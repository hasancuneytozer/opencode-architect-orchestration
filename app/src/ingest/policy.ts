/**
 * UYGULAMA POLİTİKASI — platform kuralı DEĞİLDİR.
 *
 * ── BU DOSYA NEDEN VAR ───────────────────────────────────────────────────────
 * `src/media/validate.ts` bir Ayna gibidir: içinde yalnız **sağlayıcının kendi
 * dokümanından çıkarılmış** sınırlar vardır. Instagram için zorunlu oran
 * aralığı 0.01:1–10:1'dir ve 9:16 yalnızca ÖNERİ olarak geçer; TikTok'un
 * dokümanında aspect şartı yoktur. Bu yüzden `validateMedia` 1920×1080 yatay
 * videoyu Instagram için **uyarı** üretir ve içerik `ready` sayılır. Bu DOĞRU
 * davranıştır ve `validate.ts` bunun için DEĞİŞTİRİLMEZ.
 *
 * Ancak bu uygulama bir "her şeyi kabul eden yayın aracı" değil, **9:16 dikey
 * reklam içeriği** üretir. Yatay (ya da 9:16 olmayan dikey) bir klip reklam
 * akışına girdiğinde kadraj yanlış olur: yatay klip dikey akışta siyah
 * bantlarla görünür. Bu bir platform HATASI değil, bizim ÜRÜN KARAMIZDIR.
 *
 * ── İKİ KATMAN, TEK KURAL ────────────────────────────────────────────────────
 *   * `src/media/validate.ts` → "platform bunu kabul eder mi?"   (dış dünya)
 *   * `src/ingest/policy.ts`   → "bu uygulama bunu yayınlar mı?" (bizim kural)
 * Birleştirme tek yerde (`IngestService.validateForPlatforms`) yapılır; ikisi
 * de `severity: "error"` üretirse içerik `draft` kalır ve kuyruğa GİRMEZ.
 *
 * ── DÜRÜSTLÜK KURALI ─────────────────────────────────────────────────────────
 * Bulgu metni iki şeyi AYRI ayrı söyler:
 *   1. "platform kabul eder"   → kullanıcı "dosyam bozuk mu?" diye düşünmez,
 *                                 asıl sebebi görür.
 *   2. "bu uygulama kabul etmiyor" → kural keyfî sertlik gibi görünmez; kaynağı
 *                                 bellidir (ürün kararı, doğrulanmamış sınır
 *                                 DEĞİL).
 *
 * ── `provisional` NEDEN `false` ──────────────────────────────────────────────
 * `validate.ts`'teki `provisional: true`, "bu sayı resmî dokümanla
 * DOĞRULANMAMIŞ" demektir ve bulguyu yumuşak tutar. Buradaki kuralın böyle
 * bir belirsizliği yoktur: 9:16 dikey bizim ÜRÜN tanımımız, kaynağı kendisi.
 * Bu yüzden bulgu `provisional: false` taşır ve `severity` değişmez.
 */
import { isTargetAspect, isVertical } from "../contract/index.js";
import type { MediaInfo, ValidationFinding } from "../contract/index.js";

/**
 * Bulgu kodu. **KARARLI DİZGİDİR**: panel, log ve testler bu dizgiyi anahtar
 * olarak kullanır; yeniden adlandırılmamalı. `aspect_ratio` DEĞİLDİR — o kod
 * platform kuralının sahibidir ve bu kodla karıştırılmamalıdır.
 */
export const PRODUCT_ASPECT_CODE = "product_aspect_9_16";

/** Mesajın İKİNCİ yarısı: kural bizim, kaynak doğrulanmamış bir sınır değil. */
export const PRODUCT_REFUSAL_NOTE = "bu uygulama kabul etmiyor: yalnız 9:16 dikey reklam içeriği yayınlanır";

/** Mesajın BİRİNCİ yarısı: platformun gerçek, doğrulanmış tutumu. */
export const PLATFORM_ACCEPTANCE_NOTE =
  "platform kabul eder (Instagram zorunlu aralık 0.01:1–10:1, TikTok'ta aspect şartı yok)";

function measured(info: MediaInfo): boolean {
  return (
    typeof info.width === "number" &&
    typeof info.height === "number" &&
    info.width > 0 &&
    info.height > 0
  );
}

/**
 * ÜRÜN KURALI: içerik 9:16 dikey değilse `severity: "error"` bulgu üretir.
 *
 * Ölçü yoksa (`width`/`height` `null`) bulgu ÜRETİLMEZ: o durumda zaten
 * `validateMedia` `resolution` hatası veriyor ve iki bulgu aynı sebebi
 * iki kez anlatmak yerine tek net hata bırakmak daha iyidir.
 *
 * Tolerans `isTargetAspect` içinde gelir (`ASPECT_TOLERANCE`), böylece
 * "hangi ölçüde 9:16 sayılır" sorusunun cevabı İKİ YERDE kopyalanmaz.
 */
export function productFindings(info: MediaInfo): ValidationFinding[] {
  if (!measured(info)) return [];
  if (isTargetAspect(info)) return [];

  const size = `${info.width}x${info.height}`;
  const shape = isVertical(info)
    ? "dikey ama 9:16 değil"
    : "yatay";
  const remedy = isVertical(info)
    ? "Kadraj 9:16'ya yeniden kurulmalıdır."
    : "Video 9:16 dikey kadraja kırpılmalı veya yeniden kurulmalıdır.";

  return [
    {
      code: PRODUCT_ASPECT_CODE,
      severity: "error",
      message:
        `Bu içerik ${size} (${shape}). ${PLATFORM_ACCEPTANCE_NOTE}; ` +
        `${PRODUCT_REFUSAL_NOTE}. ${remedy}`,
      observed: size,
      // Bizim kuralımız: doğrulanmamış sınır değil, kesin ürün tanımı.
      provisional: false,
    },
  ];
}

/** Yalnız bu bulgunun üretilip üretilmediği (panel/CLI için daraltılmış görünüm). */
export function hasProductAspectFinding(findings: readonly ValidationFinding[]): boolean {
  return findings.some((f) => f.code === PRODUCT_ASPECT_CODE);
}