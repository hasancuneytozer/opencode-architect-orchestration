/**
 * `content_metrics` — içerik performansı deposu.
 *
 * Desen `PublishJobRepo`'nun BİREBİR kopyasıdır: `Row` arayüzü → `toModel`,
 * `nowIso()`, `assertPlatform`, `fromJson`/`toJson`, `IdFactory` ile üretilen
 * kimlikler. Tek fark şudur: bu depo satırı SİLMEZ ya da güncellemez, tek bir
 * UPSERT yapar (`UNIQUE(job_id, metric_date)` sayesinde).
 *
 * ── `unavailable` BİLGİSİ KAYBOLMAZ ─────────────────────────────────────────
 * `metrics_json` yalnız sayıları değil, `normalize()`'ın TAM zarfını saklar:
 * `{ metrics, unknown, deprecated }`. `unavailable_reason`,
 * `unavailable_message` ve `log_id` kendi kolonlarındadır. Böylece üç ayrı
 * bilgi:
 *   1) ölçüldü mü,
 *   2) ölçülemediyse NEDEN,
 *   3) sağlayıcının destek kanıtı (`log_id`)
 * ayrı ayrı sorgulanabilir ve hiçbiri diğerinin yerine geçmez.
 *
 * ── `0` ile `null` ──────────────────────────────────────────────────────────
 * `readMetrics()` savunmacıdır: JSON'daki değer `number` değilse `null` olur,
 * değer `0` ise `0` KALIR. Okuma tarafının bir `Number(x) || 0` yazması, "veri
 * yok" ile "sıfır" ayrımını veritabanından çıkarırken yok ederdi.
 */
import {
  PUBLISHED_STATES,
  type Platform,
} from "../../contract/index.js";
import { type Db, type IdFactory, assertPlatform, nowIso, uuid } from "./../base.js";
import { fromJson, toJson } from "./../json.js";
import { pageOffset, pageSize } from "./../paging.js";
import { isMetricDate } from "../../analytics/metrics.js";
import {
  METRIC_UNAVAILABLE_REASON_SET,
  type DeprecatedMetric,
  type MetricUnavailable,
  type MetricUnavailableReason,
} from "../../analytics/types.js";

// ── Kayıt ───────────────────────────────────────────────────────────────────

