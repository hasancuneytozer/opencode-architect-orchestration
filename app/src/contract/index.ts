/**
 * Paylaşılan sözleşme. Hem sunucu hem arayüz (web/) buradan içe aktarır.
 * Buradaki türler veritabanı satırları, HTTP gövdeleri ve iş kuyruğu arasındaki
 * ortak dildir; tek yerde değişir, üç yerde birden değiştirilmez.
 *
 * DİL KURALI: Bu dosyada yalnızca veri şekilleri vardır. İş kuralı, ağ çağrısı,
 * dosya erişimi veya veritabanı erişimi YOKTUR. Testi veritabanı gerektirmez.
 *
 * SÜRÜM NOTU: zod 4 kullanılıyor. `z.record()` iki argüman ister ve
 * `.partial()` içindeki `.default()` alanları ÇIKARMAZ (sessizce doldurur).
 * Bu iki tuzak aşağıda düzeltilmiştir; geri alma.
 */
import { z } from "zod";

// ── Platformlar ───────────────────────────────────────────────────────────

// Tanım `platforms.ts`'te: çalışma zamanı sabiti gereken kod o dosyayı
// import eder, böylece zod tarayıcı paketine sızmaz. Bkz. o dosyanın yorumu.
import { PLATFORMS, type Platform } from "./platforms.js";
export { PLATFORMS, PLATFORM_LABELS, type Platform } from "./platforms.js";

export const PlatformSchema = z.enum(PLATFORMS);

export const ALL_JOB_STATES = [
  "queued",
  "preparing",
  "uploading",
  "processing",
  "published",
  "published_no_link",
  "failed",
  "canceled",
] as const;
export type JobState = (typeof ALL_JOB_STATES)[number];
export const JobStateSchema = z.enum(ALL_JOB_STATES);

/** Yayının bittiği, kalıcı permalink'in çözümlendiği tek durum. */
export const TERMINAL_OK_STATES = ["published"] as const;
/** Yayın tamam ama permalink çözümlenemedi (TikTok SELF_ONLY gibi). */
export const PUBLISHED_STATES = ["published", "published_no_link"] as const;
/** Yeniden denenebilir durumlar: kuyruğa geri alınabilir. */
export const RETRYABLE_STATES = ["failed"] as const;

export const ALL_CONTENT_STATES = [
  "draft",
  "validating",
  "ready",
  "scheduled",
  "published",
  "partial",
  "failed",
  "canceled",
] as const;
export type ContentState = (typeof ALL_CONTENT_STATES)[number];
export const ContentStateSchema = z.enum(ALL_CONTENT_STATES);

// ── Hata modeli ───────────────────────────────────────────────────────────

/**
 * Bir yayın hatasının sınıfı. Politika kararı TEK YERDE: `isRetryableKind`.
 * Sağlayıcıya özel kodlar (TikTok `fail_reason`, Meta `subcode`, YouTube `reason`)
 * bu sınıflara ADAPTÖR içinde eşlenir; eşleme tabloları sözleşmede değil,
 * ilgili adaptörde yaşar (böylece platforma özel bilgi çekirdeğe sızmaz).
 */
export const PUBLISH_ERROR_KINDS = [
  // geçici
  "network",
  "ratelimit",
  "server",
  "transient",
  // kalıcı
  "validation",
  "auth",
  "policy",
  "quota",
  // medya/sağlayıcıya özel
  "media_rejected",
  "container_expired",
  "not_public",
  "unknown",
] as const;
export type PublishErrorKind = (typeof PUBLISH_ERROR_KINDS)[number];

const RETRYABLE_ERROR_KINDS: ReadonlySet<PublishErrorKind> = new Set([
  "network",
  "ratelimit",
  "server",
  "transient",
]);

/** Geçici mi kalıcı mı? Tek doğruluk kaynağı. */
export function isRetryableKind(kind: PublishErrorKind): boolean {
  return RETRYABLE_ERROR_KINDS.has(kind);
}

export interface PublishFailure {
  kind: PublishErrorKind;
  message: string;
  /** Sağlayıcının ham kodu. TikTok `fail_reason`, Meta `code/subcode`, YouTube `reason`. */
  providerCode: string | null;
  /** TikTok `log_id` — destek talebi için ZORUNLU. Diğer platformlarda null. */
  logId: string | null;
  httpStatus: number | null;
  retryAfterMs: number | null;
  retryable: boolean;
  at: string;
}

// ── Teknik doğrulama bulguları ────────────────────────────────────────────

