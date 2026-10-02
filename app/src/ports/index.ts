/**
 * Portlar: uygulamanın dışarıya bağlandığı yerlerin arayüzleri.
 *
 * Kural: `domain` ve `services` katmanları yalnızca bu arayüzlere bağımlıdır,
 * hiçbir zaman `better-sqlite3`, `ffmpeg`, `fetch` ya da bir sağlayıcı SDK'sına
 * doğrudan dokunmaz. Bu sayede:
 *   - her adaptör tek başına test edilebilir (kütüphane kurmadan),
 *   - gerçek yayıncı ile sahte yayıncı (mock) aynı testleri geçer,
 *   - bir sağlayıcının API'si değişirse sadece adaptör değişir.
 *
 * POLİTİKA KARARLARI BURADA: "hangi hata yeniden denenir" sorusunun cevabı
 * `contract`'teki `isRetryableKind`'dir. Sağlayıcıya özel kod → sınıf eşlemesi
 * ise ilgili adaptörde yaşar; üç platformun kodu da buraya taşınmaz.
 */
import type {
  JobState,
  MediaInfo,
  Platform,
  PlatformSpec,
  PublishErrorKind,
  ValidationFinding,
} from "../contract/index.js";

// ── Medya ─────────────────────────────────────────────────────────────────

export interface FfmpegProbe {
  /** ffprobe ile kapsayıcı/akış bilgisi. Dosya okunamazsa net hata fırlatır. */
  probe(path: string): Promise<MediaInfo>;
}

/** Platforma özel dönüştürme profili. `maxHeight` opsiyonel DEĞİLDİR. */
export interface TranscodePreset {
  platform: Platform;
  /** Uzun kenar. Kırpma yapılmaz, ölçeklenir. */
  maxWidth: number;
  maxHeight: number;
  /** Aşılırsa yayına GÖNDERİLMEZ. */
  maxBytes: number;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  fps?: number;
  container: "mp4" | "mov" | "webm";
  /**
   * Sağlayıcının kendi çektiği yükleme adresinin ömrü (TikTok upload_url 1 saat).
   * null = süre yok. Bu, KENDİ sunucumuzun verdiği medya adresiyle karıştırılmamalı;
   * `MediaStore.publicUrl` için `PublicMediaUrl.expiresAt` kullan.
   */
  providerUploadUrlTtlSec: number | null;
}

export interface TranscodeResult {
  bytes: number;
  info: MediaInfo;
  /** `preset.maxBytes` aşıldıysa false → iş yayına gönderilmez. */
  withinLimits: boolean;
}

export interface Transcoder {
  /** Verilen yüzde konumundan JPEG kapak karesi üretir (yüzde 10-95). */
  grabCover(input: string, atPercent: number): Promise<Buffer>;
  toFeedReady(input: string, output: string, preset: TranscodePreset): Promise<TranscodeResult>;
}

/** Sağlayıcının kendi sunucusundan çekeceği medya adresi. */
export interface PublicMediaUrl {
  url: string;
  /** null = kalıcı/imzasız. Değilse epoch ms. */
  expiresAt: number | null;
}

