/**
 * Medya katmanının tek giriş noktası. Diğer katmanlar (servisler, API)
 * `src/media/index.ts` üzerinden içe aktarır; iç dosya yollarına doğrudan
 * dokunmaz — böylece ikili yolu ya da kural kodu değişirse tek yer güncellenir.
 */
export {
  FfmpegTools,
  MediaError,
  getFfmpegTools,
  parseFrameRate,
  buildScaleFilter,
  clampCoverPercent,
  COVER_MAX_PERCENT,
  COVER_MIN_PERCENT,
  DEFAULT_COVER_PERCENT,
  FEED_MAX_SIDE,
  PROBE_TIMEOUT_MS,
  TRANSCODE_TIMEOUT_MS,
} from "./ffmpeg.js";
export type { FfmpegToolsOptions, RunOptions, RunOutcome } from "./ffmpeg.js";

export {
  FsMediaStore,
  MediaStoreError,
  UnsafeStorageKeyError,
  DEFAULT_URL_TTL_SEC,
  assertSafeKey,
  signKey,
  verifySignature,
  verifySignedUrl,
  parseSignedUrl,
  encodeKeyForUrl,
} from "./store.js";
export type { FsMediaStoreOptions, SignedUrlParts, UrlVerification } from "./store.js";

export {
  validateMedia,
  validateAllPlatforms,
  hasErrors,
  errorsOf,
  warningsOf,
  hasFinding,
  PROVISIONAL_SUFFIX,
} from "./validate.js";
export type { ValidateOptions } from "./validate.js";

export {
  SAFE_AREAS,
  SAFE_AREA_PROVENANCE,
  ALL_PLATFORMS,
  SafeAreaError,
  assertTextInsideSafeArea,
  findTextViolations,
  hitSafeAreas,
  overlaps,
  safeAreaFor,
  toPixels,
  unionOf,
  unionArea,
  coveredAreaPercent,
  describeSafeArea,
} from "./safeArea.js";
export type { Rect, SafeAreaRect, SafeAreaCheckOptions } from "./safeArea.js";

export {
  getSpec,
  getSpecOrNull,
  allSpecs,
  limitFor,
  provisionalLimits,
  labelOf,
} from "./specs/index.js";
export {
  ASPECT_MAX,
  ASPECT_MIN,
  PREFERRED_PIXEL_FORMAT,
  findLimit,
  formatBytes,
} from "./specs/common.js";
export { tiktokSpec, TIKTOK_DOCS, TIKTOK_TRANSIENT_HTTP_STATUS } from "./specs/index.js";
export { instagramSpec, instagramLimits, GRAPH_API_VERSION, RUPLOAD_BASE, INSTAGRAM_DOCS } from "./specs/index.js";
export { youtubeSpec, youtubeLimits, YOUTUBE_DOCS, YOUTUBE_API, YOUTUBE_QUOTA_UNITS } from "./specs/index.js";

export {
  getPreset,
  allPresets,
  budgetBitrateKbps,
  MIN_VIDEO_BITRATE_KBPS,
  INSTAGRAM_MAX_BYTES,
  TIKTOK_MAX_BYTES,
  YOUTUBE_MAX_BYTES,
  INSTAGRAM_CONTAINER_TTL_SEC,
  TIKTOK_UPLOAD_URL_TTL_SEC,
} from "./presets.js";
export type { TranscodePreset, TranscodeResult, PublicMediaUrl } from "../ports/index.js";
