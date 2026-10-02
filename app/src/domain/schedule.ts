/**
 * Zamanlama iş kuralları. SAF FONKSİYON: `Date.now()` çağırmaz; "şimdi" her
 * zaman parametre olarak gelir. Aynı girdi + aynı `now` → aynı çıktı.
 *
 * DEPOLANAN ZAMAN DAİMA UTC'dir; yerel saat sadece hesaplanırken kullanılır.
 * Takvimde gösterim (`fmtLocal`) ile hesap (`nextEligibleTime`) ayrıdır.
 *
 * SESSİZ SAAT KAYDIRMA: aralık `[start, end)` yarım açıktır; bitiş anı zaten
 * sessiz değildir. Bitiş `"00:00"` ise "gece yarısı" demektir, yani O GÜNÜN
 * 00:00'ı değil ERTESİ GÜNÜN 00:00'ı — 23:00→07:00 aralığında 23:30'da
 * kaydırma, o günün 00:00'ına değil ertesi sabaha gider. Tarih taşıması
 * `Date.UTC(...)` taşmasıyla yapılır (32. gün verilirse ay doğru döner).
 */
import { isValidTimeZone, isWithinQuietHours, tzOffsetMs } from "../contract/index.js";
import type { QuietHours } from "../contract/index.js";

/** Bir kaydırma döngüsünde izin verilen maksimum gün sayısı. */
export const MAX_QUIET_SHIFTS = 7;

// ── Girdi doğrulama ───────────────────────────────────────────────────────

function parseInstant(iso: string, label: string): number {
  const ms = Date.parse(typeof iso === "string" ? iso.trim().replace(" ", "T") : "");
  if (Number.isNaN(ms)) {
    throw new TypeError(`${label} UTC ISO zaman damgası olmalı: ${String(iso)}`);
  }
  return ms;
}

function parseDate(value: Date, label: string): number {
  const ms = value instanceof Date ? value.getTime() : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new TypeError(`${label} geçerli bir Date olmalı`);
  }
  return ms;
}

function requireTimeZone(timezone: string): string {
  if (!isValidTimeZone(timezone)) {
    throw new TypeError(`Geçersiz IANA saat dilimi: ${String(timezone)}`);
  }
  return timezone;
}

/** `"23:00"` → `{ hour: 23, minute: 0 }`. `HH:MM` sözleşmesi zod ile doğrulanır. */
function parseTimeOfDay(value: string, label: string): { hour: number; minute: number } {
  const parts = value.split(":");
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new TypeError(`${label} "HH:MM" biçiminde olmalı: ${String(value)}`);
  }
  return { hour, minute };
}

// ── Yerel saat ↔ UTC ──────────────────────────────────────────────────────

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(instant: Date, timezone: string): LocalParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    // "24" değeri bazı yürütücülerde gece yarısını 24 olarak yazar.
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}

/**
 * Yerel duvar saatini (`timezone` içinde) UTC epoch ms'ye çevirir.
 * Ofset, o ana denk gelen UTC tahminine bakılarak bulunur (sözleşmedeki
 * `resolveScheduledAt` ile aynı yöntem); iki geçişli yineleme yaz saati
 * sınırlarında tek kaymanın yetmediği durumu kapatır.
 */
function localToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let ms = wall;
  for (let pass = 0; pass < 2; pass++) {
    const next = wall - tzOffsetMs(new Date(ms), timezone);
    if (next === ms) break;
    ms = next;
  }
  return ms;
}

const toIso = (ms: number): string => new Date(ms).toISOString();

// ── 1) Zaman geldi mi ─────────────────────────────────────────────────────

/** Zaman damgası geçmiş ya da şu an ise true. Gelecekse false. */
export function isDue(scheduledAtUtc: string, now: Date): boolean {
  return parseInstant(scheduledAtUtc, "scheduledAtUtc") <= parseDate(now, "now");
}

// ── 2) Sessiz saatten çıkarma ─────────────────────────────────────────────

