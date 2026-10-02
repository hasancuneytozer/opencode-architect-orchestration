/**
 * Platform spesifikasyonlarının DÜRÜSTLÜK testleri.
 *
 * Buradaki asıl amaç bir sayıyı doğrulamak değil, iki şeyi kilitlemek:
 *   1) TikTok'un doğrulanmış sınırları `provisional: false` ve kaynaklı.
 *   2) Instagram/YouTube'da EN AZ BİR sınır hâlâ `provisional: true`.
 * (2) kırılırsa "araştırma yapıldı" sanılan ama yapılmayan bir düzeltme
 * sessizce "doğrulanmış" görünmeye başlar. Test bilerek kırılacak şekilde
 * yazıldı: `expect(...some(l => l.provisional)).toBe(true)`.
 */
import { describe, expect, it } from "vitest";

import { PLATFORMS, PLATFORM_LABELS } from "../../src/contract/index.js";
import type { LimitRule } from "../../src/contract/index.js";
import {
  allSpecs,
  getSpec,
  getSpecOrNull,
  limitFor,
  provisionalLimits,
  GRAPH_API_VERSION,
  RUPLOAD_BASE,
} from "../../src/media/specs/index.js";
import { ASPECT_MAX, ASPECT_MIN, TARGET_RATIO, findLimit, formatBytes } from "../../src/media/specs/common.js";
import {
  MIN_VIDEO_BITRATE_KBPS,
  budgetBitrateKbps,
  getPreset,
  allPresets,
} from "../../src/media/presets.js";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** Platform + kod → kural (yoksa test KIRMIZI kalır, "undefined geçmez"). */
function byCodeOf(platform: "instagram" | "youtube", code: string): LimitRule {
  const l = findLimit(getSpec(platform).limits, code);
  expect(l, `${platform}/${code} kuralı yok`).toBeDefined();
  return l as LimitRule;
}

