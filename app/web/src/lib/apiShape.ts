/**
 * Sunucu yanıtını arayüzün beklediği biçime getiren DEFANSİF yardımcılar. SAF.
 *
 * Neden? Sözleşmede liste uçları için zarfın içi `{ items, total }` mı düz dizi
 * mi olduğu tek yerde sabitlenmemiş. Arayüz BURADA TAHMİN YAPMAZ: iki biçimi
 * de kabul eder, hiçbiri değilse boş liste + hata üretir. Böylece sunucu
 * biçimi değiştirirse panel boş ekran yerine açık bir mesaj gösterir.
 */
import { DASH } from "./format.js";

export interface ListResult<T> {
  items: T[];
  total: number;
  /** Yanıt beklenen biçimde değilse true (arayüz bunu uyarı olarak gösterebilir). */
  unrecognisedShape: boolean;
}

const LIST_KEYS = ["items", "data", "rows", "results", "records", "content", "assets", "jobs"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dizi ya da `{ items: [...] }` çeşitlerini tek biçime indirger. */
export function asList<T>(payload: unknown): ListResult<T> {
  if (Array.isArray(payload)) {
    return { items: payload as T[], total: payload.length, unrecognisedShape: false };
  }
  if (isRecord(payload)) {
    for (const key of LIST_KEYS) {
      const candidate = payload[key];
      if (Array.isArray(candidate)) {
        const totalRaw = payload["total"] ?? payload["count"];
        const total = typeof totalRaw === "number" && Number.isFinite(totalRaw) ? totalRaw : candidate.length;
        return { items: candidate as T[], total, unrecognisedShape: false };
      }
    }
  }
  return { items: [], total: 0, unrecognisedShape: payload !== null && payload !== undefined };
}

export function asRecord(payload: unknown): Record<string, unknown> {
  return isRecord(payload) ? payload : {};
}

export function asArray(payload: unknown): unknown[] {
  return Array.isArray(payload) ? payload : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Zamanlayıcı durumu sözleşmede alan alan tanımlı değil; bilinen anahtarları
 * TANINAN İSİMLERLE gösteririz, tanınmayanları da "sunucudan gelen ek alan"
 * olarak listeleriz — hiçbir alan uydurulmaz, hiçbiri gizlenmez.
 */
export interface StatusRow {
  label: string;
  value: string;
  /** Kırmızı uyarı gerektiren satırlar. */
  warn: boolean;
}

const SCHEDULER_KNOWN: Readonly<Record<string, string>> = {
  enabled: "Açık",
  running: "Çalışıyor",
  inFlight: "Yürüyen iş",
  in_flight: "Yürüyen iş",
  intervalSec: "Aralık (sn)",
  interval_sec: "Aralık (sn)",
  intervalMs: "Aralık (ms)",
  lastRunAt: "Son çalışma",
  last_run_at: "Son çalışma",
  lastTickAt: "Son çalışma",
  last_tick_at: "Son çalışma",
  nextRunAt: "Sonraki çalışma",
  next_run_at: "Sonraki çalışma",
  nextTickAt: "Sonraki çalışma",
  lastResult: "Son sonuç",
  last_result: "Son sonuç",
  lastError: "Son hata",
  last_error: "Son hata",
  queued: "Kuyruktaki iş",
  pending: "Bekleyen",
  runningJobs: "Çalışan iş",
};

const UNKNOWN_LABEL = "Sunucudan gelen alan";

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return DASH;
  if (typeof value === "boolean") return value ? "evet" : "hayır";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // ISO gibi görünen bir zaman mı? mümkünse yerel okunur biçime çevir.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
      const t = Date.parse(value);
      if (Number.isFinite(t)) return new Date(t).toLocaleString("tr-TR");
    }
    return value;
  }
  if (Array.isArray(value)) return `${value.length} kayıt`;
  try {
    return JSON.stringify(value);
  } catch {
    return DASH;
  }
}

export function describeScheduler(payload: unknown): StatusRow[] {
  const record = asRecord(payload);
  const rows: StatusRow[] = [];
  const seen = new Set<string>();
  for (const [key, label] of Object.entries(SCHEDULER_KNOWN)) {
    if (!(key in record) || seen.has(label)) continue;
    seen.add(label);
    rows.push({ label, value: valueToText(record[key]), warn: false });
  }
  const extras: StatusRow[] = [];
  for (const key of Object.keys(record).sort()) {
    if (SCHEDULER_KNOWN[key] !== undefined) continue;
    extras.push({ label: `${UNKNOWN_LABEL}: ${key}`, value: valueToText(record[key]), warn: false });
  }
  return [...rows, ...extras];
}

export interface HealthSummary {
  ok: boolean;
  version: string | null;
  uptimeSec: number | null;
  db: string | null;
  mode: "mock" | "live" | null;
  scheduler: StatusRow[];
}

/** `GET /api/health` gövdesi — zarfın `data` kısmı beklenir. */
export function parseHealth(payload: unknown): HealthSummary {
  const record = asRecord(payload);
  const modeRaw = record["mode"];
  const mode =
    modeRaw === "mock" || modeRaw === "live" ? (modeRaw as "mock" | "live") : null;
  const schedulerRaw = record["scheduler"];
  return {
    ok: asBoolean(record["ok"], false),
    version: asStringOrNull(record["version"]),
    uptimeSec: typeof record["uptimeSec"] === "number" ? record["uptimeSec"] : null,
    db: asStringOrNull(record["db"]),
    mode,
    scheduler: describeScheduler(schedulerRaw),
  };
}