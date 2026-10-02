/**
 * Güvenli alan (safe area) sarmalayıcısı. SAF — ağır iş `src/media/safeArea.ts`
 * içinde, burada yalnızca arayüzün ihtiyacı olan biçimlere çeviriyoruz.
 *
 * ⚠️ `src/media/safeArea.ts` kendi başlığında uyarıyor: bu dikdörtgenler
 * KURGUSAL YERLEŞİMDİR, uygulama ekranları ölçülmemiştir. Arayüz de aynı
 * uyarıyı taşır; "ölçülmüş" gibi sunmamak bir güvenlik kuralıdır.
 */
import type { Platform } from "../../../src/contract/index.js";
import type { SafeAreaRect } from "../../../src/media/safeArea.js";
import {
  coveredAreaPercent,
  describeSafeArea,
  findTextViolations,
  overlaps,
  safeAreaFor,
  toPixels,
  unionArea,
  unionOf,
} from "../../../src/media/safeArea.js";

export type { Rect, SafeAreaRect } from "../../../src/media/safeArea.js";
export { SAFE_AREA_PROVENANCE } from "../../../src/media/safeArea.js";

/** Kullanıcının metin kutusu girdisi (yüzde, 0-100). */
export interface TextBoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextBoxCheck {
  rect: TextBoxRect;
  platform: Platform;
  violations: SafeAreaRect[];
  ok: boolean;
  /** Kullanıcıya gösterilecek tek cümle. */
  message: string;
  /** Kutunun güvenli alanla kesişen alanı (kare yüzdesi). */
  overlapPercent: number;
}

export const EMPTY_TEXT_BOX_MESSAGE = "Metin kutusu için x/y/genişlik/yükseklik girin.";

/** Girdi geçerli bir dikdörtgen mi? (0..100 aralığında, pozitif ölçü) */
export function isValidTextBox(rect: Partial<TextBoxRect>): boolean {
  const nums = [rect.x, rect.y, rect.w, rect.h];
  if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) return false;
  const x = nums[0];
  const y = nums[1];
  const w = nums[2];
  const h = nums[3];
  if (x === undefined || y === undefined || w === undefined || h === undefined) return false;
  if (w <= 0 || h <= 0) return false;
  if (x < 0 || y < 0 || x + w > 100 || y + h > 100) return false;
  return true;
}

/** Yüzde dikdörtgeni CSS yüzdelerine çevirir (kapsayıcı 9:16 oranlıysa birebir örtüşür). */
export function percentStyle(rect: TextBoxRect): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  return {
    left: `${rect.x}%`,
    top: `${rect.y}%`,
    width: `${rect.w}%`,
    height: `${rect.h}%`,
  };
}

/**
 * Bir metin kutusunun platformun güvenli alanlarına girip girmediği.
 * Geçersiz/eksik girdi `ok: false` DEĞİLDİR — kimlik yoksa "bilinmiyor" demektir.
 */
export function checkTextBox(
  rect: Partial<TextBoxRect>,
  platform: Platform,
  opts: { allowTouch?: boolean } = {},
): TextBoxCheck {
  if (!isValidTextBox(rect)) {
    return {
      rect: { x: 0, y: 0, w: 0, h: 0 },
      platform,
      violations: [],
      ok: true,
      message: EMPTY_TEXT_BOX_MESSAGE,
      overlapPercent: 0,
    };
  }
  const full = rect as TextBoxRect;
  const violations = findTextViolations(full, platform, opts);
  const overlap = unionArea(
    safeAreaFor(platform).filter((area) => overlaps(full, area)),
  );
  const overlapPercent = overlap / 100;
  const message =
    violations.length === 0
      ? "Metin kutusu güvenli alanların dışında."
      : `Güvenli alan ihlali: ${violations.map((v) => v.label).join(", ")}`;
  return { rect: full, platform, violations, ok: violations.length === 0, message, overlapPercent };
}

export interface SafeAreaRow {
  id: string;
  label: string;
  kind: string;
  areaPercent: number;
}

/** Panel tablosu için: hangi bölge, ne kadar alan kaplıyor. */
export function safeAreaRows(platform: Platform): SafeAreaRow[] {
  return describeSafeArea(platform);
}

/** Kırmızı çizgi: UI'ın kapladığı toplam alan (kare yüzdesi). */
export function redLinePercent(platform: Platform): number {
  return coveredAreaPercent(platform);
}

/** Platform güvenli alanlarının bileşik kutusu (dikdörtgen yüzdesi). */
export function busyBox(platform: Platform): TextBoxRect | null {
  return unionOf(safeAreaFor(platform));
}

/** Yüzdeyi piksele çevirmek için (testler ve tooltip). */
export function rectToPixels(rect: TextBoxRect, frame: { width: number; height: number }): TextBoxRect {
  return toPixels(rect, frame);
}

/**
 * Platform güvenli alanları BİRLİKTE düşünüldüğünde metin kutusu kaç platforma
 * takılıyor? (Örn. alt-orta bant TikTok'ta yasak, Instagram'da serbest.)
 */
export function platformsViolated(rect: Partial<TextBoxRect>, platforms: readonly Platform[]): Platform[] {
  if (!isValidTextBox(rect)) return [];
  return platforms.filter((p) => checkTextBox(rect, p).violations.length > 0);
}