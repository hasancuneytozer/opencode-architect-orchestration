/**
 * `AnalyticsService` — toplama yürütücüsü. Üç kuralı tek yerde birleştirir:
 * hangi işler ölçülür, kimlik/izin eksikliği neden hata değildir, saat nereden
 * gelir.
 *
 * ── SAAT ENJEKTE EDİLİR ─────────────────────────────────────────────────────
 * `Date.now()` DOĞRUDAN ÇAĞRILMAZ. `now: () => number` zorunludur. Aksi halde
 * `metricDate` "bugün"ün hangi olduğunu test edilemez hale gelir ve Türkiye'de
 * gece yarısına yakın koşan bir test UTC günüyle yerel günü karşılaştırıp
 * YANLIŞ yerde başarısız olurdu.
 *
 * ── KİMLİK/İZİN EKSİĞİ HATA DEĞİLDİR ──────────────────────────────────────
 * `collect()` bir izin eksikliğinde FIRSAT FIRLATMAZ; `unavailable` yazar.
 * Fırlatırsak 25 içeriğin 24'ünün ölçümü de kaybolur ve panel "toplu hata"
 * görür. Gerçek olan şey "bu hesapta ölçüm yok"dur ve panelin bunu, sebebiyle
 * birlikte, göstermesi gerekir. Taşıma hatası da bir `provider_error`
 * kaydıdır; o da fırlatılmaz.
 *
 * Fırlatılan TEK durum geçersiz saat dilimidir: bu bir sağlayıcı hatası
 * değil, yapılandırma hatasıdır ve toplama turunu sessizce bozmak yerine
 * geliştiriciye görünür olmalıdır.
 *
 * ── HAM → KANONİK ───────────────────────────────────────────────────────────
 * Adaptörler SAĞLAYICI ADIYLA ham değer döner (`view_count`, `saved`, …).
 * Kanonik indirgeme tek yerde, `normalize()`'da yapılır: "hangi ham ad hangi
 * kanonik ada gider" sorusunun tek cevabı vardır ve adaptörler kanonik tabloyu
 * bilmek zorunda olmaz.
 *
 * ── AYNIGÜN YENİ ÇEKİM KORUMASI ─────────────────────────────────────────────
 * Instagram insights kotası 4800 × Impressions / 24 saattir. `collect`, bir işin
 * BUGÜNKÜ satırı varsa ve `refetchAfterMs` içinde çekilmişse atlar:
 *   * `no_scope` / `deleted` → yine denenir (yeniden yetkilendirme yapılmış
 *     olabilir; bu kayıt kalıcı olmamalıdır),
 *   * `not_public` → atlanır (yalnız sağlayıcının veri gecikmesi düzeltir ve
 *     aynı gün içinde tekrarlamak kazandırmaz),
 *   * ölçülmüş satır → atlanır.
 */
import { isValidTimeZone } from "../contract/index.js";
import type { Platform } from "../contract/index.js";
import type { AnalyticsAdapter, MetricSet } from "../ports/index.js";
import { metricDate, normalize } from "./metrics.js";
import { rollup } from "./rollup.js";
import type { RollupResult } from "./rollup.js";
import type { MetricUnavailable } from "./types.js";
import type { ContentMetricRecord, MeasurableJob, MetricListFilter, MetricsRepo } from "../db/repos/metrics.js";

/** Varsayılan gün: `Europe/Istanbul` (sözleşmedeki `TimeZoneSchema` default'u). */
export const DEFAULT_ANALYTICS_TIMEZONE = "Europe/Istanbul";

/** Aynı gün içinde yeniden çekim aralığı (ms). IG BUC kotası için 6 saat. */
export const DEFAULT_REFETCH_AFTER_MS = 6 * 60 * 60 * 1000;

/** Toplanacak azami iş sayısı. BUC kotası ve hız sınırı için tavan. */
export const DEFAULT_COLLECT_LIMIT = 100;

/** `listByContent` sayfalama tavanıyla aynı. Toplama tüm geçmişi görmeli. */
const CONTENT_ROLLUP_ROW_LIMIT = 500;

