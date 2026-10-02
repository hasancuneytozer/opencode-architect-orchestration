/**
 * Instagram (Graph API / Content Publishing) — DOĞRULANMIŞ.
 *
 * DOĞRULAMA DURUMU: aşağıdaki sayılar resmî dokümandan okundu
 * (Graph API v26.0, Eylül 2026). `provisional: false` yalnız o satırlarda
 * geçerlidir ve `source` alanı her zaman doküman köküne işaret eder.
 *
 * DOĞRULANMAYAN KALMADI — `provisionalLimits("instagram")` boş döner. Bu
 * kural `test/media/specs.test.ts` içinde kilitlidir: yeni bir kural eklenirken
 * `source` uydurmak yerine `provisional: true` + `source: null` ile gelmelidir.
 *
 * YÜKLEME MODELİ (en sık yanlış anlaşılan nokta): Instagram'da herkese açık
 * medya URL'i gerekmez. Facebook Login (Instagram Login değil) yolunda
 * resumable upload vardır:
 *   1) POST https://graph.facebook.com/{GRAPH_API_VERSION}/{ig-user-id}/media
 *      gövde: upload_type=resumable & media_type=REELS → { id, uri }
 *   2) PUT/POST yarı parçalar RUPLOAD_BASE/{container_id} adresine
 *   3) POST /{ig-user-id}/media_publish { creation_id }
 * Bu yüzden `requiresPublicMediaUrl: false` ve `supportsBinaryUpload: true`.
 *
 * KAPSayıcı ŞARTI: moov atomu dosyanın BAŞINDA olmalı — `toFeedReady` bu yüzden
 * mp4 için `-movflags +faststart` uygular; bu bir tercih değil zorunluluktur.
 */
import type { LimitRule, PlatformSpec } from "../../contract/index.js";
import {
  audioCodecRule,
  captionRule,
  containerRule,
  fileSizeRule,
  fpsRule,
  pixelFormatRule,
  platformAspectRule,
  resolutionRule,
  videoCodecRule,
} from "./common.js";

const MB = 1024 * 1024;

/** Resmî doküman kökü. Tüm doğrulanmış sınırların kaynağı. */
export const INSTAGRAM_DOCS = "https://developers.facebook.com/documentation/instagram-platform";

/**
 * Graph API sürümü. v20.0 24 Eylül 2026'da kaldırıldı; sabit yazılmazsa
 * istekler "Unsupported get_request" hatasıyla düşer.
 */
export const GRAPH_API_VERSION = "v26.0";

/** Resumable upload ikinci aşamasının taban adresi (sürüm YOLDA değil). */
export const RUPLOAD_BASE = "https://rupload.facebook.com/ig-api-upload";

/** Doğrulanmış kurallar — hepsi `provisional: false`. */
const VERIFIED: Omit<LimitRule, "code" | "label" | "rule"> = {
  source: INSTAGRAM_DOCS,
  provisional: false,
};

export const instagramSpec: PlatformSpec = {
  platform: "instagram",
  label: "Instagram",
  // Graph API'de yayın anını belirleme yok; zamanlama bizim iş kuyruğumuzda.
  supportsNativeSchedule: false,
  // Resumable upload VAR (bkz. dosya başı) → ikili yükleme destekleniyor.
  supportsBinaryUpload: true,
  // Bu yüzden herkese açık URL şart DEĞİL.
  requiresPublicMediaUrl: false,
  limits: [
    containerRule({
      ...VERIFIED,
      values: ["mp4", "mov"],
      note: "moov atomu dosya başında olmalı (faststart); `toFeedReady` bunu uygular.",
    }),
    videoCodecRule({
      ...VERIFIED,
      values: ["h264", "hevc"],
      note: "Progressive, closed GOP, 4:2:0 olmalı.",
    }),
    audioCodecRule({
      ...VERIFIED,
      values: ["aac"],
      note: "En çok 48 kHz, 1-2 kanal, 128 kbps.",
    }),
    fpsRule({ ...VERIFIED, min: 23, max: 60 }),
    // Doküman yalnız "en çok 1920 yatay piksel" diyor; alt sınır yok.
    resolutionRule({ ...VERIFIED, platform: "instagram", max: 1920 }),
    {
      code: "video_bitrate",
      label: "Video bit hızı",
      rule:
        "En çok 25 Mbps (VBR). `toFeedReady` Instagram için 6 Mbps hedefler; " +
        "sınırı aşan çıktı yayına gönderilmez.",
      max: 25_000,
      ...VERIFIED,
    },
    {
      code: "duration",
      label: "Süre",
      rule: "3 saniye ile 15 dakika arasında olmalı.",
      min: 3,
      max: 15 * 60,
      ...VERIFIED,
    },
    fileSizeRule({ ...VERIFIED, maxBytes: 300 * MB }),
    // 4:2:0 (yuv420p) dokümanda video kodek şartının parçası olarak geçiyor.
    pixelFormatRule({ ...VERIFIED, preferred: "yuv420p" }),
    platformAspectRule({
      ...VERIFIED,
      min: 0.01,
      max: 10,
      recommended: "9:16 dikey (zorunlu değil, yalnızca önerilir)",
      note:
        "Instagram'da 9:16 dikey zorunlu DEĞİLDİR; 9:16 dışı dikey video hata değil uyarı üretir.",
    }),
    captionRule({ ...VERIFIED, label: "Açıklama", max: 2200 }),
    {
      code: "hashtag_count",
      label: "Hashtag sayısı",
      rule: "En çok 30 hashtag olabilir.",
      max: 30,
      ...VERIFIED,
    },
    {
      code: "mention_count",
      label: "Mention sayısı",
      rule: "En çok 20 mention (@kullanıcı) olabilir.",
      max: 20,
      ...VERIFIED,
    },
  ],
};

export function instagramLimits(): LimitRule[] {
  return instagramSpec.limits.map((l) => ({ ...l }));
}