/**
 * Minik typed fetch istemcisi. Kütüphane yok.
 *
 * Kurallar:
 *  - Zarf açılır: başarıda `data`, hatada `error` döner.
 *  - Ağ hatası / JSON olmayan yanıt / zaman aşımı da `ApiError` olur; çağıran
 *    taraf `try/catch` ile tek bir hata yolunu ele alır ve "boş ekran" olmaz.
 *  - Sorgu dizesi boş/null değerleri atar.
 */

const BASE = "/api";
const DEFAULT_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly details: unknown;

  constructor(code: string, message: string, status: number | null = null, details: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** Sunucu çalışmıyor / ağ koptu mu? (yeniden denemek anlamlı) */
  get isNetwork(): boolean {
    return this.code === "network_error" || this.code === "timeout" || this.code === "invalid_response";
  }
}

export type QueryValue = string | number | boolean | null | undefined;

export function buildQuery(params: Record<string, QueryValue> = {}): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sunucu 401 döndüğünde çağıranın "oturum yok" demesine izin ver: `auth` kodu
 * ayrıca işaretlenir.
 */
export function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.code === "unauthorized");
}

/**
 * Ham gövde → zarf. `fetch` ve `XMLHttpRequest` YOLLARI AYNI KURALI paylaşır.
 *
 * Ayrı yazılsaydı iki taşıyıcı zamanla ayrışır: biri `ok:false` zarfını
 * `http_error` sanar, diğeri `validation_failed` mesajını düşürürdü. Tek
 * yardımcı olmasının nedeni budur.
 */
