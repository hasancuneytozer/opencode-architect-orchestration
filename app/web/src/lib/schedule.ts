/**
 * Takvim aritmetiği ve yerel saat ↔ UTC dönüşümü. SAF.
 *
 * ⚠️ SORUMLULUK SINIRI: Bu dosya zamanı **GÖSTERMEK** ve kullanıcının girdiği
 * `datetime-local` değerini doğrulamak içindir. Zamanlamanın nihai UTC kararı
 * SUNUCUDUR (bkz. contract `resolveScheduledAt`): istemci ofsetsiz yerel değeri
 * + `timezone` alanını gönderir, sunucu çevirir. Arayüz kendi çevrimiyle bir
 * zamanlama kararı VERMEZ; sadece "bu gün hangi hücreye düşer" sorusunu cevaplar.
 */

/** `Date` diliminde UTC değerini okur (kendi saat dilimi = tarayıcı/sunucu yereli). */
export function tzOffsetMs(instant: Date, timeZone: string): number | null {
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
  const read = (t: string): number => {
    const found = parts.find((p) => p.type === t);
    return found === undefined ? Number.NaN : Number(found.value);
  };
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  );
  if (!Number.isFinite(asUtc)) return null;
  return asUtc - instant.getTime();
}

/**
 * `new Date("2026-02-31T18:00Z")` JavaScript'te sessizce 3 Mart'a KAYAR.
 * Bu bir yazım hatasıdır, kullanıcının girdiği saate çevrilmemelidir: yanlış
 * bir zamana sessizce yazmak, zamanlama kaydını iki gün kaydırmaktan kötüdür.
 */
function hasRealCalendarParts(normalized: string, asUtc: Date): boolean {
  return (
    asUtc.getUTCFullYear() === Number(normalized.slice(0, 4)) &&
    asUtc.getUTCMonth() + 1 === Number(normalized.slice(5, 7)) &&
    asUtc.getUTCDate() === Number(normalized.slice(8, 10)) &&
    asUtc.getUTCHours() === Number(normalized.slice(11, 13)) &&
    asUtc.getUTCMinutes() === Number(normalized.slice(14, 16))
  );
}

/**
 * Yerel (ofsetsiz) ISO dizesini, verilen dilimde UTC anına çevirir.
 *
 * Ofset İKİ KEZ sorulur. Tek denemede kullanılan ofset, `guess` anındaki
 * (yani sıçramanın ÖNÜNDEKİ) ofsettir; sıçramanın hemen ardından gelen bir
 * saatte bu ofset yanlıştır ve sonuç bir saat kayar:
 *   New York 2026-03-08 04:30 → ilk deneme ofseti EST (−5) → 09:30Z → 05:30 EDT ✗
 * İkinci deneme 09:30Z'deki gerçek ofseti (−4) bulur ve 08:30Z döner → 04:30 ✓
 */
export function localIsoToUtc(localIso: string, timeZone: string): Date | null {
  const normalized = localIso.trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(normalized)) return null;
  const guess = new Date(`${normalized}Z`);
  if (Number.isNaN(guess.getTime())) return null;
  if (!hasRealCalendarParts(normalized, guess)) return null;
  let offset = tzOffsetMs(guess, timeZone);
  if (offset === null) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = new Date(guess.getTime() - offset);
    const next = tzOffsetMs(candidate, timeZone);
    if (next === null) return null;
    if (next === offset) return candidate; // kararlı
    offset = next;
  }
  // İki taraf arasında sıçrama varsa (NY 02:30) ofset titrer; son hesaplanan
  // değer döner, `localTimeExists` geri çevrimle bunu "yok" olarak bildirir.
  return new Date(guess.getTime() - offset);
}

/** UTC anındaki `timeZone` ofsetini "UTC+03:00" biçiminde yazar. */
export function formatOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? "-" : "+";
  const abs = Math.abs(offsetMs);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function offsetAt(instant: Date, timeZone: string): string {
  const offset = tzOffsetMs(instant, timeZone);
  return offset === null ? "—" : formatOffset(offset);
}

/**
 * Verilen ofsetsiz yerel saat dilimde GERÇEKTEN var mı?
 * DST ileri sıçramasında bazı saatler hiç oluşmaz (örn. New York 2026-03-08
 * 02:30). Böyle bir değeri sessizce kaydırmak yerine kullanıcıya söylüyoruz.
 */
