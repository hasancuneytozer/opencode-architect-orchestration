/**
 * `publish_jobs` — iş kuyruğu. Zamanlayıcının kalbi.
 *
 * Üç kural burada yaşar:
 *
 * 1) ATOMİK KİRALAMA (`claimDue`). "Sırası gelen işi al" ile "durumunu
 *    güncelle" arasında başka bir yazma girerse, aynı iş iki işçiye gider ve
 *    aynı video iki kez yayınlanır. Bu yüzden seçme + güncelleme TEK bir
 *    transaction içindedir ve satırlar `id` sırasıyla kilitlenir.
 *
 *    KRİTİK: kiralama yazılırken durum da `preparing`'e ÇEKİLMEK ZORUNDADIR.
 *    Yalnız `lease_owner`/`lease_expires_at` yazmak yetmez; durum `queued`
 *    kalırsa seçim koşulunun ilk dalı (`state = 'queued'`) bir sonraki tick'te
 *    aynı işi yine verir. Geçmişte tam olarak bu hata vardı.
 *
 * 2) KENDİ KENDİNİ İYİLEŞTİRME. Süreç çökerken `lease_*` sütunları boş
 *    kalabilir (güç kesintisi, OOM, `kill -9` daha transaction'ı COMMIT
 *    etmeden düşürür). `lease_expires_at IS NOT NULL` koşulu böyle bir işi
 *    YALNIZCA değil, HER ZAMAN yeniden alınabilir kılar. Doğru koşul
 *    `lease_expires_at IS NULL OR lease_expires_at < @now`'dur.
 *
 * 3) MÜKERRER YAYIN SAVUNMASI. `idempotency_key` kalıcıdır ve UNIQUE'tir.
 *    Kiralaması dolan iş yeniden başlatıldığında aynı anahtarla sunucuya
 *    gider; sağlayıcı ikinci kez yayınlamaz. `findByIdempotencyKey` aynı işin
 *    YENİDEN BAŞLATILMASI halinde yeni satır açmak yerine mevcut kaydı bulur.
 */
import {
  ALL_JOB_STATES,
  PUBLISH_ERROR_KINDS,
  isRetryableKind,
  type JobState,
  type Platform,
  type PublishErrorKind,
  type PublishFailure,
  type PublishJob,
} from "../../contract/index.js";
import {
  type Db,
  type IdFactory,
  assertJobState,
  assertPlatform,
  nowIso,
  uuid,
} from "./../base.js";
import { fromJson, toJson } from "./../json.js";
import { pageOffset, pageSize } from "./../paging.js";

interface Row {
  id: string;
  content_id: string;
  account_id: string;
  platform: string;
  state: string;
  scheduled_at: string;
  attempts: number;
  idempotency_key: string;
  idempotency_first_used_at: string | null;
  external_id: string | null;
  upload_url: string | null;
  upload_url_expires_at: string | null;
  uploaded_parts: number;
  total_parts: number | null;
  remote_id: string | null;
  permalink: string | null;
  error_json: string | null;
  next_attempt_at: number | null;
  started_at: string | null;
  finished_at: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  created_at: string;
  updated_at: string;
}

const ERROR_KIND_SET = new Set<string>(PUBLISH_ERROR_KINDS);

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * `error_json` → `PublishFailure`.
 *
 * Sütun elle doldurulmuş ya da eski sürüm migration'ı tarafından yazılmış
 * olabilir; okuma tarafı savunmacıdır. `retryable` DEPOLANAN değerden değil
 * `isRetryableKind`'ten türetilir: politika kararının tek kaynağı orasıdır,
 * JSON'daki bayrak eskiyse yanlış "yeniden dene" kararı üretmemek için
 * yeniden hesaplanır.
 */
