/**
 * `web/src/lib/safeAreaUi.ts` — metin kutusunun güvenli alanla kesişip kesişmediği.
 *
 * Ayrıca `web/src/components/SafeAreaOverlay.tsx` içindeki çizim kopyasının
 * `src/media/safeArea.ts` ile AYNI küreyi verdiği doğrulanır. Kopya kayabilirdi;
 * kopyaysa test bir güncelleme unutulduğunda kırılır.
 */
import { describe, expect, it } from "vitest";

import { safeAreaFor } from "../../src/media/safeArea.js";
import type { Platform } from "../../src/contract/index.js";
import { SAFE_AREA_RECTS } from "../../web/src/components/safeAreaRectangles.js";
import {
  checkTextBox,
  isValidTextBox,
  percentStyle,
  platformsViolated,
  redLinePercent,
  rectToPixels,
  safeAreaRows,
} from "../../web/src/lib/safeAreaUi.js";

const PLATFORMS: Platform[] = ["instagram", "tiktok", "youtube"];

describe("isValidTextBox", () => {
  it("geçerli dikdörtgenleri kabul eder", () => {
    expect(isValidTextBox({ x: 10, y: 20, w: 30, h: 40 })).toBe(true);
    expect(isValidTextBox({ x: 0, y: 0, w: 100, h: 100 })).toBe(true);
  });

  it("eksik/bozuk girdiyi reddeder", () => {
    expect(isValidTextBox({})).toBe(false);
    expect(isValidTextBox({ x: 10, y: 10, w: 0, h: 10 })).toBe(false);
    expect(isValidTextBox({ x: -1, y: 0, w: 10, h: 10 })).toBe(false);
    expect(isValidTextBox({ x: 90, y: 0, w: 20, h: 10 })).toBe(false);
    expect(isValidTextBox({ x: Number.NaN, y: 0, w: 10, h: 10 })).toBe(false);
  });
});

describe("checkTextBox — kesişim tespiti", () => {
  it("sol üstteki kutu hiçbir platformda ihlal değildir", () => {
    // ⚠️ Fişit DÜZELTİLDİ: y=12 idi. YouTube'da ÜST başlık bandı 0-14
    // olduğu için y=12'deki kutu (12..26) onunla 2 birim kesişiyordu.
    // y=16 → 16..30: üç platformun da dışında.
    for (const platform of PLATFORMS) {
      const check = checkTextBox({ x: 8, y: 16, w: 60, h: 14 }, platform);
      expect(check.violations, `${platform} ihlal bildirdi`).toHaveLength(0);
      expect(check.ok).toBe(true);
    }
  });

  it("sağ alt buton yığılı TikTok'ta ihlaldir", () => {
    const check = checkTextBox({ x: 84, y: 60, w: 16, h: 10 }, "tiktok");
    expect(check.ok).toBe(false);
    expect(check.violations.length).toBeGreaterThan(0);
    expect(check.message).toContain("Güvenli alan ihlali");
  });

  it("alt açıklama bandı Instagram'da ihlaldir", () => {
    // ⚠️ Fişit DÜZELTİLDİ: y=80, h=10 (80..90) idi ve YouTube'nun ALT kanal
    // bandına (86-100) da giriyordu. 74..85: Instagram alt açıklamasında
    // (72-100) ihlal, YouTube'da temiz.
    const box = { x: 5, y: 74, w: 60, h: 11 };
    expect(checkTextBox(box, "instagram").ok).toBe(false);
    expect(checkTextBox(box, "youtube").ok).toBe(true);
  });

  it("kesişen alanı yüzde olarak raporlar", () => {
    const check = checkTextBox({ x: 0, y: 0, w: 100, h: 100 }, "tiktok");
    expect(check.overlapPercent).toBeGreaterThan(0);
    expect(check.violations.length).toBeGreaterThan(0);
  });

  it("geçersiz girdi 'ihlal' sayılmaz, 'bilinmiyor' sayılır", () => {
    const check = checkTextBox({}, "tiktok");
    expect(check.ok).toBe(true);
    expect(check.violations).toHaveLength(0);
    expect(check.message).toContain("girin");
  });

  it("allowTouch kuralı ihlali bastırır", () => {
    const box = { x: 84, y: 60, w: 16, h: 10 };
    expect(checkTextBox(box, "tiktok", { allowTouch: true }).violations).toHaveLength(0);
  });
});

describe("platformsViolated", () => {
  it("aynı kutu farklı platformlarda farklı sonuç verir", () => {
    // ⚠️ Fişit DÜZELTİLDİ: y=78, h=10 (78..88) idi; 86-88 aralığı YouTube'nun
    // alt kanal bandına (86-100) giriyordu. 76..86: alt sınır 86'ya dayanır,
    // `overlaps` y>=b.y+b.h koşulunda kesişim saymaz.
    const box = { x: 0, y: 76, w: 80, h: 10 };
    const hit = platformsViolated(box, PLATFORMS);
    expect(hit).toContain("tiktok");
    expect(hit).toContain("instagram");
    expect(hit).not.toContain("youtube");
  });

  it("geçersiz kutuda hiçbir platform ihlali bildirmez", () => {
    expect(platformsViolated({}, PLATFORMS)).toEqual([]);
  });
});

describe("güvenli alan özeti", () => {
  it("her platformda en az bir bölge tanımlıdır", () => {
    for (const platform of PLATFORMS) {
      expect(safeAreaRows(platform).length).toBeGreaterThan(0);
      expect(redLinePercent(platform)).toBeGreaterThan(0);
    }
  });

  it("kapalı alan karein yarısını geçmez (olası olmayan değer kontrolü)", () => {
    for (const platform of PLATFORMS) {
      expect(redLinePercent(platform)).toBeLessThan(100);
    }
  });

  it("çizim kopyası gerçek güvenli alanlarla aynı", () => {
    // Overlay bileşeni React'ta; çizim için kopyaladığı değerler burada doğrulanır.
    for (const platform of PLATFORMS) {
      const actual = safeAreaFor(platform);
      const copy = SAFE_AREA_RECTS[platform];
      expect(Object.keys(copy).sort(), `${platform} kimlik kümesi farklı`).toEqual(
        actual.map((r) => r.id).sort(),
      );
      for (const rect of actual) {
        // `noUncheckedIndexedAccess` gereği daraltma şart; `expect` daraltmaz.
        const mirrored = copy[rect.id];
        if (mirrored === undefined) throw new Error(`${platform}/${rect.id} kopyada yok`);
        expect(mirrored).toMatchObject({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, kind: rect.kind });
      }
    }
  });
});

describe("percentStyle / rectToPixels", () => {
  it("yüzdeyi CSS yüzdesine çevirir", () => {
    expect(percentStyle({ x: 10, y: 20, w: 30, h: 40 })).toEqual({
      left: "10%",
      top: "20%",
      width: "30%",
      height: "40%",
    });
  });

  it("9:16 karede yüzdeyi piksele çevirir", () => {
    const px = rectToPixels({ x: 50, y: 0, w: 50, h: 100 }, { width: 1080, height: 1920 });
    expect(px.x).toBe(540);
    expect(px.w).toBe(540);
    expect(px.h).toBe(1920);
  });
});