/**
 * JSON sütun yardımcıları.
 *
 * SQLite'ta JSON tipi yok; sütunlar TEXT tutulur. Bu modül tek yazma yoludur,
 * böylece bozuk JSON'un veritabanına sızmaması garanti edilir.
 */
import { z } from "zod";

/** Serileştirir; `undefined` alanlarını atar (JSON'da undefined olamaz). */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Parse eder. Okuma hatası sessizce yutulmaz: `fallback` döner. */
export function fromJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (parsed === null ? fallback : parsed) as T;
  } catch {
    return fallback;
  }
}

/** Şemayla doğrular. Bozuk kayıt sessizce yutulmaz, hata fırlatır. */
export function parseJson<T>(raw: string | null | undefined, schema: z.ZodType<T>, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  const r = schema.safeParse(parsed);
  return r.success ? r.data : fallback;
}

/** Boolean listeleri (tags, scopes) için kısayol. */
export function jsonStringArray(raw: string | null | undefined): string[] {
  return fromJson<string[]>(raw, []);
}

export function jsonStringArrayOut(values: string[] | null | undefined): string {
  return toJson(values ?? []);
}