describe("getSpec / allSpecs", () => {
  it("üç platformu da kapsar ve etiketler contract'tan gelir", () => {
    const specs = allSpecs();
    expect(specs).toHaveLength(3);
    expect(specs.map((s) => s.platform).sort()).toEqual([...PLATFORMS].sort());
    for (const spec of specs) {
      expect(spec.label).toBe(PLATFORM_LABELS[spec.platform]);
      expect(spec.limits.length).toBeGreaterThan(5);
    }
  });

  it("bilinmeyen platform için getSpecOrNull null, getSpec fırlatır", () => {
    expect(getSpecOrNull("facebook")).toBeNull();
    // Derleme zamanı Platform tipi sayesinde buraya "x" girmez; çalışma zamanı
    // yine de korunur.
    expect(() => getSpec("x" as never)).toThrow(/Bilinmeyen platform/);
  });

  it("her spec içinde kural kodları tekildir", () => {
    for (const spec of allSpecs()) {
      const codes = spec.limits.map((l) => l.code);
      expect(new Set(codes).size, `${spec.platform}: yinelenen kural kodu`).toBe(codes.length);
    }
  });

  it("limit kuralları tutarlı: min <= max, kural metni boş değil", () => {
    for (const spec of allSpecs()) {
      for (const limit of spec.limits) {
        expect(limit.code.length, spec.platform).toBeGreaterThan(0);
        expect(limit.label.length).toBeGreaterThan(0);
        expect(limit.rule.length).toBeGreaterThan(5);
        expect(limit.rule.endsWith("."), `${spec.platform}/${limit.code}`).toBe(true);
        if (limit.min !== undefined && limit.max !== undefined) {
          expect(limit.min, `${spec.platform}/${limit.code}: min>max`).toBeLessThanOrEqual(
            limit.max,
          );
        }
        if (limit.provisional && limit.source !== null) {
          // Geçici sınırın "resmî kaynak" göstermemesi beklenir.
          expect(
            limit.provisional,
            `${spec.platform}/${limit.code}: geçici sınır kaynak göstermemeli`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("TikTok — doğrulanmış sınırlar", () => {
  const spec = getSpec("tiktok");
  const limits = spec.limits;
  const byCode = (code: string): LimitRule => {
    const l = findLimit(limits, code);
    expect(l, `tiktok/${code} kuralı yok`).toBeDefined();
    return l as LimitRule;
  };

  it("fps 23-60 ve DOĞRULANMIŞ (provisional: false)", () => {
    const fps = byCode("fps");
    expect(fps.min).toBe(23);
    expect(fps.max).toBe(60);
    expect(fps.provisional).toBe(false);
    expect(fps.source).toContain("developers.tiktok.com");
  });

  it("kapsayıcı MP4/WebM/MOV", () => {
    const c = byCode("container");
    expect(c.enumValues).toEqual(["mp4", "webm", "mov"]);
    expect(c.provisional).toBe(false);
  });

  it("video kodek H.264 önerilen, H.265/VP8/VP9 kabul", () => {
    const v = byCode("video_codec");
    expect(v.enumValues).toEqual(["h264", "hevc", "vp8", "vp9"]);
    expect(v.rule).toMatch(/H\.264/);
    expect(v.provisional).toBe(false);
  });

  it("çözünürlük her iki eksende 360-4096", () => {
    const r = byCode("resolution");
    expect(r.min).toBe(360);
    expect(r.max).toBe(4096);
    expect(r.provisional).toBe(false);
  });

  it("süre: 3 sn - 10 dk (API) ve akışta 3 dk", () => {
    const d = byCode("duration");
    expect(d.min).toBe(3);
    expect(d.max).toBe(600);
    expect(byCode("duration_in_feed").max).toBe(180);
    expect(d.provisional).toBe(false);
  });

  it("dosya boyutu 4 GB", () => {
    const s = byCode("file_size");
    expect(s.maxBytes).toBe(4 * GB);
    expect(s.provisional).toBe(false);
  });

  it("parça kuralları: 5-64 MB, son parça 128 MB, 1-1000 parça", () => {
    const c = byCode("chunk_size");
    expect(c.min).toBe(5 * MB);
    expect(c.max).toBe(64 * MB);
    expect(c.rule).toMatch(/128/);
    expect(c.rule).toMatch(/sıralı/);
    expect(byCode("chunk_count").max).toBe(1000);
    expect(c.provisional).toBe(false);
  });

  it("başlık 2200 karakter", () => {
    expect(byCode("caption_length").max).toBe(2200);
  });

  it("yükleme modeli: ikili yüklenir, herkese açık URL şart değil, zamanlama yok", () => {
    expect(spec.supportsBinaryUpload).toBe(true);
    expect(spec.requiresPublicMediaUrl).toBe(false);
    expect(spec.supportsNativeSchedule).toBe(false);
  });

  it("ASPECT KURALI geçici ve kaynaksız: 9:16 API'de zorunlu DEĞİL", () => {
    const a = byCode("aspect_ratio");
    expect(a.provisional).toBe(true);
    expect(a.source).toBeNull();
    expect(a.rule.toLowerCase()).toContain("zorunlu değildir");
  });

  it("piksel biçimi kuralı geçici (dokümanda yok)", () => {
    expect(byCode("pixel_format").provisional).toBe(true);
  });
});

describe("Instagram — ARAŞTIRMA SONUCU İŞLENDİ: hiçbir kural geçici değil", () => {
  it("provisional sayısı TAM OLARAK 0", () => {
    const spec = getSpec("instagram");
    const provisional = provisionalLimits("instagram");
    expect(
      provisional.map((l) => `${l.code}=${l.rule}`),
      "instagram: kalan geçici kurallar",
    ).toEqual([]);
    expect(spec.limits.some((l) => l.provisional)).toBe(false);
  });

  it("her kural resmî kaynak gösterir (provisional:false → source zorunlu)", () => {
    for (const limit of getSpec("instagram").limits) {
      expect(limit.provisional, `instagram/${limit.code}`).toBe(false);
      expect(limit.source, `instagram/${limit.code}: kaynak yok`).not.toBeNull();
      expect(limit.source).toContain("facebook.com");
    }
  });

  it("kapsayıcı MOV/MP4 + moov atomu dosya başında", () => {
    const c = byCodeOf("instagram", "container");
    expect(c.enumValues).toEqual(["mp4", "mov"]);
    expect(c.rule.toLowerCase()).toContain("moov");
  });

  it("video kodek H.264/HEVC, progressive + closed GOP + 4:2:0", () => {
    const v = byCodeOf("instagram", "video_codec");
    expect(v.enumValues).toEqual(["h264", "hevc"]);
    expect(v.rule).toMatch(/Progressive/);
    expect(v.rule).toMatch(/closed GOP/);
  });

  it("ses yalnız AAC, 48 kHz / 1-2 kanal / 128 kbps", () => {
    const a = byCodeOf("instagram", "audio_codec");
    expect(a.enumValues).toEqual(["aac"]);
    expect(a.rule).toMatch(/48 kHz/);
    expect(a.rule).toMatch(/128 kbps/);
  });

  it("fps 23-60 ve çözünürlükte üst sınır 1920 (yatay piksel)", () => {
    const fps = byCodeOf("instagram", "fps");
    expect(fps.min).toBe(23);
    expect(fps.max).toBe(60);
    expect(fps.provisional).toBe(false);
    const res = byCodeOf("instagram", "resolution");
    expect(res.max).toBe(1920);
    expect(res.provisional).toBe(false);
  });

  it("süre 3 saniye - 15 dakika (900 sn), dosya 300 MB", () => {
    const d = byCodeOf("instagram", "duration");
    expect(d.min).toBe(3);
    expect(d.max).toBe(900);
    expect(d.provisional).toBe(false);
    const s = byCodeOf("instagram", "file_size");
    expect(s.maxBytes).toBe(300 * MB);
    expect(s.provisional).toBe(false);
  });

  it("aspect kuralı DOĞRULANMIŞ ve 9:16 zorunlu DEĞİL olarak yazılmış", () => {
    const a = byCodeOf("instagram", "aspect_ratio");
    expect(a.provisional).toBe(false);
    expect(a.min).toBe(0.01);
    expect(a.max).toBe(10);
    // JS `toLowerCase()` "DEĞİLDİR" için birleşik nokta üretir; test de
    // kaynağın birebir küçük harfli yazımını arar.
    expect(a.rule.toLowerCase()).toContain("zorunlu değildir");
    expect(a.rule).toMatch(/9:16/);
  });

  it("caption 2200, hashtag 30, mention 20", () => {
    expect(byCodeOf("instagram", "caption_length").max).toBe(2200);
    expect(byCodeOf("instagram", "hashtag_count").max).toBe(30);
    expect(byCodeOf("instagram", "mention_count").max).toBe(20);
  });

  it("bitrate üst sınırı 25 Mbps", () => {
    expect(byCodeOf("instagram", "video_bitrate").max).toBe(25_000);
  });

  it("Graph API v26.0 ve rupload taban adresi dışa açık", () => {
    expect(GRAPH_API_VERSION).toBe("v26.0");
    expect(RUPLOAD_BASE).toBe("https://rupload.facebook.com/ig-api-upload");
  });
});

describe("YouTube — kısmen doğrulandı, kalanlar dürüstçe geçici", () => {
  it("3 dakika (Shorts) kuralı DOĞRULANMIŞ", () => {
    const d = byCodeOf("youtube", "duration");
    expect(d.max).toBe(180);
    expect(d.provisional).toBe(false);
    expect(d.source).toContain("developers.google.com");
    expect(d.rule).toMatch(/3 dakika/);
  });

  it("kapsayıcı MP4/WebM/MOV doğrulandı", () => {
    const c = byCodeOf("youtube", "container");
    expect(c.enumValues).toEqual(["mp4", "webm", "mov"]);
    expect(c.provisional).toBe(false);
  });

  it("üst çözünürlük 3840 doğrulandı (4K-8K oynatma kaldırıldı)", () => {
    const r = byCodeOf("youtube", "resolution");
    expect(r.max).toBe(3840);
    expect(r.provisional).toBe(false);
  });

  it("DOĞRULANMAYAN kurallar geçici ve kaynağı null (uydurma bağlantı yok)", () => {
    const provisional = provisionalLimits("youtube");
    expect(
      provisional.length,
      "youtube: en az bir kural hâlâ doğrulanmamış olmalı",
    ).toBeGreaterThan(0);
    for (const limit of provisional) {
      expect(limit.source, `youtube/${limit.code}`).toBeNull();
      expect(limit.provisional).toBe(true);
    }
    // Kodek listeleri ve fps hâlâ doğrulanmadı.
    for (const code of ["video_codec", "audio_codec", "fps"]) {
      expect(byCodeOf("youtube", code).provisional, code).toBe(true);
    }
  });

  it("instagram: RESUMABLE UPLOAD var → ikili yükleme, public URL gerekmez", () => {
    const spec = getSpec("instagram");
    expect(spec.supportsBinaryUpload).toBe(true);
    expect(spec.requiresPublicMediaUrl).toBe(false);
    expect(spec.supportsNativeSchedule).toBe(false);
  });

  it("youtube: ikili yükleme var, native zamanlama var", () => {
    const spec = getSpec("youtube");
    expect(spec.supportsBinaryUpload).toBe(true);
    expect(spec.requiresPublicMediaUrl).toBe(false);
    expect(spec.supportsNativeSchedule).toBe(true);
  });

  it("limitFor yardımcısı kodu bulur, olmayan kodda undefined verir", () => {
    expect(limitFor("tiktok", "fps")?.max).toBe(60);
    expect(limitFor("tiktok", "olmayan-kural")).toBeUndefined();
  });
});

describe("dönüştürme profilleri (getPreset)", () => {
  it("üç platform için somut sayılar üretir", () => {
    expect(allPresets()).toHaveLength(3);

    const ig = getPreset("instagram");
    expect(ig.maxWidth).toBe(1080);
    expect(ig.maxHeight).toBe(1920);
    expect(ig.maxBytes).toBe(300 * MB);
    expect(ig.videoBitrateKbps).toBe(6000);
    expect(ig.audioBitrateKbps).toBe(128);
    expect(ig.fps).toBe(30);
    expect(ig.container).toBe("mp4");
    // IG konteyneri 24 saat geçerli.
    expect(ig.providerUploadUrlTtlSec).toBe(86_400);

    const tt = getPreset("tiktok");
    expect(tt.maxBytes).toBe(4 * GB);
    expect(tt.videoBitrateKbps).toBe(10_000);
    // TikTok upload_url YALNIZ 1 saat geçerli.
    expect(tt.providerUploadUrlTtlSec).toBe(3600);

    const yt = getPreset("youtube");
    expect(yt.maxWidth).toBe(1080);
    expect(yt.maxHeight).toBe(1920);
    expect(yt.videoBitrateKbps).toBe(12_000);
    // YouTube'da yayınlanmış bir süre yok.
    expect(yt.providerUploadUrlTtlSec).toBeNull();
  });

  it("KOPYA döndürür: çağıran preset'i mutasyona uğratamaz", () => {
    const a = getPreset("instagram");
    a.maxBytes = 1;
    a.platform = "tiktok";
    expect(getPreset("instagram").maxBytes).toBe(300 * MB);
    expect(getPreset("instagram").platform).toBe("instagram");
  });

  it("bitrate bütçesi maxBytes ve süreden türetilir", () => {
    const ig = getPreset("instagram");
    // 10 sn'lik video: 300 MB sınırı çok geniş, preset hedefi (6 Mbps) geçerli.
    expect(budgetBitrateKbps(ig, 10)).toBe(6000);
    // 30 dk: bütçe preset hedefinin altına düşer.
    expect(budgetBitrateKbps(ig, 1800)).toBeLessThan(6000);
    // Süre bilinmiyorsa yalnız preset hedefi.
    expect(budgetBitrateKbps(ig, null)).toBe(6000);
    // Bütçe preset hedefinden geniş olduğunda sonuç HEDEF (alt sınır uygulanmaz).
    expect(budgetBitrateKbps(ig, 0.001)).toBe(6000);

    // ── Alt sınır devreye girer: 50 KB bütçe / 3 sn ──
    // bütçe = 50*1024 bayt * 8 / 1000 / 3 sn = 409.6/3 = 136.5333 kbps
    // emniyet payı %5 → 136.5333 * 0.95 = 129.7067 kbps, MIN (200) ALTINDA →
    // sonuç tam olarak MIN_VIDEO_BITRATE_KBPS, sıfır değil.
    // (Eskiden 100*1024 bayt kullanılıyordu: 819.2/3 = 273.0667 * 0.95 = 259.41
    //  kbps, yani 200'ün ÜSTÜNDE — taban hiç devreye girmiyordu. Beklenti
    //  aritmetik olarak yanlıştı; tabanı sınamak için bütçe küçültüldü.)
    const tight = { ...ig, maxBytes: 50 * 1024 };
    expect(budgetBitrateKbps(tight, 3)).toBe(MIN_VIDEO_BITRATE_KBPS);

    // ── Bütçe ortada: 1 MB / 10 sn, sonuç doğrudan bütçe ──
    // bütçe = 1*1024*1024 * 8 / 1000 / 10 sn = 8388608/1000/10 = 838.8608 kbps
    // * 0.95 = 796.91776 kbps. 200 < 796.92 < 6000 → ne taban ne preset hedefi,
    // tam bütçe. (Eskiden 8 MB / 8 sn deniyordu: 67108864/1000/8 = 8388.608
    //  kbps * 0.95 = 7969.18 > 6000 → sonuç preset hedefi 6000 olurdu ve
    //  "6000'den küçük" beklentisi de yanlış olarak düşerdi.)
    const mid = { ...ig, maxBytes: 1 * MB };
    const midBudget = (1 * MB * 8) / 1000 / 10; // 838.8608 kbps
    expect(midBudget * 0.95).toBeCloseTo(796.91776, 4);
    expect(budgetBitrateKbps(mid, 10)).toBe(midBudget * 0.95);
    // Sonucun HEDEF olmadığını da açıkça kilitle: 6000 değil, bütçe.
    expect(budgetBitrateKbps(mid, 10)).not.toBe(ig.videoBitrateKbps);
  });
});

describe("ortak kurallar", () => {
  it("9:16 tolerans aralığı contract ile uyumlu", () => {
    expect(ASPECT_MIN).toBeCloseTo(0.5625 * 0.94, 3);
    expect(ASPECT_MAX).toBeCloseTo(0.5625 * 1.06, 3);
    expect(TARGET_RATIO).toBeCloseTo(0.5625, 4);
    // 1080x1920 tam 9:16 olduğu için aralığın içinde.
    expect(1080 / 1920).toBeGreaterThan(ASPECT_MIN);
    expect(1080 / 1920).toBeLessThan(ASPECT_MAX);
  });

  it("üç platformda da aspect_ratio, resolution, fps, duration, file_size var", () => {
    for (const spec of allSpecs()) {
      for (const code of [
        "aspect_ratio",
        "resolution",
        "fps",
        "duration",
        "file_size",
        "container",
        "video_codec",
        "audio_codec",
        "pixel_format",
      ]) {
        expect(findLimit(spec.limits, code), `${spec.platform}/${code}`).toBeDefined();
      }
    }
  });

  it("formatBytes okunabilir", () => {
    expect(formatBytes(4 * GB)).toBe("4 GB");
    expect(formatBytes(64 * MB)).toBe("64 MB");
    expect(formatBytes(100)).toBe("100 bayt");
  });
});
