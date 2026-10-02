/**
 * YouTube Data API v3 (videos.insert) / YouTube Shorts.
 *
 * DOĞRULAMA DURUMU (kısmen): yalnız aşağıdaki satırlar resmî dokümandan
 * doğrulandı ve `provisional: false` taşır:
 *   - kapsayıcı (mp4/webm/mov)
 *   - Shorts üst süre sınırı (3 dakika)
 *   - üst çözünürlük sınırı (3840 px; 4K-8K oynatma desteği 2022'de kaldırıldı)
 *   - `status.publishAt` ön koşulu (aşağıda `NATIVE_SCHEDULE_NOTE`)
 * Geri kalan kurallar (fps, kodek listeleri, piksel biçimi, dosya boyutu, metin
 * uzunlukları) DOĞRULANMADI: `provisional: true` + `source: null` ile dururlar.
 * "Muhtemelen doğru" bir sayı "doğrulanmış" gibi sunulmaz.
 *
 * EN ÖNEMLİ KURAL — 3 DAKİKA: Shorts en çok 3 dakikadır (eski 60 saniye sınırı
 * kaldırıldı). 3 dakikayı aşan bir video Shorts SAYILMAZ; ayrıca aktif bir
 * Content ID iddiası (claim) varsa 3 dakikayı aşan içerik global olarak
 * engellenir. Doğrulayıcı bu eşiği `error` üretir.
 *
 * KOTA: kota kullanıcı/kanal seviyesindedir, medya doğrulamasında kullanılmaz.
 * Doğrulanmış birim değerleri yayıncı adaptörü için `YOUTUBE_QUOTA_UNITS`
 * altında dışa açıldı.
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

const GB = 1024 * 1024 * 1024;

/** Doğrulanmış kuralların kaynağı. */
export const YOUTUBE_DOCS = "https://developers.google.com/youtube/v3";

/** Data API taban adresi (sürüm yolda). */
export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

/**
 * `status.publishAt` ön koşulu — doğrulayıcı bu bilgiyi `info` olarak
 * bildirir (`validate.ts`, kod `native_schedule`).
 */
export const NATIVE_SCHEDULE_NOTE =
  "status.publishAt YALNIZCA privacyStatus=private ile birlikte ve video daha önce " +
  "hiç yayınlanmamışken geçerlidir; aksi halde video hemen yayınlanır.";

/** Doğrulanmış kota birimleri (v3, 2026). */
export const YOUTUBE_QUOTA_UNITS = {
  insert: 1,
  update: 50,
  setThumbnail: 50,
} as const;

/** `videos.insert` için ayrı kova: günde 100 çağrı. */
export const YOUTUBE_INSERT_DAILY_CALL_BUCKET = 100;

/** Çok parçalı yüklemede parça 256 KB'nin KATI olmalı. */
export const YOUTUBE_RESUMABLE_CHUNK_BYTES = 256 * 1024;

/** 2026'da sadeleşen `video.definition` değerleri. */
export const YOUTUBE_DEFINITION_VALUES = ["sd", "hd"] as const;

/** Doğrulanmış kurallar. */
const VERIFIED: Omit<LimitRule, "code" | "label" | "rule"> = {
  source: YOUTUBE_DOCS,
  provisional: false,
};

/**
 * DOĞRULANMADI: resmî dokümandan okunamadı. `source: null` bilinçlidir —
 * uydurulan bir bağlantı, olmayan bir kaynağın işareti olur.
 */
const UNVERIFIED: Omit<LimitRule, "code" | "label" | "rule"> = {
  source: null,
  provisional: true,
};

export const youtubeSpec: PlatformSpec = {
  platform: "youtube",
  label: "YouTube",
  // `status.publishAt` ile zamanlama var; ön koşul `NATIVE_SCHEDULE_NOTE`.
  supportsNativeSchedule: true,
  // Resumable upload ile doğrudan gövde gönderiliyor; URL zorunlu değil.
  requiresPublicMediaUrl: false,
  supportsBinaryUpload: true,
  limits: [
    containerRule({ ...VERIFIED, values: ["mp4", "webm", "mov"] }),
    // DOĞRULANMADI: resmî doküman taranıyor
    videoCodecRule({
      ...UNVERIFIED,
      values: ["h264", "vp9", "av1"],
      note: "Tahmin: bu liste dokümandan teyit edilmedi.",
    }),
    // DOĞRULANMADI: resmî doküman taranıyor
    audioCodecRule({
      ...UNVERIFIED,
      values: ["aac", "opus", "vorbis", "mp3"],
      note: "Tahmin: bu liste dokümandan teyit edilmedi.",
    }),
    // DOĞRULANMADI: resmî doküman taranıyor
    fpsRule({ ...UNVERIFIED, min: 24, max: 60 }),
    // DOĞRULANMIŞ: 4K üstü (4320p) oynatma desteği 2022'de kaldırıldı.
    // Alt sınır doğrulanmadı → yalnız üst sınır kondu.
    resolutionRule({
      ...VERIFIED,
      platform: "youtube",
      max: 3840,
      label: "Çözünürlük (üst sınır)",
    }),
    {
      code: "duration",
      label: "Süre (Shorts)",
      rule:
        "Shorts için en çok 3 dakika (180 saniye). Daha uzun videolar Shorts sayılmaz; " +
        "aktif bir Content ID iddiası (claim) varsa 3 dakikayı aşan içerik global olarak engellenir.",
      max: 180,
      ...VERIFIED,
    },
    // DOĞRULANMADI: resmî sınır çok daha yüksek; buradaki 4 GB işletimsel tavan.
    fileSizeRule({
      ...UNVERIFIED,
      maxBytes: 4 * GB,
      note: "Platform sınırı değil, işletimsel tavan.",
    }),
    // DOĞRULANMADI: resmî doküman taranıyor
    pixelFormatRule({ ...UNVERIFIED, preferred: "yuv420p" }),
    aspectWarningRule({ note: "Shorts kare ya da dikey kabul eder; bu uygulama 9:16 dikey üretir." }),
    // DOĞRULANMADI: resmî doküman taranıyor
    captionRule({ ...UNVERIFIED, label: "Açıklama", max: 5000 }),
    {
      code: "title_length",
      label: "Başlık",
      rule: "Başlık en çok 100 karakter olabilir.",
      max: 100,
      ...UNVERIFIED,
    },
  ],
};

export function youtubeLimits(): LimitRule[] {
  return youtubeSpec.limits.map((l) => ({ ...l }));
}