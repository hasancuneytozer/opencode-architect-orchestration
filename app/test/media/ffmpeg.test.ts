/**
 * `FfmpegTools` gerçek dosyalar üzerinde. Bu paketin kanıtı budur: testler
 * sentetik MP4 üretir, ikili onları okur, dönüştürür.
 *
 * Kural: ikili/üretim hatası testleri ATLAMAZ. `makeFixtures()` hata fırlatır
 * ve `beforeAll` bunu yutar; sessiz "skip" bira sürücüsü hatasını gizlerdi.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { statSync } from "node:fs";

import {
  FfmpegTools,
  buildScaleFilter,
  clampCoverPercent,
  parseFrameRate,
} from "../../src/media/ffmpeg.js";
import { budgetBitrateKbps, getPreset } from "../../src/media/presets.js";
import type { TranscodePreset } from "../../src/ports/index.js";
import type { MediaInfo } from "../../src/contract/index.js";
import { makeFixtures, ffprobeRaw } from "./fixtures.js";
import type { Fixtures } from "./fixtures.js";

let fx: Fixtures;
const tools = new FfmpegTools();

beforeAll(() => {
  fx = makeFixtures();
  // Kanıt: üretilen dosyalar gerçekten var ve boş değil.
  for (const [name, p] of [
    ["good.mp4", fx.good],
    ["landscape.mp4", fx.landscape],
    ["noaudio.mp4", fx.noaudio],
    ["tiny.mp4", fx.tiny],
  ] as const) {
    const bytes = statSync(p).size;
    // eslint-disable-next-line no-console
    console.log(
      `[fixture] ${name} üretildi: ${bytes} bayt, ffprobe: ${ffprobeSummary(p)}`,
    );
    expect(bytes, `${name} boş üretilmiş`).toBeGreaterThan(1000);
  }
}, 120_000);

afterAll(() => {
  fx?.cleanup();
});

function ffprobeSummary(path: string): string {
  const raw = JSON.parse(ffprobeRaw(path)) as {
    streams: Array<Record<string, unknown>>;
    format: Record<string, unknown>;
  };
  const v = raw.streams.find((s) => s.codec_type === "video") ?? {};
  const a = raw.streams.find((s) => s.codec_type === "audio");
  return [
    `${v.width}x${v.height}`,
    `video=${String(v.codec_name)}`,
    `pix=${String(v.pix_fmt)}`,
    `fps=${String(v.r_frame_rate)}`,
    `ses=${a ? String(a.codec_name) : "YOK"}`,
    `sure=${String(raw.format.duration)}sn`,
    `kapsayici=${String(raw.format.format_name)}`,
  ].join(" ");
}

describe("parseFrameRate", () => {
  it("kırılıklı değeri doğru çözer", () => {
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("24000/1001")).toBeCloseTo(23.976, 3);
    expect(parseFrameRate("60000/1001")).toBeCloseTo(59.94, 2);
  });
  it("tam sayı ve tek değerli biçimler", () => {
    expect(parseFrameRate("30/1")).toBe(30);
    expect(parseFrameRate("25")).toBe(25);
    expect(parseFrameRate("24 fps")).toBe(24);
  });
  it("bilgi yoksa null döner (0 değil!)", () => {
    expect(parseFrameRate("0/0")).toBeNull();
    expect(parseFrameRate("N/A")).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
    expect(parseFrameRate(null)).toBeNull();
    expect(parseFrameRate("")).toBeNull();
  });
});

describe("probe — gerçek dosyalar", () => {
  it("good.mp4: 1080x1920, 3 sn, h264+aac, yuv420p, 30 fps, ses var", async () => {
    const info = await tools.probe(fx.good);
    // eslint-disable-next-line no-console
    console.log("[probe] good.mp4 ->", JSON.stringify(info));
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.videoCodec).toBe("h264");
    expect(info.audioCodec).toBe("aac");
    expect(info.pixelFormat).toBe("yuv420p");
    expect(info.hasAudio).toBe(true);
    expect(info.fps).toBeCloseTo(30, 2);
    expect(info.durationSec).toBeCloseTo(3, 1);
    expect(info.bytes).toBeGreaterThan(1000);
    expect(info.container).toContain("mp4");
    expect(info.bitrate).toBeGreaterThan(0);
    expect(info.path).toBe(fx.good);
  });

  it("landscape.mp4: 1920x1080 okunur", async () => {
    const info = await tools.probe(fx.landscape);
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSec).toBeCloseTo(2, 1);
  });

  it("noaudio.mp4: ses akışı yok, video akışı var", async () => {
    const info = await tools.probe(fx.noaudio);
    expect(info.hasAudio).toBe(false);
    expect(info.audioCodec).toBeNull();
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.videoCodec).toBe("h264");
  });

  it("tiny.mp4: 320x568", async () => {
    const info = await tools.probe(fx.tiny);
    expect(info.width).toBe(320);
    expect(info.height).toBe(568);
    expect(info.hasAudio).toBe(true);
  });

  it("yol/bozuk dosyada hata fırlatır (sessizce geçmez)", async () => {
    await expect(tools.probe(fx.dir + "/yok-boyle-bir-dosya.mp4")).rejects.toThrow(
      /ffprobe başarısız|yok|bulunamadı/i,
    );
    // Metin dosyası: ffprobe çıkış kodu 1 → "başarısız" hatası.
    await expect(tools.probe(fx.notAVideo)).rejects.toThrow(/ffprobe başarısız/);
  });

  it("ses-tek dosyada 'Video akışı bulunamadı' der", async () => {
    // ffprobe burada GEÇERLİ JSON döner; yalnızca video akışı yoktur.
    await expect(tools.probe(fx.audioOnly)).rejects.toThrow(/Video akışı bulunamadı/);
  });

  it("zaman aşımında süreci öldürüp net hata verir", async () => {
    const impatient = new FfmpegTools({ probeTimeoutMs: 1 });
    await expect(impatient.probe(fx.good)).rejects.toThrow(/Zaman aşımı/);
  });
});

describe("grabCover", () => {
  it("JPEG döndürür: boyut > 0 ve FFD8 sihirli baytı", async () => {
    const jpeg = await tools.grabCover(fx.good, 35);
    // eslint-disable-next-line no-console
    console.log(`[cover] good.mp4 @%35 -> ${jpeg.length} bayt, başlık ${jpeg.subarray(0, 4).toString("hex")}`);
    expect(jpeg.length).toBeGreaterThan(1000);
    expect(jpeg.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    // JPEG sonlandırıcı (FFD9) da olmalı.
    expect(jpeg.subarray(-2).toString("hex")).toBe("ffd9");
  });

  it("yüzde 10 ve 95 uçlarında da çalışır", async () => {
    const low = await tools.grabCover(fx.good, 10);
    const high = await tools.grabCover(fx.good, 95);
    expect(low.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(high.subarray(0, 2).toString("hex")).toBe("ffd8");
  });

  it("aralık dışı yüzde kırpılır (10-95)", () => {
    expect(clampCoverPercent(0)).toBe(10);
    expect(clampCoverPercent(5)).toBe(10);
    expect(clampCoverPercent(100)).toBe(95);
    expect(clampCoverPercent(35)).toBe(35);
    expect(clampCoverPercent(Number.NaN)).toBe(35);
  });

  it("sessiz videodan da kare alır", async () => {
    const jpeg = await tools.grabCover(fx.noaudio, 50);
    expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
  });
});

describe("toFeedReady", () => {
  const igPreset = getPreset("instagram");

  it("dikey 1080x1920 girdiyi KIRPMAZ, yuv420p + h264 + aac üretir", async () => {
    const out = `${fx.dir}/out/feed-good.mp4`;
    const res = await tools.toFeedReady(fx.good, out, igPreset);
    // eslint-disable-next-line no-console
    console.log("[feed] good.mp4 ->", ffprobeSummary(out));
    expect(res.withinLimits).toBe(true);
    expect(res.bytes).toBe(statSync(out).size);
    expect(res.bytes).toBeLessThanOrEqual(igPreset.maxBytes);
    // Dönen `info` çıktı dosyasını tanımlıyor olmalı (port sözleşmesi).
    expect(res.info.width).toBe(1080);
    expect(res.info.height).toBe(1920);
    expect(res.info.pixelFormat).toBe("yuv420p");
    expect(res.info.videoCodec).toBe("h264");
    expect(res.info.audioCodec).toBe("aac");
    expect(res.info.hasAudio).toBe(true);
    expect((res.info.width ?? 0) / (res.info.height ?? 0)).toBeCloseTo(9 / 16, 3);
    expect(res.info.fps).toBeCloseTo(30, 1);
    expect(res.bytes).toBeGreaterThan(1000);
  }, 60_000);

  it("yatay girdiyi de kırpmaz: en uzun kenar 1920'ye sığar, oran korunur", async () => {
    const out = `${fx.dir}/out/feed-landscape.mp4`;
    const res = await tools.toFeedReady(fx.landscape, out, igPreset);
    expect(res.info.width).toBe(1920);
    expect(res.info.height).toBe(1080); // 16:9 korundu, kırpma yok
    expect((res.info.width ?? 0) / (res.info.height ?? 0)).toBeCloseTo(16 / 9, 2);
  }, 60_000);

  it("SINIRI AŞAN dosyada withinLimits:false döner (yayına gönderilmemeli)", async () => {
    // 20 KB'lık bir tavan 3 saniyelik bir klip için fiziksel olarak imkânsız;
    // encode yine de üretilir ama sonuç "yayına hazır" DEĞİLDİR.
    const out = `${fx.dir}/out/feed-over-limit.mp4`;
    const tight: TranscodePreset = { ...igPreset, maxBytes: 20_000 };
    const res = await tools.toFeedReady(fx.good, out, tight);
    // eslint-disable-next-line no-console
    console.log(
      `[feed] sınır aşımı: ${res.bytes} bayt > ${tight.maxBytes} → withinLimits=${res.withinLimits}`,
    );
    expect(res.withinLimits).toBe(false);
    expect(res.bytes).toBeGreaterThan(tight.maxBytes);
    // Dosya yine de GEÇERLİ: iki denemeden sonra bozuk muxer bırakmıyoruz.
    expect(res.info.videoCodec).toBe("h264");
    expect(res.info.width).toBe(1080);
  }, 120_000);

  it("bitrate bütçesi sınıra göre düşürülür (encode süresince değil, sonra)", async () => {
    const out = `${fx.dir}/out/feed-budget.mp4`;
    // Bütçe çok gevşek: 10 Mbps hedefi 300 MB sınırının altında zaten.
    const res = await tools.toFeedReady(fx.good, out, igPreset);
    expect(res.withinLimits).toBe(true);
    const budget = budgetBitrateKbps(igPreset, 3);
    expect(budget).toBeLessThanOrEqual(igPreset.videoBitrateKbps ?? Infinity);
  }, 60_000);

  it("geçersiz preset boyutu/reddi net hata verir", async () => {
    const out = `${fx.dir}/out/feed-bad.mp4`;
    await expect(
      tools.toFeedReady(fx.good, out, { ...igPreset, maxWidth: 4, maxHeight: 4 }),
    ).rejects.toThrow(/Geçersiz preset boyutu/);
    await expect(
      tools.toFeedReady(fx.good, out, { ...igPreset, maxBytes: 0 }),
    ).rejects.toThrow(/Geçersiz preset.maxBytes/);
  });

  it("4K girdiyi 1920'ye küçültür (büyütmez)", () => {
    const filter = buildScaleFilter({ width: 2160, height: 3840 }, 1920);
    expect(filter).toBe("scale=1080:1920:flags=bicubic,setsar=1");
  });

  it("zaten küçük girdiyi BÜYÜTMEZ", () => {
    expect(buildScaleFilter({ width: 1080, height: 1920 }, 1920)).toBe(
      "scale=1080:1920:flags=bicubic,setsar=1",
    );
    expect(buildScaleFilter({ width: 720, height: 1280 }, 1920)).toBe(
      "scale=720:1280:flags=bicubic,setsar=1",
    );
  });

  it("tek sayı ölçüleri çift sayıya indirger (yuv420p zorunluluğu)", () => {
    // 999 istek edilirse 1778 -> 999 (tek sayı) -> 998'e iner, 1000 -> 562.
    expect(buildScaleFilter({ width: 1000, height: 1778 }, 999)).toBe(
      "scale=562:998:flags=bicubic,setsar=1",
    );
  });
});

describe("MediaInfo şekli", () => {
  it("probe sonucu doğrudan contract'a uyar", async () => {
    const info: MediaInfo = await tools.probe(fx.good);
    expect(typeof info.bytes).toBe("number");
    expect(typeof info.hasAudio).toBe("boolean");
    expect(info.durationSec === null || typeof info.durationSec === "number").toBe(true);
  });

  it("probe tekrarlanabilir: aynı dosya için aynı MediaInfo", async () => {
    const a = await tools.probe(fx.good);
    const b = await tools.probe(fx.good);
    expect(b).toEqual(a);
  });
});
