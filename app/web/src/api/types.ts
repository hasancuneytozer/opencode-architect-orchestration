/**
 * API tipleri. Sözleşmeden (src/contract) yeniden dışa aktarılır; arayüz bileşenleri
 * yalnızca buradan içe aktarır, böylece sözleşme değişirse arayüz tek noktadan
 * etkilenir.
 *
 * `verbatimModuleSyntax` gereği TÜM sözleşme içe aktarmaları `import type` olmalıdır:
 * çalışma zamanında `src/contract` (ve dolayısıyla zod) tarayıcı paketine girmesin.
 */
export type {
  Account,
  AiDisclosure,
  Asset,
  AuditEvent,
  ContentItem,
  ContentState,
  JobState,
  LimitRule,
  MediaInfo,
  PerPlatformCopy,
  Platform,
  PlatformCopy,
  PlatformCopyOverride,
  PlatformSpec,
  Project,
  PublishErrorKind,
  PublishFailure,
  PublishJob,
  QuietHours,
  Severity,
  ValidationFinding,
} from "../../../src/contract/index.js";

/**
 * Analitik çekirdeğinin tipleri.
 *
 * Yalnız TİP olarak alınır (`import type`): derleyici bunu tamamen siler, tarayıcı
 * paketine `src/analytics` ya da zod GİRMEZ. Panelin gösterdiği toplama
 * biçimini elle kopyalamak ("aynı alan iki yerde") sürüklenme riskidir.
 */
export type {
  AdditiveMetricKey,
  DataCompleteness,
  MetricRates,
  MetricUnavailableReason,
  PeriodComparison,
  RollupResult,
} from "../../../src/analytics/index.js";

/**
 * `POST /api/v1/ingest` yanıtı.
 *
 * Yalnız TİP olarak alınır: derleyici bunu siler, tarayıcı paketine
 * `src/ingest` (ve `zod`) GİRMEZ. Alanlar sunucunun yazdığı `IngestResult`
 * ile aynı kaynaktan gelir; panel alanı elle kopyalarsa sunucu alanı
 * yeniden adlandırdığında derleme kırılmaz, ekran boş kalır.
 */
export type { IngestResult, IngestSkip } from "../../../src/ingest/index.js";

/**
 * Aynı tipler bu dosyanın GÖVDESİNDE de kullanılır; `export … from` yalnız
 * yeniden dışa aktarır, yerel kapsama ALMADIĞI için ayrıca içe aktarılır.
 */
import type {
  DataCompleteness,
  MetricRates,
  MetricUnavailableReason,
  PeriodComparison,
  RollupResult,
} from "../../../src/analytics/index.js";
import type { IngestResult } from "../../../src/ingest/index.js";
import type { Platform, PublishJob } from "../../../src/contract/index.js";

// ── Zarf ──────────────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

// ── Uç noktalar ───────────────────────────────────────────────────────────

export interface HealthPayload {
  ok: boolean;
  version: string;
  uptimeSec: number;
  db: string;
  mode: "mock" | "live";
  scheduler: unknown;
}

export interface ConfigProblem {
  severity: "blocker" | "warning";
  code: string;
  message: string;
  docAnchor: string | null;
  envKeys: string[];
}

export interface SessionPayload {
  authenticated: boolean;
  mode: "mock" | "live" | null;
  configProblems: ConfigProblem[];
}

export interface PlatformSetup {
  platform: import("../../../src/contract/index.js").Platform;
  configured: boolean;
  missing: string[];
  hasAccounts: boolean;
  docAnchor: string | null;
}

export interface SetupPayload {
  mode: "mock" | "live" | null;
  problems: ConfigProblem[];
  platforms: PlatformSetup[];
}

export interface AssetReportPayload {
  info: import("../../../src/contract/index.js").MediaInfo | null;
  findings: import("../../../src/contract/index.js").ValidationFinding[];
  perPlatform: {
    instagram: import("../../../src/contract/index.js").ValidationFinding[];
    tiktok: import("../../../src/contract/index.js").ValidationFinding[];
    youtube: import("../../../src/contract/index.js").ValidationFinding[];
  };
}

