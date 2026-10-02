/**
 * Metin birleştirme testleri.
 *
 * BURADA KİLİTLENEN İKİ REGRESYON VAR:
 *  1) `hashtags: []` override'ı tabanı EZER (eski hashtag'ler geri gelmez).
 *  2) `privacy: "private"` override'ı `defaultCopy`'teki `public`'ı EZER.
 * Bu ikisi "sessizce kullanıcının kararını çalma" sınıfındadır; panelde
 * fark edilmeden yayına gider. Testler bilerek ters yazılırsa kırılır.
 */
import { describe, expect, it } from "vitest";

import { PlatformCopySchema } from "../../src/contract/index.js";
import type { PlatformCopy } from "../../src/contract/index.js";
import {
  CAPTION_MAX_CHARS,
  HASHTAG_COUNT_WARN,
  SHORTS_TAG,
  YOUTUBE_TITLE_MAX_CHARS,
  applyShortsTag,
  captionProblem,
  composeCaption,
  composeCaptionDetailed,
  composeDescription,
  composeTitle,
  resolveCopy,
  validateTitle,
} from "../../src/domain/copy.js";

/** Sözleşmenin kendi varsayılanlarıyla bir taban: privacy "public". */
function baseCopy(overrides: Partial<PlatformCopy> = {}): PlatformCopy {
  return PlatformCopySchema.parse({
    caption: "Taban caption",
    hashtags: ["taban"],
    tags: ["tabanked"],
    coverAtPercent: 35,
    ...overrides,
  });
}

describe("resolveCopy — alan bazlı birleştirme", () => {
  it("override yoksa tabanın kendisi döner (dizi kopyasıyla)", () => {
    const base = baseCopy();
    const out = resolveCopy(base, undefined);
    expect(out.hashtags).toEqual(["taban"]);
    expect(out.privacy).toBe("public");
    expect(out.hashtags).not.toBe(base.hashtags);
  });

  it("override alanlarını tabanın üstüne yazar", () => {
    const out = resolveCopy(baseCopy(), { caption: "Yeni metin", title: "Yeni başlık" });
    expect(out.caption).toBe("Yeni metin");
    expect(out.title).toBe("Yeni başlık");
    expect(out.hashtags).toEqual(["taban"]);
  });

  // ── KRİTİK REGRESYON 1 ──
  it("REGRESYON: hashtags: [] override'ı ESKİ hashtag'leri ezer", () => {
    const out = resolveCopy(baseCopy({ hashtags: ["eski", "daha_eski"] }), { hashtags: [] });
    expect(out.hashtags).toEqual([]);
    expect(out.hashtags).toHaveLength(0);
  });

  it("REGRESYON: tags: [] override'ı ESKİ etiketleri ezer", () => {
    const out = resolveCopy(baseCopy({ tags: ["eski"] }), { tags: [] });
    expect(out.tags).toEqual([]);
  });

  it("hashtags: undefined override'ı tabanı KORUR", () => {
    const out = resolveCopy(baseCopy({ hashtags: ["korunacak"] }), { hashtags: undefined });
    expect(out.hashtags).toEqual(["korunacak"]);
  });

  it("hashtags: null override'ı da tabanı korur (null = gönderilmedi)", () => {
    const out = resolveCopy(
      baseCopy({ hashtags: ["korunacak"] }),
      { hashtags: null } as unknown as Parameters<typeof resolveCopy>[1],
    );
    expect(out.hashtags).toEqual(["korunacak"]);
  });

  // ── KRİTİK REGRESYON 2 ──
  it("REGRESYON: privacy: 'private' override'ı defaultCopy'teki 'public'ı ezer", () => {
    const base = baseCopy();
    expect(base.privacy).toBe("public");
    const out = resolveCopy(base, { privacy: "private" });
    expect(out.privacy).toBe("private");
  });

  it("privacy: undefined override'ı tabanı korur", () => {
    expect(resolveCopy(baseCopy({ privacy: "unlisted" }), {}).privacy).toBe("unlisted");
    expect(resolveCopy(baseCopy({ privacy: "private" }), { privacy: undefined }).privacy).toBe(
      "private",
    );
  });

  it("boş metin override'ı taban caption'ını ezer (|| tuzağı değil)", () => {
    const out = resolveCopy(baseCopy({ caption: "eski" }), { caption: "" });
    expect(out.caption).toBe("");
  });

  it("false boolean override'ı true varsayılanı ezer", () => {
    const base = baseCopy({ madeForShorts: true, aiGenerated: true });
    const out = resolveCopy(base, { madeForShorts: false, aiGenerated: false });
    expect(out.madeForShorts).toBe(false);
    expect(out.aiGenerated).toBe(false);
  });

  it("coverAtPercent 0 dışında her sayıyı kabul eder", () => {
    expect(resolveCopy(baseCopy({ coverAtPercent: 35 }), { coverAtPercent: 90 }).coverAtPercent).toBe(
      90,
    );
  });

  it("metne dokunmaz: Türkçe karakterler ve boşluklar aynen kalır", () => {
    const out = resolveCopy(baseCopy(), { caption: "Bugünün  iki  boşluğu" });
    expect(out.caption).toBe("Bugünün  iki  boşluğu");
  });
});