export function localTimeExists(localIso: string, timeZone: string): boolean {
  const asUtc = localIsoToUtc(localIso, timeZone);
  if (asUtc === null) return false;
  const back = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = back.formatToParts(asUtc);
  const read = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(read("hour")) % 24;
  const wanted = localIso.trim().replace(" ", "T");
  const [datePart, timePart] = wanted.split("T");
  const time = timePart ?? "";
  const hh = time.slice(0, 2);
  const mm = time.slice(3, 5);
  if (datePart === undefined || hh === undefined || mm === undefined) return false;
  return (
    read("year") === datePart.slice(0, 4) &&
    read("month") === datePart.slice(5, 7) &&
    read("day") === datePart.slice(8, 10) &&
    String(hour).padStart(2, "0") === hh &&
    String(read("minute")) === mm
  );
}

/**
 * İki yerel zaman damgası arasındaki kaymanın dökümü.
 * `wallClockDeltaMs` duvar saati farkı, `utcDeltaMs` gerçek zaman farkıdır.
 * Aralarındaki fark = gün ışığı kayması (DST).
 */
export interface UtcShift {
  fromUtcMs: number;
  toUtcMs: number;
  wallClockDeltaMs: number;
  utcDeltaMs: number;
  /** Gerçek zamandan KISA kısaldıysa ileri sıçrama (kaç saat). */
  springForwardMs: number;
  /** Gerçek zamandan UZUN kısaldıysa geri sıçrama (kaç saat). */
  fallBackMs: number;
}

export function describeUtcShift(fromLocalIso: string, toLocalIso: string, timeZone: string): UtcShift | null {
  const from = localIsoToUtc(fromLocalIso, timeZone);
  const to = localIsoToUtc(toLocalIso, timeZone);
  if (from === null || to === null) return null;
  const wallClockDeltaMs = Date.parse(`${toLocalIso.trim().replace(" ", "T")}Z`) - Date.parse(
    `${fromLocalIso.trim().replace(" ", "T")}Z`,
  );
  const utcDeltaMs = to.getTime() - from.getTime();
  return {
    fromUtcMs: from.getTime(),
    toUtcMs: to.getTime(),
    wallClockDeltaMs,
    utcDeltaMs,
    springForwardMs: wallClockDeltaMs > utcDeltaMs ? wallClockDeltaMs - utcDeltaMs : 0,
    fallBackMs: utcDeltaMs > wallClockDeltaMs ? utcDeltaMs - wallClockDeltaMs : 0,
  };
}

// ── Hafta aralığı ────────────────────────────────────────────────────────

/** 0 = Pazar ... 6 = Cumartesi (JS `Date.getDay()` ile aynı). */
export const WEEK_STARTS_ON = 1; // Pazartesi

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/** Haftanın başlangıcı: `weekStartsOn` günü, yerel gece yarısı. */
export function startOfWeek(date: Date, weekStartsOn: number = WEEK_STARTS_ON): Date {
  const day = startOfDay(date);
  const diff = (((day.getDay() - weekStartsOn) % 7) + 7) % 7;
  day.setDate(day.getDate() - diff);
  return day;
}

/** Haftanın 7 günü (startOfWeek'in döndürdüğü günden başlayarak). */
export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** "2026-09-28" biçiminde yerel gün anahtarı. */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Verilen UTC anının `timeZone`'deki gün anahtarı. */
export function zonedDayKey(instant: Date, timeZone: string): string | null {
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return null;
  }
  const parts = dtf.formatToParts(instant);
  const read = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  const y = read("year");
  const m = read("month");
  const d = read("day");
  if (!y || !m || !d) return null;
  return `${y}-${m}-${d}`;
}

/** Gün içi konum: 0..1439 dakika (yerel saat diliminde). */
export function minutesIntoDay(instant: Date, timeZone: string): number {
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return 0;
  }
  const parts = dtf.formatToParts(instant);
  const read = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const minutes = (read("hour") % 24) * 60 + read("minute");
  return Number.isFinite(minutes) ? Math.max(0, Math.min(1439, minutes)) : 0;
}

/** Gün hücresinde yüzde konum (0 = üst, 100 = alt). */
export function dayPositionPercent(instant: Date, timeZone: string): number {
  return (minutesIntoDay(instant, timeZone) / 1440) * 100;
}

