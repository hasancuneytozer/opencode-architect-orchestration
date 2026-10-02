/**
 * SAHTE YAYINCI ADAPTÖRÜ — üç platform için.
 *
 * NEDEN VAR: kullanıcının Meta/TikTok/Google hesabı yok; gerçek bir adaptör bugün
 * doğrulanamaz. Ama kuyruk, kiralama, durum makinesi, yeniden deneme, sessiz
 * saat ve hata sınıflandırması DOĞRULANMALIDIR. Bu dosya `PublishAdapter`
 * sözleşmesini boşluğa düşmeden doldurur: kimlikler geldiğinde gerçek adaptör
 * aynı arayüzü doldurur, motor değişmez.
 *
 * ── DÜNYA HAFIZADA ──────────────────────────────────────────────────────────
 * `Map<externalId, MockPublishRecord>`: `startPublish` bir "yayın" açar,
 * `pollPublish` ilerletir. `reset()` testler arası izolasyon sağlar; diske
 * hiçbir şey yazılmaz.
 *
 * ── MÜKERRER YAYIN KORUMASI ─────────────────────────────────────────────────
 * `externalId` `idempotencyKey`'den DETERMİNİSTİK olarak türetilir ve dünya
 * anahtarla eşleşir. Aynı anahtarla ikinci `startPublish` yeni bir iş AÇMAZ,
 * ilk çağrının sonucunu birebir döndürür. Bu, motordaki mükerrer yayın
 * savunmasının (girdi anahtarı → tek yayın) doğrudan kanıtıdır.
 *
 * ── PERMALINK ───────────────────────────────────────────────────────────────
 * Üretilen adres `https://example.invalid/...` kullanır. `.invalid` ayrılmış
 * bir üst alan adıdır (RFC 2606) ve ASLA çözünmez: sahte bir yayın adresi
 * gerçek bir hesaba gidiyorsa en kötü hata "yanlışlıkla gerçekten bir şey
 * paylaştık" olur.
 */
import { createHash } from "node:crypto";
import {
  type Platform,
  type PlatformSpec,
  type PublishErrorKind,
  type ValidationFinding,
  isRetryableKind,
} from "../../contract/index.js";
import {
  PermanentPublishError,
  RetryablePublishError,
  type AccountRef,
  type PollContext,
  type PollResult,
  type PublishAdapter,
  type PublishInput,
  type QuotaSnapshot,
  type StartResult,
} from "../../ports/index.js";
import { getSpec } from "../../media/index.js";

/** Yayının durduğu yer. Sahte sunucu tarafı. */
export type MockPublishStatus = "processing" | "published" | "scheduled" | "failed";

/** Sahte sunucuda tutulan tek yayının hâli. */
export interface MockPublishRecord {
  externalId: string;
  idempotencyKey: string;
  platform: Platform;
  jobId: string;
  accountExternalId: string;
  startKind: StartResult["kind"];
  status: MockPublishStatus;
  pollCount: number;
  remoteId: string | null;
  permalink: string | null;
  uploadUrl: string | null;
  uploadUrlExpiresAt: string | null;
  uploadedParts: number;
  totalParts: number | null;
  /** Kapak karesi bayt sayısı; `0` ise kapak gönderilmemiştir. */
  coverBytes: number;
  scheduledAt: string | null;
  /** Aynı anahtarla kaç kez `startPublish` çağrıldı (1 = mükerrer yok). */
  startCalls: number;
  finalized: boolean;
  createdAt: number;
}