export const SEVERITIES = ["error", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SeveritySchema = z.enum(SEVERITIES);

export interface ValidationFinding {
  /** Makine tarafından okunur, ör. "aspect_ratio", "duration_max", "fps_range" */
  code: string;
  severity: Severity;
  message: string;
  limit?: string;
  observed?: string;
  /** Sınır resmî dokümanla doğrulanmadıysa true. */
  provisional?: boolean;
}

export interface MediaInfo {
  path: string;
  bytes: number;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  pixelFormat: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  durationSec: number | null;
  bitrate: number | null;
  hasAudio: boolean;
}

// ── Platform kısıtları ────────────────────────────────────────────────────

/**
 * Tek bir teknik sınır. `provisional: true` ise bu değer RESMÎ DOKÜMANLA
 * DOĞRULANMAMIŞTIR ve panelde uyarı olarak gösterilir. Yanlış bir sınırı
 * "doğrulanmış" gibi sunmak kullanıcıyı yayın hatasına sokar; belirsizlik
 * saklanmaz, işaretlenir.
 */
export interface LimitRule {
  code: string;
  label: string;
  rule: string;
  min?: number;
  max?: number;
  enumValues?: Array<number | string>;
  maxBytes?: number;
  /** Resmî doküman bağlantısı. */
  source: string | null;
  provisional: boolean;
}

export interface PlatformSpec {
  platform: Platform;
  label: string;
  /** Sağlayıcının resmî API'si yayın zamanlamasını destekliyor mu. */
  supportsNativeSchedule: boolean;
  /**
   * Yayın için video yalnızca ikili (binary) yüklenebiliyorsa true.
   * Instagram: resumable upload VAR → false. TikTok: FILE_UPLOAD var → false.
   * YouTube: resumable upload var → false.
   */
  supportsBinaryUpload: boolean;
  /**
   * Yalnızca public URL ile yayınlanabilen bir yol varsa true.
   * 2026-09 itibarıyla HİÇBİR platformda true değil; alan ileride
   * geri gelirse (ör. yeni bir yöntem) tanımlayıcıları etkiler.
   */
  requiresPublicMediaUrl: boolean;
  limits: LimitRule[];
}

// ── Metin alanları ────────────────────────────────────────────────────────

/**
 * Kullanıcının GERÇEKTEN gönderdiği alanlar: seyrek, varsayılansız.
 * `PlatformCopyOverrideSchema.partial()` KULLANMA — zod 4 `.partial()`
 * içindeki `.default()` alanlarını çıkarmaz, yani "kullanıcı göndermedi"
 * ile "kullanıcı boş gönderdi" ayırt edilemez ve merge sessizce ezilir.
 */
export const PlatformCopyOverrideSchema = z
  .object({
    caption: z.string().max(2200).optional(),
    hashtags: z.array(z.string().max(60)).max(30).optional(),
    title: z.string().max(100).optional(),
    description: z.string().max(5000).optional(),
    tags: z.array(z.string().max(60)).max(500).optional(),
    madeForShorts: z.boolean().optional(),
    selfDeclaredMadeForKids: z.boolean().optional(),
    aiGenerated: z.boolean().optional(),
    coverAtPercent: z.number().min(10).max(95).optional(),
    privacy: z.enum(["public", "unlisted", "private"]).optional(),
  })
  .strict();
export type PlatformCopyOverride = z.infer<typeof PlatformCopyOverrideSchema>;

/** Doldurulmuş hal — adaptöre giden bu. */
export const PlatformCopySchema = PlatformCopyOverrideSchema.extend({
  hashtags: z.array(z.string().max(60)).max(30).default([]),
  tags: z.array(z.string().max(60)).max(500).default([]),
  madeForShorts: z.boolean().default(true),
  selfDeclaredMadeForKids: z.boolean().default(false),
  aiGenerated: z.boolean().default(true),
  coverAtPercent: z.number().min(10).max(95).default(35),
  privacy: z.enum(["public", "unlisted", "private"]).default("public"),
});
export type PlatformCopy = z.infer<typeof PlatformCopySchema>;

export const PerPlatformCopySchema = z
  .object({
    instagram: PlatformCopyOverrideSchema.optional(),
    tiktok: PlatformCopyOverrideSchema.optional(),
    youtube: PlatformCopyOverrideSchema.optional(),
  })
  .strict();
export type PerPlatformCopy = z.infer<typeof PerPlatformCopySchema>;

/**
 * AI bildirimi platform başına FARKLI yere gider; tek boolean yetmez.
 * - TikTok: `post_info.is_aigc` (Direct Post'ta var)
 * - YouTube: `status.containsSyntheticMedia` (yükleme anında)
 * - Instagram: `is_ai_generated` (container oluştururken, 2026-06-22'den beri)
 *   — API alanı var; ayrıca topluluk standardı etiketlemeyi zorunlu kılıyor.
 */
export interface AiDisclosure {
  tiktokIsAigc: boolean;
  youtubeSyntheticMedia: boolean;
  instagramIsAiGenerated: boolean;
  /** Kullanıcı bu içerik gerçekçi değilse (ürün çekimi, kurgu) kapatabilir. */
  userConfirmed: boolean;
}

export const AiDisclosureSchema = z
  .object({
    tiktokIsAigc: z.boolean().default(true),
    youtubeSyntheticMedia: z.boolean().default(true),
    instagramIsAiGenerated: z.boolean().default(true),
    userConfirmed: z
      .boolean()
      .default(false)
      .describe("Kullanıcı, içeriğin AI üretimi olduğunu onayladı mı? Onaysız gönderilmez."),
  })
  .strict();

// ── Zaman ─────────────────────────────────────────────────────────────────

/**
 * Hem ofsetli ISO hem offset'siz yerel saati kabul eder.
 * `z.iso.datetime({offset:true})` offset'siz girdiyi ("2026-09-30T18:00")
 * reddeder; arayüzün `<input type="datetime-local">` gönderdiği biçim tam olarak
 * budur. Buna karşılık `z.iso.datetime({local:true})` sahte tarihleri
 * ("2026-02-31") geçirir. Aşağıdaki desen ikisini de doğru karşılar.
 */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/;

export const ScheduledAtSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (v) => ISO_DATETIME.test(v),
    "ISO 8601 tarih-saat bekleniyor. Örnekler: 2026-09-30T18:00, 2026-09-30T18:00:00+03:00",
  )
  .refine(
    (v) => !Number.isNaN(Date.parse(v.replace(" ", "T"))),
    "Geçerli bir tarih değil (örn. 2026-02-31 kabul edilmez).",
  );

