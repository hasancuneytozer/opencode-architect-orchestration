/**
 * Sağlayıcı hata kodu → politika eşlemesi. SAF FONKSİYON: ağ yok, zaman yok,
 * dosya yok. Girdi bir ham kod, çıktı bir sınıf + kalıcı/geçici kararı.
 *
 * NEDEN ÇEKİRDEKTE DEĞİL: bu tablolar platforma özeldir. TikTok `fail_reason`
 * sözlüğü Instagram'da anlam taşımaz; üçünü tek `Record<Platform, ...>`
 * tablosunda toplamak, bir platformun kodunu diğerine sızdırır. Burada üç
 * tablo AYRI AYRI dışa aktarılır; her platform adaptörü kendi tablosunu alır.
 *
 * NEDEN `kind` ÜZERİNDEN `retryable`: `retryable` ayrı bir alan olarak
 * YAZILMAZ, `isRetryableKind(kind)` ile HESAPLANIR. Böylece "geçici görünüp
 * kalıcı davranan" ya da tersi bir satır yazılamaz; tablo ile politika
 * arasındaki kayma imkânsızdır. Kural: geçici sınıflar yalnızca
 * network / ratelimit / server / transient'tır.
 *
 * BİLİNMEYEN KOD: `null`, boş, büyük/küçük harf ya da listelenmemiş hiçbir
 * kod `unknown` + kalıcı olur. "Belki geçcidir" diye geçici saymak, destek
 * talebinde yanlış teşhis ve sonsuz yeniden deneme demektir. Şüphede kalıcıdır.
 */
import { isRetryableKind } from "../contract/index.js";
import type { PublishErrorKind } from "../contract/index.js";

// ── Ortak dönüş tipi ──────────────────────────────────────────────────────

/**
 * Üç eşleme tablosunun ortak dönüş tipi.
 * `retryable` = `isRetryableKind(kind)`; ayrıca yazılmaz.
 */
export interface ProviderErrorMapping {
  kind: PublishErrorKind;
  /** Yeniden denenebilir mi. `kind` geçici sınıflardan biriyse true. */
  retryable: boolean;
  /** Panelde gösterilecek tek cümlelik açıklama (Türkçe). */
  message: string;
  /** Sağlayıcının ham kodu; destek talebinde birebir geçer. */
  providerCode: string;
}

interface Rule {
  kind: PublishErrorKind;
  message: string;
}

function fromRule(
  providerCode: string,
  table: ReadonlyMap<string, Rule>,
  unknownMessage: string,
): ProviderErrorMapping {
  const rule = table.get(providerCode);
  if (!rule) {
    return { kind: "unknown", retryable: false, message: unknownMessage, providerCode };
  }
  return {
    kind: rule.kind,
    retryable: isRetryableKind(rule.kind),
    message: rule.message,
    providerCode,
  };
}

// ── TikTok: Content Posting API `fail_reason` ─────────────────────────────

/**
 * TikTok `status.data.fail_reason` değerleri (doğrulanmış liste).
 *
 * Sınıflandırma gerekçesi:
 * - `*_check_failed` → `media_rejected`: hepsi dosyanın kendisinden kaynaklanan
 *   teknik kontrol. Yeniden denemek aynı dosyayı aynı sonuçla gönderir.
 * - `*_pull_failed` → `transient`: sağlayıcının bizim medyamızı çekme hatası.
 *   Aynı istek yeni bir `publish_id` ile geçici olabilir.
 * - `internal` → `transient`: TikTok'un genel geçici hata kodu.
 * - `publish_cancelled` → `policy`: kullanıcı/sistem tarafında iptal edilmiş;
 *   sessizce yeniden denemek iptal kararını geri alır.
 * - `spam_risk_too_many_posts` → `quota`: yayın sıklığı kotası.
 * - `spam_risk_user_banned_from_posting`, `spam_risk_text`, `spam_risk` →
 *   `policy`: hesap ya da metin kararı; tekrar denemek hesabı riske atar.
 * - `auth_removed` → `auth`: TikTok dokümanı açıkça "Retry should not be done"
 *   der; yetki yenilenmeden denemek anlamsızdır.
 */
