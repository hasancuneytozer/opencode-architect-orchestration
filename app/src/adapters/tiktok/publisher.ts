/**
 * GERÇEK TikTok yayın adaptörü — Content Posting API (Direct Post).
 *
 * ══ BİRİNCİL SINIR: BU ADAPTÖR CANLIYA ALINMAZ ══════════════════════════════
 * TikTok'un resmî App Review politikası, "kendi hesaplarına yükleyen araç"
 * tipini **kabul etmiyor**. Bu kod yazıldı ve test edildi; ama resmî yayın
 * akışına bağlanması, uygulamanın denetim (audit) sürecinden geçmesine bağlıdır.
 * Bağlantı `src/main.ts` içindedir ve bu paket ona dokunmaz. Bkz. `NOTES.md` 1.
 *
 * ── AKIŞ (dört adım, üçü ayrı uç nokta) ─────────────────────────────────────
 *   1) `POST /v2/post/publish/creator_info/query/` → süre sınırı + gizlilik seçenekleri
 *   2) `POST /v2/post/publish/video/init/`         → `publish_id` + `upload_url`
 *   3) `PUT  {upload_url}` × N                     → SIRALI parçalar (206/201)
 *   4) `POST /v2/post/publish/status/fetch/`       → durum yoklama
 *
 * ── BU DOSYANIN BEŞ KRİTİK DETAYI ───────────────────────────────────────────
 * 1) **`FILE_UPLOAD`, `PULL_FROM_URL` DEĞİL.** Resmî öneri "dosya senin
 *    sunucundaysa PULL_FROM_URL" der; ama o yol alan adı mülkiyet doğrulaması
 *    gerektirir ve medyamızı internete açar. `spec.requiresPublicMediaUrl: false`
 *    sayesinde ikilisi bize göndermek meşru yoldur.
 * 2) **PARÇA BOYUTU `init`'TE SABİTLENİR.** `chunk_size` bir kez bildirilir;
 *    sonraki `PUT`'ların `Content-Range` değerleri O SAYIYA bağlıdır. Motor
 *    `UploadSession.partSizeBytes`'ı 0 yazar ("parça boyutu sağlayıcıya bağlıdır"),
 *    bu yüzden plan `startPublish` içinde hesaplanıp SÜREÇ İÇİ bir haritada
 *    saklanır ve `uploadParts` aynı plandan okur. Süreç yeniden başlarsa harita
 *    boşalır — bu durum `totalParts` ile ÇAPRAZ DENETLENİR ve tutmazsa kalıcı
 *    hata verilir (sessizce yanlış ofset göndermek videoyu bozar).
 * 3) **`creator_info` YAYIN ÖNCESİ ZORUNLUDUR.** `max_video_post_duration_sec`
 *    HESABA ÖZELDİR; token gerektirdiği için `precheck`'te kullanılamaz, `init`
 *    sırasında doğrulanır. `privacy_level` bu listeden biri olmak ZORUNDADIR;
 *    aksi halde 403 `privacy_level_option_mismatch`.
 * 4) **`share_url` DÖNMEZ.** Kalıcı `publicaly_available_post_id` yalnız HERKESE
 *    AÇIK yayınlanmış içerik için gelir. Denetimden geçmemiş istemci `SELF_ONLY`
 *    yayın yapar ve ölçüm hiç gelmez → `published_no_link` burada OLAĞAN.
 * 5) **`Retry-After` DOĞRULANMAMIŞ.** TikTok dokümanı bu başlığı hiç anlatmaz;
 *    yoklama aralığı üstel geri çekilmeyle birlikte kendi sabitini kullanır.
 *
 * ── `PULL_FROM_URL` YERİNE NEDEN `FILE_UPLOAD` (gerekçe) ────────────────────
 * Resmî doküman iki `source` değeri sunar. `PULL_FROM_URL` için TikTok, medyayı
 * çekeceği adresin **domain mülkiyetini doğrulamak** ister; doğrulama başarısız
 * olursa yayın sessizce kabul edilmez. Ayrıca `PULL_FROM_URL` medyanın internete
 * açık olmasını gerektirir ve bu uygulamanın `requiresPublicMediaUrl: false`
 * tercihiyle çelişir. `FILE_UPLOAD` yalnız `video.publish` kapsamı ister.
 */
import type {
  JobState,
  Platform,
  PlatformSpec,
  PublishErrorKind,
  ValidationFinding,
} from "../../contract/index.js";
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
import { mapTikTokFailReason } from "../../domain/providerErrors.js";
import type { ProviderErrorMapping } from "../../domain/providerErrors.js";
import { canTransition } from "../../domain/stateMachine.js";
import { composeCaptionDetailed } from "../../domain/copy.js";
import { findLimit, getSpec, validateMedia } from "../../media/index.js";
import { TIKTOK_UPLOAD_URL_TTL_SEC } from "../../media/presets.js";
import type { TikTokHttpClient, TikTokHttpResponse } from "./http.js";
import { TIKTOK_UPLOAD_TIMEOUT_MS, asPublishTransportError, createHttpClient } from "./http.js";

// ── Sabitler ────────────────────────────────────────────────────────────────

/** Resmî OAuth token ucunun kökü. Yetkilendirme kökü FARKLIDIR (aşağıda). */
export const TIKTOK_TOKEN_BASE = "https://open.tiktokapis.com";

/** Tarayıcıda açılan yetkilendirme diyaloğunun kökü. */
export const TIKTOK_AUTHORIZE_BASE = "https://www.tiktok.com";

/** Content Posting API kökü. */
export const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";

/**
 * Zorunlu scope'lar.
 *
 * - `video.publish`: Direct Post'un kendisi (`creator_info` + `init` + status).
 * - `user.info.basic`: hesabın `open_id`/görünen adı/avatarı. **Yayın için
 *   ZORUNLU DEĞİLDİR** (`creator_info` yalnız `video.publish` ile çalışır) ama
 *   panelde hesabı adıyla göstermek ve kimlik kaydını doldurmak için istenir.
 *
 * `video.list` YOK: yalnız permalink için gerekli ve o kapsam ek yetki demektir
 * (bkz. `NOTES.md` 3).
 */
export const TIKTOK_SCOPES: readonly string[] = ["video.publish", "user.info.basic"];

/** `source_info.source` — ikili yükleme. */
export const TIKTOK_SOURCE_FILE_UPLOAD = "FILE_UPLOAD";

/** Upload gövdesinin MIME tipi. */
export const TIKTOK_CHUNK_CONTENT_TYPE = "video/mp4";

/**
 * Parça boyutu alt sınırı (5 MB). Doküman: "her parça en az 5 MB".
 * `planChunks` bunu KIRPAR: dışarıdan 1 MB gibi bir değer gelse bile parça 5 MB'a
 * çekilir, çünkü TikTok küçük parçayı sessizce kabul etmez.
 */
export const TIKTOK_CHUNK_MIN_BYTES = 5 * 1024 * 1024;

/** Parça boyutu üst sınırı (64 MB). Ara parçalar bundan büyük olamaz. */
export const TIKTOK_CHUNK_MAX_BYTES = 64 * 1024 * 1024;

/** SON parça istisnası: 128 MB'ye kadar olabilir. */
export const TIKTOK_LAST_CHUNK_MAX_BYTES = 128 * 1024 * 1024;

/** Toplam parça sayısı sınırı. */
export const TIKTOK_MAX_CHUNK_COUNT = 1000;

/**
 * Varsayılan parça boyutu (16 MiB).
 *
 * Gerekçe: 5-64 MB aralığının ORTASI. Küçük parça → yeniden deneme ucuz ama
 * çok sayıda istek (4 GB'da 256 istek); büyük parça → az istek ama bir istek
 * başarısız olduğunda 64 MB yeniden gönderilir. 16 MiB her iki maliyeti de
 * dengeler ve 4 GB dosyayı 256 parçaya böler.
 *
 * **CANLIDA DENENMEDİ** — gerçek kabul/red davranışı ölçülmedi (bkz. `NOTES.md` 5).
 * Değiştirmek tek yerdedir.
 */
export const TIKTOK_DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * Caption sınırı. `String.length` = UTF-16 KOD BİRİMİ sayısıdır; Türkçe
 * harfler (ğ/ü/ş/İ) 1, emoji ise 2 sayılır. `copy.ts` de bu ölçümü kullanır.
 */
export const TIKTOK_CAPTION_MAX_CHARS = 2200;

