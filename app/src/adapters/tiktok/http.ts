/**
 * TikTok adaptörünün HTTP taşıma katmanı. İnce, durumsuz (stateless),
 * ağ dışında hiçbir şey bilmeyen bir `fetch` sarmalayıcısı.
 *
 * `src/adapters/instagram/http.ts` ve `src/adapters/youtube/http.ts` ile AYNI
 * SÖZLEŞMEDE; kasıtlı olarak hiçbirinden KOPYALANMAMIŞTIR (üç kopya zamanla
 * ayrışır, tek ortak taşıma ise bir platforma bağımlılık getirirdi). Buradaki
 * fark yalnızca İKİ SAYIDIR ve ikisi de yazıyla gerekçelendirilmiştir:
 *
 * 1) `TIKTOK_DEFAULT_TIMEOUT_MS` 30 sn — JSON çağrıları küçüktür.
 * 2) `TIKTOK_UPLOAD_TIMEOUT_MS` 60 DAKİKA — `upload_url`'a `PUT` edilen en
 *    büyük gövde **128 MB**'dir (son parça istisnası; ara parça ≤64 MB). 128 MB
 *    3 Mbps'te ≈5,7 dakika sürer; 60 dakika bunun ~10 katıdır. Neden "makul"
 *    bir değer değil: TikTok parçaları **SIRALI** kabul eder. Bir `PUT` zaman
 *    aşımına uğradığında sunucu baytı ALMIŞ olabilir; aynı parçayı tekrar
 *    göndermek sırayı bozar ve kalıcı bir hata üretir. Uzun zaman aşımı, bu
 *    çakışmayı mümkün olduğunca az üretmek içindir.
 *
 * ── `fetch` ENJEKTE EDİLİR ─────────────────────────────────────────────────
 * `options.fetch` verilmezse `globalThis.fetch` kullanılır. Testler sahte
 * taşıma verir ve HİÇBİR test ağa çıkmaz. Sahte taşımanın gövdeyi düz
 * `Record<string, string>` header olarak aldığı varsayılır (istemci böyle
 * gönderir); testler header'ı `Headers` nesnesine çevirmeden okuyabilir.
 *
 * ── İKİ GÖVDE ÇEŞİDİ ───────────────────────────────────────────────────────
 * `string` (JSON) ve `Uint8Array` yanında `NodeJS.ReadableStream` de kabul
 * edilir. 128 MB'lık bir parça belleğe ALINMAZ: `uploadParts` yalnız o aralığı
 * `createReadStream({ start, end })` ile açar ve doğrudan gövde olarak verir.
 * Akış gövdesinde `duplex: "half"` ZORUNLUDUR (undici reddediyorsa istek hiç
 * gönderilmez), bu yüzden gövde türüne göre eklenir.
 *
 * ── HATA SINIRI ────────────────────────────────────────────────────────────
 * Yalnız TAŞIMA hataları (ağ yok, zaman aşımı, çökme) istisna olur ve
 * `TikTokTransportError` ile sarmalanır. HTTP 4xx/5xx bir istisna DEĞİLDİR:
 * gövdesi, header'ları ve durum kodu sınıflandırma için gereklidir.
 */
import { RetryablePublishError } from "../../ports/index.js";

/** Enjekte edilebilir taşıma. Üretimde `globalThis.fetch`. */
export type Fetch = typeof fetch;

/** `open.tiktokapis.com` JSON çağrıları için istek zaman aşımı. */
export const TIKTOK_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `upload_url` bayt yüklemesi için zaman aşımı (60 dakika).
 *
 * Gerekçe dosya başında: en büyük tek istek 128 MB'dir ve TikTok parçaları
 * sıralı kabul eder; kısa bir zaman aşımı "sunucu baytı aldı, biz zaman aşımına
 * uğradık" durumunu üretir ve aynı parçayı tekrar göndermek kalıcı hata verir.
 * Değiştirmek tek yerdedir.
 */
export const TIKTOK_UPLOAD_TIMEOUT_MS = 60 * 60_000;

export interface TikTokHttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  /** Header adları küçük harfe indirgenerek gönderilir. */
  headers?: Readonly<Record<string, string>>;
  /** Metin (JSON), ikili (`Uint8Array`) veya AKİŞ gövde. */
  body?: string | Uint8Array | NodeJS.ReadableStream | null;
  /** Bu istek için zaman aşımı; verilmezse istemcinin varsayılanı. */
  timeoutMs?: number;
  /** Dışarıdan iptal sinyali (iptal testleri için). */
  signal?: AbortSignal | null;
}

