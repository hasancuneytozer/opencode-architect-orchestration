/**
 * YAYIN MOTORU — kuyruk işçisi.
 *
 * Bu dosya üç platformun hiçbirine bilmez. Yalnızca `PublishAdapter`
 * sözleşmesini bilir ve şu hattı yürütür:
 *
 *   kiralama → hazırlık (precheck, transcode, kapak) → yükleme/yayın başlatma
 *   → yoklama → terminal durum
 *
 * Kimlikler (Meta/TikTok/Google) gelene kadar bu hattın tamamı sahte
 * sağlayıcılarla kanıtlanır (`src/adapters/mock`). Kimlikler geldiğinde
 * adaptörler değişir, BU DOSYA DEĞİŞMEZ.
 *
 * ── "TEK ADIMLIK İLERLETİCİ" ───────────────────────────────────────────────
 * `runJob` bir işi bir tur ilerletir ve turu, iş bir DIŞ BEKLEME durumuna
 * girene kadar (yoklama gerekiyorsa, kuyruğa erteleniyorsa, terminale
 * ulaştıysa) sürdürür. Yarım kalmış "preparing'de bekleyen" iş üretmemek
 * içindir: bir tur ya işi ilerletir ya da NEDEN ilerletmediğini gerekçesiyle
 * yazar. `TickResult.details` bu gerekçelerin kaydıdır.
 *
 * ── SAAT DİLİMİ ────────────────────────────────────────────────────────────
 * İş mantığında `Date.now()` ÇAĞRILMAZ; tek zaman kaynağı `deps.clock.now()`
 * olup varsayılanı `systemClock`'tir. `scheduled_at` bir ISO METNİ olarak
 * saklanır ama motor onu METİN OLARAK DEĞİL, AN olarak karşılaştırır
 * (`sameInstant`; iki biçim aynı anı farklı yazabilir). `new Date(ms)`
 * kullanımı BİLİNEN bir anı biçimlendirmektir, gizli zaman okumaz.
 *
 * ── KİRALAMA ───────────────────────────────────────────────────────────────
 * `jobs.claimDue` seçme + durum çekme + kira yazma işlemini TEK transaction'da
 * yapar. Motor `leaseOwner` alanını doldurur ve her iş bitince ya da kuyruğa
 * ertelenince kirasını SERBEST BIRAKIR; bırakılmazsa bir işçi çökerse iş,
 * kiranın süresi dolana kadar (varsayılan 60 sn) boşta bekler.
 *
 * ── YENİDEN DENEME, DURUM GEÇİŞİ DEĞİLDİR ──────────────────────────────────
 * `recordFailure` işi `failed` yazar; `failed` TERMİNALdir. Yeniden deneme
 * kararı `canRequeueForRetry` ile verilir ve `claimDue`'un üçüncü dalı
 * (`state='failed' AND next_attempt_at <= now`) sayesinde iş yeniden kuyruğa
 * GİRER. `assertTransition("failed","queued")` ÇAĞRILMAZ — terminal durumdan
 * çıkış, mükerrer yayın kapısıdır. Bkz. `src/domain/stateMachine.ts`.
 */
import { stat } from "node:fs/promises";
import {
  type Account,
  type Asset,
  type JobState,
  type Platform,
  type PlatformCopyOverride,
  type PublishFailure,
  type QuietHours,
  type ValidationFinding,
  PlatformCopySchema,
  isRetryableKind,
  isWithinQuietHours,
} from "../contract/index.js";
import {
  ALLOWED_TRANSITIONS,
  IllegalTransitionError,
  aggregateContentState,
  assertTransition,
  canRequeueForRetry,
  explainTransition,
  isTerminal,
} from "../domain/stateMachine.js";
import { type RetryPolicy, nextDelayMs, shouldRetry } from "../domain/retry.js";
import { resolveCopy } from "../domain/copy.js";
import type {
  AccountRepo,
  AssetRepo,
  AuditRepo,
  ContentRepo,
  CredentialRepo,
  JobPatch,
  PublishJob,
  PublishJobRepo,
} from "../db/index.js";
import {
  PermanentPublishError,
  RetryablePublishError,
  type AccountRef,
  type CredentialCipher,
  type MediaRef,
  type MediaStore,
  type PollContext,
  type PollResult,
  type PublishAdapter,
  type PublishFailureLite,
  type PublishInput,
  type ResolvedCopy,
  type Transcoder,
  type UploadProgress,
  type UploadSession,
} from "../ports/index.js";
import { getPreset } from "../media/index.js";

// ── Zaman ──────────────────────────────────────────────────────────────────

export interface Clock {
  now(): Date;
}

/** Üretim saati. Servis içinde tek yerde geçer. */
export const systemClock: Clock = {
  now: () => new Date(),
};

// ── Medya çözümleyici ──────────────────────────────────────────────────────

/**
 * `asset` + `account` → adaptöre giden `MediaRef`.
 *
 * Arayüz olarak tanımlanır ki "medyayı nereden buluyoruz" sorusu bir
 * karar olarak test edilebilir olsun: disk, S3 ya da test sahtesi.
 */
export interface MediaRefResolver {
  build(asset: Asset, account: Account): Promise<MediaRef>;
}

/**
 * Disk tabanlı varsayılan. Boyut kayıttaki değere değil, DOSYAYA bakar:
 * transcode sonrası `assets.bytes` güncellenmeyebilir ve adaptöre yanlış bayt
 * sayısı vermek "dosya limiti aşıldı" hatasının nedeni olur.
 * Dosya yoksa kayıttaki değere düşer (eksik medya ayrı bir hatadır).
 */
export class StoreMediaRefResolver implements MediaRefResolver {
  constructor(private readonly store: MediaStore) {}

  async build(asset: Asset, _account: Account): Promise<MediaRef> {
    const bytes = await this.resolveBytes(asset);
    let publicUrl: MediaRef["publicUrl"] = null;
    try {
      // publicBaseUrl tanımlı değilse null: "yayınlanamaz" demektir.
      // Adaptör bunu kendi spec'ine göre ele alır; motor UYDURMA adres üretmez.
      publicUrl = this.store.publicUrl(asset.storageKey);
    } catch {
      publicUrl = null;
    }
    return {
      storageKey: asset.storageKey,
      bytes,
      mimeType: asset.mimeType,
      info: { ...asset.info, path: asset.storageKey, bytes },
      coverKey: asset.coverKey,
      publicUrl,
    };
  }

  private async resolveBytes(asset: Asset): Promise<number> {
    try {
      if (!(await this.store.exists(asset.storageKey))) return asset.bytes;
      const st = await stat(this.store.pathFor(asset.storageKey));
      return st.isFile() ? st.size : asset.bytes;
    } catch {
      return asset.bytes;
    }
  }
}

// ── Sonuç şekilleri ────────────────────────────────────────────────────────

/** Bir işin bu turdaki sonucu. Sayaçlar doğrudan bunlardan türetilir. */
export type StepOutcome =
  | "published"
  | "published_no_link"
  | "scheduled"
  | "retried"
  | "failed"
  | "skipped"
  | "processing";

export interface JobStepDetail {
  jobId: string;
  contentId: string;
  platform: Platform;
  /** Bu tur sonundaki durum. */
  state: JobState;
  outcome: StepOutcome;
  /** Neden atlandı/ertelendi? Boş bırakılmaz. */
  reason: string | null;
  attempts: number;
  externalId: string | null;
  remoteId: string | null;
  permalink: string | null;
  error: PublishFailure | null;
  scheduledAt: string | null;
}

export interface TickResult {
  claimed: number;
  published: number;
  scheduled: number;
  retried: number;
  failed: number;
  /** Onay bekleyen, kimlik yok, sessiz saat, adaptör yok, kota dolu. */
  skipped: number;
  details: JobStepDetail[];
}

export function emptyTickResult(): TickResult {
  return { claimed: 0, published: 0, scheduled: 0, retried: 0, failed: 0, skipped: 0, details: [] };
}

function countOf(result: TickResult, outcome: StepOutcome): void {
  switch (outcome) {
    case "published":
    case "published_no_link":
      result.published += 1;
      return;
    case "scheduled":
      result.scheduled += 1;
      return;
    case "retried":
      result.retried += 1;
      return;
    case "failed":
      result.failed += 1;
      return;
    case "skipped":
      result.skipped += 1;
      return;
    case "processing":
      return;
  }
}

// ── Servis ─────────────────────────────────────────────────────────────────

export interface PublishDeps {
  jobs: PublishJobRepo;
  contents: ContentRepo;
  assets: AssetRepo;
  accounts: AccountRepo;
  credentials: CredentialRepo;
  /** null ise token ÇÖZÜLEMEZ: iş "atlandı" olur, motor çökmez. */
  cipher: CredentialCipher | null;
  media: MediaRefResolver;
  adapters: ReadonlyMap<Platform, PublishAdapter>;
  store: MediaStore;
  audit: AuditRepo;
  clock: Clock;
  /** Kiralama sahibi. Tanımlanabilir olmalı (`claimDue` boş kabul etmez). */
  leaseOwner: string;
  transcoder?: Transcoder | null;
}

