/**
 * Metin birleştirme katmanı. SAF FONKSİYON: dosya okumaz, ağa çıkmaz,
 * veritabanına dokunmaz, `Date.now()` çağırmaz.
 *
 * BURADA EN SIK YAPILAN VE EN PAHALI HATA:
 * kullanıcı "bilerek boş gönderdi" ile "hiç göndermedi" ayrımını kaybetmek.
 * Aşağıdaki `resolveCopy` bunu üç ayrı tuzakla korur:
 *
 *   1) `??`  : `hashtags: null` gelirse (JSON gövdesi `null` olabilir) ESKİ
 *              diziye düşer — kullanıcının "temizle" işlemi sessizce geri alınır.
 *   2) `||`  : `caption: ""` gelirse ESKİ metne düşer; `hashtags: []` de aynı
 *              şekilde ezilir. Boş DİZİ ve boş METİN de `||` için yanlıştır.
 *   3) `trim()` : "Bugünün" yazmış kullanıcının metnine dokunulmaz. Boşluk
 *              normalleştirme YAPILMAZ; yalnızca "tamamen boş" olanlar yok sayılır.
 *
 * Bu yüzden tek geçerli biçim açık `=== undefined || === null` kontrolüdür.
 * Taban ve sonuç dizileri KOPYALANIR: çağıran, dönen nesneyi değiştirerek
 * kaydedilmiş `defaultCopy`'yi bozamamalıdır.
 */
import type {
  Platform,
  PlatformCopy,
  PlatformCopyOverride,
} from "../contract/index.js";

// ── Sabitler ──────────────────────────────────────────────────────────────

/** Instagram ve TikTok caption sınırı (ikisi de 2200). */
export const CAPTION_MAX_CHARS = 2200;
/** Caption sonunda bu sayıdan fazla hashtag için uyarı üretilir. */
export const HASHTAG_COUNT_WARN = 30;
/** YouTube başlık sınırı (resmî doküman). */
export const YOUTUBE_TITLE_MAX_CHARS = 100;
/** YouTube açıklama sınırı (resmî doküman). */
export const YOUTUBE_DESCRIPTION_MAX_CHARS = 5000;
/** YouTube Shorts etiketi. Resmî dokümanda ZORUNLU değil, tercihtir. */
export const SHORTS_TAG = "#Shorts";

// ── Yardımcılar ───────────────────────────────────────────────────────────

/**
 * "Gönderilmedi" anlamına gelen tek değer. `null` de buraya girer: istemci
 * alanı açıkça `null` yolladığında sessizce taban değeri kullanmak, kullanıcı
 * niyetini çalmanın en sessiz yoludur.
 */
function isAbsent(value: unknown): value is undefined | null {
  return value === undefined || value === null;
}

/** `undefined`/`null` → taban. `[]` ve `""` DEĞERDİR, tabana dönmez. */
function overrideOr<T>(value: T | undefined | null, fallback: T): T {
  return isAbsent(value) ? fallback : value;
}

/** Tamamen boş olmayan, DEĞERİ DEĞİŞTİRİLMEDEN kullanılan metin. */
function presentText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.trim().length === 0 ? null : value;
}

/**
 * Hashtag/etiket listesini tek satıra çevirir.
 * Değerler AYNEN kullanılır (kırpma, küçültme, `#` ekleme YOK); yalnızca
 * tamamen boş olanlar atlanır, aksi hâlde boşluklar birikir.
 */
function joinTokens(
  values: readonly string[] | null | undefined,
  separator: string,
  ensureHash: boolean,
): string | null {
  if (!Array.isArray(values)) return null;
  const kept = values.filter((v) => typeof v === "string" && v.trim().length > 0);
  if (kept.length === 0) return null;
  return kept.map((v) => (ensureHash && !v.trim().startsWith("#") ? `#${v}` : v)).join(separator);
}

// ── 1) Taban + override birleştirme ───────────────────────────────────────

/**
 * `override` alanlarını `base` üzerine yazar.
 *
 * KURAL: `undefined` (ve `null`) → taban korunur. `[]`, `""`, `false` → bunlar
 * GEÇERLİ kullanıcı kararlarıdır ve tabanın üzerine yazılır.
 */
