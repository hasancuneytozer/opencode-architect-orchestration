/**
 * Zamanlama testleri. Hepsi deterministik: `now` elle verilir, saat dilimi
 * sabittir. İstanbul sabit UTC+3'tür (2016'dan beri yaz saati uygulanmaz), bu
 * yüzden yaz saati hesapları yanıltmaz; bir Berlin testi de yaz saati yolunu
 * ziyaret eder.
 *
 * KİLİTLENEN HATA: `end: "00:00"` "o günün gece yarısı" değil, ERTESİ GÜNÜN
 * gece yarısıdır. Sessiz saat 23:00→00:00 iken 23:30'a yayınlanan içerik o
 * gün 00:00'a değil ertesi sabaha kayar.
 */
import { describe, expect, it } from "vitest";

import type { QuietHours } from "../../src/contract/index.js";
import {
  MAX_QUIET_SHIFTS,
  fmtLocal,
  isDue,
  nextEligibleTime,
  shiftOutOfQuietHours,
} from "../../src/domain/schedule.js";

const IST = "Europe/Istanbul";
const BERLIN = "Europe/Berlin";
const q = (start: string, end: string): QuietHours => ({ start, end });

describe("isDue", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");

  it("geçmiş zamanlar hazırdır", () => {
    expect(isDue("2026-09-30T11:59:59.000Z", now)).toBe(true);
  });

  it("şu anki an hazırdır (eşitlik dahil)", () => {
    expect(isDue("2026-09-30T12:00:00.000Z", now)).toBe(true);
  });

  it("gelecek zamanlar hazır değildir", () => {
    expect(isDue("2026-09-30T12:00:00.001Z", now)).toBe(false);
  });

  it("boşlukla ayrılmış ISO da kabul edilir", () => {
    expect(isDue("2026-09-30 11:00:00", now)).toBe(true);
  });

  it("geçersiz zaman damgası sessizce false DÖNMEZ, hata fırlatır", () => {
    expect(() => isDue("2026-09-30T99:99:99Z", now)).toThrow(TypeError);
    expect(() => isDue("", now)).toThrow(TypeError);
    expect(() => isDue("2026-09-30T12:00:00Z", new Date("çöp"))).toThrow(TypeError);
  });
});

describe("nextEligibleTime — sessiz saatte değilse dokunulmaz", () => {
  const at = "2026-09-30T18:00:00.000Z"; // İstanbul 21:00
  const now = new Date("2026-09-30T10:00:00.000Z");

  it("sessiz saat tanımı yoksa zaman olduğu gibi döner", () => {
    expect(nextEligibleTime({ scheduledAtUtc: at, quietHours: null, timezone: IST }, now)).toBe(at);
  });

  it("zaman sessiz saat aralığı dışındaysa olduğu gibi döner", () => {
    const out = nextEligibleTime({ scheduledAtUtc: at, quietHours: q("23:00", "23:59"), timezone: IST }, now);
    expect(out).toBe(at);
  });

  it("geçmiş zaman sessiz saatte de olsa kaydırılmaz (dışarıdaysa)", () => {
    const out = nextEligibleTime(
      { scheduledAtUtc: "2026-09-30T00:00:00.000Z", quietHours: q("10:00", "11:00"), timezone: IST },
      now,
    );
    expect(out).toBe("2026-09-30T00:00:00.000Z");
  });
});

describe("nextEligibleTime — sessiz saatten kaydırma", () => {
  it("23:00→07:00 arasında 03:00'e denk gelen an aynı sabaha kayar", () => {
    // 2026-09-30T00:00Z = İstanbul 03:00
    const out = nextEligibleTime(
      { scheduledAtUtc: "2026-09-30T00:00:00.000Z", quietHours: q("23:00", "07:00"), timezone: IST },
      new Date("2026-09-29T12:00:00.000Z"),
    );
    expect(out).toBe("2026-09-30T04:00:00.000Z"); // İstanbul 07:00
  });

  it("REGRESYON: end '00:00' ERTESİ GÜNE kaydırır", () => {
    // 2026-09-30T20:30Z = İstanbul 23:30 (30 Eylül)
    const out = nextEligibleTime(
      { scheduledAtUtc: "2026-09-30T20:30:00.000Z", quietHours: q("23:00", "00:00"), timezone: IST },
      new Date("2026-09-30T18:00:00.000Z"),
    );
    expect(out).toBe("2026-09-30T21:00:00.000Z"); // 1 Ekim 00:00 +03:00
    expect(new Date(out as string).toISOString()).toBe("2026-09-30T21:00:00.000Z");
  });

  it("REGRESYON: ay sınırında da '00:00' ertesi güne gider", () => {
    // 2026-10-31T20:30Z = İstanbul 23:30 (31 Ekim)
    const out = nextEligibleTime(
      { scheduledAtUtc: "2026-10-31T20:30:00.000Z", quietHours: q("23:00", "00:00"), timezone: IST },
      new Date("2026-10-31T18:00:00.000Z"),
    );
    expect(out).toBe("2026-10-31T21:00:00.000Z"); // 1 Kasım 00:00 +03:00
  });

  it("sabit ofsetli dilimde hesap birebir tutarlı", () => {
    // 2026-09-30T22:00Z = İstanbul 01:00 (1 Ekim) → sessiz → 06:00 (1 Ekim) = 03:00Z
    const out = nextEligibleTime(
      { scheduledAtUtc: "2026-09-30T22:00:00.000Z", quietHours: q("01:00", "06:00"), timezone: IST },
      new Date("2026-09-30T12:00:00.000Z"),
    );
    expect(out).toBe("2026-10-01T03:00:00.000Z");
  });

  it("yaz saati olan dilimde de doğru (Berlin, Temmuz = UTC+2)", () => {
    // 2026-07-15T02:00Z = Berlin 04:00
    const out = nextEligibleTime(
      { scheduledAtUtc: "2026-07-15T02:00:00.000Z", quietHours: q("00:00", "07:00"), timezone: BERLIN },
      new Date("2026-07-15T00:00:00.000Z"),
    );
    expect(out).toBe("2026-07-15T05:00:00.000Z"); // Berlin 07:00
  });

  it("geçmişe kaydırılan sessiz saat çöktüyse 'now' döner", () => {
    // Zamanlama 30 Eylül 05:00 (sessiz), kaydırma 04:00'e düşüyor ama şimdi
    // 09:00 → geçmiş bir zaman damgası yerine "şimdi uygun" denmeli.
    const out = nextEligibleTime(
      { scheduledAtUtc: "2026-09-30T02:00:00.000Z", quietHours: q("00:00", "07:00"), timezone: IST },
      new Date("2026-09-30T09:00:00.000Z"),
    );
    expect(out).toBe("2026-09-30T09:00:00.000Z");
  });

  it("geçersiz saat dilimi hata fırlatır", () => {
    expect(() =>
      nextEligibleTime(
        { scheduledAtUtc: "2026-09-30T18:00:00.000Z", quietHours: q("01:00", "02:00"), timezone: "Ankara" },
        new Date("2026-09-30T10:00:00.000Z"),
      ),
    ).toThrow(TypeError);
  });
});