export interface PublishServiceOptions {
  /** Kiralama ömrü (ms). Varsayılan 60_000. */
  leaseMs?: number;
  retryPolicy?: RetryPolicy;
  /** `tick()` parametresi verilmezse kullanılacak varsayılan. */
  limit?: number;
  /**
   * Yoklama aralığı (ms). Bir iş `processing` bırakıldığında kirası
   * `now + pollIntervalMs` olacak şekilde YENİDEN ARM EDİLİR; böylece yoklama
   * sıcak bir döngüye dönmez ve iki işçi aynı işi yoklamaz.
   * Varsayılan 5_000; deterministik testlerde 0.
   */
  pollIntervalMs?: number;
  /** Kota okunsun mu ve kota doluysa yayın ertelensin mi. Varsayılan true. */
  enforceQuota?: boolean;
  /** Jitter kaynağı; `nextDelayMs` bunu alır. Testler sabit verir. */
  random?: () => number;
  /** Denetim aktörü. Varsayılan "scheduler". */
  actor?: string;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LIMIT = 20;
/** Mantıksız uzunlukta bir yol görülürse denetime düşer. */
const LONG_PATH_ALERT = 4;
/**
 * Sessiz saat için uygun an ÇÖZÜLEMEZSE kullanılacak güvenli varsayılan.
 * Kuyruk ertelemesi her durumda bir ZAMAN DİLİMİ ileri gitmeli; "sıra şimdi"
 * demek işi aynı tick'te geri verir (sıcak `skipped` döngüsü).
 */
const FALLBACK_DEFER_MS = 60 * 60_000;
/** ISO metinleri karşılaştırılırken kabul edilen an farkı (ms). */
const INSTANT_TOLERANCE_MS = 1_000;
/**
 * Parça gönderildi ama yükleme BİTMEDİ (`UploadProgress.done === false`).
 *
 * Bekleme `nextAttemptAt` DEĞİL `scheduled_at` üzerinden yazılır: `nextAttemptAt`
 * yalnız `failed` işler için anlamlıdır, `scheduled_at` ise `DUE_SELECTION`'ın
 * ilk koşuludur. Yazılmazsa iş aynı tick'te yeniden kuyruğa girer ve motor
 * "bayt gönder ama hiç bitirme" döngüsünde ısınır.
 *
 * Değer bilinçlidir: parça gönderimi bir ağ turudur, saniyeler sürebilir; 0
 * yazmak sıcak döngü, çok büyük yazmak ise boşta bekletir. Varsayılan 5 sn.
 */
const UPLOAD_RETRY_DELAY_MS = 5_000;
/**
 * `uploadParts` UYGULANMAYAN adaptör için bekleme.
 *
 * Uzun tutulur çünkü bu bir sağlayıcı hatası değil, bir SÖZLEŞME boşluğudur:
 * motor kendi tekrarıyla düzeltemez (bayt gönderecek başka yol yok). Kısa
 * bir bekleme, kuyruğu saniyede bir "sıcak `skipped`" döngüsüne çevirirdi.
 */
const UPLOAD_UNSUPPORTED_BACKOFF_MS = 15 * 60_000;

interface RunContext {
  now: Date;
  /** Bu tick'te yoklama gerektiren duruma geçirilen işler. */
  needsPoll: Set<string>;
}

export class PublishService {
  private readonly deps: PublishDeps;
  private readonly leaseMs: number;
  private readonly policy: RetryPolicy;
  private readonly limit: number;
  private readonly pollIntervalMs: number;
  private readonly enforceQuota: boolean;
  private readonly random: () => number;
  private readonly actor: string;

  constructor(deps: PublishDeps, opts: PublishServiceOptions = {}) {
    if (!deps.leaseOwner || !deps.leaseOwner.trim()) {
      throw new Error("PublishService için leaseOwner zorunludur (tanımlanabilir olmalı).");
    }
    this.deps = deps;
    this.leaseMs = positive(opts.leaseMs, DEFAULT_LEASE_MS);
    this.policy = opts.retryPolicy ?? {};
    this.limit = positive(opts.limit, DEFAULT_LIMIT);
    this.pollIntervalMs = nonNegative(opts.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.enforceQuota = opts.enforceQuota ?? true;
    this.random = opts.random ?? Math.random;
    this.actor = opts.actor ?? "scheduler";
  }

  private now(): Date {
    return this.deps.clock.now();
  }

  // ── Genel giriş ───────────────────────────────────────────────────────────

  /**
   * Tek tur. Sıra:
   *   1. `claimDue` — sırası gelen işleri kirala (`preparing`'e çeker)
   *   2. yoklama — `processing`/`uploading` durumda, kirası gelmiş işleri ilerlet
   *
   * `tick` BİR İŞİN HATASI YÜZÜNDEN ÇIKMAZ: bir iş diğerlerini
   * engellememelidir. Beklenmeyen hata `unknown` sınıfıyla KALICI sayılır ve
   * ayrıntı denetime yazılır (bkz. `handleUnexpected`).
   */
  async tick(limit: number = this.limit): Promise<TickResult> {
    const result = emptyTickResult();
    const ctx: RunContext = { now: this.now(), needsPoll: new Set() };

    const jobs = this.claim(limit, ctx.now);
    result.claimed = jobs.length;
    for (const job of jobs) {
      let detail: JobStepDetail;
      try {
        detail = await this.runJob(job, ctx);
      } catch (err) {
        detail = this.handleUnexpected(job, err, ctx);
      }
      result.details.push(detail);
      countOf(result, detail.outcome);
    }

    for (const job of this.pollCandidates(ctx, limit)) {
      let detail: JobStepDetail | null;
      try {
        detail = await this.pollJob(job, ctx);
      } catch (err) {
        detail = this.handleUnexpected(job, err, ctx);
      }
      if (!detail) continue;
      result.details.push(detail);
      countOf(result, detail.outcome);
    }

    this.syncContentStates(result.details);
    return result;
  }

  /**
   * Tek bir işi zamanlamayı beklemeden çalıştırır ("şimdi yayınla").
   *
   * Zaman damgası şimdiye çekilir, kiralama bize verilir; ardından `tick` ile
   * AYNI yol yürür (yoklama dahil). İki ayrı kod yolu, "şimdi yayınla" ile
   * zamanlanmış yayını farklı davrandırır demektir.
   *
   * Yazma DOĞRULANIR (an farkıyla, metin karşılaştırmasıyla değil): tutmazsa
   * iş yine de yayınlanır ama adaptöre eski zaman gider; bu durum
   * `publish.force_schedule_write_rejected` ile görünür kılınır.
   */
  async publishNow(jobId: string): Promise<JobStepDetail | null> {
    const ctx: RunContext = { now: this.now(), needsPoll: new Set() };
    const existing = this.deps.jobs.getById(jobId);
    if (!existing) return null;
    if (isTerminal(existing.state)) {
      return this.detail(existing, "skipped", `İş terminal durumda (${existing.state}); yeniden çalıştırılamaz.`);
    }

    const claimed = this.deps.jobs.markState(existing.id, existing.state, {
      scheduledAt: ctx.now.toISOString(),
      leaseOwner: this.deps.leaseOwner,
      leaseExpiresAt: ctx.now.getTime() + this.leaseMs,
    });
    if (!claimed) return this.detail(existing, "skipped", "İş kiralanamadı (satır bulunamadı).");

    const job = this.deps.jobs.getById(jobId) ?? existing;
    this.audit(job.id, "publish.force", { scheduledAt: job.scheduledAt, state: job.state });

    // "ŞİMDİ YAYINLA" SÖZLEŞMESİ DOĞRULANIR: zaman damgası şimdiye çekildiyse
    // `runJob` adaptöre `scheduledAt: null` ("hemen") gönderir. Yazma tutmazsa
    // iş yine de YAYINLANIR ama adaptöre eski (gelecekteki) zaman gider ve
    // yayın sağlayıcıya ertelenir; "şimdi" isteği sessizce ertelenmiş olur.
    // İş burada durdurulMAZ: depo kusuru bir yayın hatası değildir ve ertelenmiş
    // bir yayın, kaybolmuş bir yayından iyidir. Görünürlük denetimle sağlanır.
    if (!sameInstant(job.scheduledAt, ctx.now)) {
      this.audit(job.id, "publish.force_schedule_write_rejected", {
        requested: ctx.now.toISOString(),
        actual: job.scheduledAt,
      });
    }

    try {
      const detail = await this.runJob(job, ctx);
      if (detail.outcome === "processing") {
        const fresh = this.deps.jobs.getById(jobId);
        if (fresh && fresh.state === "processing" && fresh.externalId !== null) {
          const polled = await this.pollJob(fresh, ctx);
          if (polled) return polled;
        }
      }
      return detail;
    } catch (err) {
      return this.handleUnexpected(job, err, ctx);
    }
  }

  // ── Kiralama ──────────────────────────────────────────────────────────────

  private claim(limit: number, now: Date): PublishJob[] {
    if (limit <= 0) return [];
    return this.deps.jobs.claimDue({
      now,
      limit,
      leaseOwner: this.deps.leaseOwner,
      leaseMs: this.leaseMs,
    });
  }

  /**
   * Yoklama adayları.
   *
   * Önce BU tick'te yoklamaya ihtiyaç duyan işler: yeni `externalId` alan iş
   * `dueForPoll`'un `updated_at <= now` filtresinden düşebilir, çünkü repo
   * `updated_at`'ı GERÇEK saatle yazar ve test saati farklı olabilir. Motor
   * neyi ne zaman gönderdiğini BİLİYOR; unutmasına gerek yok.
   * Sonra repo'nun kendi `dueForPoll` listesi (yoklaması bekleyen işler).
   */
  private pollCandidates(ctx: RunContext, limit: number): PublishJob[] {
    const now = ctx.now;
    const out: PublishJob[] = [];
    const seen = new Set<string>();

    for (const id of ctx.needsPoll) {
      const job = this.deps.jobs.getById(id);
      if (!job) continue;
      seen.add(id);
      out.push(job);
    }

    let due: PublishJob[] = [];
    try {
      due = this.deps.jobs.dueForPoll(now, limit);
    } catch (err) {
      this.audit("-", "publish.poll_query_failed", { message: errorMessage(err) });
    }
    for (const job of due) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      out.push(job);
    }

    return out.filter((job) => {
      if (job.state !== "processing" && job.state !== "uploading") return false;
      if (job.externalId === null) return false;
      // Kirası gelecekte olan iş YOKLANMAZ. Yeni açılanlar kirasız bırakılır,
      // bu yüzden aynı tick içinde bir kez yoklanırlar.
      if (!ctx.needsPoll.has(job.id) && job.leaseExpiresAt !== null && job.leaseExpiresAt > now.getTime()) {
        return false;
      }
      return true;
    });
  }