export function resolveCopy(
  base: PlatformCopy,
  override: PlatformCopyOverride | null | undefined,
): PlatformCopy {
  if (override === null || override === undefined) {
    return {
      ...base,
      hashtags: [...(base.hashtags ?? [])],
      tags: [...(base.tags ?? [])],
    };
  }
  return {
    ...base,
    caption: overrideOr(override.caption, base.caption),
    // DİZİ ALANLARI: `[]` burada tabanı EZER. `overrideOr` sayesinde.
    hashtags: [...overrideOr(override.hashtags, base.hashtags ?? [])],
    title: overrideOr(override.title, base.title),
    description: overrideOr(override.description, base.description),
    tags: [...overrideOr(override.tags, base.tags ?? [])],
    madeForShorts: overrideOr(override.madeForShorts, base.madeForShorts),
    selfDeclaredMadeForKids: overrideOr(
      override.selfDeclaredMadeForKids,
      base.selfDeclaredMadeForKids,
    ),
    aiGenerated: overrideOr(override.aiGenerated, base.aiGenerated),
    coverAtPercent: overrideOr(override.coverAtPercent, base.coverAtPercent),
    // "private" override'ı "public" varsayılanını EZER. Gizlilik kayması
    // kullanıcıya yansıyan en kötü sessiz hatadır; burada kesinlikle ezilir.
    privacy: overrideOr(override.privacy, base.privacy),
  };
}

// ── 2) Caption ────────────────────────────────────────────────────────────

export interface CaptionOptions {
  /** Sorun mesajında anılır. Sınır her iki platformda da aynı (2200). */
  platform?: Platform;
  /** Varsayılan `CAPTION_MAX_CHARS`. Test ve ileride gelen limitler için açık. */
  maxChars?: number;
  /** 30 üstü hashtag uyarısı üretilsin mi? Varsayılan true. */
  warnHashtagCount?: boolean;
  /** Etiketlerde `#` yoksa eklensin mi? Varsayılan false (kullanıcının metnine dokunulmaz). */
  ensureHash?: boolean;
}

export interface CaptionResult {
  /** `null` YALNIZCA sorun varsa: metin üretilemedi. Boş metin `""` döner. */
  text: string | null;
  /** Üretilemediyse neden. Metin ASLA sessizce kırpılmaz. */
  problem: string | null;
  /** Yayını engellemeyen uyarılar. */
  warnings: string[];
  /** Üretilen metnin `String.length` değeri (sorunda: olması gereken uzunluk). */
  length: number;
}

/**
 * Caption'ı hashtag'lerle birleştirir.
 *
 * DÖNÜŞ SÖZLEŞMESİ:
 * - her iki kaynak da yoksa → `text: ""`, `problem: null` (boş caption geçerli bir
 *   karardır; sıfır uzunluk HATA DEĞİLDİR).
 * - 2200 karakter aşılırsa → `text: null` + `problem` dolu. KIRPMA YOK.
 *
 * NEDEN KIRPMA YOK: kırpılmış caption, kullanıcının yazdığı metnin sessizce
 * bozulmasıdır ve hashtag'ler cümleyi ortadan böler. Doğru davranış yayını
 * durdurmak ve sorunu panelde göstermektir; sonuç `null` ile temsil edilir.
 *
 * BİLİNEN SINIR: uzunluk `String.length` (UTF-16 kod birimi) ile ölçülür; bir
 * emoji 2 sayılır. Sınırın hemen dibindeki emoji ağırlıklı caption'lar
 * muhtemelen 1 karakter fazla sayılabilir. Bu bilinçli bir tercihtir: kırpma
 * yerine yanlışlıkla ret etmek, sessiz metin bozulmasından iyidir.
 */
export function composeCaptionDetailed(
  caption: string | null | undefined,
  hashtags: readonly string[] | null | undefined,
  opts: CaptionOptions = {},
): CaptionResult {
  const warnings: string[] = [];
  const maxChars = Number.isFinite(opts.maxChars) && (opts.maxChars ?? 0) > 0
    ? Math.floor(opts.maxChars as number)
    : CAPTION_MAX_CHARS;
  const ensureHash = opts.ensureHash ?? false;

  const body = presentText(caption);
  const tagLine = joinTokens(hashtags, " ", ensureHash);

  const text = [body, tagLine].filter((part): part is string => part !== null).join(" ");
  const length = text.length;

  if (opts.warnHashtagCount ?? true) {
    const count = Array.isArray(hashtags)
      ? hashtags.filter((v) => typeof v === "string" && v.trim().length > 0).length
      : 0;
    if (count > HASHTAG_COUNT_WARN) {
      warnings.push(
        `Caption sonunda ${count} hashtag var; ${HASHTAG_COUNT_WARN} sınırı aşıldı. ` +
          `Platformlar uzun hashtag listesini kısabilir, erişilebilirliği düşer.`,
      );
    }
  }

  if (length > maxChars) {
    const where = opts.platform ? `${opts.platform} ` : "";
    return {
      text: null,
      problem:
        `${where}caption ${maxChars} karakter sınırını aşıyor: ${length} > ${maxChars}. ` +
        `Metin kırpılmadı; hashtag'leri veya caption'ı kısaltın.`,
      warnings,
      length,
    };
  }

  return { text, problem: null, warnings, length };
}

