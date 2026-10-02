/**
 * ffmpeg / ffprobe adaptörü.
 *
 * İKİ BİNAYİ NEREDEN GELİYOR: Sistemde kurulu ffmpeg yok. `ffmpeg-static` ve
 * `ffprobe-static` npm paketleri ikiliyi `node_modules` içinde taşır; burada
 * `createRequire` ile doğrudan onların yolunu alıyoruz. Bilerek `declare
 * module` kullanmıyoruz: ortak `.d.ts` başka paketlerde de yazılıyor olabilir
 * ve aynı modülü iki kez tanımlamak tüm derlemeyi kırar. `createRequire`
 * tip güvenliği de bırakmıyor (aşağıdaki `as` dönüşleri).
 *
 * ALT SÜREÇ KURALLARI:
 *   - `spawn` kullanılır, `execFile` değil: çıktıyı stream olarak dinleriz,
 *     "buffer taşması" diye bir şey yoktur. Yine de sonsuza kadar büyüyen
 *     stdout için üst sınır koyarız (çok büyük JSON = zaten bozuk dosya).
 *   - `windowsHide: true`: konsol penceresi açılmasın.
 *   - Her çağrıda zaman aşımı vardır; aşımda süreç öldürülür ve *net* hata
 *     fırlatılır. Yarım kalmış bir encode sessizce "başarılı" sayılmaz.
 *
 * DİL KURALI: Bu dosya I/O yapar (bu yüzden altıncı bölümdedir). Testi tek
 * başına çalışır, veritabanı veya ağ gerektirmez.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type { MediaInfo } from "../contract/index.js";
import type { FfmpegProbe, TranscodePreset, TranscodeResult, Transcoder } from "../ports/index.js";
import { MIN_VIDEO_BITRATE_KBPS, budgetBitrateKbps } from "./presets.js";
import { PREFERRED_PIXEL_FORMAT } from "./specs/common.js";

const nodeRequire = createRequire(import.meta.url);

const FFMPEG_BIN = nodeRequire("ffmpeg-static") as string;
const FFPROBE_BIN = (nodeRequire("ffprobe-static") as { path: string }).path;

/** JPEG (JFIF/SOF0) sihirli baytları — kapak karesi doğrulaması için. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export const PROBE_TIMEOUT_MS = 60_000;
export const COVER_TIMEOUT_MS = 60_000;
/** Encode süresi videoya göre değişir; 10 dakika makul bir üst sınır. */
export const TRANSCODE_TIMEOUT_MS = 600_000;

export const COVER_MIN_PERCENT = 10;
export const COVER_MAX_PERCENT = 95;
export const DEFAULT_COVER_PERCENT = 35;

/**
 * Port tanımı KORUMALIDUR, alan adı değiştirilemez: preset'te hem `maxWidth`
 * hem `maxHeight` var ve ikisinin de dokümanı "uzun kenar, kırpma yok, yalnız
 * ölçekle" diyor. 1080x1920 kutusu için en uzun kenar 1920'dir; iki sayıyı
 * ayrı ayrı zorlamak (yatay videoyu 1080'e küçültmek) hiçbir şey kazandırmaz,
 * yalnız çözünürlük kaybettirir. Bu yüzden tek sayı kullanılır.
 */
export const FEED_MAX_SIDE = 1920;

/** Konteynere göre kodek/muxer argümanları. `container` portta üç değer alır. */
const MUXER_ARGS: Record<
  TranscodePreset["container"],
  { vcodec: string; acodec: string | null; extra: string[] }
> = {
  // IG kapsayıcısı moov atomunu dosya başında ister: faststart ZORUNLU.
  mp4: { vcodec: "libx264", acodec: "aac", extra: ["-movflags", "+faststart"] },
  mov: { vcodec: "libx264", acodec: "aac", extra: ["-movflags", "+faststart"] },
  webm: { vcodec: "libvpx-vp9", acodec: "libopus", extra: [] },
};