export const TIKTOK_FAIL_REASONS: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  [
    "file_format_check_failed",
    { kind: "media_rejected", message: "Dosya biçimi TikTok tarafından kabul edilmedi (kapsayıcı/kodek)." },
  ],
  [
    "duration_check_failed",
    { kind: "media_rejected", message: "Video süresi TikTok sınırı dışında." },
  ],
  [
    "frame_rate_check_failed",
    { kind: "media_rejected", message: "Kare hızı TikTok sınırı dışında." },
  ],
  [
    "picture_size_check_failed",
    { kind: "media_rejected", message: "Görüntü çözünürlüğü TikTok sınırı dışında." },
  ],
  ["internal", { kind: "transient", message: "TikTok tarafı geçici iç hata bildirdi." }],
  ["video_pull_failed", { kind: "transient", message: "TikTok videoyu çekemedi; geçici olabilir." }],
  ["photo_pull_failed", { kind: "transient", message: "TikTok fotoğrafı çekemedi; geçici olabilir." }],
  ["publish_cancelled", { kind: "policy", message: "Yayın TikTok tarafında iptal edildi; tekrar gönderilmez." }],
  [
    "auth_removed",
    { kind: "auth", message: "TikTok yetkilendirmesi kaldırıldı; yeniden deneme yapılmaz." },
  ],
  [
    "spam_risk_too_many_posts",
    { kind: "quota", message: "Yayın sıklığı kotası aşıldı; kalıcı, yeniden deneme işe yaramaz." },
  ],
  [
    "spam_risk_user_banned_from_posting",
    { kind: "policy", message: "Hesap paylaşımda kalıcı olarak engellendi." },
  ],
  ["spam_risk_text", { kind: "policy", message: "Metin spam korumasına takıldı." }],
  ["spam_risk", { kind: "policy", message: "Genel spam riski işareti; hesap incelemeye alınabilir." }],
]);

export function mapTikTokFailReason(reason: string | null | undefined): ProviderErrorMapping {
  const code = typeof reason === "string" ? reason.trim() : "";
  if (code === "") {
    return { kind: "unknown", retryable: false, message: "TikTok hata kodu yok.", providerCode: "" };
  }
  return fromRule(
    code,
    TIKTOK_FAIL_REASONS,
    `TikTok fail_reason tanınmıyor: ${code}. Kalıcı kabul edildi, yeniden denenmedi.`,
  );
}

// ── Meta: Graph API `error.code` + `error_subcode` ────────────────────────

/**
 * `code/subcode` çiftleri (doğrulanmış):
 * - `9/2207042` günlük yayın kotası doldu → kalıcı. Kota kendiliğinden dolar,
 *   dakikalar içinde yeniden denemek yalnızca isabet hızını düşürür.
 * - `4/2207051` spam koruması → kalıcı politika kararı.
 * - `25/2207050` IG hesabı kısıtlı → kalıcı politika kararı.
 * - `-2/2207003` medya indirmek çok uzun sürdü → GEÇİCİ: sağlayıcı tarafında
 *   zaman aşımı, aynı istek başka bir yerde çalışabilir.
 *
 * DİKKAT: `code` TEK BAŞINA (`subcode` olmadan) bu tabloda YOKTUR ve
 * `unknown` → kalıcı döner. Doğrulanmamış satır uydurmak, kotayı "bilinmeyen
 * kalıcı hata" gibi gösterip yanlış teşhis üretir. `code 9` tek başına
 * günlük kotaya işaret eder; yine de doğrulanmış eşleme olmadığı için
 * bilinçli olarak `unknown` bırakıldı. Tabloyu genişletmek adaptörde yapılmalı ve
 * doğrulama kaynağı yazılmalıdır.
 */
export const META_ERROR_SUBCODES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  ["9/2207042", { kind: "quota", message: "Instagram günlük yayın kotası doldu." }],
  ["4/2207051", { kind: "policy", message: "Meta spam koruması yayını reddetti." }],
  ["25/2207050", { kind: "policy", message: "Instagram hesabı kısıtlandı." }],
  ["-2/2207003", { kind: "transient", message: "Meta medyayı indirmeyi zaman aşımına uğrattı." }],
]);

/** `error.code` tek başına taşıdığı anlam taşıyan kodlar. */
export const META_ERROR_CODES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  [
    "9004",
    {
      kind: "network",
      message:
        "Meta medyayı URI'den çekemedi (9004). Geçici kabul edildi; bağlantı ölüyse bir sonraki denemede kalıcıya döner.",
    },
  ],
  ["80002", { kind: "ratelimit", message: "Meta hız sınırı (80002 throttle)." }],
]);

export interface MetaErrorInput {
  /** Graph API `error.code` (ör. 9, 4, 25, -2, 9004, 80002). */
  code?: number | string | null;
  /** `error_subcode` (ör. 2207042). */
  subcode?: number | string | null;
  /** Bazı yanıtlarda hata kodu `error.code` içinde string gelir. */
  errorCode?: number | string | null;
  /** Container durum sorgusundaki `status_code`. */
  statusCode?: string | null;
}