export interface ContentMetricRecord {
  id: string;
  jobId: string;
  contentId: string;
  platform: Platform;
  /** Yayınlanmış içeriğin uzaktaki kimliği. */
  remoteId: string;
  /** `YYYY-MM-DD`, YEREL gün. */
  metricDate: string;
  /** Kanonik ad → değer. `null` = yok, `0` = sıfır. */
  metrics: Record<string, number | null>;
  /** Karşılığı olmayan sağlayıcı adları. Sessizce kaybolmaz. */
  unknown: string[];
  /** Kullanımdan kaldırılmış metrikler; hesaplamaya girmez. */
  deprecated: DeprecatedMetric[];
  /** null ise `metrics` anlamlıdır. */
  unavailable: MetricUnavailable | null;
  /** Destek kanıtı (TikTok `log_id`). */
  logId: string | null;
  /** Bu satırın üretildiği an (UTC ISO). */
  fetchedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertMetricInput {
  id?: string;
  jobId: string;
  contentId: string;
  platform: Platform;
  remoteId: string;
  /** `YYYY-MM-DD`. */
  metricDate: string;
  metrics: Record<string, number | null>;
  unknown?: readonly string[];
  deprecated?: readonly DeprecatedMetric[];
  unavailable?: MetricUnavailable | null;
  logId?: string | null;
  fetchedAt: string;
}

export interface MetricListFilter {
  /** `metric_date >= from` (YYYY-MM-DD, dahil). */
  from?: string;
  /** `metric_date <= to` (YYYY-MM-DD, dahil). */
  to?: string;
  platform?: Platform;
  limit?: number;
  offset?: number;
}

/** Toplanabilir bir yayın işi: yayınlanmış ve `remote_id`'si dolu. */
export interface MeasurableJob {
  jobId: string;
  contentId: string;
  platform: Platform;
  remoteId: string;
  accountId: string;
  permalink: string | null;
  /** Yayının bittiği an (varsa). */
  finishedAt: string | null;
}

// ── Satır okuma ─────────────────────────────────────────────────────────────

interface Row {
  id: string;
  job_id: string;
  content_id: string;
  platform: string;
  remote_id: string;
  metric_date: string;
  metrics_json: string;
  unavailable_reason: string | null;
  unavailable_message: string | null;
  log_id: string | null;
  fetched_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * `metrics_json` → kanonik zarf.
 *
 * Savunmacı: bozuk JSON, dizi, ya da `{"metrics": 5}` gibi yanlış biçim
 * sessizce boş ölçüme DÖNMEZ — `metrics` alanı nesne değilse boş döner ama
 * satır yine okunur. Sessizce `{}` dönmek "ölçüldü ve hepsi sıfır" gibi
 * görünebilirdi.
 */
function readEnvelope(raw: string | null): {
  metrics: Record<string, number | null>;
  unknown: string[];
  deprecated: DeprecatedMetric[];
} {
  const parsed = fromJson<unknown>(raw, null);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { metrics: {}, unknown: [], deprecated: [] };
  }
  const o = parsed as Record<string, unknown>;
  const rawMetrics = o["metrics"];
  const metrics: Record<string, number | null> = {};
  if (rawMetrics !== null && typeof rawMetrics === "object" && !Array.isArray(rawMetrics)) {
    for (const [key, value] of Object.entries(rawMetrics as Record<string, unknown>)) {
      // `number` DEĞİLSE `null`. `0` KALIR — `Number(value) || 0` YAZILMAZ.
      metrics[key] = typeof value === "number" && Number.isFinite(value) ? value : null;
    }
  }
  const rawUnknown = o["unknown"];
  const unknown = Array.isArray(rawUnknown)
    ? rawUnknown.filter((v): v is string => typeof v === "string")
    : [];
  const rawDeprecated = o["deprecated"];
  const deprecated: DeprecatedMetric[] = Array.isArray(rawDeprecated)
    ? rawDeprecated.flatMap((v) => {
        const cell = v as Record<string, unknown> | null;
        if (cell === null || typeof cell !== "object") return [];
        const providerName = typeof cell["providerName"] === "string" ? cell["providerName"] : null;
        if (providerName === null) return [];
        const value = cell["value"];
        return [
          {
            providerName,
            value: typeof value === "number" && Number.isFinite(value) ? value : null,
            note: typeof cell["note"] === "string" ? cell["note"] : "",
          },
        ];
      })
    : [];
  return { metrics, unknown, deprecated };
}

/**
 * `unavailable_reason` + `unavailable_message` → zarf.
 *
 * CHECK kısıtları ikisinin birlikte bulunmasını zorunlu kılar; burada
 * okuma tarafı da savunmacıdır: yalnız `reason` yazan eski/elle düzeltilmiş
 * bir satır `provider_error` mesajı ile tamamlanır, böylece `null`a düşmez.
 */
function readUnavailable(r: Row): MetricUnavailable | null {
  const reason = r.unavailable_reason;
  if (reason === null || reason === "") return null;
  const safeReason: MetricUnavailableReason = METRIC_UNAVAILABLE_REASON_SET.has(reason)
    ? (reason as MetricUnavailableReason)
    : "provider_error";
  const message =
    typeof r.unavailable_message === "string" && r.unavailable_message.trim() !== ""
      ? r.unavailable_message
      : DEFAULT_UNAVAILABLE_MESSAGE[safeReason];
  return { reason: safeReason, message, logId: r.log_id };
}

/**
 * Sebep için yedek mesaj. Panelde "neden ölçülemiyor" satırı ASLA boş
 * gösterilmez; boş bir neden, kullanıcıya hiçbir şey söylemeyen bir hatadır.
 */
const DEFAULT_UNAVAILABLE_MESSAGE: Readonly<Record<MetricUnavailableReason, string>> = {
  not_public: "İçerik herkese açık yayınlanmadığı için ölçülemiyor.",
  not_found: "İçerik platform tarafında bulunamadı.",
  no_scope: "Ölçüm için gereken izinler eksik.",
  provider_error: "Sağlayıcı tarafında hata; ölçüm alınamadı.",
  deleted: "İçerik platform tarafında silinmiş.",
};

function toModel(r: Row): ContentMetricRecord {
  const envelope = readEnvelope(r.metrics_json);
  return {
    id: r.id,
    jobId: r.job_id,
    contentId: r.content_id,
    platform: r.platform as Platform,
    remoteId: r.remote_id,
    metricDate: r.metric_date,
    metrics: envelope.metrics,
    unknown: envelope.unknown,
    deprecated: envelope.deprecated,
    unavailable: readUnavailable(r),
    logId: r.log_id,
    fetchedAt: r.fetched_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Yazmadan önce `unavailable` zarfını KISITLARA UYGUN hâle getirir.
 *
 * Boş mesaj CHECK'i ihlal ederdi ve tüm yazma transaction'ını düşürürdü. Burada
 * "ölçülemedi ama neden yazılmamış" durumu sessizce kaybolmaz: sebebin
 * karşılığı gelen varsayılan mesajla tamamlanır.
 */
function writeUnavailable(u: MetricUnavailable | null | undefined): {
  reason: string | null;
  message: string | null;
  logId: string | null;
} {
  if (u === null || u === undefined) return { reason: null, message: null, logId: null };
  const reason: MetricUnavailableReason = METRIC_UNAVAILABLE_REASON_SET.has(u.reason)
    ? u.reason
    : "provider_error";
  const message =
    typeof u.message === "string" && u.message.trim() !== ""
      ? u.message
      : DEFAULT_UNAVAILABLE_MESSAGE[reason];
  const logId = typeof u.logId === "string" && u.logId.trim() !== "" ? u.logId.trim() : null;
  return { reason, message, logId };
}

/** `deprecated` girişini kalıcı biçime çevirir (metin alanları korunur). */
function writeDeprecated(list: readonly DeprecatedMetric[] | undefined): DeprecatedMetric[] {
  if (list === undefined) return [];
  return list.map((d) => ({
    providerName: String(d.providerName),
    value: typeof d.value === "number" && Number.isFinite(d.value) ? d.value : null,
    note: String(d.note ?? ""),
  }));
}

// ── Depo ────────────────────────────────────────────────────────────────────

export class MetricsRepo {
  constructor(
    private readonly db: Db,
    private readonly ids: IdFactory = uuid,
  ) {}

  // ── Yazma ───────────────────────────────────────────────────────────────

  /**
   * `(job_id, metric_date)` için UPSERT.
   *
   * Aynı gün ikinci kez yazmak satır ÇOĞALTMAZ, mevcut satırı GÜNCELLER.
   * Gerekçe: metrikler gecikmelidir; aynı gün ikinci çekim ilk değeri
   * düzeltir (ör. TikTok 0 döndü, ertesi çekimde 1.200). Sil-ekle yerine
   * güncelleme seçilir çünkü sil-ekle `created_at`'i ve `id`'yi değiştirir;
   * panelde "ilk görülme" ve "son güncelleme" ayrı bilgilerdir.
   */
  upsert(input: UpsertMetricInput): ContentMetricRecord {
    assertPlatform(input.platform);
    if (!isMetricDate(input.metricDate)) {
      throw new Error(
        `Geçersiz metricDate: "${input.metricDate}". Beklenen biçim YYYY-MM-DD (yerel gün).`,
      );
    }
    if (typeof input.remoteId !== "string" || input.remoteId.trim() === "") {
      throw new Error(
        "remoteId zorunludur: ölçülebilir içerik yayınlanmış olmalıdır " +
          "(publish_jobs.remote_id dolu olmadan metrics yazılmaz).",
      );
    }
    if (typeof input.jobId !== "string" || input.jobId.trim() === "") {
      throw new Error("jobId zorunludur (UNIQUE(job_id, metric_date) buna bağlıdır).");
    }

    const ts = nowIso();
    const unavailable = writeUnavailable(input.unavailable);
    const envelope: Record<string, unknown> = {
      metrics: input.metrics ?? {},
      unknown: [...(input.unknown ?? [])].sort(),
      deprecated: writeDeprecated(input.deprecated),
    };
    // `logId` hem kolonda hem zarfın içinde tutulur: kolon sorgular için,
    // zarf ise `unavailable` nesnesiyle birlikte kopyalanan destek talebi metni
    // için. İkisi de aynı değerden yazılır.
    const logId = input.logId ?? unavailable.logId;

    this.db
      .prepare(
        `INSERT INTO content_metrics (
           id, job_id, content_id, platform, remote_id, metric_date,
           metrics_json, unavailable_reason, unavailable_message, log_id,
           fetched_at, created_at, updated_at
         )
         VALUES (@id, @job_id, @content_id, @platform, @remote_id, @metric_date,
                 @metrics_json, @unavailable_reason, @unavailable_message, @log_id,
                 @fetched_at, @created_at, @updated_at)
         ON CONFLICT (job_id, metric_date) DO UPDATE SET
           content_id    = excluded.content_id,
           platform      = excluded.platform,
           remote_id     = excluded.remote_id,
           metrics_json  = excluded.metrics_json,
           unavailable_reason  = excluded.unavailable_reason,
           unavailable_message = excluded.unavailable_message,
           log_id        = excluded.log_id,
           fetched_at    = excluded.fetched_at,
           updated_at    = excluded.updated_at`,
      )
      .run({
        id: input.id ?? this.ids(),
        job_id: input.jobId,
        content_id: input.contentId,
        platform: input.platform,
        remote_id: input.remoteId,
        metric_date: input.metricDate,
        metrics_json: toJson(envelope),
        unavailable_reason: unavailable.reason,
        unavailable_message: unavailable.message,
        log_id: logId,
        fetched_at: input.fetchedAt,
        created_at: ts,
        updated_at: ts,
      });

    const stored = this.getByJobAndDate(input.jobId, input.metricDate);
    if (stored === null) {
      // UPSERT sonrası satır bulunamıyorsa yazma gerçekleşmemiştir; sessizce
      // uydurma bir kayıt döndürmek, panelde var olmayan bir veri gösterir.
      throw new Error(
        `content_metrics upsert sonrası okunamadı (job=${input.jobId}, date=${input.metricDate}).`,
      );
    }
    return stored;
  }

  // ── Okuma ───────────────────────────────────────────────────────────────

  getByJobAndDate(jobId: string, metricDate: string): ContentMetricRecord | null {
    const r = this.db
      .prepare<[string, string], Row>(
        "SELECT * FROM content_metrics WHERE job_id = ? AND metric_date = ?",
      )
      .get(jobId, metricDate);
    return r === undefined ? null : toModel(r);
  }

  listByContent(contentId: string, filter: MetricListFilter = {}): ContentMetricRecord[] {
    const where: string[] = ["content_id = @content_id"];
    const params: Record<string, unknown> = { content_id: contentId };
    applyDateAndPlatform(where, params, filter);
    params.limit = pageSize(filter.limit);
    params.offset = pageOffset(filter.offset);
    return this.db
      .prepare<Record<string, unknown>, Row>(
        `SELECT * FROM content_metrics WHERE ${where.join(" AND ")}
         ORDER BY metric_date DESC, platform ASC, job_id ASC
         LIMIT @limit OFFSET @offset`,
      )
      .all(params)
      .map(toModel);
  }

  /**
   * Platform + tarih aralığı. `from`/`to` DAHİL'dir (`metric_date >= from AND
   * metric_date <= to`). Metin karşılaştırma `YYYY-MM-DD` üzerinde leksikografik
   * = tarihsel olduğu için CAST gerekmez.
   */
  listByPlatform(platform: Platform, from: string, to: string): ContentMetricRecord[] {
    assertPlatform(platform);
    assertRange(from, to);
    return this.db
      .prepare<[string, string, string], Row>(
        `SELECT * FROM content_metrics
         WHERE platform = ? AND metric_date >= ? AND metric_date <= ?
         ORDER BY metric_date ASC, job_id ASC`,
      )
      .all(platform, from, to)
      .map(toModel);
  }

  listByJob(jobId: string): ContentMetricRecord[] {
    return this.db
      .prepare<[string], Row>(
        "SELECT * FROM content_metrics WHERE job_id = ? ORDER BY metric_date ASC",
      )
      .all(jobId)
      .map(toModel);
  }

  /**
   * Verilen işler için EN SON günün satırı.
   *
   * `MAX(metric_date)` alt sorgusu UNIQUE(job_id, metric_date) sayesinde tek
   * satıra işaret eder; yine de `id` ile eşleştirilerek "iki satır" ihtimali
   * kapatılır.
   */
  latestPerJob(jobIds: readonly string[]): ContentMetricRecord[] {
    const ids = jobIds.filter((v) => typeof v === "string" && v !== "");
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare<unknown[], Row>(
        `SELECT m.* FROM content_metrics m
         JOIN (
           SELECT job_id, MAX(metric_date) AS newest
           FROM content_metrics
           WHERE job_id IN (${placeholders})
           GROUP BY job_id
         ) x ON x.job_id = m.job_id AND x.newest = m.metric_date
         ORDER BY m.job_id ASC`,
      )
      .all(...ids);
    return rows.map(toModel);
  }

  // ── Toplanabilir işler ──────────────────────────────────────────────────

  /**
   * Ölçülebilir yayın işleri: `PUBLISHED_STATES` (sözleşmeden türetilir) VE
   * `remote_id` dolu.
   *
   * Durum kümesi ELLE yazılmaz: `PUBLISHED_STATES` sözleşmeden gelir, böylece
   * `published_no_link` gibi yeni bir durum eklendiğinde liste otomatik genişler.
   *
   * `remote_id IS NULL` olan işler dışarıda kalır: uzaktaki kimlik olmadan
   * insights/video.query çağrısı yapılamaz. Bu bir hata değil, "henüz ölçülemez"
   * durumudur ve panelde zaten yayın durumundan görünür.
   */
  listMeasurableJobs(limit = 200, platform?: Platform): MeasurableJob[] {
    if (platform !== undefined) assertPlatform(platform);
    const states = PUBLISHED_STATES;
    const placeholders = states.map(() => "?").join(", ");
    const platformClause = platform === undefined ? "" : " AND platform = ?";
    const params: unknown[] = platform === undefined ? [...states] : [...states, platform];
    const rows = this.db
      .prepare<unknown[], {
        job_id: string;
        content_id: string;
        platform: string;
        remote_id: string;
        account_id: string;
        permalink: string | null;
        finished_at: string | null;
      }>(
        `SELECT id AS job_id, content_id, platform, remote_id, account_id, permalink, finished_at
         FROM publish_jobs
         WHERE remote_id IS NOT NULL AND TRIM(remote_id) <> ''
           AND state IN (${placeholders})${platformClause}
         ORDER BY COALESCE(finished_at, updated_at) ASC, id ASC
         LIMIT ?`,
      )
      .all(...params, pageSize(limit));
    return rows.map((r) => ({
      jobId: r.job_id,
      contentId: r.content_id,
      platform: r.platform as Platform,
      remoteId: r.remote_id,
      accountId: r.account_id,
      permalink: r.permalink,
      finishedAt: r.finished_at,
    }));
  }

  // ── Silme ───────────────────────────────────────────────────────────────

  /** Bir içeriğin TÜM ölçüm geçmişi. Dönen sayı silinen satır adedidir. */
  deleteByContent(contentId: string): number {
    return this.db.prepare("DELETE FROM content_metrics WHERE content_id = ?").run(contentId).changes;
  }

  /** Yalnız testler için: indeks kullanımını doğrulama. */
  explainPlatformRange(platform: Platform, from: string, to: string): string[] {
    assertPlatform(platform);
    return this.db
      .prepare<[string, string, string], { detail: string }>(
        `EXPLAIN QUERY PLAN SELECT * FROM content_metrics
         WHERE platform = ? AND metric_date >= ? AND metric_date <= ?`,
      )
      .all(platform, from, to)
      .map((r) => r.detail);
  }
}

// ── Yardımcılar ─────────────────────────────────────────────────────────────

function applyDateAndPlatform(
  where: string[],
  params: Record<string, unknown>,
  filter: MetricListFilter,
): void {
  if (filter.from !== undefined) {
    assertMetricDate(filter.from, "from");
    where.push("metric_date >= @from");
    params.from = filter.from;
  }
  if (filter.to !== undefined) {
    assertMetricDate(filter.to, "to");
    where.push("metric_date <= @to");
    params.to = filter.to;
  }
  if (filter.platform !== undefined) {
    assertPlatform(filter.platform);
    where.push("platform = @platform");
    params.platform = filter.platform;
  }
}

function assertMetricDate(value: string, label: string): void {
  if (!isMetricDate(value)) {
    throw new Error(`Geçersiz ${label} tarihi: "${value}". Beklenen biçim YYYY-MM-DD.`);
  }
}

function assertRange(from: string, to: string): void {
  assertMetricDate(from, "from");
  assertMetricDate(to, "to");
  if (from > to) {
    throw new Error(`Tarih aralığı ters: from=${from}, to=${to}.`);
  }
}