export class MediaError extends Error {
  constructor(
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

// ── Alt süreç ─────────────────────────────────────────────────────────────

export interface RunOptions {
  timeoutMs: number;
  /** stdout ikili mi (mjpeg) yoksa metin mi (JSON). */
  binary?: boolean;
  /** stdout üst sınırı. Aşılırsa süreç öldürülür — sığmayan buffer yok. */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface RunOutcome {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

const DEFAULT_MAX_STDOUT = 64 * 1024 * 1024;
const DEFAULT_MAX_STDERR = 32 * 1024;

/** Kısa hata metni: ffmpeg bazen 40 satır uyarı yağdırır, sonuç ilk değil. */
function tail(text: string, max = 600): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return "..." + trimmed.slice(-max);
}

function runProcess(bin: string, args: string[], opts: RunOptions): Promise<RunOutcome> {
  const {
    timeoutMs,
    binary = false,
    maxStdoutBytes = DEFAULT_MAX_STDOUT,
    maxStderrBytes = DEFAULT_MAX_STDERR,
  } = opts;

  return new Promise<RunOutcome>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(new MediaError(`Süreç başlatılamadı: ${bin}`, err instanceof Error ? err.message : null));
      return;
    }

    const out: Buffer[] = [];
    let outBytes = 0;
    let overflow = false;
    const errChunks: Buffer[] = [];
    let errBytes = 0;
    let timedOut = false;
    let settled = false;

    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* süreç zaten ölmüş */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflow) return;
      outBytes += chunk.length;
      if (outBytes > maxStdoutBytes) {
        overflow = true;
        kill();
        return;
      }
      out.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes > maxStderrBytes) return;
      errBytes += chunk.length;
      errChunks.push(chunk);
    });

    child.on("error", (err: Error) => {
      finish(() =>
        reject(new MediaError(`Süreç çalıştırılamadı: ${bin}`, err.message)),
      );
    });

    child.on("close", (code: number | null) => {
      const stderr = Buffer.concat(errChunks).toString(binary ? "utf8" : "utf8");
      finish(() => {
        if (overflow) {
          reject(
            new MediaError(
              `ffmpeg çıktısı sınıfı aştı (${maxStdoutBytes} bayt); dosya bozuk olabilir`,
            ),
          );
          return;
        }
        if (timedOut) {
          reject(
            new MediaError(
              `Zaman aşımı: ${bin} ${timeoutMs} ms içinde bitmedi`,
              tail(stderr),
            ),
          );
          return;
        }
        resolve({ stdout: Buffer.concat(out), stderr, code });
      });
    });
  });
}

// ── ffprobe çıktısı ───────────────────────────────────────────────────────

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  bit_rate?: string;
  disposition?: { attached_pic?: number };
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

/**
 * `"30000/1001"` → 29.97. Kırılıklı değerleri `parseInt` ile yutmak en sık
 * görülen fps hatasıdır (29.97 videoyu 30 kabul edip 24 sınırına takılır).
 * `"0/0"` ve `"N/A"` bilgi değil bilgi yoktur → null.
 */
export function parseFrameRate(value: string | undefined | null): number | null {
  if (!value) return null;
  const cleaned = String(value).trim().replace(/\s*fps$/i, "");
  const match = /^(\d+(?:\.\d+)?)\s*\/?\s*(\d+(?:\.\d+)?)?$/.exec(cleaned);
  if (!match) return null;
  const num = Number(match[1]);
  const den = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  if (!Number.isFinite(fps) || fps <= 0) return null;
  // 1e-6'ya kadar yuvarlama: 29.97002997 -> 29.97
  return Math.round(fps * 1e6) / 1e6;
}

function num(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Kapak görseli gibi ek görseller video akışı sayılmaz. */
function isRealVideo(s: FfprobeStream): boolean {
  return s.codec_type === "video" && s.disposition?.attached_pic !== 1;
}

// ── Uygulama ──────────────────────────────────────────────────────────────

export interface FfmpegToolsOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  probeTimeoutMs?: number;
  coverTimeoutMs?: number;
  transcodeTimeoutMs?: number;
  /** x264 hız/yoğunluk dengesi. Testlerde "ultrafast" ile hızlanır. */
  preset?: string;
  crf?: number;
}

export class FfmpegTools implements FfmpegProbe, Transcoder {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  private readonly probeTimeoutMs: number;
  private readonly coverTimeoutMs: number;
  private readonly transcodeTimeoutMs: number;
  private readonly preset: string;
  private readonly crf: number;