export interface MediaStore {
  put(key: string, body: Buffer | NodeJS.ReadableStream): Promise<{ key: string; bytes: number }>;
  read(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  pathFor(key: string): string;
  /**
   * `ttlSec` verilmezse KALICI adres döner. Instagram container'ı birkaç kez
   * çekebildiği için kısa ömürlü imzalı adres önerilmez; IG'nin resumable
   * upload yolu varsayılan olarak public URL'e ihtiyaç duymaz.
   * `publicBaseUrl` tanımlı değilse `null` — adaptör bunu "yayınlanamaz"
   * olarak ele almalı, sessizce özel adres üretmemeli.
   */
  publicUrl(key: string, opts?: { ttlSec?: number }): PublicMediaUrl | null;
}

// ── Yayınlama ─────────────────────────────────────────────────────────────

export interface AccountRef {
  id: string;
  platform: Platform;
  externalId: string;
  /** Çözülmüş erişim belirteci. */
  accessToken: string;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
}

export interface MediaRef {
  storageKey: string;
  bytes: number;
  mimeType: string;
  info: MediaInfo;
  coverKey: string | null;
  /** Yalnızca gerçekten public URL gerektiren yol varsa anlamlı. */
  publicUrl: PublicMediaUrl | null;
}

export interface ResolvedCopy {
  caption: string | null;
  hashtags: string[];
  title: string | null;
  description: string | null;
  tags: string[];
  privacy: "public" | "unlisted" | "private";
  coverAtPercent: number;
  /** Platformun kendi AI bildirim alanı bu değerden türetilir. */
  aiGenerated: boolean;
  selfDeclaredMadeForKids: boolean;
  madeForShorts: boolean;
}

export interface PublishInput {
  jobId: string;
  /** Aynı işin iki kez yayınlanmasını engelleyen kalıcı anahtar. */
  idempotencyKey: string;
  account: AccountRef;
  media: MediaRef;
  copy: ResolvedCopy;
  /** DAİMA UTC ISO veya null (hemen yayınla). */
  scheduledAt: string | null;
  /** Kapak karesi için transcoder çıktısı; sıfırın üstünde bayt. */
  coverBytes: Buffer | null;
}

/** Polling için gereken hesap bağlamı. `externalId` tek başına YETMEZ:
 *  Meta `/{ig-user-id}/media?fields=status_code` ister (ig-user-id + container id),
 *  TikTok `publish_id` + token ister, YouTube token ister. */
export interface PollContext {
  account: AccountRef;
  externalId: string | null;
  uploadUrl: string | null;
  uploadUrlExpiresAt: string | null;
  uploadedParts: number;
  totalParts: number | null;
  scheduledAt: string | null;
}

/**
 * `startPublish` cevabı. Durum makinesi dört farklı sonucu tanır:
 * - `immediate`  : iş bitti (YouTube privacyStatus=public ile anında).
 * - `pending`    : sunucu işliyor, `pollPublish` gerekir (Meta, TikTok).
 * - `uploadUrl`  : ikili yükleme başladı; `uploadUrl` 1 saat geçerli, parça
 *                  ilerlemesi `uploadedParts` ile sürdürülür.
 * - `scheduled`  : sağlayıcıya bırakıldı (YouTube `status.publishAt`).
 */
export type StartResult =
  | { kind: "immediate"; remoteId: string; permalink: string | null; state: JobState }
  | { kind: "pending"; externalId: string; state: JobState }
  | { kind: "uploadUrl"; externalId: string; uploadUrl: string; expiresAt: string; state: JobState }
  | { kind: "scheduled"; remoteId: string | null; state: JobState };

export interface PollResult {
  state: JobState;
  remoteId?: string | null;
  permalink?: string | null;
  /** Ağır iş sürüyorsa kaç ms sonra tekrar sorulacağı. */
  retryAfterMs?: number;
  /** Sağlayıcının ham durum kodu (Meta `status_code`, TikTok `status`). Arşiv için. */
  providerStatus?: string | null;
  /** Sağlayıcı bir hata bildirdiyse sınıflandırılmış hata. */
  error?: PublishFailureLite | null;
}

export interface PublishFailureLite {
  kind: PublishErrorKind;
  message: string;
  providerCode: string | null;
  logId: string | null;
  httpStatus: number | null;
}

/** Sağlayıcının yayın kotası. Instagram'da hardcode etmek yanlış: iki resmî
 *  sayfa farklı sayı veriyor (100/24s rehber, 50 endpoint) ve Meta endpoint'ten
 *  anlık okumayı öneriyor. Adaptör destekliyorsa yayından ÖNCE okunur. */
export interface QuotaSnapshot {
  used: number;
  total: number;
  windowSec: number;
}

// ── Parçalı yükleme ───────────────────────────────────────────────────────

/**
 * `StartResult.uploadUrl` bir adresten ibarettir; **baytları gönderen motor
 * olur.** Bu ayrım bilinçlidir: sağlayıcılar farklı parça boyutu, farklı
 * sıra garantisi ve farklı "noktadan devam et" sinyali kullanıyor
 * (TikTok 5-64 MB ve ZORUNLU sıra, YouTube 256 KB katı, Meta `offset` başlığı).
 * Motor bunları bilmez — adaptör bilir.
 *
 * Neden ayrı: motor devam etmeyi `uploadedParts`/`totalParts` ile izler, böylece
 * süreç çöküp yeniden başlasa da yükleme baştan değil kaldığı yerden gider.
 * Tek bir `startPublish` çağrısında hepsini yüklemek bunu imkânsız kılardı.
 */
export interface UploadSession {
  uploadUrl: string;
  /** null = süre bildirilmemiş. TikTok 1 saat verir. */
  expiresAt: string | null;
  /** null = sağlayıcı parçalamayı seçmedi (tek PUT). */
  totalParts: number | null;
  uploadedParts: number;
  /** Adaptör bu boyutu seçer; motor bilmez. */
  partSizeBytes: number;
}

export interface UploadProgress {
  /** Bu çağrıdan sonra kabul edilmiş parça sayısı. Kalıcı yazılır. */
  uploadedParts: number;
  totalParts: number | null;
  /** Tüm baytlar gönderildi mi. */
  done: boolean;
  /**
   * Sağlayıcı "şuradan devam et" diyorsa bayt ofseti; yoksa null.
   * TikTok sıra zorunlu kıldığı için hep `uploadedParts` üzerinden ilerler.
   */
  nextOffset: number | null;
}


export interface PublishAdapter {
  readonly platform: Platform;
  readonly spec: PlatformSpec;

  /** Yayına göndermeden önce son kez doğrular. */
  precheck(input: PublishInput): Promise<ValidationFinding[]>;

  /**
   * Yüklemeyi başlatır / sürdürür. `uploadedParts > 0` ise bu bir DEVAM
   * çağrısıdır: kaldığı parçadan devam etmeli, baştan başlamamalıdır.
   */
  startPublish(input: PublishInput): Promise<StartResult>;