  /**
   * Süresi dolmuş kiralama. `tick` BUNU ÇAĞIRMAZ: `claimDue`'un ikinci dalı
   * (`lease_expires_at IS NULL OR < now`) zaten çöken işçinin işini geri alır;
   * `attempts` artışı ise `recoverExpiredLeases`'in işidir. Çağırmak, her
   * kurtarmada bir yayın denemesi daha harcamış olur. Operasyonel/CLI
   * kullanımı için açık metot olarak durur.
   */
  recoverLeases(now: Date = this.now()): number {
    const recovered = this.deps.jobs.recoverExpiredLeases(now);
    for (const job of recovered) {
      this.audit(job.id, "publish.lease_recovered", { attempts: job.attempts, state: job.state });
    }
    return recovered.length;
  }

  // ── Ana iş döngüsü ───────────────────────────────────────────────────────

  private async runJob(job: PublishJob, ctx: RunContext): Promise<JobStepDetail> {
    const now = ctx.now;

    if (isTerminal(job.state)) {
      return this.detail(job, "skipped", `İş zaten terminal (${job.state}).`);
    }

    const content = this.deps.contents.getById(job.contentId);
    if (!content) return this.defer(job, "content_missing", "İçerik kaydı yok (silinmiş olabilir).");

    // 1) ONAY. Onaysız yayın, reklam içeriğinde en pahalı hatadır.
    if (content.requiresApproval && !content.approvedAt) {
      return this.defer(job, "approval_pending", "İçerik onay bekliyor; onaysız yayın yapılmaz.");
    }

    // 2) ADAPTÖR
    const adapter = this.deps.adapters.get(job.platform);
    if (!adapter) {
      return this.defer(
        job,
        "adapter_missing",
        `${job.platform} için adaptör yok; iş kuyrukta bekliyor (kimlik/entegrasyon gelince çalışır).`,
      );
    }

    // 3) HESAP + KİMLİK
    const account = this.deps.accounts.getById(job.accountId);
    if (!account) return this.defer(job, "account_missing", "Hesap kaydı yok.");
    if (account.platform !== job.platform) {
      return this.defer(
        job,
        "account_platform_mismatch",
        `Hesabın platformu (${account.platform}) işin platformuyla (${job.platform}) uyuşmuyor.`,
      );
    }
    if (account.status === "disabled") {
      return this.defer(job, "account_disabled", "Hesap devre dışı; yayın yapılmayacak.");
    }
    if (account.status === "needs_reauth") {
      return this.defer(
        job,
        "account_needs_reauth",
        "Hesap yeniden yetkilendirme bekliyor; eski belirteçle denemek kota/hesap riskidir.",
      );
    }

    const credential = this.deps.credentials.getByAccountId(account.id);
    if (!credential) return this.defer(job, "credential_missing", "Hesabın kimlik kaydı yok.");
    if (credential.platform !== job.platform) {
      return this.defer(job, "credential_platform_mismatch", "Kimlik kaydının platformu uyuşmuyor.");
    }
    if (!this.deps.cipher) {
      return this.defer(
        job,
        "cipher_missing",
        "Şifre çözücü yok (SP_MASTER_KEY tanımlı değil); belirteç çözülemiyor.",
      );
    }

    let accessToken: string;
    try {
      accessToken = this.deps.cipher.open(credential.accessTokenEnc);
    } catch (err) {
      // Bozuk kutu bir YAYIN hatası değil. Sessizce geçilirse kullanıcı
      // neden yayınlanmadığını anlamaz; kuyrukta bırakılır ki operatör
      // anahtarı/veriyi düzelttikten sonra iş yeniden sürülsün.
      this.audit(job.id, "publish.credential_unreadable", {
        message: errorMessage(err),
        accountId: account.id,
      });
      return this.defer(job, "credential_unreadable", `Belirteç çözülemedi: ${errorMessage(err)}`);
    }

    // 4) VARLIK
    const sourceAsset = this.deps.assets.getById(content.assetId);
    if (!sourceAsset) return this.defer(job, "asset_missing", "Varlık kaydı yok.");

    // 5) SESSİZ SAAT. `scheduledAt` UTC ISO'dur ama karşılaştırma içeriğin
    //    kendi saat diliminde, YEREL saat diliminde yapılır.
    if (content.quietHours && isWithinQuietHours(now, content.quietHours, content.timezone)) {
      return this.deferQuietHours(job, content.quietHours, content.timezone, ctx);
    }

    // 6) GİRDİ
    const accountRef: AccountRef = {
      id: account.id,
      platform: account.platform,
      externalId: account.externalId,
      accessToken,
      refreshToken: null,
      tokenExpiresAt: credential.tokenExpiresAt,
    };
    const copy = this.resolveCopyFor(content.copy[job.platform] ?? null);

    const media = await this.deps.media.build(sourceAsset, account);
    const coverBytes = await this.readCover(sourceAsset.coverKey, job.id);

    const baseInput: PublishInput = {
      jobId: job.id,
      idempotencyKey: job.idempotencyKey,
      account: accountRef,
      media,
      copy,
      // `scheduledAt` GELECEKTEYSE sağlayıcıya bırakılır; zamanı gelmişse
      // null: "hemen yayınla". Karşılaştırma METİN DEĞİL AN üzerinden
      // yapılır (`Date.parse`): iki ISO biçimi aynı anı farklı yazabilir.
      // `publishNow` ZAMANI BEKLEMEZ; zaman damgasını şimdiye çektiği için
      // buraya gelen iş hep ikinci yola düşer ve adaptöre `null` gider.
      scheduledAt: Date.parse(job.scheduledAt) > now.getTime() ? job.scheduledAt : null,
      coverBytes,
    };

    // 7) HAZIRLIK — ön kontrol. YALNIZ yeni yayında (`externalId` yok):
    //    sağlayıcıya zaten gönderilmiş bir yüklemeyi/yayını yeniden hazırlamak
    //    yanlıştır; o iş 9) ve 10'a girmez.
    if (job.externalId === null) {
      const findings = await this.runPrecheck(adapter, baseInput);
      const errors = findings.filter((f) => f.severity === "error");
      if (errors.length > 0) {
        const message = `Ön kontrol hata: ${errors.map((f) => `${f.code}: ${f.message}`).join(" | ")}`;
        this.audit(job.id, "publish.precheck_failed", { findings });
        // DENEME SAYILMAZ: dışarı hiç gidilmedi. `attempts` 0'da kalır ki
        // "kaç kez denendi?" sorusu "hiç" cevabını versin.
        return this.failJob(job, buildFailure("validation", message, ctx.now, null), ctx);
      }
      if (findings.length > 0) {
        this.audit(job.id, "publish.precheck_warnings", { findings });
      }
    }

    // 8) DENEME SAYACI. Ön kontrolün GEÇTİĞİ her yolda tam olarak bir artış:
    //    hem "yayına gittim" demektir, hem de hazırlıkta oluşan geçici hatayı
    //    `shouldRetry`'ye DOĞRU `attempt` ile götürür. Sayaç burada artmazsa
    //    "transient" hata hep `attempt=1` sayılır, politika hep "dene" der ve
    //    iş SONSUZA KADAR yeniden denenir (bkz. `prepareAsset`).
    //    Ön kontrolün reddi bir deneme DEĞİLDİR; yukarıda elendi.
    const running = await this.bumpAttempt(job);

    // 9) DIŞ BEKLEME: `externalId` varsa iş bir YÜKLEME DEVAMI ya da YOKLAMADIR.
    if (job.externalId !== null) {
      // 9a) BAYT GÖNDERME. `StartResult.uploadUrl` oturumu AÇAN aşamadır; oturum
      //     tek başına bir yayın DEĞİLDİR. `uploadedParts < totalParts` ise
      //     hâlâ bayt gönderilmesi gerekiyor demektir.
      if (this.uploadPending(job)) {
        return this.continueUpload(adapter, baseInput, running, ctx);
      }
      // 9b) Eski yol: `uploadParts` UYGULAMAYAN adaptörler baytı kendi
      //     yolundan (ör. herkese açık adresi çekerek) ilerletir; motor yalnız
      //     oturumu yeniler. `uploadParts` varsa bu dal AÇILMAZ — çünkü o
      //     durumda `uploadPending` zaten yakalar.
      if (
        job.uploadUrl !== null &&
        job.uploadedParts > 0 &&
        typeof adapter.uploadParts !== "function"
      ) {
        return this.callStart(adapter, baseInput, running, ctx);
      }
      return (
        (await this.pollJob(running, ctx)) ?? this.detail(running, "skipped", "Yoklanacak durum oluşmadı.")
      );
    }

    // 10) TRANSCODE. Varlık bu platform için daha önce türetilmişse YENİDEN
    //     yapılmaz: kirası dolup yeniden çalışan işçi aynı işi tekrar etmesin.
    //     `running` geçer: dönüştürme hatası ARTIRILMIŞ `attempts` ile
    //     değerlendirilir, yoksa yeniden deneme bütçesi hiç işlemez.
    const prepared = await this.prepareAsset(running, sourceAsset, copy, baseInput, ctx);
    if (!prepared.ok) return prepared.detail;
    const finalInput = prepared.input;

    // 11) KOTA. Kota doluysa yayına GİTME; kotanın sıfırlanacağı ana kadar ertele.
    const quotaSkip = await this.enforceQuotaIfNeeded(job, adapter, accountRef, ctx);
    if (quotaSkip) return quotaSkip;

    // 12) YAYINI BAŞLAT
    return this.callStart(adapter, finalInput, running, ctx);
  }

  // ── Hazırlık ──────────────────────────────────────────────────────────────

