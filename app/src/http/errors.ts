/**
 * HTTP HATA ZARFI — TEK yer.
 *
 * SÖZLEŞME (panel bunu kullanıyor):
 *   başarı → 200/201/202 { ok: true,  data: ... }
 *   hata   → 4xx/5xx  { ok: false, error: { code, message, details? } }
 *
 * `code` kebab-case MAKİNE kodudur (insan metni DEĞİL): panel mantığı
 * `code`'a göre yazar. `message` insan içindir ve çevrilebilir.
 *
 * Neden `HttpError` sınıfı: handler içinde `reply.code(404).send(...)` yazmak,
 * dokuz farklı yerde dokuz farklı zarf üretir. Burada TEK üretici var ve
 * `setErrorHandler` her şeyi aynı biçime zorlar.
 */

/** Makine kodları. Panel bu listeyi tanır; yeni kod eklerken buraya da ekle. */
export const ERROR_CODES = [
  "validation_failed",
  "not_found",
  "unauthorized",
  "forbidden",
  "csrf_failed",
  "rate_limited",
  "conflict",
  "not_configured",
  "not_implemented",
  "payload_too_large",
  "unsupported_media_type",
  "method_not_allowed",
  "internal_error",
  "bad_request",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  not_found: 404,
  unauthorized: 401,
  forbidden: 403,
  csrf_failed: 403,
  rate_limited: 429,
  conflict: 409,
  not_configured: 503,
  not_implemented: 501,
  payload_too_large: 413,
  unsupported_media_type: 415,
  method_not_allowed: 405,
  internal_error: 500,
  bad_request: 400,
};

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ErrorEnvelope {
  ok: false;
  error: ErrorBody;
}

/** Handler'ların fırlattığı hata. Durum kodu ve makine kodu BİRLİKTE verilir. */
export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly statusOverride?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }

  get status(): number {
    return this.statusOverride ?? DEFAULT_STATUS[this.code];
  }
}

export const notFound = (what = "kayıt"): HttpError =>
  new HttpError("not_found", `${what} bulunamadı.`);

export const unauthorized = (message = "Oturum gerekli."): HttpError =>
  new HttpError("unauthorized", message);

export const forbidden = (message = "Bu işlem için yetkiniz yok."): HttpError =>
  new HttpError("forbidden", message);

export const validationFailed = (
  message: string,
  details?: unknown,
): HttpError => new HttpError("validation_failed", message, details);

export const conflict = (message: string): HttpError => new HttpError("conflict", message);

export const rateLimited = (message: string): HttpError => new HttpError("rate_limited", message);

export const notConfigured = (message: string): HttpError =>
  new HttpError("not_configured", message);

export const notImplemented = (message: string): HttpError =>
  new HttpError("not_implemented", message);

export function okEnvelope<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

export function errorEnvelope(code: string, message: string, details?: unknown): ErrorEnvelope {
  return { ok: false, error: details === undefined ? { code, message } : { code, message, details } };
}

/**
 * Fastify'nin kendi hatalarını (düzensiz JSON, gövde limiti, 404) zarfımıza
 * çevirir. Kullanıcının göreceği `statusCode` ile `code` EŞLEŞMESİ şart:
 * "HTTP 400 ama code=internal_error" panelde yanlış mesaj gösterir.
 */
export function fromFastifyError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const anyErr = err as { statusCode?: number; code?: string; message?: string } | null;
  const status = typeof anyErr?.statusCode === "number" ? anyErr.statusCode : 500;
  const message = typeof anyErr?.message === "string" ? anyErr.message : "Beklenmeyen hata.";

  if (status === 400) {
    // Fastify gövde parse hataları `FST_ERR_CTP_*` ile gelir.
    return new HttpError("bad_request", `İstek gövdesi okunamadı: ${message}`);
  }
  if (status === 401) return new HttpError("unauthorized", message);
  if (status === 403) return new HttpError("forbidden", message);
  if (status === 404) return new HttpError("not_found", message);
  if (status === 405) return new HttpError("method_not_allowed", message);
  if (status === 413) {
    return new HttpError("payload_too_large", `Gövde çok büyük (üst sınır aşıldı): ${message}`);
  }
  if (status === 415) return new HttpError("unsupported_media_type", message);
  return new HttpError("internal_error", message, undefined, status);
}