/** IANA saat dilimi adı doğrulaması. "Ankara" kabul edilmez. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, "Geçerli IANA saat dilimi adı olmalı (örn. Europe/Istanbul)")
  .default("Europe/Istanbul");

export const TimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "SS:DD biçiminde saat bekleniyor (örn. 23:00)");

/**
 * Sessiz saat: bu aralıkta zamanlanan yayın ertelenir. Yerel saat, "HH:MM".
 * Başlangıç > bitiş ise gece yarısını geçer (örn. 23:00 → 07:00).
 */
export const QuietHoursSchema = z
  .object({
    start: TimeOfDaySchema,
    end: TimeOfDaySchema,
  })
  .strict();
export type QuietHours = z.infer<typeof QuietHoursSchema>;

// ── Girdi kaynakları (güvenlik) ───────────────────────────────────────────

/**
 * `sourcePath` sunucu tarafında okunan bir yoldur. AI projesi bu alanı
 * doldururken saldırgan kontrolünde olabilir; `.env`, `~/.ssh/id_rsa`
 * okunabilmesin diye gezinme (nokta-nokta) ve ev dizini genişletmesi reddedilir.
 * Dosya sistemi kökü ayrıca `src/config` tarafından sınırlandırılır.
 */
export const SourcePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !v.includes("\0"), "NUL karakteri yasak.")
  .refine((v) => !/^\s*[~.]/.test(v) && !v.includes(".."), "Gezinme (~, ..) yasak.");

/**
 * `sourceUrl` SSRF'ye açıktır: yalnız http(s), özel IP aralıkları, yerel
 * dosya şeması ve bulut metadata adresi reddedilir.
 */
const BLOCKED_URL_HOST =
  /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|metadata\.google\.internal)/i;

export const SourceUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), "Yalnız http/https. file:// veya veri: kabul edilmez.")
  .refine(
    (v) => {
      try {
        return !BLOCKED_URL_HOST.test(new URL(v).hostname);
      } catch {
        return false;
      }
    },
    "Özel IP aralıklarına veya yerel adreslere erişilemez.",
  );

// ── Ingest ────────────────────────────────────────────────────────────────

