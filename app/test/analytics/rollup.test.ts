/**
 * Toplama (`rollup`) ve dönem karşılaştırması — SAF testler.
 *
 * En önemli kanıt: **günlük satırlar TOPLANMAZ.** 300/450/600 gösteren üç
 * günlük tabloda toplam 1350 DEĞİL 600 olmalıdır; satırlar aynı ölçümün
 * zaman içindeki anlık görüntüleridir, günlük artışlar değil.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_DELAY_DAYS, comparePeriods, percentChange, rollup } from "../../src/analytics/rollup.js";
import type { RollupRow } from "../../src/analytics/rollup.js";
import type { MetricUnavailable } from "../../src/analytics/types.js";

/** Satır kurucu — testlerde tekrar tekrar yazmamak için. */
function row(
  jobId: string,
  metricDate: string,
  metrics: Record<string, number | null>,
  unavailable: MetricUnavailable | null = null,
  extra: Partial<RollupRow> = {},
): RollupRow {
  return { jobId, contentId: `c-${jobId}`, platform: "instagram", metricDate, metrics, unavailable, ...extra };
}

function noScope(logId: string | null = null): MetricUnavailable {
  return { reason: "no_scope", message: "İzin eksik: instagram_manage_insights.", logId };
}

// ── Günlük satırlar toplanmaz ────────────────────────────────────────────────

describe("rollup — günlük ANLIK GÖRÜNTÜLER TOPLANMAZ", () => {
  it("300/450/600 gösteren 3 günlük tablonun toplamı 1350 DEĞİL 600'dür", () => {
    const rows: RollupRow[] = [
      row("j1", "2026-10-01", { views: 300, likes: 30 }),
      row("j1", "2026-10-02", { views: 450, likes: 40 }),
      row("j1", "2026-10-03", { views: 600, likes: 50 }),
    ];
    const out = rollup(rows, { scope: "content" });
    expect(out.totals.views).toBe(600);
    expect(out.totals.views).not.toBe(1350);
    expect(out.totals.likes).toBe(50);
  });

  it("toplam her işin EN SON günkü üzerinden kurulur", () => {
    const rows: RollupRow[] = [
      row("j1", "2026-10-01", { views: 300 }),
      row("j1", "2026-10-03", { views: 600 }),
      row("j2", "2026-10-01", { views: 100 }),
      row("j2", "2026-10-02", { views: 250 }),
    ];
    const out = rollup(rows, { scope: "platform" });
    // j1 → 600, j2 → 250. Satır satır toplam (300+600+100+250 = 1250) YANLIŞTIR.
    expect(out.totals.views).toBe(850);
    expect(out.itemCount).toBe(2);
  });

  it("sıra karışık geldiğinde de gün karşılaştırması yapılır", () => {
    const rows: RollupRow[] = [
      row("j1", "2026-10-03", { views: 600 }),
      row("j1", "2026-10-01", { views: 300 }),
      row("j1", "2026-10-02", { views: 450 }),
    ];
    expect(rollup(rows, { scope: "content" }).totals.views).toBe(600);
  });

  it("latestDate ölçülen EN SON gündür", () => {
    const rows: RollupRow[] = [
      row("j1", "2026-10-01", { views: 300 }),
      row("j1", "2026-10-03", { views: 600 }),
    ];
    expect(rollup(rows, { scope: "content" }).latestDate).toBe("2026-10-03");
  });

  it("son gün ölçülemiyorsa latestDate daha eskiye düşer", () => {
    const rows: RollupRow[] = [
      row("j1", "2026-10-01", { views: 300 }),
      row("j1", "2026-10-03", {}, noScope()),
    ];
    const out = rollup(rows, { scope: "content" });
    expect(out.latestDate).toBe("2026-10-01");
    expect(out.unavailableCount).toBe(1);
  });
});

// ── scope davranışı ──────────────────────────────────────────────────────────

describe("rollup — scope", () => {
  it("scope=content: latest o içeriğin tamamıdır", () => {
    const out = rollup([row("j1", "2026-10-01", { views: 600, likes: 50, avg_watch_time_sec: 18 })], {
      scope: "content",
    });
    expect(out.latest).toEqual({ views: 600, likes: 50, avg_watch_time_sec: 18 });
  });

  it("scope=platform: latest yalnız TOPLANABİLİR anahtarların toplamıdır", () => {
    const rows = [
      row("j1", "2026-10-01", { views: 600, likes: 50, avg_watch_time_sec: 18 }),
      row("j2", "2026-10-01", { views: 400, likes: 20, avg_watch_time_sec: 25 }),
    ];
    const out = rollup(rows, { scope: "platform" });
    expect(out.latest["views"]).toBe(1000);
    expect(out.latest["likes"]).toBe(70);
    // Ortalama toplanmaz: ortalama + ortalama "ortalama" değildir.
    expect(out.latest["avg_watch_time_sec"]).toBeUndefined();
  });
});

