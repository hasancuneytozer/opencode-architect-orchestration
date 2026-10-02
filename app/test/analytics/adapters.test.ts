/**
 * Üç analitik adaptörü — HİÇBİR TEST AĞA ÇIKMAZ.
 *
 * `fetch` daima enjekte edilmiş sahte bir taşıma ile değiştirilir. Sahte taşıma
 * gerçek `Response` nesneleri üretir; böylece istemcinin ayrıştırma, başlık
 * toplama ve `Retry-After` yolu da testte çalışır.
 *
 * Dört kanıt sütunu:
 *   1) SÖZLEŞME — çıktı dizisi girişle AYNI uzunlukta ve sıra korunmuş.
 *   2) İZİN — eksik kapsam `no_scope` yazar, mesaj HANGİ izni gerektiğini
 *      söyler ve AĞ ÇAĞRISI YAPILMAZ (IG'de yayın izni yetmez).
 *   3) SAĞLAYICI AYRIMI — TikTok `not_public`, destek kanıtı `log_id`.
 *   4) DOKÜMAN LİMİTLERİ — TikTok parti sınırı, IG metrik listesi.
 */
import { describe, expect, it } from "vitest";
import {
  INSTAGRAM_INSIGHT_METRICS,
  InstagramAnalyticsAdapter,
  insightsHasNoData,
  readInsightsMetrics,
} from "../../src/analytics/adapters/instagram.js";
import {
  TIKTOK_VIDEO_FIELDS,
  TIKTOK_VIDEO_QUERY_BATCH,
  TiktokAnalyticsAdapter,
  buildVideoQueryBody,
  chunk,
  readVideoMetrics,
} from "../../src/analytics/adapters/tiktok.js";
import {
  VIEWS_COUNTING_CHANGE_DATE,
  YOUTUBE_ANALYTICS_METRICS,
  YoutubeAnalyticsAdapter,
  buildReportQuery,
  periodCrossesViewsChange,
  readReportMetrics,
  reportHasError,
} from "../../src/analytics/adapters/youtube.js";
import {
  classifyBody,
  parseMetaLogId,
  providerMessageOf,
  tiktokErrorCode,
  tiktokLogId,
} from "../../src/analytics/adapters/shared.js";
import { INSTAGRAM_INSIGHT_SCOPES, REQUIRED_ANALYTICS_SCOPES, TIKTOK_LIST_SCOPE, YOUTUBE_ANALYTICS_SCOPES, missingScopes } from "../../src/analytics/scopes.js";
import type { MetricQueryItem } from "../../src/analytics/types.js";

// ── Sabit zaman ve sahte taşıma ──────────────────────────────────────────────

/** 2026-10-01T20:00:00Z → Europe/Istanbul'da 2026-10-01 yerel günü. */
const NOW_ISO = "2026-10-01T20:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const now = (): number => NOW_MS;

interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  raw?: string;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function fakeTransport(responses: FakeResponse[]): { fn: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    const rawBody = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof rawBody === "string" ? rawBody : null,
    });
    const headers = new Headers(spec.headers ?? {});
    const body = spec.raw !== undefined ? spec.raw : spec.body === undefined ? "" : JSON.stringify(spec.body);
    return new Response(body, { status: spec.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** Yanıtta o id dönmezse `not_public` yazılacak. */
function igItem(remoteId: string, over: Partial<MetricQueryItem> = {}): MetricQueryItem {
  return {
    remoteId,
    accessToken: "tok-ig",
    scopes: [...INSTAGRAM_INSIGHT_SCOPES],
    ...over,
  };
}

function ttItem(remoteId: string, over: Partial<MetricQueryItem> = {}): MetricQueryItem {
  return { remoteId, accessToken: "tok-tt", scopes: [TIKTOK_LIST_SCOPE], ...over };
}

function ytItem(remoteId: string, over: Partial<MetricQueryItem> = {}): MetricQueryItem {
  return { remoteId, accessToken: "tok-yt", scopes: [...YOUTUBE_ANALYTICS_SCOPES], ...over };
}

/** IG insights gövdesi. */
function insightsBody(pairs: Record<string, number | null>) {
  return {
    data: Object.entries(pairs).map(([name, value]) => ({ name, values: [{ value }] })),
  };
}

/** YouTube rapor gövdesi: sütun adları + tek satır. */
function reportBody(columns: readonly string[], row: readonly string[]) {
  return { columnHeaders: columns.map((name) => ({ name })), rows: [row] };
}

// ── Sözleşme: çıktı girişle aynı uzunlukta, sıra korunmuş ────────────────────

describe("fetchMetrics sözleşmesi — uzunluk ve sıra", () => {
  it("Instagram: çıktı girişle aynı uzunlukta ve sıra korunmuş", async () => {
    const { fn } = fakeTransport([
      { body: insightsBody({ reach: 10 }) },
      { body: insightsBody({ reach: 20 }) },
      { body: insightsBody({ reach: 30 }) },
    ]);
    const a = new InstagramAnalyticsAdapter({ now, fetch: fn });
    const items = [igItem("m1"), igItem("m2"), igItem("m3")];
    const out = await a.fetchMetrics(items);
    expect(out).toHaveLength(items.length);
    expect(out.map((r) => r.remoteId)).toEqual(["m1", "m2", "m3"]);
    expect(out.map((r) => r.metrics["reach"])).toEqual([10, 20, 30]);
  });

  it("YouTube: çıktı girişle aynı uzunlukta ve sıra korunmuş", async () => {
    const { fn } = fakeTransport([
      { body: reportBody(["views"], ["11"]) },
      { body: reportBody(["views"], ["22"]) },
    ]);
    const a = new YoutubeAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([ytItem("v1"), ytItem("v2")]);
    expect(out.map((r) => r.remoteId)).toEqual(["v1", "v2"]);
    expect(out.map((r) => r.metrics["views"])).toEqual([11, 22]);
  });

  it("TikTok: karışık sonuçlarda sıra korunur (bulunan/bulunmayan)", async () => {
    const { fn } = fakeTransport([
      {
        body: {
          data: {
            videos: [
              { id: "b", view_count: 2 },
              { id: "a", view_count: 1 },
            ],
          },
        },
      },
    ]);
    const a = new TiktokAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([ttItem("a"), ttItem("yok"), ttItem("b")]);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.remoteId)).toEqual(["a", "yok", "b"]);
    expect(out[0]?.metrics["view_count"]).toBe(1);
    expect(out[1]?.unavailable?.reason).toBe("not_public");
    expect(out[2]?.metrics["view_count"]).toBe(2);
  });

  it("boş girdi boş çıktı verir (istisna değil)", async () => {
    const { fn, calls } = fakeTransport([{ body: {} }]);
    const ig = new InstagramAnalyticsAdapter({ now, fetch: fn });
    const yt = new YoutubeAnalyticsAdapter({ now, fetch: fn });
    const tt = new TiktokAnalyticsAdapter({ now, fetch: fn });
    expect(await ig.fetchMetrics([])).toEqual([]);
    expect(await yt.fetchMetrics([])).toEqual([]);
    expect(await tt.fetchMetrics([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ── Kapsam / izin ────────────────────────────────────────────────────────────

describe("eksik kapsam — `no_scope` ve AĞ ÇAĞRISI YAPILMAZ", () => {
  it("Instagram: yayın izni tek başına ÖLÇÜM İZNİ DEĞİLDİR", async () => {
    const { fn, calls } = fakeTransport([{ body: { data: [] } }]);
    const a = new InstagramAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([
      igItem("m1", { scopes: ["instagram_content_publish", "instagram_basic"] }),
    ]);
    expect(out[0]?.unavailable?.reason).toBe("no_scope");
    // Mesaj HANGİ iznin gerektiğini söyler.
    expect(out[0]?.unavailable?.message).toContain("instagram_manage_insights");
    expect(out[0]?.unavailable?.message).toMatch(/yeniden yetkilendirme/);
    expect(calls).toHaveLength(0);
    expect(a.callCount()).toBe(0);
  });

  it("Instagram: eksik izin listesi tam olarak farkı gösterir", () => {
    expect(missingScopes("instagram", ["instagram_basic"])).toEqual([
      "instagram_manage_insights",
      "pages_read_engagement",
    ]);
    expect(missingScopes("instagram", [...INSTAGRAM_INSIGHT_SCOPES])).toEqual([]);
    expect(REQUIRED_ANALYTICS_SCOPES.instagram).toBe(INSTAGRAM_INSIGHT_SCOPES);
  });

  it("Instagram: belirteç yoksa da `no_scope` yazar (401 beklemeden)", async () => {
    const { fn, calls } = fakeTransport([{ body: {} }]);
    const a = new InstagramAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([{ remoteId: "m1", scopes: [...INSTAGRAM_INSIGHT_SCOPES] }]);
    expect(out[0]?.unavailable?.reason).toBe("no_scope");
    expect(calls).toHaveLength(0);
  });

  it("TikTok: `video.list` eksikse `no_scope`, ağ çağrısı yok", async () => {
    const { fn, calls } = fakeTransport([{ body: {} }]);
    const a = new TiktokAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([ttItem("v1", { scopes: [] })]);
    expect(out[0]?.unavailable?.reason).toBe("no_scope");
    expect(out[0]?.unavailable?.message).toContain(TIKTOK_LIST_SCOPE);
    expect(calls).toHaveLength(0);
  });

  it("TikTok: karışık grupta yalnız izinli öğeler ağa gider", async () => {
    const { fn, calls } = fakeTransport([{ body: { data: { videos: [{ id: "ok", view_count: 7 }] } } }]);
    const a = new TiktokAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([ttItem("yok", { scopes: [] }), ttItem("ok")]);
    expect(calls).toHaveLength(1);
    expect(out[0]?.unavailable?.reason).toBe("no_scope");
    expect(out[1]?.metrics["view_count"]).toBe(7);
  });

  it("YouTube: eksik kapsamda `no_scope` ve hangi izin gerektiği yazılır", async () => {
    const { fn, calls } = fakeTransport([{ body: {} }]);
    const a = new YoutubeAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([ytItem("v1", { scopes: ["https://www.googleapis.com/auth/youtube.upload"] })]);
    expect(out[0]?.unavailable?.reason).toBe("no_scope");
    expect(out[0]?.unavailable?.message).toContain("yt-analytics.readonly");
    expect(calls).toHaveLength(0);
  });
});

// ── 403 / hata gövdesi sınıflandırması ───────────────────────────────────────

describe("sağlayıcı hatası — durum önce gelir", () => {
  it("Instagram 403 → `no_scope` + `fbtrace_id` logId olarak taşınır", async () => {
    const { fn } = fakeTransport([
      { status: 403, body: { error: { message: "izin yok", code: 10, fbtrace_id: "trace-9" } } },
    ]);
    const a = new InstagramAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([igItem("m1")]);
    expect(out[0]?.unavailable?.reason).toBe("no_scope");
    expect(out[0]?.logId).toBe("trace-9");
    expect(out[0]?.unavailable?.logId).toBe("trace-9");
  });

  it("Instagram 410 → `deleted` (404 ile karıştırılmaz)", async () => {
    const { fn } = fakeTransport([{ status: 410, body: { error: { message: "silinmiş" } } }]);
    const a = new InstagramAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([igItem("m1")]);
    expect(out[0]?.unavailable?.reason).toBe("deleted");
  });

  it("Instagram 404 → `not_found`", async () => {
    const { fn } = fakeTransport([{ status: 404, body: { error: { message: "bulunamadı" } } }]);
    const a = new InstagramAnalyticsAdapter({ now, fetch: fn });
    expect((await a.fetchMetrics([igItem("m1")]))[0]?.unavailable?.reason).toBe("not_found");
  });

  it("Instagram 429 → geçici `provider_error`, bekleme süresi mesajda", async () => {
    const { fn } = fakeTransport([{ status: 429, headers: { "retry-after": "30" }, body: {} }]);
    const a = new InstagramAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([igItem("m1")]);
    expect(out[0]?.unavailable?.reason).toBe("provider_error");
    expect(out[0]?.unavailable?.message).toMatch(/30 sn/);
  });

  it("Instagram 5xx → geçici `provider_error`", async () => {
    const { fn } = fakeTransport([{ status: 503, body: {} }]);
    const a = new InstagramAnalyticsAdapter({ now, fetch: fn });
    expect((await a.fetchMetrics([igItem("m1")]))[0]?.unavailable?.reason).toBe("provider_error");
  });

  it("YouTube 403 `insufficientPermissions` → `no_scope` (rapor hiç gelmez)", async () => {
    const { fn } = fakeTransport([
      { status: 403, body: { error: { errors: [{ reason: "insufficientPermissions" }] } } },
    ]);
    const a = new YoutubeAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([ytItem("v1")]);
    expect(out[0]?.unavailable?.reason).toBe("no_scope");
    // Eski beklenti "tanınmıyor" idi; `insufficientPermissions` tabloya girince
    // mesaj "bilinmeyen hata" değil **gereken kapsamı adıyla** söylüyor.
    // Kullanıcıya hangi kapsamı vermesi gerektiğini söylemek, "tanınmıyor"
    // demekten çok daha işe yarar.
    expect(out[0]?.unavailable?.message).toMatch(/yt-analytics\.readonly/);
  });

  it("taşıma hatası FIRSATLATMAZ, `provider_error` yazar", async () => {
    const boom = (async () => {
      throw new Error("ağ yok");
    }) as unknown as typeof fetch;
    const ig = new InstagramAnalyticsAdapter({ now, fetch: boom });
    const yt = new YoutubeAnalyticsAdapter({ now, fetch: boom });
    const tt = new TiktokAnalyticsAdapter({ now, fetch: boom });
    for (const out of [
      await ig.fetchMetrics([igItem("m1")]),
      await yt.fetchMetrics([ytItem("v1")]),
      await tt.fetchMetrics([ttItem("v1")]),
    ]) {
      expect(out[0]?.unavailable?.reason).toBe("provider_error");
      expect(out[0]?.metrics).toEqual({});
    }
  });
});

// ── TikTok `not_public` ayrımı ───────────────────────────────────────────────

describe("TikTok — `not_public` ayrımı", () => {
  it("yanıt 200 ama video dönmediyse `not_public` YAZILIR (0 değil)", async () => {
    const { fn } = fakeTransport([{ body: { data: { videos: [] } } }]);
    const a = new TiktokAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([ttItem("v1")]);
    expect(out[0]?.unavailable?.reason).toBe("not_public");
    expect(out[0]?.metrics).toEqual({});
    expect(out[0]?.metrics["view_count"]).toBeUndefined();
  });

  it("mesaj `publicaly_available_post_id` kuralını ve gecikmeyi açıklar", async () => {
    const { fn } = fakeTransport([{ body: { data: { videos: [] } } }]);
    const a = new TiktokAnalyticsAdapter({ now, fetch: fn });
    const message = (await a.fetchMetrics([ttItem("v1")]))[0]?.unavailable?.message ?? "";
    expect(message).toContain("publicaly_available_post_id");
    expect(message).toContain("SELF_ONLY");
    expect(message).toMatch(/gecikmeli/);
  });

  it("`not_public` `no_scope` DEĞİLDİR: ikisi ayrı sebeptir", async () => {
    const { fn } = fakeTransport([{ body: { data: { videos: [] } } }]);
    const a = new TiktokAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([ttItem("v1")]);
    expect(out[0]?.unavailable?.reason).not.toBe("no_scope");
    expect(out[0]?.unavailable?.reason).not.toBe("not_found");
  });

  it("bulunan video `unavailable: null` yazar", async () => {
    const { fn } = fakeTransport([{ body: { data: { videos: [{ id: "v1", view_count: 3 }] } } }]);
    const a = new TiktokAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([ttItem("v1")]);
    expect(out[0]?.unavailable).toBeNull();
    expect(out[0]?.metrics["view_count"]).toBe(3);
  });
});

// ── `logId` taşınması ────────────────────────────────────────────────────────

describe("logId taşınması", () => {
  it("TikTok: gövdedeki `log_id` hem üst düzeme hem zarfın içine yazılır", async () => {
    const { fn } = fakeTransport([
      { body: { data: { videos: [{ id: "v1", view_count: 1 }] }, log_id: "log-tt-1" } },
    ]);
    const a = new TiktokAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([ttItem("v1")]);
    expect(out[0]?.logId).toBe("log-tt-1");
  });

  it("TikTok: hata gövdesinde `error.log_id` bulunur (kök değil)", async () => {
    const { fn } = fakeTransport([
      { status: 400, body: { error: { code: 10003, message: "hata", log_id: "log-tt-err" } } },
    ]);
    const a = new TiktokAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics([ttItem("v1")]);
    expect(out[0]?.logId).toBe("log-tt-err");
    expect(out[0]?.unavailable?.logId).toBe("log-tt-err");
  });

  it("Instagram: `fbtrace_id` yoksa `error_log_id` okunur", () => {
    expect(parseMetaLogId({ error: { error_log_id: "L2" } })).toBe("L2");
    expect(parseMetaLogId({ error: { fbtrace_id: "F1", error_log_id: "L2" } })).toBe("F1");
    expect(parseMetaLogId({})).toBeNull();
    expect(parseMetaLogId(null)).toBeNull();
  });

  it("logId yoksa null yazılır (uydurulmaz)", async () => {
    const { fn } = fakeTransport([{ body: { data: { videos: [{ id: "v1" }] } } }]);
    const a = new TiktokAnalyticsAdapter({ now, fetch: fn });
    expect((await a.fetchMetrics([ttItem("v1")]))[0]?.logId).toBeNull();
  });
});

// ── Doküman limitleri ────────────────────────────────────────────────────────

describe("TikTok 20'lik parti sınırı", () => {
  it("25 kimlik 2 partiye bölünür, her partide en fazla 20 var", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `v${i}`);
    const { fn, calls } = fakeTransport([{ body: { data: { videos: [] } } }]);
    const a = new TiktokAnalyticsAdapter({ now, fetch: fn });
    const out = await a.fetchMetrics(ids.map((id) => ttItem(id)));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const body = JSON.parse(call.body ?? "{}") as { filters: { video_ids: string[] } };
      expect(body.filters.video_ids.length).toBeLessThanOrEqual(TIKTOK_VIDEO_QUERY_BATCH);
    }
    expect(out).toHaveLength(25);
  });

  it("tam 20'lik tek partiye sığar", () => {
    expect(chunk(Array.from({ length: 20 }, (_, i) => i), TIKTOK_VIDEO_QUERY_BATCH)).toHaveLength(1);
    expect(chunk(Array.from({ length: 21 }, (_, i) => i), TIKTOK_VIDEO_QUERY_BATCH)).toHaveLength(2);
    expect(TIKTOK_VIDEO_QUERY_BATCH).toBe(20);
  });

  it("chunk boş girdide boş dizi döner", () => {
    expect(chunk([], TIKTOK_VIDEO_QUERY_BATCH)).toEqual([]);
  });

  it("gövde `fields` listesini taşır (yalnız dokümanda listelenenler)", () => {
    const body = buildVideoQueryBody(["a", "b"]);
    expect(body["fields"]).toEqual([...TIKTOK_VIDEO_FIELDS]);
    expect(TIKTOK_VIDEO_FIELDS).toContain("view_count");
    expect(TIKTOK_VIDEO_FIELDS).not.toContain("download_count");
  });
});

describe("Instagram istenen metrik listesi", () => {
  it("kaldırılmış `plays` ve `impressions` İSTENMEZ", () => {
    expect(INSTAGRAM_INSIGHT_METRICS).not.toContain("plays");
    expect(INSTAGRAM_INSIGHT_METRICS).not.toContain("impressions");
  });

  it("9:16 reklam için anlamlı olanlar istenir", () => {
    for (const m of ["reach", "views", "saved", "shares", "ig_reels_avg_watch_time", "reels_skip_rate"]) {
      expect(INSTAGRAM_INSIGHT_METRICS).toContain(m);
    }
  });

  it("12 metrik TEK çağrıda istenir (metrik başına çağrı yok)", async () => {
    const { fn, calls } = fakeTransport([{ body: { data: [] } }]);
    const a = new InstagramAnalyticsAdapter({ now, fetch: fn });
    await a.fetchMetrics([igItem("m1"), igItem("m2"), igItem("m3")]);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toContain("metric=");
    expect(calls[0]?.url).toContain("ig_reels_avg_watch_time");
  });

  it("YouTube `dislikes` ve `shares` istenmez", () => {
    expect(YOUTUBE_ANALYTICS_METRICS).not.toContain("dislikes");
    expect(YOUTUBE_ANALYTICS_METRICS).not.toContain("shares");
    expect(YOUTUBE_ANALYTICS_METRICS).toContain("estimatedMinutesWatched");
  });

  it("belirteç URL'de DEĞİL, `Authorization` başlığındadır", async () => {
    const { fn, calls } = fakeTransport([{ body: insightsBody({ reach: 1 }) }]);
    const a = new InstagramAnalyticsAdapter({ now, fetch: fn });
    await a.fetchMetrics([igItem("m1")]);
    expect(calls[0]?.url).not.toContain("access_token");
    expect(calls[0]?.url).not.toContain("tok-ig");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer tok-ig");
  });
});

// ── Gövde ayrıştırıcıları ────────────────────────────────────────────────────

describe("readInsightsMetrics", () => {
  it("çoklu `values` girdisinde EN SON alınır", () => {
    const out = readInsightsMetrics({ data: [{ name: "views", values: [{ value: 1 }, { value: 2 }] }] });
    expect(out["views"]).toBe(2);
  });

  it("`value` yoksa null yazılır, 0 DEĞİL", () => {
    const out = readInsightsMetrics({ data: [{ name: "views", values: [{}] }] });
    expect(out["views"]).toBeNull();
  });

  it("insightsHasNoData: boş küme 'veri henüz yok'tur, hata değil", () => {
    expect(insightsHasNoData({ data: [] })).toBe(true);
    expect(insightsHasNoData({})).toBe(true);
    expect(insightsHasNoData({ data: [{ name: "views", values: [{ value: 1 }] }] })).toBe(false);
  });

  it("bozuk/olmayan gövde boş ölçüm döner, istisna fırlatmaz", () => {
    expect(readInsightsMetrics(null)).toEqual({});
    expect(readInsightsMetrics("çöp")).toEqual({});
  });
});

describe("readReportMetrics", () => {
  it("sütun adı → değer eşlemesi kurar (pozisyona güvenilmez)", () => {
    const out = readReportMetrics(reportBody(["likes", "views"], ["5", "100"]));
    expect(out).toEqual({ likes: 5, views: 100 });
  });

  it("boş hücre `null`dur (0 değil)", () => {
    const out = readReportMetrics(reportBody(["views", "likes"], ["100", ""]));
    expect(out["likes"]).toBeNull();
  });

  it("satır yoksa boş sözlük döner (rapor yok = henüz veri yok)", () => {
    expect(readReportMetrics({ columnHeaders: [{ name: "views" }], rows: [] })).toEqual({});
    expect(readReportMetrics({})).toEqual({});
  });

  it("sayı metni kabul edilir (Google bazı yanıtlarda metin gönderir)", () => {
    expect(readReportMetrics(reportBody(["averageViewPercentage"], ["55.5"]))["averageViewPercentage"]).toBeCloseTo(55.5, 10);
  });

  it("reportHasError hata nesnesini görür", () => {
    expect(reportHasError({ error: { code: 403 } })).toBe(true);
    expect(reportHasError({ errors: [] })).toBe(true);
    expect(reportHasError({ rows: [] })).toBe(false);
  });
});

describe("readVideoMetrics", () => {
  it("yalnız dönen videoları içerir; DOĞRULANMAMIŞ alanlar yutulur", () => {
    // `download_count` TikTok'un belgelenmiş alan listesinde YOK. İstenmediği
    // gibi okunmaması da doğru: okunsaydı kanonik karşılığı olmayan bir sayı
    // panele sızar ve "neden bu metrik var" sorusu doğmaz. Bu yüzden test
    // "okunur" değil **"yutulur"** diyor.
    const out = readVideoMetrics({
      data: { videos: [{ id: "v1", view_count: 4, like_count: 1, download_count: 2 }] },
    });
    expect(Object.keys(out)).toEqual(["v1"]);
    expect(out["v1"]).toEqual({ view_count: 4, like_count: 1 });
    expect(out["v1"]).not.toHaveProperty("download_count");
  });

  it("alan geldi ama boşsa null (0 değil)", () => {
    const out = readVideoMetrics({ data: { videos: [{ id: "v1", view_count: null }] } });
    expect(out["v1"]?.["view_count"]).toBeNull();
  });

  it("`videos` dizisi yoksa boş sözlük", () => {
    expect(readVideoMetrics({ data: {} })).toEqual({});
    expect(readVideoMetrics(null)).toEqual({});
  });
});

// ── YouTube tarih kırılması ─────────────────────────────────────────────────

describe("YouTube view sayımı değişikliği", () => {
  it("kırılma tarihi tek kaynaktır", () => {
    expect(VIEWS_COUNTING_CHANGE_DATE).toBe("2026-08-27");
  });

  it("dönem kırılmayı İÇERİYORSA uyarı verir", () => {
    expect(periodCrossesViewsChange("2026-08-01", "2026-09-01")).toBe(true);
    expect(periodCrossesViewsChange("2026-08-27", "2026-08-27")).toBe(true);
  });

  it("dönem tamamen sonraysa uyarı vermez", () => {
    expect(periodCrossesViewsChange("2026-09-01", "2026-09-07")).toBe(false);
    expect(periodCrossesViewsChange("2026-08-01", "2026-08-20")).toBe(false);
  });
});

describe("buildReportQuery", () => {
  it("dimensions=video + filters=video==ID üretir", () => {
    const q = new URLSearchParams(
      buildReportQuery({ videoId: "abc", metrics: ["views"], startDate: "2026-09-01", endDate: "2026-09-07" }),
    );
    expect(q.get("dimensions")).toBe("video");
    expect(q.get("filters")).toBe("video==abc");
    expect(q.get("metrics")).toBe("views");
    expect(q.get("ids")).toBe("channel==MINE");
  });

  it("rapor adresi `now` ile gün hesabı yapar", () => {
    const a = new YoutubeAnalyticsAdapter({
      now,
      fetch: fakeTransport([{ body: reportBody(["views"], ["1"]) }]).fn,
    });
    expect(a.reportUrl("v1")).toContain("endDate=2026-10-01");
  });
});

// ── Gövde yardımcıları ───────────────────────────────────────────────────────

describe("shared gövde yardımcıları", () => {
  it("providerMessageOf Meta ve Google biçimlerini okur", () => {
    expect(providerMessageOf({ error: { message: "m1" } })).toBe("m1");
    expect(providerMessageOf({ errors: [{ message: "m2" }] })).toBe("m2");
    expect(providerMessageOf({ message: "m3" })).toBe("m3");
    expect(providerMessageOf({})).toBeNull();
  });

  it("tiktokLogId kökte ya da `error` içinde arar", () => {
    expect(tiktokLogId({ log_id: "A" })).toBe("A");
    expect(tiktokLogId({ error: { log_id: "B" } })).toBe("B");
    expect(tiktokLogId({ error: { log_id: "B" }, log_id: "A" })).toBe("B");
    expect(tiktokLogId(null)).toBeNull();
  });

  it("tiktokErrorCode sayıyı metne çevirir", () => {
    expect(tiktokErrorCode({ error: { code: 10003 } })).toBe("10003");
    expect(tiktokErrorCode({ code: "X" })).toBe("X");
    expect(tiktokErrorCode({})).toBeNull();
  });

  it("classifyBody TikTok için null döner (uydurma kod tablosu yok)", () => {
    expect(classifyBody("tiktok", { error: { code: 10003 } })).toBeNull();
    expect(classifyBody("instagram", { error: { code: 9, error_subcode: 2207042 } })).not.toBeNull();
    expect(classifyBody("youtube", { errors: [{ reason: "forbidden" }] })).not.toBeNull();
  });
});