  private async runPrecheck(adapter: PublishAdapter, input: PublishInput): Promise<ValidationFinding[]> {
    try {
      const findings = await adapter.precheck(input);
      return Array.isArray(findings) ? findings : [];
    } catch (err) {
      if (err instanceof PermanentPublishError || err instanceof RetryablePublishError) throw err;
      // Ön kontrolün kendisi patladıysa yayına gitmek anlamsız: kalıcı sayılır.
      throw new PermanentPublishError(
        `Ön kontrol başarısız: ${errorMessage(err)}`,
        "validation",
        null,
        null,
        null,
      );
    }
  }

  /**
   * Platforma özel türev üretir (var olanı kullanır) ve kapak çıkarır.
   *
   * `withinLimits === false` → YAYINA GİTMEZ. Bunu "başarısız deneme" saymak
   * yanlıştır: dosya platform sınırını aşıyor demektir ve aynı girdiyle tekrar
   * denemek aynı sonucu verir.
   */
  private async prepareAsset(
    job: PublishJob,
    sourceAsset: Asset,
    copy: ResolvedCopy,
    input: PublishInput,
    ctx: RunContext,
  ): Promise<{ ok: true; input: PublishInput } | { ok: false; detail: JobStepDetail }> {
    const transcoder = this.deps.transcoder ?? null;
    if (!transcoder) return { ok: true, input };

    const existing = this.deps.assets
      .listDerivedFrom(sourceAsset.id)
      .find((a) => a.derivedForPlatform === job.platform);
    if (existing) {
      return { ok: true, input: await this.rebuildInput(job, input, existing, copy) };
    }

    const preset = getPreset(job.platform);
    const derivedKey = `derived/${job.platform}/${sourceAsset.id}.${preset.container}`;

    let result;
    try {
      result = await transcoder.toFeedReady(
        this.deps.store.pathFor(sourceAsset.storageKey),
        this.deps.store.pathFor(derivedKey),
        preset,
      );
    } catch (err) {
      const message = `Dönüştürme başarısız: ${errorMessage(err)}`;
      this.audit(job.id, "publish.transcode_failed", { message });
      // Dönüştürme SAĞLAYICI hatası değil, kendi altyapımızın hatasıdır (ffmpeg,
      // disk, süre aşımı) ve GEÇİCİ sayılır. Kararı `handleFailure` verir:
      // `next_attempt_at` DOLDURULUR, `finished_at` boş kalır, bütçe
      // (`maxAttempts`) dolunca kalıcı hataya düşer. Sonsuz yeniden deneme
      // YOKTUR ve "geçici" kaydı yalan söylemez.
      // Burada doğrudan `failJob` çağırmak `recordFailure`'a `nextAttemptAt:
      // null` verirdi; `transient` (geçici) bir kayıtta `next_attempt_at` de
      // `finished_at` da NULL kalır — yani "ne geçici ne kalıcı", bir daha
      // denenmeyen ölü bir iş (bkz. MIMARI.md "failed kalıcı mı geçici mi").
      return {
        ok: false,
        detail: this.handleFailure(job, new RetryablePublishError(message, "transient"), ctx),
      };
    }

    if (!result.withinLimits) {
      const message =
        `Dönüştürülen dosya ${job.platform} sınırını aşıyor ` +
        `(${result.bytes} bayt > ${preset.maxBytes} bayt); yayına gönderilmedi.`;
      this.audit(job.id, "publish.transcode_over_budget", {
        bytes: result.bytes,
        maxBytes: preset.maxBytes,
      });
      return {
        ok: false,
        detail: this.failJob(job, buildFailure("validation", message, ctx.now, null), ctx),
      };
    }

    const derived = this.deps.assets.create({
      projectId: sourceAsset.projectId,
      storageKey: derivedKey,
      originalName: `${sourceAsset.originalName}.${preset.container}`,
      bytes: result.bytes,
      mimeType: preset.container === "mp4" ? "video/mp4" : "application/octet-stream",
      info: result.info,
      findings: sourceAsset.findings,
      derivedFromAssetId: sourceAsset.id,
      derivedForPlatform: job.platform,
    });

    // Kapak: yoksa üret. Üretilemezse kapaksız devam et — kapak zorunlu değil.
    if (derived.coverKey === null) {
      const bytes = await this.grabCover(
        transcoder,
        this.deps.store.pathFor(derived.storageKey),
        copy.coverAtPercent,
        job.id,
      );
      if (bytes) {
        try {
          const put = await this.deps.store.put(`covers/${job.platform}/${job.id}.jpg`, bytes);
          this.deps.assets.setCoverKey(derived.id, put.key);
        } catch (err) {
          this.audit(job.id, "publish.cover_store_failed", { message: errorMessage(err) });
        }
      }
    }

    return { ok: true, input: await this.rebuildInput(job, input, derived, copy) };
  }

  private async rebuildInput(
    job: PublishJob,
    input: PublishInput,
    asset: Asset,
    copy: ResolvedCopy,
  ): Promise<PublishInput> {
    const account = this.deps.accounts.getById(job.accountId);
    const media = account ? await this.deps.media.build(asset, account) : input.media;
    const coverBytes = await this.readCover(asset.coverKey, job.id);
    return { ...input, media, coverBytes, copy };
  }

  private async grabCover(
    transcoder: Transcoder,
    path: string,
    percent: number,
    jobId: string,
  ): Promise<Buffer | null> {
    try {
      const bytes = await transcoder.grabCover(path, percent);
      // SIFIR baytlık kapak KULLANILMAZ: adaptöre boş kapak vermek, kapak
      // üretmemiş bir işi "kapaklı" gösterir.
      return bytes && bytes.length > 0 ? bytes : null;
    } catch (err) {
      this.audit(jobId, "publish.cover_failed", { message: errorMessage(err) });
      return null;
    }
  }

  private async readCover(coverKey: string | null, jobId: string): Promise<Buffer | null> {
    if (!coverKey) return null;
    try {
      const bytes = await this.deps.store.read(coverKey);
      return bytes.length > 0 ? bytes : null;
    } catch (err) {
      // Kapak zorunlu değil; eksik kapak yayını durdurmaz ama kaydedilir.
      this.audit(jobId, "publish.cover_missing", { coverKey, message: errorMessage(err) });
      return null;
    }
  }

  // ── Kota ──────────────────────────────────────────────────────────────────

  /**
   * `readQuota` destekleyen adaptörlerde yayından önce kota okunur. Doluysa iş,
   * kotanın sıfırlanacağı ana kadar ERTELİR (sayım değil, erteleme).
   */
  private async enforceQuotaIfNeeded(
    job: PublishJob,
    adapter: PublishAdapter,
    account: AccountRef,
    ctx: RunContext,
  ): Promise<JobStepDetail | null> {
    if (!this.enforceQuota || typeof adapter.readQuota !== "function") return null;

    let quota;
    try {
      quota = await adapter.readQuota(account);
    } catch (err) {
      // Kota OKUNAMAZSA yayın engellenmez: kısıt zaten sağlayıcıda uygulanır;
      // buradaki okuma yalnızca "boşuna denemeyelim" ipucudur.
      this.audit(job.id, "publish.quota_read_failed", { message: errorMessage(err) });
      return null;
    }
    if (!quota || !(quota.total > 0) || quota.used < quota.total) return null;

    const until = new Date(ctx.now.getTime() + Math.max(1, quota.windowSec) * 1000);
    this.audit(job.id, "publish.deferred_quota", { quota, until: until.toISOString() });
    return this.deferUntil(
      job,
      until.toISOString(),
      `Kota dolu (${quota.used}/${quota.total}, pencere ${quota.windowSec} sn)`,
      ctx,
    );
  }

  // ── Yükleme / yayın başlatma ──────────────────────────────────────────────

  /** Fiziksel deneme sayacı. Durum değişmeden ALAN yazılır (aynı duruma "geçiş" tanımlı değildir). */
  private async bumpAttempt(job: PublishJob): Promise<PublishJob> {
    const attempts = job.attempts + 1;
    this.deps.jobs.markState(job.id, job.state, { attempts });
    return { ...job, attempts };
  }

  /**
   * Yoklamaya bırakılan işin KİRALANMASI: sahibi biziz, süre `now + pollIntervalMs`.
   *
   * Kirasız bırakılsaydı `claimDue`'un ikinci dalı (`lease_expires_at IS NULL`)
   * işi HER tick'te geri alır ve aynı turda hem kirala hem yokla olurdu; iki
   * işçi aynı işi yoklayabilirdi. Süre kollarak yoklama ritmini de verir.
   * `pollCandidates` bu tick'te kendi elimize geçen işi kiralama filtresinden
   * muaf tutar; böylece ilk yoklama beklemeden yapılır.
   */
  private armPollLease(job: PublishJob, ctx: RunContext): void {
    this.moveTo(job, "processing", {
      error: null,
      leaseOwner: this.deps.leaseOwner,
      leaseExpiresAt: ctx.now.getTime() + this.pollIntervalMs,
    });
  }

  // ── Parçalı yükleme döngüsü ──────────────────────────────────────────────

  /**
   * Bu işin bayt göndermesi gerekiyor mu?
   *
   * KURAL: durum DEĞİL, VERİ karar verir. `claimDue` kiraladığı her işi
   * `preparing`'e çektiği için `runJob` içinde `state === "uploading"` hiç
   * doğru olmaz; kriter olsaydı motor hiçbir zaman bayt göndermezdi.
   *
   * İki durum "gönderiliyor" demektir:
   *   - `totalParts` biliniyorsa ve `uploadedParts < totalParts`,
   *   - `totalParts` bilinmiyorsa (`null`) ve HİÇ parça gönderilmemişse
   *     (`uploadedParts === 0`). Bu, `StartResult.uploadUrl` dalının bıraktığı
   *     hâldir: oturum açıldı ama tek bayt gitmedi.
   *
   * `totalParts === null && uploadedParts > 0` ise "sağlayıcı alanı kendi
   * yolundan ilerletiyor" demektir; motor tekrar göndermez.
   */
  private uploadPending(job: PublishJob): boolean {
    if (job.uploadUrl === null || job.uploadUrl === "") return false;
    if (job.totalParts === null) return job.uploadedParts === 0;
    return job.uploadedParts < job.totalParts;
  }