describe("composeCaption", () => {
  it("caption yoksa hashtag'leri birleştirir", () => {
    expect(composeCaption(null, ["b", "c"])).toBe("b c");
    expect(composeCaption(undefined, ["b"])).toBe("b");
    expect(composeCaption("   ", ["b"])).toBe("b");
  });

  it("caption varsa hashtag'leri sonuna tek boşlukla ekler", () => {
    expect(composeCaption("Merhaba", ["b", "c"])).toBe("Merhaba b c");
  });

  it("hashtag yoksa caption aynen döner", () => {
    expect(composeCaption("Merhaba", [])).toBe("Merhaba");
    expect(composeCaption("Merhaba", null)).toBe("Merhaba");
  });

  it("ikisi de yoksa boş metin döner — null DEĞİL (null = sorun)", () => {
    const r = composeCaptionDetailed(null, []);
    expect(r.text).toBe("");
    expect(r.problem).toBeNull();
    expect(composeCaption(null, [])).toBe("");
  });

  it("tamamen boş hashtag girdileri atlanır (çift boşluk oluşmaz)", () => {
    expect(composeCaption("x", ["a", "", "   ", "b"])).toBe("x a b");
  });

  it("ensureHash seçeneğiyle eksik # eklenir, mevcut # tekrarlanmaz", () => {
    expect(composeCaption("x", ["a", "#b"], { ensureHash: true })).toBe("x #a #b");
    expect(composeCaption("x", ["#a"])).toBe("x #a");
  });

  // ── 2200 sınırı: KIRPMA YOK ──
  it("sınırın tam dibinde sorun üretmez", () => {
    const caption = "a".repeat(CAPTION_MAX_CHARS);
    const r = composeCaptionDetailed(caption, [], { platform: "instagram" });
    expect(r.problem).toBeNull();
    expect(r.text).toHaveLength(CAPTION_MAX_CHARS);
  });

  it("sınırı 1 karakter aşan caption sorun bildirir ve KIRPMAZ", () => {
    const caption = "a".repeat(CAPTION_MAX_CHARS + 1);
    const r = composeCaptionDetailed(caption, [], { platform: "tiktok" });
    expect(r.text).toBeNull();
    expect(r.problem).toContain("2200");
    expect(r.problem).toContain(String(CAPTION_MAX_CHARS + 1));
    expect(r.length).toBe(CAPTION_MAX_CHARS + 1);
    // Kırpılmış metin YOK: kısmi sonuç üretilmedi.
    expect(captionProblem(caption, [], { platform: "tiktok" })).toBe(r.problem);
    expect(composeCaption(caption, [])).toBeNull();
  });

  it("hashtag eklenmesi sınırı taşırsa caption'ın KENDİSİ korunmaz", () => {
    const caption = "b".repeat(CAPTION_MAX_CHARS - 2);
    const r = composeCaptionDetailed(caption, ["tag"], { platform: "instagram" });
    expect(r.text).toBeNull();
    expect(r.problem).not.toBeNull();
  });

  it(`${HASHTAG_COUNT_WARN} hashtag uyarı üretmez, üstü üretir`, () => {
    const atLimit = Array.from({ length: HASHTAG_COUNT_WARN }, (_, i) => `t${i}`);
    expect(composeCaptionDetailed("x", atLimit).warnings).toHaveLength(0);
    const over = [...atLimit, "ekstra"];
    const r = composeCaptionDetailed("x", over);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(String(over.length));
  });

  it("warnHashtagCount: false uyarıyı bastırır", () => {
    const over = Array.from({ length: 40 }, (_, i) => `t${i}`);
    expect(composeCaptionDetailed("x", over, { warnHashtagCount: false }).warnings).toEqual([]);
  });

  it("maxChars opsiyonu platform sınırını geçersiz kılmaz, test edilebilir kılar", () => {
    expect(composeCaption("12345", [], { maxChars: 4 })).toBeNull();
  });
});

