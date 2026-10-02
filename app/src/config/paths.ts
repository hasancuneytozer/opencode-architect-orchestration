/**
 * Yol çözümleme kuralları. Göreli yollar her zaman `app/` köküne göre çözülür;
 * bu, `npm test` ile `npm start` arasındaki "farklı dizin" hatasını kapatır.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `app/` kökü. `src/config/paths.ts` buradan iki seviye yukarıdadır.
 * Derlemede `dist/config/paths.js` da aynı derinlikte olduğu için yol tutarlı kalır.
 */
export const APP_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Verilen yolu `app/` köküne göre mutlaklaştırır. Zaten mutlaksa dokunmaz. */
export function resolveAppPath(input: string, appRoot: string = APP_ROOT): string {
  return isAbsolute(input) ? resolve(input) : resolve(appRoot, input);
}

/**
 * Dizini yoksa oluşturur, mutlak yolunu döndürür.
 * Varlık garantisi isteyen her yer (medya deposu, veri dizini) bunu kullanmalıdır.
 */
export function resolveDataDir(dir: string, appRoot: string = APP_ROOT): string {
  const abs = resolveAppPath(dir, appRoot);
  mkdirSync(abs, { recursive: true });
  // Windows'ta 8.3 adları/ junctions normalize değil; canonical forma indir.
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** Ana veri dizinini oluşturup döndürür. */
export function ensureDataDir(dir: string, appRoot: string = APP_ROOT): string {
  return resolveDataDir(dir, appRoot);
}