export interface AnalyticsAdapterSet {
  instagram?: AnalyticsAdapter | null;
  tiktok?: AnalyticsAdapter | null;
  youtube?: AnalyticsAdapter | null;
}

/** Çözülmüş hesap bağlamı. Belirteç çözen katman buraya enjekte eder. */
export interface AnalyticsAccountContext {
  accessToken: string | null;
  scopes: readonly string[];
}

export interface CollectOptions {
  /** Yalnız bu platformu topla. */
  platform?: Platform;
  /** Azami iş sayısı. */
  limit?: number;
  /** `metric_date` bu saat diliminde hesaplanır. */
  timezone?: string;
  /** Aynı gün tekrar çekim koruması (ms). `0` = koruma yok. */
  refetchAfterMs?: number;
  /** Platform başına adaptör. Eksikse o platform ATLANIR (hata değil). */
  adapters?: AnalyticsAdapterSet;
  /**
   * Platform başına hesap bağlamı. VERİLMEZSE boş bağlamla toplanır ve
   * adaptör `no_scope` yazar: "sessizce ölçüm toplamayıp başarı bildirmek"
   * yanlış; panelde "neden ölçülemiyor" yazması doğrudur.
   */
  accounts?: Partial<Record<Platform, AnalyticsAccountContext>>;
}

export interface CollectOutcome {
  /** Bu turda gerçekten çekilen iş sayısı. */
  fetched: number;
  /** Yazılan satır sayısı. */
  written: number;
  /** Atlanan işler ve NEDENİ. Panel bu listeyi gösterir. */
  skipped: Array<{ jobId: string; reason: string }>;
  byPlatform: Partial<Record<Platform, { fetched: number; written: number }>>;
  /** Bu turda kullanılan YEREL gün. */
  metricDate: string;
  /** Yazılan kayıtlar (panelde "toplandı / ölçülemedi" listesi için). */
  records: ContentMetricRecord[];
}

export interface GetForContentOptions {
  from?: string;
  to?: string;
  platform?: Platform;
  /** Veri gecikmesi (gün). Varsayılan 2 (IG 48 saat). */
  delayDays?: number;
}

export class AnalyticsService {
  constructor(
    private readonly repo: MetricsRepo,
    /** Zaman kaynağı. **Zorunludur** — gizli `Date.now()` yasaktır. */
    private readonly now: () => number,
  ) {}

