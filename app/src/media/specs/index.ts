/**
 * Platform spesifikasyonlarının tek giriş noktası.
 *
 * `getSpec` bilinmeyen platformda **sessizce yedek spec döndürmez** —
 * çağıran tarafın `switch` içinde unuttuğu bir platform, yanlış sınırlarla
 * yayın yapmasına yol açardı. Bunun yerine `getSpecOrNull` vardır ve
 * `getSpec` yalnızca `Platform` tipi (derleme zamanı garantisi) taşır.
 */
import { PLATFORMS, PLATFORM_LABELS } from "../../contract/index.js";
import type { LimitRule, Platform, PlatformSpec } from "../../contract/index.js";
import { instagramSpec } from "./instagram.js";
import { tiktokSpec } from "./tiktok.js";
import { youtubeSpec } from "./youtube.js";

const BY_PLATFORM: Record<Platform, PlatformSpec> = {
  instagram: instagramSpec,
  tiktok: tiktokSpec,
  youtube: youtubeSpec,
};

export function getSpec(platform: Platform): PlatformSpec {
  const spec = BY_PLATFORM[platform];
  if (!spec) {
    throw new Error(`Bilinmeyen platform: ${String(platform)}`);
  }
  return spec;
}

/** Çalışma zamanında gelen (HTTP gövdesi) string için güvenli sürüm. */
export function getSpecOrNull(platform: string): PlatformSpec | null {
  return (PLATFORMS as readonly string[]).includes(platform)
    ? BY_PLATFORM[platform as Platform]
    : null;
}

export function allSpecs(): PlatformSpec[] {
  return PLATFORMS.map((p) => BY_PLATFORM[p]);
}

/** Platform etiketlerini tek yerden almak için (contract zaten kaynak). */
export function labelOf(platform: Platform): string {
  return PLATFORM_LABELS[platform];
}

/** Kodla tek kural; bulunmazsa `undefined` (bulgu "sınır yok" demektir). */
export function limitFor(platform: Platform, code: string): LimitRule | undefined {
  return BY_PLATFORM[platform].limits.find((l) => l.code === code);
}

/** Doğrulanmamış (geçici) sınırların listesi — panelde "uyarı" olarak gösterilir. */
export function provisionalLimits(platform: Platform): LimitRule[] {
  return BY_PLATFORM[platform].limits.filter((l) => l.provisional);
}

export { findLimit, ASPECT_MIN, ASPECT_MAX, TARGET_RATIO } from "./common.js";
export { tiktokSpec, TIKTOK_DOCS, TIKTOK_TRANSIENT_HTTP_STATUS } from "./tiktok.js";
export {
  instagramSpec,
  instagramLimits,
  GRAPH_API_VERSION,
  RUPLOAD_BASE,
  INSTAGRAM_DOCS,
} from "./instagram.js";
export {
  youtubeSpec,
  youtubeLimits,
  YOUTUBE_DOCS,
  YOUTUBE_API,
  YOUTUBE_QUOTA_UNITS,
  YOUTUBE_INSERT_DAILY_CALL_BUCKET,
  YOUTUBE_RESUMABLE_CHUNK_BYTES,
  YOUTUBE_DEFINITION_VALUES,
  NATIVE_SCHEDULE_NOTE,
} from "./youtube.js";