// ── Türetilmiş oranlar ───────────────────────────────────────────────────────

describe("rollup — türetilmiş oranlar", () => {
  const rows = [
    row("j1", "2026-10-01", { views: 1000, saves: 50, shares: 25, interactions: 200 }),
    row("j2", "2026-10-01", { views: 1000, saves: 30, shares: 15, interactions: 100 }),
  ];

  it("saveRate = saves / views", () => {
    // saves 50+30 = 80, views 1000+1000 = 2000 → 0.04
    expect(rollup(rows, { scope: "platform" }).rates.saveRate).toBeCloseTo(0.04, 10);
  });

  it("shareRate = shares / views", () => {
    // shares 25+15 = 40, views 2000 → 0.02
    expect(rollup(rows, { scope: "platform" }).rates.shareRate).toBeCloseTo(0.02, 10);
  });

  it("interactionRate = interactions / views", () => {
    // interactions 200+100 = 300, views 2000 → 0.15
    expect(rollup(rows, { scope: "platform" }).rates.interactionRate).toBeCloseTo(0.15, 10);
  });

  it("oranlar 0 değerinde de hesaplanır (pay 0, payda değil)", () => {
    const zero = [row("j1", "2026-10-01", { views: 1000, saves: 0, shares: 0, interactions: 0 })];
    const out = rollup(zero, { scope: "platform" });
    expect(out.rates.saveRate).toBe(0);
    expect(out.rates.shareRate).toBe(0);
    expect(out.rates.interactionRate).toBe(0);
  });
});

describe("rollup — sıfıra bölme koruması", () => {
  it("views=0 iken oranlar null'dur (Infinity değil)", () => {
    const out = rollup([row("j1", "2026-10-01", { views: 0, saves: 0, shares: 0, interactions: 0 })], {
      scope: "content",
    });
    expect(out.totals.views).toBe(0);
    expect(out.rates.saveRate).toBeNull();
    expect(out.rates.shareRate).toBeNull();
    expect(out.rates.interactionRate).toBeNull();
  });

  it("hiç views satırı yoksa oranlar null'dur", () => {
    const out = rollup([row("j1", "2026-10-01", { likes: 10 })], { scope: "content" });
    expect(out.totals.views).toBe(0);
    expect(out.rates.saveRate).toBeNull();
  });

  it("ölçülemeyen işlerin değerleri orana girmez", () => {
    const rows = [
      row("j1", "2026-10-01", { views: 1000, saves: 100 }),
      row("j2", "2026-10-01", {}, noScope()),
    ];
    const out = rollup(rows, { scope: "platform" });
    expect(out.totals.views).toBe(1000);
    expect(out.rates.saveRate).toBeCloseTo(0.1, 10);
    expect(out.unavailableCount).toBe(1);
  });
});

// ── Üç ayrı "veri yok" durumu ────────────────────────────────────────────────

