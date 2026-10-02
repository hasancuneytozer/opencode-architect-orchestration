/**
 * HTTP katmanının tek giriş noktası.
 *
 * `main.ts`, CLI ve testler iç dosya yollarını bilmez; hepsi buradan içe
 * aktarır. Böylece `server.ts` bir dosya adı değiştirildiğinde yalnızca bu
 * dosya güncellenir ve katmanlar arası iç yol sızıntısı olmaz.
 *
 * DIŞA AKTARILAN ASIL YÜZEY: `buildServer(deps)`.
 */
export {
  APP_VERSION,
  MAX_JSON_BYTES,
  MAX_UPLOAD_BYTES,
  buildServer,
  isSecurePublicUrl,
  verifyMediaSignature,
} from "./server.js";
export type { BuildServerDeps, BuiltServer, HttpMediaStore } from "./server.js";

export {
  ERROR_CODES,
  HttpError,
  conflict,
  errorEnvelope,
  forbidden,
  fromFastifyError,
  notConfigured,
  notFound,
  notImplemented,
  okEnvelope,
  rateLimited,
  unauthorized,
  validationFailed,
} from "./errors.js";
export type { ErrorBody, ErrorCode, ErrorEnvelope } from "./errors.js";

export {
  LOGIN_LIMIT_PER_WINDOW,
  LOGIN_WINDOW_MS,
  LoginRateLimiter,
  SESSION_COOKIE,
  SESSION_TOKEN_BYTES,
  SESSION_TTL_MS,
  SessionStore,
  csrfOk,
  hashPassword,
  isStateChanging,
  normalizeOrigin,
  parsePassword,
  serializePassword,
  verifyPassword,
} from "./security.js";
export type { CsrfOptions, PasswordDigest, RateLimitOptions, Session } from "./security.js";

export { REDACT_CENSOR, REDACT_PATHS, createLogger } from "./logger.js";
export type { LoggerOptionsOverrides } from "./logger.js";

export { MAX_RANGE_BYTES, parseRange, serveFile } from "./media.js";
export type { MediaKeyResolver, ParsedRange, ServeFileOptions } from "./media.js";

export { emptyTickResult, fakeScheduler, wrapScheduler } from "./scheduler.js";
export type {
  FakeSchedulerOptions,
  SchedulerHandle,
  SchedulerStatus,
  WrapOptions,
} from "./scheduler.js";

export { buildSetupReport } from "./setup.js";
export type {
  PlatformSetup,
  SetupProblem,
  SetupReport,
  SetupSeverity,
} from "./setup.js";