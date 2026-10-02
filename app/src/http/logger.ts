/**
 * Pino yapılandırması ve SIR MASKELEME.
 *
 * ── NEDEN `redact` ZORUNLU ───────────────────────────────────────────────────
 * Bir sır, log dosyası üzerinden de sızar. "Hatırlamaya çalışmayalım" kuralı
 * 6 ay sonra bir PR'da unutulur; `redact` teknik bir güvenceye dönüşür ve
 * hatırlama gerektirmez.
 *
 * Maskelenenler:
 *   * `req.headers.authorization`  — Bearer/JWT taşıyıcıları
 *   * `req.headers.cookie`         — oturum token'ı
 *   * `req.headers["x-api-key"]`   — ingest anahtarı
 *   * `res.headers["set-cookie"]`  — yeni oturum token'ı
 *   * `*.password`, `*.token`, `*.secret`, `*.apiKey` — gövde alanları
 *
 * `SP_MASTER_KEY` bir ortam değişkenidir ve pino `env` nesnesini yalnız
 * açıkça eklendiğinde loglar; burada eklenmiyor ve `redact` listesinde de
 * bulunmuyor (maskelenmesi için loglanması gerekirdi).
 */
import { pino, type Logger, type LoggerOptions } from "pino";
import type { Writable } from "node:stream";

/** Maskelenen alanlar. Sıra yalnız okunabilirlik için. */
export const REDACT_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.Authorization",
  "req.headers.cookie",
  "req.headers.Cookie",
  'req.headers["x-api-key"]',
  'req.headers["X-Api-Key"]',
  'res.headers["set-cookie"]',
  'headers["x-api-key"]',
  'headers["authorization"]',
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  "api_key",
  "*.api_key",
  "masterKey",
  "*.masterKey",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
];

/** Maskeleme yerine yazılan metin. Gizli değer yanlışlıkla görünmesin. */
export const REDACT_CENSOR = "[maskeli]";

export interface LoggerOptionsOverrides {
  level: string;
  /** Testler: log çıktısını yakalamak için akış. */
  destination?: Writable;
  /** Testler: gürültüyü kapatmak. */
  enabled?: boolean;
}

/**
 * Logger üretir.
 *
 * `enabled: false` → hiçbir şey yazılmaz (testlerde `silent`). Aksine
 * `destination` verilmişse pino O AKIŞA yazar; testler böylece "log çıktısı
 * parolayı içeriyor mu?" sorusunu dosya sistemine bakmadan yanıtlayabilir.
 */
export function createLogger(opts: LoggerOptionsOverrides): Logger {
  const base: LoggerOptions = {
    level: opts.enabled === false ? "silent" : opts.level,
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR, remove: false },
    base: { service: "social-publish" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  // Akış verilmezse pino varsayılan olarak stdout'a (fd 1) yazar. İkinci
  // argümanın tipi `DestinationStream` (`write(msg)`) olduğu için `{ dest: 1 }`
  // gibi bir SonicBoom seçeneği BURAYA verilemez; pino(base) zaten doğru olanı
  // yapar ve bir seçenek nesnesi uydurmak tip güvenliğini bozduğu gibi
  // "stdout mu, dosya mı?" sorusunu belirsizleştirirdi.
  return opts.destination ? pino(base, opts.destination) : pino(base);
}