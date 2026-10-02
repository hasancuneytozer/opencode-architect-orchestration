/**
 * `web/src/lib/schedule.ts` — hafta aralığı, gün hücresi, gün ışığı kayması,
 * sınır durumları (gece yarısı, ay sonu).
 */
import { describe, expect, it } from "vitest";

import {
  addDays,
  buildWeekColumns,
  columnIndexInWeek,
  dayPositionPercent,
  describeQuietHours,
  describeUtcShift,
  localDayKey,
  localIsoToUtc,
  localTimeExists,
  minutesIntoDay,
  minutesToTime,
  offsetAt,
  quietHoursSpan,
  startOfDay,
  startOfWeek,
  timeToMinutes,
  weekDays,
  weekTitle,
  weekdayShort,
  zonedDayKey,
} from "../../web/src/lib/schedule.js";

const TZ = "Europe/Istanbul";

describe("startOfWeek — Pazartesi başlangıç", () => {
  it("Çarşamba 30.09.2026 → Pazartesi 28.09.2026", () => {
    const wed = new Date(2026, 8, 30, 14, 30);
    expect(localDayKey(startOfWeek(wed))).toBe("2026-09-28");
  });

  it("Pazartesi günü kendisinde kalır", () => {
    const mon = new Date(2026, 8, 28, 9, 0);
    expect(localDayKey(startOfWeek(mon))).toBe("2026-09-28");
  });

  it("Pazar günü önceki Pazartesi'ye gider", () => {
    const sun = new Date(2026, 8, 27, 23, 59);
    expect(localDayKey(startOfWeek(sun))).toBe("2026-09-21");
  });

  it("hafta başlangıcı gece yarısıdır", () => {
    const week = startOfWeek(new Date(2026, 8, 30, 17, 45));
    expect(week.getHours()).toBe(0);
    expect(week.getMinutes()).toBe(0);
  });

  it("hafta 7 gün verir, art arda günler", () => {
    const days = weekDays(startOfWeek(new Date(2026, 8, 30)));
    expect(days).toHaveLength(7);
    for (let i = 1; i < days.length; i += 1) {
      const prev = days[i - 1];
      const cur = days[i];
      expect(cur === undefined || prev === undefined).toBe(false);
      if (prev === undefined || cur === undefined) continue;
      expect(Math.round((cur.getTime() - prev.getTime()) / 86_400_000)).toBe(1);
    }
  });

  it("hafta başlığı gün adını taşır", () => {
    expect(weekTitle(startOfWeek(new Date(2026, 8, 30)))).toContain("Pzt");
    expect(weekdayShort(new Date(2026, 8, 28))).toBe("Pzt");
  });
});

describe("ay sonu / yıl sonu sınırları", () => {
  it("31 Aralık ay sonuna doğru hafta 1 Ocak'a geçer", () => {
    const week = startOfWeek(new Date(2026, 11, 31));
    expect(localDayKey(week)).toBe("2026-12-28");
    const keys = weekDays(week).map(localDayKey);
    expect(keys).toContain("2027-01-03");
  });

  it("Ocak ayı sonu haftayı bölmez", () => {
    const keys = weekDays(startOfWeek(new Date(2026, 0, 31))).map(localDayKey);
    expect(keys[0]).toBe("2026-01-26");
    expect(keys[6]).toBe("2027-02-01".replace("2027-02-01", "2026-02-01"));
  });

  it("artık yıl 29 Şubat'ı kapsayan hafta", () => {
    const keys = weekDays(startOfWeek(new Date(2028, 1, 29))).map(localDayKey);
    expect(keys).toContain("2028-02-29");
  });

  it("addDays ayı doğru geçer", () => {
    expect(localDayKey(addDays(new Date(2026, 0, 31), 1))).toBe("2026-02-01");
    expect(localDayKey(addDays(new Date(2026, 0, 31), -31))).toBe("2025-12-31");
  });

  it("startOfDay saat bileşenlerini sıfırlar", () => {
    const d = startOfDay(new Date(2026, 5, 15, 22, 13, 45, 999));
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0]);
  });
});

