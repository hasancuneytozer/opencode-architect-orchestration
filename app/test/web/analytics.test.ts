/**
 * `web/src/lib/analytics.ts` — panelin SAF mantığı.
 *
 * Kapsam: `0`/`null` ayrımı, tarih penceresi hesabı, yüzde değişim, ölçülemezlik
 * sebepleri, satır durumu, platform sıralaması ve tarih kırılması uyarısı.
 *
 * ── NEDEN BURADA `Date.now()` YOK ───────────────────────────────────────────
 * `rangeOf`/`previousRange` referans günü PARAMETREYLE alır; bu yüzden "bugün"
 * değişse de testler kırılmaz ve pencerenin gün sayısı elle doğrulanabilir.
 *
 * ⚠️ `formatCount(0)` ve `formatCount(null)` FARKLI sonuç verir (`"0"` / `"—"`).
 * Bu ayrım panelin varlık nedenidir; tek test hâlinde ikisini birlikte
 * doğrulayan bir kontrol aşağıda vardır.
 */
import { describe, expect, it } from "vitest";

import { percentChange } from "../../src/analytics/index.js";
import type { AdditiveMetricKey } from "../../src/analytics/index.js";
import type { Platform } from "../../src/contract/index.js";
import {
  ANALYTICS_DELAY_DAYS,
  DEFAULT_RANGE_DAYS,
  UNAVAILABLE_REASON_META,
  VIEWS_COUNTING_CHANGE_DATE,
  activeReasons,
  changeTone,
  completenessNote,
  daysInRange,
  formatChangePct,
  formatCount,
  formatRate,
  groupDigits,
  isDayString,
  measuredValue,
  newestFirst,
  previousRange,
  rangeOf,
  seriesState,
  shiftDay,
  sortPlatforms,
  sumMeasured,
  unavailableBadge,
  unavailableReasonMeta,
  viewsChangeWarning,
} from "../../web/src/lib/analytics.js";

/** `MetricUnavailableReason` değerlerinin tamamı — `src/analytics`'ten alınır. */
const REASONS = Object.keys(UNAVAILABLE_REASON_META) as Array<keyof typeof UNAVAILABLE_REASON_META>;

// ── `0` ile `null` AYRI mı? ────────────────────────────────────────────────

describe("formatCount — 0 ölçüldü, null ölçülmedi", () => {
  it("null → DASH, undefined → DASH", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(undefined)).toBe("—");
  });

  it("0 → \"0\" (DASH DEĞİL)", () => {
    expect(formatCount(0)).toBe("0");
  });

  it("null ve 0 AYRI gösterilir — aynı sütunda karışmaz", () => {
    expect(formatCount(0)).not.toBe(formatCount(null));
    expect(formatCount(0)).not.toBe("—");
    expect(formatCount(null)).not.toBe("0");
  });

  it("sonlu olmayan değerler DASH (Infinity bile)", () => {
    expect(formatCount(Number.NaN)).toBe("—");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatCount(Number.NEGATIVE_INFINITY)).toBe("—");
  });

  it("10 bindan küçük sayılar tam yazılır", () => {
    expect(formatCount(1)).toBe("1");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1000)).toBe("1.000");
    expect(formatCount(9999)).toBe("9.999");
  });

  it("10 bin ve üstü kısaltılır: bin / mn / Mr", () => {
    expect(formatCount(10_000)).toBe("10,0 bin");
    expect(formatCount(12_345)).toBe("12,3 bin");
    expect(formatCount(999_999)).toBe("1000,0 bin");
    expect(formatCount(1_000_000)).toBe("1,0 mn");
    expect(formatCount(2_450_000)).toBe("2,5 mn");
    expect(formatCount(1_200_000_000)).toBe("1,2 Mr");
    // Kısaltılmış biçim binlik ayırıcı KULLANMAZ (yalnız ondalık virgül):
    // "3.400 Mr" yazmak yanlış olurdu, çünkü `3.400 Mr` = 3,4 Mr okunur.
    expect(formatCount(3_400_000_000_000)).toBe("3400,0 Mr");
  });

  it("negatif değerde işaret korunur", () => {
    expect(formatCount(-1)).toBe("-1");
    expect(formatCount(-5000)).toBe("-5.000");
    expect(formatCount(-1_500_000)).toBe("-1,5 mn");
  });

  it("groupDigits: binlik ayırıcı nokta, ondalık yok", () => {
    expect(groupDigits(0)).toBe("0");
    expect(groupDigits(999)).toBe("999");
    expect(groupDigits(1000)).toBe("1.000");
    expect(groupDigits(1_234_567)).toBe("1.234.567");
    expect(groupDigits(-1_234_567)).toBe("-1.234.567");
  });
});