export type AssetDetail = import("../../../src/contract/index.js").Asset;

export type ContentDetail = import("../../../src/contract/index.js").ContentItem & {
  asset: import("../../../src/contract/index.js").Asset | null;
  jobs: import("../../../src/contract/index.js").PublishJob[];
  findings: import("../../../src/contract/index.js").ValidationFinding[];
};

export interface SchedulerPayload {
  [key: string]: unknown;
}

export interface IngestKey {
  key: string;
  prefix: string;
}

/** Yalnızca görüntüleme için: sunucu 501 dönerse. */
export interface NotImplementedPayload {
  reason?: string;
}

// ── Analitik ───────────────────────────────────────────────────────────────

/** Sebep → sayı. Sunucu beş sebebin HEPSİ için (0 dahil) anahtar gönderir. */
export type ReasonCounts = Record<MetricUnavailableReason, number>;

/** Tek platformun dönem özeti — panelin üst kartı. */
export interface AnalyticsPlatformCard {
  platform: Platform;
  totals: Record<string, number>;
  /** Her toplamın dayandığı iş sayısı. `0` ise değer `null` gösterilir. */
  contributors: Record<string, number>;
  rates: MetricRates;
  available: { configured: boolean; reason: string | null };
  latestDate: string | null;
  itemCount: number;
  measuredCount: number;
  /** Satır var ama hiç değer yok (IG 48 saat gecikmesi). `0` DEĞİLDİR. */
  noDataCount: number;
  unavailableCount: number;
  unavailableReasons: ReasonCounts;
  missingDataDays: number;
  completeness: DataCompleteness;
}

export interface AnalyticsOverview {
  mode: "mock" | "live";
  from: string;
  to: string;
  /** Bir önceki, eşit uzunlukta dönem. */
  previous: { from: string; to: string };
  platforms: AnalyticsPlatformCard[];
}

/** Günlük tablonun bir satırı. `null` = "bu metrik için ölçülen değer yok". */
export interface AnalyticsSeriesPoint {
  date: string;
  platform: Platform;
  views: number | null;
  interactions: number | null;
  saves: number | null;
  shares: number | null;
  items: number;
  measured: number;
  unavailable: { count: number; byReason: ReasonCounts } | null;
}

export interface AnalyticsSeries {
  from: string;
  to: string;
  points: AnalyticsSeriesPoint[];
}

export interface AnalyticsCoverage {
  from: string;
  to: string;
  /** Pencerede en az bir satırı görünen iş sayısı. */
  totalJobs: number;
  /** En son satırı gerçek ölçüm içeren iş sayısı. */
  measurable: number;
  unavailable: Array<{ platform: Platform; count: number; byReason: ReasonCounts }>;
}

export interface AnalyticsContentAsset {
  id: string;
  originalName: string;
  mimeType: string;
  bytes: number;
  hasCover: boolean;
}

export interface AnalyticsContentPoint {
  date: string;
  platform: Platform;
  metrics: Record<string, number | null>;
  unavailable: { reason: MetricUnavailableReason; message: string } | null;
}

export interface AnalyticsContentDetail {
  contentId: string;
  asset: AnalyticsContentAsset | null;
  jobs: PublishJob[];
  rollup: RollupResult;
  series: AnalyticsContentPoint[];
  /** Karşılaştırılacak veri yoksa `null` (0 dönem DEĞİL). */
  previous: { window: { from: string; to: string }; rollup: RollupResult } | null;
  change: PeriodComparison | null;
  /** YouTube view sayımı değişim tarihi (sunucudan gelir, panelde sabit yazılmaz). */
  viewsCountingChangeDate: string;
}

export interface AnalyticsCollectResult {
  collected: number;
  fetched: number;
  skipped: number;
  metricDate: string;
  results: Array<{ jobId: string; ok: boolean; reason: string | null }>;
}