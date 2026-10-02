/**
 * `validateMedia` — saf fonksiyonun hem GERÇEK dosyalarla hem elle kurulan
 * `MediaInfo` ile testleri.
 *
 * Gerçek dosya kullanan testler (beforeAll'da üretilen sentetik MP4'ler)
 * kanıttır: kurgu doğruysa ama ffprobe alanları yanlış dolduruyorsa burada
 * yakalanır. Elle kurulan `MediaInfo` ile yazılan testler ise doğrulayıcının
 * her dalını (süre aşımı, fps, kapsayıcı, boyut...) 3 saniyede gezebilmemizi
 * sağlar; onlarca saniyelik encode beklemeden kural değişikliği etkisini
 * görebiliriz.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MediaInfo, PlatformSpec } from "../../src/contract/index.js";
import { getSpec } from "../../src/media/specs/index.js";
import {
  PROVISIONAL_SUFFIX,
  errorsOf,
  hasErrors,
  hasFinding,
  validateMedia,
  warningsOf,
} from "../../src/media/validate.js";
import { FfmpegTools } from "../../src/media/ffmpeg.js";
import { makeFixtures } from "./fixtures.js";
import type { Fixtures } from "./fixtures.js";

const tools = new FfmpegTools();
let fx: Fixtures;

beforeAll(() => {
  fx = makeFixtures();
});

afterAll(() => {
  fx?.cleanup();
}, 60_000);

/** El ile kurulabilen geçerli dikey referans. */
function baseInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: "/tmp/ornek.mp4",
    bytes: 5 * 1024 * 1024,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 15,
    bitrate: 4_000_000,
    hasAudio: true,
    ...overrides,
  };
}

function codes(findings: { code: string }[]): string[] {
  return findings.map((f) => f.code);
}

// ── Gerçek dosyalar ───────────────────────────────────────────────────────

describe("validateMedia — gerçek videolar", () => {
  it("landscape.mp4: instagram'da aspect_ratio UYARI (IG'de 9:16 zorunlu değil)", async () => {
    const info = await tools.probe(fx.landscape);
    const findings = validateMedia(info, getSpec("instagram"));
    const aspect = findings.find((f) => f.code === "aspect_ratio");
    expect(aspect, "aspect_ratio bulgusu yok").toBeDefined();
    expect(aspect?.severity).toBe("warning");
    expect(aspect?.message).toMatch(/Yatay/);
    expect(aspect?.observed).toBe("1920x1080");
    // Yatay video platformca reddedilmez; bu uygulamanın ürün kuralıdır.
    expect(errorsOf(findings).map((f) => f.code)).not.toContain("aspect_ratio");
  });

  it("landscape.mp4: youtube'da aspect_ratio HATASI", async () => {
    const info = await tools.probe(fx.landscape);
    const findings = validateMedia(info, getSpec("youtube"));
    expect(findings.find((f) => f.code === "aspect_ratio")?.severity).toBe("error");
  });

  it("landscape.mp4: TikTok'ta aspect_ratio UYARI (API zorunlu kılmıyor)", async () => {
    const info = await tools.probe(fx.landscape);
    const findings = validateMedia(info, getSpec("tiktok"));
    const aspect = findings.find((f) => f.code === "aspect_ratio");
    expect(aspect?.severity).toBe("warning");
    expect(aspect?.message).toMatch(/zorunlu değildir/);
    expect(aspect?.message).toContain(PROVISIONAL_SUFFIX);
  });

  it("good.mp4: üç platformda da HATA üretmez (warning kabul)", async () => {
    const info = await tools.probe(fx.good);
    for (const platform of ["instagram", "tiktok", "youtube"] as const) {
      const findings = validateMedia(info, getSpec(platform));
      const errors = errorsOf(findings);
      // eslint-disable-next-line no-console
      console.log(
        `[validate] good.mp4 / ${platform}: ${findings.length} bulgu, ${errors.length} hata`,
      );
      expect(errors, `${platform} hataları: ${JSON.stringify(errors)}`).toHaveLength(0);
    }
  });

  it("noaudio.mp4: no_audio bulgusu var; TikTok'ta warning, YouTube'da info", async () => {
    const info = await tools.probe(fx.noaudio);
    const tiktok = validateMedia(info, getSpec("tiktok"));
    const tiktokAudio = tiktok.find((f) => f.code === "no_audio");
    expect(tiktokAudio).toBeDefined();
    expect(tiktokAudio?.severity).toBe("warning");
    expect(tiktokAudio?.message).toMatch(/reddedilebilir/);

    const youtube = validateMedia(info, getSpec("youtube"));
    expect(youtube.find((f) => f.code === "no_audio")?.severity).toBe("info");

    const instagram = validateMedia(info, getSpec("instagram"));
    expect(instagram.find((f) => f.code === "no_audio")?.severity).toBe("info");
  });

  it("tiny.mp4 (320x568): TikTok 360px alt sınırı ihlali", async () => {
    const info = await tools.probe(fx.tiny);
    const findings = validateMedia(info, getSpec("tiktok"));
    // 320 < 360, 568 < 360 değil → yalnız genişlik ekseni ihlal ediliyor.
    const width = findings.find((f) => f.code === "width");
    expect(width).toBeDefined();
    expect(width?.severity).toBe("error");
    expect(width?.observed).toBe("width=320");
    // 9:16'ya yakın olduğu için aspect bulgusu hata değil info.
    expect(findings.find((f) => f.code === "aspect_ratio")?.severity).toBe("info");
  });

  it("good.mp4 doğrulaması saf ve tekrarlanabilir", async () => {
    const info = await tools.probe(fx.good);
    const spec = getSpec("instagram");
    expect(validateMedia(info, spec)).toEqual(validateMedia(info, spec));
  });
});

