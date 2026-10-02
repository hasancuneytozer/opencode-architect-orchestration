/**
 * Test videolarının ÜRETİCİSİ (fixture).
 *
 * Bu dosya test değildir (vitest yalnızca `*.test.ts` toplar). Amacı tek bir
 * yerde, tekrarlanabilir biçimde gerçek MP4 dosyaları üretmek.
 *
 * NEDEN `ffmpeg-static`: sistemde kurulu ffmpeg yok; npm paketinin getirdiği
 * ikili kullanılıyor — üretim koduyla aynı ikili, aynı yol mantığı.
 *
 * ÖNEMLİ TUZAK: `testsrc` ve `sine` lavfi kaynakları **sonsuzdur**. Yalnız
 * `-shortest` yazarsanız hiçbir akış bitmediği için ffmpeg sonsuza kadar
 * kodlar (bkz. bu dosyayı yazan sırada 3 dakika süren "donmuş" üretim).
 * Doğru yol: kaynaklara `:duration=N` vermek. `-t` çıktı seçeneği de ayrıca
 * veriliyor.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nodeRequire = createRequire(import.meta.url);

export const FFMPEG_BIN = nodeRequire("ffmpeg-static") as string;
export const FFPROBE_BIN = (nodeRequire("ffprobe-static") as { path: string }).path;

export function runFfmpeg(args: string[]): void {
  const res = spawnSync(FFMPEG_BIN, args, {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(
      `ffmpeg çalıştırılamadı (${FFMPEG_BIN}). Bu ikili/ortam hatasıdır, test atlanmamalı: ${res.error.message}`,
    );
  }
  if (res.status !== 0) {
    throw new Error(
      `ffmpeg üretim hatası (çıkış ${res.status}):\n` +
        `komut: ${FFMPEG_BIN} ${args.join(" ")}\n` +
        `stderr: ${res.stderr?.slice(0, 2000) ?? ""}`,
    );
  }
}

export interface EncodeOptions {
  width: number;
  height: number;
  seconds: number;
  withAudio: boolean;
  fps?: number;
  /** Testlerde hız için ultrafast; varsayılan veryfast. */
  preset?: string;
}

/** Tek bir test videosu üretir. `testsrc` görüntü + `sine` ses. */
export function encodeTestVideo(outPath: string, opts: EncodeOptions): void {
  const { width, height, seconds, withAudio } = opts;
  const fps = opts.fps ?? 30;
  const preset = opts.preset ?? "veryfast";
  mkdirSync(join(outPath, ".."), { recursive: true });

  const args: string[] = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${width}x${height}:rate=${fps}:duration=${seconds}`,
  ];
  if (withAudio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`);
  }
  args.push(
    "-t",
    String(seconds),
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
  );
  if (withAudio) {
    args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2", "-shortest");
  }
  args.push(outPath);
  runFfmpeg(args);

  if (!existsSync(outPath)) {
    throw new Error(`ffmpeg çıkışı yazmadı: ${outPath}`);
  }
}

export interface Fixtures {
  dir: string;
  good: string;
  landscape: string;
  noaudio: string;
  tiny: string;
  notAVideo: string;
  /** Yalnız ses akışı olan geçerli kapsayıcı: "video akışı yok" yolunu sınar. */
  audioOnly: string;
  cleanup(): void;
}

/**
 * Geçici dizine dört video + bir "video değil" dosyası + ses-tek dosyası üretir.
 * Üretim başarısız olursa **hata fırlatır**; testleri sessizce atlamak,
 * ikili/ortam hatasını gizlerdi.
 */
export function makeFixtures(): Fixtures {
  const dir = mkdtempSync(join(tmpdir(), "sp-media-"));
  const p = (name: string): string => join(dir, name);

  const good = p("good.mp4");
  const landscape = p("landscape.mp4");
  const noaudio = p("noaudio.mp4");
  const tiny = p("tiny.mp4");
  const notAVideo = p("not-a-video.mp4");
  const audioOnly = p("audio-only.m4a");

  // Hedef: 1080x1920 dikey, 3 sn, H.264 + AAC  -> sıfır hata üretmeli.
  encodeTestVideo(good, { width: 1080, height: 1920, seconds: 3, withAudio: true });
  // Yatay 1920x1080 -> aspect_ratio hatası üretmeli.
  encodeTestVideo(landscape, { width: 1920, height: 1080, seconds: 2, withAudio: true });
  // Dikey ama ses akışı yok -> no_audio bulgusu.
  encodeTestVideo(noaudio, { width: 1080, height: 1920, seconds: 2, withAudio: false });
  // 320x568: dikey ve 9:16'ya yakın ama TikTok'un 360px alt sınırının altında.
  encodeTestVideo(tiny, { width: 320, height: 568, seconds: 2, withAudio: true });
  // Yalnız ses: ffprobe geçerli JSON verir ama video akışı yoktur.
  runFfmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-c:a", "aac", "-b:a", "128k",
    audioOnly,
  ]);

  writeFileSync(notAVideo, "bu bir video dosyası değil\n", "utf8");

  return {
    dir,
    good,
    landscape,
    noaudio,
    tiny,
    notAVideo,
    audioOnly,
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Test çıktısında ffprobe sonucunu da göster (kanıt). */
export function ffprobeRaw(path: string): string {
  const res = spawnSync(
    FFPROBE_BIN,
    ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
    { windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(`ffprobe başarısız (${res.status}): ${path}\n${res.stderr ?? ""}`);
  }
  return res.stdout;
}
