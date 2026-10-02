/**
 * Medya doğrulayıcı. SAF FONKSİYON: dosya okumaz, ağa çıkmaz, ffmpeg çağırmaz.
 * Girdi `MediaInfo` + `PlatformSpec`, çıktı `ValidationFinding[]`. Bu sayede
 * aynı kurallar sunucuda, iş kuyruğunda ve panelde aynı sonucu üretir ve test
 * gerçek videoya ihtiyaç duymadan yazılabilir.
 *
 * BULGU KODLARI STABİLDİR — panel ve yayıncı adaptörleri bu dizgileri
 * anahtar olarak kullanır, bu yüzden isim değiştirilmemeli:
 *   aspect_ratio, orientation, resolution, width, height, container,
 *   video_codec, audio_codec, pixel_format, fps_range, duration_min,
 *   duration_max, file_size, no_audio, unreadable, native_schedule
 *
 * SEVİYE POLİTİKASI:
 *   error   = yayınlamayı engelleyen durum (kapsayıcı/kodek yok, 9:16 değil)
 *   warning = yayınlanabilir ama riskli (10-bit piksel, 4K, sessiz TikTok)
 *   info    = bilgilendirme (sessiz video, sessizlik bir sorun değil)
 *
 * GEÇİCİ SINIRLAR: `provisional: true` bir kural ihlal edildiğinde bulgu
 * `warning` seviyesine indirilir ve mesajın sonuna
 * "(sınır henüz doğrulanmadı)" eklenir. Kullanıcı, doğrulanmamış bir sayı
 * yüzünden yayını kaybetmemeli; ama sınır da sessizce gizlenmemeli.
 */
import { ASPECT_TOLERANCE, TARGET_ASPECT, isVertical } from "../contract/index.js";
import type { MediaInfo, Platform, PlatformSpec, Severity, ValidationFinding } from "../contract/index.js";
import { ASPECT_MAX, ASPECT_MIN, PREFERRED_PIXEL_FORMAT, findLimit } from "./specs/common.js";

export const PROVISIONAL_SUFFIX = "(sınır henüz doğrulanmadı)";

export interface ValidateOptions {
  /**
   * `provisional: true` sınırlar ihlalinde `error` yerine `warning` üretilsin mi?
   *
   * VARSAYILAN `false` — yani geçici sınır ihlali de hata sayılır. Sebep:
   * doğrulanmamış olmak, kuralın YANLIŞ olduğu anlamına gelmez; kapsayıcı ya da
   * kodek gerçekten kabul edilmeyebilir ve "warning" gördüğü için yükleyen
   * yayına devam edip platformda reddedilir. Doğrulanmamışlık mesajda bellidir,
   * kapıda değil. Yumuşak kapı isteyen çağıran `true` geçebilir.
   */
  downgradeProvisional?: boolean;
  /** Bulgu metnine "(sınır henüz doğrulanmadı)" eklensin mi? Varsayılan true. */
  annotateProvisional?: boolean;
  /** `false` ise hiçbir bulgu üretilmez (hızlı ön eleme). */
  enabled?: boolean;
}

/**
 * 9:16'nın platformlar arasında ZORUNLU olup olmadığı burada sabittir.
 *
 * DOĞRULAMA SONUCU (Eylül 2026):
 *   - TikTok: Content Posting API dokümanında aspect şartı YOK → uyarı.
 *   - Instagram: zorunlu oran aralığı **0.01:1 - 10:1**, 9:16 yalnızca
 *     ÖNERİLİR. 9:16 dışı bir dikey video reddedilmez → uyarı, hata DEĞİL.
 *   - YouTube: Shorts için kare ya da dikey olması gerekir; 9:16 bu uygulamanın
 *     ÜRÜN kararıdır (platform zorunluluğu değil) ve hata olarak işaretlenir.
 */
const ASPECT_IS_HARD_REQUIREMENT: Record<Platform, boolean> = {
  tiktok: false,
  instagram: false,
  youtube: true,
};

/**
 * `ASPECT_IS_HARD_REQUIREMENT[platform] === false` iken mesajda kullanılacak
 * GEREKÇE. Mesaj "TikTok'ta çalışır" deyip başka platformda da aynı cümleyi
 * koyarsa kullanıcı yanlış belgeye atıf yapmış olur.
 */
