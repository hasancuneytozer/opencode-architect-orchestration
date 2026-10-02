/**
 * Güvenli alan (safe area) testleri.
 *
 * ÖNEMLİ: `SAFE_AREAS` ÖLÇÜLMÜŞ DEĞERLER DEĞİLDİR — kurgusal/olası UI
 * yerleşimleridir (bkz. `SAFE_AREA_PROVENANCE`). Buradaki testler yerleşimin
 * *mantığını* doğrular (çakışma tespiti, yüzde→piksel, birleşim alanı), onun
 * gerçekliğini değil. Uygulama arayüzü ölçülürse bu testler güncellenmelidir.
 */
import { describe, expect, it } from "vitest";

import { PLATFORMS } from "../../src/contract/index.js";
import {
  SAFE_AREAS,
  SAFE_AREA_PROVENANCE,
  SafeAreaError,
  assertTextInsideSafeArea,
  coveredAreaPercent,
  describeSafeArea,
  findTextViolations,
  hitSafeAreas,
  overlaps,
  safeAreaFor,
  toPixels,
  unionArea,
  unionOf,
} from "../../src/media/safeArea.js";
import type { Rect } from "../../src/media/safeArea.js";

/** Alt sağ köşe: üç platformda da aksiyon yığını bölgesi. */
const BOTTOM_RIGHT: Rect = { x: 85, y: 70, w: 12, h: 12 };
/** Sol üst orta: hiçbir yerleşime girmemeli. */
const UPPER_LEFT_MID: Rect = { x: 8, y: 30, w: 40, h: 20 };

describe("SAFE_AREAS", () => {
  it("üç platform için de bölge var", () => {
    for (const platform of PLATFORMS) {
      const areas = SAFE_AREAS[platform];
      expect(areas.length, platform).toBeGreaterThan(0);
      for (const a of areas) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.x + a.w).toBeLessThanOrEqual(100.0001);
        expect(a.y + a.h).toBeLessThanOrEqual(100.0001);
        expect(a.w).toBeGreaterThan(0);
        expect(a.h).toBeGreaterThan(0);
        expect(a.id.startsWith(platform)).toBe(true);
      }
    }
  });

  it("provenance notu kurgusal yerleşim olduğunu söylüyor", () => {
    expect(SAFE_AREA_PROVENANCE).toMatch(/KURGUSAL/);
    expect(SAFE_AREA_PROVENANCE).toMatch(/ölçülmedi/);
  });

  it("safeAreaFor kopya döner: dışarıdan mutasyon kaynağı bozulmaz", () => {
    const copy = safeAreaFor("tiktok");
    copy[0]!.x = -100;
    expect(SAFE_AREAS.tiktok[0]!.x).not.toBe(-100);
  });

  it("describeSafeArea her bölge için alan yüzdesi verir", () => {
    const rows = describeSafeArea("instagram");
    expect(rows).toHaveLength(SAFE_AREAS.instagram.length);
    for (const r of rows) {
      expect(r.areaPercent).toBeGreaterThan(0);
    }
  });
});

describe("çakışma tespiti", () => {
  it("alt sağ köşe TikTok buton yığınına giriyor", () => {
    const hits = hitSafeAreas(BOTTOM_RIGHT, SAFE_AREAS.tiktok);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.id)).toContain("tiktok.actions");
  });

  it("sol üst orta hiçbir platformda güvenli alana girmiyor", () => {
    for (const platform of PLATFORMS) {
      expect(hitSafeAreas(UPPER_LEFT_MID, SAFE_AREAS[platform]), platform).toHaveLength(0);
      expect(() => assertTextInsideSafeArea(UPPER_LEFT_MID, platform)).not.toThrow();
    }
  });

  it("kenara değme sayılmaz, 1 birim içeri girer", () => {
    const touching: Rect = { x: 82, y: 55, w: 5, h: 5 }; // tam orada başlar
    expect(overlaps(touching, { x: 82, y: 55, w: 18, h: 30 })).toBe(true);
    const outside: Rect = { x: 60, y: 55, w: 20, h: 30 }; // 80'de bitiyor
    expect(overlaps(outside, { x: 82, y: 55, w: 18, h: 30 })).toBe(false);
  });

  it("assertTextInsideSafeArea ihlalde SafeAreaError fırlatır", () => {
    expect(() => assertTextInsideSafeArea(BOTTOM_RIGHT, "tiktok")).toThrow(SafeAreaError);
    try {
      assertTextInsideSafeArea(BOTTOM_RIGHT, "youtube");
      expect.unreachable("ihlal var, fırlatmalıydı");
    } catch (err) {
      expect(err).toBeInstanceOf(SafeAreaError);
      const e = err as SafeAreaError;
      expect(e.violations.length).toBeGreaterThan(0);
      expect(e.platform).toBe("youtube");
      expect(e.message).toMatch(/güvenli alan/);
    }
  });

  it("allowTouch:true ihlali bastırır", () => {
    expect(findTextViolations(BOTTOM_RIGHT, "tiktok")).not.toHaveLength(0);
    expect(findTextViolations(BOTTOM_RIGHT, "tiktok", { allowTouch: true })).toHaveLength(0);
    expect(() =>
      assertTextInsideSafeArea(BOTTOM_RIGHT, "tiktok", { allowTouch: true }),
    ).not.toThrow();
  });
});

describe("yüzde -> piksel", () => {
  it("9:16 karede oranı korur", () => {
    const px = toPixels({ x: 50, y: 50, w: 10, h: 10 }, { width: 1080, height: 1920 });
    expect(px).toEqual({ x: 540, y: 960, w: 108, h: 192 });
    expect(px.w / px.h).toBeCloseTo(9 / 16, 6);
  });

  it("YouTube başlık bandı 1080x1920'de 141px yükseklikte", () => {
    const title = SAFE_AREAS.youtube.find((a) => a.id === "youtube.title");
    expect(title).toBeDefined();
    const px = toPixels(title as Rect, { width: 1080, height: 1920 });
    expect(px.h).toBeCloseTo(0.14 * 1920, 0);
  });
});

describe("birleşim", () => {
  it("unionOf kutu döndürür ama BOŞ ALAN DEĞİLDİR (belgelenmiş tuzak)", () => {
    const union = unionOf(SAFE_AREAS.tiktok);
    expect(union).not.toBeNull();
    // Sol üst orta TikTok'ta boş olmasına rağmen bileşik kutunun İÇİNDE.
    // Bu yüzden unionOf "metin kutusu" olarak kullanılamaz.
    const u = union as Rect;
    expect(overlaps(UPPER_LEFT_MID, u)).toBe(true);
    expect(findTextViolations(UPPER_LEFT_MID, "tiktok")).toHaveLength(0);
  });

  it("unionOf boş listede null", () => {
    expect(unionOf([])).toBeNull();
  });

  it("unionArea üst üste binen dikdörtgenleri bir kez sayar", () => {
    expect(unionArea([])).toBe(0);
    expect(unionArea([{ x: 0, y: 0, w: 10, h: 10 }])).toBe(100);
    // İki kutu üst üste: 10x10 + 10x10 - 10x10 = 100
    expect(
      unionArea([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 5, y: 5, w: 10, h: 10 },
      ]),
    ).toBe(175);
  });

  it("kapalı alan yüzdesi 0-100 arasında", () => {
    for (const platform of PLATFORMS) {
      const pct = coveredAreaPercent(platform);
      expect(pct, platform).toBeGreaterThan(0);
      expect(pct, platform).toBeLessThanOrEqual(100);
    }
  });
});
