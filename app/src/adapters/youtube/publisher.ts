/**
 * GERÇEK YouTube yayın adaptörü — YouTube Data API v3 (`videos.*`).
 *
 * NEDEN İLK GERÇEK ADAPTÖR BU: uygulama incelemesi (app review) GEREK MİYOR.
 * Yükleyen kendi kanalına yükleme yaptığı için Google tarafında onay beklenmez;
 * ayrıca resumable upload sayesinde HİÇBİR HERKESE AÇIK MEDYA ADRESİ
 * gerekmez (`PlatformSpec.requiresPublicMediaUrl: false`).
 *
 * ── BU DOSYANIN EN KRİTİK KURALI: `videos.update` YIKICILIĞI ───────────────
 * `videos.update` yarı-birleştirmedir: gönderdiğiniz `part` içinde
 * BİRİLEŞTİRME alanlarını belirtmezseniz o alanlar **SİLİNİR**. Yani
 * `part=status` ile sadece `privacyStatus` gönderen bir çağrı, videonun
 * `selfDeclaredMadeForKids`, `containsSyntheticMedia`, `license`, `embeddable`
 * ve `publicStatsViewable` beyanlarını sessizce siler. "AI içeriği" beyanı
 * kaybolmak COPPA/AI etiketi açısından geri dönüşü olmayan bir hatadır.
 *
 * Bu yüzden `updateStatus()` ÖNCE `videos.get(part=id,status,snippet)` ile
 * okur (1 kota birimi), sonra birleştirir ve `status` part'ının TÜM
 * yazılabilir alanlarını gönderir. Test bunu GÖVDE üzerinden kanıtlar.
 *
 * ── SESSİZ GİZLİ KURALLAR ──────────────────────────────────────────────────
 *   1. `snippet` güncelleniyorsa `snippet.categoryId` ZORUNLUDUR (yoksa 400).
 *      Bu yüzden `updateStatus` snippet alanı istenirse `categoryId`'yi de
 *      doldurur; yalnız status için `part=status` kullanır.
 *   2. `status.publishAt` YALNIZ `privacyStatus=private` ile ve video daha
 *      hiç yayınlanmamışken geçerlidir. `startPublish` bu yüzden zamanlanmış
 *      yayında `private` gönderir.
 *   3. KOTA (2026): `videos.insert` 1 birim + GÜNDE 100 ÇAĞRI ayrı kova;
 *      `videos.update` 50, `thumbnails.set` 50, `videos.list` 1. (Eski "1600
 *      birim" bilgisi geçersizdir.) `finalize` bu yüzden `thumbnails.set`
 *      ÇAĞIRMAZ.
 *   4. `replay` yapan bir kanal **verilmemiş** projede yüklemeler `private`a
 *      kilitlidir. Bu bir yayın hatası değil, doğrulanmamış bir kanaldır:
 *      kullanıcıya "compliance audit gerekiyor" diyen kalıcı hata üretilir.
 *   5. Reklam uygunluğu ve 18+ kısıtı API'de YOKTUR (Studio-only); bu
 *      yüzden `precheck` onları denetleyemez ve iddia etmez.
 *
 * ── BAYTLAR KİM GÖNDERİR ──────────────────────────────────────────────────
 * `startPublish` yalnızca resumable oturumu açar ve `Location`'ı döndürür;
 * `uploadParts` baytları GÖNDEREN adımdır. Motor (`src/services/publisher.ts`)
 * oturumu `publish_jobs`'a yazar, `uploadedParts` ilerlemesini kalıcı tutar ve
 * her tick'te bir kez `uploadParts` çağırır. Bu ayrım bilinçlidir: tek bir
 * `startPublish` çağrısında her şeyi yapmak, süreç çökünce kaldığı yerden
 * devam etmeyi imkânsız kılardı.
 *
 * YouTube TEK `PUT` önerir; parçalamak (256 KB katı `Content-Range`'ler)
 * varsayılan DEĞİLDİR ve kasten açılmaz.
 */
import type {
  JobState,
  Platform,
  PlatformSpec,
  PublishErrorKind,
  ValidationFinding,
} from "../../contract/index.js";
import { isVertical } from "../../contract/index.js";
import type {
  AccountRef,
  MediaRef,
  PollContext,
  PollResult,
  PublishAdapter,
  PublishFailureLite,
  PublishInput,
  QuotaSnapshot,
  StartResult,
  UploadProgress,
  UploadSession,
} from "../../ports/index.js";
import { PermanentPublishError, RetryablePublishError } from "../../ports/index.js";
import { mapYouTubeReason } from "../../domain/providerErrors.js";
import type { ProviderErrorMapping } from "../../domain/providerErrors.js";
import { canTransition } from "../../domain/stateMachine.js";
import {
  SHORTS_TAG,
  YOUTUBE_DESCRIPTION_MAX_CHARS,
  YOUTUBE_TITLE_MAX_CHARS,
  composeDescription,
  composeTitle,
} from "../../domain/copy.js";
import { getSpec, validateMedia } from "../../media/index.js";
import {
  NATIVE_SCHEDULE_NOTE,
  YOUTUBE_API,
  YOUTUBE_INSERT_DAILY_CALL_BUCKET,
  YOUTUBE_QUOTA_UNITS,
  YOUTUBE_RESUMABLE_CHUNK_BYTES,
} from "../../media/specs/youtube.js";
import type { YouTubeHttpClient, YouTubeHttpResponse } from "./http.js";
import { asPublishTransportError, createHttpClient } from "./http.js";

// ── Sabitler ───────────────────────────────────────────────────────────────

/** Zorunlu scope'lar. `youtube.force-ssl` olmadan `videos.update` çalışmaz. */
export const YOUTUBE_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

/**
 * `snippet.categoryId` — 27 = Entertainment.
 *
 * GEREKÇE: uygulama dikey (9:16) kısa reklam/klip içeriği yayınlıyor.
 * YouTube'un reklam uygunluğu denetimi bir politika motorudur, kategori
 * numarası reklam uygunluğunu BELİRLEMEZ; yalnızca videonun hangi içerik
 * türü kutusunda ve hangi otomatik etiketleme kümesinde ele alınacağını
 * etkiler. "27 (Entertainment)" genel içerik için nötr bir varsayılandır.
 *
 * DEĞİŞTİRİLEBİLİR Mİ? Evet — `startPublish` seçeneğiyle. Sabit bir değer
 * "her kanal için doğru" değildir; bir sağlık kanalı 24 (Health & Fitness),
 * bir eğitim kanalı 27 değil 26 (Education) ister. Varsayılan seçilir,
 * tahmin olduğu dosyada ve `NOTES.md`'de yazılıdır.
 */
export const YOUTUBE_CATEGORY_ID = "27";

/** `snippet.defaultLanguage` — bu uygulamanın içerik dili. */
export const YOUTUBE_DEFAULT_LANGUAGE = "tr";

/** YouTube video kimliği oluşana kadar `StartResult.externalId` alanında taşınan değerin öneki. */
export const YOUTUBE_PENDING_PREFIX = "pending:";

/** `videos.insert` resumable uç noktası. */
export const YOUTUBE_UPLOAD_ENDPOINT = `${YOUTUBE_API}/videos`;

/** `part=snippet,status` — gönderdiğimiz iki part. */
export const YOUTUBE_UPLOAD_PARTS = "snippet,status";

/** `videos.insert` sorgu dizesi. */
export const YOUTUBE_UPLOAD_QUERY = `uploadType=resumable&part=${YOUTUBE_UPLOAD_PARTS}`;

/** Kalıcı yayın adresi. */
export const YOUTUBE_PERMALINK_BASE = "https://youtu.be";

/**
 * Resumable oturumun tahmini ömrü. YouTube SÜREYİ YAZMAZ; 1 saat güvenli tavan. */
export const YOUTUBE_UPLOAD_SESSION_TTL_SEC = 3_600;

/**
 * Bayt gönderme isteği için zaman aşımı: **30 dakika**.
 *
 * Gerekçe: `http.ts` istemcisinin varsayılanı 30 saniyedir ve bu bir
 * METADATA isteği içindir. Resumable `PUT` gövdesi 2 GB'a kadar olabilir;
 * 30 saniyede kesilen bir yükleme, sunucuda alınmış baytları bilinmeyen bir
 * noktada bırakır ve motor sessizce yanlış yerden devam eder. 30 dakika
 * normal bir bant genişliğinde 2 GB'ı fazlasıyla kapsar; zaman aşımı yine de
 * VARDIR çünkü `AbortSignal.timeout` olmasa istek sonsuza kadar asılı kalır.
 */
export const YOUTUBE_UPLOAD_PUT_TIMEOUT_MS = 30 * 60_000;

/** Zamanlanmış yayın yoklama aralığı (1 dakika). */
export const YOUTUBE_SCHEDULE_POLL_MS = 60_000;

/** Yayınlanma işlemi sürerken yoklama aralığı (30 saniye). */
export const YOUTUBE_PROCESSING_POLL_MS = 30_000;

/** Oturum açık ama video kimliği henüz yok: yoklama aralığı (10 saniye). */
export const YOUTUBE_SESSION_POLL_MS = 10_000;

