/**
 * Analitik adaptörlerinin ortak HTTP taşıma katmanı.
 *
 * `src/adapters/instagram/http.ts` ve `src/adapters/youtube/http.ts` ile AYNI
 * SÖZLEŞMEDE ve bilinçli olarak onlardan KOPYALANMAMIŞTIR: ortak bir taşıma
 * yazılsaydı `adapters` → `analytics` yönünde bir bağımlılık çizgisi oluşurdu
 * (veya tersi) ve üç değil iki değil, dört kopya bakımı gerekirdi. Buradaki
 * fark yalnız ikisidir ve ikisi de yazıyla gerekçelendirilmiştir:
 *   1) Varsayılan zaman aşımı 30 sn — insights/rapor çağrıları küçük JSON'dur.
 *   2) Bayt yüklemesi YOKTUR: analitik yalnız okur.
 *
 * ── `fetch` ENJEKTE EDİLİR ─────────────────────────────────────────────────
 * `options.fetch` verilmezse `globalThis.fetch` kullanılır. Testler sahte
 * `fetch` verir ve HİÇBİR test ağa çıkmaz.
 *
 * ── HATA SINIRI ─────────────────────────────────────────────────────────────
 * Yalnız TAŞIMA hataları (ağ yok, zaman aşımı, çökme) istisna olur ve
 * `AnalyticsTransportError` ile sarılır. HTTP 4xx/5xx istisna DEĞİLDİR:
 * gövdesi ve durum kodu "neden ölçülemedi" sınıflandırması için gereklidir.
 *
 * ── `now` ZORUNLUDUR ────────────────────────────────────────────────────────
 * Varsayılanı yoktur. `Retry-After` bir HTTP-TARİHİ ise bugüne göre
 * çözülmesi gerekir; saati gizleyen bir varsayılan "süre doldu mu" sorusunu
 * test edilemez hale getirir. Aynı kural `src/adapters/<platform>/http.ts`
 * içinde de yazılıdır.
 */
/** Enjekte edilebilir taşıma. Üretimde `globalThis.fetch`. */
export type AnalyticsFetch = typeof fetch;

/** Graph API / Reports çağrıları için istek zaman aşımı. */
export const ANALYTICS_DEFAULT_TIMEOUT_MS = 30_000;

export interface AnalyticsHttpRequest {
  method: "GET" | "POST";
  url: string;
  /** Header adları küçük harfe indirgenerek gönderilir. */
  headers?: Readonly<Record<string, string>>;
  /** Metin (JSON) gövde. Analitik yalnız okur; akış gövdesi yoktur. */
  body?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal | null;
}

export interface AnalyticsHttpResponse {
  status: number;
  ok: boolean;
  headers: Readonly<Record<string, string>>;
  /** Ham gövde metni. Boş gövde `""` döner, `undefined` DEĞİL. */
  body: string;
  /** Ayrıştırılmış JSON ya da `null` (bozuk/boş gövde). */
  json: unknown;
  /** `Retry-After` başlığından hesaplanan GECİKME (ms). `null` = sağlayıcı süre vermedi. */
  retryAfterMs: number | null;
}

export interface AnalyticsHttpClient {
  send(request: AnalyticsHttpRequest): Promise<AnalyticsHttpResponse>;
}

export interface AnalyticsHttpClientOptions {
  /** Testler sahte `fetch` enjekte eder. Verilmezse `globalThis.fetch`. */
  fetch?: AnalyticsFetch;
  timeoutMs?: number;
  /** Zaman kaynağı. **Varsayılanı YOKTUR.** */
  now: () => number;
}

/** Taşıma katmanı hatası: istek sunucuya hiç ulaşmadı ya da yanıt alınamadı. */
export class AnalyticsTransportError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
    readonly timedOut: boolean = false,
  ) {
    super(message);
    this.name = "AnalyticsTransportError";
  }
}

/**
 * `Retry-After` başlığını GECİKMEYE (ms) çevirir. İki biçim kabul edilir:
 * saniye sayısı ve HTTP-tarihi. Geçersiz/boş başlık → `null`.
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

/** Header sözlüğünü küçük harfe indirger; `undefined`/`null` değerleri atar. */
export function normalizeAnalyticsHeaders(
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

function collectHeaders(source: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  source.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function createAnalyticsHttpClient(
  options: AnalyticsHttpClientOptions,
): AnalyticsHttpClient {
  const transport: AnalyticsFetch =
    options.fetch ??
    ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));
  const defaultTimeoutMs = options.timeoutMs ?? ANALYTICS_DEFAULT_TIMEOUT_MS;

  return {
    async send(request: AnalyticsHttpRequest): Promise<AnalyticsHttpResponse> {
      const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = request.signal
        ? AbortSignal.any([timeoutSignal, request.signal])
        : timeoutSignal;

      const init: RequestInit = {
        method: request.method,
        headers: normalizeAnalyticsHeaders(request.headers),
        signal,
      };
      if (request.body !== undefined && request.body !== null) init.body = request.body;

      let response: Response;
      try {
        response = await transport(request.url, init);
      } catch (err) {
        const timedOut = timeoutSignal.aborted;
        throw new AnalyticsTransportError(
          timedOut
            ? `Analitik isteği zaman aşımına uğradı (${timeoutMs} ms): ${request.method} ${request.url}`
            : `Analitik isteği başarısız (ağ/hata): ${request.method} ${request.url} — ${
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

/** Nesne mi? Diziyi ve `null`'u reddeder. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Boş olmayan metin; `null` döner. */
export function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}