/**
 * Zaman sessiz saat aralığındaysa onu `quietHours.end` anına kaydırır.
 * Kaydırılan an hâlâ sessiz saatteyse döngü TEKRARLANIR; en fazla
 * {@link MAX_QUIET_SHIFTS} kez. Hâlâ çözülemediyse `null` döner: takvimde
 * uyarı üretilmelidir, çünkü bu içerik o gün yayınlanamayabilir.
 *
 * `now` bilerek ALINMAZ — ham kaydırma sonucu, ne olursa olsun aynıdır.
 */
export function shiftOutOfQuietHours(
  scheduledAtUtc: string,
  quietHours: QuietHours,
  timezone: string,
): string | null {
  const tz = requireTimeZone(timezone);
  const end = parseTimeOfDay(quietHours.end, "quietHours.end");
  let ms = parseInstant(scheduledAtUtc, "scheduledAtUtc");

  for (let shift = 0; shift < MAX_QUIET_SHIFTS; shift++) {
    if (!isWithinQuietHours(new Date(ms), quietHours, tz)) return toIso(ms);
    const local = localParts(new Date(ms), tz);
    const endToday = localToUtcMs(
      local.year,
      local.month,
      local.day,
      end.hour,
      end.minute,
      tz,
    );
    // Bitiş o gün geçmişse ertesi güne geç: `end: "00:00"` + 23:30 → ertesi
    // gün 00:00. Bu, sessiz saat hesabının en sık çözülen hatasıdır.
    const candidate = endToday > ms ? endToday : localToUtcMs(
      local.year,
      local.month,
      local.day + 1,
      end.hour,
      end.minute,
      tz,
    );
    if (candidate <= ms) {
      // İlerleme yok: döngü sonsuza kadar sürerdi. Sessiz saat tanımı
      // tutarsız (örn. bitiş = başlangıç). null = "kullanıcıdan karar istenmeli".
      return null;
    }
    ms = candidate;
  }

  return isWithinQuietHours(new Date(ms), quietHours, tz) ? null : toIso(ms);
}

// ── 3) Yayına uygun ilk an ────────────────────────────────────────────────

export interface EligibilityInput {
  /** DAİMA UTC ISO. */
  scheduledAtUtc: string;
  quietHours: QuietHours | null;
  timezone: string;
}

/**
 * Yayına uygun ilk anı UTC ISO olarak döner.
 *
 * - Sessiz saat tanımı yoksa veya zaman sessiz saatte DEĞİLSE zaman AYNEN
 *   döner (kullanıcının seçtiği gün değişmez).
 * - Sessiz saattEYSE {@link shiftOutOfQuietHours} uygulanır.
 * - Kaydırılan an hâlâ çözülemiyorsa `null` → takvim uyarısı gerekir.
 *
 * `now` NEDEN VAR: kaydırılan an çoktan geçmişse (zamanlama iki gün önceydi,
 * sessiz saat bu sabah bitti) en uygun an "şimdi"dir; geçmiş bir zaman
 * damgası döndürmek, çağırana "ne zaman?" sorusunu cevapsız bırakır. Bu
 * yüzden sonuç `now`'dan küçükse `now` döner.
 */
export function nextEligibleTime(when: EligibilityInput, now: Date): string | null {
  const tz = requireTimeZone(when.timezone);
  const nowMs = parseDate(now, "now");
  const scheduledMs = parseInstant(when.scheduledAtUtc, "scheduledAtUtc");
  const quiet = when.quietHours ?? null;

  if (!quiet) return toIso(scheduledMs);
  if (!isWithinQuietHours(new Date(scheduledMs), quiet, tz)) return toIso(scheduledMs);

  const shifted = shiftOutOfQuietHours(when.scheduledAtUtc, quiet, tz);
  if (shifted === null) return null;

  const shiftedMs = parseInstant(shifted, "shifted");
  return toIso(Math.max(shiftedMs, nowMs));
}

// ── 4) Takvimde gösterim ──────────────────────────────────────────────────

/**
 * UTC ISO'yu kullanıcının saat diliminde okunur biçime çevirir.
 * Yalnızca GÖSTERİM içindir; hesaplama bu metni asla geri ayrıştırmaz.
 */
export function fmtLocal(
  utcIso: string,
  timezone: string,
  locale = "tr-TR",
  opts: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "short" },
): string {
  const tz = requireTimeZone(timezone);
  const ms = parseInstant(utcIso, "utcIso");
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: tz }).format(new Date(ms));
}