/**
 * Üç platformda da TEKRAR EDEN kural şekilleri.
 *
 * Buradaki her şey bir "değer" değil, bir "kural kalıbı"dır: sayısal sınırı
 * çağıran platform verir. Amaç şu: aynı kavramı (fps aralığı, çözünürlük,
 * süre, dosya boyutu) üç yerde elle yazıp birinde güncellemeyi unutmamak.
 *
 * DÜRÜSTLÜK KURALI: `provisional` alanı kozmetik değil. `true` ise o sayı
 * resmî dokümandan okunmamış ya da okunamamış demektir. Doğrulayıcı, geçici
 * sınıra dayanan bulgunun mesajına "(sınır henüz doğrulanmadı)" ekler.
 * Yanlış güven, olmayan sınırı göstermekten daha pahalıdır: kullanıcı videoyu
 * yayınlar, reddedilir, hataya güveni sarsılır.
 */
import { ASPECT_TOLERANCE, TARGET_ASPECT } from "../../contract/index.js";
import type { LimitRule, Platform } from "../../contract/index.js";

/** 9:16'ya toleranslı aralık. Oran = genişlik / yükseklik. */
export const ASPECT_MIN = TARGET_ASPECT * (1 - ASPECT_TOLERANCE);
export const ASPECT_MAX = TARGET_ASPECT * (1 + ASPECT_TOLERANCE);

export const ASPECT_TOLERANCE_RATIO = ASPECT_TOLERANCE;
export const TARGET_RATIO = TARGET_ASPECT;

/** Yayınlanabilir en yaygın piksel biçimi. */
export const PREFERRED_PIXEL_FORMAT = "yuv420p";

/** Kapak karesi yüzde aralığı (contract ile aynı değerler). */
export const COVER_PERCENT = { min: 10, max: 95 } as const;

export interface NumericLimitInput {
  code: string;
  label: string;
  rule: string;
  min?: number;
  max?: number;
  enumValues?: Array<number | string>;
  maxBytes?: number;
  source: string | null;
  provisional: boolean;
}

function base(input: NumericLimitInput): LimitRule {
  const rule: LimitRule = {
    code: input.code,
    label: input.label,
    rule: input.rule,
    source: input.source,
    provisional: input.provisional,
  };
  if (input.min !== undefined) rule.min = input.min;
  if (input.max !== undefined) rule.max = input.max;
  if (input.enumValues !== undefined) rule.enumValues = input.enumValues;
  if (input.maxBytes !== undefined) rule.maxBytes = input.maxBytes;
  return rule;
}

/**
 * KURAL METNİ SÖZLEŞMESİ: her kural metni tek cümlecik biter, yani nokta ile
 * biter. Bunu `endStop` ile garanti ediyoruz; aksi halde `not` ekleyen bir
 * kural sessizce sözleşmeyi ihlal eder ve test kırılırken sebebi görünmez.
 */
function endStop(text: string): string {
  const t = text.trimEnd();
  return t.endsWith(".") ? t : `${t}.`;
}

/**
 * `min`/`max` her iki eksene birden uygulanır. Değerler farklıysa iki kural
 * ayrı ayrı tanımlanmalıdır.
 */
export function resolutionRule(input: {
  label?: string;
  min?: number;
  max?: number;
  source: string | null;
  provisional: boolean;
  platform: Platform;
}): LimitRule {
  const parts: string[] = [];
  if (input.min !== undefined) parts.push(`en az ${input.min}px`);
  if (input.max !== undefined) parts.push(`en çok ${input.max}px`);
  return base({
    code: "resolution",
    label: input.label ?? "Çözünürlük",
    rule: endStop(
      `Her iki eksende ${parts.join(", ")} (dikey 9:16 için 1080x1920 önerilir)`,
    ),
    min: input.min,
    max: input.max,
    source: input.source,
    provisional: input.provisional,
  });
}

export function fpsRule(input: {
  min: number;
  max: number;
  source: string | null;
  provisional: boolean;
}): LimitRule {
  return base({
    code: "fps",
    label: "Kare hızı",
    rule: `${input.min}-${input.max} fps arası olmalı (kırılıklı değerler dahil, ör. 29.97).`,
    min: input.min,
    max: input.max,
    source: input.source,
    provisional: input.provisional,
  });
}

export function durationRule(input: {
  min: number;
  max: number;
  source: string | null;
  provisional: boolean;
  note?: string;
}): LimitRule {
  const rule = input.note
    ? `${input.min}-${input.max} saniye. ${input.note}`
    : `${input.min}-${input.max} saniye arasında olmalı`;
  return base({
    code: "duration",
    label: "Süre",
    rule: endStop(rule),
    min: input.min,
    max: input.max,
    source: input.source,
    provisional: input.provisional,
  });
}

export function fileSizeRule(input: {
  maxBytes: number;
  source: string | null;
  provisional: boolean;
  note?: string;
}): LimitRule {
  return base({
    code: "file_size",
    label: "Dosya boyutu",
    rule: endStop(
      `En çok ${formatBytes(input.maxBytes)}${input.note ? ` ${input.note}` : ""}`,
    ),
    maxBytes: input.maxBytes,
    source: input.source,
    provisional: input.provisional,
  });
}