// ── Elle kurulan MediaInfo: her dal ───────────────────────────────────────

describe("validateMedia — kural dalları", () => {
  const tiktok = getSpec("tiktok");

  it("kapsayıcı desteklenmiyorsa hata", () => {
    const findings = validateMedia(baseInfo({ container: "avi,matroska" }), tiktok);
    const f = findings.find((x) => x.code === "container");
    expect(f?.severity).toBe("error");
    expect(f?.observed).toBe("avi,matroska");
  });

  it("MOV kapsayıcı TikTok'ta kabul edilir (alt dizin bazlı eşleşme)", () => {
    const findings = validateMedia(
      baseInfo({ container: "mov,mp4,m4a,3gp,3g2,mj2" }),
      tiktok,
    );
    expect(hasFinding(findings, "container")).toBe(false);
  });

  it("WEBM kapsayıcı Instagram'da reddedilir (yalnız mp4/mov)", () => {
    const findings = validateMedia(baseInfo({ container: "matroska,webm" }), getSpec("instagram"));
    expect(findings.find((f) => f.code === "container")?.severity).toBe("error");
  });

  it("video kodek dışarıdaysa hata (VP9 Instagram'da yok)", () => {
    const findings = validateMedia(baseInfo({ videoCodec: "vp9" }), getSpec("instagram"));
    const f = findings.find((x) => x.code === "video_codec");
    expect(f?.severity).toBe("error");
    // Kural DOĞRULANDI → mesaj sonuna "doğrulanmadı" notu DÜŞMEZ.
    expect(f?.message).not.toContain(PROVISIONAL_SUFFIX);
  });

  it("kodek okunamıyorsa hata", () => {
    const findings = validateMedia(baseInfo({ videoCodec: null }), tiktok);
    expect(findings.find((f) => f.code === "video_codec")?.severity).toBe("error");
  });

  it("ses kodeki dışarıdaysa uyarı", () => {
    const findings = validateMedia(baseInfo({ audioCodec: "flac" }), tiktok);
    expect(findings.find((f) => f.code === "audio_codec")?.severity).toBe("warning");
  });

  it("piksel biçimi yuv420p değilse uyarı (error DEĞİL)", () => {
    const findings = validateMedia(baseInfo({ pixelFormat: "yuv444p" }), tiktok);
    const f = findings.find((x) => x.code === "pixel_format");
    expect(f?.severity).toBe("warning");
    expect(f?.observed).toBe("yuv444p");
  });

  it("fps aralık dışıysa fps_range hatası", () => {
    const findings = validateMedia(baseInfo({ fps: 120 }), tiktok);
    const f = findings.find((x) => x.code === "fps_range");
    expect(f?.severity).toBe("error");
    expect(f?.observed).toBe("120");
    expect(f?.message).toMatch(/23-60/);
  });

  it("fps okunamıyorsa uyarı (bilgi eksik, hata değil)", () => {
    const findings = validateMedia(baseInfo({ fps: null }), tiktok);
    expect(findings.find((x) => x.code === "fps_range")?.severity).toBe("warning");
  });

  it("29.97 fps kabul edilir (kırılıklı değer 23-60 içinde)", () => {
    expect(hasFinding(validateMedia(baseInfo({ fps: 29.97 }), tiktok), "fps_range")).toBe(false);
  });

  it("çözünürlük her iki eksende küçükse tek 'resolution' bulgusu", () => {
    const findings = validateMedia(baseInfo({ width: 320, height: 240 }), tiktok);
    const f = findings.find((x) => x.code === "resolution");
    expect(f).toBeDefined();
    expect(f?.observed).toBe("320x240");
    expect(hasFinding(findings, "width")).toBe(false);
    expect(hasFinding(findings, "height")).toBe(false);
  });

  it("süre çok uzunsa duration_max", () => {
    const findings = validateMedia(baseInfo({ durationSec: 900 }), tiktok);
    const max = findings.find((f) => f.code === "duration_max");
    expect(max?.severity).toBe("error");
    // Akış sınırı 180 sn, yükleme sınırı 600 sn → ikisi de ihlal.
    expect(findings.filter((f) => f.code === "duration_max").length).toBeGreaterThan(0);
  });

  it("süre 3 dakikayı aşmıyorsa yalnız akış sınırı kontrol edilir", () => {
    const findings = validateMedia(baseInfo({ durationSec: 400 }), tiktok);
    const maxes = findings.filter((f) => f.code === "duration_max");
    expect(maxes).toHaveLength(1);
    expect(maxes[0]?.limit).toMatch(/3 dakika/);
  });

  it("süre çok kısaysa duration_min", () => {
    const findings = validateMedia(baseInfo({ durationSec: 1 }), tiktok);
    expect(findings.find((f) => f.code === "duration_min")?.severity).toBe("error");
  });

  it("dosya boyutu sınırı aşarsa hata", () => {
    const findings = validateMedia(baseInfo({ bytes: 5 * 1024 ** 3 }), tiktok);
    const f = findings.find((x) => x.code === "file_size");
    expect(f?.severity).toBe("error");
    expect(f?.message).toMatch(/GB/);
  });

  it("dosya boyutu sınır içindeyse bulgu yok", () => {
    expect(hasFinding(validateMedia(baseInfo({ bytes: 1000 }), tiktok), "file_size")).toBe(false);
  });

  it("ses yok + süre 0 → unreadable hatası, başka bulgu üretilmez", () => {
    const findings = validateMedia(baseInfo({ hasAudio: false, durationSec: 0 }), tiktok);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("unreadable");
    expect(findings[0]?.severity).toBe("error");
  });

  it("ses yok + süre bilinmiyor → yine unreadable", () => {
    const findings = validateMedia(
      baseInfo({ hasAudio: false, durationSec: null }),
      tiktok,
    );
    expect(findings[0]?.code).toBe("unreadable");
  });

  it("boyut okunamıyorsa resolution hatası", () => {
    const findings = validateMedia(baseInfo({ width: null, height: null }), tiktok);
    expect(findings.find((f) => f.code === "resolution")?.severity).toBe("error");
  });

  it("enabled:false hiçbir bulgu üretmez", () => {
    const findings = validateMedia(baseInfo({ fps: 500 }), tiktok, { enabled: false });
    expect(findings).toHaveLength(0);
  });
});