const ASPECT_NOT_HARD_NOTE: Record<Platform, string> = {
  tiktok: "TikTok dokümanında aspect oranı zorunlu değildir,",
  instagram:
    "Instagram dokümanında aspect oranı zorunlu değildir (zorunlu aralık 0.01:1-10:1, 9:16 yalnızca önerilir),",
  youtube: "YouTube Shorts için kare ya da dikey kabul edilir,",
};

/**
 * Sağlayıcının kendi yayın zamanlaması varsa kullanıcıya söylenmesi gereken
 * ön koşul. `supportsNativeSchedule: true` tek başına "zamanlama çalışır"
 * anlamına gelmez: YouTube'da `status.publishAt` yalnızca `privacyStatus=private`
 * ile birlikte ve video daha önce hiç yayınlanmamışken geçerlidir; koşul
 * sağlanmazsa video HEMEN yayınlanır (sessizce yanlış tarih gösterir).
 */
const NATIVE_SCHEDULE_CAVEAT: Record<Platform, string | null> = {
  tiktok: null,
  instagram: null,
  youtube:
    "YouTube'da zamanlama status.publishAt ile yapılır; bu alan YALNIZCA " +
    "privacyStatus=private ile birlikte ve video daha önce hiç yayınlanmamışken " +
    "geçerlidir, aksi halde video zamanlanmadan hemen yayınlanır.",
};

/** Sessiz video hangi platformda gerçekten sorun? */
const NO_AUDIO_SEVERITY: Record<Platform, Severity> = {
  tiktok: "warning",
  instagram: "info",
  youtube: "info",
};

function annotate(message: string, provisional: boolean, opts: ValidateOptions): string {
  if (!provisional || opts.annotateProvisional === false) return message;
  return `${message} ${PROVISIONAL_SUFFIX}`;
}

function severityFor(
  base: Severity,
  provisional: boolean,
  opts: ValidateOptions,
): Severity {
  // Varsayılan: geçici sınır ihlali de hatadır. Yalnız çağıran açıkça
  // isterse (`downgradeProvisional: true`) yumuşar.
  if (provisional && opts.downgradeProvisional === true && base === "error") {
    return "warning";
  }
  return base;
}