const IngestBaseSchema = z.object({
  project: z.string().min(1).max(120),
  campaign: z.string().max(120).optional(),
  sourcePath: SourcePathSchema.optional(),
  sourceUrl: SourceUrlSchema.optional(),
  fileName: z.string().max(255).optional(),
  platforms: z.array(PlatformSchema).min(1).max(3),
  /**
   * Kullanıcının seçtiği zaman. Ofset varsa UTC'ye çevrilir; yoksa
   * `timezone` ile yorumlanır. DEPOLANAN DEĞER DAİMA UTC ISO'dur —
   * yerel saat kaydetmek, yıl boyunca kaymaya yol açar.
   */
  scheduledAt: ScheduledAtSchema.optional(),
  /** Yalnız offset'siz `scheduledAt` için anlamlı, ve sessiz saat hesabı için. */
  timezone: TimeZoneSchema,
  /** Bu aralıkta zamanlanan yayın ertelenir. */
  quietHours: QuietHoursSchema.optional(),
  defaultCopy: PlatformCopyOverrideSchema.optional(),
  copy: PerPlatformCopySchema.optional(),
  tags: z.array(z.string().max(60)).max(30).default([]),
  /** Aynı toplu isme bağlayan anahtar. AI projesi birden çok dosya gönderebilir. */
  batchId: z.string().max(120).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  /**
   * Varsayılan FALSE. Reklam içeriği insan onayı olmadan yayına girmemeli;
   * bu alanı true yapan istemci (CLI/otomasyon) bilinçli olarak riski alıyor.
   */
  autoSchedule: z.boolean().default(false),
  /** true ise AI bildirimi (is_aigc / AI info / synthetic media) gönderilir. */
  aiDisclosure: AiDisclosureSchema.optional(),
});

/**
 * `.refine()` `.strict()` sonrasında `ZodEffects` üretir ve `.shape` erişimi
 * kaybolur. Bu yüzden önce temel şema kurulur, sonra tek kaynaktan kural
 * uygulanır — `.shape` kullanan testler bozulmasın diye.
 */
export const IngestRequestSchema = IngestBaseSchema.strict()
  .refine(
    (v) => [v.sourcePath, v.sourceUrl].filter(Boolean).length <= 1,
    "sourcePath ve sourceUrl aynı anda verilemez.",
  )
  .refine(
    (v) => Boolean(v.sourcePath) !== Boolean(v.sourceUrl),
    "Tam olarak biri zorunludur: sourcePath, sourceUrl veya multipart file alanı.",
  )
  .refine(
    (v) => !v.autoSchedule || v.scheduledAt !== undefined || v.scheduledAt === undefined,
    "autoSchedule=true iken scheduledAt verilmemişse içerik hemen yayınlanır; bilinçli seçimdir.",
  );
export type IngestRequest = z.infer<typeof IngestRequestSchema>;
export const IngestBaseShape = IngestBaseSchema.shape;

// ── Varlıklar ─────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  notes: string | null;
  createdAt: string;
}

export interface Asset {
  id: string;
  /** HANGİ AI projesinin çıktısı. Kaynak asset'te null olabilir. */
  projectId: string | null;
  storageKey: string;
  originalName: string;
  bytes: number;
  mimeType: string;
  info: MediaInfo;
  findings: ValidationFinding[];
  coverKey: string | null;
  /** Transcoder çıktısı ise kaynak asset. Platform başına bir kopya. */
  derivedFromAssetId: string | null;
  derivedForPlatform: Platform | null;
  createdAt: string;
}

export interface ContentItem {
  id: string;
  projectId: string;
  assetId: string;
  state: ContentState;
  campaign: string | null;
  tags: string[];
  copy: PerPlatformCopy;
  /** DAİMA UTC ISO. */
  scheduledAt: string | null;
  timezone: string;
  quietHours: QuietHours | null;
  metadata: Record<string, unknown>;
  aiDisclosure: AiDisclosure;
  /** Onay akışı. Reklam içeriği için varsayılan gerekir. */
  requiresApproval: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  batchId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  id: string;
  platform: Platform;
  /** Platform tarafındaki kalıcı kimlik: IG user id, TikTok open_id, YouTube channel id. */
  externalId: string;
  displayName: string;
  username: string | null;
  status: "active" | "needs_reauth" | "disabled";
  label: string | null;
  createdAt: string;
}

/**
 * Kimlik deposu. Kolon adları ve kutu biçimi BURADA sabitlenir; şifreleme
 * algoritması `CredentialCipher` uygulamasında yaşar, ama biçim sözleşmedir:
 * iki farklı biçim, sessizce okunamayan veri üretir.
 */