describe("rollup — ölçülemeyen / veri yok / sıfır AYRI sayılır", () => {
  it("unavailableCount yalnız `unavailable` yazan işleri sayar", () => {
    const rows = [
      row("j1", "2026-10-01", { views: 10 }),
      row("j2", "2026-10-01", {}, noScope()),
      row("j3", "2026-10-01", {}, { reason: "not_public", message: "herkese açık değil", logId: null }),
    ];
    const out = rollup(rows, { scope: "platform" });
    expect(out.unavailableCount).toBe(2);
    expect(out.measuredCount).toBe(1);
    expect(out.itemCount).toBe(3);
  });

  it("noDataCount: satır var, unavailable YOK, tüm değerler null", () => {
    const rows = [
      row("j1", "2026-10-01", { views: null, likes: null }),
      row("j2", "2026-10-01", { views: 0 }),
    ];
    const out = rollup(rows, { scope: "platform" });
    expect(out.noDataCount).toBe(1);
    expect(out.measuredCount).toBe(1);
    expect(out.unavailableCount).toBe(0);
  });

  it("değeri 0 olan satır ÖLÇÜLMÜŞ sayılır (null sayılmaz)", () => {
    const out = rollup([row("j1", "2026-10-01", { views: 0, likes: 0 })], { scope: "content" });
    expect(out.measuredCount).toBe(1);
    expect(out.noDataCount).toBe(0);
    expect(out.unavailableCount).toBe(0);
    expect(out.totals.views).toBe(0);
    expect(out.latestDate).toBe("2026-10-01");
  });

  it("sebeplere göre kırılım üretilir (panel 'neden ölçülemiyor' listesi)", () => {
    const rows = [
      row("j1", "2026-10-01", {}, { reason: "no_scope", message: "a", logId: null }),
      row("j2", "2026-10-01", {}, { reason: "no_scope", message: "b", logId: null }),
      row("j3", "2026-10-01", {}, { reason: "not_public", message: "c", logId: null }),
      row("j4", "2026-10-01", {}, { reason: "deleted", message: "d", logId: null }),
    ];
    const out = rollup(rows, { scope: "platform" });
    expect(out.unavailableReasons.no_scope).toBe(2);
    expect(out.unavailableReasons.not_public).toBe(1);
    expect(out.unavailableReasons.deleted).toBe(1);
    expect(out.unavailableReasons.not_found).toBe(0);
    expect(out.unavailableReasons.provider_error).toBe(0);
  });

  it("üç sayacın toplamı `itemCount`a eşittir", () => {
    const rows = [
      row("j1", "2026-10-01", { views: 5 }),
      row("j2", "2026-10-01", { views: null }),
      row("j3", "2026-10-01", {}, noScope()),
    ];
    const out = rollup(rows, { scope: "platform" });
    expect(out.measuredCount + out.noDataCount + out.unavailableCount).toBe(out.itemCount);
  });
});

// ── Pencere ve tamlık ────────────────────────────────────────────────────────

describe("rollup — pencere dışı satırlar sayılmaz", () => {
  const rows = [
    row("j1", "2026-09-28", { views: 100 }),
    row("j1", "2026-10-01", { views: 300 }),
    row("j1", "2026-10-03", { views: 600 }),
    row("j1", "2026-10-07", { views: 999 }),
  ];

  it("from/to verilmezse satırların gün aralığı kullanılır", () => {
    const out = rollup(rows, { scope: "content" });
    expect(out.from).toBe("2026-09-28");
    expect(out.to).toBe("2026-10-07");
  });

  it("verilen pencere dışındaki satır toplama GİRMEZ", () => {
    const out = rollup(rows, { scope: "content", from: "2026-10-01", to: "2026-10-03" });
    expect(out.totals.views).toBe(600);
    expect(out.from).toBe("2026-10-01");
    expect(out.to).toBe("2026-10-03");
  });

  it("pencere dışı satırlar `missingDataDays` sayımını da kirletmez", () => {
    const out = rollup(rows, { scope: "content", from: "2026-10-01", to: "2026-10-03" });
    expect(out.completeness.expectedDays).toBe(3);
    expect(out.completeness.missingDataDays).toBe(0);
  });

  it("pencereye hiç satır düşmezse boş sonuç döner", () => {
    const out = rollup(rows, { scope: "content", from: "2026-11-01", to: "2026-11-03" });
    expect(out.totals.views).toBe(0);
    expect(out.latestDate).toBeNull();
    expect(out.itemCount).toBe(0);
  });
});

describe("rollup — veri tamlığı (missingDataDays)", () => {
  it("varsayılan gecikme 2 gündür (IG 48 saat)", () => {
    expect(DEFAULT_DELAY_DAYS).toBe(2);
    expect(rollup([], { scope: "platform", from: "2026-10-01", to: "2026-10-10" }).completeness.delayDays).toBe(2);
  });

  it("pencere sonundaki gecikme günleri EKSİK SAYILMAZ", () => {
    const rows = [row("j1", "2026-10-01", { views: 10 })];
    const out = rollup(rows, { scope: "content", from: "2026-10-01", to: "2026-10-10", delayDays: 2 });
    // 10 günlük pencere, 1 ölçülen gün. Son 2 gün (09, 10) "bekleniyor".
    expect(out.completeness.expectedDays).toBe(10);
    expect(out.completeness.measuredDays).toBe(1);
    expect(out.completeness.pendingDays).toEqual(["2026-10-09", "2026-10-10"]);
    expect(out.completeness.missingDataDays).toBe(7);
    expect(out.completeness.complete).toBe(false);
  });

  it("gecikme beklentisi dışında eksik yoksa `complete` true'dur", () => {
    const rows = [
      row("j1", "2026-10-07", { views: 1 }),
      row("j1", "2026-10-08", { views: 2 }),
      row("j1", "2026-10-09", { views: 3 }),
    ];
    const out = rollup(rows, { scope: "content", from: "2026-10-07", to: "2026-10-09", delayDays: 2 });
    expect(out.completeness.missingDataDays).toBe(0);
    expect(out.completeness.complete).toBe(true);
  });

  it("delayDays=0 son günü de bekleniyor saymaz", () => {
    const rows = [row("j1", "2026-10-01", { views: 1 })];
    const out = rollup(rows, { scope: "content", from: "2026-10-01", to: "2026-10-03", delayDays: 0 });
    expect(out.completeness.pendingDays).toEqual([]);
    expect(out.completeness.missingDataDays).toBe(2);
  });

  it("hiç ölçülmeyen gün `measuredDays`a girmez", () => {
    const rows = [row("j1", "2026-10-01", {}, noScope())];
    const out = rollup(rows, { scope: "content", from: "2026-10-01", to: "2026-10-05", delayDays: 0 });
    expect(out.completeness.measuredDays).toBe(0);
    expect(out.completeness.missingDataDays).toBe(5);
    expect(out.latestDate).toBeNull();
  });
});