  pollPublish(ctx: PollContext): Promise<PollResult>;

  /**
   * `StartResult.uploadUrl` döndükten SONRA motor bunu çağırır ve baytları
   * gönderir. Desteklemeyen adaptör `undefined` bırakır; bu durumda motor
   * `StartResult.pending` bekler ve bu dal hiç açılmaz.
   *
   * `fromPart > 0` ise **DEVAM** çağrısıdır: baştan gönderilmez, kaldığı yerden
   * ilerler. Motor her çağrıdan sonra ilerlemeyi `publish_jobs`'a yazar.
   */
  uploadParts?(input: PublishInput, session: UploadSession): Promise<UploadProgress>;

  /** Yayın bitti: geçici dosya silme, container kapatma, muhasebe yazma. */
  finalize?(input: PublishInput, result: PollResult): Promise<void>;

  /** Destekleniyorsa yayından önce çağrılır; kotada yer yoksa yayını ERTELE. */
  readQuota?(account: AccountRef): Promise<QuotaSnapshot | null>;
}

export class RetryablePublishError extends Error {
  constructor(
    message: string,
    readonly kind: Extract<PublishErrorKind, "network" | "ratelimit" | "server" | "transient">,
    readonly retryAfterMs: number | null = null,
    readonly providerCode: string | null = null,
    readonly logId: string | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "RetryablePublishError";
  }
}

export class PermanentPublishError extends Error {
  constructor(
    message: string,
    readonly kind: PublishErrorKind,
    readonly providerCode: string | null = null,
    readonly logId: string | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "PermanentPublishError";
  }
}

// ── Kimlik doğrulama ──────────────────────────────────────────────────────

export interface RefreshOutcome {
  accessToken: string;
  /**
   * null = yenileme sırasında YENİ refresh token DÖNMEDİ, eskisi korunmalı.
   * TikTok farklı bir refresh_token döndürürse ESKİSİ GEÇERSİZLEŞİR ve
   * yenisiyle değiştirilmek ZORUNDADIR. null'ı "koru" diye yorumlamak
   * sessizce refresh yeteneğini kaybettirir.
   */
  refreshToken: string | null;
  expiresAt: string | null;
  /** Yenilenen token artık farklı hesaba aitse true → needs_reauth. */
  accountChanged: boolean;
}

export interface AuthProvider {
  readonly platform: Platform;
  authorizeUrl(state: string, redirectUri: string, scopes: string[]): string;
  exchangeCode(input: {
    code: string;
    state: string;
    redirectUri: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresAt: string | null;
    externalId: string;
    username: string | null;
    displayName: string;
    scopes: string[];
    /** Instagram: hangi Facebook Page'e bağlı (resumable yol için gerekli). */
    linkedPageId?: string | null;
  }>;
  /** Süresi dolmuş belirteci yeniler. Desteklenmiyorsa null. */
  refresh?(refreshToken: string): Promise<RefreshOutcome>;
}

// ── Sır saklama ───────────────────────────────────────────────────────────

/**
 * Kutu biçimi SÖZLEŞMEDİR; algoritma uygulamaya aittir. Önerilen biçim:
 *   `v1:<base64url(nonce)>:<base64url(tag)>:<base64url(ciphertext)>`
 * GCM tag'i olmadan şifre çözme sessizce yanlış sonuç verir; bu yüzden
 * `open` başarısız olursa ESKİ METNE DÜŞME, hata fırlat.
 */
export interface CredentialCipher {
  seal(plain: string): string;
  open(sealed: string): string;
}

// ── Analitik ──────────────────────────────────────────────────────────────

export interface MetricSet {
  platform: Platform;
  /** Girdiyle birebir eşleşir; sıra korunur. */
  remoteId: string;
  fetchedAt: string;
  /**
   * Neden ölçülemedi. null ise `metrics` anlamlıdır.
   * TikTok'ta `publicaly_available_post_id` yalnız HERKESE AÇIK yayınlanmış
   * içerik için döner; onaylı olmayan istemci SELF_ONLY yayın yapar ve
   * ölçüm hiç gelmez. "0" ile "bilinmiyor" ayrımı zorunludur.
   */
  unavailable: null | {
    reason: "not_public" | "not_found" | "no_scope" | "provider_error" | "deleted";
    message: string;
  };
  /** null = bu metrik için veri yok. 0 = sıfır. Karıştırma. */
  metrics: Record<string, number | null>;
  /** provider_error durumunda destek kanıtı (TikTok log_id). */
  logId: string | null;
}

export interface AnalyticsAdapter {
  readonly platform: Platform;
  /**
   * Söz: çıktı dizisinin UZUNLUĞU girişle aynıdır ve `result[i]` her zaman
   * `items[i]` içindir. Çağıran indeksle eşleştürmek zorundadır.
   */
  fetchMetrics(items: ReadonlyArray<{ remoteId: string }>): Promise<MetricSet[]>;
}