  constructor(opts: FfmpegToolsOptions = {}) {
    this.ffmpegPath = opts.ffmpegPath ?? FFMPEG_BIN;
    this.ffprobePath = opts.ffprobePath ?? FFPROBE_BIN;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.coverTimeoutMs = opts.coverTimeoutMs ?? COVER_TIMEOUT_MS;
    this.transcodeTimeoutMs = opts.transcodeTimeoutMs ?? TRANSCODE_TIMEOUT_MS;
    this.preset = opts.preset ?? "fast";
    this.crf = opts.crf ?? 21;
  }

  /**
   * ffprobe çalıştırır ve `MediaInfo` üretir.
   *
   * Dosya yoksa, izin yoksa, kapsayıcı tanınmıyorsa veya içinde video akışı
   * yoksa **hata fırlatır**. `-v quiet` + `fatal:false` tarzı "yut ve devam
   * et" yaklaşımı, bozuk dosyayı "0 sn, 0x0, sesiz" gibi görünür kılarak
   * doğrulayıcıyı yanıltır; bu yüzden bilinçli olarak yok.
   */
  async probe(path: string): Promise<MediaInfo> {
    const out = await runProcess(
      this.ffprobePath,
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        path,
      ],
      { timeoutMs: this.probeTimeoutMs, maxStdoutBytes: 8 * 1024 * 1024 },
    );

