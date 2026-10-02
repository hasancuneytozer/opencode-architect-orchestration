/**
 * Normalleştirme ve yerel gün hesabı — SAF testler. Ağ yok, veritabanı yok.
 *
 * Buradaki kanıtlar panelde görülen sayıların nereden geldiğini gösterir:
 *   * her platformun ham adı kanonik ada gider (üç platform karşılaştırılabilir),
 *   * `plays`/`impressions` kanonik tabloya GİRMEZ,
 *   * `0` ile `null` ayrı kalır,
 *   * tanınmayan ad SESSİZE düşmez,
 *   * gün UTC değil YEREL gündür.
 */
import { describe, expect, it } from "vitest";
import {
  ADDITIVE_METRIC_KEYS,
  CANONICAL_METRIC_NAMES,
  INSTAGRAM_METRIC_ALIASES,
  TIKTOK_METRIC_ALIASES,
  YOUTUBE_METRIC_ALIASES,
  canonicalName,
  dayCount,
  deprecatedNote,
  deprecationWarnings,
  eachDay,
  isCanonicalMetricName,
  isMetricDate,
  metricDate,
  nextDay,
  noteUnknown,
  normalize,
  readNumber,
  safeDivide,
} from "../../src/analytics/metrics.js";
import type { NormalizeRef } from "../../src/analytics/metrics.js";

/** Sabit referans — `normalize` zamanı dışarıdan alır, burada da öyle. */
const REF: NormalizeRef = {
  remoteId: "remote-1",
  metricDate: "2026-10-01",
  fetchedAt: "2026-10-01T20:00:00.000Z",
};

// ── Kanonik ad eşlemeleri ───────────────────────────────────────────────────

describe("normalize — Instagram ham adları kanonik ada gider", () => {
  it("ig_reels_avg_watch_time → avg_watch_time_sec", () => {
    const out = normalize("instagram", { ig_reels_avg_watch_time: 18 }, REF);
    expect(out.metrics["avg_watch_time_sec"]).toBe(18);
    expect(out.metrics["watch_time_min"]).toBeUndefined();
  });

  it("reels_skip_rate → skip_rate", () => {
    const out = normalize("instagram", { reels_skip_rate: 0.42 }, REF);
    expect(out.metrics["skip_rate"]).toBeCloseTo(0.42, 10);
  });

  it("total_interactions → interactions", () => {
    const out = normalize("instagram", { total_interactions: 512 }, REF);
    expect(out.metrics["interactions"]).toBe(512);
  });

  it("saved → saves (IG 'saves' değil 'saved' der)", () => {
    expect(canonicalName("instagram", "saved")).toBe("saves");
    const out = normalize("instagram", { saved: 31 }, REF);
    expect(out.metrics["saves"]).toBe(31);
    expect(out.metrics["saved"]).toBeUndefined();
  });

  it("reach/views/likes/comments/shares/reposts birebir kanonik ada gider", () => {
    const out = normalize(
      "instagram",
      { reach: 100, views: 240, likes: 12, comments: 3, shares: 5, reposts: 1 },
      REF,
    );
    expect(out.metrics).toEqual({
      reach: 100,
      views: 240,
      likes: 12,
      comments: 3,
      shares: 5,
      reposts: 1,
    });
  });

  it("platforma özel alanlar da kanonikleşir (toplama GİRMEZ)", () => {
    const out = normalize("instagram", { crossposted_views: 90, facebook_views: 70 }, REF);
    expect(out.metrics["crossposted_views"]).toBe(90);
    expect(out.metrics["facebook_views"]).toBe(70);
    expect(ADDITIVE_METRIC_KEYS).not.toContain("crossposted_views");
    expect(ADDITIVE_METRIC_KEYS).not.toContain("facebook_views");
  });
});