export interface TikTokHttpResponse {
  status: number;
  ok: boolean;
  /** Header adları küçük harfe indirgenmiş. */
  headers: Readonly<Record<string, string>>;
  /** Ham gövde metni. Boş gövde `""` döner, `undefined` DEĞİL. */
  body: string;
  /** Ayrıştırılmış JSON ya da `null` (bozuk/boş gövde). */
  json: unknown;
  /** `Retry-After` başlığından hesaplanan GECİKME (ms). `null` = sağlayıcı süre vermedi. */
  retryAfterMs: number | null;
}

export interface TikTokHttpClient {
  send(request: TikTokHttpRequest): Promise<TikTokHttpResponse>;
}

export interface TikTokHttpClientOptions {
  /** Testler sahte taşıma enjekte eder. Verilmezse `globalThis.fetch`. */
  fetch?: Fetch;
  timeoutMs?: number;
  /**
   * Zaman kaynağı. `Retry-After` bir HTTP-TARİHİ ise bugüne göre çözülmesi
   * gerekir; bu yüzden saat dışarıdan gelir. **Varsayılanı YOKTUR** — saati
   * gizleyen bir varsayılan, "süre doldu mu" sorusunu test edilemez hale
   * getirir.
   */
  now: () => number;
}

/** Taşıma katmanı hatası: istek sunucuya hiç ulaşmadı ya da yanıt alınamadı. */
export class TikTokTransportError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
    readonly timedOut: boolean = false,
  ) {
    super(message);
    this.name = "TikTokTransportError";
  }
}

/**
 * `Retry-After` başlığını GECİKMEYE (ms) çevirir. İki biçim kabul edilir:
 * saniye sayısı (`Retry-After: 120`) ve HTTP-tarihi.
 *
 * ⚠️ TikTok dokümanı `Retry-After` davranışını HİÇ ANLATMIYOR (bkz. `NOTES.md`).
 * Bu yüzden okunan değer bir "bonus"tur; alan yoksa çağıran üstel geri çekilme
 * uygulamak zorundadır. Geçersiz/boş başlık → `null`.
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

/** Header sözlüğünü küçük harfe indirger; `undefined`/`null` değerleri atar. */
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

/** Gövde bir Node akışı mı? Akışta `duplex: "half"` zorunludur. */
function isStreamBody(body: unknown): body is NodeJS.ReadableStream {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { pipe?: unknown }).pipe === "function"
  );
}

export function createHttpClient(options: TikTokHttpClientOptions): TikTokHttpClient {
  const transport: Fetch =
    options.fetch ??
    ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));
  const defaultTimeoutMs = options.timeoutMs ?? TIKTOK_DEFAULT_TIMEOUT_MS;

  return {
    async send(request: TikTokHttpRequest): Promise<TikTokHttpResponse> {
      const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      // Dışarıdan verilen iptal sinyali varsa ikisi birlikte dinlenir; sadece
      // timeout sinyali kullanmak çağıranın iptalini sessizce yutardı.
      const signal = request.signal
        ? AbortSignal.any([timeoutSignal, request.signal])
        : timeoutSignal;

      const init: RequestInit & { duplex?: string } = {
        method: request.method,
        headers: normalizeHeaders(request.headers),
        signal,
      };
      if (request.body !== undefined && request.body !== null) {
        init.body = request.body as unknown as BodyInit;
        if (isStreamBody(request.body)) init.duplex = "half";
      }

      let response: Response;
      try {
        response = await transport(request.url, init);
      } catch (err) {
        const timedOut = timeoutSignal.aborted;
        throw new TikTokTransportError(
          timedOut
            ? `TikTok isteği zaman aşımına uğradı (${timeoutMs} ms): ${request.method} ${request.url}`
            : `TikTok isteği başarısız (ağ/hata): ${request.method} ${request.url} — ${
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
 * Neden `network`: ağ/sunucu yoktur; aynı istek başka bir anda başarılı olabilir.
 * `transient` DEĞİL — `transient` "sağlayıcının kendi kısa süreli hatası" anlamına
 * gelir ve farklı geri çekilme politikasına bağlıdır.
 */
export function asPublishTransportError(err: unknown, what: string): RetryablePublishError {
  if (err instanceof RetryablePublishError) return err;
  const timedOut = err instanceof TikTokTransportError ? err.timedOut : false;
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