// ── Katkıcı sayısı, unknown ve deprecated ────────────────────────────────────

describe("rollup — katkıcılar, unknown, deprecated", () => {
  it("her toplamın dayandığı iş sayısı ayrı sayılır", () => {
    const rows = [
      row("j1", "2026-10-01", { views: 100, likes: 10 }),
      row("j2", "2026-10-01", { views: 200, likes: null }),
    ];
    const out = rollup(rows, { scope: "platform" });
    expect(out.contributors.views).toBe(2);
    expect(out.contributors.likes).toBe(1);
  });

  it("null değer katkıcı sayısına GİRMEZ", () => {
    const rows = [row("j1", "2026-10-01", { views: null })];
    const out = rollup(rows, { scope: "content" });
    expect(out.contributors.views).toBe(0);
    expect(out.totals.views).toBe(0);
  });

  it("eşlenmemiş ham adlar birleşik ve sıralı gelir", () => {
    const rows = [
      row("j1", "2026-10-01", { views: 1 }, null, { unknown: ["zeta", "alpha"] }),
      row("j2", "2026-10-01", { views: 1 }, null, { unknown: ["mu", "alpha"] }),
    ];
    expect(rollup(rows, { scope: "platform" }).unknown).toEqual(["alpha", "mu", "zeta"]);
  });

  it("kaldırılmış metrikler raporlanır ama TOPLAMA GİRMEZ", () => {
    const rows = [
      row("j1", "2026-10-01", { views: 100 }, null, {
        deprecated: [{ providerName: "plays", value: 900, note: "kaldırıldı" }],
      }),
    ];
    const out = rollup(rows, { scope: "content" });
    expect(out.deprecated).toHaveLength(1);
    expect(out.totals.views).toBe(100);
    expect(Object.keys(out.totals)).not.toContain("plays");
  });
});

// ── Boş girdi ────────────────────────────────────────────────────────────────

describe("rollup — boş girdi geçerli bir sonuçtur", () => {
  it("boş satır dizisi sıfır ve null döner, HATA FIRSATLATMAZ", () => {
    const out = rollup([], { scope: "platform", from: "2026-10-01", to: "2026-10-07" });
    expect(out.totals.views).toBe(0);
    expect(out.latestDate).toBeNull();
    expect(out.latest).toEqual({});
    expect(out.rates.saveRate).toBeNull();
    expect(out.itemCount).toBe(0);
    expect(out.unknown).toEqual([]);
    expect(out.completeness.expectedDays).toBe(7);
  });

  it("'hiç veri yok' ile 'ölçülemedi' ayrımı bozulmaz", () => {
    const bos = rollup([], { scope: "platform", from: "2026-10-01", to: "2026-10-07" });
    const olcumlenemez = rollup([row("j1", "2026-10-01", {}, noScope())], {
      scope: "platform",
      from: "2026-10-01",
      to: "2026-10-07",
      delayDays: 0,
    });
    expect(bos.latestDate).toBeNull();
    expect(bos.unavailableCount).toBe(0);
    expect(olcumlenemez.unavailableCount).toBe(1);
  });
});

// ── Yüzde değişim ────────────────────────────────────────────────────────────