describe("shiftOutOfQuietHours — ham kaydırma", () => {
  it("sessiz saatte değilse dokunmaz", () => {
    const at = "2026-09-30T18:00:00.000Z";
    expect(shiftOutOfQuietHours(at, q("23:00", "07:00"), IST)).toBe(at);
  });

  it("sessiz saattese bitiş anına taşır", () => {
    // 2026-09-30T02:00Z = İstanbul 05:00
    expect(shiftOutOfQuietHours("2026-09-30T02:00:00.000Z", q("00:00", "07:00"), IST)).toBe(
      "2026-09-30T04:00:00.000Z",
    );
  });

  it("bitiş saati tam sınırdır: kaydırılan an artık sessiz saatte DEĞİLDİR", () => {
    const shifted = shiftOutOfQuietHours("2026-09-30T02:00:00.000Z", q("00:00", "07:00"), IST) as string;
    // İkinci uygulama hiçbir şey değiştirmemeli: döngü bir turda yakınsar.
    expect(shiftOutOfQuietHours(shifted, q("00:00", "07:00"), IST)).toBe(shifted);
  });

  it("gece yarısını geçen bitişte bir gün ileri atlar", () => {
    expect(shiftOutOfQuietHours("2026-09-30T20:30:00.000Z", q("23:00", "00:00"), IST)).toBe(
      "2026-09-30T21:00:00.000Z",
    );
  });

  it("başlangıç = bitiş olan pencere 'hiç sessiz değil' sayılır", () => {
    const at = "2026-09-30T20:30:00.000Z";
    expect(shiftOutOfQuietHours(at, q("23:00", "23:00"), IST)).toBe(at);
  });

  it("kaydırma döngüsü 7 günle sınırlıdır (sabit belgelenmiş)", () => {
    expect(MAX_QUIET_SHIFTS).toBe(7);
  });

  it("gerçekçi pencerelerde döngü tek turda yakınsar", () => {
    for (const quiet of [q("00:00", "07:00"), q("23:00", "07:00"), q("22:00", "06:00")]) {
      const first = shiftOutOfQuietHours("2026-09-30T02:00:00.000Z", quiet, IST) as string;
      expect(shiftOutOfQuietHours(first, quiet, IST)).toBe(first);
    }
  });
});

describe("fmtLocal", () => {
  it("UTC'yi kullanıcı saat dilimine çevirir", () => {
    expect(fmtLocal("2026-09-30T18:00:00.000Z", IST)).toMatch(/21:00/);
    expect(fmtLocal("2026-09-30T18:00:00.000Z", "UTC")).toMatch(/18:00/);
  });

  it("tarihi de gösterir", () => {
    expect(fmtLocal("2026-09-30T18:00:00.000Z", IST)).toMatch(/2026/);
  });

  it("locale değiştirilebilir", () => {
    // en-US kısa tarih biçimi 9/30/26 kullanır (yıl iki hane).
    expect(fmtLocal("2026-09-30T18:00:00.000Z", "UTC", "en-US")).toMatch(/9\/30\/26/);
    expect(fmtLocal("2026-09-30T18:00:00.000Z", "UTC", "en-US", { dateStyle: "long" })).toMatch(
      /September 30, 2026/,
    );
  });

  it("özel biçim seçenekleri geçerlidir", () => {
    const out = fmtLocal("2026-09-30T18:00:00.000Z", IST, "tr-TR", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    expect(out).toMatch(/Eylül/);
  });

  it("geçersiz zaman/saat dilimi hata fırlatır", () => {
    expect(() => fmtLocal("2026-09-30T18:00:00.000Z", "Ankara")).toThrow(TypeError);
    expect(() => fmtLocal("çöp", IST)).toThrow(TypeError);
  });
});