/** Davranışı programlanabilir senaryo. Hepsi isteğe bağlı. */
export interface MockScript {
  /** İlk N deneme geçici hatayla düşsün, sonra başarılı olsun. */
  failFirstN?: number;
  failKind?: PublishErrorKind;
  failProviderCode?: string;
  /** `RetryablePublishError.retryAfterMs`; verilmezse null. */
  failRetryAfterMs?: number | null;
  /** Kac polling turu "işleniyor" sonrası başarılı dönsün. Varsayılan 0. */
  processingPolls?: number;
  /** Native zamanlama destekli platformlarda true dönsün. */
  returnScheduled?: boolean;
  /** publish_id sonrası kaç tur sonra tamamlansın. */
  publishAfterPolls?: number;
  /** upload_url veren yol (IG resumable, TikTok chunk). */
  uploadUrlTtlSec?: number;
  /** quota okunsun mu. */
  quota?: { used: number; total: number; windowSec: number };
  /**
   * `StartResult` dalı. Verilmezse şu sırayla çıkarılır:
   * `uploadUrlTtlSec` → `uploadUrl`, `returnScheduled` → `scheduled`,
   * aksi hâlde `pending`.
   */
  startResult?: "pending" | "immediate" | "uploadUrl" | "scheduled";
  /** Yayın tamam ama permalink yok (TikTok SELF_ONLY). */
  omitPermalink?: boolean;
  /** Kapak ZORUNLU olsun mu? Varsayılan false: adaptör kapak zorunlu kılmaz. */
  requireCover?: boolean;
}

export interface MockPublishAdapterOptions {
  /**
   * Zaman kaynağı. Üretimde `Date.now`; testlerde sabit bir değer verilir ki
   * "yükleme adresi süresi doldu" senaryosu saat dilimine bağlı olmasın.
   */
  now?: () => number;
  /** Sahte permalink tabanı. `.invalid` dışına çıkmaz. */
  permalinkBase?: string;
}

/** Varsayılan başarı eşiği: ilk yoklamada tamamlanır (tek tick'lik E2E için). */
const DEFAULT_PROCESSING_POLLS = 0;

/**
 * `idempotencyKey` → kalıcı `externalId`. Aynı anahtar aynı kimliği verir;
 * iki farklı anahtar pratik olarak çakışmaz (128 bit kesilmiş SHA-256).
 */