/**
 * Durum yoklama aralığı (5 saniye).
 *
 * TikTok dokümanı "şu kadar sık sorun" DEMEZ; yalnız **hız sınırı** verir:
 * status 30 istek/dakika. 5 saniyede bir soru = 12 istek/dakika, sınırın yarısı
 * bile değil. `TIKTOK_MIN_POLL_MS` yoklama cevabındaki `Retry-After` bu değerin
 * altına indirilmez.
 */
export const TIKTOK_STATUS_POLL_MS = 5_000;

/** Hız sınırına saygının ALT SINIRI. 30/dk = 2000 ms; bundan sık sorulmaz. */
export const TIKTOK_MIN_POLL_MS = 2_000;

/** Yayın tamamlandıktan SONRA arşivde yazan durum kodu (ham TikTok kodu). */
export const TIKTOK_PUBLISHED_STATUS = "PUBLISH_COMPLETE";

// ── Uç nokta kurucuları (saf) ───────────────────────────────────────────────

/** `creator_info` sorgu adresi. */
export function creatorInfoUrl(base: string = TIKTOK_API_BASE): string {
  return `${base}/post/publish/creator_info/query/`;
}

/** `video/init` adresi. */
export function videoInitUrl(base: string = TIKTOK_API_BASE): string {
  return `${base}/post/publish/video/init/`;
}

/** `status/fetch` adresi. */
export function statusFetchUrl(base: string = TIKTOK_API_BASE): string {
  return `${base}/post/publish/status/fetch/`;
}

/** `status/fetch` gövdesi. */
export function buildStatusBody(publishId: string): Record<string, unknown> {
  return { publish_id: publishId };
}

// ── Gizlilik (saf) ──────────────────────────────────────────────────────────

/**
 * `privacy_level` değerleri (doğrulanmış enum).
 *
 * `unlisted` karşılığı YOKTUR: TikTok'ta "bağlantısı olanlar görsün" diye bir
 * görünürlük kademesi tanımlı değildir. `MUTUAL_FOLLOW_FRIENDS` en yakın
 * karşılıktır (yalnız karşılıklı takipçiler görür, keşif akışında çıkmaz) ve
 * bir ÜRÜN KARARIDIR, sağlayıcı zorunluluğu değil. `precheck` bunu `info` olarak
 * bildirir.
 */
export type TikTokPrivacyLevel =
  | "PUBLIC_TO_EVERYONE"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR"
  | "SELF_ONLY";

/** Dokümanda geçen dört değer. */
export const TIKTOK_PRIVACY_LEVELS: readonly TikTokPrivacyLevel[] = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
];

/** `ResolvedCopy.privacy` → `privacy_level`. */
export function privacyLevelFor(
  privacy: "public" | "unlisted" | "private",
): TikTokPrivacyLevel {
  if (privacy === "public") return "PUBLIC_TO_EVERYONE";
  if (privacy === "private") return "SELF_ONLY";
  return "MUTUAL_FOLLOW_FRIENDS";
}

/**
 * İstenen gizlilik seçeneği hesapta VAR MI?
 *
 * `null` = sorun yok. Aksi halde AÇIKLAYICI metin: kullanıcı ne istedi, hesapta
 * hangi seçenekler var. Sessizce başka bir değer SEÇMEK yanlıştır: kullanıcı
 * "herkese açık" dedi, biz "sadece ben" dersek reklam kampanyası sessizce
 * hedefsizleşir; "herkese açık" yerine arkadaşlara açık dersek hesap politikası
 * ihlal edilebilir.
 */
export function privacyLevelProblem(
  privacy: "public" | "unlisted" | "private",
  options: readonly TikTokPrivacyLevel[],
): string | null {
  const wanted = privacyLevelFor(privacy);
  if (options.includes(wanted)) return null;
  const available = options.length === 0 ? "(hesap hiçbir seçenek bildirmiyor)" : options.join(", ");
  if (options.length === 1 && options[0] === "SELF_ONLY") {
    return (
      `Kullanıcı "${privacy}" gizliliği istedi (karşılığı ${wanted}), ama bu hesap yalnız ` +
      "SELF_ONLY yayın yapabiliyor. TikTok denetimden (App Review/Audit) geçmemiş " +
      "istemciler yalnız özel hesaba yayın yapar ve günde sınırlı sayıda kullanıcıya " +
      "hizmet verir. Bu bir hata değil, platform politikasıdır: yayın politikayı " +
      "ihlal ederek yapılmaz."
    );
  }
  return (
    `Kullanıcı "${privacy}" gizliliği istedi (karşılığı ${wanted}), ama bu hesapta bu ` +
    `seçenek yok. Hesabın sunduğu seçenekler: ${available}. ` +
    "İstemci sessizce başka bir değer SEÇMEZ; kullanıcı bilinçli karar vermelidir."
  );
}

// ── Parça planı (saf, en kritik bölüm) ──────────────────────────────────────

export interface TikTokChunkPlan {
  /** `init` gövdesinde gönderilecek `chunk_size`. */
  chunkSize: number;
  /** `init` gövdesinde gönderilecek `total_chunk_count`. */
  totalChunkCount: number;
  /** Tek parça mı (dosya 5 MB altı ya da tek parçaya sığan büyük dosya). */
  single: boolean;
  /** `null` = plan geçerli. Değilse açıklayıcı hata metni. */
  problem: string | null;
}

/**
 * Parça planı — `total_chunk_count = floor(video_size / chunk_size)`.
 *
 * ── NEDEN `floor` VE SON PARÇA NEDEN "EN BÜYÜK" PARÇA ────────────────────────
 * Doküman `total_chunk_count = floor(video_size / chunk_size)` der. Bu formül
 * `ceil` DEĞİLDİR; dolayısıyla son parça kalan küçük dilim değil, **şu kadardır**:
 *
 *     son = video_size − (count − 1) × chunk_size,   count = floor(size / chunk)
 *
 * `count = floor(size/chunk)` olduğu için `size ∈ [count·chunk, (count+1)·chunk)`
 * ve dolayısıyla `son ∈ [chunk, 2·chunk)`. Yani:
 *   - `chunk ≤ 64 MB` iken son parça **her zaman** `< 128 MB` → dokümanın
 *     "son parça 128 MB'ye kadar" istisnası HER ZAMAN yeterlidir,
 *   - `chunk ≥ 5 MB` iken son parça **her zaman** `≥ 5 MB` → alt sınır da doludur.
 * Kısacası `floor` formülü, verilen iki istisna olmadan ÇALIŞMAZ; istisnalar
 * formülün parçasıdır. (Bkz. `NOTES.md` 6.)
 *
 * ── SEÇİM SIRASI ────────────────────────────────────────────────────────────
 * 1) `size < 5 MB` → TEK parça, `chunk_size = video_size` (dokümanın açık
 *    kuralı; 5 MB altında `chunk_size = 5 MB` göndermek `floor = 0` üretirdi).
 * 2) `chunk_size = clamp(tercih, 5 MB, 64 MB)` — dışarıdan 1 MB gibi bir değer
 *    gelse bile 5 MB'a çekilir.
 * 3) `count = max(1, floor(size / chunk_size))`.
 * 4) `count > 1000` ise plan reddedilir. **Ulaşılamaz** (64 MB tavan + 4 GB dosya
 *    tavanı = en çok 64 parça) ama `startPublish` `precheck`'ten bağımsız
 *    çalıştığı için savunma olarak durur.
 * 5) `count === 1` ise `chunk_size = video_size`: tek parçada `chunk_size`'dan
 *    büyük dosya bildirmek kendi gövdemizle çelişir (TikTok `floor = 0`
 *    hesaplar ve yüklemeyi reddeder).
 */
export function planChunks(
  totalBytes: number,
  preferredChunkBytes: number = TIKTOK_DEFAULT_CHUNK_BYTES,
): TikTokChunkPlan {
  const size = Number.isFinite(totalBytes) ? Math.floor(totalBytes) : 0;
  if (!(size > 0)) {
    return {
      chunkSize: 0,
      totalChunkCount: 0,
      single: false,
      problem: `Medya ${totalBytes} bayt. Boş dosya için init isteği gönderilmez.`,
    };
  }
  if (size < TIKTOK_CHUNK_MIN_BYTES) {
    return { chunkSize: size, totalChunkCount: 1, single: true, problem: null };
  }

  const wanted = Number.isFinite(preferredChunkBytes) ? Math.floor(preferredChunkBytes) : 0;
  const chunk = Math.min(TIKTOK_CHUNK_MAX_BYTES, Math.max(TIKTOK_CHUNK_MIN_BYTES, wanted));
  let count = Math.floor(size / chunk);
  if (count < 1) count = 1;
  if (count > TIKTOK_MAX_CHUNK_COUNT) {
    return {
      chunkSize: chunk,
      totalChunkCount: count,
      single: false,
      problem:
        `Dosya ${size} bayt; ${chunk} baytlık parçalarla ${count} parça gerekiyor, ` +
        `doküman en çok ${TIKTOK_MAX_CHUNK_COUNT} parça kabul ediyor. Dosya TikTok'un ` +
        "4 GB sınırını aşıyor ya da çok küçük parça boyutu dayatıldı.",
    };
  }
  return {
    chunkSize: count === 1 ? size : chunk,
    totalChunkCount: count,
    single: count === 1,
    problem: null,
  };
}