/** `composeCaptionDetailed(...).text` — soru `null` ise sorun vardır, sorun metni `captionProblem()` ile alınır. */
export function composeCaption(
  caption: string | null | undefined,
  hashtags: readonly string[] | null | undefined,
  opts: CaptionOptions = {},
): string | null {
  return composeCaptionDetailed(caption, hashtags, opts).text;
}

/** Caption üretilemediyse nedeni, üretildiyse `null`. */
export function captionProblem(
  caption: string | null | undefined,
  hashtags: readonly string[] | null | undefined,
  opts: CaptionOptions = {},
): string | null {
  return composeCaptionDetailed(caption, hashtags, opts).problem;
}

// ── 3) YouTube açıklaması ve başlığı ──────────────────────────────────────

/**
 * `title` zaten `#Shorts` içeriyorsa dokunulmaz (buyuk/küçük harf duyarsız).
 * YouTube Shorts işaretlemesi başlık VEYA açıklamada `#Shorts` ile yapılır.
 */
export function applyShortsTag(title: string | null | undefined): string {
  const text = presentText(title);
  if (text === null) return SHORTS_TAG;
  if (/#shorts\b/i.test(text)) return text;
  return `${text} ${SHORTS_TAG}`;
}

/** Başlığa, istenirse `#Shorts` ekler. Diğer her şey dokunulmadan kalır. */
export function composeTitle(
  title: string | null | undefined,
  madeForShorts: boolean,
): string {
  const text = presentText(title);
  if (!madeForShorts) return text ?? "";
  return applyShortsTag(text);
}

export interface DescriptionOptions {
  /** Etiketlerde `#` yoksa eklensin mi? Varsayılan false. */
  ensureHash?: boolean;
}

/**
 * YouTube açıklaması: `açıklama` + `\n\n` + hashtag satırı + etiket satırı.
 * Boş olan bölümler atlanır; dolu bölümler `\n\n` ile ayrılır.
 *
 * `madeForShorts` true ise sona `#Shorts` bölümü eklenir.
 *
 * TERCİH, KURAL DEĞİL: resmî YouTube dokümanında `#Shorts` ZORUNLU değildir;
 * Shorts işaretlemesi başlıkta veya açıklamada bulunmasıyla yapılır. Başlık
 * alanı bu fonksiyonun girdisi olmadığı için etiket açıklamaya konur; 100
 * karakterlik başlığa eklemek zaten sınırı zorlar, açıklama ise 5000
 * karaktere yer sahibi. Başlık tarafı `composeTitle()` ile desteklenir.
 *
 * UYARI: bu fonksiyon 5000 karakter sınırını UYGULAMAZ ve kırpma yapmaz.
 * Sınır `YOUTUBE_DESCRIPTION_MAX_CHARS`; uyguları bunu doğrulamalıdır.
 */
export function composeDescription(
  caption: string | null | undefined,
  hashtags: readonly string[] | null | undefined,
  tags: readonly string[] | null | undefined,
  madeForShorts: boolean,
  opts: DescriptionOptions = {},
): string {
  const ensureHash = opts.ensureHash ?? false;
  const parts: string[] = [];

  const body = presentText(caption);
  if (body !== null) parts.push(body);

  const tagLine = joinTokens(hashtags, " ", ensureHash);
  if (tagLine !== null) parts.push(tagLine);

  const labelLine = joinTokens(tags, ", ", ensureHash);
  if (labelLine !== null) parts.push(labelLine);

  if (madeForShorts) {
    const joined = parts.join("\n\n");
    if (!/#shorts\b/i.test(joined)) parts.push(SHORTS_TAG);
  }

  return parts.join("\n\n");
}

// ── 4) Başlık doğrulama ───────────────────────────────────────────────────

export interface TitleValidation {
  ok: boolean;
  problem: string | null;
}

/**
 * Başlık denetimi.
 *
 * - YouTube: başlık ZORUNLU, boş olamaz ve en fazla 100 karakter olabilir.
 * - Instagram/TikTok: başlık alanı YOKTUR. Bu platformlarda `ok: true` döner;
 *   alan yok sayılır, uzunluğu hata değildir. "Uzun başlık" hatası üretmek,
 *   kullanıcıya hiç ilgili olmayan bir kapı koymaktır.
 */
export function validateTitle(
  title: string | null | undefined,
  platform: Platform,
): TitleValidation {
  if (platform !== "youtube") {
    return { ok: true, problem: null };
  }
  const text = presentText(title);
  if (text === null) {
    return { ok: false, problem: "YouTube başlığı zorunlu ve boş olamaz." };
  }
  if (text.length > YOUTUBE_TITLE_MAX_CHARS) {
    return {
      ok: false,
      problem:
        `YouTube başlığı en fazla ${YOUTUBE_TITLE_MAX_CHARS} karakter olabilir; ` +
        `şu an ${text.length}.`,
    };
  }
  return { ok: true, problem: null };
}