function toFailure(raw: string | null, fallbackAt: string): PublishFailure | null {
  const parsed = fromJson<unknown>(raw, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const rawKind = asString(o.kind);
  const kind: PublishErrorKind =
    rawKind !== null && ERROR_KIND_SET.has(rawKind) ? (rawKind as PublishErrorKind) : "unknown";
  return {
    kind,
    message: asString(o.message) ?? "",
    providerCode: asString(o.providerCode),
    logId: asString(o.logId),
    httpStatus: asNumber(o.httpStatus),
    retryAfterMs: asNumber(o.retryAfterMs),
    retryable: isRetryableKind(kind),
    at: asString(o.at) ?? fallbackAt,
  };
}

/** Yazmadan önce `PublishFailure`'ı normalleştirir (alan kaybı olmaz). */
function failureToJson(failure: PublishFailure): string {
  return toJson({ ...failure, retryable: isRetryableKind(failure.kind) });
}

function toModel(r: Row): PublishJob {
  return {
    id: r.id,
    contentId: r.content_id,
    platform: r.platform as Platform,
    accountId: r.account_id,
    state: r.state as JobState,
    scheduledAt: r.scheduled_at,
    attempts: r.attempts,
    idempotencyKey: r.idempotency_key,
    idempotencyFirstUsedAt: r.idempotency_first_used_at,
    externalId: r.external_id,
    uploadUrl: r.upload_url,
    uploadUrlExpiresAt: r.upload_url_expires_at,
    uploadedParts: r.uploaded_parts,
    totalParts: r.total_parts,
    remoteId: r.remote_id,
    permalink: r.permalink,
    error: toFailure(r.error_json, r.updated_at),
    nextAttemptAt: r.next_attempt_at,
    leaseOwner: r.lease_owner,
    leaseExpiresAt: r.lease_expires_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Kiralama altındaki (işçide olan) durumlar. */
const LEASED_STATES = ["preparing", "uploading", "processing"] as const;

/**
 * Kiralama serbest bırakılacak durumlar: iş artık kimseye ait değil.
 * `published_no_link` da burada — yayın tamamlandı, permalink çözülemedi;
 * işçi tutmaya devam ederse kuyruk "meşgul" görünür.
 */
const RELEASING_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "published",
  "published_no_link",
  "failed",
  "canceled",
]);

/**
 * `claimDue` ve `explainDueQuery` aynı metni kullanır. Ayrı yazılırsa test,
 * üretim kodundan FARKLI bir sorguyu doğrular ve anlamsızlaşır — geçmişte
 * iki kopya birbirinden ayrılmıştı.
 */
const DUE_SELECTION = `
            WHERE scheduled_at <= @now
              AND (
                    (state = 'queued'
                     AND (lease_expires_at IS NULL OR lease_expires_at < @nowMs))
                 OR (state IN ('preparing','uploading','processing')
                     AND (lease_expires_at IS NULL OR lease_expires_at < @nowMs))
                 OR (state = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= @nowMs)
              )
            ORDER BY scheduled_at ASC, id ASC
            LIMIT @limit`;

export interface CreateJobInput {
  id?: string;
  contentId: string;
  platform: Platform;
  accountId: string;
  scheduledAt: string;
  state?: JobState;
  /**
   * Mükerrer yayın anahtarı. Verilmezse `job:<id>` türetilir: id benzersiz
   * olduğu için anahtar da benzersiz ve BOŞ OLMAZ (UNIQUE indeksi bozan tek
   * durum budur). Gerçek anahtar (TikTok init, YouTube resumable) sunucuya
   * gönderilen anahtardır; çağıran tarafından verilmelidir.
   */
  idempotencyKey?: string;
}

export interface JobPatch {
  externalId?: string | null;
  uploadUrl?: string | null;
  uploadUrlExpiresAt?: string | null;
  uploadedParts?: number;
  totalParts?: number | null;
  remoteId?: string | null;
  permalink?: string | null;
  /** `PublishFailure` NESNESİ; düz metin kabul edilmez. */
  error?: PublishFailure | null;
  nextAttemptAt?: number | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  attempts?: number;
  scheduledAt?: string;
  idempotencyFirstUsedAt?: string | null;
}

/** HTTP kuyruk listeleme filtresi. Tüm alanlar isteğe bağlıdır. */
export interface JobListFilter {
  state?: JobState;
  contentId?: string;
  platform?: Platform;
  limit?: number;
  offset?: number;
}

export interface ClaimOptions {
  now: Date;
  limit: number;
  leaseOwner: string;
  leaseMs: number;
}

export class PublishJobRepo {
  constructor(
    private readonly db: Db,
    private readonly ids: IdFactory = uuid,
  ) {}

  // ── Yazma ───────────────────────────────────────────────────────────────

  create(input: CreateJobInput): PublishJob {
    assertPlatform(input.platform);
    const state = input.state ?? "queued";
    assertJobState(state);
    const ts = nowIso();
    const id = input.id ?? this.ids();
    const row: Row = {
      id,
      content_id: input.contentId,
      account_id: input.accountId,
      platform: input.platform,
      state,
      scheduled_at: input.scheduledAt,
      attempts: 0,
      idempotency_key: input.idempotencyKey ?? `job:${id}`,
      idempotency_first_used_at: null,
      external_id: null,
      upload_url: null,
      upload_url_expires_at: null,
      uploaded_parts: 0,
      total_parts: null,
      remote_id: null,
      permalink: null,
      error_json: null,
      next_attempt_at: null,
      started_at: null,
      finished_at: null,
      lease_owner: null,
      lease_expires_at: null,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO publish_jobs (id, content_id, account_id, platform, state, scheduled_at,
                                   attempts, idempotency_key, idempotency_first_used_at,
                                   external_id, upload_url, upload_url_expires_at,
                                   uploaded_parts, total_parts, remote_id, permalink, error_json,
                                   next_attempt_at, started_at, finished_at,
                                   lease_owner, lease_expires_at, created_at, updated_at)
         VALUES (@id, @content_id, @account_id, @platform, @state, @scheduled_at,
                 @attempts, @idempotency_key, @idempotency_first_used_at,
                 @external_id, @upload_url, @upload_url_expires_at,
                 @uploaded_parts, @total_parts, @remote_id, @permalink, @error_json,
                 @next_attempt_at, @started_at, @finished_at,
                 @lease_owner, @lease_expires_at, @created_at, @updated_at)`,
      )
      .run(row);
    return toModel(row);
  }

  /**
   * Aynı işi ikinci kez KUYRUĞA GİRMEZ.
   *
   * Önce `idempotencyKey` kontrolü yapılır, sonra içerik/platform/hesap üçlüsü:
   * aynı iş yeniden başlatıldığında (süreç çöküp yeniden koşulduğunda) ilk
   * eşleşen kayıt bulunur ve mükerrer yayın başlamaz.
   */
  enqueueUnique(input: CreateJobInput): PublishJob {
    if (input.idempotencyKey) {
      const ayniAnahtarli = this.findByIdempotencyKey(input.idempotencyKey);
      if (ayniAnahtarli) return ayniAnahtarli;
    }
    const existing = this.findByTarget(input.contentId, input.platform, input.accountId);
    return existing ?? this.create(input);
  }

  /**
   * Durum geçişi + istenen alanlar. Kiralama terminal durumlarda serbest
   * bırakılır; aksi halde kuyruk "meşgul" görünür.
   */
  markState(id: string, state: JobState, patch: JobPatch = {}): boolean {
    assertJobState(state);
    const sets: string[] = ["state = @state", "updated_at = @updated_at"];
    const params: Record<string, unknown> = { id, state, updated_at: nowIso() };

    const put = (col: string, key: string, value: unknown) => {
      sets.push(`${col} = @${key}`);
      params[key] = value;
    };
    if ("externalId" in patch) put("external_id", "external_id", patch.externalId ?? null);
    if ("uploadUrl" in patch) put("upload_url", "upload_url", patch.uploadUrl ?? null);
    if ("uploadUrlExpiresAt" in patch) {
      put("upload_url_expires_at", "upload_url_expires_at", patch.uploadUrlExpiresAt ?? null);
    }
    if ("uploadedParts" in patch) put("uploaded_parts", "uploaded_parts", patch.uploadedParts ?? 0);
    if ("totalParts" in patch) put("total_parts", "total_parts", patch.totalParts ?? null);
    if ("remoteId" in patch) put("remote_id", "remote_id", patch.remoteId ?? null);
    if ("permalink" in patch) put("permalink", "permalink", patch.permalink ?? null);
    if ("error" in patch) {
      put("error_json", "error_json", patch.error ? failureToJson(patch.error) : null);
    }
    if ("nextAttemptAt" in patch) put("next_attempt_at", "next_attempt_at", patch.nextAttemptAt ?? null);
    if ("leaseOwner" in patch) put("lease_owner", "lease_owner", patch.leaseOwner ?? null);
    if ("leaseExpiresAt" in patch) put("lease_expires_at", "lease_expires_at", patch.leaseExpiresAt ?? null);
    if ("startedAt" in patch) put("started_at", "started_at", patch.startedAt ?? null);
    if ("finishedAt" in patch) put("finished_at", "finished_at", patch.finishedAt ?? null);
    if ("idempotencyFirstUsedAt" in patch) {
      put(
        "idempotency_first_used_at",
        "idempotency_first_used_at",
        patch.idempotencyFirstUsedAt ?? null,
      );
    }
    if (patch.attempts !== undefined) {
      put("attempts", "attempts", patch.attempts);
    }
    // Erteleme (sessiz saat, kota dolu, "şimdi yayınla" ertelemesi) zamanı
    // buradan yazar. Yazılmazsa `scheduled_at <= @now` koşulu hep doğru kalır ve
    // ertelenen iş HER TICK yeniden alınır — gerekçesiz deneme döngüsü.
    if ("scheduledAt" in patch) put("scheduled_at", "scheduled_at", patch.scheduledAt);

    if (RELEASING_STATES.has(state)) {
      sets.push("lease_owner = NULL", "lease_expires_at = NULL");
    }

    return this.db
      .prepare(`UPDATE publish_jobs SET ${sets.join(", ")} WHERE id = @id`)
      .run(params).changes > 0;
  }

  // ── Kuyruk: sıralama, kiralama, kurtarma ────────────────────────────────

  /**
   * Sırası gelen işleri ATOMİK olarak alır ve durumlarını `preparing`'e çeker.
   *
   * Seçim koşulu:
   *   scheduled_at <= now VE
   *   ( state = 'queued'
   *     VEYA ( state IN ('preparing','uploading','processing')
   *           AND (lease_expires_at IS NULL VEYA lease_expires_at < now) )
   *     VEYA ( state = 'failed' VE next_attempt_at <= now ) )   ← retry
   *
   * `lease_expires_at IS NULL` dalı kendi kendini iyileştirme: süreç çöktüğünde
   * kiralama hiç yazılmamış olabilir, o iş sonsuza kadar bekleyebilirdi.
   *
   * Atomiklik: okuma ve yazma tek transaction'da. better-sqlite3 senkron
   * çalıştığı için bu süre içinde başka bir bağlantı yazamaz (WAL + BEGIN
   * IMMEDIATE), yani "iki çağrı aynı işi görmez".
   */
  claimDue(opts: ClaimOptions): PublishJob[] {
    const { now, limit, leaseOwner, leaseMs } = opts;
    if (limit <= 0) return [];
    if (!leaseOwner) throw new Error("claimDue için leaseOwner zorunludur (tanımlanabilir olmalı).");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error(`claimDue için leaseMs pozitif olmalı, gelen: ${leaseMs}`);
    }
    const nowIsoStr = now.toISOString();
    const nowMs = now.getTime();
    const leaseExpires = nowMs + leaseMs;

    const tx = this.db.transaction((lim: number) => {
      // Adlandırılmış parametreler NESNE ile bağlanır: `@now` sorguda birden çok
      // kez geçse de nesne anahtarı bir kez verilir. Konumsal değer verilirse
      // better-sqlite3 her GEÇİŞ için ayrı değer bekler.
      const rows = this.db
        .prepare<{ now: string; nowMs: number; limit: number }, Row>(
          `SELECT * FROM publish_jobs${DUE_SELECTION}`,
        )
        .all({ now: nowIsoStr, nowMs, limit: lim });

      if (rows.length === 0) return [] as Row[];

      // Kiralama yazımı. Satır satır, tek transaction içinde: başka bir çağrı
      // bu arada listedeki aynı işi seçemez çünkü ya COMMIT'li ya ROLLBACK'li
      // olur. `state = 'preparing'` KESİNLİKLE gereklidir: yalnız lease
      // yazılırsa iş hâlâ 'queued' görünür ve bir sonraki tick onu yine verir.
      const upd = this.db.prepare(
        `UPDATE publish_jobs
         SET state = 'preparing',
             lease_owner = @owner, lease_expires_at = @expires,
             started_at = COALESCE(started_at, @updated), updated_at = @updated
         WHERE id = @id`,
      );
      for (const r of rows) {
        upd.run({ owner: leaseOwner, expires: leaseExpires, updated: nowIsoStr, id: r.id });
        r.state = "preparing";
        r.lease_owner = leaseOwner;
        r.lease_expires_at = leaseExpires;
        r.started_at ??= nowIsoStr;
        r.updated_at = nowIsoStr;
      }
      return rows;
    });

    // BEGIN IMMEDIATE: yazma kilidini beklemeden al, "sıra geldi" kontrolü
    // ile yazma arasında başkası giremesin.
    const rows = tx.immediate(limit);
    return rows.map(toModel);
  }

  /**
   * Uzaktan durum sorulacak işler: uploading/processing ve `external_id`'si olanlar.
   *
   * `now` son güncelleme ÜST SINIRIDIR: `updated_at > now` olan bir iş
   * (saat kayması) sorulmaz. Sorgu önceki sürümde `now`'u ALIYORDU ama hiç
   * kullanmıyordu; better-sqlite3 kullanılmayan parametreyi "Too many parameter
   * values" hatasıyla reddediyordu, yani metot HİÇ ÇALIŞMIYORDU. Kullanılmayan
   * parametreyi sessizce atmak yerine sınır olarak uyguluyoruz.
   *
   * Aralık (kaç ms sonra tekrar sorulacak) yoklayıcının işidir; `ORDER BY
   * updated_at` en eskiyi önce verdiği için çağıran isterse ilk N kaydla
   * sınırlayabilir.
   */
  dueForPoll(now: Date, limit = 20): PublishJob[] {
    return this.db
      .prepare<[string, number], Row>(
        `SELECT * FROM publish_jobs
         WHERE state IN ('uploading','processing')
           AND external_id IS NOT NULL
           AND updated_at <= ?
         ORDER BY updated_at ASC, id ASC
         LIMIT ?`,
      )
      .all(now.toISOString(), limit)
      .map(toModel);
  }

  /**
   * Süresi dolmuş kiralamaları kuyruğa geri koyar ve `attempts` artırır.
   *
   * `attempts` artışı bilinçlidir: çöken süreçteki iş kimse bilmeden yarım
   * kalmış olabilir; deneme sayacı artmalı ki "her zaman yeniden deneriz"
   * durumu oluşmasın. `recoverExpiredLeases` bir "devre" DEĞİLDİR: süresi
   * dolan iş tekrar işlenebilir.
   *
   * `error_json` BURADA TEMİZLENİR ve bir `PublishFailure` uydurulmaz:
   * kiralamanın dolması bir YAYIN hatası değildir; uydurma bir hata nesnesi
   * "kalıcı hatayla başarısız oldu" izlenimi üretir. Kanıt `attempts` ve
   * `updated_at`'tir, gerekiyorsa ayrıca denetim kaydı yazılır.
   */
  recoverExpiredLeases(now: Date): PublishJob[] {
    const nowIsoStr = now.toISOString();
    const nowMs = now.getTime();
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare<[number], Row>(
          `SELECT * FROM publish_jobs
           WHERE lease_expires_at IS NOT NULL
             AND lease_expires_at < ?
             AND state IN ('preparing','uploading','processing')
           ORDER BY lease_expires_at ASC, id ASC`,
        )
        .all(nowMs);

      const upd = this.db.prepare(
        `UPDATE publish_jobs
         SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
             attempts = attempts + 1,
             error_json = NULL,
             updated_at = ?
         WHERE id = ?`,
      );
      for (const r of rows) {
        upd.run(nowIsoStr, r.id);
        r.state = "queued";
        r.lease_owner = null;
        r.lease_expires_at = null;
        r.attempts += 1;
        r.error_json = null;
        r.updated_at = nowIsoStr;
      }
      return rows;
    });
    return tx.immediate().map(toModel);
  }

  // ── Hata kaydı ──────────────────────────────────────────────────────────

  /**
   * Hata kaydeder. `PublishFailure` NESNESİ yazılır (düz metin değil), böylece
   * `logId`, `httpStatus`, `retryAfterMs` gibi destek kanıtları kaybolmaz.
   *
   * Yeniden deneme kararı `isRetryableKind(failure.kind)`'den gelir; politika
   * burada DEĞİL sözleşmededir. `nextAttemptAt` verilmezse `retryAfterMs`
   * kullanılır (sağlayıcı ne zaman deneyeceğimizi söylemişse).
   *
   *   * retryable  → `nextAttemptAt` dolunca `claimDue` yeniden alır, `finishedAt` boş kalır.
   *   * kalıcı     → `finishedAt` yazılır, iş kuyruktan çıkar.
   */
  recordFailure(id: string, failure: PublishFailure, nextAttemptAt: number | null = null): boolean {
    const retryable = isRetryableKind(failure.kind);
    const plan =
      retryable && nextAttemptAt === null && failure.retryAfterMs !== null
        ? Date.parse(failure.at) + failure.retryAfterMs
        : nextAttemptAt;
    const planMs = Number.isFinite(plan) ? plan : null;
    return this.markState(id, "failed", {
      error: failure,
      nextAttemptAt: retryable ? planMs : null,
      finishedAt: retryable ? null : nowIso(),
    });
  }

  // ── Okuma ───────────────────────────────────────────────────────────────

  getById(id: string): PublishJob | null {
    const r = this.db.prepare<[string], Row>("SELECT * FROM publish_jobs WHERE id = ?").get(id);
    return r ? toModel(r) : null;
  }

  /**
   * Mükerrer yayının son savunması: aynı anahtarla yeniden başlatılan iş
   * bulunur. Bulunamazsa `null` — çağıran yeni iş açabilir.
   */
  findByIdempotencyKey(key: string): PublishJob | null {
    if (!key) throw new Error("findByIdempotencyKey için boş anahtar verilemez.");
    const r = this.db
      .prepare<[string], Row>("SELECT * FROM publish_jobs WHERE idempotency_key = ?")
      .get(key);
    return r ? toModel(r) : null;
  }

  findByTarget(contentId: string, platform: Platform, accountId: string): PublishJob | null {
    assertPlatform(platform);
    const r = this.db
      .prepare<[string, string, string], Row>(
        `SELECT * FROM publish_jobs
         WHERE content_id = ? AND platform = ? AND account_id = ?`,
      )
      .get(contentId, platform, accountId);
    return r ? toModel(r) : null;
  }

  listByContent(contentId: string): PublishJob[] {
    return this.db
      .prepare<[string], Row>(
        "SELECT * FROM publish_jobs WHERE content_id = ? ORDER BY platform, created_at",
      )
      .all(contentId)
      .map(toModel);
  }

  /**
   * HTTP listeleme filtresi (EKSİTME).
   *
   * Gerekçe: panel kuyruk ekranı "durum + içerik + platform" üçlüsüyle
   * sayfalı liste ister. Mevcut `listByState` tekil filtre verir ve `offset`
   * kabul etmez. Üç filtreli bir sorgu üç ayrı çağrıyla ancak tutarsız
   * (ve ara sonuçta kayabilen) yapılır; bu yüzden tek koşul üretici eklendi.
   */
  listFiltered(filter: JobListFilter = {}): PublishJob[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.state !== undefined) {
      assertJobState(filter.state);
      where.push("state = @state");
      params.state = filter.state;
    }
    if (filter.contentId !== undefined) {
      where.push("content_id = @content_id");
      params.content_id = filter.contentId;
    }
    if (filter.platform !== undefined) {
      assertPlatform(filter.platform);
      where.push("platform = @platform");
      params.platform = filter.platform;
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    params.limit = pageSize(filter.limit);
    params.offset = pageOffset(filter.offset);
    return this.db
      .prepare<Record<string, unknown>, Row>(
        `SELECT * FROM publish_jobs${clause}
         ORDER BY scheduled_at ASC, id ASC LIMIT @limit OFFSET @offset`,
      )
      .all(params)
      .map(toModel);
  }

  listByState(state: JobState, limit = 100): PublishJob[] {
    assertJobState(state);
    return this.db
      .prepare<[string, number], Row>(
        "SELECT * FROM publish_jobs WHERE state = ? ORDER BY scheduled_at ASC, id LIMIT ?",
      )
      .all(state, limit)
      .map(toModel);
  }

  /** Kiralama sahibi kim? Tanılama ve stale-lease temizliği için. */
  leaseOf(id: string): { owner: string | null; expiresAt: number | null } | null {
    const r = this.db
      .prepare<[string], { lease_owner: string | null; lease_expires_at: number | null }>(
        "SELECT lease_owner, lease_expires_at FROM publish_jobs WHERE id = ?",
      )
      .get(id);
    return r ? { owner: r.lease_owner, expiresAt: r.lease_expires_at } : null;
  }

  /** Kuyruk derinliği; arayüzde gösterilir. Durum listesi sözleşmeden gelir. */
  countByState(): Record<JobState, number> {
    const rows = this.db
      .prepare<[], { state: string; n: number }>(
        "SELECT state, COUNT(*) AS n FROM publish_jobs GROUP BY state",
      )
      .all();
    const out = Object.fromEntries(ALL_JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>;
    for (const r of rows) {
      if (r.state in out) out[r.state as JobState] = r.n;
    }
    return out;
  }

  cancel(id: string): boolean {
    return this.markState(id, "canceled", { finishedAt: nowIso(), error: null });
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM publish_jobs WHERE id = ?").run(id).changes > 0;
  }

  /** Yalnızca testlerde plan sorgusunun indeks kullandığını doğrulamak için. */
  explainDueQuery(now: Date): string[] {
    return this.db
      .prepare<{ now: string; nowMs: number; limit: number }, { detail: string }>(
        `EXPLAIN QUERY PLAN SELECT * FROM publish_jobs${DUE_SELECTION}`,
      )
      .all({ now: now.toISOString(), nowMs: now.getTime(), limit: 10 })
      .map((r) => r.detail);
  }
}

export { LEASED_STATES };
