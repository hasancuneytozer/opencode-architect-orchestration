/**
 * Instagram adaptörünün HTTP taşıma katmanı. İnce, durumsuz (stateless),
 * ağ dışında hiçbir şey bilmeyen bir `fetch` sarmalayıcısı.
 *
 * `src/adapters/youtube/http.ts` ile AYNI SÖZLEŞMEDE; kasıtlı olarak ondan
 * KOPYALANMAMIŞTIR. İki kopya yazılsaydı zamanla ayrışır, ama tek bir ortak
 * taşıma yazılsaydı YouTube'a bağımlı olurdu (ve tersi). Buradaki fark yalnızca
 * İKİ SAYIDIR ve ikisi de yazıyla gerekçelendirilmiştir:
 *
 * 1) `INSTAGRAM_DEFAULT_TIMEOUT_MS` 30 sn — Graph API JSON çağrıları küçüktür.
 * 2) `INSTAGRAM_UPLOAD_TIMEOUT_MS` 30 DAKİKA — `rupload.facebook.com`'a 300 MB'a
 *    kadar bayt gider. 30 saniyelik bir zaman aşımı, sağlıklı bir 4G bağlantıda
 *    HATA DEĞİL ama **HATALI YENİ DENEME** üretir: sunucu isteği almış, biz
 *    zaman aşımına uğramışız, yeniden denemede aynı `offset` ile çakışma
 *    (`4xx oturum/eylem sırası hatası`) alırız. Yavaş ağda 30 dakika bile
 *    yetersiz kalabilir; bu yüzden sabit bir "makul" değer seçilmiştir.
 *
 * ── `fetch` ENJEKTE EDİLİR ─────────────────────────────────────────────────
 * `options.fetch` verilmezse `globalThis.fetch` kullanılır. Testler sahte
 * `fetch` verir ve HİÇBİR test ağa çıkmaz. Sahte `fetch`'in gövdeyi düz
 * `Record<string, string>` header olarak aldığı varsayılır (istemci böyle
 * gönderir); testler header'ı `Headers` nesnesine çevirmeden okuyabilir.
 *
 * ── İKİ GÖVDE ÇEŞİDİ ───────────────────────────────────────────────────────
 * `string` (JSON) ve `Uint8Array` yanında `NodeJS.ReadableStream` de kabul
 * edilir. Instagram yüklemesinde 300 MB bayt BELLEĞE ALINMAZ: `uploadParts`
 * yalnız o aralıktaki baytları `createReadStream({ start, end })` ile açar ve
 * doğrudan gövde olarak verir. Akış gövdesinde `duplex: "half"` ZORUNLUDUR
 * (undici reddediyorsa istek hiç gönderilmez), bu yüzden gövde türüne göre
 * eklenir.
 *
 * ── HATA SINIRI ────────────────────────────────────────────────────────────
 * Yalnız TAŞIMA hataları (ağ yok, zaman aşımı, çökme) istisna olur ve
 * `InstagramTransportError` ile sarmalanır. HTTP 4xx/5xx bir istisna DEĞİLDİR:
 * gövdesi, header'ları ve durum kodu sınıflandırma için gereklidir.
 */
import { RetryablePublishError } from "../../ports/index.js";

/** Enjekte edilebilir taşıma. Üretimde `globalThis.fetch`. */
export type Fetch = typeof fetch;

/** Graph API JSON çağrıları için istek zaman aşımı. */
export const INSTAGRAM_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `rupload.facebook.com` bayt yüklemesi için zaman aşımı (30 dakika).
 *
 * Neden bu kadar uzun: Instagram'ın DOĞRULANMIŞ en büyük dosyası 300 MB. Meta
 * "5 dakika" dediği için yaygın yazılım 5 dakika seçer; bu bir UYGULAMA İLKELERİ
 * ile çelişir çünkü yavaş bağlantıda yarım kalan yükleme "sunucu hatası"
 * sanılır ve kalıcı hata üretir. Zaman aşımı her zaman `IG_UPLOAD_TIMEOUT`'ın
 * altında olmalıdır: bir istek zaman aşımına uğradığında sunucu baytları ALMAMIŞ
 * olabilir, ama işleme devam ediyor olabilir — yeniden denemek `offset`
 * çakışması üretir.
 */
export const INSTAGRAM_UPLOAD_TIMEOUT_MS = 30 * 60_000;

export interface InstagramHttpRequest {
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

export interface InstagramHttpResponse {
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

export interface InstagramHttpClient {
  send(request: InstagramHttpRequest): Promise<InstagramHttpResponse>;
}

export interface InstagramHttpClientOptions {
  /** Testler sahte `fetch` enjekte eder. Verilmezse `globalThis.fetch`. */
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
export class InstagramTransportError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
    readonly timedOut: boolean = false,
  ) {
    super(message);
    this.name = "InstagramTransportError";
  }
}

/**
 * `Retry-After` başlığını GECİKMEYE (ms) çevirir. İki biçim kabul edilir:
 * saniye sayısı (`Retry-After: 120`) ve HTTP-tarihi.
 *
 * Geçersiz/boş başlık → `null`. "0" değeri `0` döner (dene hemen).
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

export function createHttpClient(options: InstagramHttpClientOptions): InstagramHttpClient {
  const transport: Fetch =
    options.fetch ??
    ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));
  const defaultTimeoutMs = options.timeoutMs ?? INSTAGRAM_DEFAULT_TIMEOUT_MS;

  return {
    async send(request: InstagramHttpRequest): Promise<InstagramHttpResponse> {
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
        throw new InstagramTransportError(
          timedOut
            ? `Meta isteği zaman aşımına uğradı (${timeoutMs} ms): ${request.method} ${request.url}`
            : `Meta isteği başarısız (ağ/hata): ${request.method} ${request.url} — ${
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
  const timedOut = err instanceof InstagramTransportError ? err.timedOut : false;
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