describe("composeDescription / composeTitle", () => {
  it("bölümleri \\n\\n ile ayırır, boş bölümleri atlar", () => {
    const out = composeDescription("Açıklama", ["h1", "h2"], ["etiket"], false);
    expect(out).toBe("Açıklama\n\nh1 h2\n\netiket");
  });

  it("yalnız hashtag varsa tek bölüm üretir", () => {
    expect(composeDescription(null, ["h1"], [], false)).toBe("h1");
  });

  it("etiketleri virgülle ayırır", () => {
    expect(composeDescription("x", [], ["a", "b", "c"], false)).toBe("x\n\na, b, c");
  });

  it("madeForShorts true ise #Shorts ekler", () => {
    const out = composeDescription("x", [], [], true);
    expect(out).toBe(`x\n\n${SHORTS_TAG}`);
  });

  it("var olan #Shorts'u tekrarlamaz", () => {
    expect(composeDescription(`zaten ${SHORTS_TAG}`, [], [], true)).toBe(`zaten ${SHORTS_TAG}`);
  });

  it("madeForShorts false ise #Shorts eklemez", () => {
    expect(composeDescription("x", ["h"], ["t"], false)).not.toContain("Shorts");
  });

  it("applyShortsTag başlığa ekler, varken dokunmaz", () => {
    expect(applyShortsTag("Merhaba")).toBe(`Merhaba ${SHORTS_TAG}`);
    expect(applyShortsTag(`Merhaba ${SHORTS_TAG}`)).toBe(`Merhaba ${SHORTS_TAG}`);
    expect(applyShortsTag(null)).toBe(SHORTS_TAG);
  });

  it("composeTitle yalnız istenirse etiketler", () => {
    expect(composeTitle("Başlık", true)).toBe(`Başlık ${SHORTS_TAG}`);
    expect(composeTitle("Başlık", false)).toBe("Başlık");
  });
});

describe("validateTitle", () => {
  it("YouTube: boş başlığı reddeder", () => {
    expect(validateTitle(null, "youtube")).toEqual({
      ok: false,
      problem: expect.stringContaining("zorunlu"),
    });
    expect(validateTitle("   ", "youtube").ok).toBe(false);
  });

  it("YouTube: 100 karakter sınırı", () => {
    expect(validateTitle("a".repeat(YOUTUBE_TITLE_MAX_CHARS), "youtube").ok).toBe(true);
    const over = validateTitle("a".repeat(YOUTUBE_TITLE_MAX_CHARS + 1), "youtube");
    expect(over.ok).toBe(false);
    expect(over.problem).toContain(String(YOUTUBE_TITLE_MAX_CHARS + 1));
  });

  it("Instagram/TikTok: başlık alanı yok, sorun da yok", () => {
    expect(validateTitle(null, "instagram")).toEqual({ ok: true, problem: null });
    expect(validateTitle("a".repeat(500), "tiktok")).toEqual({ ok: true, problem: null });
  });
});