  /**
   * Yayınlanmış işleri bulur, adaptörleri çağırır ve sonucu yazar.
   *
   * SÖZLEŞME KONTROLÜ: `AnalyticsAdapter.fetchMetrics` girişle aynı uzunlukta
   * dizi döndürmek ZORUNDADIR. Boy uyuşmazlığı burada, tek yerde, açık bir
   * atlamaya çevrilir; indeksle eşleştirmeye devam edilseydi sonuçlar sessizce
   * YANLIŞ işlere yazılırdı.
   */
  async collect(options: CollectOptions = {}): Promise<CollectOutcome> {
    const nowMs = this.now();
    const timezone = options.timezone ?? DEFAULT_ANALYTICS_TIMEZONE;
    if (!isValidTimeZone(timezone)) {
      throw new Error(`Geçersiz saat dilimi: ${timezone}`);
    }
    const refetchAfterMs = options.refetchAfterMs ?? DEFAULT_REFETCH_AFTER_MS;
    const limit = options.limit ?? DEFAULT_COLLECT_LIMIT;
    const date = metricDate(new Date(nowMs), timezone);
    const fetchedAt = new Date(nowMs).toISOString();

    const outcome: CollectOutcome = {
      fetched: 0,
      written: 0,
      skipped: [],
      byPlatform: {},
      metricDate: date,
      records: [],
    };

    const jobs = this.repo.listMeasurableJobs(limit, options.platform);
    if (jobs.length === 0) return outcome;

    const adapters = options.adapters ?? {};
    const accounts = options.accounts ?? {};

    for (const [platform, group] of groupByPlatform(jobs)) {
      const adapter = adapters[platform];
      if (adapter === undefined || adapter === null) {
        outcome.skipped.push({
          jobId: group[0]?.jobId ?? "",
          reason: `${platform}: analitik adaptörü yapılandırılmamış; ölçüm toplanmadı.`,
        });
        continue;
      }

      const due = group.filter((job) => this.shouldFetch(job, date, nowMs, refetchAfterMs, outcome));
      if (due.length === 0) continue;

      const account = accounts[platform] ?? { accessToken: null, scopes: [] };
      const results = await adapter.fetchMetrics(
        due.map((job) => ({
          jobId: job.jobId,
          contentId: job.contentId,
          remoteId: job.remoteId,
          accessToken: account.accessToken,
          scopes: account.scopes,
        })),
      );

      if (results.length !== due.length) {
        outcome.skipped.push({
          jobId: due[0]?.jobId ?? "",
          reason:
            `${platform}: adaptör ${due.length} girdi için ${results.length} sonuç döndürdü ` +
            "(AnalyticsAdapter sözleşmesi ihlal edildi; bu turun tamamı atlandı).",
        });
        continue;
      }

      outcome.fetched += due.length;
      const bucket = (outcome.byPlatform[platform] ?? { fetched: 0, written: 0 });
      bucket.fetched += due.length;

      for (let i = 0; i < due.length; i += 1) {
        const job = due[i];
        const result = results[i];
        if (job === undefined || result === undefined) continue;

        // Adaptörün döndürdüğü `remoteId` girişle AYNI olmalı. Eşleşmezse sonuç
        // yanlış işe yazılır; sıra hatası sessizce veri bozduğu için atlanır.
        if (result.remoteId !== job.remoteId) {
          outcome.skipped.push({
            jobId: job.jobId,
            reason:
              `${platform}: adaptör indeks/kimlik eşleştirmesini bozdu ` +
              `(beklenen ${job.remoteId}, gelen ${result.remoteId}).`,
          });
          continue;
        }

        const normalized = normalize(result.platform, result.metrics, {
          remoteId: job.remoteId,
          metricDate: date,
          fetchedAt: result.fetchedAt === "" ? fetchedAt : result.fetchedAt,
          unavailable: liftUnavailable(result.unavailable, result.logId),
          logId: result.logId,
        });

        outcome.records.push(
          this.repo.upsert({
            jobId: job.jobId,
            contentId: job.contentId,
            platform,
            remoteId: job.remoteId,
            metricDate: date,
            metrics: normalized.metrics,
            unknown: normalized.unknown,
            deprecated: normalized.deprecated,
            unavailable: normalized.unavailable,
            logId: normalized.logId,
            fetchedAt: normalized.fetchedAt,
          }),
        );
        outcome.written += 1;
        bucket.written += 1;
      }
    }

    return outcome;
  }

  /** Bir içeriğin tüm platformlardaki ölçüm geçmişi (en yeni gün önce). */
  listForContent(contentId: string, filter: MetricListFilter = {}): ContentMetricRecord[] {
    return this.repo.listByContent(contentId, filter);
  }

  /**
   * Bir içeriğin ölçümlerinden TEK toplama. Panelin "içerik performansı" ekranı.
   *
   * Sayfalama BURADA uygulanmaz: `missingDataDays` sayımı eksik günleri
   * "ölçülmedi" sanırdı.
   */
  getForContent(contentId: string, options: GetForContentOptions = {}): RollupResult {
    const rows = this.repo.listByContent(contentId, {
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      limit: CONTENT_ROLLUP_ROW_LIMIT,
    });
    return rollup(rows, {
      scope: "content",
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
      ...(options.delayDays === undefined ? {} : { delayDays: options.delayDays }),
    });
  }

  /** Platform + tarih aralığı toplaması. */
  getForPlatform(
    platform: Platform,
    from: string,
    to: string,
    delayDays?: number,
  ): RollupResult {
    const rows = this.repo.listByPlatform(platform, from, to);
    return rollup(rows, {
      scope: "platform",
      from,
      to,
      ...(delayDays === undefined ? {} : { delayDays }),
    });
  }

  /**
   * "Bu dönem" için, hemen önceki ve EŞİT UZUNLUKTA dönemin penceresini
   * döndürür. Kaydırma burada yapılır; çağıran iki `getForPlatform` çağrısını
   * elle kurarsa gün sayısı kayar ve yüzde değişim yanlış çıkar.
   */
  previousWindow(from: string, to: string): { from: string; to: string } {
    const days = daySpan(from, to);
    const prevTo = shiftDays(from, -1);
    return { from: shiftDays(prevTo, -(days - 1)), to: prevTo };
  }