  /**
   * Oturumun ömrü dolmuş mu?
   *
   * `uploadUrlExpiresAt === null` ise "bilinmiyor" demektir ve "dolmuş" sayılmaz:
   * sağlayıcı süre vermediyse biz kendi kafamızdan bir tarih UYDURAMAYIZ (aynı
   * ilke `sameInstant` yorumunda da geçerli). Uydurma süre, henüz geçerli bir
   * oturumu "süresi doldu" diye öldürürdü.
   *
   * Karşılaştırma AN üzerinden `Date.parse` ile yapılır; metin karşılaştırması
   * iki biçimli ISO'yu (`.sssZ` / `+00:00`) farklı sayar.
   */
  private uploadSessionExpired(job: PublishJob, ctx: RunContext): boolean {
    const iso = job.uploadUrlExpiresAt;
    if (iso === null || iso === "") return false;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return false;
    return ms <= ctx.now.getTime();
  }

  /**
   * BAYTLARI GÖNDEREN ADIM. `StartResult.uploadUrl` oturumu AÇTI; bu adım
   * olmadan hiçbir şey gönderilmez ve iş `processing`'de sonsuza kadar kalır.
   *
   * Sıra (her adım gerekçelidir):
   *   1. Süre dolmuşsa → kalıcı `container_expired` (yeniden deneme YOK:
   *      TikTok upload_url 1 saat, Meta container 24 saat; ikisi de aynı
   *      oturuma geri dönülemez, yeni oturum açmak gerekir).
   *   2. `uploadParts` yoksa → gerekçeli `skipped` + `publish.upload_unsupported`
   *      denetim kaydı. `processing`'e GEÇİLMEZ; aksi halde kullanıcı "yayın
   *      sırasında" görür ve video hiçbir zaman yüklenmez.
   *   3. Oturum kur → `uploadParts` çağır.
   *   4. **BAŞARILI CEVAPTAN SONRA** ilerlemeyi yaz. Zaman aşımında hiçbir
   *      şey yazılmaz: "gönderdim sanıp" işaretlemek sonraki denemede bayt
   *      ATLATIR ve sessiz 416 alır.
   *   5. `done` → `processing`; değilse ilerleme yazılır, iş kuyruğa geri
   *      bırakılır (aynı tick'te ikinci deneme YAPILMAZ).
   */
  private async continueUpload(
    adapter: PublishAdapter,
    input: PublishInput,
    job: PublishJob,
    ctx: RunContext,
  ): Promise<JobStepDetail> {
    // 1) SÜRE. `PermanentPublishError` DEĞİL `failJob` + `container_expired`:
    //    ikisi de kalıcıdır ama `failJob` durum geçişini DOĞRULAR, denetim
    //    kaydı yazar ve `finished_at` damgalar. `recordFailure` `null`
    //    `nextAttemptAt` ile çağrıldığı için `isRetryableKind` false ise
    //    `next_attempt_at` de NULL kalır: yeniden deneme YOK.
    if (this.uploadSessionExpired(job, ctx)) {
      const message =
        `Yükleme oturumu süresi doldu (${job.uploadUrlExpiresAt}); bu oturuma artık bayt ` +
        "gönderilemez. Kalıcı hata: aynı oturuma dönmek işe yaramaz, yükleme BAŞTAN " +
        "başlatılmalıdır (yeni oturum açılır).";
      this.audit(job.id, "publish.upload_url_expired", {
        uploadUrlExpiresAt: job.uploadUrlExpiresAt,
        uploadedParts: job.uploadedParts,
        totalParts: job.totalParts,
      });
      return this.failJob(job, buildFailure("container_expired", message, ctx.now, null), ctx);
    }

    // 2) ADAPTÖR YETENEĞİ.
    //    `StartResult.uploadUrl` döndüren adaptör `uploadParts` UYGULAMAK
    //    ZORUNDADIR (port sözleşmesi); uygulamıyorsa oturumu açan adaptör
    //    sözleşmeyi bozmuştur. Yine de motor bu durumda `processing`'e
    //    GİTMEZ: kullanıcı "yayın sırasında" görür ama video hiç yüklenmez.
    if (typeof adapter.uploadParts !== "function") {
      if (job.uploadedParts > 0) {
        // Kısmi ilerleme VAR: oturum sahibi baytı başka bir yoldan göndermiş
        // demektir (ör. sağlayıcı herkese açık adresi kendisi çekti). Eski
        // `startPublish` DEVAM yolu bu durumda doğrudur.
        this.audit(job.id, "publish.upload_progress_observed", {
          uploadedParts: job.uploadedParts,
          totalParts: job.totalParts,
          note: "Adaptör uploadParts uygulamıyor; kısmi ilerleme var, oturum startPublish ile sürdürülüyor.",
        });
        return this.callStart(adapter, input, job, ctx);
      }
      this.audit(job.id, "publish.upload_unsupported", {
        platform: job.platform,
        externalId: job.externalId,
        uploadUrlExpiresAt: job.uploadUrlExpiresAt,
        note: "Adaptör StartResult.uploadUrl döndürdü ama uploadParts uygulamıyor; bayt gönderen yok.",
      });
      return this.deferUntil(
        job,
        new Date(ctx.now.getTime() + UPLOAD_UNSUPPORTED_BACKOFF_MS).toISOString(),
        "upload_unsupported",
        ctx,
        `${job.platform} adaptörü ikili yükleme oturumu açtı ama bayt GÖNDEREN YOK ` +
          "(uploadParts uygulanmamış). Video yüklenmedi; `processing`'e geçilmedi.",
      );
    }

    // 3) OTURUM. `partSizeBytes` bilerek `0`: parça boyutu SAĞLAYICIYA
    //    bağlıdır (YouTube 256 KB katı, TikTok 5-64 MB). Motor bir sayı
    //    uydurursa sağlayıcı kuralıyla çelişir. 0 = "kendi varsayılanını kullan".
    const session: UploadSession = {
      uploadUrl: job.uploadUrl as string,
      expiresAt: job.uploadUrlExpiresAt,
      totalParts: job.totalParts,
      uploadedParts: job.uploadedParts,
      partSizeBytes: 0,
    };

    // İş "bayt gönderiliyor" durumuna alınır: `preparing → uploading` yasal
    // kenardır ve panelde "yükleniyor" görünür. `uploading → processing`
    // yalnız `done` geldikten sonra kullanılır.
    //
    // `current` yazılan GERÇEK durumu tutar: `moveTo`/`markState` bellekteki
    // `job.state`'i değiştirmez ve `markState` geçiş DOĞRULAMAZ. `current`
    // okunmazsa sonraki `markState`/`deferUntil` çağrıları `uploading` olan bir
    // satırı `preparing`'e geri yazardı — yani motor kendi yazdığı durumu
    // geri alırdı.
    let current: PublishJob = job;
    this.moveTo(current, "uploading", { error: null, nextAttemptAt: null });
    current = this.refresh(job.id);

    this.audit(job.id, "publish.upload_cycle", {
      uploadedParts: session.uploadedParts,
      totalParts: session.totalParts,
      uploadUrl: session.uploadUrl,
    });

    let progress: UploadProgress;
    try {
      progress = await adapter.uploadParts(input, session);
    } catch (err) {
      // Zaman aşımı dahil HİÇBİR hata yolunda ilerleme YAZILMAZ: doğru sayı
      // `uploadedParts`'te kalır, sonraki deneme kaldığı yerden gider. "Gönderdim
      // sanıp" işaretlemek sonraki denemede bayt ATLATIR ve sessiz 416 alır.
      return this.handleFailure(current, err, ctx);
    }

    // 4) İLERLEME. KAYNAK TEK: adaptörün BİLDİRDİĞİ kabul edilen parça
    //    sayısıdır. "Ne gönderdik" varsayımı yazılmaz. Süreç buradan sonra
    //    çökse bile bir sonraki işçi kaldığı yerden devam eder.
    const uploadedParts = Math.max(0, Math.floor(progress.uploadedParts));
    const totalParts =
      typeof progress.totalParts === "number" && Number.isFinite(progress.totalParts)
        ? Math.max(0, Math.floor(progress.totalParts))
        : null;
    current = {
      ...current,
      uploadedParts,
      totalParts,
      uploadUrl: session.uploadUrl,
    };
    this.deps.jobs.markState(job.id, "uploading", {
      uploadedParts,
      totalParts,
      uploadUrl: session.uploadUrl,
      error: null,
      nextAttemptAt: null,
    });
    this.audit(job.id, "publish.upload_progress", {
      uploadedParts,
      totalParts,
      done: progress.done,
      nextOffset: progress.nextOffset,
    });

    // 5a) BİTTİ → yoklama. Video kimliği `externalId` üzerinden gelir.
    if (progress.done) {
      this.moveTo(current, "processing", {
        error: null,
        nextAttemptAt: null,
        leaseOwner: this.deps.leaseOwner,
        leaseExpiresAt: ctx.now.getTime() + this.pollIntervalMs,
      });
      ctx.needsPoll.add(job.id);
      const fresh = this.refresh(job.id);
      return this.detail(
        fresh,
        "processing",
        "Baytlar gönderildi; sunucunun işlemesi bekleniyor.",
        { externalId: fresh.externalId },
      );
    }

    // 5b) BİTMEDİ → kuyruğa geri. `deferUntil` `scheduled_at`'ı İLERİ yazar ve
    //     YAZILDIĞINI DOĞRULAR; yazılmazsa iş her tick'te yeniden denenir
    //     (sıcak `skipped` döngüsü). Aynı tick'te ikinci deneme YAPILMAZ.
    const label = totalParts === null ? "upload_partial" : "upload_incomplete";
    const reason = `Yükleme sürüyor: ${uploadedParts}/${totalParts ?? "?"} parça gönderildi.`;
    const until = new Date(ctx.now.getTime() + UPLOAD_RETRY_DELAY_MS).toISOString();
    return this.deferUntil(current, until, label, ctx, reason);
  }

