/** Paylaşılan satır/repository altyapısı. */
import { randomUUID } from "node:crypto";
import type { Db } from "./connection.js";
import {
  ALL_CONTENT_STATES,
  ALL_JOB_STATES,
  PLATFORMS,
  type ContentState,
  type JobState,
  type MediaInfo,
  type PerPlatformCopy,
  type Platform,
  type ValidationFinding,
} from "../contract/index.js";

export type { Db };

/** Yeni kayıt kimliği. Testler deterministik olsun diye enjekte edilebilir. */
export type IdFactory = () => string;

export const uuid: IdFactory = () => randomUUID();

/** ISO-8601 UTC damgası. SQLite'ta tüm tarihler bu biçimdedir. */
export function nowIso(d: Date = new Date()): string {
  return d.toISOString();
}

/** ISO-8601 → epoch ms. Geçersizse null. */
export function toEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** epoch ms → ISO-8601. */
export function fromEpochMs(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// Aşağıdaki üç küme `migrations/*.sql` içindeki CHECK kısıtlarıyla BİREBİR aynı
// listelerdir ve SÖZLEŞMEDEN türetilir (elle kopyalanmaz). Elle yazılan liste
// `published_no_link` eklenirken sessizce geride kalmıştı: veritabanı reddediyor,
// uygulama ise kabul ediyordu. Tek kaynak sözleşme, tek yerde değişir.
export const PLATFORM_SET = new Set<string>(PLATFORMS);
export const JOB_STATE_SET = new Set<string>(ALL_JOB_STATES);
export const CONTENT_STATE_SET = new Set<string>(ALL_CONTENT_STATES);

/** SQLite CHECK kısıtlarıyla aynı listeler; INSERT öncesi erken hata için. */
export function assertPlatform(p: string): asserts p is Platform {
  if (!PLATFORM_SET.has(p)) {
    throw new Error(`Geçersiz platform: "${p}". Beklenen: ${[...PLATFORM_SET].join(" | ")}`);
  }
}

export function assertJobState(s: string): asserts s is JobState {
  if (!JOB_STATE_SET.has(s)) {
    throw new Error(
      `Geçersiz iş durumu: "${s}". Beklenen: ${[...JOB_STATE_SET].join(" | ")}`,
    );
  }
}

export function assertContentState(s: string): asserts s is ContentState {
  if (!CONTENT_STATE_SET.has(s)) throw new Error(`Geçersiz içerik durumu: "${s}"`);
}

// ── MediaInfo / bulgular için sade normalizasyon ───────────────────────────

export function normalizeMediaInfo(info: MediaInfo): MediaInfo {
  return {
    path: info.path,
    bytes: info.bytes,
    container: info.container ?? null,
    videoCodec: info.videoCodec ?? null,
    audioCodec: info.audioCodec ?? null,
    pixelFormat: info.pixelFormat ?? null,
    width: info.width ?? null,
    height: info.height ?? null,
    fps: info.fps ?? null,
    durationSec: info.durationSec ?? null,
    bitrate: info.bitrate ?? null,
    hasAudio: info.hasAudio === true,
  };
}

export function normalizeFinding(f: ValidationFinding): ValidationFinding {
  return {
    code: f.code,
    severity: f.severity,
    message: f.message,
    ...(f.limit !== undefined ? { limit: f.limit } : {}),
    ...(f.observed !== undefined ? { observed: f.observed } : {}),
  };
}

export function normalizeFindings(list: ValidationFinding[] | null | undefined): ValidationFinding[] {
  return (list ?? []).map(normalizeFinding);
}

export function emptyCopy(): PerPlatformCopy {
  return {};
}