/** `null`/tanımsız/boş → `null` ("yok"); sayı veya metin → kırpılmış metin. */
function codeText(value: number | string | null | undefined): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  return null;
}

/**
 * Meta hata gövdesini sınıflandırır.
 *
 * ÖNCELİK: `errorCode` → `code/subcode` → `code` tek başına → `statusCode`.
 * Hata alanları, durum alanından daha spesifik bilgi taşır; bu yüzden önce
 * bakılır.
 */
export function mapMetaError(input: MetaErrorInput): ProviderErrorMapping {
  const errorCode = codeText(input.errorCode);
  if (errorCode !== null && META_ERROR_CODES.has(errorCode)) {
    return fromRule(
      errorCode,
      META_ERROR_CODES,
      `Meta error.code tanınmıyor: ${errorCode}. Kalıcı kabul edildi.`,
    );
  }

  const code = codeText(input.code);
  const subcode = codeText(input.subcode);
  if (code !== null && subcode !== null) {
    const pair = `${code}/${subcode}`;
    if (META_ERROR_SUBCODES.has(pair)) {
      return fromRule(
        pair,
        META_ERROR_SUBCODES,
        `Meta code/subcode tanınmıyor: ${pair}. Kalıcı kabul edildi.`,
      );
    }
    // Bilinen bir üst kod varsa (ör. 80002) o kullanılır.
    if (META_ERROR_CODES.has(code)) {
      return fromRule(code, META_ERROR_CODES, `Meta code tanınmıyor: ${code}. Kalıcı kabul edildi.`);
    }
    // Tanımsız ÇİFT: üst kod da bilinmiyorsa ham kod mesajda korunur, yoksa
    // destek talebinde elde edilecek tek ipucu kaybolur.
    return {
      kind: "unknown",
      retryable: false,
      message: `Meta code/subcode tanınmıyor: ${pair}. Kalıcı kabul edildi.`,
      providerCode: pair,
    };
  }

  if (code !== null && META_ERROR_CODES.has(code)) {
    return fromRule(code, META_ERROR_CODES, `Meta code tanınmıyor: ${code}. Kalıcı kabul edildi.`);
  }

  const statusCode = codeText(input.statusCode);
  if (statusCode !== null) {
    const status = mapMetaStatus(statusCode);
    return {
      kind: status.kind ?? "unknown",
      retryable: status.retryable,
      message: status.message,
      providerCode: status.providerCode,
    };
  }

  return {
    kind: "unknown",
    retryable: false,
    message: "Meta yanıtında tanınabilir hata kodu yok; kalıcı kabul edildi.",
    providerCode: "",
  };
}

// ── Meta: container `status_code` ─────────────────────────────────────────

export type MetaContainerStatus =
  | "processing"
  | "ready"
  | "published"
  | "failed"
  | "expired"
  | "unknown";

/**
 * Durum eşlemesi. Hata mappers'ıyla AYNI alanları taşır; farkı `kind: null`
 * olabilmesi ve `status`/`terminal` alanlarının eklenmesidir.
 * `kind: null` = "bu bir hata değil".
 */
export interface MetaStatusMapping {
  kind: PublishErrorKind | null;
  /** Bu durumda işi yeniden denemek anlamlı mı (yoklama sürsün mü). */
  retryable: boolean;
  message: string;
  providerCode: string;
  status: MetaContainerStatus;
  /** Kuyruk işi bu durumda kapatılabilir mi? */
  terminal: boolean;
}

const META_STATUSES: ReadonlyMap<string, MetaStatusMapping> = new Map<
  string,
  MetaStatusMapping
>([
  [
    "IN_PROGRESS",
    {
      kind: null,
      retryable: true,
      message: "Meta container işleniyor; yoklama sürüyor.",
      providerCode: "IN_PROGRESS",
      status: "processing",
      terminal: false,
    },
  ],
  [
    // FINISHED = container işlendi ama medya HENÜZ yayınlanmadı; publish adımı gerekir.
    "FINISHED",
    {
      kind: null,
      retryable: true,
      message: "Container hazır; yayınlama adımı bekliyor.",
      providerCode: "FINISHED",
      status: "ready",
      terminal: false,
    },
  ],
  [
    "PUBLISHED",
    {
      kind: null,
      retryable: false,
      message: "Yayınlandı.",
      providerCode: "PUBLISHED",
      status: "published",
      terminal: true,
    },
  ],
  [
    "ERROR",
    {
      kind: "media_rejected",
      retryable: false,
      message: "Meta işleme hatası; container kalıcı olarak başarısız.",
      providerCode: "ERROR",
      status: "failed",
      terminal: true,
    },
  ],
  [
    // Container 24 saat sonra geçerliliğini yitirir; aynı id ile yeniden
    // kullanılamaz, yeni container gerekir → kalıcı.
    "EXPIRED",
    {
      kind: "container_expired",
      retryable: false,
      message: "Container süresi doldu (24 saat); yeni container gerekir.",
      providerCode: "EXPIRED",
      status: "expired",
      terminal: true,
    },
  ],
]);