  private async callStart(
    adapter: PublishAdapter,
    input: PublishInput,
    job: PublishJob,
    ctx: RunContext,
  ): Promise<JobStepDetail> {
    let current = job;
    if (current.idempotencyFirstUsedAt === null) {
      // Anahtar İLK KEZ sunucuya gönderiliyor. Damga, mükerrer yayın
      // soruşturmasında "aynı anahtarla ikinci gönderim ne zaman oldu"
      // sorusunun tek dayanağıdır.
      const stamp = ctx.now.toISOString();
      this.deps.jobs.markState(current.id, current.state, { idempotencyFirstUsedAt: stamp });
      current = { ...current, idempotencyFirstUsedAt: stamp };
    }

    let result;
    try {
      result = await adapter.startPublish(input);
    } catch (err) {
      return this.handleFailure(current, err, ctx);
    }

    switch (result.kind) {
      case "immediate": {
        const permalink = result.permalink ?? null;
        const remoteId = result.remoteId;
        this.finishPublished(current, remoteId, permalink, ctx);
        this.audit(current.id, "publish.published", {
          immediate: true,
          remoteId,
          permalink,
          attempts: current.attempts,
        });
        return this.detail(this.refresh(current.id), permalink ? "published" : "published_no_link", null, {
          remoteId,
          permalink,
        });
      }
      case "pending": {
        this.moveTo(current, "processing", {
          externalId: result.externalId,
          error: null,
          nextAttemptAt: null,
          leaseOwner: this.deps.leaseOwner,
          leaseExpiresAt: ctx.now.getTime() + this.pollIntervalMs,
        });
        this.audit(current.id, "publish.pending", {
          externalId: result.externalId,
          attempts: current.attempts,
        });
        // `nextAttemptAt` BURAYA YAZILMAZ: o alan yalnız `failed` işler için
        // anlamlıdır. Yoklama `dueForPoll` ile gelir.
        ctx.needsPoll.add(current.id);
        const fresh = this.refresh(current.id);
        return this.detail(fresh, "processing", "Sunucu yayını işliyor; yoklama bekleniyor.", {
          externalId: fresh.externalId,
        });
      }
      case "uploadUrl": {
        this.moveTo(current, "processing", {
          externalId: result.externalId,
          uploadUrl: result.uploadUrl,
          uploadUrlExpiresAt: result.expiresAt,
          // Parça sayısını BİLMEYİZ (`totalParts: null` dürüst yanıt) ve
          // `uploadedParts: 0` "kabul edilmiş parça yok" demektir: sahte
          // ilerleme yazmak, süre aşımında yanlış yerden devam etmeye yol açar.
          uploadedParts: 0,
          totalParts: null,
          error: null,
          nextAttemptAt: null,
          leaseOwner: this.deps.leaseOwner,
          leaseExpiresAt: ctx.now.getTime() + this.pollIntervalMs,
        });
        this.audit(current.id, "publish.upload_url", {
          externalId: result.externalId,
          uploadUrlExpiresAt: result.expiresAt,
        });
        ctx.needsPoll.add(current.id);
        const fresh = this.refresh(current.id);
        return this.detail(
          fresh,
          "processing",
          `İkili yükleme başladı; ${result.expiresAt} içinde geçerli.`,
          { externalId: fresh.externalId },
        );
      }
      case "scheduled": {
        // Sağlayıcıya zamanlama bırakıldı. Veritabanında "scheduled" diye bir İŞ
        // durumu YOKTUR; iş `processing` kalır ve yayın gerçekleştiğinde
        // yoklamayla `published`'a geçer. `remoteId` şimdiden yazılır.
        this.moveTo(current, "processing", {
          externalId: current.externalId ?? result.remoteId,
          remoteId: result.remoteId,
          error: null,
          nextAttemptAt: null,
          leaseOwner: this.deps.leaseOwner,
          leaseExpiresAt: ctx.now.getTime() + this.pollIntervalMs,
        });
        this.audit(current.id, "publish.scheduled", {
          remoteId: result.remoteId,
          attempts: current.attempts,
        });
        ctx.needsPoll.add(current.id);
        const fresh = this.refresh(current.id);
        return this.detail(
          fresh,
          "scheduled",
          "Yayın sağlayıcıya zamanlandı; sonucu yoklamayla izleniyor.",
          { remoteId: fresh.remoteId },
        );
      }
      default: {
        const kind = (result as { kind?: string }).kind;
        return this.failJob(
          current,
          buildFailure(
            "validation",
            `Tanımsız startPublish sonucu: ${String(kind)}`,
            ctx.now,
            null,
          ),
          ctx,
        );
      }
    }
  }

  // ── Yoklama ───────────────────────────────────────────────────────────────

  private async pollJob(job: PublishJob, ctx: RunContext): Promise<JobStepDetail | null> {
    const content = this.deps.contents.getById(job.contentId);
    if (!content) return this.defer(job, "content_missing", "İçerik kaydı yok; yoklama yapılamadı.");

    if (content.quietHours && isWithinQuietHours(ctx.now, content.quietHours, content.timezone)) {
      return this.deferQuietHours(job, content.quietHours, content.timezone, ctx);
    }

    const adapter = this.deps.adapters.get(job.platform);
    if (!adapter) return this.defer(job, "adapter_missing", "Adaptör yok.");

    const account = this.deps.accounts.getById(job.accountId);
    if (!account) return this.defer(job, "account_missing", "Hesap kaydı yok.");

    const credential = this.deps.credentials.getByAccountId(account.id);
    if (!credential || !this.deps.cipher) {
      return this.defer(job, "credential_missing", "Kimlik kaydı/şifre çözücü yok; yoklama yapılamadı.");
    }

    let accessToken: string;
    try {
      accessToken = this.deps.cipher.open(credential.accessTokenEnc);
    } catch (err) {
      this.audit(job.id, "publish.credential_unreadable", { message: errorMessage(err) });
      return this.defer(job, "credential_unreadable", `Belirteç çözülemedi: ${errorMessage(err)}`);
    }

    const pollCtx: PollContext = {
      account: {
        id: account.id,
        platform: account.platform,
        externalId: account.externalId,
        accessToken,
        refreshToken: null,
        tokenExpiresAt: credential.tokenExpiresAt,
      },
      externalId: job.externalId,
      uploadUrl: job.uploadUrl,
      uploadUrlExpiresAt: job.uploadUrlExpiresAt,
      uploadedParts: job.uploadedParts,
      totalParts: job.totalParts,
      scheduledAt: job.scheduledAt,
    };

    let poll: PollResult;
    try {
      poll = await adapter.pollPublish(pollCtx);
    } catch (err) {
      return this.handleFailure(job, err, ctx);
    }

    if (poll.error) {
      return this.handleFailure(job, fromLite(poll.error, ctx.now), ctx);
    }

    const remoteId = poll.remoteId ?? job.remoteId ?? job.externalId;
    if (poll.state === "published" || poll.state === "published_no_link") {
      const permalink = poll.permalink ?? null;
      this.finishPublished(job, remoteId, permalink, ctx);
      this.audit(job.id, "publish.published", {
        remoteId,
        permalink,
        providerStatus: poll.providerStatus ?? null,
        attempts: job.attempts,
      });
      return this.detail(this.refresh(job.id), permalink ? "published" : "published_no_link", null, {
        remoteId,
        permalink,
      });
    }

    // Hâlâ işleniyor: kirası `pollIntervalMs` sonrasına yeniden arm et.
    this.armPollLease(job, ctx);
    this.audit(job.id, "publish.processing", {
      providerStatus: poll.providerStatus ?? null,
      retryAfterMs: poll.retryAfterMs ?? null,
      remoteId,
    });
    const fresh = this.refresh(job.id);
    return this.detail(fresh, "processing", "Sağlayıcı yayını işliyor.", { remoteId: fresh.remoteId });
  }