    if (out.code !== 0) {
      throw new MediaError(
        `ffprobe başarısız (çıkış ${out.code ?? "null"}): ${path}`,
        tail(out.stderr),
      );
    }

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(out.stdout.toString("utf8")) as FfprobeOutput;
    } catch (err) {
      throw new MediaError(
        `ffprobe çıktısı JSON değil: ${path}`,
        err instanceof Error ? err.message : null,
      );
    }

    const streams = parsed.streams ?? [];
    const videoStreams = streams.filter(isRealVideo);
    if (videoStreams.length === 0) {
      throw new MediaError(`Video akışı bulunamadı: ${path}`);
    }
    // Birden fazla video akışı varsa en büyük kareyi esas al (kalite sunumu).
    const video = videoStreams.reduce((best, s) => {
      const area = (s.width ?? 0) * (s.height ?? 0);
      const bestArea = (best.width ?? 0) * (best.height ?? 0);
      return area > bestArea ? s : best;
    }, videoStreams[0] as FfprobeStream);
    const audio = streams.find((s) => s.codec_type === "audio");
    const format = parsed.format ?? {};

    const durationSec =
      num(format.duration) ?? num(video.duration) ?? num(audio?.duration);

    let bytes = num(format.size) ?? 0;
    if (bytes <= 0) {
      // format.size yoksa (bazı akışlar) dosyadan okuyarak doldur.
      try {
        bytes = statSync(path).size;
      } catch {
        bytes = 0;
      }
    }

    return {
      path,
      bytes,
      container: format.format_name ?? null,
      videoCodec: video.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      pixelFormat: video.pix_fmt ?? null,
      width: num(video.width),
      height: num(video.height),
      fps: parseFrameRate(video.r_frame_rate) ?? parseFrameRate(video.avg_frame_rate),
      durationSec,
      bitrate: num(format.bit_rate) ?? num(video.bit_rate),
      hasAudio: Boolean(audio),
    };
  }

  /**
   * Videodan tek kare alıp JPEG olarak döner.
   *
   * `atPercent` 10-95 aralığına kırpılır: %0 kare çoğu reklam videosunda siyah
   * ya da geçiş karesidir, %100 ise dosyanın son karesi (bazı decode
   * sürücülerinde tam güvenli değildir). Aralık `PlatformCopySchema` ile de
   * eşleşir.
   */
  async grabCover(input: string, atPercent: number): Promise<Buffer> {
    const percent = clampCoverPercent(atPercent);
    const info = await this.probe(input);
    const duration = info.durationSec ?? 0;
    if (!(duration > 0)) {
      throw new MediaError(`Kapak karesi alınamadı: süre sıfır veya bilinmiyor (${input})`);
    }
    // Son kareden biraz önce dur: %95 * kısa video tam sonda tıkanabiliyor.
    const atSec = Math.min(
      Math.max(0, (duration * percent) / 100),
      Math.max(0, duration - 0.05),
    );

    const out = await runProcess(
      this.ffmpegPath,
      [
        "-v",
        "error",
        "-ss",
        atSec.toFixed(3),
        "-i",
        input,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-an",
        "-sn",
        "-f",
        "image2",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      { timeoutMs: this.coverTimeoutMs, binary: true, maxStdoutBytes: 32 * 1024 * 1024 },
    );

    if (out.code !== 0) {
      throw new MediaError(
        `Kapak karesi alınamadı (çıkış ${out.code ?? "null"}): ${input}`,
        tail(out.stderr),
      );
    }
    if (out.stdout.length === 0) {
      throw new MediaError(
        `Kapak karesi boş döndü: ${input} @%${percent} (${atSec.toFixed(2)} sn)`,
        tail(out.stderr),
      );
    }
    if (!out.stdout.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
      throw new MediaError(
        `Kapak karesi JPEG değil: ${input} (ilk baytlar ${out.stdout.subarray(0, 4).toString("hex")})`,
      );
    }
    return out.stdout;
  }

  /**
   * Yayına hazır çıktı üretir ve BOYUT SINIRINI UYGULAR.
   *
   * ÖLÇEKLEME: en uzun kenar `max(maxWidth, maxHeight)` sınırına iner,
   * **kırpma yoktur** — ölçek oransaldır. libx264 + yuv420p çift sayı kare
   * genişliği zorunlu olduğu için ölçüler aşağı yuvarlanır (en fazla 1 piksel).
   *
   * BOYUT SINIRI — `-fs` KULLANILAMAZ (ölçülmüş gerçek): ffmpeg 6.1.1'de `-fs`
   * çıktı seçeneği olarak ETKİSİZDİR. `-fs 20000` verilen 265 KB'lık bir
   * çıktıyı 20 KB'a indirmiyor, `-i`'den önce konulunca "cannot be applied to
   * input" hatası veriyor. Sessizce işe yaramayan bir bayrağı argüman
   * listesine koymak, sınırı uyguladığımız izlenimini verirken hiçbir şey
   * uygulamamış olmak demektir. Bunun yerine sınır İKİ GERÇEK yolla uygulanır:
   *   1) bitrate bütçesi: `maxBytes * 8 / 1000 / süre` (bkz. `presets.ts`)
   *   2) ölçüm sonrası gerekirse BİR DAHA daha düşük bitrate ile deneme
   * Kalan aşım sessizce yutulmaz: `withinLimits: false` döner ve çağıran işi
   * yayına GÖNDERMEZ.
   */
  async toFeedReady(
    input: string,
    output: string,
    preset: TranscodePreset,
  ): Promise<TranscodeResult> {
    const maxSide = Math.max(preset.maxWidth, preset.maxHeight);
    if (!(maxSide >= 16)) {
      throw new MediaError(
        `Geçersiz preset boyutu (maxWidth/maxHeight en az 16 olmalı): ${maxSide}`,
      );
    }
    if (!(preset.maxBytes > 0)) {
      throw new MediaError(`Geçersiz preset.maxBytes: ${String(preset.maxBytes)}`);
    }

    const info = await this.probe(input);
    const filter = buildScaleFilter(info, maxSide);

    mkdirSync(dirname(output), { recursive: true });

    // 1. deneme: preset hedefi ile boyut bütçesinin küçüğü.
    let target = budgetBitrateKbps(preset, info.durationSec);
    let attempt = 0;
    let size = 0;

    // En fazla 2 deneme: biri bütçeyle, biri de ölçülen taşmaya göre düzeltilmiş
    // hâlle. Daha fazlası zaman kaybı; kalan aşım `withinLimits:false` ile bildirilir.
    while (attempt < 2) {
      attempt += 1;
      size = await this.runTranscode(input, output, filter, preset, target);
      if (size <= preset.maxBytes) break;
      // Taşma gerçek: bitrate'i orantılı düşür, ikinci deneme.
      const scaled = Math.floor((target * preset.maxBytes) / size);
      const next = Math.max(MIN_VIDEO_BITRATE_KBPS, Math.floor(scaled * 0.95));
      if (attempt >= 2 || next >= target) break;
      target = next;
    }

    const outputInfo = await this.probe(output);
    return {
      bytes: size,
      info: outputInfo,
      withinLimits: size <= preset.maxBytes,
    };
  }

  /** Tek bir ffmpeg encode çalıştırır ve çıktı boyutunu bayt olarak döndürür. */
  private async runTranscode(
    input: string,
    output: string,
    filter: string,
    preset: TranscodePreset,
    videoBitrateKbps: number,
  ): Promise<number> {
    const args = [
      "-y",
      "-nostdin",
      "-v",
      "error",
      "-i",
      input,
      "-vf",
      filter,
      "-c:v",
      MUXER_ARGS[preset.container].vcodec,
      "-preset",
      this.preset,
      "-crf",
      String(this.crf),
      "-profile:v",
      "high",
      "-pix_fmt",
      PREFERRED_PIXEL_FORMAT,
      "-b:v",
      `${videoBitrateKbps}k`,
      // VBV tavanı: CRF kaliteyi belirler, bu tavan bitrate'i sınırlar.
      "-maxrate",
      `${videoBitrateKbps}k`,
      "-bufsize",
      `${videoBitrateKbps * 2}k`,
      "-r",
      String(preset.fps ?? 30),
      ...(MUXER_ARGS[preset.container].acodec
        ? [
            "-c:a",
            MUXER_ARGS[preset.container].acodec as string,
            "-b:a",
            `${preset.audioBitrateKbps ?? 128}k`,
            "-ar",
            "48000",
            "-ac",
            "2",
          ]
        : ["-an"]),
      ...MUXER_ARGS[preset.container].extra,
      output,
    ];

    const out = await runProcess(this.ffmpegPath, args, {
      timeoutMs: this.transcodeTimeoutMs,
      // Encode stdout üretmez; yine de bir tavan koyuyoruz.
      maxStdoutBytes: 1024 * 1024,
    });

    if (out.code !== 0) {
      throw new MediaError(
        `Dönüştürme başarısız (çıkış ${out.code ?? "null"}): ${input} -> ${output}`,
        tail(out.stderr),
      );
    }

    // ffmpeg 0 döndü ama dosya yazılmamış olabilir; sessiz boş dosya en kötü hata.
    let size = 0;
    try {
      size = statSync(output).size;
    } catch (err) {
      throw new MediaError(
        `Çıktı dosyası oluşmadı: ${output}`,
        err instanceof Error ? err.message : null,
      );
    }
    if (size <= 0) {
      throw new MediaError(`Çıktı dosyası boş: ${output}`);
    }
    return size;
  }
}