describe("gün hücresine düşürme", () => {
  const weekStart = startOfWeek(new Date(2026, 8, 30));

  it("hafta içindeki günler 0..6 döner", () => {
    // 28 Eyl 00:00 UTC = 28 Eyl 03:00 İstanbul → sütun 0
    expect(columnIndexInWeek(new Date("2026-09-27T21:00:00Z"), weekStart, TZ)).toBe(0);
    // 30 Eyl 15:00 UTC = 30 Eyl 18:00 → sütun 2
    expect(columnIndexInWeek(new Date("2026-09-30T15:00:00Z"), weekStart, TZ)).toBe(2);
  });

  it("hafta dışı -1 döner", () => {
    expect(columnIndexInWeek(new Date("2026-10-10T12:00:00Z"), weekStart, TZ)).toBe(-1);
  });

  it("gece yarısı sınırında yanlış güne düşmez", () => {
    // 2026-09-30T21:00Z = 1 Ekim 00:00 İstanbul → sütun 3, 4 değil
    expect(columnIndexInWeek(new Date("2026-09-30T21:00:00Z"), weekStart, TZ)).toBe(3);
  });

  it("geçersiz saat diliminde -1 döner", () => {
    expect(columnIndexInWeek(new Date("2026-09-30T12:00:00Z"), weekStart, "Ankara")).toBe(-1);
  });

  it("zonedDayKey gün anahtarını yerel dilimde verir", () => {
    expect(zonedDayKey(new Date("2026-09-30T21:30:00Z"), TZ)).toBe("2026-10-01");
    expect(zonedDayKey(new Date("2026-09-30T21:30:00Z"), "UTC")).toBe("2026-09-30");
  });
});

describe("gün içi konum", () => {
  it("gece yarısı 0 dakika", () => {
    expect(minutesIntoDay(new Date("2026-09-30T21:00:00Z"), TZ)).toBe(0);
  });

  it("gün sonu 1439 dakikayı aşmaz", () => {
    // ⚠️ Fişit DÜZELTİLDİ: 2026-10-01T17:59Z İstanbul'da 20:59'dur (1259 dk),
    // gün sonu DEĞİLDİR. Günün son dakikası olan 23:59 yerel = 20:59Z.
    expect(minutesIntoDay(new Date("2026-10-01T17:59:00Z"), TZ)).toBe(1259);
    expect(minutesIntoDay(new Date("2026-10-01T20:59:00Z"), TZ)).toBe(1439);
  });

  it("yüzde konum 0-100 arasında", () => {
    expect(dayPositionPercent(new Date("2026-09-30T21:00:00Z"), TZ)).toBe(0);
    const noon = dayPositionPercent(new Date("2026-09-30T09:00:00Z"), TZ);
    expect(noon).toBeCloseTo(50, 0);
  });

  it("geçersiz dilimde 0 döner, çökmez", () => {
    expect(minutesIntoDay(new Date("2026-09-30T12:00:00Z"), "Ankara")).toBe(0);
  });
});

