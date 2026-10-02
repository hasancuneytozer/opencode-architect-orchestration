/**
 * YouTube adaptörünün HTTP taşıma katmanı. İnce, durumsuz (stateless),
 * ağ dışında hiçbir şey bilmeyen bir `fetch` sarmalayıcısı.
 *
 * ── NEDEN BÖYLE AYRI ────────────────────────────────────────────────────────
 * Yayıncı ve OAuth sağlayıcısı ikisi de aynı taşıma kurallarına ihtiyaç
 * duyuyor: zaman aşımı, metin gövde, JSON ayrıştırma, `Retry-After` okuma ve
 * "HTTP hatası bir `Response` olarak döner, istisna olarak değil" kuralı.
 * Bu kurallar iki yerde ayrı ayrı yazılırsa zamanla ayrışır; ayrıştırıcı
 * bir yerde düzeltilir, diğer yerde unutulur.
 *
 * ── `fetch` ENJEKTE EDİLİR ─────────────────────────────────────────────────
 * `options.fetch` verilmezse `globalThis.fetch` kullanılır. Testler sahte
 * bir `fetch` verir ve HİÇBİR test ağa çıkmaz. Sahte `fetch`'in gövdeyi
 * düz `Record<string, string>` header olarak aldığı varsayılır (istemci
 * böyle gönderir); testler header'ı `Headers` nesnesine çevirmeden okuyabilir.
 *
 * ── HATA SINIRI ────────────────────────────────────────────────────────────
 * Yalnız TAŞIMA hataları (ağ yok, zaman aşımı, çökme) istisna olur ve
 * `YouTubeTransportError` ile sarmalanır. HTTP 4xx/5xx bir istisna DEĞİLDİR:
 * gövdesi, header'ları ve durum kodu sınıflandırma için gereklidir. Bunu
 * istisna yapmak, `Retry-After`'ı ya da `reason` alanını kaybetmek demektir.
 */
import { RetryablePublishError } from "../../ports/index.js";

/** Enjekte edilebilir taşıma. Üretimde `globalThis.fetch`. */
export type Fetch = typeof fetch;

/** Varsayılan istek zaman aşımı. Büyük resumable gövdeler için 30 sn. */
export const YOUTUBE_DEFAULT_TIMEOUT_MS = 30_000;

export interface YouTubeHttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  /** Header adları küçük harfe indirgenerek gönderilir. */
  headers?: Readonly<Record<string, string>>;
  /** Metin (JSON) veya ikili gövde (`Uint8Array`). */
  body?: string | Uint8Array | null;
  /** Bu istek için zaman aşımı; verilmezse istemcinin varsayılanı. */
  timeoutMs?: number;
  /** Dışarıdan iptal sinyali (iptal testleri için). */
  signal?: AbortSignal | null;
}

export interface YouTubeHttpResponse {
  status: number;
  ok: boolean;
  /** Header adları küçük harfe indirgenmiş. */
  headers: Readonly<Record<string, string>>;
  /** Ham gövde metni. Boş gövde `""` döner, `undefined` DEĞİL. */
  body: string;
  /** Ayrıştırılmış JSON ya da `null` (bozuk/boş gövde). */
  json: unknown;
  /**
   * `Retry-After` başlığından hesaplanan GECİKME (ms). `429` için kritik;
   * `null` ise sağlayıcı süre vermedi, çağıran kendi politikasını uygular.
   */
  retryAfterMs: number | null;
}

export interface YouTubeHttpClient {
  send(request: YouTubeHttpRequest): Promise<YouTubeHttpResponse>;
}

export interface YouTubeHttpClientOptions {
  /** Testler sahte `fetch` enjekte eder. Verilmezse `globalThis.fetch`. */
  fetch?: Fetch;
  timeoutMs?: number;
  /**
   * Zaman kaynağı. `Retry-After` bir HTTP-TARİHİ ise bugüne göre çözülmesi
   * gerekir; bu yüzden saat dışarıdan gelir. **Varsayılanı YOKTUR** —
   * saati gizleyen bir varsayılan, "süre doldu mu" sorusunu test edilemez
   * hale getirir. Çağıran sistem saatini veren bir okuma işlevi geçirir.
   */
  now: () => number;
}

