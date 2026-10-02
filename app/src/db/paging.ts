/**
 * Sayfalama (limit/offset) normalizasyonu — TEK yer.
 *
 * Neden ayrı dosya: HTTP katmanı, CLI ve repository'ler aynı soruyu sorar
 * ("kaç kayıt, kaçıncıdan başlayarak"). Her biri kendi `Math.min(...)` yazarsa
 * üç ayrı tavan ve üç ayrı davranış çıkar; `limit=0` ya da `limit=-5` gibi
 * bir sorgu tek katmanda "tümünü getir" anlamına gelirse bu sessizce tüm
 * tabloyu belleğe alır.
 *
 * KURAL:
 *   * `limit` verilmezse `fallback` (varsayılan 100).
 *   * `limit` NaN/çok büyükse `max` tavanına kırpılır.
 *   * `offset` negatif veya bozuksa 0.
 *   * Sonuç DAİMA pozitif tam sayıdır.
 */
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

export function pageSize(limit: number | undefined, fallback = DEFAULT_PAGE_SIZE): number {
  const base = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : fallback;
  if (base <= 0) return fallback;
  return Math.min(base, MAX_PAGE_SIZE);
}

export function pageOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset)) return 0;
  const v = Math.floor(offset);
  return v > 0 ? v : 0;
}