export function clampCoverPercent(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_COVER_PERCENT;
  return Math.min(COVER_MAX_PERCENT, Math.max(COVER_MIN_PERCENT, percent));
}

function evenDown(n: number): number {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

/**
 * `scale` filtresini JSDEN hesaplarız, filtre ifadesiyle değil: `gt(iw,ih)`
 * gibi ifadelerde virgül kaçışı platforma göre değişir ve sessizce bozulur.
 * Burada virgül yalnızca zincir ayracı olarak geçer.
 */
export function buildScaleFilter(info: Pick<MediaInfo, "width" | "height">, maxSide: number): string {
  const w0 = info.width;
  const h0 = info.height;
  if (w0 && h0 && w0 > 0 && h0 > 0) {
    const longest = Math.max(w0, h0);
    // Küçültme yalnız: büyütme kaliteyi artırmaz, sadece bit harcar.
    const ratio = longest > maxSide ? maxSide / longest : 1;
    const w = evenDown(w0 * ratio);
    const h = evenDown(h0 * ratio);
    return `scale=${w}:${h}:flags=bicubic,setsar=1`;
  }
  // Boyut bilinmiyorsa güvenli yedek: en uzun kenarı sınırlar, kırpmaz.
  return `scale=${maxSide}:${maxSide}:force_original_aspect_ratio=decrease:flags=bicubic,setsar=1`;
}

/** Gecikmeli tekil: açılışta ikili aranmaz, ilk kullanımda hata verir. */
let shared: FfmpegTools | null = null;

export function getFfmpegTools(opts?: FfmpegToolsOptions): FfmpegTools {
  if (opts) {
    shared = new FfmpegTools(opts);
  } else if (!shared) {
    shared = new FfmpegTools();
  }
  return shared;
}
