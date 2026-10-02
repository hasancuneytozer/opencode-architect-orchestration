/**
 * `web/src/lib/format.ts` — bayt, süre, göreli zaman, yerel saat ↔ UTC.
 * Saf mantık testleri; DOM veya ağ yok.
 */
import { describe, expect, it } from "vitest";

import {
  DASH,
  charUsage,
  formatBitrate,
  formatBytes,
  formatDurationSec,
  formatFps,
  formatPercent,
  formatRelativeTime,
  formatResolution,
  formatZonedDateTime,
  pluralTr,
  toDateTimeLocalValue,
  truncate,
  trNumber,
  zonedDateParts,
} from "../../web/src/lib/format.js";
import { localIsoToUtc, offsetAt } from "../../web/src/lib/schedule.js";

const TZ = "Europe/Istanbul";

describe("formatBytes (1024 tabanlı)", () => {
  it("bayt altı değerleri ham bayt olarak yazılır", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("1024 tabanlı birim zincirini kullanır", () => {
    expect(formatBytes(1024)).toBe("1,0 KB");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1,0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1,0 GB");
  });

  it("100 ve üstünde ondalık basamağı düşürür", () => {
    expect(formatBytes(1024 * 200)).toBe("200 KB");
  });

  it("bilinmeyen değerlerde tek tutarlı yedek döner", () => {
    expect(formatBytes(null)).toBe(DASH);
    expect(formatBytes(undefined)).toBe(DASH);
    expect(formatBytes(-1)).toBe(DASH);
    expect(formatBytes(Number.NaN)).toBe(DASH);
  });
});

describe("formatDurationSec", () => {
  it("dakika:saniye biçimini kullanır", () => {
    expect(formatDurationSec(0)).toBe("0:00");
    expect(formatDurationSec(7)).toBe("0:07");
    expect(formatDurationSec(65)).toBe("1:05");
    expect(formatDurationSec(599)).toBe("9:59");
  });

  it("bir saati aşınca saat ekler", () => {
    expect(formatDurationSec(3600)).toBe("1:00:00");
    expect(formatDurationSec(3723)).toBe("1:02:03");
  });

  it("gece yarısı sınırında iki basamağa çıkar", () => {
    expect(formatDurationSec(86399)).toBe("23:59:59");
  });

  it("negatif ve bilinmeyen değerlerde yedek döner", () => {
    expect(formatDurationSec(null)).toBe(DASH);
    expect(formatDurationSec(-5)).toBe(DASH);
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");

  it("çok yakın geçmişi 'az önce' yazar", () => {
    expect(formatRelativeTime("2026-10-01T11:59:30Z", now)).toBe("az önce");
  });

  it("dakika/saat/gün/hafta/ay/yıl basamaklarını kullanır", () => {
    expect(formatRelativeTime("2026-10-01T11:57:00Z", now)).toBe("3 dk önce");
    expect(formatRelativeTime("2026-10-01T07:00:00Z", now)).toBe("5 sa önce");
    expect(formatRelativeTime("2026-09-28T12:00:00Z", now)).toBe("3 gün önce");
    expect(formatRelativeTime("2026-09-10T12:00:00Z", now)).toBe("3 hafta önce");
    expect(formatRelativeTime("2026-06-01T12:00:00Z", now)).toBe("4 ay önce");
    expect(formatRelativeTime("2024-10-01T12:00:00Z", now)).toBe("2 yıl önce");
  });

  it("geleceği 'sonra' ile ayırır", () => {
    expect(formatRelativeTime("2026-10-01T12:10:00Z", now)).toBe("10 dk sonra");
  });

  it("bozuk tarihte çökmez", () => {
    expect(formatRelativeTime("değil-tarih", now)).toBe(DASH);
    expect(formatRelativeTime(null, now)).toBe(DASH);
  });
});

describe("yerel saat ↔ UTC (Europe/Istanbul)", () => {
  it("UTC ISO'yu yerel okunur biçime çevirir (+03:00)", () => {
    expect(formatZonedDateTime("2026-09-30T15:00:00Z", TZ)).toBe("30.09.2026 18:00");
  });

  it("gece yarısını geçen UTC değerini doğru gün çevirir", () => {
    // 21:00Z = 00:00 (ertesi gün) İstanbul'da
    expect(formatZonedDateTime("2026-09-30T21:00:00Z", TZ)).toBe("01.10.2026 00:00");
  });

  it("datetime-local değerine yerel saat olarak çevirir", () => {
    expect(toDateTimeLocalValue("2026-09-30T15:00:00Z", TZ)).toBe("2026-09-30T18:00");
  });

  it("datetime-local geri çevrimi yereli UTC'ye çevirir", () => {
    const local = toDateTimeLocalValue("2026-09-30T15:00:00Z", TZ);
    const utc = localIsoToUtc(local, TZ);
    expect(utc?.toISOString()).toBe("2026-09-30T15:00:00.000Z");
  });

  it("geçersiz saat diliminde null döner, çökmez", () => {
    expect(localIsoToUtc("2026-09-30T18:00", "Ankara")).toBeNull();
    expect(zonedDateParts(new Date("2026-09-30T15:00:00Z"), "Ankara")).toBeNull();
    expect(offsetAt(new Date("2026-09-30T15:00:00Z"), "Ankara")).toBe(DASH);
  });

  it("geçersiz yerel değeri reddeder", () => {
    expect(localIsoToUtc("saat 18", TZ)).toBeNull();
    expect(localIsoToUtc("2026-02-31T18:00", TZ)).toBeNull();
  });
});

describe("biçim yardımcıları", () => {
  it("çözünürlük, fps ve bit hızı", () => {
    expect(formatResolution(1080, 1920)).toBe("1080×1920");
    expect(formatResolution(null, 1920)).toBe(DASH);
    expect(formatFps(29.97)).toBe("29.97 fps");
    expect(formatFps(30)).toBe("30 fps");
    expect(formatBitrate(5_500_000)).toBe("5,5 Mbps");
    expect(formatBitrate(0)).toBe(DASH);
    expect(formatPercent(0.512)).toBe("%51,2");
  });

  it("Türkçe ondalık ayırıcı virgüldür", () => {
    expect(trNumber(1.25)).toBe("1,3");
    expect(pluralTr(1, "kayıt", "kayıt")).toBe("1 kayıt");
  });

  it("uzun metni orta yerden keser", () => {
    expect(truncate("abcdef", 10)).toBe("abcdef");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate(null, 4)).toBe("");
  });
});

describe("charUsage — sınırdan büyük metin kırpılmaz", () => {
  it("sınır içinde kalanı yeşil sayar", () => {
    const usage = charUsage("abc", 2200);
    expect(usage.length).toBe(3);
    expect(usage.over).toBe(false);
    expect(usage.near).toBe(false);
    expect(usage.remaining).toBe(2197);
  });

  it("sınıra yaklaşınca uyarır", () => {
    expect(charUsage("x".repeat(2160), 2200).near).toBe(true);
  });

  it("sınırı aşan metni kırpma, fazlayı raporlar", () => {
    const usage = charUsage("x".repeat(2300), 2200);
    expect(usage.over).toBe(true);
    expect(usage.length).toBe(2300);
    expect(usage.value).toHaveLength(2300);
    expect(usage.remaining).toBe(-100);
  });
});