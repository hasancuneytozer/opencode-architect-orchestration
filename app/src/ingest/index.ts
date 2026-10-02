/**
 * Ingest katmanının tek giriş noktası. HTTP, CLI ve `main.ts` yalnızca buradan
 * içe aktarır; iç dosya yolları katmanlar arasında dağınık kalmaz.
 */
export {
  IngestService,
  IngestSourceError,
  IngestValidationError,
  MAX_INGEST_BYTES,
  COVER_AT_PERCENT,
  idempotencyKeyFor,
  sha256Hex,
  storageKeyFor,
  storageKeyForDigest,
} from "./ingest.js";
export type {
  IngestDeps,
  IngestResult,
  IngestSkip,
  IngestSource,
} from "./ingest.js";

export {
  AssetUploadError,
  defaultGetSpec,
  uploadAsset,
} from "./asset.js";
export type {
  AssetOnlyDeps,
  AssetOnlyResult,
  UploadAssetInput,
} from "./asset.js";

/**
 * KAPAK ÜRETİMİ — iki akışın ORTAK doğrusu (`IngestService` ve `uploadAsset`).
 * Dışa aktarılır ki testler üretilen anahtarı ve yardımcının hata toleransını
 * doğrudan sınayabilsin.
 */
export { attachCover, coverKeyFor } from "./cover.js";
export type { AttachCoverOptions, CoverDeps, CoverResult } from "./cover.js";

/**
 * UYGULAMA POLİTİKASI. `src/media/validate.ts`'in (platform kuralları) YANINA
 * konan, bizim ürün kararımız olan katman. İkisi `IngestService` içinde
 * birleştirilir.
 */
export {
  PLATFORM_ACCEPTANCE_NOTE,
  PRODUCT_ASPECT_CODE,
  PRODUCT_REFUSAL_NOTE,
  hasProductAspectFinding,
  productFindings,
} from "./policy.js";

export {
  API_KEY_BYTES,
  API_KEY_PATTERN,
  API_KEY_PREFIX,
  createApiKey,
  generateApiKey,
  isApiKeyShaped,
} from "./apikeys.js";
export type { CreateApiKeyOptions, NewApiKey } from "./apikeys.js";