export interface CredentialRecord {
  id: string;
  accountId: string;
  platform: Platform;
  /** Şifreli kutu: sürüm etiketli, nonce + ciphertext + tag. */
  accessTokenEnc: string;
  /** TikTok yeni bir refresh_token dönebilir; ayrı kolonda tutulur. */
  refreshTokenEnc: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  /** Yenilendiğinde değişir → "eski refresh token geçersiz" kuralı buradan. */
  rotatedAt: string | null;
  /** Token'ın hangi hesaba ait olduğu. Yenilemede değişirse alarm. */
  boundExternalId: string | null;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PublishJob {
  id: string;
  contentId: string;
  platform: Platform;
  accountId: string;
  state: JobState;
  /** DAİMA UTC ISO. */
  scheduledAt: string;
  attempts: number;

  /**
   * Aynı işin iki kez yayınlanmasını engelleyen anahtar. TikTok init ve
   * YouTube resumable başlangıcında sunucuya gönderilir, birimimizde kalıcıdır.
   * "Kiralama doldu, işçi yeniden çalıştı" senaryosunun tek savunması budur.
   */
  idempotencyKey: string;
  /** Bu anahtarın ilk kez sunucuya gönderildiği an. */
  idempotencyFirstUsedAt: string | null;

  /** Geçici kimlik: Meta container_id, TikTok publish_id. */
  externalId: string | null;
  /** Meta resumable yükleme URI'si ve TikTok upload_url. **1 saat geçerli.** */
  uploadUrl: string | null;
  uploadUrlExpiresAt: string | null;
  /** Parça/resumable ilerlemesi — süre aşımında kaldığı yerden devam için. */
  uploadedParts: number;
  totalParts: number | null;

  /** Yayınlanmış içeriğin kalıcı kimliği. */
  remoteId: string | null;
  permalink: string | null;

  error: PublishFailure | null;
  nextAttemptAt: number | null;

  /** Kuyruk kiralama: aynı iş iki işçide birden çalışmasın. */
  leaseOwner: string | null;
  leaseExpiresAt: number | null;

  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
}

// ── Yardımcılar ───────────────────────────────────────────────────────────

export function isVertical(info: Pick<MediaInfo, "width" | "height">): boolean {
  if (!info.width || !info.height) return false;
  return info.height > info.width;
}

export function aspectRatio(width: number, height: number): number {
  return width / height;
}

export const TARGET_ASPECT = 9 / 16;
/** Tolerans: mutlak fark. 9:16 yerine 1080x1918 gibi kompozit çıktıları da kabul eder. */
export const ASPECT_TOLERANCE = 0.06;

/** Toleranslı 9:16 kontrolü. `ASPECT_TOLERANCE` burada GERÇEKTEN uygulanır. */
export function isTargetAspect(
  info: Pick<MediaInfo, "width" | "height">,
  tolerance: number = ASPECT_TOLERANCE,
): boolean {
  if (!info.width || !info.height) return false;
  return Math.abs(aspectRatio(info.width, info.height) - TARGET_ASPECT) <= tolerance;
}

/**
 * Girdi zaman damgasını UTC ISO'ya çevirir. Ofsetli girdi olduğu gibi çözülür;
 * offset'siz girdi `timezone` ile yorumlanır. Geçersiz saat dilimi hata fırlatır.
 */
export function resolveScheduledAt(
  value: string,
  timezone: string,
): string {
  const normalized = value.replace(" ", "T");
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(normalized);
  if (hasOffset) {
    return new Date(normalized).toISOString();
  }
  if (!isValidTimeZone(timezone)) {
    throw new Error(`Geçersiz saat dilimi: ${timezone}`);
  }
  // "2026-09-30T18:00" → UTC'ye kaydırmak için dilimin o andaki ofsetini bul.
  const asUtcGuess = new Date(`${normalized}Z`);
  if (Number.isNaN(asUtcGuess.getTime())) {
    throw new Error(`Geçersiz tarih: ${value}`);
  }
  const offset = tzOffsetMs(asUtcGuess, timezone);
  return new Date(asUtcGuess.getTime() - offset).toISOString();
}

/** `instant` anındaki `timezone` ofseti (ms). */
export function tzOffsetMs(instant: Date, timezone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

/** Verilen an `timezone`'de sessiz saat aralığında mı? */
export function isWithinQuietHours(
  instant: Date,
  quiet: QuietHours | null,
  timezone: string,
): boolean {
  if (!quiet) return false;
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
  const now = toMinutes(hhmm);
  const from = toMinutes(quiet.start);
  const to = toMinutes(quiet.end);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}