  /**
   * Permalink yoksa `published_no_link`: yayın TAMAM ama kalıcı adres
   * çözümlenemedi (TikTok SELF_ONLY). `published` demek yanlış olurdu — panelde
   * tıklanabilir bir yayın beklenir.
   */
  private finishPublished(
    job: PublishJob,
    remoteId: string | null,
    permalink: string | null,
    ctx: RunContext,
  ): void {
    const state: JobState = permalink ? "published" : "published_no_link";
    this.moveTo(job, state, {
      remoteId,
      permalink,
      error: null,
      nextAttemptAt: null,
      finishedAt: ctx.now.toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  // ── Hata yolu ─────────────────────────────────────────────────────────────

  private handleFailure(job: PublishJob, err: unknown, ctx: RunContext): JobStepDetail {
    if (err instanceof PermanentPublishError) {
      return this.failJob(
        job,
        buildFailure(err.kind, err.message, ctx.now, {
          providerCode: err.providerCode,
          logId: err.logId,
          httpStatus: err.httpStatus,
        }),
        ctx,
      );
    }

    if (err instanceof RetryablePublishError) {
      const attempt = Math.max(1, job.attempts);
      const common = {
        providerCode: err.providerCode,
        logId: err.logId,
        httpStatus: err.httpStatus,
        retryAfterMs: err.retryAfterMs,
      };

      if (!shouldRetry(err.kind, attempt, this.policy)) {
        this.audit(job.id, "publish.retry_exhausted", {
          kind: err.kind,
          attempt,
          message: err.message,
        });
        return this.failJob(job, buildFailure(err.kind, err.message, ctx.now, common), ctx);
      }

      const delayMs = nextDelayMs(attempt, {
        ...this.policy,
        kind: err.kind,
        retryAfterMs: err.retryAfterMs,
        random: this.random,
      });
      const failure = buildFailure(err.kind, err.message, ctx.now, common);
      const nextAttemptAt = ctx.now.getTime() + delayMs;

      // `recordFailure` durumu `failed` yazar, `finishedAt`'ı retryable
      // hatalarda BOŞ BIRAKIR ve `canRequeueForRetry` yolunu açar: `claimDue`
      // üçüncü dalı `next_attempt_at <= now` olunca işi yeniden kuyruğa alır.
      this.deps.jobs.recordFailure(job.id, failure, nextAttemptAt);
      const fresh = this.refresh(job.id);

      if (!canRequeueForRetry(fresh.state)) {
        // Savunma: politika "yeniden dene" dedi ama durum makinesi izin
        // vermiyor. YUTULMAZ; sonuç dürüstçe `failed` olarak bildirilir.
        this.audit(job.id, "publish.requeue_forbidden", {
          state: fresh.state,
          kind: err.kind,
          attempt,
        });
        return this.detail(fresh, "failed", "Yeniden deneme planlandı ama iş kuyruğa alınamadı.", {
          error: failure,
        });
      }

      this.audit(job.id, "publish.retried", {
        kind: err.kind,
        attempt,
        delayMs,
        nextAttemptAt,
        message: err.message,
      });
      return this.detail(fresh, "retried", err.message, { error: failure });
    }

    return this.handleUnexpected(job, err, ctx);
  }

  /**
   * Beklenmeyen hata. `unknown` sınıfı YENİDEN DENENMEZ: motor bir program
   * hatasında kuyruğu sonsuza kadar döndürmez; ama denetime yazılır ki
   * "bu iş neden durdu" sorusu cevaplanabilsin.
   */
  private handleUnexpected(job: PublishJob, err: unknown, ctx: RunContext): JobStepDetail {
    const message = errorMessage(err);
    this.audit(job.id, "publish.internal_error", {
      message,
      name: err instanceof Error ? err.name : typeof err,
      state: job.state,
      attempts: job.attempts,
    });
    return this.failJob(job, buildFailure("unknown", message, ctx.now, null), ctx);
  }

  /** Kalıcı hata: `failed`, yeniden deneme YOK. */
  private failJob(job: PublishJob, failure: PublishFailure, ctx: RunContext): JobStepDetail {
    const current = this.refresh(job.id);
    if (current.state !== "failed") assertTransition(current.state, "failed");
    this.deps.jobs.recordFailure(job.id, failure, null);
    this.audit(job.id, "publish.failed", {
      kind: failure.kind,
      message: failure.message,
      providerCode: failure.providerCode,
      logId: failure.logId,
      httpStatus: failure.httpStatus,
      attempts: current.attempts,
    });
    return this.detail(this.refresh(job.id), "failed", failure.message, { error: failure });
  }

  // ── Durum makinesi ───────────────────────────────────────────────────────

  /**
   * `from → to` yolunu `ALLOWED_TRANSITIONS` üzerinden BFS ile bulur ve her
   * atlamada `assertTransition` çağırır.
   *
   * NEDEN BFS: `claimDue` işi her zaman `preparing`'e ÇEKER; kirası dolan bir
   * `processing` işi de `preparing` görünür. Doğrudan
   * `assertTransition("preparing","published")` denemek MEŞRU bir akışı
   * reddeder. BFS yalnız izin verilen kenarları kullandığı için zincir de
   * meşrudur ve her atlama yine de doğrulanır.
   */
  private moveTo(job: PublishJob, target: JobState, patch: JobPatch): void {
    let current = job.state;
    if (current === target) {
      // Aynı duruma "geçiş" tanımlı değildir; alan doğrudan yazılır.
      this.deps.jobs.markState(job.id, target, patch);
      return;
    }

    const path = statePath(current, target);
    if (path === null) {
      const reason = explainTransition(current, target) ?? "izin verilen yol yok";
      // Bu bir PROGRAM HATASIDIR: motor geçersiz bir zincir kurmuş demektir.
      // Yutulmaz — denetime yazılır ve `tick` bunu yakalayıp işi kapatır.
      this.audit(job.id, "publish.illegal_transition", { from: current, to: target, reason });
      throw new IllegalTransitionError(current, target, reason);
    }

    const chain = path.slice(1);
    for (let i = 0; i < chain.length; i += 1) {
      const hop = chain[i] as JobState;
      assertTransition(current, hop);
      this.deps.jobs.markState(job.id, hop, i === chain.length - 1 ? patch : {});
      current = hop;
    }
    if (chain.length + 1 > LONG_PATH_ALERT) {
      this.audit(job.id, "publish.long_path", { from: job.state, to: target, path });
    }
  }

  /**
   * İşi kuyruğa geri bırakır: durum `queued`, kiralama serbest.
   *
   * `patch` verilirse o alanlar aynı yazmada gider. `deferUntil` zaman damgasını
   * BURADA değil, kiralama bırakılmadan ÖNCE yazıp doğrular (bkz. `deferUntil`).
   */
  private release(job: PublishJob, patch: JobPatch = {}): void {
    if (job.state !== "queued") assertTransition(job.state, "queued");
    this.deps.jobs.markState(job.id, "queued", {
      ...patch,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  private deferQuietHours(
    job: PublishJob,
    quiet: QuietHours,
    timezone: string,
    ctx: RunContext,
  ): JobStepDetail {
    const resolved = resolveQuietTarget(ctx.now, quiet, timezone);
    // `null` = UYGUN AN BULUNAMADI (dejenere bir sessiz saat tanımı). `deferUntil`
    // `until` bekler; hedef verilemezse iş `queued` kalır ve `DUE_SELECTION`
    // onu HER TICK geri verir — sıcak `skipped` döngüsü.
    //
    // KARAR: +1 saatlik GÜVENLİ varsayılan. Yayın yine de yapılmaz (sessiz
    // saat emri ağır basar) ama kuyruk ilerler ve döngü sıcak değildir;
    // `failed`/`policy` ile durdurmak yayını da öldürürdü — hata iş mantığında
    // değil YAPILANDIRMADA'dır ve asıl görünmesi gereken yer denetimdir.
    const until = resolved ?? new Date(ctx.now.getTime() + FALLBACK_DEFER_MS).toISOString();
    if (resolved === null) {
      this.audit(job.id, "publish.quiet_defer_unresolved", {
        timezone,
        quietHours: quiet,
        fallbackMs: FALLBACK_DEFER_MS,
      });
    }
    this.audit(job.id, "publish.deferred_quiet_hours", {
      until,
      timezone,
      quietHours: quiet,
      state: job.state,
      resolved: resolved !== null,
    });
    return this.deferUntil(job, until, "Sessiz saat", ctx);
  }

  /**
   * İşi `until` zamanına kadar ERTELER.
   *
   * SIRA ÖNEMLİDİR — önce `scheduled_at` YAZILIR ve yazma DOĞRULANIR, SONRA iş
   * kuyruğa bırakılır:
   *   * Doğrulama kiralama bırakıldıktan sonra yapılsaydı, yazma tutmazsa iş
   *     `queued`/kirasız kalır ve `DUE_SELECTION` onu her tick geri verirdi.
   *   * `queued → failed` doğrudan YASAK olduğu için o konumda hata yolu da
   *     kilitlenirdi. Doğrulama iş hâlâ kiralanmışken yapılır.
   *
   * DOĞRULAMA NEDEN VAR: `JobPatch.scheduledAt` bir SÖZLEŞMEDİR; `markState`
   * bu alanı yazmakla borçludur. Depo sürümü değişir ya da kırılırsa erteleme
   * sessizce başarısız olur, `scheduled_at <= now` hep doğru kalır ve iş
   * "her tick'te yeniden ertele" döngüsüne girer. TELAFİ YOKTUR (kiralama yeniden
   * arm edilmez): tespit yeterlidir. Yazılmayan bir erteleme, işin kuyrukta
   * sonsuza kadar beklemesinden ve "gerekçesiz atlama" üretmesinden iyidir.
   */
  private deferUntil(
    job: PublishJob,
    until: string,
    label: string,
    ctx: RunContext,
    /** Kullanıcıya gösterilecek ek gerekçe. Verilmezse varsayılan kullanılır. */
    reason?: string,
  ): JobStepDetail {
    this.deps.jobs.markState(job.id, job.state, { scheduledAt: until });
    const fresh = this.refresh(job.id);
    const storedMs = Date.parse(fresh.scheduledAt);

    // İKİ KOŞUL BİRDEN: yazma tuttu mu (AN), tuttuysa iş kuyruğa geri dönmüyor
    // mu (GELECEĞE yazıldı). `scheduled_at <= now` kalan her değer bir
    // "her tick'te yeniden ertele" döngüsüdür.
    if (!sameInstant(fresh.scheduledAt, until) || !(storedMs > ctx.now.getTime())) {
      this.audit(job.id, "publish.defer_write_rejected", {
        label,
        until,
        actual: fresh.scheduledAt,
        note: "PublishJobRepo.markState scheduled_at sütununu yazmadı; erteleme uygulanamadı.",
      });
      return this.failDeferringJob(
        job,
        `${label} ertelenemedi: scheduled_at yazılmadı (istenen ${until}, okunan ${fresh.scheduledAt || "null"}). ` +
          "Bu kuyruk işi her tur yeniden deneyeceği için iş durduruldu.",
        ctx,
      );
    }

    this.release(job);
    const text = reason ?? `${label}: sıra ${until} içine alındı.`;
    return this.detail(this.refresh(job.id), "skipped", text, {
      scheduledAt: until,
      state: "queued",
    });
  }

  /**
   * Erteleme YAZILAMADI: iş kuyrukta bekletilmez.
   *
   * `scheduled_at` ileri yazılmadığı için `DUE_SELECTION` işi her tick'te yine
   * verir ve motor sonsuz `skipped` döngüsünde döner. Karar: `failed` + gerekçeli
   * denetim kaydı. Yeniden deneme YOK — sebep iş mantığı değil depo
   * sözleşmesidir, motor kendi tekrarıyla düzeltemez.
   *
   * `moveTo` ile yazılır (doğrudan `recordFailure` değil): `queued`'dan `failed`
   * doğrudan geçiş YASAK olduğu için BFS yasal yolu (`queued → preparing →
   * failed`) bulur ve her bacağı `assertTransition` ile doğrular.
   */
  private failDeferringJob(job: PublishJob, message: string, ctx: RunContext): JobStepDetail {
    const failure = buildFailure("unknown", message, ctx.now, null);
    this.moveTo(job, "failed", {
      error: failure,
      nextAttemptAt: null,
      finishedAt: ctx.now.toISOString(),
    });
    this.audit(job.id, "publish.failed", {
      kind: failure.kind,
      message,
      attempts: job.attempts,
      deferWriteRejected: true,
    });
    return this.detail(this.refresh(job.id), "failed", message, { error: failure });
  }

  private defer(job: PublishJob, code: string, message: string): JobStepDetail {
    this.audit(job.id, "publish.skipped", { code, message, state: job.state });
    this.release(job);
    return this.detail(this.refresh(job.id), "skipped", `${code}: ${message}`);
  }

  // ── Yardımcılar ───────────────────────────────────────────────────────────

  private refresh(id: string): PublishJob {
    return this.deps.jobs.getById(id) ?? emptyJob(id);
  }

  private resolveCopyFor(override: PlatformCopyOverride | null | undefined): ResolvedCopy {
    // Taban: sözleşmenin kendi varsayılanları (`PlatformCopySchema`), elle
    // yazılmış bir kopya değil — şema ile ayrışırsa AI bildirimi ya da
    // gizlilik sessizce düşer.
    const merged = resolveCopy(PlatformCopySchema.parse({}), override);
    return {
      caption: merged.caption ?? null,
      hashtags: merged.hashtags,
      title: merged.title ?? null,
      description: merged.description ?? null,
      tags: merged.tags,
      privacy: merged.privacy,
      coverAtPercent: merged.coverAtPercent,
      aiGenerated: merged.aiGenerated,
      selfDeclaredMadeForKids: merged.selfDeclaredMadeForKids,
      madeForShorts: merged.madeForShorts,
    };
  }

  /** İçerik durumunu platform işlerinden türetir (tek kaynak: `aggregateContentState`). */
  private syncContentStates(details: readonly JobStepDetail[]): void {
    for (const contentId of new Set(details.map((d) => d.contentId))) {
      const states = this.deps.jobs.listByContent(contentId).map((j) => j.state);
      this.deps.contents.setState(contentId, aggregateContentState(states));
    }
  }

  private audit(targetId: string, action: string, detail: Record<string, unknown>): void {
    try {
      this.deps.audit.record({ actor: this.actor, action, targetType: "publish_job", targetId, detail });
    } catch {
      // Denetim kaydı yazılamazsa iş akışı DURMAZ: yayın yapılamaz hale
      // gelmesi, kaydın kaybolmasından daha kötüdür. Bu tek kanal zaten hataya
      // bağlı olduğu için burada başka yol yok.
    }
  }

  private detail(
    job: PublishJob,
    outcome: StepOutcome,
    reason: string | null,
    extra: Partial<JobStepDetail> = {},
  ): JobStepDetail {
    return {
      jobId: job.id,
      contentId: job.contentId,
      platform: job.platform,
      state: job.state,
      outcome,
      reason,
      attempts: job.attempts,
      externalId: job.externalId,
      remoteId: job.remoteId,
      permalink: job.permalink,
      error: job.error,
      scheduledAt: job.scheduledAt,
      ...extra,
    };
  }
}

// ── Yardımcılar ────────────────────────────────────────────────────────────

function emptyJob(id: string): PublishJob {
  return {
    id,
    contentId: "",
    platform: "instagram",
    accountId: "",
    state: "failed",
    scheduledAt: "",
    attempts: 0,
    idempotencyKey: "",
    idempotencyFirstUsedAt: null,
    externalId: null,
    uploadUrl: null,
    uploadUrlExpiresAt: null,
    uploadedParts: 0,
    totalParts: null,
    remoteId: null,
    permalink: null,
    error: null,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "",
    updatedAt: "",
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * İki zaman damgası AYNI AN mı?
 *
 * METİN KARŞILAŞTIRMASI YAPILMAZ: `toISOString()` daima `.sssZ` üretir ama
 * veritabanındaki değer başka bir yoldan (başka istemci, geçmiş sürüm, elle
 * düzeltme) `+00:00` ya da saniye hassasiyetsiz yazılmış olabilir; iki metin
 * farklı, iki an aynıdır. Karşılaştırma AN üzerinden yapılır ve bir saniyelik
 * tolerans bırakılır (yuvarlama farkı bir kusur değildir).
 */
function sameInstant(a: string | null | undefined, b: string | Date): boolean {
  const x = typeof a === "string" ? Date.parse(a) : Number.NaN;
  const y = b instanceof Date ? b.getTime() : Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= INSTANT_TOLERANCE_MS;
}

/**
 * `PollResult.error` (lite) → motorun kullandığı hata SINIFI. Politika kararı
 * `isRetryableKind`'ten gelir; burada elle yazılmış bir geçici/kalıcı listesi
 * yoktur (sözleşme tek kaynak diye bunu yasaklar).
 */
function fromLite(lite: PublishFailureLite, _at: Date): unknown {
  if (!isRetryableKind(lite.kind)) {
    return new PermanentPublishError(lite.message, lite.kind, lite.providerCode, lite.logId, lite.httpStatus);
  }
  // `isRetryableKind` bir TİP YAKINI değil (sözleşme bir `Set.has`), bu yüzden
  // burada daraltma elle yapılır: aynı kaynak (`isRetryableKind`) kararı verdi,
  // liste ikinci kez yazılmaz.
  return new RetryablePublishError(
    lite.message,
    lite.kind as Extract<PublishFailure["kind"], "network" | "ratelimit" | "server" | "transient">,
    null,
    lite.providerCode,
    lite.logId,
    lite.httpStatus,
  );
}

function buildFailure(
  kind: PublishFailure["kind"],
  message: string,
  at: Date,
  extra: {
    providerCode?: string | null;
    logId?: string | null;
    httpStatus?: number | null;
    retryAfterMs?: number | null;
  } | null,
): PublishFailure {
  return {
    kind,
    message,
    providerCode: extra?.providerCode ?? null,
    logId: extra?.logId ?? null,
    httpStatus: extra?.httpStatus ?? null,
    retryAfterMs: extra?.retryAfterMs ?? null,
    // Politika TEK KAYNAKTAN: `isRetryableKind`. Depolama katmanı da bunu
    // yeniden hesaplar; elle yazılmış bayrak yanlış karar üretir.
    retryable: isRetryableKind(kind),
    at: at.toISOString(),
  };
}

// ── Sessiz saat ────────────────────────────────────────────────────────────

/**
 * Sessiz saat bitince ilk uygun an.
 *
 * "Şu andan `quiet.end` kadar dakika ekle" basitçe hesaplanır ve sonra
 * `isWithinQuietHours` ile DOĞRULANIR. DST geçişlerinde ilk tahmin yanlış günü
 * seçebilir; doğrulama döngüsü bunu bir dakikalık adımlarla düzeltir. Döngü
 * iki günle sınırlıdır ki bir hata sonsuz döngüye dönmesin.
 */
export function nextEligibleTime(
  instant: Date,
  quiet: QuietHours,
  timezone: string,
): Date {
  const endMinutes = toMinutes(quiet.end);
  const nowMinutes = localMinutes(instant, timezone);
  let delta = endMinutes - nowMinutes;
  if (delta <= 0) delta += 24 * 60;

  let candidate = new Date(instant.getTime() + delta * 60_000);
  for (let i = 0; i < 2 * 24 * 60 && isWithinQuietHours(candidate, quiet, timezone); i += 1) {
    candidate = new Date(candidate.getTime() + 60_000);
  }
  return candidate;
}

/**
 * Sessiz saatin bitiminden sonraki ilk uygun an (ISO). ÇÖZÜLEMEZSE `null`.
 *
 * `nextEligibleTime` araması iki günle sınırlıdır; sınır aşılırsa döndürdüğü an
 * hâlâ sessiz saatte demektir. Böyle bir anı "erteleme hedefi" diye kullanmak,
 * işi her tur yeniden ertelemekten başka bir şey yapmaz (sıcak döngü). Sonuç bu
 * yüzden DOĞRULANIR; çağıran (`deferQuietHours`) `null` için güvenli bir
 * varsayılana düşer.
 */
function resolveQuietTarget(now: Date, quiet: QuietHours, timezone: string): string | null {
  const next = nextEligibleTime(now, quiet, timezone);
  const ms = next.getTime();
  if (!Number.isFinite(ms) || ms <= now.getTime()) return null;
  if (isWithinQuietHours(next, quiet, timezone)) return null;
  return next.toISOString();
}

function localMinutes(instant: Date, timezone: string): number {
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
  return toMinutes(hhmm);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

// ── Durum yolu (BFS) ───────────────────────────────────────────────────────

const PATH_CACHE = new Map<string, JobState[] | null>();

/** `from → to` için izin verilen en kısa yol (uçlar dâhil). Yol yoksa `null`. */
export function statePath(from: JobState, to: JobState): JobState[] | null {
  if (from === to) return [from];
  const key = `${from}>${to}`;
  if (PATH_CACHE.has(key)) return PATH_CACHE.get(key) ?? null;

  const prev = new Map<JobState, JobState>();
  const queue: JobState[] = [from];
  const seen = new Set<JobState>([from]);
  let found: JobState[] | null = null;

  while (queue.length > 0) {
    const head = queue.shift() as JobState;
    if (head === to) {
      const path = [head];
      let cursor = head;
      while (prev.has(cursor)) {
        cursor = prev.get(cursor) as JobState;
        path.unshift(cursor);
      }
      found = path;
      break;
    }
    for (const next of ALLOWED_TRANSITIONS[head]) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, head);
      queue.push(next);
    }
  }

  PATH_CACHE.set(key, found);
  return found;
}