  /** Aynı platform için iki dönemin toplamalarını hazırlar. */
  windowsOnPlatform(
    platform: Platform,
    current: { from: string; to: string },
    delayDays?: number,
  ): { current: RollupResult; previous: RollupResult } {
    const previous = this.previousWindow(current.from, current.to);
    return {
      current: this.getForPlatform(platform, current.from, current.to, delayDays),
      previous: this.getForPlatform(platform, previous.from, previous.to, delayDays),
    };
  }

  // ── Dahili ──────────────────────────────────────────────────────────────

  /**
   * Aynı gün içinde tekrar çekim yapılmalı mı?
   *
   * `no_scope` ve `deleted` da atlanmaz: kullanıcı OAuth ekranından izin
   * verdikten sonra aynı gün içinde toplama yeniden denenmelidir.
   */
  private shouldFetch(
    job: MeasurableJob,
    date: string,
    nowMs: number,
    refetchAfterMs: number,
    outcome: CollectOutcome,
  ): boolean {
    const existing = this.repo.getByJobAndDate(job.jobId, date);
    if (existing === null) return true;

    const reason = existing.unavailable?.reason ?? null;
    if (reason === "not_public") {
      outcome.skipped.push({
        jobId: job.jobId,
        reason: "not_public: içerik herkese açık değil; aynı gün tekrar denemek anlamsız.",
      });
      return false;
    }
    if (reason === "no_scope" || reason === "deleted") return true;

    const fetched = Date.parse(existing.fetchedAt);
    if (refetchAfterMs > 0 && Number.isFinite(fetched) && nowMs - fetched < refetchAfterMs) {
      outcome.skipped.push({
        jobId: job.jobId,
        reason: "Bugünkü ölçüm zaten alındı (yeniden çekim koruması).",
      });
      return false;
    }
    return true;
  }
}

// ── Saf yardımcılar ─────────────────────────────────────────────────────────

/**
 * Port `MetricSet.unavailable` yalnız `{ reason, message }` taşır; analitik
 * çekirdeğinin `MetricUnavailable` tipi `logId`'yi ZORUNLU ister (destek
 * talebinin tek ipucu bu alandır). Portu DEĞİŞTİRMEYİZ — `lift` köprüsü
 * eksik alanı doldurur.
 *
 * ÖNCELİK: nesnenin kendi `logId`'si → kaydın üst düzey `logId`'si → `null`.
 * Üst düzey alan adaptörlerde zaten aynı değerden yazılır (`errors.ts`'teki
 * `build()` hem `unavailable.logId` hem `logId` alanlarını aynı `logId` ile
 * doldurur), yani ikinci dal normalde birincinin tekrarıdır; üçüncü dal
 * "bilinmiyor" demektir ve log_id UYDURMAZ.
 */
function liftUnavailable(
  unavailable: MetricSet["unavailable"],
  logId: string | null,
): MetricUnavailable | null {
  if (unavailable === null) return null;
  const own = (unavailable as { logId?: unknown }).logId;
  const resolved =
    typeof own === "string" && own.trim() !== ""
      ? own
      : typeof logId === "string" && logId.trim() !== ""
        ? logId
        : null;
  return { reason: unavailable.reason, message: unavailable.message, logId: resolved };
}

function groupByPlatform(jobs: readonly MeasurableJob[]): Map<Platform, MeasurableJob[]> {
  const out = new Map<Platform, MeasurableJob[]>();
  for (const job of jobs) {
    const list = out.get(job.platform);
    if (list === undefined) out.set(job.platform, [job]);
    else list.push(job);
  }
  return out;
}

/** `[from, to]` dahil gün sayısı. `from > to` ise 1 (çöp girdi tek gün sayılır). */
export function daySpan(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return ms < 0 ? 1 : Math.floor(ms / 86_400_000) + 1;
}

/** `days` kadar gün kaydır (negatif = geriye). */
export function shiftDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}