function unwrapResponse<T>(text: string, status: number, url: string): T {
  let payload: unknown = null;
  let parseFailed = false;
  if (text !== "") {
    try {
      payload = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  if (isRecord(payload) && payload["ok"] === true && "data" in payload) {
    if (status < 200 || status >= 300) {
      throw new ApiError("http_error", `Sunucu ${status} döndürdü.`, status, payload);
    }
    return payload["data"] as T;
  }

  if (isRecord(payload) && payload["ok"] === false && isRecord(payload["error"])) {
    const err = payload["error"];
    throw new ApiError(
      typeof err["code"] === "string" ? err["code"] : "unknown_error",
      typeof err["message"] === "string" ? err["message"] : "Sunucu hata döndürdü.",
      status,
      err["details"] ?? null,
    );
  }

  if (parseFailed || payload === null) {
    throw new ApiError(
      "invalid_response",
      `Sunucudan beklenmeyen yanıt (${url}, HTTP ${status}). API ayakta mı?`,
      status,
      text.slice(0, 400),
    );
  }

  throw new ApiError("http_error", `İstek başarısız (HTTP ${status}).`, status, payload);
}

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  opts: { timeoutMs?: number; formData?: boolean } = {},
): Promise<T> {
  const url = `${BASE}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      // Oturum çerezi aynı kaynak üzerinden (Vite proxy) gider.
      credentials: "same-origin",
      signal: controller.signal,
      headers: body === undefined || opts.formData ? undefined : { "content-type": "application/json" },
      body:
        body === undefined
          ? undefined
          : opts.formData
            ? (body as FormData)
            : JSON.stringify(body),
    });
  } catch (cause) {
    const aborted = cause instanceof DOMException && cause.name === "AbortError";
    throw new ApiError(
      aborted ? "timeout" : "network_error",
      aborted
        ? `Sunucu ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms içinde yanıt vermedi (${url}).`
        : `Sunucuya ulaşılamadı (${url}). API çalışıyor mu?`,
      null,
      cause,
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text().catch(() => "");
  return unwrapResponse<T>(text, response.status, url);
}

export const api = {
  get: <T>(path: string, params: Record<string, QueryValue> = {}): Promise<T> =>
    request<T>("GET", `${path}${buildQuery(params)}`, undefined),
  post: <T>(path: string, body: unknown = undefined): Promise<T> => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown): Promise<T> => request<T>("PATCH", path, body),
  del: <T>(path: string): Promise<T> => request<T>("DELETE", path, undefined),
  /** multipart yükleme (içerik dışa aktarımı). */
  upload: <T>(path: string, form: FormData, timeoutMs = 180_000): Promise<T> =>
    request<T>("POST", path, form, { formData: true, timeoutMs }),
};

/** `<video>`/`<img>` için doğrudan adresler (Range desteği sunucuda; proxy iletir). */
export function assetVideoUrl(assetId: string): string {
  return `${BASE}/v1/assets/${encodeURIComponent(assetId)}/video`;
}

// ── İlerlemeli yükleme (XHR) ────────────────────────────────────────────────

/**
 * Neden `fetch` DEĞİL: `fetch` gövde yükleme ilerlemesi VERMEZ. Yalnız indirme
 * (`response.body` okunduğunda) olay üretir; istek gövdesi tarayıcıya giderken
 * kaç bayt gittiğini `fetch` çağıranına söylemez (bkz. WHATWG "Upload
 * progress" bilinen boşluğu). 300 MB'lık bir klipte kullanıcı saniyelerce
 * tepki yok sanır — indirme göstergesi çalışsa bile.
 *
 * `XMLHttpRequest.upload.onprogress` gerçek `loaded/total` verir; aynı zamanda
 * iptal (`abort()`) de sunucudur. `request` tabanlı `api.upload` ilerleme
 * vermediği için BURADA korunur (içerik dışa aktarımı küçük ve ilerlemesiz).
 *
 * ⚠️ `xhr.withCredentials = true` ZORUNLU: istek Vite proxy üzerinden aynı
 * kaynağa gider ve oturum `sp_session` çerezi taşır. Varsayılan `false` bırakılırsa
 * çerez GİTMEZ, sunucu 401 döner ve panel "oturum yok" sanır — asıl sorun
 * dosya yükleyememek.
 */
export interface XhrUploadOptions {
  form: FormData;
  method?: "POST" | "PUT";
  /** Varsayılan 10 dakika: 2 GB yerel disk + ffmpeg probe süresi. */
  timeoutMs?: number;
  /** Yükleme ilerlemesi (0..100 tam sayı). */
  onProgress?: (percent: number) => void;
}

export interface XhrUploadHandle<T> {
  promise: Promise<T>;
  /** İptal: isteği keser ve promise `aborted` kodlu `ApiError` ile reddeder. */
  abort: () => void;
}

/** FormData içinden `File` nesnelerini yeniden kurar (kuyruk satırı → gövde). */
export function appendQueuedFile(form: FormData, field: string, file: File): void {
  form.append(field, file, file.name);
}

export function xhrUpload<T>(path: string, opts: XhrUploadOptions): XhrUploadHandle<T> {
  const url = `${BASE}${path}`;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const xhr = new XMLHttpRequest();

  const promise = new Promise<T>((resolve, reject) => {
    xhr.open(opts.method ?? "POST", url, true);
    // Oturum çerezi aynı kaynak üzerinden (proxy) gider.
    xhr.withCredentials = true;
    xhr.timeout = timeoutMs;

    if (xhr.upload !== null) {
      xhr.upload.onprogress = (event: ProgressEvent) => {
        if (!opts.onProgress) return;
        // `lengthComputable` false ise `total` 0 gelir; `progressPercent` onu
        // 0'a indirger ve gösterge son `load` çağrısında 100 olur.
        opts.onProgress(percentOf(event.loaded, event.lengthComputable ? event.total : null));
      };
    }

    xhr.onerror = () => {
      reject(new ApiError("network_error", `Sunucuya ulaşılamadı (${url}). API çalışıyor mu?`));
    };
    xhr.ontimeout = () => {
      reject(
        new ApiError("timeout", `Yükleme ${timeoutMs} ms içinde tamamlanmadı (${url}).`, 0),
      );
    };
    xhr.onabort = () => {
      reject(new ApiError("aborted", "Yükleme iptal edildi."));
    };
    xhr.onload = () => {
      // `upload.onload` (gönderme bitti) ile `load` (yanıt geldi) FARKLIDIR;
      // yüzde 100 ancak yanıt geldiğinde gösterilir.
      opts.onProgress?.(100);
      try {
        resolve(unwrapResponse<T>(String(xhr.responseText ?? ""), xhr.status, url));
      } catch (err) {
        reject(err instanceof Error ? err : new ApiError("http_error", "İstek başarısız."));
      }
    };

    xhr.send(opts.form);
  });

  return { promise, abort: () => xhr.abort() };
}

/** `loaded/total` → 0..100. `total` bilinmiyorsa 0 (gösterge "belirsiz"). */
function percentOf(loaded: number, total: number | null): number {
  if (total === null || !Number.isFinite(total) || total <= 0) return 0;
  const raw = Math.floor((loaded / total) * 100);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return raw > 100 ? 100 : raw;
}

export function assetCoverUrl(assetId: string): string {
  return `${BASE}/v1/assets/${encodeURIComponent(assetId)}/cover`;
}

export function fileNameFromContentDisposition(value: string | null | undefined): string | null {
  if (!value) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8 && utf8[1]) return decodeURIComponent(utf8[1]);
  const plain = /filename="([^"]+)"/i.exec(value);
  return plain && plain[1] ? plain[1] : null;
}