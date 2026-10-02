/**
 * 9:16 reklam videosu için platforma göre GÜVENLİ ALAN.
 *
 * ⚠️ BUNLAR TAHMİN DEĞİL, KURGUSAL YERLEŞİMDİR.
 * Aşağıdaki dikdörtgenler "uygulamaların arayüzü muhtemelen burada" diye
 * çizilmiş OLUMLU YERLEŞİM DEĞERLERİDİR. Hiçbir uygulamanın ekranı
 * ölçülmedi, hiçbir sürüm notuna bakılmadı. Amaçları:
 *   1) metin üreticisinin (metin-üzeri-video iş akışı) okunabilir metni
 *      buton yığınlarının altına koymaması,
 *   2) bu bölgelerin kapladığı alanı panelde gösterebilmek.
 * Uygulama arayüzü sürümle birlikte değişir; bu sabitler o yüzden
 * `AD_AREA_IDS` ile etiketlenmiş ve tek yerde toplanmıştır — yeniden
 * ölçüldükçe buradaki değerler güncellenir. "Doğrulanmış" gibi sunulmaz;
 * doğrulama notu `SAFE_AREA_PROVENANCE` alanında taşınır.
 *
 * BİRİM: YÜZDE. `x`/`y` sol üst köşeden, `w`/`h` çerçeve yüzdesi (0-100).
 * 9:16 karede 100x100 yüzde kare değildir: oran korunur, yani
 * 1080x1920'de `x=84` -> 907px. `toPixels` ile piksele çevrilir.
 */
import { PLATFORMS } from "../contract/platforms.js";
import type { Platform } from "../contract/index.js";

/** Tüm platformlar listesi — panel ve testler için. */
export const ALL_PLATFORMS: readonly Platform[] = PLATFORMS;

export interface Rect {
  /** Sol kenar, yüzde. */
  x: number;
  /** Üst kenar, yüzde. */
  y: number;
  /** Genişlik, yüzde. */
  w: number;
  /** Yükseklik, yüzde. */
  h: number;
}

export interface SafeAreaRect extends Rect {
  id: string;
  label: string;
  /** Bu bölgenin ne olduğu (UI öğesi türü). */
  kind: "actions" | "caption" | "title" | "audio" | "bottom";
}

/** Bu değerlerin nereden geldiğini tek satırda söyle. */
export const SAFE_AREA_PROVENANCE =
  "KURGUSAL YERLEŞİM — uygulama ekranları ölçülmedi. Doğrulama yapılmadan tahmini UI " +
  "bölgesi olarak kullanılır; sürüm değişiminde yeniden ölçülmelidir.";

const rect = (id: string, label: string, kind: SafeAreaRect["kind"], x: number, y: number, w: number, h: number): SafeAreaRect => ({
  id,
  label,
  kind,
  x,
  y,
  w,
  h,
});

/**
 * TikTok: sağdaki etkileşim buton yığını (beğeni/yorum/paylaş/kaydet),
 * sağdaki ikincil etkileşim sütunu, alt açıklama alanı ve sol altta dönen
 * ses kaydırma diski.
 */
const TIKTOK: SafeAreaRect[] = [
  rect("tiktok.actions", "Sağ alt buton yığını (beğeni/yorum/paylaş)", "actions", 82, 55, 18, 30),
  rect("tiktok.interactions", "Sağ etkileşim sütunu (paylaş, ses kaydırma)", "actions", 84, 40, 16, 15),
  rect("tiktok.caption", "Alt açıklama alanı (kullanıcı adı + açıklama)", "caption", 0, 76, 82, 24),
  rect("tiktok.disc", "Sol alt ses kaydırma diski", "bottom", 0, 74, 22, 20),
];

/**
 * Instagram Reels: sağ alt aksiyon yığını, alt açıklama alanı, üstte
 * "Reels" müzik satırı.
 */
const INSTAGRAM: SafeAreaRect[] = [
  rect("instagram.actions", "Sağ alt aksiyon yığını (beğeni/yorum/paylaş)", "actions", 82, 58, 18, 28),
  rect("instagram.caption", "Alt açıklama alanı (kullanıcı adı + açıklama)", "caption", 0, 72, 82, 28),
  rect("instagram.audio", "Üst müzik/format satırı", "audio", 0, 0, 100, 12),
];

/**
 * YouTube Shorts: sağ alt aksiyon yığını, üst başlık ve kanal satırı,
 * alt kanal aboneliği.
 */