/** Taşıma katmanı hatası: istek sunucuya hiç ulaşmadı ya da yanıt alınamadı. */
export class YouTubeTransportError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
    readonly timedOut: boolean = false,
  ) {
    super(message);
    this.name = "YouTubeTransportError";
  }
}

/**
 * `Retry-After` başlığını GECİKMEYE (ms) çevirir. İki biçim kabul edilir:
 * saniye sayısı (`Retry-After: 120`) ve HTTP-tarihi.
 *
 * Geçersiz/boş başlık → `null`. "0" değeri `0` döner (dene hemen) — `0` bir
 * hata değil, sağlayıcının "kısıt yok" demesidir.
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

function collectHeaders(source: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  source.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Header sözlüğünü küçük harfe indirger; `undefined` değerleri atar. */
export function normalizeHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

/**
 * HTTP istemcisi.
 *
 * `Content-Length` bilinçli olarak header'a yazılır: YouTube resumable yükleme
 * PUT'unun `Content-Length` ve `Content-Type` değerlerinin başlangıçtaki
 * `X-Upload-Content-*` ile **aynı** olmasını şart koşar. Çalışma zamanı
 * yazılmış `Content-Length`'i kaldırırsa gövdeden kendisi doğru değeri
 * üretir (ikisi de aynı sayıdır), dolayısıyla davranış doğru kalır.
 */
export function createHttpClient(options: YouTubeHttpClientOptions): YouTubeHttpClient {
  const transport: Fetch =
    options.fetch ??
    ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));
  const defaultTimeoutMs = options.timeoutMs ?? YOUTUBE_DEFAULT_TIMEOUT_MS;

  return {
    async send(request: YouTubeHttpRequest): Promise<YouTubeHttpResponse> {
      const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      // Dışarıdan verilen iptal sinyali varsa ikisi birlikte dinlenir; sadece
      // timeout sinyali kullanmak çağıranın iptalini sessizce yutardı.
      const signal = request.signal
        ? AbortSignal.any([timeoutSignal, request.signal])
        : timeoutSignal;

      let response: Response;
      try {
        response = await transport(request.url, {
          method: request.method,
          headers: normalizeHeaders(request.headers),
          ...(request.body === undefined || request.body === null
            ? {}
            : { body: request.body as BodyInit }),
          signal,
        });
      } catch (err) {
        const timedOut = timeoutSignal.aborted;
        throw new YouTubeTransportError(
          timedOut
            ? `YouTube isteği zaman aşımına uğradı (${timeoutMs} ms): ${request.method} ${request.url}`
            : `YouTube isteği başarısız (ağ/hata): ${request.method} ${request.url} — ${
                err instanceof Error ? err.message : String(err)
              }`,
          err,
          timedOut,
        );
      }

      const body = await response.text();
      const headers = collectHeaders(response.headers);
      return {
        status: response.status,
        ok: response.ok,
        headers,
        body,
        json: safeJsonParse(body),
        retryAfterMs: parseRetryAfterMs(headers["retry-after"] ?? null, options.now()),
      };
    },
  };
}

/** Bozuk JSON istisna fırlatmaz: `null` döner, çağıran "yok" der. */
export function safeJsonParse(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Taşıma hatasını yayın hatasına çevirir.
 *
 * NEDEN `network`: ağ/sunucu yoktur; aynı istek başka bir anda başarılı
 * olabilir. `transient` DEĞİL — `transient` "sağlayıcının kendi kısa süreli
 * hatası" anlamına gelir ve farklı geri çekilme politikasına bağlıdır.
 */
export function asPublishTransportError(err: unknown, what: string): RetryablePublishError {
  if (err instanceof RetryablePublishError) return err;
  const timedOut = err instanceof YouTubeTransportError ? err.timedOut : false;
  const detail = err instanceof Error ? err.message : String(err);
  return new RetryablePublishError(
    `${what}: ${timedOut ? "zaman aşımı" : "ağ hatası"} — ${detail}`,
    "network",
    null,
    null,
    null,
    null,
  );
}