/**
 * `status` part'ının YAZILABİLİR alanları — hepsi.
 *
 * `videos.update` birleştirme kuralı buradan türer: bu listedeki alanların
 * HEPSİ gönderilmezse sunucu yok sayılanları siler. Liste resmî
 * `VideoStatus` yazılabilir alanlarından oluşur; `madeForKids` yalnızca OKUNUR
 * (hesap düzeyinde) ve bu yüzden listede yoktur.
 */
export const YOUTUBE_STATUS_WRITABLE_FIELDS: readonly string[] = [
  "privacyStatus",
  "license",
  "embeddable",
  "publicStatsViewable",
  "selfDeclaredMadeForKids",
  "containsSyntheticMedia",
];

/** Sunucu `status` alanını vermezse kullanılacak BELİRLENMİŞ varsayılanlar. */
export const YOUTUBE_STATUS_DEFAULTS: Readonly<Record<string, unknown>> = {
  license: "youtube",
  embeddable: true,
  publicStatsViewable: true,
  selfDeclaredMadeForKids: false,
  containsSyntheticMedia: false,
};

/** "Video hâlâ private" durumunda kullanıcıya gösterilecek açıklama. */
export const UNVERIFIED_PROJECT_MESSAGE =
  "Video yüklenmiş ama `private`a kilitlenmiş. YouTube, API üzerinden " +
  "yüklenen videoları doğrulanmamış (unverified) projelerde `private` " +
  "olarak saklar. Yayınlamak için kanalın API erişimi olan bir projeye " +
  "taşınması ve YouTube Studio'dan doğrulama/compliance audit başlatılması gerekir.";

export type YouTubePrivacyStatus = "public" | "unlisted" | "private";

// ── Gövde kurucuları (saf; testler doğrudan bunları doğrular) ──────────────

export interface YouTubeSnippetInput {
  title: string;
  description: string;
  tags: readonly string[];
  categoryId?: string;
  defaultLanguage?: string;
}

export interface YouTubeStatusInput {
  privacyStatus: YouTubePrivacyStatus;
  selfDeclaredMadeForKids: boolean;
  containsSyntheticMedia: boolean;
  /** Zamanlanmış yayın; `undefined` ise `publishAt` ANAHTARI GÖNDERİLMEZ. */
  publishAt?: string | null;
}

/** `publishAt` yalnız zamanlanmış yayında gönderilir; `null` gönderilmez. */
export function buildVideoResource(
  snippet: YouTubeSnippetInput,
  status: YouTubeStatusInput,
): { snippet: Record<string, unknown>; status: Record<string, unknown> } {
  const snippetOut: Record<string, unknown> = {
    title: snippet.title,
    description: snippet.description,
    tags: [...snippet.tags],
    categoryId: snippet.categoryId ?? YOUTUBE_CATEGORY_ID,
    defaultLanguage: snippet.defaultLanguage ?? YOUTUBE_DEFAULT_LANGUAGE,
  };
  const statusOut: Record<string, unknown> = {
    privacyStatus: status.privacyStatus,
    selfDeclaredMadeForKids: status.selfDeclaredMadeForKids,
    containsSyntheticMedia: status.containsSyntheticMedia,
  };
  if (typeof status.publishAt === "string" && status.publishAt !== "") {
    statusOut["publishAt"] = status.publishAt;
  }
  return { snippet: snippetOut, status: statusOut };
}

/**
 * Başlığı 100 karaktere SİĞDIRIR ve `#Shorts` etiketini KORUR.
 *
 * Kırpma sırasında `#Shorts` düşerse Shorts sınıflandırması bozulur (etiket
 * açıklamada da olabilir, ama başlıkta olması en görünür yerdir). Bu yüzden
 * etiket için yer ayrılır; etiket yoksa normal kırpma yapılır.
 */
export function fitTitle(raw: string | null | undefined, madeForShorts: boolean): string {
  const composed = composeTitle(raw, madeForShorts).trim();
  if (composed.length <= YOUTUBE_TITLE_MAX_CHARS) return composed;
  const tag = madeForShorts ? ` ${SHORTS_TAG}` : "";
  const room = Math.max(1, YOUTUBE_TITLE_MAX_CHARS - tag.length);
  return `${composed.slice(0, room).trimEnd()}${tag}`;
}

/** Açıklamayı 5000 karaktere sığdırır; `#Shorts` bölümü yine korunur. */
export function fitDescription(
  caption: string | null | undefined,
  hashtags: readonly string[] | null | undefined,
  tags: readonly string[] | null | undefined,
  madeForShorts: boolean,
): string {
  const composed = composeDescription(caption, hashtags, tags, madeForShorts);
  if (composed.length <= YOUTUBE_DESCRIPTION_MAX_CHARS) return composed;
  const tag = madeForShorts ? `\n\n${SHORTS_TAG}` : "";
  const room = Math.max(1, YOUTUBE_DESCRIPTION_MAX_CHARS - tag.length);
  return `${composed.slice(0, room).trimEnd()}${tag}`;
}

/** `null`/boş olmayan başlık var mı? */
export function hasTitle(raw: string | null | undefined): boolean {
  return typeof raw === "string" && raw.trim().length > 0;
}

/** `idempotencyKey` → henüz video id'si olmayan geçici `externalId`. */
export function pendingExternalId(idempotencyKey: string): string {
  return `${YOUTUBE_PENDING_PREFIX}${idempotencyKey}`;
}

export function isPendingExternalId(externalId: string | null | undefined): boolean {
  return typeof externalId === "string" && externalId.startsWith(YOUTUBE_PENDING_PREFIX);
}

export function youtubePermalink(videoId: string): string {
  return `${YOUTUBE_PERMALINK_BASE}/${videoId}`;
}

/** `X-Upload-Content-Type`: medya `video/*` bildirmiyorsa mp4 varsayılır. */
export function uploadContentType(media: MediaRef): string {
  return typeof media.mimeType === "string" && /^video\//i.test(media.mimeType)
    ? media.mimeType
    : "video/mp4";
}

// ── Google hata gövdesi ayrıştırma ─────────────────────────────────────────

export interface GoogleErrorInfo {
  /** `error.errors[].reason` — İÇ İÇE GEÇMİŞ olabilir, özyinelemeli aranır. */
  reason: string | null;
  /** İnsan okunur mesaj (gövdeden). */
  message: string | null;
  /** `error.status` ("PERMISSION_DDENIED" gibi) — tanı için ipucu. */
  status: string | null;
  /** Gövde ham hâli (kırpılmış) — tanımlanmadıysa kullanıcıya gösterilir. */
  raw: string;
}

const MAX_SCAN_DEPTH = 12;

/**
 * Ağacın İÇİNDE ilk `key` alanına sahip metni bulur.
 *
 * NEDEN: Google hata gövdesi şeması sabit DEĞİLDİR. `error.errors[].reason`
 * çoğunlukla düzdür ama `error.details[]`, `error.errors[].extensions` gibi
 * yuvalarda da görünür. Yalnız `error.errors[0].reason` okumak sessizce
 * `null` döner ve hata "tanınmıyor" (kalıcı) sayılır — yani gerçek geçici
 * bir hata kalıcıya düşer. Derinlik sınırlıdır: bir döngü/patlama
 * ihtimaline karşı tarama durdurulur.
 */