describe("formatRate — sıfıra bölme koruması", () => {
  it("null / undefined / NaN → DASH", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(undefined)).toBe("—");
    expect(formatRate(Number.NaN)).toBe("—");
  });

  it("0 oranı sıfıra böler ve \"0,0\" değil DEĞİL — yüzde olarak yazılır", () => {
    // Payda 0 olan bir bölme YOK; oran zaten 0..1 arasında bir sayıdır.
    expect(formatRate(0)).toBe("%0,0");
    expect(formatRate(0)).not.toContain("NaN");
    expect(formatRate(0)).not.toContain("Infinity");
  });

  it("oran 100 ile çarpılır (0,512 → %51,2)", () => {
    expect(formatRate(0.512)).toBe("%51,2");
    expect(formatRate(0.0344)).toBe("%3,4");
    expect(formatRate(1)).toBe("%100,0");
  });

  it("negatif oran DASH değil, işaretli yazılır", () => {
    expect(formatRate(-0.05)).toBe("%-5,0");
  });
});

describe("formatChangePct — temel 0 ise yüzde hesaplanmaz", () => {
  it("null → \"—\" (hesaplanamadı, 0 değil)", () => {
    expect(formatChangePct(null)).toBe("—");
    expect(formatChangePct(undefined)).toBe("—");
    expect(formatChangePct(Number.NaN)).toBe("—");
  });

  it("temel dönem 0 iken değişim null gelir ve panel \"—\" yazar", () => {
    // `percentChange` 0'a bölmeyi reddeder; zincirin sonu paneldir.
    expect(percentChange(120, 0)).toBeNull();
    expect(formatChangePct(percentChange(120, 0))).toBe("—");
    // Temel 0 veya ölçülmemiş → \"∞%\" gibi sahte bir kesinlik YAZILMAZ.
    expect(formatChangePct(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("artış / azalış / eşitlik / negatif", () => {
    expect(formatChangePct(12.34)).toBe("+%12,3");
    expect(formatChangePct(-4.06)).toBe("-%4,1");
    expect(formatChangePct(0)).toBe("±%0");
    expect(formatChangePct(-100)).toBe("-%100,0");
  });

  it("bağlam dışı temel: null ise değişim de null", () => {
    expect(percentChange(null, 10)).toBeNull();
    expect(percentChange(10, null)).toBeNull();
    expect(formatChangePct(percentChange(null, 10))).toBe("—");
  });

  it("changeTone: yön → renk", () => {
    expect(changeTone(5)).toBe("ok");
    expect(changeTone(-5)).toBe("danger");
    expect(changeTone(0)).toBe("muted");
    expect(changeTone(null)).toBe("muted");
  });
});

// ── Tarih penceresi ────────────────────────────────────────────────────────

describe("isDayString / shiftDay / daysInRange", () => {
  it("yalnız takvimsel olarak var olan gün kabul edilir", () => {
    expect(isDayString("2026-02-28")).toBe(true);
    expect(isDayString("2024-02-29")).toBe(true);
    expect(isDayString("2026-02-29")).toBe(false);
    expect(isDayString("2026-13-01")).toBe(false);
    expect(isDayString("2026-9-1")).toBe(false);
    expect(isDayString("")).toBe(false);
    expect(isDayString(null)).toBe(false);
    expect(isDayString(20260901)).toBe(false);
  });

  it("shiftDay UTC günü üzerinden kaydırır", () => {
    expect(shiftDay("2026-09-30", 1)).toBe("2026-10-01");
    expect(shiftDay("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("bozuk", 1)).toBe("bozuk");
  });

  it("daysInRange dahil gün sayısını verir", () => {
    expect(daysInRange("2026-09-01", "2026-09-30")).toBe(30);
    expect(daysInRange("2026-09-01", "2026-09-01")).toBe(1);
    expect(daysInRange("2026-09-30", "2026-09-01")).toBe(0);
    expect(daysInRange("2026-09-01", "2026-10-01")).toBe(31);
    expect(daysInRange("bozuk", "2026-09-01")).toBe(0);
  });
});

describe("rangeOf / previousRange", () => {
  it("30 günlük pencere 30 gün verir", () => {
    expect(rangeOf(30, "2026-09-30")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(daysInRange(rangeOf(30, "2026-09-30").from, rangeOf(30, "2026-09-30").to)).toBe(30);
  });

  it("7 günlük pencere ay sınırını geçer", () => {
    expect(rangeOf(7, "2026-01-05")).toEqual({ from: "2025-12-30", to: "2026-01-05" });
  });

  it("90 günlük pencere yıl sınırını geçer", () => {
    const range = rangeOf(90, "2026-01-01");
    expect(range.to).toBe("2026-01-01");
    expect(daysInRange(range.from, range.to)).toBe(90);
  });

  it("from === to olduğunda tek gün", () => {
    expect(rangeOf(1, "2026-03-15")).toEqual({ from: "2026-03-15", to: "2026-03-15" });
  });

  it("geçersiz/eksik gün sayısı varsayılana döner", () => {
    expect(rangeOf(0, "2026-09-30")).toEqual(rangeOf(DEFAULT_RANGE_DAYS, "2026-09-30"));
    expect(rangeOf(-5, "2026-09-30")).toEqual(rangeOf(DEFAULT_RANGE_DAYS, "2026-09-30"));
    expect(rangeOf(Number.NaN, "2026-09-30")).toEqual(rangeOf(DEFAULT_RANGE_DAYS, "2026-09-30"));
  });

  it("previousRange eşit uzunlukta ve bitişiktir (çakışmaz)", () => {
    const current = rangeOf(30, "2026-09-30");
    const previous = previousRange(current.from, current.to);
    expect(previous).toEqual({ from: "2026-08-02", to: "2026-08-31" });
    expect(daysInRange(previous.from, previous.to)).toBe(daysInRange(current.from, current.to));
    // Önceki dönemin son günü, içinde bulunulan dönemin ilk gününün tam bir gün öncesi.
    expect(shiftDay(previous.to, 1)).toBe(current.from);
  });

  it("ay sonu geçişinde önceki dönem de doğru uzunlukta", () => {
    const previous = previousRange("2026-09-01", "2026-09-01");
    expect(previous).toEqual({ from: "2026-08-31", to: "2026-08-31" });
  });

  it("from === to için önceki dönem tek gün", () => {
    expect(previousRange("2026-03-15", "2026-03-15")).toEqual({
      from: "2026-03-14",
      to: "2026-03-14",
    });
  });
});

// ── Tarih kırılması uyarısı ────────────────────────────────────────────────

describe("viewsChangeWarning", () => {
  const D = VIEWS_COUNTING_CHANGE_DATE;

  it("sabit, panelde sabit yazılan tarih değil sunucudan gelebilir", () => {
    expect(D).toBe("2026-08-27");
  });

  it("iki dönem de tamamen önceyse uyarı YOK", () => {
    expect(
      viewsChangeWarning({
        from: "2026-07-01",
        to: "2026-07-30",
        previousFrom: "2026-06-01",
        previousTo: "2026-06-30",
      }),
    ).toBeNull();
  });

  it("iki dönem de tamamen sonraysa uyarı YOK", () => {
    expect(
      viewsChangeWarning({
        from: "2026-08-28",
        to: "2026-09-26",
        previousFrom: "2026-07-29",
        previousTo: "2026-08-26",
      }),
    ).toBeNull();
  });

  it("İÇİNDEKİ dönem kırılmayı içeriyorsa uyarı verir", () => {
    const warning = viewsChangeWarning({
      from: "2026-08-20",
      to: "2026-09-18",
      previousFrom: "2026-07-21",
      previousTo: "2026-08-19",
    });
    expect(warning).not.toBeNull();
    expect(warning).toContain("bu dönem");
    expect(warning).toContain(D);
    expect(warning).not.toContain("önceki dönem");
  });

  it("ÖNCEKİ dönem kırılmayı içeriyorsa uyarı verir", () => {
    const warning = viewsChangeWarning({
      from: "2026-08-28",
      to: "2026-09-26",
      previousFrom: "2026-07-30",
      previousTo: "2026-08-28",
    });
    expect(warning).not.toBeNull();
    expect(warning).toContain("önceki dönem");
    expect(warning).not.toContain("bu dönem");
  });

  it("iki dönem de kırılmayı içeriyorsa ikisi birlikte anılır", () => {
    const warning = viewsChangeWarning({
      from: "2026-08-01",
      to: "2026-08-31",
      previousFrom: "2026-08-02",
      previousTo: "2026-08-30",
    });
    expect(warning).toContain("bu dönem ve önceki dönem");
  });

  it("sınırlar dahil: from VE to tam olarak kırılma günü", () => {
    expect(
      viewsChangeWarning({
        from: D,
        to: D,
        previousFrom: "2026-08-01",
        previousTo: "2026-08-26",
      }),
    ).not.toBeNull();
  });

  it("kırılma gününden bir gün sonrası artık \"içinde\" değil", () => {
    // `to === D` hâlâ sınıra DAHİL; iki dönemin de sonu `D`'den küçük olmalı.
    expect(
      viewsChangeWarning({
        from: "2026-08-28",
        to: "2026-09-27",
        previousFrom: "2026-07-30",
        previousTo: "2026-08-26",
      }),
    ).toBeNull();
  });

  it("sunucudan gelen kırılma tarihi varsa O kullanılır", () => {
    const warning = viewsChangeWarning({
      from: "2026-01-01",
      to: "2026-01-31",
      previousFrom: "2025-12-02",
      previousTo: "2026-01-01",
      changeDate: "2026-01-10",
    });
    expect(warning).toContain("2026-01-10");
    expect(warning).not.toContain(VIEWS_COUNTING_CHANGE_DATE);
  });

  it("karşılaştırma penceresi yoksa (null) yalnız içindeki dönem anılır", () => {
    const warning = viewsChangeWarning({
      from: "2026-08-01",
      to: "2026-08-31",
      previousFrom: null,
      previousTo: null,
    });
    expect(warning).toContain("bu dönem");
    expect(warning).not.toContain("ve önceki dönem");
  });

  it("bozuk tarihler uyarı üretmez (çökmeye yol açmaz)", () => {
    expect(
      viewsChangeWarning({ from: "bozuk", to: "2026-09-01", previousFrom: null, previousTo: null }),
    ).toBeNull();
  });
});

// ── Sıralama ───────────────────────────────────────────────────────────────

describe("sortPlatforms — kararlı sıralama", () => {
  const card = (platform: Platform, views: number | undefined): {
    platform: Platform;
    totals: Record<string, number>;
  } => ({ platform, totals: views === undefined ? {} : { views } });

  it("oynatmaya göre büyükten küçüğe", () => {
    const out = sortPlatforms([card("youtube", 10), card("instagram", 30), card("tiktok", 25)]);
    expect(out.map((c) => c.platform)).toEqual(["instagram", "tiktok", "youtube"]);
  });

  it("eşitlikte platform sırası sabittir (IG → TT → YT), girdi sırasından bağımsız", () => {
    const a = sortPlatforms([card("youtube", 10), card("tiktok", 10), card("instagram", 10)]);
    const b = sortPlatforms([card("instagram", 10), card("youtube", 10), card("tiktok", 10)]);
    const c = sortPlatforms([card("tiktok", 10), card("instagram", 10), card("youtube", 10)]);
    expect(a.map((x) => x.platform)).toEqual(["instagram", "tiktok", "youtube"]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("eksik anahtar 0 sayılır", () => {
    const out = sortPlatforms([card("instagram", undefined), card("youtube", 1)]);
    expect(out.map((c) => c.platform)).toEqual(["youtube", "instagram"]);
  });

  it("hepsi 0 ise kararlılık korunur", () => {
    const out = sortPlatforms([card("youtube", 0), card("tiktok", 0), card("instagram", 0)]);
    expect(out.map((c) => c.platform)).toEqual(["instagram", "tiktok", "youtube"]);
  });

  it("girdi dizisi MUTASYONA UĞRAMAZ", () => {
    const input = [card("youtube", 1), card("instagram", 9)];
    const copy = [...input];
    sortPlatforms(input);
    expect(input).toEqual(copy);
  });

  it("boş dizi", () => {
    expect(sortPlatforms([])).toEqual([]);
  });

  it("newestFirst: tarih yeniden eskiye, girdi değişmez", () => {
    const points = [{ date: "2026-09-01" }, { date: "2026-09-30" }, { date: "2026-09-15" }];
    expect(newestFirst(points).map((p) => p.date)).toEqual([
      "2026-09-30",
      "2026-09-15",
      "2026-09-01",
    ]);
    expect(points[0]?.date).toBe("2026-09-01");
  });
});

// ── Ölçülemezlik sebepleri ─────────────────────────────────────────────────

describe("activeReasons — sıfır sayımlı sebepleri eler", () => {
  it("sıfır ve negatif sayımlar listeye GİRMEZ", () => {
    const out = activeReasons({ not_public: 3, not_found: 0, deleted: -2, no_scope: 1 });
    expect(out.map((r) => r.reason)).toEqual(["not_public", "no_scope"]);
  });

  it("en çok etkilenen sebep önce gelir", () => {
    const out = activeReasons({ not_public: 1, deleted: 5, not_found: 9 });
    expect(out.map((r) => r.reason)).toEqual(["not_found", "deleted", "not_public"]);
    expect(out.map((r) => r.count)).toEqual([9, 5, 1]);
  });

  it("eşitlikte sebep adına göre deterministik", () => {
    const out = activeReasons({ not_public: 2, deleted: 2 });
    expect(out.map((r) => r.reason)).toEqual(["deleted", "not_public"]);
  });

  it("null / undefined / {} → boş liste", () => {
    expect(activeReasons(null)).toEqual([]);
    expect(activeReasons(undefined)).toEqual([]);
    expect(activeReasons({})).toEqual([]);
  });

  it("her sebep meta taşır", () => {
    const out = activeReasons({ not_public: 2 });
    expect(out[0]?.meta.label).toBe(UNAVAILABLE_REASON_META.not_public.label);
  });

  it("bilinmeyen sebep kodu olduğu gibi gösterilir (çökmez)", () => {
    const out = activeReasons({ future_reason_code: 4 });
    expect(out[0]?.reason).toBe("future_reason_code");
    expect(out[0]?.meta.label).toBe("future_reason_code");
    expect(unavailableReasonMeta("bilinmeyen").label).toBe("bilinmeyen");
  });

  it("sözlükte sayı olmayan değerler elenir", () => {
    const out = activeReasons({ not_public: "3" as unknown as number, deleted: 1 });
    expect(out.map((r) => r.reason)).toEqual(["deleted"]);
  });

  it("unavailableBadge metni sayıyı taşır", () => {
    expect(unavailableBadge(4)).toBe("ölçülemeyen 4 içerik");
  });

  it("sözlükteki beş sebep için karşılık gelen üst sınıf mevcut", () => {
    for (const reason of REASONS) {
      expect(unavailableReasonMeta(reason).label.length).toBeGreaterThan(0);
      expect(unavailableReasonMeta(reason).detail.length).toBeGreaterThan(0);
    }
  });
});

// ── Satır durumu ───────────────────────────────────────────────────────────

describe("seriesState — üç hâl", () => {
  it("ölçüldü: satırda ölçülen iş var", () => {
    expect(seriesState({ items: 3, measured: 3, unavailable: null })).toEqual({
      label: "ölçüldü",
      tone: "ok",
    });
  });

  it("ölçülemedi: unavailable sayısı SATIR SAYISINDAN büyük olabilir", () => {
    expect(seriesState({ items: 2, measured: 1, unavailable: { count: 7 } })).toEqual({
      label: "7 içerik ölçülemedi",
      tone: "warn",
    });
  });

  it("karışık: measured 0 olsa bile \"ölçülemedi\" kazanır", () => {
    // Sıralama kasıtlı: kullanıcı en kötü haberi önce görür.
    expect(seriesState({ items: 2, measured: 0, unavailable: { count: 2 } })).toEqual({
      label: "2 içerik ölçülemedi",
      tone: "warn",
    });
  });

  it("ölçülemeyen yok ama measured 0 ise \"veri bekleniyor\" (arıza DEĞİL)", () => {
    expect(seriesState({ items: 2, measured: 0, unavailable: null })).toEqual({
      label: "veri bekleniyor",
      tone: "info",
    });
    expect(seriesState({ items: 2, measured: 0, unavailable: { count: 0 } })).toEqual({
      label: "veri bekleniyor",
      tone: "info",
    });
  });

  it("tek üç hâl dışında etiket üretilmez", () => {
    const labels = [
      seriesState({ items: 1, measured: 1, unavailable: null }).label,
      seriesState({ items: 1, measured: 0, unavailable: null }).label,
      seriesState({ items: 1, measured: 1, unavailable: { count: 1 } }).label,
    ];
    expect(labels).toEqual(["ölçüldü", "veri bekleniyor", "1 içerik ölçülemedi"]);
  });
});

// ── Veri gecikmesi notu ────────────────────────────────────────────────────

describe("completenessNote — eksik gün sayısına göre metin", () => {
  const completeness = (pendingDays: string[], delayDays = ANALYTICS_DELAY_DAYS) => ({
    from: "2026-09-01",
    to: "2026-09-30",
    expectedDays: 30,
    measuredDays: 30 - pendingDays.length,
    missingDataDays: 0,
    delayDays,
    pendingDays,
    complete: pendingDays.length === 0,
  });

  it("null / undefined → not yok (null)", () => {
    expect(completenessNote(null)).toBeNull();
    expect(completenessNote(undefined)).toBeNull();
  });

  it("eksik gün yoksa not YOK (kullanıcı gereksiz uyarı görmez)", () => {
    expect(completenessNote(completeness([]))).toBeNull();
  });

  it("gecikme penceresindeki günler not edilir ve \"eksik sayılmaz\" der", () => {
    const note = completenessNote(completeness(["2026-09-29", "2026-09-30"]));
    expect(note).not.toBeNull();
    expect(note).toContain("Son 2 gün");
    expect(note).toContain("2026-09-29, 2026-09-30");
    expect(note).toContain("2 günlük veri gecikmesi");
    expect(note).toContain("eksik sayılmaz");
  });

  it("tek gün ile çok gün farklı metin üretir", () => {
    expect(completenessNote(completeness(["2026-09-30"]))).toContain("Son 1 gün");
    expect(completenessNote(completeness(["2026-09-28", "2026-09-29", "2026-09-30"]))).toContain(
      "Son 3 gün",
    );
  });

  it("varsayılan gecikme Instagram'ın 48 saati", () => {
    expect(ANALYTICS_DELAY_DAYS).toBe(2);
    expect(completenessNote(completeness(["2026-09-30"]))).toContain("2 günlük veri gecikmesi");
  });
});

// ── Toplama ────────────────────────────────────────────────────────────────

describe("sumMeasured — null toplamlar yok sayılır", () => {
  it("hiç ölçülen yoksa null (0 DEĞİL)", () => {
    expect(sumMeasured([])).toBeNull();
    expect(sumMeasured([null, null])).toBeNull();
  });

  it("tek sıfır ölçüldüyse sonuç 0'dır — null DEĞİL", () => {
    expect(sumMeasured([null, 0])).toBe(0);
  });

  it("null'lar atlanır, kalanlar toplanır", () => {
    expect(sumMeasured([1, null, 2, Number.NaN, 3])).toBe(6);
  });

  it("ölçülen değerler arasında tek sıfır varsa da null DEĞİLDİR", () => {
    expect(sumMeasured([0, 0])).toBe(0);
  });
});

describe("measuredValue — katkı 0 ise null", () => {
  const rollup = (totals: Partial<Record<AdditiveMetricKey, number>>, contributors: Partial<Record<AdditiveMetricKey, number>>) =>
    ({ totals, contributors }) as Parameters<typeof measuredValue>[0];

  it("katkı 0 ise 0 katkılı toplam bile gösterilMEZ (null)", () => {
    expect(measuredValue(rollup({ views: 0 }, { views: 0 }), "views")).toBeNull();
    expect(measuredValue(rollup({ views: 999 }, { views: 0 }), "views")).toBeNull();
  });

  it("katkı varsa toplam ne 0 ise 0 olarak kalır — null DEĞİL", () => {
    expect(measuredValue(rollup({ views: 0 }, { views: 3 }), "views")).toBe(0);
  });

  it("katkıda anahtar yoksa null (undefined ≠ ölçüldü)", () => {
    expect(measuredValue(rollup({ views: 12 }, {}), "views")).toBeNull();
  });

  it("toplam sonlu değilse null", () => {
    expect(measuredValue(rollup({ views: Number.NaN }, { views: 1 }), "views")).toBeNull();
    expect(measuredValue(rollup({}, { views: 1 }), "views")).toBeNull();
  });

  it("0 ve null ayrımı bu katmanda da korunur", () => {
    const zero = measuredValue(rollup({ views: 0 }, { views: 2 }), "views");
    const missing = measuredValue(rollup({ views: 0 }, { views: 0 }), "views");
    expect(zero).not.toBe(missing);
    expect(formatCount(zero)).toBe("0");
    expect(formatCount(missing)).toBe("—");
  });
});