describe("percentChange", () => {
  it("temel dönem 0 ise yüzde null'dur (Infinity değil)", () => {
    expect(percentChange(100, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
  });

  it("temel dönem null ise yüzde null'dur ('ölçülmemiş' ≠ 'sıfır')", () => {
    expect(percentChange(100, null)).toBeNull();
    expect(percentChange(null, 100)).toBeNull();
  });

  it("artış pozitif yüzde verir", () => {
    expect(percentChange(150, 100)).toBeCloseTo(50, 10);
  });

  it("azalış negatif yüzde verir", () => {
    expect(percentChange(50, 100)).toBeCloseTo(-50, 10);
  });

  it("eşitlikte yüzde 0'dır", () => {
    expect(percentChange(100, 100)).toBe(0);
  });

  it("negatif temel değerde işaret korunur (Math.abs paydası)", () => {
    expect(percentChange(-50, -100)).toBeCloseTo(50, 10);
  });
});

// ── Dönem karşılaştırması ────────────────────────────────────────────────────

describe("comparePeriods", () => {
  // Satırın `metricDate`'si Pencereye İÇİDE olmalıdır: `rollup` pencere dışı
  // satırları filtreler, "önceki dönem" bu yüzden kendi günüyle üretilir.
  const cur = (views: number, likes: number) =>
    rollup([row("j1", "2026-10-02", { views, likes })], {
      scope: "content",
      from: "2026-10-01",
      to: "2026-10-07",
    });
  const prev = (views: number, likes: number) =>
    rollup([row("j1", "2026-09-25", { views, likes })], {
      scope: "content",
      from: "2026-09-24",
      to: "2026-09-30",
    });

  it("her toplanabilir anahtar için bir delta üretir", () => {
    const cmp = comparePeriods(cur(200, 20), prev(100, 10));
    expect(cmp.deltas.length).toBeGreaterThanOrEqual(7);
    const views = cmp.deltas.find((d) => d.key === "views");
    expect(views).toEqual({ key: "views", current: 200, previous: 100, delta: 100, changePct: 100 });
  });

  it("oranlar da karşılaştırılır (saveRate/shareRate/interactionRate)", () => {
    const cur = rollup([row("j1", "2026-10-01", { views: 100, saves: 20, shares: 5, interactions: 30 })], {
      scope: "content",
      from: "2026-10-01",
      to: "2026-10-07",
    });
    const prev = rollup([row("j1", "2026-09-24", { views: 100, saves: 10, shares: 5, interactions: 20 })], {
      scope: "content",
      from: "2026-09-24",
      to: "2026-09-30",
    });
    const cmp = comparePeriods(cur, prev);
    const saveRate = cmp.deltas.find((d) => d.key === "saveRate");
    expect(saveRate?.current).toBeCloseTo(0.2, 10);
    expect(saveRate?.previous).toBeCloseTo(0.1, 10);
    expect(saveRate?.changePct).toBeCloseTo(100, 10);
  });

  it("temel dönem 0 ise yüzde null gelir", () => {
    const views = comparePeriods(cur(500, 5), prev(0, 0)).deltas.find((d) => d.key === "views");
    expect(views?.previous).toBe(0);
    expect(views?.delta).toBe(500);
    expect(views?.changePct).toBeNull();
  });

  it("azalış yönü `down` olarak sayılır", () => {
    const cmp = comparePeriods(cur(50, 5), prev(100, 10));
    expect(cmp.direction.down).toBeGreaterThan(0);
    expect(cmp.direction.up).toBe(0);
  });

  it("eşitlikte `flat` sayılır", () => {
    const cmp = comparePeriods(cur(100, 10), prev(100, 10));
    expect(cmp.direction.flat).toBeGreaterThan(0);
    expect(cmp.deltas.find((d) => d.key === "views")?.changePct).toBe(0);
  });

  it("hesaplanamayan oranlar `unknown` yönündedir", () => {
    const cur = rollup([row("j1", "2026-10-01", { views: 0 })], {
      scope: "content",
      from: "2026-10-01",
      to: "2026-10-07",
    });
    const prev = rollup([row("j1", "2026-09-24", { views: 0 })], {
      scope: "content",
      from: "2026-09-24",
      to: "2026-09-30",
    });
    const cmp = comparePeriods(cur, prev);
    expect(cmp.direction.unknown).toBeGreaterThan(0);
    expect(cmp.deltas.find((d) => d.key === "saveRate")?.delta).toBeNull();
  });

  it("her iki dönemin penceresi de döner", () => {
    const cmp = comparePeriods(cur(1, 1), prev(1, 1));
    expect(cmp.current).toMatchObject({ from: "2026-10-01", to: "2026-10-07" });
    expect(cmp.previous).toMatchObject({ from: "2026-09-24", to: "2026-09-30" });
  });

  it("yön sayaçlarının toplamı delta sayısına eşittir", () => {
    const cmp = comparePeriods(cur(200, 20), prev(100, 10));
    const { up, down, flat, unknown } = cmp.direction;
    expect(up + down + flat + unknown).toBe(cmp.deltas.length);
  });
});