describe("geçici sınır işaretlemesi", () => {
  it("provisional kural ihlalinde severity error kalır, mesaja not düşer", () => {
    // YouTube resolution kuralı artık DOĞRULANDI; geçici kural örneği olarak
    // YouTube fps (24-60, provisional: true) kullanılıyor.
    const spec: PlatformSpec = getSpec("youtube");
    const findings = validateMedia(baseInfo({ fps: 5 }), spec);
    const f = findings.find((x) => x.code === "fps_range");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("error");
    expect(f?.message.endsWith(PROVISIONAL_SUFFIX)).toBe(true);
    expect(f?.limit).toBeTruthy();
  });

  it("downgradeProvisional:true yumuşak kapı isteyenlere seçenek", () => {
    const findings = validateMedia(baseInfo({ fps: 5 }), getSpec("youtube"), {
      downgradeProvisional: true,
    });
    const f = findings.find((x) => x.code === "fps_range");
    expect(f?.severity).toBe("warning");
    expect(f?.message.endsWith(PROVISIONAL_SUFFIX)).toBe(true);
  });

  it("doğrulanmış sınırlarda not DÜŞMEZ (TikTok fps 23-60)", () => {
    const findings = validateMedia(baseInfo({ fps: 10 }), getSpec("tiktok"));
    const f = findings.find((x) => x.code === "fps_range");
    expect(f?.severity).toBe("error");
    expect(f?.message).not.toContain(PROVISIONAL_SUFFIX);
  });

  it("Instagram'da DOĞRULANMIŞ resolution ihlali not düşmez", () => {
    const findings = validateMedia(baseInfo({ width: 2160, height: 3840 }), getSpec("instagram"));
    const f = findings.find((x) => x.code === "resolution");
    expect(f?.severity).toBe("error");
    expect(f?.message).not.toContain(PROVISIONAL_SUFFIX);
  });

  it("annotateProvisional:false not eklemez", () => {
    const findings = validateMedia(baseInfo({ fps: 5 }), getSpec("youtube"), {
      annotateProvisional: false,
    });
    const f = findings.find((x) => x.code === "fps_range");
    expect(f?.severity).toBe("error");
    expect(f?.message).not.toContain(PROVISIONAL_SUFFIX);
  });
});