function within(value: number, min: number | undefined, max: number | undefined): boolean {
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${Math.round((mb / 1024) * 100) / 100} GB`;
  if (mb >= 1) return `${Math.round(mb * 10) / 10} MB`;
  return `${bytes} B`;
}

/** `mov,mp4,m4a,3gp` -> gerçekten mp4 mü? Alt dizin bazlı, tahmin değil. */
function containerIncludes(container: string | null, accepted: string[]): boolean {
  if (!container) return false;
  const tokens = container
    .toLowerCase()
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return accepted.some((a) => tokens.includes(a.toLowerCase()));
}

/**
 * ANA DOĞRULAMA. Sıra önemli: önce "okunabilir mi", sonra format uyumu, en
 * sonda ölçü sınırları. Böylece okunamayan bir dosya için anlamsız onlarca
 * bulgu üretilmez.
 */
export function validateMedia(
  info: MediaInfo,
  spec: PlatformSpec,
  opts: ValidateOptions = {},
): ValidationFinding[] {
  if (opts.enabled === false) return [];
  const findings: ValidationFinding[] = [];
  const platform = spec.platform;
  const limits = spec.limits;

  // ── 1. Okunabilirlik ────────────────────────────────────────────────────
  // "Süre 0 + ses yok" tanımı gereği bozuk/boş dosyadır; ölçü bulguları
  // anlamsızlaşır, tek net hata yeter.
  const duration = info.durationSec;
  if (!info.hasAudio && (duration === null || duration <= 0)) {
    findings.push({
      code: "unreadable",
      severity: "error",
      message:
        "Dosya okunabilir görünmüyor: video akışı yok ve süre sıfır. " +
        "Dosya bozuk olabilir veya desteklenmeyen bir kapsayıcı olabilir.",
      observed: `${fmtBytes(info.bytes)}, süre ${duration === null ? "bilinmiyor" : `${fmt(duration)} sn`}`,
    });
    return findings;
  }

  if (info.width === null || info.height === null || info.width <= 0 || info.height <= 0) {
    findings.push({
      code: "resolution",
      severity: "error",
      message: "Video kare boyutu okunamadı (genişlik/yükseklik eksik).",
      observed: `${info.width ?? "?"}x${info.height ?? "?"}`,
    });
  }

  // ── 1b. Sağlayıcıya bırakılan zamanlama ─────────────────────────────────
  // Bilgi seviyesinde: kapıyı kapatmaz ama "zamanlama çalışmaz" yanılgısını
  // önler. Ön koşul sağlanmazsa yayın anı sessizce şimdiye kayar.
  const scheduleCaveat = NATIVE_SCHEDULE_CAVEAT[platform];
  if (spec.supportsNativeSchedule && scheduleCaveat) {
    findings.push({
      code: "native_schedule",
      severity: "info",
      message: scheduleCaveat,
      observed: "supportsNativeSchedule=true",
    });
  }

  // ── 2. Kadraj (9:16) ────────────────────────────────────────────────────
  if (info.width && info.height && info.width > 0 && info.height > 0) {
    const ratio = info.width / info.height;
    const vertical = isVertical(info);
    const onTarget = ratio >= ASPECT_MIN && ratio <= ASPECT_MAX;
    const drift = (ratio - TARGET_ASPECT) / TARGET_ASPECT;
    const aspectLimit = findLimit(limits, "aspect_ratio");
    const provisional = aspectLimit?.provisional ?? true;
    const hard = ASPECT_IS_HARD_REQUIREMENT[platform];

    if (!onTarget) {
      // Severity BURADA politika tablosundan gelir ve `downgradeProvisional`
      // uygulanmaz: 9:16 kadraj kuralı platformun sınırı değil, ürün kararıdır.
      // Doğrulanmamışlık yine de mesajın sonuna yazılır.
      const base: Severity = hard ? "error" : "warning";
      findings.push({
        code: "aspect_ratio",
        severity: base,
        message: annotate(
          vertical
            ? `Dikey ama 9:16 değil: ${info.width}x${info.height} (oran ${fmt(ratio)}, ` +
                `hedef ${fmt(TARGET_ASPECT)}, sapma yüzde ${fmt(drift * 100)}). ` +
                (hard
                  ? "Bu uygulama 9:16 dikey reklam yayınlar; kadraj yeniden kurulmalı."
                  : `${ASPECT_NOT_HARD_NOTE[platform]} bu yüzden hata değil uyarıdır; ` +
                    "yine de akışta 9:16 dikey görünüm en iyi sonucu verir.")
            : `Yatay video: ${info.width}x${info.height} (oran ${fmt(ratio)}). ` +
                (hard
                  ? "Bu uygulama yalnız dikey 9:16 reklam yayınlar; yatay video kırpılarak dikey hâle getirilmelidir."
                  : `${ASPECT_NOT_HARD_NOTE[platform]} bu yüzden hata değil uyarıdır; ` +
                    "yine de bu uygulamanın dikey reklam kadrajına uymaz."),
          provisional,
          opts,
        ),
        limit: aspectLimit?.rule,
        observed: `${info.width}x${info.height}`,
      });
    } else if (vertical) {
      // 9:16 hedefinde ama tam değil (ör. 320x568): bilgi, hata değil.
      findings.push({
        code: "aspect_ratio",
        severity: "info",
        message:
          `9:16'ya toleranslı yakın (${info.width}x${info.height}, sapma yüzde ` +
          `${fmt(drift * 100)}; tolerans yüzde ${fmt(ASPECT_TOLERANCE * 100)}).`,
        observed: `${info.width}x${info.height}`,
      });
    }
  }

  // ── 3. Kapsayıcı ve kodekler ───────────────────────────────────────────
  const containerLimit = findLimit(limits, "container");
  if (containerLimit?.enumValues) {
    const accepted = containerLimit.enumValues.map(String);
    const ok = containerIncludes(info.container, accepted);
    if (!ok) {
      findings.push({
        code: "container",
        severity: severityFor("error", containerLimit.provisional, opts),
        message: annotate(
          `Kapsayıcı kabul edilmiyor: ${info.container ?? "bilinmiyor"}. ` +
            `Beklenen: ${accepted.join(", ")}.`,
          containerLimit.provisional,
          opts,
        ),
        limit: containerLimit.rule,
        observed: info.container ?? "bilinmiyor",
      });
    }
  }

  const videoCodecLimit = findLimit(limits, "video_codec");
  if (videoCodecLimit?.enumValues) {
    const accepted = videoCodecLimit.enumValues.map((v) => String(v).toLowerCase());
    const codec = info.videoCodec?.toLowerCase() ?? null;
    if (!codec) {
      findings.push({
        code: "video_codec",
        severity: "error",
        message: "Video kodeki okunamadı.",
      });
    } else if (!accepted.includes(codec)) {
      findings.push({
        code: "video_codec",
        severity: severityFor("error", videoCodecLimit.provisional, opts),
        message: annotate(
          `Video kodeki desteklenmiyor: ${codec}. Beklenen: ${accepted.join(", ")}. ` +
            "`toFeedReady` ile H.264'e dönüştürülebilir.",
          videoCodecLimit.provisional,
          opts,
        ),
        limit: videoCodecLimit.rule,
        observed: codec,
      });
    }
  }

  // ── 4. Ses ─────────────────────────────────────────────────────────────
  const audioCodecLimit = findLimit(limits, "audio_codec");
  if (audioCodecLimit?.enumValues && info.hasAudio) {
    const accepted = audioCodecLimit.enumValues.map((v) => String(v).toLowerCase());
    const codec = info.audioCodec?.toLowerCase() ?? null;
    if (codec && !accepted.includes(codec)) {
      findings.push({
        code: "audio_codec",
        severity: severityFor("warning", audioCodecLimit.provisional, opts),
        message: annotate(
          `Ses kodeki beklenen listede değil: ${codec}. Beklenen: ${accepted.join(", ")}.`,
          audioCodecLimit.provisional,
          opts,
        ),
        limit: audioCodecLimit.rule,
        observed: codec,
      });
    }
  }

  if (!info.hasAudio) {
    findings.push({
      code: "no_audio",
      severity: NO_AUDIO_SEVERITY[platform],
      message:
        platform === "tiktok"
          ? "Ses akışı yok. TikTok'ta sessiz video reddedilebilir; sessiz reklam da risklidir."
          : "Ses akışı yok. Teknik olarak yayınlanabilir, ancak sessiz reklam dikkat çekmeyebilir.",
      observed: "hasAudio=false",
    });
  }

  // ── 5. Piksel biçimi ───────────────────────────────────────────────────
  const pixLimit = findLimit(limits, "pixel_format");
  if (pixLimit && info.pixelFormat) {
    const accepted = (pixLimit.enumValues ?? [PREFERRED_PIXEL_FORMAT]).map((v) =>
      String(v).toLowerCase(),
    );
    if (!accepted.includes(info.pixelFormat.toLowerCase())) {
      // error DEĞİL: dosya çalışıyor, sadece bazı cihazlarda bozulma riski var.
      findings.push({
        code: "pixel_format",
        severity: severityFor("warning", pixLimit.provisional, opts),
        message: annotate(
          `Piksel biçimi ${info.pixelFormat}; ${PREFERRED_PIXEL_FORMAT} tercih edilir ` +
            "(yüksek bit derinliği bazı telefonlarda siyah çıkar).",
          pixLimit.provisional,
          opts,
        ),
        limit: pixLimit.rule,
        observed: info.pixelFormat,
      });
    }
  }

  // ── 6. Kare hızı ───────────────────────────────────────────────────────
  const fpsLimit = findLimit(limits, "fps");
  if (fpsLimit && info.fps !== null) {
    if (!within(info.fps, fpsLimit.min, fpsLimit.max)) {
      findings.push({
        code: "fps_range",
        severity: severityFor("error", fpsLimit.provisional, opts),
        message: annotate(
          `Kare hızı ${fmt(info.fps)} fps; ${fpsLimit.min}-${fpsLimit.max} aralığında olmalı.`,
          fpsLimit.provisional,
          opts,
        ),
        limit: fpsLimit.rule,
        observed: fmt(info.fps),
      });
    }
  } else if (fpsLimit && info.fps === null) {
    findings.push({
      code: "fps_range",
      severity: "warning",
      message: "Kare hızı okunamadı; doğrulama yapılamadı.",
    });
  }

  // ── 7. Çözünürlük (her iki eksen) ───────────────────────────────────────
  const resLimit = findLimit(limits, "resolution");
  if (resLimit && info.width && info.height) {
    const wOk = within(info.width, resLimit.min, resLimit.max);
    const hOk = within(info.height, resLimit.min, resLimit.max);
    if (!wOk && !hOk) {
      findings.push({
        code: "resolution",
        severity: severityFor("error", resLimit.provisional, opts),
        message: annotate(
          `Çözünürlük ${info.width}x${info.height}; her iki eksende ` +
            `${resLimit.min ?? "-"}-${resLimit.max ?? "-"} px aralığında olmalı.`,
          resLimit.provisional,
          opts,
        ),
        limit: resLimit.rule,
        observed: `${info.width}x${info.height}`,
      });
    } else if (!wOk || !hOk) {
      const axis = wOk ? "height" : "width";
      const value = wOk ? info.height : info.width;
      findings.push({
        code: axis,
        severity: severityFor("error", resLimit.provisional, opts),
        message: annotate(
          `${axis === "width" ? "Genişlik" : "Yükseklik"} ${value}px; ` +
            `${resLimit.min ?? "-"}-${resLimit.max ?? "-"} px aralığında olmalı.`,
          resLimit.provisional,
          opts,
        ),
        limit: resLimit.rule,
        observed: `${axis}=${value}`,
      });
    }
  }

  // ── 8. Süre ───────────────────────────────────────────────────────────
  // `duration` ve `duration_in_feed` gibi tüm süre kodları aynı mantıkla
  // denetlenir: platform birden çok süre sınırı koyabiliyor.
  for (const limit of limits) {
    if (!/^duration($|_)/.test(limit.code)) continue;
    if (duration === null) {
      findings.push({
        code: "duration_max",
        severity: "warning",
        message: "Süre okunamadı; bu sınır denetlenemedi.",
        limit: limit.rule,
      });
      continue;
    }
    if (duration <= 0) {
      findings.push({
        code: "duration_min",
        severity: "error",
        message: "Süre sıfır; dosya boş veya okunamıyor.",
        limit: limit.rule,
        observed: fmt(duration),
      });
      continue;
    }
    if (duration < (limit.min ?? Number.NEGATIVE_INFINITY)) {
      findings.push({
        code: "duration_min",
        severity: severityFor("error", limit.provisional, opts),
        message: annotate(
          `Süre ${fmt(duration)} sn çok kısa; en az ${limit.min} sn olmalı.`,
          limit.provisional,
          opts,
        ),
        limit: limit.rule,
        observed: fmt(duration),
      });
    }
    if (limit.max !== undefined && duration > limit.max) {
      findings.push({
        code: "duration_max",
        severity: severityFor("error", limit.provisional, opts),
        message: annotate(
          `Süre ${fmt(duration)} sn çok uzun; en çok ${limit.max} sn olmalı.`,
          limit.provisional,
          opts,
        ),
        limit: limit.rule,
        observed: fmt(duration),
      });
    }
  }

  // ── 9. Dosya boyutu ────────────────────────────────────────────────────
  const sizeLimit = findLimit(limits, "file_size");
  if (sizeLimit?.maxBytes !== undefined && info.bytes > sizeLimit.maxBytes) {
    findings.push({
      code: "file_size",
      severity: severityFor("error", sizeLimit.provisional, opts),
      message: annotate(
        `Dosya ${fmtBytes(info.bytes)}; en çok ${fmtBytes(sizeLimit.maxBytes)} olabilir.`,
        sizeLimit.provisional,
        opts,
      ),
      limit: sizeLimit.rule,
      observed: fmtBytes(info.bytes),
    });
  }

  return findings;
}

// ── Yardımcılar ───────────────────────────────────────────────────────────

export function hasErrors(findings: ValidationFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

export function errorsOf(findings: ValidationFinding[]): ValidationFinding[] {
  return findings.filter((f) => f.severity === "error");
}

export function warningsOf(findings: ValidationFinding[]): ValidationFinding[] {
  return findings.filter((f) => f.severity === "warning");
}

export function hasFinding(findings: ValidationFinding[], code: string): boolean {
  return findings.some((f) => f.code === code);
}

/** Tüm platformlar için doğrular: içerik platformlardan birine girsin. */
export function validateAllPlatforms(
  info: MediaInfo,
  specs: PlatformSpec[],
  opts: ValidateOptions = {},
): ValidationFinding[] {
  return specs.flatMap((spec) => validateMedia(info, spec, opts));
}
