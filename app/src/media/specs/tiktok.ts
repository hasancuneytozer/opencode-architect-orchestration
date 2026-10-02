/**
 * TikTok Content Posting API.
 *
 * DOĞRULAMA DURUMU: aşağıdaki sayılar **resmî dokümandan okundu**
 * (24 Ağustos 2026). `provisional: false` yalnız o satırlarda geçerlidir.
 *
 * KAYNAK NOTU: Değerler doğrulandı ama derin bağlantı yerine doküman kökü
 * yazıldı. Kök (`developers.tiktok.com/doc`) doğrudur, ancak bir sınır
 * değiştiğinde hangi sayfanın okunduğunu görebilmek için tam bağlantı
 * (`...?lang=en` ve video-specs sayfası) sonradan sabitlenmeli. Şimdilik bu
 * belirsizlik bilinçli olarak not düşülerek bırakıldı; `provisional: false`
 * demenin "sayı doğru" olduğu, "bağlantı sabit" olduğu anlamına gelmiyor.
 *
 * EN ÖNEMLİ NOKTA — ASPECT: TikTok'un Content Posting API dokümanında 9:16
 * oranı **zorunlu değildir**; API geniş kapsayıcı/çözünürlük kabul eder. Bu
 * uygulamanın ürün kararı 9:16 dikey reklam yayınlamaktır, ama bunu platform
 * sınırı diye sunmak yanlış olur. Bu yüzden `aspect_ratio` kuralı
 * `provisional: true` + `source: null` ile işaretlenir ve doğrulayıcı bunu
 * `warning` olarak üretip nedenini açıklar.
 */
import type { LimitRule, PlatformSpec } from "../../contract/index.js";
import {
  aspectWarningRule,
  audioCodecRule,
  captionRule,
  containerRule,
  fileSizeRule,
  fpsRule,
  pixelFormatRule,
  resolutionRule,
  videoCodecRule,
} from "./common.js";

/** Resmî doküman kökü. Derin bağlantı sabitlenmeli (yukarıdaki not). */
export const TIKTOK_DOCS = "https://developers.tiktok.com/doc/";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const MIN = 60;

/**
 * Yeniden denenmesi anlamlı olan durumlar. Retry politikası bunu kullanmalı;
 * 4xx (geçersiz istek) ve 403 (yetki) retry edilmemeli.
 */
export const TIKTOK_TRANSIENT_HTTP_STATUS: readonly number[] = [429, 500, 502, 503, 504];

/** Doğrulanan kurallar — hepsi `provisional: false`. */
const VERIFIED: Omit<LimitRule, "code" | "label" | "rule"> = {
  source: TIKTOK_DOCS,
  provisional: false,
};

export const tiktokSpec: PlatformSpec = {
  platform: "tiktok",
  label: "TikTok",
  // TikTok'un herkese açık Content Posting API'sinde "şimdi yayınla" ve
  // "belirli bir anda yayınla" yoktur; zamanlama bizim iş kuyruğumuzda.
  supportsNativeSchedule: false,
  // Doğrudan yükleme (init → upload → publish) destekleniyor; URL gerekmiyor.
  requiresPublicMediaUrl: false,
  supportsBinaryUpload: true,
  limits: [
    containerRule({
      ...VERIFIED,
      values: ["mp4", "webm", "mov"],
    }),
    videoCodecRule({
      ...VERIFIED,
      values: ["h264", "hevc", "vp8", "vp9"],
      note: "H.264 önerilir.",
    }),
    audioCodecRule({
      ...VERIFIED,
      values: ["aac", "mp3"],
    }),
    fpsRule({ ...VERIFIED, min: 23, max: 60 }),
    resolutionRule({ ...VERIFIED, platform: "tiktok", min: 360, max: 4096 }),
    // Yükleme sınırı 10 dakika. Akışta görünen içerik limiti 3 dakika olduğu
    // için ikinci bir kural daha var: ikisi de doğrulanmış.
    {
      code: "duration",
      label: "Süre (yükleme)",
      rule: "Video 3 saniye ile 10 dakika arasında olmalı.",
      min: 3,
      max: 10 * MIN,
      ...VERIFIED,
    },
    {
      code: "duration_in_feed",
      label: "Süre (akış)",
      rule: "Akışta görünen video en çok 3 dakika olabilir; 10 dakikalık yüklemeler akışta kısılır.",
      max: 3 * MIN,
      ...VERIFIED,
    },
    fileSizeRule({
      ...VERIFIED,
      maxBytes: 4 * GB,
      note: "Tek parça yüklemede sınır; parçalı yüklemede de dosya toplamı 4 GB'ı geçemez.",
    }),
    // Doğrulanmış: parça 5-64 MB, son parça 128 MB'ye kadar, 1-1000 parça,
    // parçalar SIRALI gönderilir (her parçanın id'si bir sonrakine girdidir).
    {
      code: "chunk_size",
      label: "Parça boyutu",
      rule: "Parça 5-64 MB olmalı; yalnızca son parça 128 MB'ye kadar olabilir. Parçalar sıralı gönderilir.",
      min: 5 * MB,
      max: 64 * MB,
      ...VERIFIED,
    },
    {
      code: "chunk_count",
      label: "Parça sayısı",
      rule: "Parça sayısı 1-1000 arasında olmalı.",
      min: 1,
      max: 1000,
      ...VERIFIED,
    },
    // Doğrulanmamış: dokümanda piksel biçimi zorunluluğu yok. 10-bit riskini
    // yine de bildirmek istediğimiz için kural var ama geçici işaretli.
    pixelFormatRule({ preferred: "yuv420p", source: TIKTOK_DOCS, provisional: true }),
    aspectWarningRule({
      note:
        "TikTok dokümanında aspect oranı zorunlu değildir; bu uygulama 9:16 dikey reklam " +
        "ürettiği için kadraj dışı kalan içerik uyarı üretir, hata değil.",
    }),
    captionRule({ ...VERIFIED, label: "Başlık/açıklama", max: 2200 }),
  ],
};

export function tiktokLimits(): LimitRule[] {
  return tiktokSpec.limits.map((l) => ({ ...l }));
}