describe("Instagram aspect kuralı — 9:16 zorunlu DEĞİL", () => {
  it("9:16 dışı DİKEY video uyarı üretir, hata DEĞİL", () => {
    // 1080x1350 (4:5): zorunlu aralık 0.01-10 → kabul edilir, hata vermez.
    const findings = validateMedia(baseInfo({ width: 1080, height: 1350 }), getSpec("instagram"));
    const f = findings.find((x) => x.code === "aspect_ratio");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.message).toMatch(/zorunlu değildir/);
    expect(errorsOf(findings).map((e) => e.code)).not.toContain("aspect_ratio");
  });

  it("mesaj Instagram'a özgü gerekçeyi verir (TikTok metni karışmaz)", () => {
    const ig = validateMedia(baseInfo({ width: 1080, height: 1350 }), getSpec("instagram"));
    expect(ig.find((f) => f.code === "aspect_ratio")?.message).toMatch(/0\.01:1-10:1/);
    const tt = validateMedia(baseInfo({ width: 1080, height: 1350 }), getSpec("tiktok"));
    expect(tt.find((f) => f.code === "aspect_ratio")?.message).toMatch(/TikTok/);
  });

  it("YouTube'da 9:16 dışı dikey HATA (ürün kararı: 9:16 dikey reklam)", () => {
    const findings = validateMedia(baseInfo({ width: 1080, height: 1350 }), getSpec("youtube"));
    expect(findings.find((f) => f.code === "aspect_ratio")?.severity).toBe("error");
  });
});

describe("YouTube native schedule uyarısı", () => {
  it("supportsNativeSchedule:true iken info bulgusu üretir", () => {
    const findings = validateMedia(baseInfo(), getSpec("youtube"));
    const f = findings.find((x) => x.code === "native_schedule");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("info");
    expect(f?.message).toMatch(/privacyStatus=private/);
    // Bilgi kapıyı kapatmaz.
    expect(errorsOf(findings)).toHaveLength(0);
  });

  it("zamanlaması olmayan platformda bu bulgu üretilmez", () => {
    expect(validateMedia(baseInfo(), getSpec("instagram")).some((f) => f.code === "native_schedule")).toBe(false);
    expect(validateMedia(baseInfo(), getSpec("tiktok")).some((f) => f.code === "native_schedule")).toBe(false);
  });
});

describe("bulgu yardımcıları", () => {
  it("hasErrors / errorsOf / warningsOf / hasFinding tutarlı", () => {
    const findings = validateMedia(baseInfo({ fps: 500, pixelFormat: "yuv420p10le" }), getSpec("tiktok"));
    expect(hasErrors(findings)).toBe(true);
    expect(errorsOf(findings).every((f) => f.severity === "error")).toBe(true);
    expect(warningsOf(findings).every((f) => f.severity === "warning")).toBe(true);
    expect(hasFinding(findings, "fps_range")).toBe(true);
    expect(hasFinding(findings, "olmayan")).toBe(false);
  });

  it("bulgu kodları sözleşmede sabitlenenlerden", () => {
    const spec = getSpec("youtube");
    const findings = validateMedia(
      baseInfo({ fps: 5, durationSec: 999, container: "avi", pixelFormat: "yuv422p10le" }),
      spec,
    );
    for (const f of findings) {
      expect(
        [
          "aspect_ratio",
          "orientation",
          "resolution",
          "width",
          "height",
          "container",
          "video_codec",
          "audio_codec",
          "pixel_format",
          "fps_range",
          "duration_min",
          "duration_max",
          "file_size",
          "no_audio",
          "unreadable",
          "native_schedule",
        ],
        `bilinmeyen bulgu kodu: ${f.code}`,
      ).toContain(f.code);
    }
    expect(codes(findings)).toContain("duration_max");
  });
});