/**
 * UTC anı verilen haftanın hangi sütununa düşer? 0..6, hafta dışıysa -1.
 * Karşılaştırma YEREL gün anahtarlarıyla yapılır; bu, "aynı gün" kavramının
 * dilimler arası kaymasını doğru ele alır.
 */
export function columnIndexInWeek(instant: Date, weekStart: Date, timeZone: string): number {
  const key = zonedDayKey(instant, timeZone);
  if (key === null) return -1;
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(startOfDay(weekStart), i);
    if (localDayKey(day) === key) return i;
  }
  return -1;
}

// ── Sessiz saat ───────────────────────────────────────────────────────────

/** "HH:MM" doğrulaması (sözleşmedeki TimeOfDay ile aynı kabul). */
export function isTimeOfDay(value: string | null | undefined): boolean {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

/** "HH:MM" → gece yarısından dakika; geçersizse null. */
export function timeToMinutes(value: string | null | undefined): number | null {
  if (!isTimeOfDay(value)) return null;
  const trimmed = (value as string).trim();
  const [h, m] = trimmed.split(":");
  return Number(h) * 60 + Number(m);
}

export function minutesToTime(minutes: number): string {
  const safe = Math.max(0, Math.min(1439, Math.floor(minutes)));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Başlangıç > bitiş ise aralık gece yarısını geçer (23:00 → 07:00).
 * Aralığın uzunluğunu dakika olarak verir; `null` aralık "kapalı" demektir.
 */
export function quietHoursSpan(
  quiet: { start: string; end: string } | null | undefined,
): number | null {
  if (!quiet) return null;
  const from = timeToMinutes(quiet.start);
  const to = timeToMinutes(quiet.end);
  if (from === null || to === null) return null;
  if (from === to) return 0;
  return from <= to ? to - from : 1440 - from + to;
}

/** "23:00 → 07:00 (8 saat, gece yarısını geçiyor)" */
export function describeQuietHours(quiet: { start: string; end: string } | null | undefined): string {
  if (!quiet) return "Kapalı";
  if (!isTimeOfDay(quiet.start) || !isTimeOfDay(quiet.end)) return "Geçersiz saat";
  const span = quietHoursSpan(quiet) ?? 0;
  const from = timeToMinutes(quiet.start) ?? 0;
  const to = timeToMinutes(quiet.end) ?? 0;
  const crossesMidnight = from > to;
  const hours = span / 60;
  const hoursText = Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace(".", ",");
  return `${quiet.start} → ${quiet.end} · ${hoursText} saat${crossesMidnight ? " · gece yarısını geçiyor" : ""}`;
}

/** Türkçe gün başlığı kısaltması: "Pzt". */
const WEEKDAY_SHORT: Readonly<Record<number, string>> = {
  0: "Paz",
  1: "Pzt",
  2: "Sal",
  3: "Çar",
  4: "Per",
  5: "Cum",
  6: "Cmt",
};

export function weekdayShort(date: Date): string {
  return WEEKDAY_SHORT[date.getDay()] ?? "";
}

/** "28 Eyl 2026 Pazartesi" — hafta başlığı. */
export function weekTitle(weekStart: Date): string {
  const last = addDays(weekStart, 6);
  const monthName = (d: Date): string =>
    [
      "Oca",
      "Şub",
      "Mar",
      "Nis",
      "May",
      "Haz",
      "Tem",
      "Ağu",
      "Eyl",
      "Eki",
      "Kas",
      "Ara",
    ][d.getMonth()] ?? "";
  const left = `${weekStart.getDate()} ${monthName(weekStart)} ${weekStart.getFullYear()}`;
  const right = `${last.getDate()} ${monthName(last)} ${last.getFullYear()}`;
  return `${left} – ${right} ${weekdayShort(weekStart)}`;
}

/** Bugünün yerel gün anahtarı (karşılaştırma için). */
export function todayKey(now: Date = new Date()): string {
  return localDayKey(startOfDay(now));
}

/** Gün hücresi başlıkları: { key, date, isToday, label }. */
export interface DayColumn {
  index: number;
  key: string;
  date: Date;
  label: string;
  weekday: string;
  isToday: boolean;
}

export function buildWeekColumns(weekStart: Date, now: Date = new Date()): DayColumn[] {
  const today = todayKey(now);
  return weekDays(weekStart).map((date, index) => ({
    index,
    key: localDayKey(date),
    date,
    weekday: weekdayShort(date),
    label: `${date.getDate()}`,
    isToday: localDayKey(date) === today,
  }));
}