export function containerRule(input: {
  values: string[];
  source: string | null;
  provisional: boolean;
  label?: string;
  note?: string;
}): LimitRule {
  return base({
    code: "container",
    label: input.label ?? "Kapsayıcı",
    rule: endStop(
      `Kabul edilen kapsayıcılar: ${input.values.join(", ")}${input.note ? ` ${input.note}` : ""}`,
    ),
    enumValues: input.values,
    source: input.source,
    provisional: input.provisional,
  });
}

export function videoCodecRule(input: {
  values: string[];
  source: string | null;
  provisional: boolean;
  note?: string;
}): LimitRule {
  return base({
    code: "video_codec",
    label: "Video kodek",
    rule: endStop(
      `Kabul edilen video kodekleri: ${input.values.join(", ")}${input.note ? ` ${input.note}` : ""}`,
    ),
    enumValues: input.values,
    source: input.source,
    provisional: input.provisional,
  });
}

export function audioCodecRule(input: {
  values: string[];
  source: string | null;
  provisional: boolean;
  note?: string;
}): LimitRule {
  return base({
    code: "audio_codec",
    label: "Ses kodek",
    rule: endStop(
      `Kabul edilen ses kodekleri: ${input.values.join(", ")}${input.note ? ` ${input.note}` : ""}`,
    ),
    enumValues: input.values,
    source: input.source,
    provisional: input.provisional,
  });
}

/**
 * Piksel biçimi. 10-bit/4:2:2 videolar bazı telefonlarda siyah çıkar; bu yüzden
 * doğrulayıcı bunu varsayılan olarak `warning` üretir, `error` değil —
 * dosya çalışıyor, sadece riskli.
 */
export function pixelFormatRule(input: {
  preferred: string;
  source: string | null;
  provisional: boolean;
}): LimitRule {
  return base({
    code: "pixel_format",
    label: "Piksel biçimi",
    rule: `${input.preferred} olmalı (yüksek derinlikli 10-bit/4:2:2 bazı cihazlarda bozulur).`,
    enumValues: [input.preferred],
    source: input.source,
    provisional: input.provisional,
  });
}

/** Kopyalama metni sınırı — medya değil, yayın gövdesi kuralı. */
export function captionRule(input: {
  max: number;
  source: string | null;
  provisional: boolean;
  label: string;
}): LimitRule {
  return base({
    code: "caption_length",
    label: input.label,
    rule: `Açıklama en çok ${input.max} karakter (UTF-16 birim) olabilir.`,
    max: input.max,
    source: input.source,
    provisional: input.provisional,
  });
}

/**
 * Bu uygulamanın ÜRÜN kararı: yayınlanan reklam 9:16 dikey kadrajda olmalı.
 *
 * Bu bir *platform* sınırı değil; genişliği/yüksekliği bilinen tek kural.
 * `min`/`max` oranı (genişlik/yükseklik) `TARGET_ASPECT ± %` aralığını anlatır.
 *
 * `provisional` bilinçli olarak `true` gelir: hiçbir platformun genel API
 * sözleşmesi 9:16'yı zorunlu kılmaz (TikTok'ta bu açıkça belgelenmiştir), bu
 * yüzden bu kurala "resmî sınır" diyeceğimiz yanlış olur. Doğrulayıcı, bu
 * kurala dayanan bulguyu `warning` seviyesine indirir ve mesajına
 * "(sınır henüz doğrulanmadı)" ekler.
 */
export function aspectWarningRule(input: { note?: string }): LimitRule {
  return base({
    code: "aspect_ratio",
    label: "Kadraj (9:16)",
    rule: endStop(
      `9:16 dikey olmalı: genişlik/yükseklik oranı ${ASPECT_MIN.toFixed(3)}-${ASPECT_MAX.toFixed(3)} ` +
        `aralığında (1080x1920). Bu uygulamanın kadraj kuralıdır, platformun zorunlu sınırı değildir` +
        (input.note ? ` ${input.note}` : ""),
    ),
    min: ASPECT_MIN,
    max: ASPECT_MAX,
    source: null,
    provisional: true,
  });
}

/**
 * Platformun KENDİ aspect kuralı — `aspectWarningRule`'den farkı sayının
 * DOĞRULANMIŞ olabilmesidir (`source` + `provisional: false`).
 *
 * Buradaki `min`/`max` platformun ZORUNLU kabul ettiği oran aralığıdır;
 * `recommended` ise ayrıca önerilen kadraj. 9:16'nın zorunlu olmadığı bir
 * platformda (Instagram: 0.01:1-10:1) bu kural doğrulanmış olsa bile 9:16
 * ihlali `error` üretmez — seviye doğrulayıcının işidir (bkz. `validate.ts`).
 */
export function platformAspectRule(input: {
  min: number;
  max: number;
  recommended: string;
  source: string | null;
  provisional: boolean;
  note?: string;
}): LimitRule {
  return base({
    code: "aspect_ratio",
    label: "En-boy oranı",
    rule: endStop(
      `Oran zorunlu değildir; zorunlu aralık genişlik/yükseklik ${input.min}-${input.max} arasındadır; ` +
        `tercih edilen kadraj ${input.recommended}` +
        (input.note ? ` ${input.note}` : ""),
    ),
    min: input.min,
    max: input.max,
    source: input.source,
    provisional: input.provisional,
  });
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  if (mb >= 1) return `${Math.round(mb * 10) / 10} MB`;
  return `${bytes} bayt`;
}

/** Kodla bulmak için: `spec.limits` içinde tekilleştirilmiş kural. */
export function findLimit(limits: LimitRule[], code: string): LimitRule | undefined {
  return limits.find((l) => l.code === code);
}