export function findFirstStringField(node: unknown, key: string, depth = 0): string | null {
  if (depth > MAX_SCAN_DEPTH) return null;
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirstStringField(item, key, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string" && direct.trim() !== "") return direct;
  for (const value of Object.values(record)) {
    const found = findFirstStringField(value, key, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** Hata gövdesinden `reason` / `message` / `status` çıkarır. Bozuk gövde `null` verir. */
export function parseGoogleError(response: YouTubeHttpResponse): GoogleErrorInfo {
  const json = response.json;
  return {
    reason: findFirstStringField(json, "reason"),
    message: findFirstStringField(json, "message"),
    status: findFirstStringField(json, "status"),
    raw: response.body.slice(0, 500),
  };
}

/**
 * HTTP hatasını yayın hatasına çevirir.
 *
 * ÖNCELİK SIRASI:
 *  1. `reason` varsa → `mapYouTubeReason(reason)`. Tabloda olmayan kod
 *     `unknown` + KALICI olur (tahmin yok).
 *  2. `reason` yoksa → HTTP DURUMU. Bu bir kod tahmini DEĞİLDİR; taşıma
 *     katmanının bize verdiği kesin bir olgudur (429, 5xx, 401, 403, 404,
 *     409). Bu bandın DIŞINDAKİ her durum `unknown` + kalıcıdır.
 *
 * Bu ayrımın sebebi: `reason` yoksa geçici saymak, geçici olmayan bir hatayı
 * sonsuza kadar yeniden denemek demektir. Buna karşılık 5xx'i kalıcı saymak
 * da doğru değildir — API dokümanı 5xx için "geri çekil, durum sorgula" der.
 */
export function classifyHttpFailure(
  response: YouTubeHttpResponse,
  what: string,
): PermanentPublishError | RetryablePublishError {
  const info = parseGoogleError(response);
  const status = response.status;
  const detail = info.message ?? (info.raw !== "" ? info.raw : "(gövde boş)");
  const base = `${what} — HTTP ${status}${info.reason ? ` (${info.reason})` : ""}: ${detail}`;

  if (info.reason !== null) {
    const mapping: ProviderErrorMapping = mapYouTubeReason(info.reason);
    const message = withProviderNote(base, mapping, status);
    if (mapping.retryable) {
      return new RetryablePublishError(
        message,
        mapping.kind as Extract<PublishErrorKind, "network" | "ratelimit" | "server" | "transient">,
        response.retryAfterMs,
        mapping.providerCode || info.reason,
        info.status,
        status,
      );
    }
    return new PermanentPublishError(message, mapping.kind, mapping.providerCode || info.reason, info.status, status);
  }

  if (status === 429) {
    return new RetryablePublishError(`${base}`, "ratelimit", response.retryAfterMs, "rateLimitExceeded", info.status, status);
  }
  if (status >= 500) {
    return new RetryablePublishError(`${base}`, "server", response.retryAfterMs, null, info.status, status);
  }
  if (status === 401) {
    return new PermanentPublishError(`${base}`, "auth", "unauthorized", info.status, status);
  }
  if (status === 403) {
    return new PermanentPublishError(`${base}`, "policy", "forbidden", info.status, status);
  }
  if (status === 404 || status === 410) {
    return new PermanentPublishError(
      `${base}. Resumable oturumun ömrü sınırlıdır ve bu oturum artık kabul edilmiyor: ` +
        "yükleme BAŞTAN başlatılmalıdır (aynı oturuma dönmek işe yaramaz).",
      "container_expired",
      "session_expired",
      info.status,
      status,
    );
  }
  if (status === 409) {
    // Bayt atlama/çakışma: YouTube HİÇBİR ŞEY yüklemez ve sessiz kalır.
    return new PermanentPublishError(
      `${base}. Bayt aralığı çakıştı; YouTube bu durumda hiçbir şey yüklemez ` +
        `(sessiz hata). Oturum baştan açılmalı.`,
      "validation",
      "range_conflict",
      info.status,
      status,
    );
  }
  // Bilgi taşımayan durum → tahmin yok, kalıcı.
  return new PermanentPublishError(`${base}. Tanımlanmayan durum; kalıcı kabul edildi.`, "unknown", null, info.status, status);
}

/** `youtubeSignupRequired` gibi politikalı kodlara kullanıcı aksiyonu ekler. */
function withProviderNote(base: string, mapping: ProviderErrorMapping, status: number): string {
  if (mapping.providerCode === "youtubeSignupRequired" || (status === 403 && mapping.kind === "policy")) {
    return `${base} — ${mapping.message} ${UNVERIFIED_PROJECT_MESSAGE}`;
  }
  return `${base} — ${mapping.message}`;
}

// ── Video durumu okuma ─────────────────────────────────────────────────────

export interface YouTubeVideoView {
  id: string;
  privacyStatus: string | null;
  publishAt: string | null;
  /** `status.uploadStatus`: uploaded / processed / failed / rejected. */
  uploadStatus: string | null;
}

/**
 * Video kaynağını okur. İKİ GÖVDE BİÇİMİ vardır:
 *   - `videos.list` / `videos.get`: `{ items: [ {...} ] }`
 *   - `videos.insert` / resumable `PUT` 201 yanıtı: `{ id, status, snippet }` (düz)
 * İkisi de karşılanır; ayrım "items dizisi var mı" ile yapılır.
 * Hiçbirinde video yoksa `null`.
 */
export function readVideoView(json: unknown): YouTubeVideoView | null {
  if (json === null || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const items = root["items"];
  let record: Record<string, unknown> | null = null;
  if (Array.isArray(items)) {
    const first = items[0];
    record = first !== null && typeof first === "object" ? (first as Record<string, unknown>) : null;
  } else if (typeof root["id"] === "string") {
    // Düz video kaynağı (201 Created yanıtı).
    record = root;
  }
  if (record === null) return null;
  const id = typeof record["id"] === "string" ? record["id"] : null;
  if (id === null || id === "") return null;
  const status =
    record["status"] !== null && typeof record["status"] === "object"
      ? (record["status"] as Record<string, unknown>)
      : {};
  return {
    id,
    privacyStatus: typeof status["privacyStatus"] === "string" ? status["privacyStatus"] : null,
    publishAt: typeof status["publishAt"] === "string" ? status["publishAt"] : null,
    uploadStatus: typeof status["uploadStatus"] === "string" ? status["uploadStatus"] : null,
  };
}

function toFailureLite(
  kind: PublishErrorKind,
  message: string,
  providerCode: string | null = null,
  httpStatus: number | null = null,
): PublishFailureLite {
  return { kind, message, providerCode, logId: null, httpStatus };
}

// ── Günlük çağrı sayacı ────────────────────────────────────────────────────

/**
 * `videos.insert` günlük 100 ÇAĞRI kovasını SAYAN sayaç.
 *
 * DÜRÜSTLÜK: bu Google'ın kotASINI DEĞİL, BİZİM gönderdiğimiz istek sayısını
 * tutar. Google kotanın kalanını okuyan bir uç nokta SUNMAZ; dolayısıyla
 * sayacı "kota" diye sunmak yanlış olur. `readQuota` bu yüzden dönerken
 * "bu bizim ölçümümüz" notunu taşır ve kararı çağıran yapar.
 */
class DailyCallCounter {
  private readonly entries = new Map<string, string>();

  constructor(
    private readonly now: () => number,
    private readonly limit: number,
  ) {}

  /** Aynı `idempotencyKey` gün içinde iki kez SAYILMAZ. */
  record(accountExternalId: string, idempotencyKey: string): void {
    const key = `${accountExternalId}|${idempotencyKey}`;
    this.entries.set(key, this.utcDay());
  }

  used(accountExternalId: string): number {
    const day = this.utcDay();
    let count = 0;
    for (const [key, day0] of this.entries) {
      if (day0 === day && key.startsWith(`${accountExternalId}|`)) count += 1;
    }
    return count;
  }

  total(): number {
    return this.limit;
  }

  /** Bugünün kalanı (saniye). Pencerenin sonu UTC gece yarısıdır. */
  windowSec(): number {
    const nowMs = this.now();
    const dayMs = 86_400_000;
    return Math.max(0, Math.ceil((dayMs - (nowMs % dayMs)) / 1000));
  }

  private utcDay(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }
}

// ── Adaptör ────────────────────────────────────────────────────────────────

export interface YouTubeSession {
  uploadUrl: string;
  expiresAt: string;
  mediaKey: string;
  /**
   * `uploadParts` 201 Created aldığında YouTube'un verdiği video kimliği.
   *
   * NEDEN GEREKLİ: `startPublish` `externalId` olarak `pending:<key>` döner,
   * çünkü kimlik ancak `PUT` SONUNDA oluşur. `pollPublish` `pending:` görünce
   * `videos.list` YAPAMAZ (kimlik henüz yoktur) ve "oturum hâlâ açık" deyip
   * sonsuza kadar döner. Kimlik burada saklanır; yoklama onu kullanır.
   */
  videoId: string | null;
}

export interface YouTubeAdapterOptions {
  /** Zaman kaynağı. **Varsayılanı YOKTUR** (saat test edilemez hale gelmesin). */
  now: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** `videos.insert` gövdesindeki `snippet.categoryId`. */
  categoryId?: string;
  /** `videos.insert` için tek seferlik istek zaman aşımı. */
  startTimeoutMs?: number;
  /** Resumable `PUT` (bayt gönderme) zaman aşımı. Varsayılan 30 dakika. */
  uploadTimeoutMs?: number;
  /**
   * Baytları NEREDEN okuyacağı. Motor `uploadParts`'ı çağırır; baytlar
   * `PublishInput.media` üzerinden gelmez, dosyadan okunmalıdır.
   *
   * Verilmezse `MediaRef.storageKey` DEPO İÇİ bir anahtardır ve mutlak yol
   * değildir; bu yüzden `uploadParts` "okuyucu yok" diye KALICI hata verir.
   * Üretimde `MediaStore` üzerinden bir okuyucu geçilmelidir.
   */
  readMedia?: (media: MediaRef) => Promise<Uint8Array>;
}

export interface YouTubeCounters {
  precheck: number;
  start: number;
  poll: number;
  finalize: number;
  quota: number;
  get: number;
  update: number;
  thumbnail: number;
  upload: number;
}

export interface YouTubeStatusChange {
  privacyStatus?: YouTubePrivacyStatus;
  publishAt?: string | null;
  selfDeclaredMadeForKids?: boolean;
  containsSyntheticMedia?: boolean;
  license?: string;
  embeddable?: boolean;
  publicStatsViewable?: boolean;
}

export interface YouTubeSnippetChange {
  title?: string;
  description?: string;
  tags?: readonly string[];
  categoryId?: string;
  defaultLanguage?: string;
}

export interface YouTubeUpdateOutcome {
  videoId: string;
  /** Sunucuya GİDEREK gönderilen gövde — testler bunu kanıtlar. */
  sent: Record<string, unknown>;
  /** Hangi part gönderildi: "status" veya "snippet,status". */
  part: string;
  /** `videos.get` okumasının maliyeti (kota birimi). */
  readQuotaUnits: number;
  /** `videos.update` maliyeti (kota birimi). */
  writeQuotaUnits: number;
}

export interface YouTubeUploadOutcome {
  uploaded: boolean;
  /** 308 sonrası kabul edilen bayt sayısı. */
  receivedBytes: number;
  videoId: string | null;
  permalink: string | null;
  privacyStatus: string | null;
  publishAt: string | null;
}

export class YouTubePublishAdapter implements PublishAdapter {
  readonly platform: Platform = "youtube";
  readonly spec: PlatformSpec = getSpec("youtube");

  private readonly now: () => number;
  private readonly client: YouTubeHttpClient;
  private readonly categoryId: string;
  private readonly startTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly readMedia: ((media: MediaRef) => Promise<Uint8Array>) | null;
  private readonly counter: DailyCallCounter;
  /** `idempotencyKey` → açılmış oturum. Mükerrer `startPublish` koruması. */
  private readonly sessions = new Map<string, YouTubeSession>();
  private readonly counts: YouTubeCounters = {
    precheck: 0,
    start: 0,
    poll: 0,
    finalize: 0,
    quota: 0,
    get: 0,
    update: 0,
    thumbnail: 0,
    upload: 0,
  };

  constructor(options: YouTubeAdapterOptions) {
    this.now = options.now;
    this.client = createHttpClient({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      now: options.now,
    });
    this.categoryId = options.categoryId ?? YOUTUBE_CATEGORY_ID;
    this.startTimeoutMs = options.startTimeoutMs ?? 30_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? YOUTUBE_UPLOAD_PUT_TIMEOUT_MS;
    this.readMedia = options.readMedia ?? null;
    this.counter = new DailyCallCounter(options.now, YOUTUBE_INSERT_DAILY_CALL_BUCKET);
  }

  /** Test kancası: sayaçları okur. */
  callCounts(): Readonly<YouTubeCounters> {
    return { ...this.counts };
  }

  /** Test kancası: açılmış oturumları okur. */
  session(idempotencyKey: string): YouTubeSession | null {
    const found = this.sessions.get(idempotencyKey);
    return found ? { ...found } : null;
  }

  // ── precheck ─────────────────────────────────────────────────────────────

  /**
   * Yayına gitmeden önceki son kontrol.
   *
   * Katman 1 — `validateMedia(media.info, getSpec("youtube"))`: ölçü, kapsayıcı,
   * kodek, süre, boyut kuralları. Bu katmanın ürettiği bulgular ASSET kaydında
   * da üretilir; aynı kuralların iki yerde farklı sertlikte olması, panelde
   * "uyarı" derken işin "hata" ile kapanması demektir. Bu yüzden SEVİYE
   * DÖNÜŞTÜRÜLMEZ.
   *
   * Katman 2 — YouTube'a özgü, başka hiçbir katmanın bilmediği kurallar:
   * başlık zorunluluğu, Shorts sınıflandırması, `publishAt` ön koşulu.
   */
  async precheck(input: PublishInput): Promise<ValidationFinding[]> {
    this.counts.precheck += 1;
    const findings: ValidationFinding[] = validateMedia(input.media.info, this.spec);
    const composedTitle = composeTitle(input.copy.title, input.copy.madeForShorts).trim();

    if (!hasTitle(input.copy.title)) {
      findings.push({
        code: "title_required",
        severity: "error",
        message:
          "YouTube'da başlık zorunludur (snippet.title). Başlık olmadan `videos.insert` " +
          "400 döner; yayın gönderilmez.",
        limit: String(YOUTUBE_TITLE_MAX_CHARS),
        observed: "(boş)",
      });
    } else if (composedTitle.length > YOUTUBE_TITLE_MAX_CHARS) {
      findings.push({
        code: "title_length",
        severity: "error",
        message:
          `Başlık ${composedTitle.length} karakter; YouTube sınırı ${YOUTUBE_TITLE_MAX_CHARS}. ` +
          (input.copy.madeForShorts
            ? `#${SHORTS_TAG} eklendiği için sınır daha da zorlanıyor.`
            : "Başlık kısaltılmalı."),
        limit: String(YOUTUBE_TITLE_MAX_CHARS),
        observed: String(composedTitle.length),
      });
    }

    const info = input.media.info;
    const width = info.width;
    const height = info.height;
    if (width !== null && height !== null && width > 0 && height > 0) {
      const square = width === height;
      if (!square && !isVertical(info)) {
        findings.push({
          code: "shorts_aspect",
          severity: "warning",
          message:
            `Yatay video (${width}x${height}) YouTube Shorts olarak SINIFLANDIRILMAZ; ` +
            "Shorts için kare ya da dikey (en-boy 9:16) olmalıdır. Video yine de " +
            "sıradan bir video olarak yayınlanır.",
          limit: "dikey veya kare",
          observed: `${width}x${height}`,
        });
      }
    }

    if (
      info.durationSec !== null &&
      info.durationSec > 180 &&
      input.copy.madeForShorts
    ) {
      findings.push({
        code: "shorts_duration",
        severity: "warning",
        message:
          `Süre ${info.durationSec.toFixed(1)} sn; Shorts sınırı 180 sn. Video Shorts ` +
          "sayılmaz. Ayrıca kanalda AKTİF bir Content ID iddiası (claim) varsa 3 " +
          "dakikayı aşan içerik global olarak engellenebilir (blok riski).",
        limit: "180",
        observed: info.durationSec.toFixed(1),
      });
    }

    const scheduledText = typeof input.scheduledAt === "string" ? input.scheduledAt : null;
    const scheduledMs = parseInstantMs(scheduledText);
    if (scheduledMs !== null && scheduledMs > this.now()) {
      findings.push({
        code: "schedule_publish_at",
        severity: "warning",
        message:
          `Zamanlanmış yayın \`status.publishAt\` ile yapılır. ${NATIVE_SCHEDULE_NOTE} ` +
          (input.copy.privacy === "public" || input.copy.privacy === "unlisted"
            ? ` Bu yüzden gönderilen privacyStatus "private" olacak ve ` +
              `"${input.copy.privacy}" tercihi geçersiz sayılacaktır.`
            : ""),
        limit: "private + daha önce hiç yayınlanmamış",
        observed: scheduledText ?? undefined,
      });
    }

    return findings;
  }

  // ── startPublish ─────────────────────────────────────────────────────────

  /**
   * Resumable oturumu açar ve `Location`'ı döndürür.
   *
   * MÜKERRER KORUMA: YouTube `videos.insert` gövdesinde resmî bir
   * idempotens alanı YOKTUR. Bu yüzden `idempotencyKey` `externalId` alanında
   * taşınır (`pending:<key>`) ve aynı anahtarla gelen ikinci çağrı YENİ OTURUM
   * AÇMAZ, ilk oturumu aynen döndürür. Anahtarın "aynı dosya" olduğu
   * `storageKey|bytes|mimeType` üçlüsüyle doğrulanır: FARKLI bir dosya aynı
   * anahtarla gelirse bu artık mükerrer değil, farklı bir iştir ve yeni
   * oturum açılır. Süresi dolmuş oturum da yenilenir (YouTube 404 döner).
   */
  async startPublish(input: PublishInput): Promise<StartResult> {
    this.counts.start += 1;
    const key = input.idempotencyKey;
    const mediaKey = mediaFingerprint(input.media);
    const externalId = pendingExternalId(key);

    const existing = this.sessions.get(key);
    if (existing && existing.mediaKey === mediaKey && !this.isExpired(existing.expiresAt)) {
      return {
        kind: "uploadUrl",
        externalId,
        uploadUrl: existing.uploadUrl,
        expiresAt: existing.expiresAt,
        state: "processing",
      };
    }

    if (!(input.media.bytes > 0)) {
      throw new PermanentPublishError(
        `Yükleme başlatılamaz: medya ${input.media.bytes} bayt. Boş dosya için oturum açmak ` +
          "sunucuda anlık reddedilir; yerinde kalıcı hata verilir.",
        "media_rejected",
        "empty_media",
      );
    }

    if (!hasTitle(input.copy.title)) {
      throw new PermanentPublishError(
        "Yayın başlatılamaz: YouTube başlığı zorunlu (snippet.title).",
        "validation",
        "title_required",
      );
    }

    const scheduledMs = parseInstantMs(input.scheduledAt);
    const publishAtMs = scheduledMs !== null && scheduledMs > this.now() ? scheduledMs : null;
    const privacyStatus: YouTubePrivacyStatus = publishAtMs === null ? input.copy.privacy : "private";
    const publishAt = publishAtMs === null ? undefined : new Date(publishAtMs).toISOString();

    const resource = buildVideoResource(
      {
        title: fitTitle(input.copy.title, input.copy.madeForShorts),
        description: fitDescription(
          input.copy.caption,
          input.copy.hashtags,
          input.copy.tags,
          input.copy.madeForShorts,
        ),
        tags: [...input.copy.tags],
        categoryId: this.categoryId,
      },
      {
        privacyStatus,
        selfDeclaredMadeForKids: input.copy.selfDeclaredMadeForKids,
        containsSyntheticMedia: input.copy.aiGenerated,
        publishAt,
      },
    );

    // Kota, istek GÖNDERİLDİĞİ anda sayılır: başarısızlıkta da tüketilmiş
    // olabilir ve bunu bilmiyoruz. Kötümser yönde saymak güvenlidir.
    this.counter.record(input.account.externalId, key);

    let response: YouTubeHttpResponse;
    try {
      response = await this.client.send({
        method: "POST",
        url: `${YOUTUBE_UPLOAD_ENDPOINT}?${YOUTUBE_UPLOAD_QUERY}`,
        headers: {
          authorization: `Bearer ${input.account.accessToken}`,
          "content-type": "application/json; charset=utf-8",
          "x-upload-content-length": String(input.media.bytes),
          "x-upload-content-type": uploadContentType(input.media),
        },
        body: JSON.stringify(resource),
        timeoutMs: this.startTimeoutMs,
      });
    } catch (err) {
      throw asPublishTransportError(err, "videos.insert oturumu açılamadı");
    }

    if (!response.ok) {
      throw classifyHttpFailure(response, "videos.insert oturumu açılamadı");
    }

    const location = response.headers["location"] ?? null;
    if (location === null || location === "") {
      // 200 geldi ama oturum adresi yok: protokol ihlali. Bayt gönderilmediği
      // için yeni oturum açmak güvenlidir → geçici sınıf.
      throw new RetryablePublishError(
        "videos.insert 200 döndü ama `Location` başlığı yok; oturum açılamadı. " +
          "Tekrar denenecek (bayt gönderilmediği için mükerrer yayın riski yoktur).",
        "transient",
        null,
        "missing_location",
        null,
        response.status,
      );
    }

    const expiresAt = new Date(this.now() + YOUTUBE_UPLOAD_SESSION_TTL_SEC * 1000).toISOString();
    this.sessions.set(key, { uploadUrl: location, expiresAt, mediaKey, videoId: null });

    return {
      kind: "uploadUrl",
      externalId,
      uploadUrl: location,
      expiresAt,
      state: "processing",
    };
  }

  // ── pollPublish ──────────────────────────────────────────────────────────

  /**
   * `pending:` externalId → video kimliği henüz yoktur, `videos.list` çağrısı
   * yapılamaz. Bu durumda oturumun ömrü kontrol edilir: dolduysa kalıcı hata
   * (`container_expired`), dolmadıysa "hâlâ yükleniyor" döner.
   *
   * GERÇEK VİDEO KİMLİĞİ → `videos.list` (1 kota birimi) ile durum okunur:
   *   - `public`/`unlisted` → `published` + `https://youtu.be/{id}`
   *   - `private` + `publishAt` GELECEKTE → `processing` (zamanlanmış)
   *   - `private` + `publishAt` GEÇMİŞTE → `processing` (yayınlanma sürüyor)
   *   - `private` + `publishAt` YOK → kalıcı politika/doğrulama hatası
   */
  async pollPublish(ctx: PollContext): Promise<PollResult> {
    this.counts.poll += 1;
    const externalId = ctx.externalId;
    if (typeof externalId !== "string" || externalId.trim() === "") {
      throw new PermanentPublishError(
        "YouTube yoklaması video kimliği olmadan yapılamaz (externalId boş). " +
          "Yükleme tamamlanmamış bir oturum yoklanamaz; kalıcı hata.",
        "validation",
        "unknown_external_id",
      );
    }

    if (isPendingExternalId(externalId)) {
      const expiresAt = ctx.uploadUrlExpiresAt;
      if (expiresAt !== null && this.isExpired(expiresAt)) {
        throw new PermanentPublishError(
          `Resumable oturum süresi doldu (${expiresAt}); YouTube bu oturumu artık kabul ` +
            "etmez. Yükleme BAŞTAN başlatılmalı (yeni oturum açılır).",
          "container_expired",
          "session_expired",
          null,
          null,
        );
      }
      // `uploadParts` 201 aldıysa gerçek video kimliği oturumda SAKLANMIŞTIR.
      // `pending:` öneki `startPublish` çıktısıdır ve kalıcı bir kimlik
      // DEĞİLDİR; `videos.list` onunla çağrılamaz. Kimlik biliniyorsa
      // YOKLAMA BURADA BİTER ve gerçek `videos.list` okumasına düşer.
      const key = externalId.slice(YOUTUBE_PENDING_PREFIX.length);
      const videoId = this.sessions.get(key)?.videoId ?? null;
      if (videoId === null) {
        return {
          state: assertReachable("processing"),
          retryAfterMs: YOUTUBE_SESSION_POLL_MS,
          providerStatus: "resumable_session_open",
        };
      }
      const uploaded = await this.getJson(
        ctx.account,
        `${YOUTUBE_API}/videos?part=id,status,snippet&id=${encodeURIComponent(videoId)}`,
        "videos.list (yükleme sonrası yoklama)",
      );
      const uploadedView = readVideoView(uploaded.json);
      if (uploadedView === null) {
        return {
          state: assertReachable("processing"),
          retryAfterMs: YOUTUBE_PROCESSING_POLL_MS,
          providerStatus: "video_not_visible_yet",
          error: null,
        };
      }
      return this.interpretVideo(uploadedView, { ...ctx, externalId: uploadedView.id });
    }

    const response = await this.getJson(
      ctx.account,
      `${YOUTUBE_API}/videos?part=id,status,snippet&id=${encodeURIComponent(externalId)}`,
      "videos.list (yoklama)",
    );
    const view = readVideoView(response.json);
    if (view === null) {
      return {
        state: assertReachable("processing"),
        retryAfterMs: YOUTUBE_PROCESSING_POLL_MS,
        providerStatus: "video_not_visible_yet",
        error: null,
      };
    }
    return this.interpretVideo(view, ctx);
  }

  /** `status.uploadStatus` + `privacyStatus` → `PollResult`. */
  private interpretVideo(view: YouTubeVideoView, ctx: PollContext): PollResult {
    if (view.uploadStatus === "failed" || view.uploadStatus === "rejected") {
      return {
        state: assertReachable("processing"),
        remoteId: view.id,
        permalink: null,
        providerStatus: view.uploadStatus,
        error: toFailureLite(
          "media_rejected",
          `YouTube yüklemeyi reddetti (uploadStatus=${view.uploadStatus}). Dosya veya ` +
            "beyanlar kabul edilmedi; aynı dosyayla tekrar denemek aynı sonucu verir.",
          view.uploadStatus,
          null,
        ),
      };
    }

    if (view.privacyStatus === "public" || view.privacyStatus === "unlisted") {
      return {
        state: assertReachable("published"),
        remoteId: view.id,
        permalink: youtubePermalink(view.id),
        providerStatus: view.privacyStatus,
      };
    }

    if (view.privacyStatus === "private") {
      const publishMs = parseInstantMs(view.publishAt);
      if (publishMs !== null && publishMs > this.now()) {
        return {
          state: assertReachable("processing"),
          remoteId: view.id,
          providerStatus: "private_scheduled",
          retryAfterMs: YOUTUBE_SCHEDULE_POLL_MS,
        };
      }
      if (publishMs !== null) {
        return {
          state: assertReachable("processing"),
          remoteId: view.id,
          providerStatus: "private_publishing",
          retryAfterMs: YOUTUBE_PROCESSING_POLL_MS,
        };
      }
      // private + publishAt YOK.
      if (ctx.scheduledAt !== null) {
        return {
          state: assertReachable("processing"),
          remoteId: view.id,
          providerStatus: "private_no_publish_at",
          retryAfterMs: YOUTUBE_SCHEDULE_POLL_MS,
          error: toFailureLite(
            "validation",
            `Zamanlanmış yayın istenmişti (\`${ctx.scheduledAt}\`) ama video private ve ` +
              "`publishAt` YOK. YouTube `publishAt`'ı yalnız `privacyStatus=private` " +
              "ile birlikte ve video daha önce hiç yayınlanmamışken kabul eder; koşul " +
              "sağlanmadıysa yayın anı sessizce kaymış olur.",
            "invalidPublishAtTime",
          ),
        };
      }
      return {
        state: assertReachable("processing"),
        remoteId: view.id,
        providerStatus: "private_unverified",
        retryAfterMs: YOUTUBE_PROCESSING_POLL_MS,
        error: toFailureLite("policy", UNVERIFIED_PROJECT_MESSAGE, "private_unverified"),
      };
    }

    return {
      state: assertReachable("processing"),
      remoteId: view.id,
      providerStatus: view.privacyStatus ?? "unknown_privacy",
      retryAfterMs: YOUTUBE_PROCESSING_POLL_MS,
      error: toFailureLite(
        "unknown",
        `YouTube privacyStatus okunamadı (uploadStatus=${view.uploadStatus ?? "bilinmiyor"}). ` +
          "Kalıcı kabul edildi; tanımsız durumda geçici sayılmaz.",
        null,
      ),
    };
  }

  // ── finalize ─────────────────────────────────────────────────────────────

  /**
   * `finalize` AĞ ÇAĞRISI YAPMAZ — özellikle `thumbnails.set` ÇAĞIRMAZ.
   *
   * GEREKÇE (kotanın bu paketteki en pahalı kararı):
   *  1. `thumbnails.set` 50 KOTA BİRİMİ harcar. `videos.insert` 1 birim,
   *     yani tek bir kapak 50 yayının maliyetidir. 100 çağrılık günlük kova
   *     bir kapakla iki kere tükenir.
   *  2. YouTube kendi kare seçimini (kısa videolarda en temiz kareyi) yapar;
   *     hazır bir kapak vermek çoğu klibin sonucunu KÖTÜLEŞTİRİR.
   *  3. Shorts'ta kapak görseli hiç gösterilmez — video yalnız tam ekran
   *     oynatılır. Yatay olmayan her içerik için bu çağrı boşa 50 birimdir.
   *
   * Kapak yine de gerekirse `setThumbnail()` AÇIKÇA çağrılabilir; bu bir
   * ürün kararıdır ve kotanın hesabıyla birlikte yapılır.
   */
  async finalize(_input: PublishInput, _result: PollResult): Promise<void> {
    this.counts.finalize += 1;
    // Ağ çağrısı yok. `thumbnails.set` bilinçli olarak çağrılmaz (yukarıda).
  }

  // ── readQuota ────────────────────────────────────────────────────────────

  /**
   * Günlük 100 çağrılık `videos.insert` kovasını SAYAR.
   *
   * DÜRÜST SINIR: Google kotanın kalanını okuyan bir uç nokta SUNMAZ
   * (`myRating`/`playlistItems` gerektirir ve o da kotadır). Dönen değer
   * "Google kotanın ne kadarı kaldı" DEĞİL, "biz bu süreçte kaç `videos.insert`
   * gönderdik" tir. `used === 0` iken `null` döner: sıfırı "hiç kullanılmadı"
   * diye sunmak, başka süreçlerden ve YouTube Studio'dan yapılan yüklemeleri
   * gizlerdi.
   *
   * Kararı çağıran verir: `used >= total` ise yayını ertelemesi mantıklıdır.
   */
  async readQuota(account: AccountRef): Promise<QuotaSnapshot | null> {
    this.counts.quota += 1;
    const used = this.counter.used(account.externalId);
    if (used === 0) return null;
    return { used, total: this.counter.total(), windowSec: this.counter.windowSec() };
  }

  // ── videos.update (YIKICI BİRLEŞTİRME) ──────────────────────────────────

  /**
   * `videos.update` çağrısı. **ÖNCE OKUR, SONRA BİRLEŞTİRİR, SONRA GÖNDERİR.**
   *
   * Adımlar:
   *  1. `videos.get(part=id,snippet,status)` — 1 kota birimi. Bu adım
   *     atlanırsa yazılabilir alanların hepsi silinir.
   *  2. `status` part'ının TÜM yazılabilir alanları mevcut değerlerle
   *     doldurulur (`YOUTUBE_STATUS_DEFAULTS` yalnız sunucu alanı vermediyse
   *     kullanılır).
   *  3. `change` alanları üzerine yazılır.
   *  4. `snippet` alanı isteniyorsa `part=snippet,status` kullanılır ve
   *     `categoryId` ZORUNLU olduğu için doldurulur.
   */
  async updateStatus(
    input: { account: AccountRef; videoId: string },
    change: YouTubeStatusChange = {},
    snippetChange: YouTubeSnippetChange = {},
  ): Promise<YouTubeUpdateOutcome> {
    const current = await this.getJson(
      input.account,
      `${YOUTUBE_API}/videos?part=id,status,snippet&id=${encodeURIComponent(input.videoId)}`,
      "videos.get (updateStatus okuması)",
    );
    const view = readVideoView(current.json);
    if (view === null) {
      throw new PermanentPublishError(
        `videos.get video döndürmedi (id=${input.videoId}). Mükerrer okuma yapılamadan ` +
          "`videos.update` gönderilmez: gönderilseydi yazılabilir alanlar silinirdi.",
        "validation",
        "video_not_found",
      );
    }

    const remoteStatus = remoteStatusOf(current.json);
    const mergedStatus: Record<string, unknown> = {};
    for (const field of YOUTUBE_STATUS_WRITABLE_FIELDS) {
      const existing = remoteStatus[field];
      mergedStatus[field] =
        existing === undefined || existing === null
          ? YOUTUBE_STATUS_DEFAULTS[field]
          : existing;
    }
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) continue;
      if (key === "publishAt" && value === null) {
        delete mergedStatus["publishAt"];
        continue;
      }
      mergedStatus[key] = value;
    }

    const body: Record<string, unknown> = {};
    const snippetKeys = Object.keys(snippetChange).filter((k) => snippetChange[k as keyof YouTubeSnippetChange] !== undefined);
    if (snippetKeys.length > 0) {
      const remote = remoteSnippetOf(current.json);
      body["snippet"] = {
        title: snippetChange.title ?? remote["title"] ?? "",
        description: snippetChange.description ?? remote["description"] ?? "",
        tags: snippetChange.tags !== undefined ? [...snippetChange.tags] : (remote["tags"] ?? []),
        // `snippet` güncelleniyorsa `categoryId` ZORUNLUDUR → 400 olmasın.
        categoryId: snippetChange.categoryId ?? remote["categoryId"] ?? this.categoryId,
        defaultLanguage:
          snippetChange.defaultLanguage ?? remote["defaultLanguage"] ?? YOUTUBE_DEFAULT_LANGUAGE,
      };
    }
    body["status"] = mergedStatus;
    const part = body["snippet"] === undefined ? "status" : "snippet,status";

    this.counts.update += 1;
    let response: YouTubeHttpResponse;
    try {
      response = await this.client.send({
        method: "PUT",
        url: `${YOUTUBE_UPLOAD_ENDPOINT}?part=${encodeURIComponent(part)}&id=${encodeURIComponent(input.videoId)}`,
        headers: {
          authorization: `Bearer ${input.account.accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw asPublishTransportError(err, "videos.update gönderilemedi");
    }
    if (!response.ok) {
      throw classifyHttpFailure(response, "videos.update başarısız");
    }
    return {
      videoId: view.id,
      sent: body,
      part,
      readQuotaUnits: 1,
      writeQuotaUnits: YOUTUBE_QUOTA_UNITS.update,
    };
  }

  /**
   * KAPAK GÖNDERME — varsayılan KAPALI, `finalize` çağırmaz.
   * Maliyet 50 kota birimi; çağırmak bilinçli bir ürün kararıdır.
   */
  async setThumbnail(
    input: { account: AccountRef; videoId: string; bytes: Uint8Array; contentType?: "image/jpeg" | "image/png" },
  ): Promise<{ videoId: string; bytes: number }> {
    this.counts.thumbnail += 1;
    if (!(input.bytes.length > 0)) {
      throw new PermanentPublishError(
        "Kapak gönderilemez: 0 bayt. Boş kapak, YouTube'nin kendi kare seçimini " +
          "45 kota birimine mal olur ve hiçbir şey kazandırmaz.",
        "media_rejected",
        "empty_thumbnail",
      );
    }
    const response = await this.sendBinary(
      input.account,
      "POST",
      `${YOUTUBE_API}/thumbnails/set?videoId=${encodeURIComponent(input.videoId)}`,
      input.bytes,
      input.contentType ?? "image/jpeg",
      "thumbnails.set",
    );
    return { videoId: input.videoId, bytes: input.bytes.length };
  }

  // ── Resumable yükleme (tek PUT) ──────────────────────────────────────────

  /**
   * Baytları oturuma GÖNDERİR. YouTube tek `PUT` önerir; 256 KB katı parçaya
   * bölmek (YOUTUBE_RESUMABLE_CHUNK_BYTES) varsayılan DEĞİLDİR, çünkü
   * parçalamak hem hata yüzeyini büyütür hem de gereksiz `Content-Range`
   * hesabı getirir.
   *
   * 308 = "kabul edilen baytlar", HATA DEĞİLDİR; `{ uploaded: false,
   * receivedBytes }` döner. 404/410 = oturum SONA ERMİŞTİR, kalıcı hata
   * (baştan başla). 409 = bayt aralığı çakışıyor; YouTube hiçbir şey
   * yüklemez ve bu SESSİZ bir hatadır, bu yüzden kalıcı sayılır.
   */
  async uploadMedia(input: {
    account: AccountRef;
    sessionUri: string;
    bytes: Uint8Array;
    contentType?: string;
  }): Promise<YouTubeUploadOutcome> {
    this.counts.upload += 1;
    const total = input.bytes.length;
    if (!(total > 0)) {
      throw new PermanentPublishError(
        `Yükleme yapılamaz: 0 bayt gövde. Oturum açılmış olsa bile sunucu 400 döner.`,
        "media_rejected",
        "empty_body",
      );
    }
    let response: YouTubeHttpResponse;
    try {
      response = await this.client.send({
        method: "PUT",
        url: input.sessionUri,
        headers: {
          // YouTube: `Content-Length` ve `Content-Type` başlangıçtaki
          // `X-Upload-Content-*` ile AYNI olmalı.
          "content-length": String(total),
          "content-type": input.contentType ?? "video/mp4",
        },
        body: input.bytes,
        timeoutMs: 0,
      });
    } catch (err) {
      throw asPublishTransportError(err, "resumable PUT başarısız");
    }
    return this.readUploadResponse(response, total);
  }

  /**
   * Kesintide kaldığı baytı sorar: BOŞ `PUT` + `Content-Range: bytes *[slash]TOTAL`.
   * 308 + `Range` → kabul edilen bayt sayısı.
   *
   * NOT: `Content-Range` için TOPLAM bayt bilinmelidir. `PollContext` bu
   * bilgiyi taşımadığı için bu metot ayrıdır; çağıran `totalBytes`'ı bilir.
   */
  async probeUploadSession(
    input: { account: AccountRef; sessionUri: string; totalBytes: number },
  ): Promise<PollResult> {
    let response: YouTubeHttpResponse;
    try {
      response = await this.client.send({
        method: "PUT",
        url: input.sessionUri,
        headers: {
          "content-length": "0",
          "content-type": "video/mp4",
          "content-range": `bytes */${input.totalBytes}`,
        },
        body: new Uint8Array(0),
        timeoutMs: 0,
      });
    } catch (err) {
      throw asPublishTransportError(err, "resumable durum sorgusu başarısız");
    }
    if (response.status === 308) {
      return {
        state: assertReachable("processing"),
        retryAfterMs: YOUTUBE_SESSION_POLL_MS,
        providerStatus: "resumable_308",
      };
    }
    if (!response.ok) {
      throw classifyHttpFailure(response, "resumable oturum reddedildi");
    }
    const view = readVideoView(response.json);
    if (view === null) {
      return {
        state: assertReachable("processing"),
        retryAfterMs: YOUTUBE_SESSION_POLL_MS,
        providerStatus: "resumable_probe_unknown",
      };
    }
    return this.interpretVideo(view, {
      account: input.account,
      externalId: view.id,
      uploadUrl: input.sessionUri,
      uploadUrlExpiresAt: null,
      uploadedParts: 0,
      totalParts: null,
      scheduledAt: null,
    });
  }

  // ── uploadParts: motorun çağırdığı bayt gönderme adımı ───────────────────

  /**
   * Resumable oturuma baytları GÖNDERİR. `startPublish` yalnızca oturumu açar;
   * bu adım olmadan hiçbir bayt sunucuya ulaşmaz.
   *
   * ── TEK `PUT` KARARI (varsayılan) ──────────────────────────────────────────
   * YouTube resmî olarak TEK `PUT` önerir. Çok parçalı yüklemede her chunk
   * 256 KB'nin KATI olmak zorundadır; parçalamak hem `Content-Range`
   * hesabını hem de 409 (bayt çakışması → SESSİZ hiçbir şey yüklenmez)
   * riskini getirir. Bu yüzden `partSizeBytes` 0 geldiğinde (motorun yazdığı
   * normal değer) **tek `PUT` atılır**. Parçalamayı zorlamak isteyen bir çağıran
   * `partSizeBytes` verirse `Content-Range` ile devam edilir.
   *
   * ── `Content-Length` ve `Content-Type` ─────────────────────────────────────
   * YouTube, `PUT`'un `Content-Length`/`Content-Type` değerlerinin oturum
   * açılışındaki `X-Upload-Content-Length`/`X-Upload-Content-Type` ile AYNI
   * olmasını şart koşar. `Content-Length` burada `bytes.length`'tir: bayt
   * sayısı `media.bytes` KAYIT değerinden değil, GERÇEK gövdeden okunur
   * (transcode sonrası kayıt eskimiş olabilir; yanlış sayı 400 döner).
   *
   * ── DÜNEM KURALI (asıl kural) ─────────────────────────────────────────────
   * `uploadedParts` YALNIZCA 2xx/201 CEVABI ALINDIKTAN SONRA artar. Zaman aşımı
   * ya da ağ hatası `RetryablePublishError` fırlatır ve motor ilerlemeyi
   * GÜNCELLEMEZ. "Gönderdim sanıp" işaretlemek, sunucu aslında baytı almamışsa
   * sonraki denemede bayt ATLATIR ve sessizce 416 alır — yani video hiç
   * tamamlanmaz ama motor "ilerliyor" sanır.
   *
   * 308 HATA DEĞİLDİR: sunucu baytları ALDI, işlem sürüyor demektir.
   * `Range: bytes=0-N` başlığı kaldığın ofseti verir.
   */
  async uploadParts(input: PublishInput, session: UploadSession): Promise<UploadProgress> {
    this.counts.upload += 1;

    if (this.readMedia === null) {
      // Okuyucu yoksa bayt gönderilemez. `PermanentPublishError` DEĞİL:
      // bu bir SAĞLAYICI hatası değil, bizim montaj eksiğimizdir ve motor
      // `unknown` + kalıcı üretecekti. `validation` daha dürüst bir sınıftır
      // ve kullanıcıya ne yapılacağını söyler.
      throw new PermanentPublishError(
        "YouTube bayt gönderemiyor: `readMedia` okuyucusu tanımlı değil. " +
          "Resumable yükleme medyayı depodan okumak zorundadır; `storageKey` " +
          "depo içi bir anahtardır ve tek başına okunamaz.",
        "validation",
        "no_media_reader",
      );
    }

    const bytes = await this.readMedia(input.media);
    const total = bytes.length;
    if (!(total > 0)) {
      throw new PermanentPublishError(
        `Yükleme yapılamaz: ${input.media.storageKey} okundu ama 0 bayt. ` +
          "Oturum açılmış olsa bile sunucu 400 döner.",
        "media_rejected",
        "empty_body",
      );
    }

    const contentType = uploadContentType(input.media);
    // Oturum daha önce kullanıldıysa sunucudan kaldığı yeri SORARIZ; kendi
    // sayacımıza güvenmeyiz (motorun yazdığı `uploadedParts` bayt ofseti değil,
    // parça sayısıdır ve iki durumda da ofset bilgisi taşımaz).
    const resumeOffset = session.uploadedParts > 0 ? await this.probeOffset(session.uploadUrl, total) : 0;

    const chunked = session.partSizeBytes > 0 && resumeOffset < total;
    if (!chunked) {
      // ── YOL A: tek PUT (varsayılan) ──────────────────────────────────────
      let response: YouTubeHttpResponse;
      try {
        response = await this.client.send({
          method: "PUT",
          url: session.uploadUrl,
          headers: {
            // Oturum açılışıyla AYNI olmak zorunda (bkz. yukarı).
            "content-length": String(total),
            "content-type": contentType,
          },
          body: bytes,
          timeoutMs: this.uploadTimeoutMs,
        });
      } catch (err) {
        // Zaman aşımı dahil: HİÇBİR ilerleme bildirilmez.
        throw asPublishTransportError(err, "resumable PUT başarısız");
      }
      return this.progressFromResponse(response, total, session, input.idempotencyKey);
    }

    // ── YOL B: parçalı (yalnız `partSizeBytes` verilirse) ───────────────────
    const chunk = Math.max(YOUTUBE_RESUMABLE_CHUNK_BYTES, session.partSizeBytes);
    let offset = resumeOffset;
    while (offset < total) {
      const slice = bytes.subarray(offset, Math.min(offset + chunk, total));
      let response: YouTubeHttpResponse;
      try {
        response = await this.client.send({
          method: "PUT",
          url: session.uploadUrl,
          headers: {
            "content-length": String(slice.length),
            "content-type": contentType,
            "content-range": `bytes ${offset}-${offset + slice.length - 1}/${total}`,
          },
          body: slice,
          timeoutMs: this.uploadTimeoutMs,
        });
      } catch (err) {
        throw asPublishTransportError(err, "resumable parça PUT başarısız");
      }
      const progress = this.progressFromResponse(response, total, session, input.idempotencyKey);
      if (progress.done) return progress;
      // 308: sunucu kaldığı ofseti `Range` ile bildirdi. İlerlemezse döngü
      // sonsuzlaşır; bu yüzden `receivedBytes` YOKSA kırılır.
      const next = this.receivedBytesOf(response);
      if (next === null || next <= offset) return progress;
      offset = next;
    }
    // Döngü bitti ama sunucu 201 vermedi (parça sayısı tutarsız): motor bir
    // sonraki turda `probeOffset` ile gerçek durumu soracak.
    return { uploadedParts: session.uploadedParts, totalParts: session.totalParts, done: false, nextOffset: total };
  }

  /**
   * Kesintide kaldığın baytı sorar: BOŞ `PUT` + `Content-Range: bytes *[/]TOTAL`.
   * 308 + `Range: bytes=0-N` → sunucunun aldığı bayt sayısı (`N + 1`).
   * 201 → sunucu yüklemeyi zaten tamamlamış (video kaynağı gelir).
   */
  private async probeOffset(sessionUri: string, total: number): Promise<number> {
    let response: YouTubeHttpResponse;
    try {
      response = await this.client.send({
        method: "PUT",
        url: sessionUri,
        headers: {
          "content-length": "0",
          "content-type": "video/mp4",
          "content-range": `bytes */${total}`,
        },
        body: new Uint8Array(0),
        timeoutMs: this.uploadTimeoutMs,
      });
    } catch (err) {
      throw asPublishTransportError(err, "resumable durum sorgusu başarısız");
    }
    if (response.status === 308) {
      return this.receivedBytesOf(response) ?? 0;
    }
    if (!response.ok) {
      throw classifyHttpFailure(response, "resumable oturum reddedildi");
    }
    // 2xx: sunucu tüm baytları almış. `0` dönerüz → çağıran tek PUT atar ve
    // sunucu 201 döner; çift gönderim olmaz çünkü tek PUT yolunda ofset 0'dır.
    return 0;
  }

  /** 308 yanıtındaki `Range` → kabul edilen bayt sayısı. Yoksa `null`. */
  private receivedBytesOf(response: YouTubeHttpResponse): number | null {
    if (response.status !== 308) return null;
    const parsed = parseRangeHeader(response.headers["range"]);
    return parsed > 0 ? parsed : null;
  }

  /**
   * HTTP cevabı → `UploadProgress`.
   *
   * 201 Created + video kaynağı → `done: true` ve `uploadedParts = totalParts`.
   * 308 → `done: false`; `uploadedParts` ARTMAZ çünkü parça kabul edilmedi.
   * Bu, motorun "yalnız başarılı cevaptan sonra artır" kuralıyla birebir
   * örtüşür: 308 bir HATA değil, "devam et" sinyalidir.
   */
  private progressFromResponse(
    response: YouTubeHttpResponse,
    total: number,
    session: UploadSession,
    idempotencyKey: string,
  ): UploadProgress {
    if (response.status === 308) {
      const received = this.receivedBytesOf(response);
      return {
        // Parça TAM kabul edilmediği sayı artmaz; motor kaldığı yerden
        // devam edebilsin diye ofset bildirilir.
        uploadedParts: session.uploadedParts,
        totalParts: session.totalParts,
        done: false,
        nextOffset: received,
      };
    }
    if (!response.ok) {
      // 404/410 → `container_expired` (oturum sona erdi, BAŞTAN başla),
      // 5xx → `server` (geçici), 409 → `validation` (bayt çakışması, sessiz).
      throw classifyHttpFailure(response, `Yükleme reddedildi (${total} bayt gönderildi)`);
    }
    // 201 Created: gövde video kaynağıdır ve kimliği (`id`) İÇERİR. Kimlik
    // oturuma yazılır; yoklama bir sonraki çağrıda `pending:` yerine gerçek
    // kimliği okur. Kaynak yoksa (200 + boş gövde) kabul edilmiş sayılır ama
    // kimlik bilinmiyor — motor `pollPublish`'e düşer ve oturum hâlâ `pending:`
    // göründüğü için süre kontrolüyle ilerler.
    const view = readVideoView(response.json);
    const opened = this.sessions.get(idempotencyKey);
    if (view !== null && opened !== undefined) {
      opened.videoId = view.id;
    }
    return {
      uploadedParts: 1,
      totalParts: 1,
      done: true,
      nextOffset: null,
    };
  }

  // ── İç yardımcılar ──────────────────────────────────────────────────────

  private readUploadResponse(response: YouTubeHttpResponse, total: number): YouTubeUploadOutcome {
    if (response.status === 308) {
      return {
        uploaded: false,
        receivedBytes: parseRangeHeader(response.headers["range"]),
        videoId: null,
        permalink: null,
        privacyStatus: null,
        publishAt: null,
      };
    }
    if (!response.ok) {
      throw classifyHttpFailure(response, `Yükleme reddedildi (${total} bayt gönderildi)`);
    }
    const view = readVideoView(response.json);
    return {
      uploaded: view !== null,
      receivedBytes: total,
      videoId: view?.id ?? null,
      permalink: view === null ? null : youtubePermalink(view.id),
      privacyStatus: view?.privacyStatus ?? null,
      publishAt: view?.publishAt ?? null,
    };
  }

  private async getJson(
    account: AccountRef,
    url: string,
    what: string,
  ): Promise<YouTubeHttpResponse> {
    this.counts.get += 1;
    let response: YouTubeHttpResponse;
    try {
      response = await this.client.send({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${account.accessToken}` },
      });
    } catch (err) {
      throw asPublishTransportError(err, what);
    }
    if (!response.ok) {
      throw classifyHttpFailure(response, what);
    }
    return response;
  }

  private async sendBinary(
    account: AccountRef,
    method: "POST" | "PUT",
    url: string,
    bytes: Uint8Array,
    contentType: string,
    what: string,
  ): Promise<YouTubeHttpResponse> {
    let response: YouTubeHttpResponse;
    try {
      response = await this.client.send({
        method,
        url,
        headers: {
          authorization: `Bearer ${account.accessToken}`,
          "content-length": String(bytes.length),
          "content-type": contentType,
        },
        body: bytes,
      });
    } catch (err) {
      throw asPublishTransportError(err, what);
    }
    if (!response.ok) {
      throw classifyHttpFailure(response, what);
    }
    return response;
  }

  private isExpired(iso: string): boolean {
    const ms = parseInstantMs(iso);
    return ms !== null && ms <= this.now();
  }
}

// ── Saf yardımcılar ────────────────────────────────────────────────────────

/** `Range: bytes=0-1023` → 1024 (kabul edilen bayt). Ayrık/bozuk → 0. */
export function parseRangeHeader(value: string | null | undefined): number {
  if (typeof value !== "string") return 0;
  const match = /bytes\s*=\s*(\d+)\s*-\s*(\d+)/i.exec(value);
  if (match === null) return 0;
  const end = Number(match[2]);
  return Number.isFinite(end) ? end + 1 : 0;
}

/**
 * ISO metni → epoch ms. Geçersiz/boş → `null`.
 *
 * YALAN TARİH REDDİ: `Date.parse("2026-02-31T00:00:00Z")` sessizce 3 Mart'a
 * kaydırır (JS `Date` taşma davranışı). Sözleşmenin `ScheduledAtSchema`'sı bu
 * sahte tarihleri zaten reddediyor; adaptör de aynı ciddiyeti gösterir. Aksi
 * halde "31 Şubat" diye girilen bir yayın günü sessizce 3 Mart'a gider ve
 * kullanıcı yanlış günü yayınladığını öğrenir.
 */
export function parseInstantMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(" ", "T");
  if (normalized === "") return null;
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return null;
  const datePart = /^(\d{4})-(\d{2})-(\d{2})/.exec(normalized);
  if (datePart !== null) {
    const back = new Date(ms);
    if (
      back.getUTCFullYear() !== Number(datePart[1]) ||
      back.getUTCMonth() + 1 !== Number(datePart[2]) ||
      back.getUTCDate() !== Number(datePart[3])
    ) {
      return null;
    }
  }
  return ms;
}

/** `storageKey|bytes|mimeType` — "aynı dosya mı" sorusunun tek yanıtı. */
export function mediaFingerprint(media: MediaRef): string {
  return `${media.storageKey}|${media.bytes}|${media.mimeType}`;
}

/** `videos.get` gövdesindeki `status` nesnesi. */
function remoteStatusOf(json: unknown): Record<string, unknown> {
  if (json === null || typeof json !== "object") return {};
  const items = (json as Record<string, unknown>)["items"];
  if (!Array.isArray(items) || items.length === 0) return {};
  const first = items[0];
  if (first === null || typeof first !== "object") return {};
  const status = (first as Record<string, unknown>)["status"];
  return status !== null && typeof status === "object" ? (status as Record<string, unknown>) : {};
}

/** `videos.get` gövdesindeki `snippet` nesnesi. */
function remoteSnippetOf(json: unknown): Record<string, unknown> {
  if (json === null || typeof json !== "object") return {};
  const items = (json as Record<string, unknown>)["items"];
  if (!Array.isArray(items) || items.length === 0) return {};
  const first = items[0];
  if (first === null || typeof first !== "object") return {};
  const snippet = (first as Record<string, unknown>)["snippet"];
  return snippet !== null && typeof snippet === "object" ? (snippet as Record<string, unknown>) : {};
}

/**
 * Adaptörün döndürdüğü her durum `processing`'den GEÇİLEBİLİR olmalıdır.
 * Motor durum makinesine göre yazıyor; burada bir kontrol, sözleşmeyi
 * bozan bir `StartResult`/`PollResult` üretirse motora değil burada durur.
 *
 * KENDİNE GEÇİŞ İSTİSNASI: `canTransition("processing", "processing")` bilinçli
 * olarak `false` döner — `explainTransition` kendine geçişi "aynı durumu yeniden
 * yazmak" diye reddeder. Motor `processing` işini `armPollLease` ile zaten
 * kendine geçişle yeniden kaydeder; bu bir GEÇİŞ değil, kiranın uzatılmasıdır.
 * Yoklama dönerken `processing` demek normaldir ve reddedilmemelidir.
 */
function assertReachable(next: JobState): JobState {
  if (next !== "processing" && !canTransition("processing", next)) {
    throw new PermanentPublishError(
      `YouTube adaptörü geçersiz iş durumu üretti: processing → ${next}.`,
      "validation",
      "illegal_state",
    );
  }
  return next;
}

export {
  YOUTUBE_RESUMABLE_CHUNK_BYTES,
  YOUTUBE_INSERT_DAILY_CALL_BUCKET,
  YOUTUBE_QUOTA_UNITS,
  YOUTUBE_API,
};