describe("normalize — TikTok ham adları", () => {
  it("view_count → views", () => {
    const out = normalize("tiktok", { view_count: 1234 }, REF);
    expect(out.metrics["views"]).toBe(1234);
    expect(out.metrics["view_count"]).toBeUndefined();
  });

  it("like/comment/share/download sayaçları kanonikleşir", () => {
    const out = normalize(
      "tiktok",
      { like_count: 40, comment_count: 6, share_count: 9, download_count: 2 },
      REF,
    );
    expect(out.metrics).toEqual({ views: undefined, likes: 40, comments: 6, shares: 9, downloads: 2 });
    expect(out.metrics["views"]).toBeUndefined();
  });

  it("TikTok'ta kaldırılmış sayaç YOKTUR", () => {
    expect(deprecatedNote("tiktok", "plays")).toBeNull();
    expect(deprecatedNote("tiktok", "impressions")).toBeNull();
    expect(TIKTOK_METRIC_ALIASES.size).toBeGreaterThan(0);
  });
});

describe("normalize — YouTube ham adları", () => {
  it("estimatedMinutesWatched → watch_time_min (TOPLAM dakika)", () => {
    const out = normalize("youtube", { estimatedMinutesWatched: 820 }, REF);
    expect(out.metrics["watch_time_min"]).toBe(820);
  });

  it("averageViewDuration → avg_watch_time_sec (ORTALAMA saniye)", () => {
    const out = normalize("youtube", { averageViewDuration: 137 }, REF);
    expect(out.metrics["avg_watch_time_sec"]).toBe(137);
  });

  it("toplam dakika ve ortalama saniye AYRI kanonik adlardır", () => {
    // Birleştirilseydi "ortalama + toplam" hatası olurdu.
    expect(canonicalName("youtube", "estimatedMinutesWatched")).toBe("watch_time_min");
    expect(canonicalName("youtube", "averageViewDuration")).toBe("avg_watch_time_sec");
    expect(canonicalName("youtube", "estimatedMinutesWatched")).not.toBe(
      canonicalName("youtube", "averageViewDuration"),
    );
  });

  it("averageViewPercentage / audienceWatchRatio / subscribersGained karşılıklarını bulur", () => {
    const out = normalize(
      "youtube",
      {
        averageViewPercentage: 55.5,
        audienceWatchRatio: 0.61,
        subscribersGained: 17,
      },
      REF,
    );
    expect(out.metrics["avg_view_percent"]).toBeCloseTo(55.5, 10);
    expect(out.metrics["watch_ratio"]).toBeCloseTo(0.61, 10);
    expect(out.metrics["subs_gained"]).toBe(17);
  });

  it("YouTube paylaşım sayısı VERMEZ: `shares` eşlemesi UYDURULMAZ", () => {
    expect(YOUTUBE_METRIC_ALIASES.has("shares")).toBe(false);
    expect(canonicalName("youtube", "shares")).toBeNull();
    const out = normalize("youtube", { views: 10 }, REF);
    expect(out.metrics["shares"]).toBeUndefined();
  });

  it("YouTube `dislikes` istenmez (PublicData'da yoktur) ama eşlemesi vardır", () => {
    expect(canonicalName("youtube", "dislikes")).toBe("dislikes");
  });
});

// ── Kaldırılmış metrikler ───────────────────────────────────────────────────

describe("normalize — plays ve impressions KALDIRILMIŞ", () => {
  it("plays kanonik tabloya GİRMEZ, deprecated listesine yazılır", () => {
    const out = normalize("instagram", { plays: 900 }, REF);
    expect(out.metrics["plays"]).toBeUndefined();
    expect(isCanonicalMetricName("plays")).toBe(false);
    expect(CANONICAL_METRIC_NAMES).not.toContain("plays");
    expect(out.deprecated).toHaveLength(1);
    expect(out.deprecated[0]?.providerName).toBe("plays");
    expect(out.deprecated[0]?.value).toBe(900);
    expect(out.deprecated[0]?.note).toMatch(/21 Nisan 2025/);
  });

  it("impressions kanonik tabloya GİRMEZ, deprecated listesine yazılır", () => {
    const out = normalize("instagram", { impressions: 1_500 }, REF);
    expect(out.metrics["impressions"]).toBeUndefined();
    expect(isCanonicalMetricName("impressions")).toBe(false);
    expect(CANONICAL_METRIC_NAMES).not.toContain("impressions");
    expect(out.deprecated[0]?.providerName).toBe("impressions");
    expect(out.deprecated[0]?.note).toMatch(/2 Temmuz 2024/);
  });

  it("kaldırılmış ad `unknown` listesine DE GİRMEZ (çift sayım olurdu)", () => {
    const out = normalize("instagram", { plays: 10, impressions: 20 }, REF);
    expect(out.unknown).toEqual([]);
    expect(out.deprecated.map((d) => d.providerName)).toEqual(["impressions", "plays"]);
  });

  it("kaldırılmış metrik toplanabilir listede de yoktur", () => {
    expect(ADDITIVE_METRIC_KEYS).not.toContain("plays");
    expect(ADDITIVE_METRIC_KEYS).not.toContain("impressions");
  });

  it("deprecationWarnings panelde gösterilecek tek cümleler üretir", () => {
    const out = normalize("instagram", { plays: 5 }, REF);
    const warnings = deprecationWarnings("instagram", out.deprecated);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^plays: /);
  });
});

