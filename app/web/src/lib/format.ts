/**
 * Biçimlendirme. TAMAMEN SAF: I/O yok, `Date.now()` yalnızca varsayılan
 * parametre olarak gelir ve testte her zaman açıkça verilir.
 *
 * Dil notu: arayüz Türkçe. Ondalık ayırıcı virgüldür; sayıyı elle
 * biçimlendiriyoruz ki sonuç ICU/yerel ayarlarına bağlı olmasın ve
 * testler beklenen dizgiyi birebir görebilsin.
 */

/** Bilinmeyen/uygulanamayan değer için tek tutarlı yedek. */
export const DASH = "—";

export type DateLike = string | number | Date;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Türkçe ondalık gösterim: 1.5 → "1,5" */
export function trNumber(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return DASH;
  return value.toFixed(digits).replace(".", ",");
}

export function toDate(value: DateLike | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Bayt → okunur birim. 1024 tabanlı. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return DASH;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < BYTE_UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  const unit = BYTE_UNITS[index] ?? "B";
  const digits = value >= 100 ? 0 : 1;
  return `${trNumber(value, digits)} ${unit}`;
}

/** Saniye → "0:07" / "12:34" / "1:02:03". */
export function formatDurationSec(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return DASH;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = pad2(minutes);
  const ss = pad2(secs);
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

const SECOND = 1;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;
const MONTH = 2629800; // 30,44 gün
const YEAR = 31557600; // 365,25 gün

const RELATIVE_UNITS: ReadonlyArray<{ limit: number; name: string }> = [
  { limit: YEAR, name: "yıl" },
  { limit: MONTH, name: "ay" },
  { limit: WEEK, name: "hafta" },
  { limit: DAY, name: "gün" },
  { limit: HOUR, name: "sa" },
  { limit: MINUTE, name: "dk" },
];

/**
 * Basamak sayısı. Kesme değil YUVARLAMA.
 *
 * Neden: `YEAR` bir ORTAK yıl uzunluğudur (365,25 gün). Tam iki takvim yılı önce
 * olan bir kayıt (730 gün) 1,9988 yıl eder; kesme onu "1 yıl önce" yazardı —
 * neredeyse iki yıllık bir geçmişi bir yıllık gösterir. Yuvarlama en kötü
 * durumda yarım birim sapar, kesme ise tam bir birim. `1` tabanı korunur:
 * seçilen basamağın sınırına girildiği anda sayı 0 olamaz ("0 dk önce" yazmaz).
 */
function unitCount(absSec: number, unitSec: number): number {
  return Math.max(1, Math.round(absSec / unitSec));
}

/** "3 dk önce", "5 sa sonra". `nowMs` verilmezse `Date.now()` kullanılır. */
export function formatRelativeTime(value: DateLike | null | undefined, nowMs: number = Date.now()): string {
  const d = toDate(value);
  if (d === null) return DASH;
  const diffSec = Math.round((nowMs - d.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  const suffix = diffSec < 0 ? " sonra" : " önce";
  if (abs < 45) return diffSec >= 0 ? "az önce" : "birazdan";
  for (const unit of RELATIVE_UNITS) {
    if (abs >= unit.limit) {
      return `${unitCount(abs, unit.limit)} ${unit.name}${suffix}`;
    }
  }
  // 45..59 saniye: dakika basamağı henüz sınıra ulaşmadı ama "0 dk" yazmamalı.
  return `${unitCount(abs, MINUTE)} dk${suffix}`;
}

/**
 * `instant` anının `timeZone` içindeki parçaları. Geçersiz saat dilimi → null.
 * Uygulama ekranı yerelinde çalıştığı için "bugün/yarın" gibi dilde-sonrası
 * karşılaştırmalar yapmıyoruz; yalnızca UTC'den yerele düşüyoruz.
 */
export function zonedDateParts(instant: Date, timeZone: string): ZonedParts | null {
  if (Number.isNaN(instant.getTime())) return null;
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return null;
  }
  const parts = dtf.formatToParts(instant);
  const read = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found === undefined ? Number.NaN : Number(found.value);
  };
  const raw = {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
  if (Object.values(raw).some((v) => !Number.isFinite(v))) return null;
  return raw;
}

/** UTC ISO → "30.09.2026 18:00" (verilen dilimde). */
export function formatZonedDateTime(value: DateLike | null | undefined, timeZone: string): string {
  const d = toDate(value);
  if (d === null) return DASH;
  const parts = zonedDateParts(d, timeZone);
  if (parts === null) return DASH;
  return `${pad2(parts.day)}.${pad2(parts.month)}.${parts.year} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/** UTC ISO → "30.09.2026" (verilen dilimde). */
export function formatZonedDate(value: DateLike | null | undefined, timeZone: string): string {
  const d = toDate(value);
  if (d === null) return DASH;
  const parts = zonedDateParts(d, timeZone);
  if (parts === null) return DASH;
  return `${pad2(parts.day)}.${pad2(parts.month)}.${parts.year}`;
}

/** UTC ISO → `<input type="datetime-local">` değeri (verilen dilimde, ofsetsiz). */
export function toDateTimeLocalValue(value: DateLike | null | undefined, timeZone: string): string {
  const d = toDate(value);
  if (d === null) return "";
  const parts = zonedDateParts(d, timeZone);
  if (parts === null) return "";
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

export function formatResolution(width: number | null | undefined, height: number | null | undefined): string {
  if (width === null || width === undefined || height === null || height === undefined) return DASH;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return DASH;
  return `${width}×${height}`;
}

export function formatFps(fps: number | null | undefined): string {
  if (fps === null || fps === undefined || !Number.isFinite(fps)) return DASH;
  return `${Number(fps.toFixed(2))} fps`;
}

export function formatBitrate(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps) || bps <= 0) return DASH;
  if (bps >= 1_000_000) return `${trNumber(bps / 1_000_000, 1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

/**
 * Oran (0..1) → yüzde dizesi: 0.512 → "%51,2".
 *
 * ⚠️ 100 ile ÇARPILIR. Çarpmadan önceki hâli `formatPercent(0.512)` için
 * "%0,5" yazıyordu; oranı olduğu gibi yazdırıyordu.
 */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return DASH;
  return `%${trNumber(ratio * 100, digits)}`;
}

/** "3 kayıt" / "1 kayıt" */
export function pluralTr(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Metin uzunluğu, sınır bilgisiyle birlikte. Düzeltme YAPILMAZ — sınır aşımı gösterilir. */
export interface CharUsage {
  value: string;
  length: number;
  max: number;
  remaining: number;
  over: boolean;
  near: boolean;
}

export function charUsage(value: string | null | undefined, max: number): CharUsage {
  const text = value ?? "";
  const length = [...text].length;
  const remaining = max - length;
  const threshold = Math.max(1, Math.floor(max * 0.1));
  return {
    value: text,
    length,
    max,
    remaining,
    over: length > max,
    near: length <= max && remaining <= threshold,
  };
}

/** Uzun metni orta yerden kesip sonuna "…" ekler (yalnızca TEK SATIR gösterimi için). */
export function truncate(text: string | null | undefined, max: number): string {
  if (text === null || text === undefined) return "";
  const chars = [...text];
  if (chars.length <= max) return text;
  if (max <= 1) return "…";
  return `${chars.slice(0, max - 1).join("")}…`;
}