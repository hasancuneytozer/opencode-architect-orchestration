/**
 * Analitik çekirdeğinin ortak tipleri.
 *
 * ── NEDEN BURADA, `src/ports` DEĞİL ────────────────────────────────────────
 * `MetricSet.unavailable` yalnız `{ reason, message }` taşıyor; TikTok'ta
 * destek talebinin tek ipucu olan `log_id` SANAL ÇÜKTÜ ALANI taşımıyor.
 * `MetricSet` zaten üst düzeyde bir `logId` alanı içeriyor (bkz.
 * `src/ports/index.ts`), bu yüzden portu DEĞİŞTİRMEK yerine burada bir
 * uzantı tipi tanımlanır:
 *
 *   `MetricRecord` ≡ `MetricSet` + `unavailable.logId`
 *
 * Yapısal tiplilik sayesinde `MetricRecord`, `MetricSet`'in yerine geçer:
 * `Promise<MetricRecord[]>` bir `Promise<MetricSet[]>` döndürme sözünü
 * TAAHHÜT EDER, port genişletilmez. Böylece iki katmanın sözleşmesi de bozulmaz.
 */
import type { MetricSet } from "../ports/index.js";

/** Sağlayıcı metriğinin KALDIRILMIŞ olması nedeniyle kullanımdan çıkarıldı. */
export interface DeprecatedMetric {
  /** Sağlayıcının verdiği ham ad (ör. `plays`, `impressions`). */
  providerName: string;
  /** Ham değer. `null` ise sağlayıcı alanı döndü ama boştu. */
  value: number | null;
  /** Panelde gösterilecek tek cümlelik gerekçe. */
  note: string;
}

/**
 * "Ölçülemedi" sebepleri. Değer kümesi `MetricSet.unavailable.reason` ile
 * BİREBİR aynıdır — porttan ayrılmadan önce de burada bir kopya üretmiyoruz.
 */
export const METRIC_UNAVAILABLE_REASONS = [
  "not_public",
  "not_found",
  "no_scope",
  "provider_error",
  "deleted",
] as const;
export type MetricUnavailableReason = (typeof METRIC_UNAVAILABLE_REASONS)[number];

export const METRIC_UNAVAILABLE_REASON_SET: ReadonlySet<string> = new Set<string>(
  METRIC_UNAVAILABLE_REASONS,
);

export interface MetricUnavailable {
  reason: MetricUnavailableReason;
  message: string;
  /** TikTok `log_id`. Üst düzey `logId` ile AYNI değerdir; zarf içinde de bulunur
   *  çünkü destek talebi metni tek nesne olarak kopyalanır. */
  logId: string | null;
}

/**
 * Adaptörün döndürdüğü ölçüm. `MetricSet`'in uzantısı; sözleşmedeki
 * "çıktı dizisi girişle aynı uzunlukta, sıra korunur" kuralı bozulmaz.
 */
export interface MetricRecord extends MetricSet {
  unavailable: MetricUnavailable | null;
}

/** Saklanan/görülen normalize ölçüm zarfı. `metrics_json` bunun JSON'idır. */
export interface NormalizedEnvelope {
  /** Kanonik ad → değer. `null` = yok, `0` = sıfır. İKİSİ AYRI KALIR. */
  metrics: Record<string, number | null>;
  /** Karşılığı olmayan sağlayıcı adları. Sessizce düşmez. */
  unknown: string[];
  /** Kullanımdan kaldırılmış metrikler; hesaplamaya GİRMEZ. */
  deprecated: DeprecatedMetric[];
}

/** `fetchMetrics` çağrısına verilen iş. */
export interface MetricQueryItem {
  /** Yayın işi kimliği (arşiv ve UNIQUE anahtarı için). */
  jobId?: string;
  contentId?: string;
  remoteId: string;
  /**
   * Sağlayıcı tarafındaki erişim düzeyi. TikTok'ta kritik: onaylı olmayan
   * istemci `SELF_ONLY` yayın yapar, `publicaly_available_post_id` hiç dönmez.
   */
  accessToken?: string | null;
  /** Hesabın talep ettiği kapsamlar (yetkilendirme sırasında saklanan liste). */
  scopes?: readonly string[];
}

/** Bir işin ölçülebilir olup olmadığını açıklayan kimlik. */
export interface AnalyticsAccountContext {
  accessToken: string | null;
  scopes: readonly string[];
}