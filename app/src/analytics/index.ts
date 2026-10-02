/**
 * Analitik çekirdeğinin tek giriş noktası.
 *
 * Katman ayrımı:
 *   * `metrics.ts`, `rollup.ts`, `errors.ts`, `scopes.ts`, `http.ts` → SAF.
 *     Ağ yok, veritabanı yok, `Date.now()` yok; veritabanı gerektirmez.
 *   * `adapters/*.ts` → AĞ. `fetch` ENJEKTE EDİLİR; testler hiç ağa çıkmaz.
 *   * `service.ts` → veritabanı + adaptörleri birleştirir; saat ENJEKTE EDİLİR.
 */
export * from "./types.js";
export * from "./metrics.js";
export * from "./rollup.js";
export * from "./errors.js";
export * from "./scopes.js";
export * from "./http.js";

export {
  INSTAGRAM_GRAPH_BASE,
  INSTAGRAM_INSIGHT_METRICS,
  INSTAGRAM_INSIGHTS_BUC_PER_DAY,
  InstagramAnalyticsAdapter,
  insightsHasNoData,
  readInsightsMetrics,
} from "./adapters/instagram.js";
export type { InstagramAnalyticsOptions } from "./adapters/instagram.js";

export {
  TIKTOK_OPEN_API_BASE,
  TIKTOK_RATE_LIMIT_PER_MIN,
  TIKTOK_VIDEO_FIELDS,
  TIKTOK_VIDEO_QUERY_BATCH,
  TIKTOK_VIDEO_QUERY_PATH,
  TiktokAnalyticsAdapter,
  buildVideoQueryBody,
  chunk,
  readVideoMetrics,
} from "./adapters/tiktok.js";
export type { TiktokAnalyticsOptions } from "./adapters/tiktok.js";

export {
  VIEWS_COUNTING_CHANGE_DATE,
  YOUTUBE_ANALYTICS_BASE,
  YOUTUBE_ANALYTICS_METRICS,
  YoutubeAnalyticsAdapter,
  buildReportQuery,
  periodCrossesViewsChange,
  readReportMetrics,
  reportHasError,
} from "./adapters/youtube.js";
export type { YoutubeAnalyticsOptions } from "./adapters/youtube.js";

export {
  DEFAULT_ANALYTICS_TIMEZONE,
  DEFAULT_COLLECT_LIMIT,
  DEFAULT_REFETCH_AFTER_MS,
  AnalyticsService,
  daySpan,
  shiftDays,
} from "./service.js";
export type {
  AnalyticsAccountContext,
  AnalyticsAdapterSet,
  CollectOptions,
  CollectOutcome,
  GetForContentOptions,
} from "./service.js";