// ── 0 / null / undefined ayrımı ─────────────────────────────────────────────

describe("normalize — 0 ile null AYRI kalır", () => {
  it("0 sayı olarak kalır (null'a çevrilmez)", () => {
    expect(readNumber(0)).toBe(0);
    const out = normalize("instagram", { views: 0, reach: 0 }, REF);
    expect(out.metrics["views"]).toBe(0);
    expect(out.metrics["reach"]).toBe(0);
  });

  it("null 'veri yok' olarak kalır (0'a çevrilmez)", () => {
    expect(readNumber(null)).toBeNull();
    const out = normalize("instagram", { views: null }, REF);
    expect(out.metrics["views"]).toBeNull();
    expect(out.metrics["views"]).not.toBe(0);
  });

  it("undefined alan metrics'e hiç yazılmaz", () => {
    const out = normalize("instagram", { views: undefined }, REF);
    expect(Object.keys(out.metrics)).toEqual([]);
  });

  it("üç durum birbirinden ayrılabilir", () => {
    const out = normalize("instagram", { reach: 0, views: null, likes: undefined }, REF);
    expect(out.metrics["reach"]).toBe(0);
    expect("views" in out.metrics).toBe(true);
    expect(out.metrics["views"]).toBeNull();
    expect("likes" in out.metrics).toBe(false);
  });

  it("boş metin `null`dur (YouTube kırpılmış sayıda boş hücre döner)", () => {
    expect(readNumber("")).toBeNull();
    expect(readNumber("   ")).toBeNull();
    expect(normalize("youtube", { views: "" }, REF).metrics["views"]).toBeNull();
  });

  it("sayı metni sayıya çevrilir", () => {
    expect(readNumber("42")).toBe(42);
    expect(readNumber(" 3.5 ")).toBe(3.5);
    expect(normalize("youtube", { views: "120" }, REF).metrics["views"]).toBe(120);
  });

  it("sayıya çevrilemeyen metin `null`dur", () => {
    expect(readNumber("çok")).toBeNull();
    expect(readNumber(Number.NaN)).toBeNull();
    expect(readNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

// ── Tanınmayan metrikler ────────────────────────────────────────────────────

describe("normalize — tanınmayan metrik SESSİZE düşmez", () => {
  it("eşlenmemiş sayısal alan `unknown`a girer", () => {
    const out = normalize("tiktok", { view_count: 5, brand_hits: 3 }, REF);
    expect(out.unknown).toEqual(["brand_hits"]);
    expect(out.metrics["brand_hits"]).toBeUndefined();
  });

  it("eşlenmemiş metinsel alan da `unknown`a girer (okunamadı DEĞİL)", () => {
    const out = normalize("instagram", { is_aigc: true }, REF);
    expect(out.unknown).toEqual(["is_aigc"]);
    expect(out.metrics["is_aigc"]).toBeUndefined();
  });

  it("`unknown` sıralı gelir (panelde kararlı görünsün)", () => {
    const out = normalize("instagram", { zeta: 1, alpha: 1, mu: 1 }, REF);
    expect(out.unknown).toEqual(["alpha", "mu", "zeta"]);
  });

  it("noteUnknown sonradan eksik alanı ekler", () => {
    const first = normalize("instagram", { views: 1 }, REF);
    const second = noteUnknown(first, "plays_missing");
    expect(second.unknown).toEqual(["plays_missing"]);
    expect(first.unknown).toEqual([]);
  });

  it("noteUnknown aynı adı iki kez EKLEMEZ", () => {
    const first = noteUnknown(normalize("instagram", { views: 1 }, REF), "x");
    expect(noteUnknown(first, "x").unknown).toEqual(["x"]);
  });
});

// ── Boş küme ve kimlik taşıma ───────────────────────────────────────────────

describe("normalize — boş küme 0 DEĞİLDİR", () => {
  it("IG'nin boş `data: []` yanıtı boş ölçüm verir, sıfır değil", () => {
    const out = normalize("instagram", {}, REF);
    expect(out.metrics).toEqual({});
    expect(Object.values(out.metrics)).not.toContain(0);
    expect(out.unknown).toEqual([]);
    expect(out.deprecated).toEqual([]);
    expect(out.unavailable).toBeNull();
  });

  it("kimlik ve zaman damgası girdiyle birebir taşınır", () => {
    const out = normalize("tiktok", { view_count: 1 }, {
      ...REF,
      remoteId: "vid-9",
      metricDate: "2026-10-02",
    });
    expect(out.remoteId).toBe("vid-9");
    expect(out.metricDate).toBe("2026-10-02");
    expect(out.fetchedAt).toBe(REF.fetchedAt);
    expect(out.platform).toBe("tiktok");
  });

  it("`logId` üst düzeyden gelir", () => {
    const out = normalize("tiktok", { view_count: 1 }, { ...REF, logId: "log-77" });
    expect(out.logId).toBe("log-77");
  });

  it("`logId` yoksa zarfın içinden alınır", () => {
    const out = normalize("tiktok", {}, {
      ...REF,
      unavailable: { reason: "provider_error", message: "hata", logId: "log-88" },
    });
    expect(out.logId).toBe("log-88");
  });

  it("hiçbir yerde logId yoksa null", () => {
    expect(normalize("instagram", { views: 1 }, REF).logId).toBeNull();
  });
});

// ── Yerel gün ───────────────────────────────────────────────────────────────

describe("metricDate — YEREL gün, UTC günü değil", () => {
  it("2026-10-01T22:00Z + Europe/Istanbul → 2026-10-02", () => {
    expect(metricDate("2026-10-01T22:00:00Z", "Europe/Istanbul")).toBe("2026-10-02");
  });

  it("aynı an UTC'de 2026-10-01'dir — ayrımın tam olarak bu", () => {
    expect(metricDate("2026-10-01T22:00:00Z", "UTC")).toBe("2026-10-01");
  });

  it("sınırın hemen altındaki an aynı güne düşer", () => {
    expect(metricDate("2026-10-01T20:59:00Z", "Europe/Istanbul")).toBe("2026-10-01");
  });

  it("sınırın tam üstündeki an ertesi güne düşer", () => {
    expect(metricDate("2026-10-01T21:00:00Z", "Europe/Istanbul")).toBe("2026-10-02");
  });

  it("New York'ta aynı an hâlâ 01 Ekim'dir (dilim işareti)", () => {
    expect(metricDate("2026-10-01T22:00:00Z", "America/New_York")).toBe("2026-10-01");
  });

  it("Date ve epoch ms kabul edilir", () => {
    const ms = Date.parse("2026-10-01T22:00:00Z");
    expect(metricDate(new Date(ms), "Europe/Istanbul")).toBe("2026-10-02");
    expect(metricDate(ms, "Europe/Istanbul")).toBe("2026-10-02");
  });

  it("varsayılan saat dilimi Europe/Istanbul'dır", () => {
    expect(metricDate("2026-10-01T22:00:00Z")).toBe("2026-10-02");
  });

  it("geçersiz saat dilimi FIRSAT FIRLATIR (sessizce UTC'ye düşmez)", () => {
    expect(() => metricDate("2026-10-01T22:00:00Z", "Ankara")).toThrow(/Geçersiz saat dilimi/);
  });

  it("geçersiz zaman anı fırlatır", () => {
    expect(() => metricDate("yok-boyle-bir-tarih")).toThrow(/Geçersiz zaman anı/);
  });
});

// ── Tarih yardımcıları ──────────────────────────────────────────────────────

describe("tarih yardımcıları", () => {
  it("isMetricDate biçimi ve takvimi doğrular", () => {
    expect(isMetricDate("2026-10-01")).toBe(true);
    expect(isMetricDate("2026-1-1")).toBe(false);
    expect(isMetricDate("2026-02-31")).toBe(false);
    expect(isMetricDate("")).toBe(false);
    expect(isMetricDate("2026-10-01T00:00:00Z")).toBe(false);
  });

  it("nextDay ay ve yıl sınırlarını geçer", () => {
    expect(nextDay("2026-10-01")).toBe("2026-10-02");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
  });

  it("dayCount UÇTAŞ (dahil) gün sayar, ters aralık 0 verir", () => {
    expect(dayCount("2026-10-01", "2026-10-01")).toBe(1);
    expect(dayCount("2026-10-01", "2026-10-03")).toBe(3);
    expect(dayCount("2026-10-03", "2026-10-01")).toBe(0);
  });

  it("dayCount geçersiz tarihte fırlatır", () => {
    expect(() => dayCount("2026-10", "2026-10-03")).toThrow(/Geçersiz tarih aralığı/);
  });

  it("eachDay aralığı kronolojik üretir", () => {
    expect([...eachDay("2026-10-01", "2026-10-04")]).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
  });
});

// ── Bölme koruması ──────────────────────────────────────────────────────────

describe("safeDivide", () => {
  it("normal bölme", () => {
    expect(safeDivide(10, 5)).toBe(2);
  });

  it("payda 0 ise null (Infinity üretilmez)", () => {
    expect(safeDivide(10, 0)).toBeNull();
    expect(safeDivide(0, 0)).toBeNull();
  });

  it("payda null ise null (0 değil)", () => {
    expect(safeDivide(10, null)).toBeNull();
    expect(safeDivide(null, 5)).toBeNull();
  });

  it("pay 0 iken sonuç 0'dır (ölçüldü ve sıfır)", () => {
    expect(safeDivide(0, 5)).toBe(0);
  });

  it("sonlu olmayan girdi null verir", () => {
    expect(safeDivide(Number.POSITIVE_INFINITY, 5)).toBeNull();
    expect(safeDivide(10, Number.NaN)).toBeNull();
  });
});

// ── Eşleme tablolarının bütünlüğü ───────────────────────────────────────────

describe("kanonik tablo bütünlüğü", () => {
  it("her eşleme değeri kanonik kümede olan bir addır", () => {
    for (const map of [INSTAGRAM_METRIC_ALIASES, TIKTOK_METRIC_ALIASES, YOUTUBE_METRIC_ALIASES]) {
      for (const canonical of map.values()) {
        expect(isCanonicalMetricName(canonical)).toBe(true);
      }
    }
  });

  it("bir platform İÇİNDE iki ham ad aynı kanonik ada gitmez", () => {
    // Platformlar ARASI tekrar beklenir (`views` üçünde de `views`'tır); kural
    // platform içinde geçerlidir, çünkü `normalize` tek platformun tablosunu kullanır.
    for (const map of [INSTAGRAM_METRIC_ALIASES, TIKTOK_METRIC_ALIASES, YOUTUBE_METRIC_ALIASES]) {
      const seen = new Map<string, string>();
      for (const [raw, canonical] of map) {
        const key = `${canonical}`;
        const prior = seen.get(key);
        expect(prior ?? raw).toBe(raw);
        seen.set(key, raw);
      }
    }
  });

  it("üç platformun ortak kanonik adları gerçekten ortaktır", () => {
    expect(canonicalName("instagram", "views")).toBe("views");
    expect(canonicalName("tiktok", "view_count")).toBe("views");
    expect(canonicalName("youtube", "views")).toBe("views");
  });

  it("toplanabilir anahtarların hepsi kanoniktir", () => {
    for (const key of ADDITIVE_METRIC_KEYS) {
      expect(isCanonicalMetricName(key)).toBe(true);
    }
  });

  it("toplanabilir küme, ortalama/oran adlarını İÇERMEZ", () => {
    for (const key of ["avg_watch_time_sec", "watch_time_min", "skip_rate", "watch_ratio"]) {
      expect(ADDITIVE_METRIC_KEYS).not.toContain(key);
    }
  });
});