/** Tek bir parçanın bayt aralığı. */
export interface TikTokChunkRange {
  offset: number;
  length: number;
  /** Bu parçadan sonra tüm baytlar gönderilmiş mi? */
  final: boolean;
  /** `Content-Range` başlığının tam değeri (`bytes first-last/total`). */
  contentRange: string;
}

/**
 * `partIndex`'inci parçanın aralığı (0 tabanlı).
 *
 * SIRA ZORUNLUDUR: TikTok parçaları sıralı kabul eder; `partIndex` yalnız
 * `session.uploadedParts` değerinden gelir, çağıran serbest bırakılmaz.
 * `offset = index × chunk_size` — bu yüzden `chunk_size` `init`'te bildirilen
 * DEĞER olmak ZORUNDADIR.
 */
export function chunkRange(
  plan: TikTokChunkPlan,
  totalBytes: number,
  partIndex: number,
): TikTokChunkRange {
  const index = Math.max(0, Math.floor(partIndex));
  const offset = index * plan.chunkSize;
  const final = index >= plan.totalChunkCount - 1;
  const remaining = totalBytes - offset;
  // Son parça kalanın TAMAMINI alır; ara parça tam `chunk_size`.
  const length = final ? remaining : plan.chunkSize;
  const safeLength = Math.max(0, length);
  return {
    offset,
    length: safeLength,
    final,
    contentRange: `bytes ${offset}-${offset + safeLength - 1}/${totalBytes}`,
  };
}

// ── Kapak zaman damgası (saf) ───────────────────────────────────────────────

/**
 * `coverAtPercent` (yüzde) + `durationSec` → `video_cover_timestamp_ms`.
 *
 * TikTok Direct Post'ta kapak `post_info.video_cover_timestamp_ms` ile
 * seçilir: **milisaniye cinsinden video içi konum.** Yüzde değeri doğrudan
 * gönderilmez — 35% bir 30 saniyelik videoda 10 500 ms demektir, 35 ms değil.
 *
 * `durationSec` bilinmiyorsa `null` döner ve alan GÖNDERİLMEZ: bilinmeyen
 * süreyle bir zaman damgası uydurmak, kapağı yanlış yere koymaktan kötüdür
 * (TikTok 0'ı "ilk kare" olarak yorumlar; sessizce 0 göndermek kullanıcının
 * seçtiği karesi yok sayar).
 */
export function coverTimestampMs(
  coverAtPercent: number,
  durationSec: number | null | undefined,
): number | null {
  const duration = typeof durationSec === "number" && Number.isFinite(durationSec) ? durationSec : null;
  if (duration === null || !(duration > 0)) return null;
  const raw = Number.isFinite(coverAtPercent) ? coverAtPercent : 0;
  const percent = Math.min(100, Math.max(0, raw));
  return Math.round((duration * 1000 * percent) / 100);
}

// ── Başlık (caption) üretimi (saf) ──────────────────────────────────────────

/**
 * `post_info.title` = caption + hashtag'ler.
 *
 * UZUNLUK ÖLÇÜMÜ: `composeCaptionDetailed` `String.length` kullanır, yani
 * UTF-16 KOD BİRİMİ. Türkçe harf 1 sayılır (doğru), **emoji 2 sayılır** —
 * bir aile emojisi içeren caption sınıra 1-2 karakter yaklaşabilir. Bu bilinçli
 * bir tercihtir: kırpma yerine yanlışlıkla ret etmek, sessiz metin bozulmasından
 * iyidir (bkz. `copy.ts`).
 */
export function buildTitle(
  caption: string | null,
  hashtags: readonly string[],
): { text: string; problem: string | null } {
  const composed = composeCaptionDetailed(caption, hashtags, {
    maxChars: TIKTOK_CAPTION_MAX_CHARS,
    platform: "tiktok",
  });
  if (composed.text === null) {
    return { text: "", problem: composed.problem ?? "caption üretilemedi" };
  }
  return { text: composed.text, problem: null };
}

// ── `init` gövdesi (saf) ────────────────────────────────────────────────────

export interface TikTokInitInput {
  privacyLevel: TikTokPrivacyLevel;
  title: string;
  /** `post_info.is_aigc` — `ResolvedCopy.aiGenerated`'ın doğrudan karşılığı. */
  aiGenerated: boolean;
  videoSizeBytes: number;
  chunkSizeBytes: number;
  totalChunkCount: number;
  /** null → alan gönderilmez (süre bilinmiyor). */
  coverTimestampMs: number | null;
}

/**
 * `POST /v2/post/publish/video/init/` gövdesi.
 *
 * - `source_info.source: "FILE_UPLOAD"` — bkz. dosya başı.
 * - `post_info.is_aigc` `false` olsa bile AÇIKÇA gönderilir: alan yok
 *   bırakılırsa sunucu "beyan yok" ile ayırt edemez ve içerik sessizce AI
 *   etiketsiz yayınlanır.
 * - `video_cover_timestamp_ms` yalnız hesaplanabildiyse eklenir.
 */
export function buildInitBody(input: TikTokInitInput): Record<string, unknown> {
  const postInfo: Record<string, unknown> = {
    privacy_level: input.privacyLevel,
    title: input.title,
    is_aigc: input.aiGenerated,
  };
  if (input.coverTimestampMs !== null) {
    postInfo["video_cover_timestamp_ms"] = input.coverTimestampMs;
  }
  return {
    post_info: postInfo,
    source_info: { source: TIKTOK_SOURCE_FILE_UPLOAD },
    video_size: input.videoSizeBytes,
    chunk_size: input.chunkSizeBytes,
    total_chunk_count: input.totalChunkCount,
  };
}

// ── Yanıt ayrıştırma (saf) ─────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Gövde alanı: önce kök, sonra `data`.
 *
 * NEDEN İKİSİ: resmî örneklerde `creator_info`/`init` cevabı
 * `{ code: 0, message: "success", data: { ... } }` zarfı taşır; `status/fetch`
 * ise düz gövde döner. Alanı "önce kökte ara, yoksa `data`'da ara" şeklinde
 * okumak ikisini de destekler ve zarf biçimi değişse bile kırılmaz.
 */
function readField(json: unknown, key: string): unknown {
  const root = asRecord(json);
  if (root === null) return undefined;
  if (root[key] !== undefined) return root[key];
  const data = asRecord(root["data"]);
  return data === null ? undefined : data[key];
}