export function mockExternalId(platform: Platform, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`mock:${platform}:${idempotencyKey}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `mock_${digest}`;
}

/** Çağrı sayaçları — testler "kaç kez çağrıldı" diye sorar. */
export interface MockCounters {
  precheck: number;
  start: number;
  poll: number;
  finalize: number;
  quota: number;
}

export class MockPublishAdapter implements PublishAdapter {
  readonly platform: Platform;
  /**
   * Platformun sınırları SAHTE DEĞİLDİR: `getSpec` aynı `PlatformSpec`'i
   * döndürür. Böylece motor "9:16 değil" kararını gerçek sınırlarla verir ve
   * sahte adaptörün kendi kopyasıyla ayrışamaz.
   */
  readonly spec: PlatformSpec;

  private readonly script: MockScript;
  private readonly now: () => number;
  private readonly permalinkBase: string;
  private readonly byExternalId = new Map<string, MockPublishRecord>();
  private readonly byIdempotencyKey = new Map<string, MockPublishRecord>();
  private readonly counters: MockCounters = {
    precheck: 0,
    start: 0,
    poll: 0,
    finalize: 0,
    quota: 0,
  };

  constructor(
    platform: Platform,
    script: MockScript = {},
    opts: MockPublishAdapterOptions = {},
  ) {
    this.platform = platform;
    this.spec = getSpec(platform);
    this.script = { ...script };
    this.now = opts.now ?? (() => Date.now());
    this.permalinkBase = (opts.permalinkBase ?? "https://example.invalid").replace(/\/+$/, "");
  }

  // ── Test kancaları ────────────────────────────────────────────────────────

  /** Testler arası izolasyon: dünya ve sayaçlar sıfırlanır. */
  reset(): void {
    this.byExternalId.clear();
    this.byIdempotencyKey.clear();
    this.counters.precheck = 0;
    this.counters.start = 0;
    this.counters.poll = 0;
    this.counters.finalize = 0;
    this.counters.quota = 0;
  }

  callCounts(): Readonly<MockCounters> {
    return { ...this.counters };
  }

  /** Dünyadaki kayıtların kopyası (yeni→eski değil, oluşma sırası). */
  world(): MockPublishRecord[] {
    return [...this.byExternalId.values()].map((r) => ({ ...r }));
  }

  record(externalId: string): MockPublishRecord | null {
    const found = this.byExternalId.get(externalId);
    return found ? { ...found } : null;
  }

  recordByKey(idempotencyKey: string): MockPublishRecord | null {
    const found = this.byIdempotencyKey.get(idempotencyKey);
    return found ? { ...found } : null;
  }

  /** Parça ilerlemesini elle ayarla (yarım yükleme senaryosu için). */
  setUploadProgress(externalId: string, uploadedParts: number, totalParts: number | null): boolean {
    const rec = this.byExternalId.get(externalId);
    if (!rec) return false;
    rec.uploadedParts = uploadedParts;
    rec.totalParts = totalParts;
    return true;
  }

  // ── PublishAdapter ────────────────────────────────────────────────────────

  /**
   * Yayına gitmeden önceki son kontrol.
   *
   * İki kural:
   *  - `media.info` bozuksa `media_rejected` HATA bulgusu üretilir (motor bunu
   *    kalıcı hataya çevirir, iş yayına GİTMEZ);
   *  - sağlayıcı tarafında parça ilerlemesi eksikse "yükleme yarım" UYARISI
   *    üretilir (yayını durdurmaz, panelde görünür).
   */
  async precheck(input: PublishInput): Promise<ValidationFinding[]> {
    this.counters.precheck += 1;
    const findings: ValidationFinding[] = [];
    const info = input.media.info;

    const broken: string[] = [];
    if (!info || typeof info !== "object") broken.push("info yok");
    else {
      if (!(info.bytes > 0)) broken.push("bayt sayısı sıfır veya bilinmiyor");
      if (!info.videoCodec) broken.push("video akışı yok");
      if (!info.width || !info.height) broken.push("genişlik/yükseklik bilinmiyor");
      if (info.bytes <= 0) broken.push("bayt sayısı sıfır");
    }
    if (broken.length > 0) {
      findings.push({
        code: "media_rejected",
        severity: "error",
        message:
          `Medya yayına uygun değil (${this.platform}): ${broken.join(", ")}. ` +
          `Klip ffprobe ile yeniden okunmalı; yayın gönderilmez.`,
        observed: JSON.stringify({
          bytes: info?.bytes ?? null,
          videoCodec: info?.videoCodec ?? null,
          width: info?.width ?? null,
          height: info?.height ?? null,
        }),
      });
    }

    if (this.script.requireCover && (input.coverBytes === null || input.coverBytes.length === 0)) {
      findings.push({
        code: "cover_missing",
        severity: "error",
        message:
          `Kapak karesi zorunlu (${this.platform}) ama kapak gönderilmedi. ` +
          `coverAtPercent değerini kontrol edin.`,
      });
    } else if (input.coverBytes !== null && input.coverBytes.length === 0) {
      // Kapak GÖNDERİLDİ ama boş: sessizce yok saymak, sağlayıcının "kapak
      // yok" davranışını taklit etmekten daha kötüdür.
      findings.push({
        code: "cover_empty",
        severity: "error",
        message: "Kapak karesi gönderildi ama SIFIR bayt; kapak çıkarma başarısız olmuş.",
        observed: "0",
      });
    }

    const rec = this.byIdempotencyKey.get(input.idempotencyKey);
    if (rec && rec.totalParts !== null && rec.uploadedParts < rec.totalParts) {
      findings.push({
        code: "upload_incomplete",
        severity: "warning",
        message:
          `Yükleme yarım kalmış: ${rec.uploadedParts}/${rec.totalParts} parça kabul edilmiş. ` +
          `Yayın yine de denenecek.`,
        limit: String(rec.totalParts),
        observed: String(rec.uploadedParts),
      });
    }

    return findings;
  }

  /**
   * Yüklemeyi başlatır / sürdürür.
   *
   * Sıra ÖNEMLİDİR: `failFirstN` sayacı, dünya kaydına bakılmadan ÖNCE artar —
   * aksi hâlde aynı anahtarla gelen ikinci (mükerrer) çağrı yeniden hata
   * fırlatır ve mükerrer koruması hata sanılır.
   */
  async startPublish(input: PublishInput): Promise<StartResult> {
    this.counters.start += 1;

    const existing = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      existing.startCalls += 1;
      // YENİ İŞ YOK. Aynı sonucu döndürür: sağlayıcı ikinci kez yayınlamaz.
      return this.replay(existing);
    }

    if (
      input.coverBytes !== null &&
      input.coverBytes.length === 0
    ) {
      throw new PermanentPublishError(
        `Kapak karesi boş (0 bayt); ${this.platform} yayını başlatılamaz.`,
        "media_rejected",
      );
    }

    const failFirstN = this.script.failFirstN ?? 0;
    if (failFirstN > 0 && this.counters.start <= failFirstN) {
      throw this.buildFailure(failFirstN);
    }

    const externalId = mockExternalId(this.platform, input.idempotencyKey);
    const kind = this.resolveStartKind();
    const nowMs = this.now();
    const permalink = this.script.omitPermalink
      ? null
      : `${this.permalinkBase}/${this.platform}/${externalId}`;

    const rec: MockPublishRecord = {
      externalId,
      idempotencyKey: input.idempotencyKey,
      platform: this.platform,
      jobId: input.jobId,
      accountExternalId: input.account.externalId,
      startKind: kind,
      status: kind === "scheduled" ? "scheduled" : "processing",
      pollCount: 0,
      remoteId: null,
      permalink,
      uploadUrl:
        kind === "uploadUrl"
          ? `${this.permalinkBase}/upload/${this.platform}/${externalId}`
          : null,
      uploadUrlExpiresAt:
        kind === "uploadUrl"
          ? new Date(nowMs + (this.script.uploadUrlTtlSec ?? 3600) * 1000).toISOString()
          : null,
      // Parça sayısını BİLMEYİZ: adaptörün içindedir. null dürüst yanıt.
      uploadedParts: 0,
      totalParts: null,
      coverBytes: input.coverBytes?.length ?? 0,
      scheduledAt: input.scheduledAt,
      startCalls: 1,
      finalized: false,
      createdAt: nowMs,
    };
    this.byExternalId.set(externalId, rec);
    this.byIdempotencyKey.set(input.idempotencyKey, rec);
    return this.toStartResult(rec);
  }

  async pollPublish(ctx: PollContext): Promise<PollResult> {
    this.counters.poll += 1;

    const key = ctx.externalId;
    const rec = key ? this.byExternalId.get(key) : undefined;
    if (!rec) {
      // Bilinmeyen kimlik KALICI hatadır: yeniden denemek işe yaramaz, çünkü
      // bizim dünyamızda olmayan bir yayın bizim hatamız değil.
      throw new PermanentPublishError(
        `Bilinmeyen yayın kimliği: ${key ?? "(null)"}. ` +
          `Harici kimlik bu adaptörde açılmamış; kalıcı hata.`,
        "validation",
        "unknown_external_id",
      );
    }

    const expiresAt = ctx.uploadUrlExpiresAt ?? rec.uploadUrlExpiresAt;
    if (expiresAt !== null) {
      const expiryMs = Date.parse(expiresAt);
      if (!Number.isNaN(expiryMs) && expiryMs <= this.now()) {
        rec.status = "failed";
        throw new PermanentPublishError(
          `Yükleme adresi/konteyner süresi doldu (${expiresAt}). ` +
            `Bu yükleme bir daha kurtarılamaz; baştan başlatmak gerekir.`,
          "container_expired",
          "expired",
        );
      }
    }

    rec.pollCount += 1;
    const before =
      this.script.publishAfterPolls ?? this.script.processingPolls ?? DEFAULT_PROCESSING_POLLS;
    // Sağlayıcıya bırakılmış bir yayın, `scheduledAt` anında olmadan "canlı"
    // sayılmaz: en az bir tur daha beklenir. (Yoksa "şimdi yayınla" ile
    // zamanlanmış yayın aynı tikte hem scheduled hem published bildirirdi.)
    const effectiveBefore = rec.status === "scheduled" ? Math.max(before, 1) : before;

    if (rec.pollCount <= effectiveBefore) {
      return {
        state: "processing",
        retryAfterMs: 50,
        providerStatus: rec.status === "scheduled" ? "PENDING_FOR_SCHEDULE" : "IN_PROGRESS",
      };
    }

    rec.status = "published";
    rec.remoteId = rec.externalId;
    return {
      state: "published",
      remoteId: rec.remoteId,
      permalink: rec.permalink,
      providerStatus: "PUBLISHED",
    };
  }

  async finalize(input: PublishInput, _result: PollResult): Promise<void> {
    this.counters.finalize += 1;
    const rec = this.byIdempotencyKey.get(input.idempotencyKey);
    if (rec) rec.finalized = true;
  }

  async readQuota(_account: AccountRef): Promise<QuotaSnapshot | null> {
    this.counters.quota += 1;
    const q = this.script.quota;
    if (!q) return null;
    return { used: q.used, total: q.total, windowSec: q.windowSec };
  }

  // ── İç yardımcılar ────────────────────────────────────────────────────────

  private resolveStartKind(): StartResult["kind"] {
    if (this.script.startResult) return this.script.startResult;
    if (this.script.uploadUrlTtlSec !== undefined) return "uploadUrl";
    if (this.script.returnScheduled) return "scheduled";
    return "pending";
  }

  private buildFailure(failFirstN: number): Error {
    const kind = this.script.failKind ?? "server";
    const message = `Sahte sağlayıcı hatası: ${kind} (${this.counters.start}/${failFirstN}).`;
    const providerCode = this.script.failProviderCode ?? null;
    if (isRetryableKind(kind)) {
      return new RetryablePublishError(
        message,
        // `isRetryableKind` yalnızca dört sınıfı kabul eder; TS daraltması burada.
        kind as Extract<PublishErrorKind, "network" | "ratelimit" | "server" | "transient">,
        this.script.failRetryAfterMs ?? null,
        providerCode,
        `log-mock-${this.counters.start}`,
        null,
      );
    }
    return new PermanentPublishError(message, kind, providerCode, `log-mock-${this.counters.start}`, null);
  }

  private toStartResult(rec: MockPublishRecord): StartResult {
    switch (rec.startKind) {
      case "immediate":
        rec.remoteId = rec.externalId;
        return { kind: "immediate", remoteId: rec.externalId, permalink: rec.permalink, state: "published" };
      case "uploadUrl":
        return {
          kind: "uploadUrl",
          externalId: rec.externalId,
          uploadUrl: rec.uploadUrl ?? "",
          expiresAt: rec.uploadUrlExpiresAt ?? new Date(this.now()).toISOString(),
          state: "processing",
        };
      case "scheduled":
        rec.remoteId = rec.externalId;
        return { kind: "scheduled", remoteId: rec.remoteId, state: "processing" };
      case "pending":
      default:
        return { kind: "pending", externalId: rec.externalId, state: "processing" };
    }
  }

  /** Aynı `idempotencyKey` için ikinci çağrının cevabı: ilk çağrının aynısı. */
  private replay(rec: MockPublishRecord): StartResult {
    return this.toStartResult(rec);
  }
}