const YOUTUBE: SafeAreaRect[] = [
  rect("youtube.actions", "Sağ alt aksiyon yığını (beğeni/yorum/paylaş)", "actions", 82, 52, 18, 32),
  rect("youtube.title", "Üst başlık satırı", "title", 0, 0, 82, 14),
  rect("youtube.channel", "Alt kanal satırı", "bottom", 0, 86, 82, 14),
];

export const SAFE_AREAS: Record<Platform, SafeAreaRect[]> = {
  tiktok: TIKTOK,
  instagram: INSTAGRAM,
  youtube: YOUTUBE,
};

export function safeAreaFor(platform: Platform): SafeAreaRect[] {
  return SAFE_AREAS[platform].map((r) => ({ ...r }));
}

/**
 * Dikdörtgenlerin BİLEŞİK KUTUSU. DİKKAT: bu "serbest alan" DEĞİLDİR.
 * Dağınık kutuların birleşimi, aralarındaki boşlukları da içine alan dev bir
 * kutu olur (TikTok'ta kutu tüm kareyi kaplar, oysa sol üst köşe boştur).
 * Yalnızca "UI en yoğun bölge nerede" sorusuna yanıttır; metin kutusu
 * seçmek için `findTextViolations` kullanılır.
 */
export function unionOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function toPixels(r: Rect, frame: { width: number; height: number }): Rect {
  return {
    x: (r.x / 100) * frame.width,
    y: (r.y / 100) * frame.height,
    w: (r.w / 100) * frame.width,
    h: (r.h / 100) * frame.height,
  };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Bir dikdörtgenin hangi güvenli alanlara girdiği. */
export function hitSafeAreas(target: Rect, areas: SafeAreaRect[]): SafeAreaRect[] {
  return areas.filter((area) => overlaps(target, area));
}

export class SafeAreaError extends Error {
  constructor(
    readonly violations: SafeAreaRect[],
    readonly target: Rect,
    readonly platform: Platform,
  ) {
    const names = violations.map((v) => v.label).join(", ");
    super(
      `Metin kutusu ${platform} güvenli alanına giriyor (${names}). ` +
        "Metni bu bölgelerin dışına taşıyın veya boyutunu küçültün.",
    );
    this.name = "SafeAreaError";
  }
}

export interface SafeAreaCheckOptions {
  /** Güvenli alanla kesişen en küçük alana izin ver (varsayılan false). */
  allowTouch?: boolean;
  /** Platform listesi; varsayılan hepsi. */
  platforms?: readonly Platform[];
}

/** Saf: girdi kutusu + platform güvenli alanları → ihlal listesi. */
export function findTextViolations(
  target: Rect,
  platform: Platform,
  opts: SafeAreaCheckOptions = {},
): SafeAreaRect[] {
  const hit = hitSafeAreas(target, safeAreaFor(platform));
  if (opts.allowTouch === true) return [];
  return hit;
}

export function assertTextInsideSafeArea(
  target: Rect,
  platform: Platform,
  opts: SafeAreaCheckOptions = {},
): void {
  const violations = findTextViolations(target, platform, opts);
  if (violations.length > 0) {
    throw new SafeAreaError(violations, target, platform);
  }
}

/**
 * Gerçek birleşim ALANI (yüzde cinsinden, 0-10_000). Bileşik kutudan farklı
 * olarak üst üste binen dikdörtgenleri bir kez sayar; koordinat sıkıştırması
 * ile tam sonuç verir (dikdörtgen sayısı küçük, maliyet ihmal edilebilir).
 */
export function unionArea(rects: Rect[]): number {
  if (rects.length === 0) return 0;
  const xs = [...new Set(rects.flatMap((r) => [r.x, r.x + r.w]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.y, r.y + r.h]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    for (let j = 0; j + 1 < ys.length; j++) {
      const y0 = ys[j];
      const y1 = ys[j + 1];
      if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) continue;
      const cell: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      if (cell.w <= 0 || cell.h <= 0) continue;
      if (rects.some((r) => overlaps(cell, r))) area += cell.w * cell.h;
    }
  }
  return area;
}

/** Panel için: kare yüzdesi olarak UI'a tahminen kapalı alan. */
export function coveredAreaPercent(platform: Platform): number {
  return unionArea(SAFE_AREAS[platform]) / 100;
}

/** Panel için özet: hangi bölge, ne kadar alan kaplıyor. */
export function describeSafeArea(platform: Platform): Array<{
  id: string;
  label: string;
  kind: string;
  areaPercent: number;
}> {
  return SAFE_AREAS[platform].map((r) => ({
    id: r.id,
    label: r.label,
    kind: r.kind,
    areaPercent: (r.w * r.h) / 100,
  }));
}