function readText(json: unknown, key: string): string | null {
  const value = readField(json, key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readNumber(json: unknown, key: string): number | null {
  const value = readField(json, key);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** `data.publish_id` ve `data.upload_url`. */
export interface TikTokInitRef {
  publishId: string;
  uploadUrl: string;
}

export function readInitRef(json: unknown): TikTokInitRef | null {
  const publishId = readText(json, "publish_id");
  const uploadUrl = readText(json, "upload_url");
  if (publishId === null || uploadUrl === null) return null;
  return { publishId, uploadUrl };
}

/** `creator_info` cevabı. */
export interface TikTokCreatorOptions {
  /** Hesaba özel üst sınır (saniye). null = sunucu bildirmedi. */
  maxVideoPostDurationSec: number | null;
  /** Hesapta yayınlanabilen gizlilik seçenekleri (tanınanlar). */
  privacyLevelOptions: TikTokPrivacyLevel[];
  /** Ham cevap — panelde gösterilebilir, testlerde ölçülebilir. */
  raw: unknown;
}

/**
 * `POST /v2/post/publish/creator_info/query/` cevabı.
 *
 * `privacy_level_options` boş DÖNERSE seçeneklerin hiçbiri bilinmiyor demektir;
 * `privacyLevelProblem` bunu "hesap hiçbir seçenek bildirmiyor" diye okur ve
 * kalıcı hata verir. Dört değeri varsaymak UYDURMA olurdu: alan eksikse
 * `403 privacy_level_option_mismatch` alırız ve nedeni görünmez.
 *
 * Tanınmayan değerler (doküman dışı) ATILIR; ama GEREĞİ BİR TANE tanındıysa
 * liste boşalmaz, yoksa hesabın tek seçeneği varmış gibi görünür.
 */
export function readCreatorOptions(json: unknown): TikTokCreatorOptions {
  const rawOptions = readField(json, "privacy_level_options");
  const list = Array.isArray(rawOptions) ? rawOptions : [];
  const options: TikTokPrivacyLevel[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const value = item.trim().toUpperCase();
    if ((TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(value)) {
      options.push(value as TikTokPrivacyLevel);
    }
  }
  return {
    maxVideoPostDurationSec: readNumber(json, "max_video_post_duration_sec"),
    privacyLevelOptions: options,
    raw: json,
  };
}

/** `status/fetch` cevabı. */
export interface TikTokStatusView {
  status: string | null;
  failReason: string | null;
  /** Yalnız HERKESE AÇIK yayınlanmış içerik için döner. */
  publicPostId: string | null;
  /** `PUBLISH_COMPLETE` için alternatif kimlik (`publicaly_available_post_id` yoksa). */
  videoId: string | null;
}

export function readStatusView(json: unknown): TikTokStatusView {
  return {
    status: readText(json, "status"),
    failReason: readText(json, "fail_reason"),
    publicPostId: readText(json, "publicaly_available_post_id"),
    videoId: readText(json, "video_id"),
  };
}

/** `status` değerleri. Tanımlı olmayan kod kalıcı `unknown` üretir. */
export const TIKTOK_PROCESSING_STATUSES: readonly string[] = [
  "PROCESSING_UPLOAD",
  "PROCESSING_DOWNLOAD",
  "SEND_TO_USER_INBOX",
];

// ── Hata gövdesi ayrıştırma ────────────────────────────────────────────────

export interface TikTokErrorInfo {
  /** `error` alanı (OAuth hatalarında) ya da gövde zarfının `code`'u. */
  code: string | null;
  /** `error_description` / `message`. */
  description: string | null;
  /** `log_id` — destek talebinde ZORUNLU tek ipucu. */
  logId: string | null;
}

/**
 * TikTok hata gövdesi.
 *
 * İKİ ZARF BİÇİMİ vardır ve ikisi de okunur:
 *   - OAuth/token: `{ error: "invalid_grant", error_description: "..." }`
 *   - API: `{ code: 10008, message: "...", log_id: "..." }`
 * Alan YOKSA `null` döner; eksik alana `0` gibi bir değer uydurmak "tanınmıyor"
 * yerine "geçici" görünmesine yol açardı.
 */
export function parseTikTokError(json: unknown, rawBody: string): TikTokErrorInfo {
  const root = asRecord(json);
  if (root === null) {
    return {
      code: null,
      description: rawBody.trim() === "" ? null : rawBody.trim().slice(0, 400),
      logId: null,
    };
  }
  const code =
    (typeof root["error"] === "string" ? root["error"] : null) ??
    (root["code"] !== undefined && root["code"] !== null ? String(root["code"]) : null);
  const description =
    (typeof root["error_description"] === "string" ? root["error_description"] : null) ??
    (typeof root["message"] === "string" ? root["message"] : null);
  return {
    code: code !== null && code.trim() !== "" ? code.trim() : null,
    description: description !== null && description.trim() !== "" ? description.trim() : null,
    logId: typeof root["log_id"] === "string" ? root["log_id"] : null,
  };
}

/** Denetimden geçmemiş istemci hatası — kalıcı politika kararı. */
export const TIKTOK_UNAUDITED_CODE = "unaudited_client_can_only_post_to_private_accounts";

/**
 * HTTP hatasını yayın hatasına çevirir.
 *
 * ÖNCELİK:
 *   1) Dokümanlanmış politika kodu (`unaudited_client_...`) → kalıcı `policy`.
 *   2) 429 → `ratelimit`, 5xx/408 → `server`/`transient` (GEÇİCİ).
 *   3) 401 → kalıcı `auth`, 403 → kalıcı `policy`.
 *   4) `ctx.upload === true` iken 403 **ÖZEL**: `upload_url` 1 saatte
 *      süresini doldurur ve aynı adres bayt kabul etmez → kalıcı
 *      `container_expired`. 416 da `ctx.upload` dalında kalıcı `validation`
 *      ("Content-Range ilerlemeyi yansıtmıyor") — aynı parçayı tekrar göndermek
 *      sırayı bozacağı için bir daha denenmemeli.
 *
 * Neden 4xx "belki geçcidir" sayılmaz: TikTok 4xx'i bir politika kararı olarak
 * kullanır; `fail_reason`/`error` alanı geçici olan durumları ayrıca bildirir.
 */
export function classifyTikTokFailure(
  response: TikTokHttpResponse,
  what: string,
  ctx: { upload?: boolean } = {},
): PermanentPublishError | RetryablePublishError {
  const info = parseTikTokError(response.json, response.body);
  const status = response.status;
  const detail = info.description ?? (response.body !== "" ? response.body.slice(0, 400) : "(gövde boş)");
  const base = `${what} — HTTP ${status}${info.code !== null ? ` (code=${info.code})` : ""}: ${detail}`;
  const retryable = (kind: PublishErrorKind, code: string | null): RetryablePublishError =>
    new RetryablePublishError(
      base,
      kind as Extract<PublishErrorKind, "network" | "ratelimit" | "server" | "transient">,
      response.retryAfterMs,
      code,
      info.logId,
      status,
    );
  const permanent = (kind: PublishErrorKind, code: string | null): PermanentPublishError =>
    new PermanentPublishError(base, kind, code, info.logId, status);

  // 1) Politika kodu.
  if (info.code !== null && info.code === TIKTOK_UNAUDITED_CODE) {
    return new PermanentPublishError(
      `${base} — TikTok denetimden (App Review/Audit) geçmemiş istemciler yalnız ` +
        "SELF_ONLY yayın yapabilir. Bu bir hata değil, platform politikasıdır; " +
        "tekrar denemek kabul edilmez.",
      "policy",
      info.code,
      info.logId,
      status,
    );
  }

  // 2) Geçici sınıflar.
  if (status === 429) return retryable("ratelimit", info.code ?? "http_429");
  if (status >= 500) return retryable("server", info.code ?? `http_${status}`);
  if (status === 408) return retryable("transient", info.code ?? "http_408");

  // 3) YÜKLEME ADRESİNE ÖZEL kalıcı hatalar.
  //
  // SIRA ÖNEMLİDİR: bu dal JENERİK 403 `policy` dalından ÖNCE gelir. `upload_url`
  // imzalı bir depolama adresidir; oradaki 403 "bu adres artık bayt kabul
  // etmiyor" demektir ve kalıcı `container_expired` üretir. Aynı HTTP durumu API
  // uçlarında ise politika kararıdır — ikisi aynı kodu paylaştığı için bağlam
  // ayrımı ZORUNLUDUR.
  if (ctx.upload === true) {
    if (status === 403) {
      return new PermanentPublishError(
        `${base} — Yükleme adresi artık bayt kabul etmiyor (TikTok upload_url 1 saatte ` +
          "süresini doldurur). Aynı adrese bayt gönderilemez; yükleme BAŞTAN " +
          "başlatılmalıdır.",
        "container_expired",
        info.code ?? "upload_url_expired",
        info.logId,
        status,
      );
    }
    if (status === 410) {
      return new PermanentPublishError(
        `${base} — Yükleme adresi artık geçerli değil (TikTok upload_url 1 saatte ` +
          "süresini doldurur). Aynı adrese bayt gönderilemez; yükleme baştan başlatılmalıdır.",
        "container_expired",
        info.code ?? "upload_url_expired",
        info.logId,
        status,
      );
    }
    if (status === 416) {
      return new PermanentPublishError(
        `${base} — Sunucu bu Content-Range aralığını kabul etmedi: istek kaldığın yerden ` +
          "devam et anlamına gelmiyor. Parçayı yeniden göndermek SIRAYI BOZAR; yükleme " +
          "baştan başlatılmalıdır.",
        "validation",
        info.code ?? "content_range_rejected",
        info.logId,
        status,
      );
    }
  }

  // 4) Jenerik kalıcı sınıflar.
  if (status === 401) return permanent("auth", info.code ?? "unauthorized");
  if (status === 403) return permanent("policy", info.code ?? "forbidden");

  return permanent("validation", info.code ?? `http_${status}`);
}

// ── Bayt aralığı kaynağı ───────────────────────────────────────────────────

/** `uploadParts` için bayt aralığı okuyucu. Büyük gövdelerde AKIM döner. */
export type OpenRangeFn = (input: {
  storageKey: string;
  offset: number;
  length: number;
}) => Promise<Uint8Array | NodeJS.ReadableStream> | Uint8Array | NodeJS.ReadableStream;

// ── Adaptör ─────────────────────────────────────────────────────────────────

/** Süreç içi oturum kaydı. `chunk_size` burada SABİTLENİR. */
export interface TikTokSession {
  publishId: string;
  uploadUrl: string;
  expiresAt: string;
  /** "Aynı dosya mı" sorusunun yanıtı. */
  fingerprint: string;
  /** `init`'te bildirilen bayt sayısı — ofset aritmetiğinin tabanı. */
  totalBytes: number;
  /** `init`'te bildirilen dosya anahtarı (transcode sonrası olabilir). */
  storageKey: string;
  chunkSize: number;
  totalChunkCount: number;
}

export interface TikTokAdapterOptions {
  /** Zaman kaynağı. **Varsayılanı YOKTUR** (süre hesabı test edilemez olmasın). */
  now: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Parça yüklemesi zaman aşımı (varsayılan 60 dakika). */
  uploadTimeoutMs?: number;
  /** Tercih edilen parça boyutu (varsayılan 16 MiB, 5-64 MB'ye kırpılır). */
  partSizeBytes?: number;
  /** Bayt aralığı okuyucu. Verilirse `resolvePath` yok sayılır. */
  openRange?: OpenRangeFn;
  /** Depo anahtarını dosya yoluna çözer (MediaStore.pathFor). */
  resolvePath?: (storageKey: string) => string;
  /** Test kancaları. Üretimde resmî adresler kullanılır. */
  apiBase?: string;
}

export interface TikTokCounters {
  precheck: number;
  creatorInfo: number;
  start: number;
  upload: number;
  poll: number;
  finalize: number;
  quota: number;
}

export class TikTokPublishAdapter implements PublishAdapter {
  readonly platform: Platform = "tiktok";
  readonly spec: PlatformSpec = getSpec("tiktok");

  private readonly now: () => number;
  private readonly client: TikTokHttpClient;
  private readonly uploadTimeoutMs: number;
  private readonly partSizeBytes: number;
  private readonly openRange: OpenRangeFn | null;
  private readonly apiBase: string;
  /** `idempotencyKey` → açılmış oturum. Aynı süreç içinde mükerrer koruması. */
  private readonly sessions = new Map<string, TikTokSession>();
  private readonly counts: TikTokCounters = {
    precheck: 0,
    creatorInfo: 0,
    start: 0,
    upload: 0,
    poll: 0,
    finalize: 0,
    quota: 0,
  };

  constructor(options: TikTokAdapterOptions) {
    this.now = options.now;
    this.client = createHttpClient({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      now: options.now,
    });
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? TIKTOK_UPLOAD_TIMEOUT_MS;
    this.partSizeBytes = options.partSizeBytes ?? TIKTOK_DEFAULT_CHUNK_BYTES;
    this.apiBase = options.apiBase ?? TIKTOK_API_BASE;
    if (options.openRange !== undefined) {
      this.openRange = options.openRange;
    } else if (options.resolvePath !== undefined) {
      // `node:fs` yalnız lazy olarak yüklenir: `openRange` verilmişse gerekmez.
      const resolvePath = options.resolvePath;
      this.openRange = async ({ storageKey, offset, length }) => {
        const path = resolvePath(storageKey);
        // Varlık ÖNCE doğrulanır. `createReadStream` dosya yoksa HATA
        // FIRLATMAZ: eksik dosyada akım nesnesi döner, hata gövde tüketilirken
        // `error` OLAYI olarak doğar. O olay `client.send` tarafından
        // YAKALANAMAZ (gövde sahibi orası değildir) → süreçte yakalanmamış
        // istisna olur; üstelik istek 200 dönseydi `uploadParts` "başarılı"
        // derdi. `statSync` burada, eşzamansız ve yakalanabilir biçimde patlar.
        const { createReadStream, statSync } = await import("node:fs");
        statSync(path);
        return createReadStream(path, { start: offset, end: offset + length - 1 });
      };
    } else {
      this.openRange = null;
    }
  }

  /** Test kancası: sayaçları okur. */
  callCounts(): Readonly<TikTokCounters> {
    return { ...this.counts };
  }

  /** Test kancası: açılmış oturumları okur. */
  session(idempotencyKey: string): TikTokSession | null {
    const found = this.sessions.get(idempotencyKey);
    return found === undefined ? null : { ...found };
  }

  // ── precheck ─────────────────────────────────────────────────────────────

  /**
   * Yayına gitmeden önceki son kontrol. **AĞ ÇAĞRISI YAPMAZ.**
   *
   * Neden yapamaz: `max_video_post_duration_sec` ve `privacy_level_options`
   * hesaba özeldir ve token ister; `precheck` sözleşmesi gereği saf yerel
   * kontroldür. Bu iki kontrol `startPublish` içinde, `creator_info` cevabıyla
   * yapılır (bkz. `NOTES.md` 2).
   *
   * Katman 1 — `validateMedia(info, getSpec("tiktok"))`: ölçü, kapsayıcı, kodek,
   * fps, süre (3 sn-10 dk), boyut (4 GB). 9:16 ORANI burada `warning` üretir,
   * `error` DEĞİL: TikTok dokümanında aspect oranı zorunlu değildir. Seviye
   * DÖNÜŞTÜRÜLMEZ — aynı kuralın iki yerde farklı sertlikte olması panelde
   * "uyarı" derken işin "hata" ile kapanmasına yol açar.
   *
   * Katman 2 — yalnız bu katmanın bildiği kurallar:
   *   - caption + hashtag BİLEŞİK uzunluğu (2200 UTF-16 birim),
   *   - `aiGenerated` beyanı (`is_aigc: true` gönderilecek),
   *   - gizlilik eşlemesi (özellikle `unlisted` → `MUTUAL_FOLLOW_FRIENDS`
   *     tam karşılık DEĞİLDİR),
   *   - kapak yüzdesinin ms'e çevrileceği ve süre bilinirse gönderileceği,
   *   - zamanlamanın TikTok'ta YAPILAMADIĞI bilgisi (bizim kuyruğumuzda),
   *   - hesaba özel süre sınırının burada doğrulanamayacağı.
   */
  async precheck(input: PublishInput): Promise<ValidationFinding[]> {
    this.counts.precheck += 1;
    const findings: ValidationFinding[] = validateMedia(input.media.info, this.spec);

    if (!(input.media.bytes > 0)) {
      findings.push({
        code: "empty_media",
        severity: "error",
        message:
          `Medya ${input.media.bytes} bayt. Boş dosya için init isteği gönderilmez; ` +
          "sunucu anlık reddeder.",
        observed: String(input.media.bytes),
      });
    }

    const captionLimit = findLimit(this.spec.limits, "caption");
    const maxChars =
      typeof captionLimit?.max === "number" && captionLimit.max > 0
        ? captionLimit.max
        : TIKTOK_CAPTION_MAX_CHARS;
    const composed = composeCaptionDetailed(input.copy.caption, input.copy.hashtags, {
      maxChars,
      platform: "tiktok",
    });
    if (composed.problem !== null) {
      findings.push({
        code: "caption_length",
        severity: "error",
        message:
          `${composed.problem} Metin kırpılmadı; TikTok'ta sessiz kırpma yerine ` +
          "reddetmek tercih edilir. (Uzunluk UTF-16 birimiyle ölçülür: Türkçe harf 1, emoji 2.)",
        ...(captionLimit === undefined ? {} : { limit: captionLimit.rule }),
        observed: `${composed.length} karakter`,
      });
    }
    for (const warning of composed.warnings) {
      findings.push({
        code: "caption_warning",
        severity: "info",
        message: warning,
        observed: `${composed.length} karakter`,
      });
    }

    if (input.copy.aiGenerated) {
      findings.push({
        code: "ai_generated_disclosure",
        severity: "info",
        message:
          "`is_aigc: true` gönderilecek. TikTok bu beyanı platformda AI etiketine " +
          "çevirir; alan gönderilmezse içerik sessizce AI etiketsiz yayınlanır.",
        observed: "aiGenerated=true",
      });
    }

    const level = privacyLevelFor(input.copy.privacy);
    findings.push({
      code: "privacy_level",
      severity: "info",
      message:
        input.copy.privacy === "unlisted"
          ? `"unlisted" isteği ${level} olarak gönderilecek. TikTok'ta "yalnız bağlantısı " +
            "olanlar görsün" diye bir kademe YOKTUR; bu eşleme bir ÜRÜN KARARIDIR ve en ` +
            "yakın karşılıktır. Hesap bu seçeneği sunmazsa yayın reddedilir."
          : `Gizlilik ${level} olarak gönderilecek. Hesabın sunduğu seçenekler ` +
            "creator_info ile yayın anında doğrulanır.",
      observed: level,
    });

    const coverMs = coverTimestampMs(input.copy.coverAtPercent, input.media.info.durationSec);
    findings.push({
      code: "cover_timestamp",
      severity: "info",
      message:
        coverMs === null
          ? "Video süresi bilinmiyor; `video_cover_timestamp_ms` GÖNDERİLMEZ. Bilinmeyen " +
            "süreyle bir zaman damgası uydurmak, kullanıcının seçtiği kareyi yok sayar."
          : `Kapak karesi video_cover_timestamp_ms=${coverMs} olarak gönderilecek ` +
            `(%${input.copy.coverAtPercent} × ${input.media.info.durationSec ?? 0} sn).`,
      observed: coverMs === null ? "bilinmiyor" : String(coverMs),
    });

    findings.push({
      code: "duration_account_limit",
      severity: "info",
      message:
        "TikTok'un video süre üst sınırı HESABA ÖZELDİR (max_video_post_duration_sec) ve " +
        "belirteç gerektirir; burada doğrulanamaz. Genel taban (3 sn-10 dk) yukarıda " +
        "uygulandı, hesap limiti init sırasında creator_info ile kontrol edilir.",
      observed: String(input.media.info.durationSec ?? "bilinmiyor"),
    });

    const scheduledText = typeof input.scheduledAt === "string" ? input.scheduledAt : null;
    if (scheduledText !== null) {
      findings.push({
        code: "schedule_local_only",
        severity: "info",
        message:
          "TikTok Content Posting API'de yayın zamanlaması YOKTUR. Zamanlama bizim iş " +
          "kuyruğumuzda yapılır; init çağrısı yalnız kuyruk o anı geldiğinde yapılır.",
        observed: scheduledText,
      });
    }

    return findings;
  }

  // ── creator_info ─────────────────────────────────────────────────────────

  /**
   * Hesabın yayın yeteneklerini okur: azami video süresi ve gizlilik seçenekleri.
   *
   * Bu çağrı ZORUNLUDUR ve yayından ÖNCE yapılır: `privacy_level` listede yoksa
   * 403 `privacy_level_option_mismatch`, süre aşılırsa 403 `duration_check_failed`
   * gelir ve ikisi de kaynakta anlaşılmaz. Hız sınırı 20 istek/dakika.
   */
  async getCreatorOptions(account: AccountRef): Promise<TikTokCreatorOptions> {
    this.counts.creatorInfo += 1;
    const response = await this.send({
      method: "POST",
      url: creatorInfoUrl(this.apiBase),
      what: "Hesap yayın yetenekleri okunamadı (creator_info)",
      account,
      body: {},
    });
    if (!response.ok) throw classifyTikTokFailure(response, "creator_info okunamadı");
    return readCreatorOptions(response.json);
  }

  // ── startPublish ─────────────────────────────────────────────────────────

  /**
   * `creator_info` okur, gizlilik/süre kararlarını doğrular ve `init` çağırır.
   *
   * MÜKERRER KORUMA: TikTok'un `init` gövdesinde resmî bir idempotens alanı
   * **YOKTUR** (`publish_id` sunucunun ürettiği bir kimliktir, istemci veremez).
   * Bu yüzden:
   *   - `idempotencyKey` → süreç içi `sessions` haritası.
   *   - Anahtarın "aynı dosya" olduğu `storageKey|bytes|mimeType` üçlüsüyle
   *     doğrulanır. FARKLI bir dosya aynı anahtarla gelirse bu artık mükerrer
   *     DEĞİLDİR (farklı bir iş) ve yeni `init` açılır.
   *   - Süresi dolmuş oturum yenilenir: `upload_url` 1 saatte geçersizleşir ve
   *     aynı adres bayt kabul etmez.
   * KORUMA SÜREÇ İÇİDİR. Kalıcı koruma motorun kendi kuralıdır: `externalId`
   * yazılmış bir iş için `startPublish` YENİDEN ÇAĞRILMAZ (bkz.
   * `src/services/publisher.ts` 9. adım). Süreç yeniden başlasa bile harita
   * boşalır; o durumda `uploadParts` `totalParts` ile çapraz denetler.
   *
   * `FILE_UPLOAD` seçimi: bkz. dosya başı.
   */
  async startPublish(input: PublishInput): Promise<StartResult> {
    this.counts.start += 1;
    const key = input.idempotencyKey;
    const fingerprint = mediaFingerprint(input.media);

    const existing = this.sessions.get(key);
    if (
      existing !== undefined &&
      existing.fingerprint === fingerprint &&
      !isPast(existing.expiresAt, this.now())
    ) {
      return {
        kind: "uploadUrl",
        externalId: existing.publishId,
        uploadUrl: existing.uploadUrl,
        expiresAt: existing.expiresAt,
        state: "processing",
      };
    }

    if (!(input.media.bytes > 0)) {
      throw new PermanentPublishError(
        `init çağrılamaz: medya ${input.media.bytes} bayt. Boş dosya için publish_id ` +
          "açılmaz; yerinde kalıcı hata verilir.",
        "media_rejected",
        "empty_media",
      );
    }

    const plan = planChunks(input.media.bytes, this.partSizeBytes);
    if (plan.problem !== null) {
      throw new PermanentPublishError(
        plan.problem,
        "media_rejected",
        "chunk_plan_invalid",
        null,
        null,
      );
    }

    const creator = await this.getCreatorOptions(input.account);

    const level = privacyLevelFor(input.copy.privacy);
    const privacyProblem = privacyLevelProblem(input.copy.privacy, creator.privacyLevelOptions);
    if (privacyProblem !== null) {
      throw new PermanentPublishError(privacyProblem, "policy", "privacy_level_option_mismatch");
    }

    const duration = input.media.info.durationSec;
    if (
      typeof duration === "number" &&
      Number.isFinite(duration) &&
      creator.maxVideoPostDurationSec !== null &&
      duration > creator.maxVideoPostDurationSec
    ) {
      throw new PermanentPublishError(
        `Video ${duration} saniye; bu hesabın TikTok sınırı ${creator.maxVideoPostDurationSec} ` +
          "saniye. Bu sınır HESABA ÖZELDİR (creator_info) ve ön kontrolde doğrulanamaz; " +
          "aynı dosyayla yeniden denemek aynı sonucu verir.",
        "media_rejected",
        "duration_check_failed",
        null,
        null,
      );
    }

    const title = buildTitle(input.copy.caption, input.copy.hashtags);
    if (title.problem !== null) {
      throw new PermanentPublishError(
        `Başlık üretilemedi: ${title.problem} Metin kırpılmadı.`,
        "validation",
        "caption_too_long",
      );
    }

    const body = buildInitBody({
      privacyLevel: level,
      title: title.text,
      aiGenerated: input.copy.aiGenerated,
      videoSizeBytes: input.media.bytes,
      chunkSizeBytes: plan.chunkSize,
      totalChunkCount: plan.totalChunkCount,
      coverTimestampMs: coverTimestampMs(input.copy.coverAtPercent, duration),
    });

    const response = await this.send({
      method: "POST",
      url: videoInitUrl(this.apiBase),
      what: "Yayın başlatılamadı (video/init)",
      account: input.account,
      body,
    });
    if (!response.ok) throw classifyTikTokFailure(response, "Yayın başlatılamadı (video/init)");

    const ref = readInitRef(response.json);
    if (ref === null) {
      // 200 geldi ama publish_id yok: bayt GÖNDERİLMEDİ, dolayısıyla mükerrer
      // yayın riski yok → geçici sınıf.
      throw new RetryablePublishError(
        `init isteği 200 döndü ama gövdede \`publish_id\`/\`upload_url\` yok (gövde: ` +
          `${response.body.slice(0, 300)}). Bayt gönderilmediği için yeniden denemek güvenli.`,
        "transient",
        null,
        "missing_publish_id",
        null,
        response.status,
      );
    }

    const expiresAt = new Date(this.now() + TIKTOK_UPLOAD_URL_TTL_SEC * 1000).toISOString();
    this.sessions.set(key, {
      publishId: ref.publishId,
      uploadUrl: ref.uploadUrl,
      expiresAt,
      fingerprint,
      totalBytes: input.media.bytes,
      storageKey: input.media.storageKey,
      chunkSize: plan.chunkSize,
      totalChunkCount: plan.totalChunkCount,
    });

    return {
      kind: "uploadUrl",
      externalId: ref.publishId,
      uploadUrl: ref.uploadUrl,
      expiresAt,
      state: "processing",
    };
  }

  // ── uploadParts ──────────────────────────────────────────────────────────

  /**
   * YALNIZ SIRADAKİ PARÇAYI gönderir ve kaldığı yerden devam eder.
   *
   * ── SIRALI GÖNDERİM ────────────────────────────────────────────────────────
   * TikTok parçaları SIRALI kabul eder; sunucu "sıradaki parçayı gönder" der.
   * Bu yüzden bir çağrıda `session.uploadedParts + 1`. parça gönderilir, hepsi
   * birden DEĞİL. `uploadedParts` motor tarafından kalıcı yazıldığı için süreç
   * çökse de kaldığı yerden devam eder.
   *
   * ── OFSET NEREDEN ─────────────────────────────────────────────────────────
   * `offset = uploadedParts × chunk_size`. `chunk_size` `init`'te bildirilmiş ve
   * SÜREÇ İÇİ haritada sabitlenmiştir; motor `partSizeBytes: 0` yazar
   * ("sağlayıcıya bağlıdır"), bu yüzden burada yeniden hesaplanmaz. Harita
   * boşsa (süreç yeniden başlamış) plan `input.media.bytes`'ten türetilir ve
   * `totalParts` ile ÇAPRAZ DENETLENİR: tutmuyorsa kalıcı hata. Yanlış ofseti
   * sessizce göndermek videoyu bozup TikTok'tan 416 alır; hata vermek daha
   * dürüsttür.
   *
   * ── CEVAP ─────────────────────────────────────────────────────────────────
   *   `206` → parça alındı, `done: false` (kabul edilen parça sayısı +1).
   *   `201` → YÜKLEME TAMAM, `done: true`.
   *   SON parça (ofset+bayt = dosya sonu) → `done: true` KABUL EDİLİR: baytlar
   *     gitmiştir, `done: false` dönmek motoru sonsuz döngüye sokardı. TikTok
   *     son parçaya 201 döner; 206 dönmesi bir sapmadır ve yoklama `FAILED`
   *     bildirirse yakalanır.
   *   `403` → kalıcı `container_expired` (upload_url süresi doldu).
   *   `416` → kalıcı `validation` (Content-Range ilerlemeyi yansıtmıyor).
   *   `5xx`/`429` → GEÇİCİ; parça motorun yazdığı `uploadedParts`'ten yeniden
   *     gönderilir (dokümanın sıra kuralı bunu gerektirir).
   */
  async uploadParts(input: PublishInput, session: UploadSession): Promise<UploadProgress> {
    this.counts.upload += 1;
    if (this.openRange === null) {
      throw new PermanentPublishError(
        "TikTok adaptörü bayt aralığı okuyacak bir kaynağa bağlı değil. `openRange` ya " +
          "da `resolvePath` seçeneği verilmelidir; aksi halde 128 MB'lık gövde belleğe " +
          "alınamaz ve yükleme sessizce yapılamaz.",
        "validation",
        "range_source_missing",
      );
    }

    const known = this.sessions.get(input.idempotencyKey);
    const totalBytes = known !== undefined ? known.totalBytes : input.media.bytes;
    const storageKey = known !== undefined ? known.storageKey : input.media.storageKey;

    if (!(totalBytes > 0)) {
      throw new PermanentPublishError(
        `Yükleme yapılamaz: ${storageKey} için ${totalBytes} bayt hesaplandı. Oturum açılmış ` +
          "olsa bile gövde boş.",
        "media_rejected",
        "empty_media",
      );
    }

    const chunkSize = known !== undefined ? known.chunkSize : this.plannedChunkSize(totalBytes);
    const totalChunkCount =
      known !== undefined ? known.totalChunkCount : Math.max(1, Math.floor(totalBytes / chunkSize));

    if (
      Number.isFinite(session.partSizeBytes) &&
      session.partSizeBytes > 0 &&
      Math.floor(session.partSizeBytes) !== chunkSize
    ) {
      throw new PermanentPublishError(
        `Parça boyutu çelişiyor: init ${chunkSize} baytlık parça bildirdi, oturum ` +
          `${Math.floor(session.partSizeBytes)} diyor. chunk_size init'te SABİTLENİR; ` +
          "değiştirmek Content-Range aritmetiğini bozar. Yükleme baştan başlatılmalıdır.",
        "validation",
        "chunk_size_mismatch",
      );
    }
    // Çapraz denetim: süreç yeniden başlamışsa harita boştur ve plan türetilir.
    // Motorun yazdığı `totalParts` ile türetilen sayı tutmuyorsa parça boyutu
    // yanlış demektir; yanlış ofset göndermek yerine dururuz.
    if (
      known === undefined &&
      session.totalParts !== null &&
      Number.isFinite(session.totalParts) &&
      Math.floor(session.totalParts) !== totalChunkCount
    ) {
      throw new PermanentPublishError(
        `Parça sayısı çelişiyor: oturum ${Math.floor(session.totalParts)} parça diyor, ` +
          `${totalBytes} bayt / ${chunkSize} bayt hesabı ${totalChunkCount} parça üretiyor. ` +
          "chunk_size init isteğinde sabitlendiği için bu oturumdan devam edilemez; " +
          "yükleme baştan başlatılmalıdır.",
        "validation",
        "chunk_count_mismatch",
      );
    }

    const uploaded = Math.max(0, Math.floor(session.uploadedParts));
    if (uploaded >= totalChunkCount) {
      // Tüm baytlar önceki turlarda gönderilmiş. Yeni istek YOK: parçayı tekrar
      // göndermek TikTok'ta sıra hatası üretir.
      return { uploadedParts: totalChunkCount, totalParts: totalChunkCount, done: true, nextOffset: null };
    }

    const plan: TikTokChunkPlan = {
      chunkSize,
      totalChunkCount,
      single: totalChunkCount === 1,
      problem: null,
    };
    const range = chunkRange(plan, totalBytes, uploaded);
    const body = await this.openRange({
      storageKey,
      offset: range.offset,
      length: range.length,
    });

    let response: TikTokHttpResponse;
    try {
      response = await this.client.send({
        method: "PUT",
        // ⚠️ Adres AYNEN kullanılır: `upload_url` imzalıdır ve sorgu
        // parametreleri (X-Amz-* imzaları) parçaya bağlıdır. Yeniden kurmak
        // ("base + path") imzayı geçersiz kılar.
        url: session.uploadUrl,
        headers: {
          "content-type": TIKTOK_CHUNK_CONTENT_TYPE,
          "content-length": String(range.length),
          "content-range": range.contentRange,
        },
        body,
        timeoutMs: this.uploadTimeoutMs,
      });
    } catch (err) {
      // Zaman aşımı dahil HİÇBİR ilerleme bildirilmez: motor `uploadedParts`'i
      // güncellemez ve aynı parça yeniden gönderilir.
      throw asPublishTransportError(err, `Parça gönderilemedi (parça ${uploaded + 1})`);
    }

    if (response.status >= 200 && response.status < 300) {
      const nextOffset = range.offset + range.length;
      return {
        uploadedParts: uploaded + 1,
        totalParts: totalChunkCount,
        done: response.status === 201 || range.final,
        nextOffset: response.status === 201 || range.final ? null : nextOffset,
      };
    }

    throw classifyTikTokFailure(response, `Parça reddedildi (parça ${uploaded + 1}/${totalChunkCount})`, {
      upload: true,
    });
  }

  // ── pollPublish ──────────────────────────────────────────────────────────

  /**
   * `status/fetch` → durum.
   *
   *   `PROCESSING_UPLOAD` / `PROCESSING_DOWNLOAD` / `SEND_TO_USER_INBOX`
   *       → `processing` + `retryAfterMs`. Aralık 5 sn, HIZ SINIRININ (30/dk)
   *       altında; sağlayıcı `Retry-After` gönderse bile 2 sn'nin altına
   *       indirilmez (doküman bu başlığı hiç anlatmadığı için başlığa
   *       güvenilmez, üstel geri çekilme motorun işidir).
   *   `PUBLISH_COMPLETE` → `published`. `remoteId` =
   *       `publicaly_available_post_id`, yoksa `video_id`. **`permalink: null`**
   *       — TikTok `share_url` DÖNMEZ; motor `published_no_link`'a çevirir.
   *   `FAILED` → `mapTikTokFailReason(fail_reason)` ile sınıflandırılır ve
   *       `PollResult.error` olarak DÖNER (motor işi kapatır).
   *
   * `uploadUrlExpiresAt` KONTROLÜ YAPILMAZ (Instagram bunu yapıyor): TikTok
   * baytlar alındıktan SONRA işlemeyi kendi tarafında sürdürür; `upload_url`
   * yalnız bayt göndermeyi düzenler. Süresi dolmuş bir adres, dolmuş bir
   * yayını "başarısız" yapmaz — yoklama `FAILED` bildirirse zaten yakalanır.
   */
  async pollPublish(ctx: PollContext): Promise<PollResult> {
    this.counts.poll += 1;
    const publishId = ctx.externalId;
    if (typeof publishId !== "string" || publishId.trim() === "") {
      throw new PermanentPublishError(
        "TikTok yoklaması publish_id olmadan yapılamaz (externalId boş). Yüklenmemiş " +
          "bir yayın yoklanamaz; kalıcı hata.",
        "validation",
        "unknown_external_id",
      );
    }

    const response = await this.send({
      method: "POST",
      url: statusFetchUrl(this.apiBase),
      what: "Yayın durumu okunamadı (status/fetch)",
      account: ctx.account,
      body: buildStatusBody(publishId),
    });
    if (!response.ok) throw classifyTikTokFailure(response, "Yayın durumu okunamadı");

    const view = readStatusView(response.json);
    const status = view.status;

    if (status !== null && TIKTOK_PROCESSING_STATUSES.includes(status)) {
      return {
        state: assertReachable("processing"),
        retryAfterMs: this.pollDelay(response.retryAfterMs),
        providerStatus: status,
      };
    }

    if (status === TIKTOK_PUBLISHED_STATUS) {
      const remoteId = view.publicPostId ?? view.videoId ?? publishId;
      // `share_url` TikTok API'sinde YOKTUR. Permalink için `/v2/video/query/`
      // (`video.list`) gerekir ve o da yalnız herkese açık içerik için döner.
      return {
        state: assertReachable("published"),
        remoteId,
        permalink: null,
        providerStatus: status,
      };
    }

    if (status === "FAILED") {
      const mapping = mapTikTokFailReason(view.failReason);
      return {
        state: assertReachable("processing"),
        providerStatus: `FAILED:${mapping.providerCode === "" ? "no_reason" : mapping.providerCode}`,
        error: toFailureLite(
          mapping.kind,
          `TikTok yayını başaramadı (status=FAILED, fail_reason="${
            view.failReason ?? "(yok)"
          }") — ${mapping.message}`,
          mapping.providerCode === "" ? null : mapping.providerCode,
          null,
        ),
      };
    }

    // Tanımsız durum: geçici SAYILMAZ. `unknown` + kalıcı hata; motor işi kapatır.
    return {
      state: assertReachable("processing"),
      providerStatus: status,
      error: toFailureLite(
        "unknown",
        `TikTok durumu okunamadı (status=${status ?? "(yok)"}) — bilinmeyen kod kalıcı ` +
          "kabul edildi, yeniden denenmedi.",
        status,
        null,
      ),
    };
  }

  // ── finalize ─────────────────────────────────────────────────────────────

  /**
   * `finalize` AĞ ÇAĞRISI YAPMAZ.
   *
   * Gerekçe: (a) geçici dosya yok — medya kalıcı anahtarda duruyor; (b) TikTok'ta
   * kapatılacak bir oturum YOKTUR (`publish_id` doğrudan `status/fetch` ile
   * sorgulanır); (c) her `DELETE` harcanan bir çağrıdır. Oturum kaydı yalnız süreç
   * belleğindedir, iş bitince unutulur.
   */
  async finalize(_input: PublishInput, _result: PollResult): Promise<void> {
    this.counts.finalize += 1;
  }

  // ── readQuota ────────────────────────────────────────────────────────────

  /**
   * **TikTok'ta yayın kotası okunabilir bir uç nokta YOKTUR.**
   *
   * Content Posting API'de `content_publishing_limit` benzeri bir sayaç yoktur;
   * Instagram'daki gibi anlık okuma yapılamaz. Bu yüzden:
   *   - **hiçbir sayı kodda sabit yazılmaz** (`null` döner), çünkü denetimsiz
   *     istemciler için günlük ~15 post kotası TÜM istemciler arasında
   *     PAYLAŞILIR ve hesaba özel DEĞİLDİR; sabit yazmak uydurma olurdu.
   *   - AĞ ÇAĞRISI YAPILMAZ: `null` döndürmek için istek atmak 20/dk
   *     `creator_info` kotasını boşa harcar.
   * - Motor `null` görünce yayını ENGELLEMEZ (kısıt zaten TikTok tarafında
   *     uygulanır); `null` yalnız "boşuna denemeyelim" ipucudur.
   * Aşılırsa TikTok `status/fetch` içinde `fail_reason:
   * "spam_risk_too_many_posts"` bildirir ve `mapTikTokFailReason` onu kalıcı
   * `quota` olarak sınıflandırır.
   */
  async readQuota(_account: AccountRef): Promise<QuotaSnapshot | null> {
    this.counts.quota += 1;
    return null;
  }

  // ── İç yardımcılar ───────────────────────────────────────────────────────

  /** Yoklama aralığı: sağlayıcı isteği ALT SINIRININ ALTINA çekilemez. */
  private pollDelay(retryAfterMs: number | null): number {
    if (retryAfterMs === null) return TIKTOK_STATUS_POLL_MS;
    return Math.max(TIKTOK_STATUS_POLL_MS, retryAfterMs);
  }

  /** Harita boşken türetilen parça boyutu (aynı `planChunks` kuralı). */
  private plannedChunkSize(totalBytes: number): number {
    const plan = planChunks(totalBytes, this.partSizeBytes);
    if (plan.problem !== null || !(plan.chunkSize > 0)) {
      throw new PermanentPublishError(plan.problem ?? "Parça planı hesaplanamadı.", "validation", "chunk_plan_invalid");
    }
    return plan.chunkSize;
  }

  private async send(input: {
    method: "GET" | "POST" | "DELETE";
    url: string;
    what: string;
    account: AccountRef;
    body?: Record<string, unknown>;
  }): Promise<TikTokHttpResponse> {
    let response: TikTokHttpResponse;
    try {
      response = await this.client.send({
        method: input.method,
        url: input.url,
        headers: {
          authorization: `Bearer ${input.account.accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
    } catch (err) {
      throw asPublishTransportError(err, input.what);
    }
    return response;
  }
}

// ── Saf yardımcılar ─────────────────────────────────────────────────────────

/** `storageKey|bytes|mimeType` — "aynı dosya mı" sorusunun tek yanıtı. */
export function mediaFingerprint(media: MediaRef): string {
  return `${media.storageKey}|${media.bytes}|${media.mimeType}`;
}

function toFailureLite(
  kind: PublishErrorKind,
  message: string,
  providerCode: string | null = null,
  httpStatus: number | null = null,
): PublishFailureLite {
  return { kind, message, providerCode, logId: null, httpStatus };
}

/** ISO metni geçmişte mi? Geçersiz/bozuk tarih "geçmişte" sayılmaz. */
export function isPast(iso: string | null | undefined, nowMs: number): boolean {
  if (typeof iso !== "string" || iso.trim() === "") return false;
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms <= nowMs;
}

/**
 * Adaptörün döndürdüğü her durum `processing`'den GEÇİLEBİLİR olmalıdır.
 * Motor durum makinesine göre yazıyor; bir kontrol sözleşmeyi bozan sonucu
 * motora değil burada durdurur.
 */
function assertReachable(next: JobState): JobState {
  if (next !== "processing" && !canTransition("processing", next)) {
    throw new PermanentPublishError(
      `TikTok adaptörü geçersiz iş durumu üretti: processing → ${next}.`,
      "validation",
      "illegal_state",
    );
  }
  return next;
}