describe("gün ışığı kayması", () => {
  it("Europe/Istanbul yıl boyunca UTC+03:00 (kayma yok)", () => {
    expect(offsetAt(new Date("2026-01-15T00:00:00Z"), TZ)).toBe("UTC+03:00");
    expect(offsetAt(new Date("2026-07-15T00:00:00Z"), TZ)).toBe("UTC+03:00");
  });

  it("New York ileri sıçramada gerçek zaman 1 saat kısalır", () => {
    const shift = describeUtcShift("2026-03-07T09:00", "2026-03-09T09:00", "America/New_York");
    expect(shift).not.toBeNull();
    expect(shift?.wallClockDeltaMs).toBe(48 * 3_600_000);
    expect(shift?.utcDeltaMs).toBe(47 * 3_600_000);
    expect(shift?.springForwardMs).toBe(3_600_000);
  });

  it("New York geri sıçramada gerçek zaman 1 saat uzar", () => {
    const shift = describeUtcShift("2026-10-31T09:00", "2026-11-02T09:00", "America/New_York");
    expect(shift?.fallBackMs).toBe(3_600_000);
    expect(shift?.springForwardMs).toBe(0);
  });

  it("kaymasız dilimde ileri/geri sıçrama sıfırdır", () => {
    const shift = describeUtcShift("2026-03-07T09:00", "2026-03-09T09:00", TZ);
    expect(shift?.springForwardMs).toBe(0);
    expect(shift?.fallBackMs).toBe(0);
  });

  it("yok olan yerel saati var gibi sunmaz", () => {
    // New York'da 8 Mart 2026 02:00-03:00 arası saat ileri atlandı
    expect(localTimeExists("2026-03-08T02:30", "America/New_York")).toBe(false);
    expect(localTimeExists("2026-03-08T04:30", "America/New_York")).toBe(true);
    expect(localTimeExists("2026-03-08T02:30", TZ)).toBe(true);
  });
});

describe("yerel ↔ UTC dönüşümü sınırları", () => {
  it("gece yarısı yerel değer doğru UTC'ye gider", () => {
    expect(localIsoToUtc("2026-10-01T00:00", TZ)?.toISOString()).toBe("2026-09-30T21:00:00.000Z");
  });

  it("yıl sonu gece yarısı", () => {
    expect(localIsoToUtc("2027-01-01T00:00", TZ)?.toISOString()).toBe("2026-12-31T21:00:00.000Z");
  });

  it("saniye yoksa da kabul eder", () => {
    expect(localIsoToUtc("2026-10-01T12:00:30", TZ)?.toISOString()).toBe("2026-10-01T09:00:30.000Z");
  });
});

describe("sessiz saat", () => {
  it("SS:DD doğrulaması", () => {
    expect(timeToMinutes("23:00")).toBe(1380);
    expect(timeToMinutes("07:00")).toBe(420);
    expect(timeToMinutes("24:00")).toBeNull();
    expect(timeToMinutes("7:00")).toBeNull();
    expect(timeToMinutes(null)).toBeNull();
  });

  it("dakikaya çevir ve geri al", () => {
    expect(minutesToTime(1380)).toBe("23:00");
    expect(minutesToTime(0)).toBe("00:00");
    expect(minutesToTime(1439)).toBe("23:59");
  });

  it("gece yarısını geçen aralık 8 saattir", () => {
    expect(quietHoursSpan({ start: "23:00", end: "07:00" })).toBe(480);
  });

  it("gündüz aralığı farkı verir", () => {
    expect(quietHoursSpan({ start: "09:00", end: "17:00" })).toBe(480);
    expect(quietHoursSpan(null)).toBeNull();
  });

  it("gece yarısını geçtiğini açıkça söyler", () => {
    expect(describeQuietHours({ start: "23:00", end: "07:00" })).toContain("gece yarısını geçiyor");
    expect(describeQuietHours({ start: "09:00", end: "17:00" })).not.toContain("gece yarısını geçiyor");
    expect(describeQuietHours(null)).toBe("Kapalı");
    expect(describeQuietHours({ start: "99:99", end: "07:00" })).toBe("Geçersiz saat");
  });
});

describe("buildWeekColumns", () => {
  it("bugünü işaretler", () => {
    const weekStart = startOfWeek(new Date(2026, 8, 30));
    const columns = buildWeekColumns(weekStart, new Date(2026, 8, 30));
    expect(columns).toHaveLength(7);
    expect(columns[0]?.key).toBe("2026-09-28");
    expect(columns.find((c) => c.isToday)?.key).toBe("2026-09-30");
    expect(columns[2]?.weekday).toBe("Çar");
  });
});