/** Büyük/küçük harf ve boşluk normalleştirilir; Meta kodları büyük harftir. */
export function mapMetaStatus(statusCode: string | null | undefined): MetaStatusMapping {
  const code = typeof statusCode === "string" ? statusCode.trim().toUpperCase() : "";
  if (code === "") {
    return {
      kind: "unknown",
      retryable: false,
      message: "Meta durum kodu yok; bilinmeyen kod kalıcı kabul edildi.",
      providerCode: "",
      status: "unknown",
      terminal: false,
    };
  }
  const mapped = META_STATUSES.get(code);
  if (mapped) return mapped;
  return {
    kind: "unknown",
    retryable: false,
    message: `Meta durum kodu tanınmıyor: ${code}. Kalıcı kabul edildi.`,
    providerCode: code,
    status: "unknown",
    terminal: false,
  };
}

// ── YouTube: `videos.insert` reason ──────────────────────────────────────

/**
 * YouTube Data API reason kodları (doğrulanmış).
 * - `uploadLimitExceeded` / `dailyLimitExceeded` → `quota`: günlük kota veya
 *   kota birimine takılan yükleme sınırı; dakikalar içinde çözülmez.
 * - `rateLimitExceeded` → `ratelimit`: geçici.
 * - `invalidVideo` → `media_rejected`: dosyanın kendisi kabul edilmiyor.
 * - `invalidPublishAtTime` → `validation`: zamanlama penceresi geçersiz; aynı
 *   zaman damgasıyla tekrar göndermek aynı hatayı verir.
 * - `unauthorized` → `auth`, `forbidden` → `policy`: ikisi de kalıcı.
 * - `internalServerError` / `serviceUnavailable` → `server`: geçici.
 * - `youtubeSignupRequired` → `policy`: kanal API erişimi olmayan bir YouTube
 *   hesabı; akışta kalıcı engeldir.
 */
export const YOUTUBE_REASONS: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  ["uploadLimitExceeded", { kind: "quota", message: "YouTube yükleme kotası aşıldı." }],
  ["dailyLimitExceeded", { kind: "quota", message: "YouTube günlük kota aşıldı." }],
  ["rateLimitExceeded", { kind: "ratelimit", message: "YouTube hız sınırı; geçici." }],
  ["invalidVideo", { kind: "media_rejected", message: "YouTube videoyu geçersiz saydı." }],
  ["invalidPublishAtTime", { kind: "validation", message: "Yayın zamanı geçersiz." }],
  ["unauthorized", { kind: "auth", message: "Yetkilendirme yok veya süresi dolmuş." }],
  // YouTube, OAuth kapsamı eksik olduğunda `forbidden` DEĞİL `insufficientPermissions`
  // döner. Ayrılmadan önce analitik tarafı "eksik izin" yerine "tanımsız hata" sanıyor
  // ve kullanıcıya yanlış yol gösteriyordu. Kalıcı: kapsam yalnız OAuth ekranından
  // verilebilir, tekrar denemek anlamsız.
  ["insufficientPermissions", { kind: "auth", message: "Yetkilendirme kapsamı eksik." }],
  ["forbidden", { kind: "policy", message: "İşlem kanala izin verilmiyor." }],
  ["internalServerError", { kind: "server", message: "YouTube iç hata; geçici." }],
  ["serviceUnavailable", { kind: "server", message: "YouTube hizmeti geçici olarak kullanılamıyor." }],
  ["youtubeSignupRequired", { kind: "policy", message: "YouTube API erişimi için kanal kaydı gerekli." }],
]);

export function mapYouTubeReason(reason: string | null | undefined): ProviderErrorMapping {
  const code = typeof reason === "string" ? reason.trim() : "";
  if (code === "") {
    return { kind: "unknown", retryable: false, message: "YouTube reason kodu yok.", providerCode: "" };
  }
  return fromRule(
    code,
    YOUTUBE_REASONS,
    `YouTube reason tanınmıyor: ${code}. Kalıcı kabul edildi, yeniden denenmedi.`,
  );
}