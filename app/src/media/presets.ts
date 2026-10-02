/**
 * Platforma özel dönüştürme profilleri — "hangi platform" bilgisini somut
 * sayılara çeviren TEK yer.
 *
 * NEDEN AYRI DOSYA: `specs/*.ts` bir platformun **ne kabul ettiğini** anlatır
 * (ve her satırı doğrulanmış/geçici olarak işaretlidir). Buradaki sayılar ise
 * **bizim ne ürettiğimizdir** — doğruluk iddiası taşımaz, bizim kararımızdır.
 * İkisini birleştirmek ("kabul edilen en küçük değer bizim hedefimizdir")
 * ya gereksiz yere küçültür ya da platform sınırını ürün hedefi sanmaya yol
 * açar; bu yüzden ayrı tutulur.
 *
 * SAYILARIN KAYNAĞI:
 *   - instagram: 300 MB dosya sınırı + 25 Mbps video sınırı (doğrulanmış),
 *     1080x1920 kadraj, 6 Mbps hedef, AAC 128k/48kHz (doğrulanmış sınırın içinde).
 *   - tiktok: 4 GB tek parça sınırı (doğrulanmış), 1080x1920, 10 Mbps.
 *   - youtube: 4K üstü oynatma kaldırıldı → 1080x1920, 12 Mbps; dosya boyutu
 *     platform sınırı DEĞİL, işletimsel tavan.
 *
 * `providerUploadUrlTtlSec` YANLIŞ ANLAŞILMAMALI: bu, SAĞLAYICININ bize verdiği
 * yükleme adresinin/konteynerinin ömrüdür (TikTok `upload_url` 1 saat, IG
 * `REELS` konteyneri 24 saat). Bizim kendi medya adresimizin ömrü için
 * `MediaStore.publicUrl({ ttlSec })` kullanılır — ikisi karıştırılamaz.
 */
import type { Platform } from "../contract/index.js";
import type { TranscodePreset } from "../ports/index.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Instagram dosya sınırı (doğrulanmış): 300 MB. */
export const INSTAGRAM_MAX_BYTES = 300 * MB;
/** TikTok tek parça sınırı (doğrulanmış): 4 GB. */
export const TIKTOK_MAX_BYTES = 4 * GB;
/** YouTube için işletimsel tavan — platform sınırı DEĞİLDİR. */
export const YOUTUBE_MAX_BYTES = 4 * GB;

/** IG `/{ig-user-id}/media` ile açılan REELS konteynerinin ömrü: 24 saat. */
export const INSTAGRAM_CONTAINER_TTL_SEC = 86_400;
/** TikTok `upload_url` geçerlilik süresi: 1 saat. */
export const TIKTOK_UPLOAD_URL_TTL_SEC = 3_600;

/**
 * Dönüştürme profilinin alt sınırı: bunun altında videonun kalitesi çöpe
 * dönüşür. Boyut bütçesini bu değere küçültürüz ama `withinLimits: false`
 * yerine sahte bir başarı üretmeyiz.
 */
export const MIN_VIDEO_BITRATE_KBPS = 200;

/**
 * Profil tablosu. `getPreset` **kopya** döndürür: çağıran preset'i
 * mutasyona uğratırsa bir sonraki iş, başka platformun sınırlarıyla kodlanır.
 */
const PRESETS: Record<Platform, TranscodePreset> = {
  instagram: {
    platform: "instagram",
    maxWidth: 1080,
    maxHeight: 1920,
    maxBytes: INSTAGRAM_MAX_BYTES,
    // 25 Mbps resmî üst sınırın belirgin altında; 6 Mbps 1080x1920 için fazlasıyla yeterli.
    videoBitrateKbps: 6000,
    // IG: AAC, en çok 48 kHz, 128 kbps.
    audioBitrateKbps: 128,
    fps: 30,
    container: "mp4",
    providerUploadUrlTtlSec: INSTAGRAM_CONTAINER_TTL_SEC,
  },
  tiktok: {
    platform: "tiktok",
    maxWidth: 1080,
    maxHeight: 1920,
    maxBytes: TIKTOK_MAX_BYTES,
    videoBitrateKbps: 10_000,
    audioBitrateKbps: 128,
    fps: 30,
    container: "mp4",
    providerUploadUrlTtlSec: TIKTOK_UPLOAD_URL_TTL_SEC,
  },
  youtube: {
    platform: "youtube",
    maxWidth: 1080,
    maxHeight: 1920,
    maxBytes: YOUTUBE_MAX_BYTES,
    videoBitrateKbps: 12_000,
    audioBitrateKbps: 128,
    fps: 30,
    container: "mp4",
    // YouTube resumable upload adresinde yayınlanmış bir süre yok → null.
    providerUploadUrlTtlSec: null,
  },
};

/** Platformun dönüştürme profili (kopyası). */
export function getPreset(platform: Platform): TranscodePreset {
  const preset = PRESETS[platform];
  if (!preset) throw new Error(`Bilinmeyen platform: ${String(platform)}`);
  return { ...preset };
}

/** Tüm profiller (kopya). Test ve panel listeleri için. */
export function allPresets(): TranscodePreset[] {
  return Object.keys(PRESETS).map((p) => getPreset(p as Platform));
}

/**
 * Boyut bütçesinden türetilen bitrate tavanı (kbps).
 *
 * `maxBytes` bir SÜREye göre anlamlıdır: 300 MB bir 3 saniyelik klipte lüks,
 * 15 dakikalık klipte imkânsızdır. Bu yüzden `maxBytes` içinden hedef bitrate
 * hesaplanır: `süre_bütçesi = maxBytes * 8 / 1000 / süre_saniye`.
 *
 * `durationSec` bilinmiyorsa yalnız presetin kendi hedefi kullanılır; sınır
 * aşımı sonradan `withinLimits` ile bildirilir.
 */
export function budgetBitrateKbps(
  preset: TranscodePreset,
  durationSec: number | null,
  safety = 0.95,
): number {
  const target = preset.videoBitrateKbps ?? Number.POSITIVE_INFINITY;
  if (durationSec === null || !(durationSec > 0) || !(preset.maxBytes > 0)) return target;
  const budget = (preset.maxBytes * 8) / 1000 / durationSec;
  const capped = Math.min(target, budget * safety);
  // Alt sınır yalnız bütçe GERÇEKTEN dar olduğunda devreye girer: bütçe
  // preset hedefinden genişse sonuç preset hedefidir (6000), 200 değil.
  return budget * safety < MIN_VIDEO_BITRATE_KBPS ? MIN_VIDEO_BITRATE_KBPS : capped;
}