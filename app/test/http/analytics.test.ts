/**
 * ANALİTİK HTTP UÇLARI.
 *
 * Kapsam: zarf, oturum zorunluluğu, tarih/platform doğrulaması, `collect`
 * yetkilendirmesi (oturum **veya** `X-Api-Key`) ve "ölçülemeyen" bilgisinin
 * kaybolmaması.
 *
 * Sunucu `inject()` ile çağrılır — PORT AÇILMAZ.
 *
 * ── SAHTE SERVİS NEDEN GERÇEK `AnalyticsService` DEĞİL ──────────────────────
 * Uçların sorumluluğu "depoyu okumak" değil, **panelin ihtiyaç duyduğu alanları
 * zarf içinde doğru kurmaktır**. `collect` gerçekten ağa çıkmasın diye sahte
 * bir servis geçilir; toplama (`rollup`) mantığı ise SAHTE DEĞİLDİR: gerçek
 * `rollup()`/`comparePeriods()` saf fonksiyonları kullanılır. Böylece "0 mı,
 * `null` mu" ayrımı ve "ölçülemeyen" sayaçları üretimdekiyle AYNI yoldan geçer.
 *
 * `createHarness` veri katmanını (veritabanı + migration + depolar + saat +
 * medya deposu) kurar; analitik bağımlılığı O kurulumun parçası olmadığı için
 * ikinci bir `buildServer` çağrısıyla bağlanır. Aynı veritabanı, iki sunucu:
 * port açılmadığı için çakışma olmaz.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { rollup } from "../../src/analytics/index.js";
import type {
  CollectOptions,
  CollectOutcome,
  GetForContentOptions,
  MetricUnavailableReason,
  RollupResult,
} from "../../src/analytics/index.js";
import type { Platform } from "../../src/contract/index.js";
import type { ContentMetricRecord, MetricListFilter } from "../../src/db/index.js";
import { buildServer, type HttpMediaStore } from "../../src/http/index.js";
// `AnalyticsReader` yalnız `server.ts`'te tanımlı; `http/index.ts` bir İÇE
// AKTARIM yüzeyi ve bu paket onu yeniden dışa aktarmıyor (o dosya korumalı).
// Tip olduğu için çalışma zamanına hiçbir şey girmez.
import type { AnalyticsReader } from "../../src/http/server.js";
import {
  createHarness,
  dataOf,
  errorOf,
  type Harness,
} from "./helpers.js";

const PAROLA = "test-parola-1234";

// ── Sahte veri ──────────────────────────────────────────────────────────────

let rowSeq = 0;

interface RowOver {
  jobId: string;
  metricDate: string;
  platform: Platform;
  contentId?: string;
  metrics?: Record<string, number | null>;
  unavailable?: MetricUnavailableReason | null;
}

/** Depo kaydı üretir. Varsayılanlar: ölçülmüş, tek platformlu satır. */
function row(over: RowOver): ContentMetricRecord {
  rowSeq += 1;
  const unavailable =
    over.unavailable === undefined || over.unavailable === null
      ? null
      : { reason: over.unavailable, message: `${over.unavailable} gerekçesi`, logId: null };
  return {
    id: `metric-${rowSeq}`,
    jobId: over.jobId,
    contentId: over.contentId ?? "content-1",
    platform: over.platform,
    remoteId: `remote-${over.jobId}`,
    metricDate: over.metricDate,
    metrics: over.metrics ?? { views: 100, interactions: 10, saves: 4, shares: 2 },
    unknown: [],
    deprecated: [],
    unavailable,
    logId: null,
    fetchedAt: `${over.metricDate}T09:00:00.000Z`,
    createdAt: `${over.metricDate}T09:00:00.000Z`,
    updatedAt: `${over.metricDate}T09:00:00.000Z`,
  };
}

/** `AnalyticsReader` sahte uygulaması: gerçek toplama, kontrollü satırlar. */
class FakeAnalytics implements AnalyticsReader {
  readonly collectCalls: Array<CollectOptions> = [];

  constructor(private rows: ContentMetricRecord[] = []) {}

  set(rows: ContentMetricRecord[]): void {
    this.rows = rows;
  }

  /** Test kurulumu: sahte satırların hepsini görünür kılar. */
  allRows(): ContentMetricRecord[] {
    return this.rows;
  }

  listForContent(contentId: string, filter: MetricListFilter = {}): ContentMetricRecord[] {
    return this.rows
      .filter((r) => r.contentId === contentId)
      .filter((r) => filter.from === undefined || r.metricDate >= filter.from)
      .filter((r) => filter.to === undefined || r.metricDate <= filter.to)
      .filter((r) => filter.platform === undefined || r.platform === filter.platform)
      .sort((a, b) => a.metricDate.localeCompare(b.metricDate));
  }

  getForContent(contentId: string, options: GetForContentOptions = {}): RollupResult {
    return rollup(this.listForContent(contentId, options), {
      scope: "content",
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
      ...(options.delayDays === undefined ? {} : { delayDays: options.delayDays }),
    });
  }

  getForPlatform(
    platform: Platform,
    from: string,
    to: string,
    delayDays?: number,
  ): RollupResult {
    const rows = this.rows.filter((r) => r.platform === platform && r.metricDate >= from && r.metricDate <= to);
    return rollup(rows, {
      scope: "platform",
      from,
      to,
      ...(delayDays === undefined ? {} : { delayDays }),
    });
  }

  previousWindow(from: string, to: string): { from: string; to: string } {
    const days = Math.floor(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
    ) + 1;
    const prevTo = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const prevFrom = new Date(Date.parse(`${prevTo}T00:00:00Z`) - (days - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return { from: prevFrom, to: prevTo };
  }

  async collect(options: CollectOptions = {}): Promise<CollectOutcome> {
    this.collectCalls.push(options);
    const outcome: CollectOutcome = {
      fetched: 0,
      written: 0,
      skipped: [],
      byPlatform: {},
      metricDate: "2026-09-30",
      records: [],
    };
    for (const record of this.rows.slice(0, options.limit ?? 100)) {
      outcome.records.push(record);
      outcome.written += 1;
      outcome.fetched += 1;
    }
    if (options.adapters?.tiktok === undefined) {
      outcome.skipped.push({
        jobId: "job-tiktok-1",
        reason: "tiktok: analitik adaptörü yapılandırılmamış; ölçüm toplanmadı.",
      });
    }
    return outcome;
  }
}

// ── Kurulum ────────────────────────────────────────────────────────────────

interface FixtureOptions {
  rows?: ContentMetricRecord[];
  /** `undefined` → analitik hiç bağlanmamış (`null`). */
  analytics?: FakeAnalytics | null;
  analyticsPlatforms?: Platform[];
  adminPassword?: string | null;
}

interface Fixture {
  harness: Harness;
  server: FastifyInstance;
  analytics: FakeAnalytics | null;
  cookie: string;
  close(): Promise<void>;
}

let f: Fixture;

async function setup(opts: FixtureOptions = {}): Promise<Fixture> {
  const harness = await createHarness({ adminPassword: opts.adminPassword ?? PAROLA });
  const analytics =
    opts.analytics === undefined ? new FakeAnalytics(opts.rows ?? []) : opts.analytics;
  const built = await buildServer({
    config: harness.config,
    db: harness.db,
    repos: harness.repos,
    store: harness.store as HttpMediaStore,
    probe: harness.ffmpeg,
    ingest: harness.ingest,
    publisher: harness.publisher,
    scheduler: harness.scheduler,
    clock: harness.clock,
    mediaSecret: harness.mediaSecret,
    liveAdapters: new Set<Platform>(),
    analytics,
    analyticsPlatforms: new Set<Platform>(opts.analyticsPlatforms ?? []),
  });
  return {
    harness,
    server: built.server,
    analytics,
    cookie: "",
    async close() {
      try {
        await built.server.close();
      } catch {
        /* zaten kapalı */
      }
      await harness.close();
    },
  };
}

/** Oturum açar ve `Cookie` başlığını döndürür. */
async function login(): Promise<string> {
  const res = await f.server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: "http://localhost", host: "localhost" },
    payload: { password: PAROLA },
  });
  if (res.statusCode !== 200) throw new Error(`giriş başarısız: ${res.payload}`);
  const raw = Array.isArray(res.headers["set-cookie"])
    ? res.headers["set-cookie"].join(";")
    : String(res.headers["set-cookie"] ?? "");
  return raw.split(";")[0] ?? "";
}

function authHeaders(cookie?: string): Record<string, string> {
  const c = cookie ?? f.cookie;
  return { origin: "http://localhost", host: "localhost", ...(c ? { cookie: c } : {}) };
}

/**
 * Gerçek bir içerik kaydı açar ve kimliğini döndürür.
 *
 * Sahte satırların `contentId` alanı BÖYLE ayarlanır: içerik detayı ucu
 * önce `contents` tablosundan içeriği arar, olmayan bir kimlik 404 döner.
 */
function seedContent(name: string): string {
  const repos = f.harness.repos;
  const project = repos.projects.ensure("test-projesi", null);
  const asset = repos.assets.create({
    storageKey: `seed/${name}`,
    originalName: name,
    bytes: 10,
    mimeType: "video/mp4",
    info: { width: 1080, height: 1920, durationSec: 4, fps: 30 } as never,
  });
  const content = repos.contents.create({ projectId: project.id, assetId: asset.id });
  for (const record of f.analytics?.allRows() ?? []) {
    if (record.contentId === "content-1") record.contentId = content.id;
  }
  return content.id;
}

async function get(path: string, cookie?: string): Promise<{ status: number; raw: string }> {
  const res = await f.server.inject({ method: "GET", url: path, headers: authHeaders(cookie) });
  return { status: res.statusCode, raw: res.payload };
}

// ── Testler ───────────────────────────────────────────────────────────────

describe("analitik uçları", () => {
  beforeEach(async () => {
    f = await setup();
  });

  afterEach(async () => {
    await f.close();
  });

  describe("kimlik doğrulama", () => {
    it("overview oturum ister", async () => {
      const res = await get("/api/v1/analytics/overview", "sp_session=yok");
      expect(res.status).toBe(401);
      expect(errorOf(res.raw).code).toBe("unauthorized");
    });

    it("series ve coverage oturum ister", async () => {
      expect((await get("/api/v1/analytics/series", "sp_session=yok")).status).toBe(401);
      expect((await get("/api/v1/analytics/coverage", "sp_session=yok")).status).toBe(401);
    });

    it("analitik bağlanmamışsa overview 503 not_configured döner", async () => {
      await f.close();
      f = await setup({ analytics: null });
      f.cookie = await login();
      const res = await get("/api/v1/analytics/overview");
      expect(res.status).toBe(503);
      expect(errorOf(res.raw).code).toBe("not_configured");
    });
  });

  describe("GET /api/v1/analytics/overview", () => {
    it("zarfı ve varsayılan 30 günlük pencereyi döndürür", async () => {
      f.cookie = await login();
      const res = await get("/api/v1/analytics/overview");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.raw);
      expect(body.ok).toBe(true);

      const data = dataOf<{
        from: string;
        to: string;
        mode: string;
        platforms: Array<{ platform: Platform; totals: Record<string, number> }>;
      }>(res.raw);
      expect(data.platforms.map((p) => p.platform)).toEqual([
        "instagram",
        "tiktok",
        "youtube",
      ]);
      const days =
        (Date.parse(`${data.to}T00:00:00Z`) - Date.parse(`${data.from}T00:00:00Z`)) /
        86_400_000 +
        1;
      expect(days).toBe(30);
      expect(data.mode).toBe("mock");
    });

    it("platform filtresi tek kart döner", async () => {
      f.cookie = await login();
      const res = await get("/api/v1/analytics/overview?platform=tiktok");
      const data = dataOf<{ platforms: Array<{ platform: Platform }> }>(res.raw);
      expect(data.platforms).toHaveLength(1);
      expect(data.platforms[0]?.platform).toBe("tiktok");
    });

    it("geçersiz platform 400 validation_failed verir", async () => {
      f.cookie = await login();
      const res = await get("/api/v1/analytics/overview?platform=facebook");
      expect(res.status).toBe(400);
      expect(errorOf(res.raw).code).toBe("validation_failed");
    });

    it("geçersiz tarih 400 validation_failed verir", async () => {
      f.cookie = await login();
      for (const path of [
        "/api/v1/analytics/overview?from=2026-13-01",
        "/api/v1/analytics/overview?to=bugun",
        "/api/v1/analytics/coverage?from=2026-02-30",
      ]) {
        const res = await get(path);
        expect(res.status).toBe(400);
        expect(errorOf(res.raw).code).toBe("validation_failed");
      }
    });

    it("to < from 400 validation_failed verir", async () => {
      f.cookie = await login();
      const res = await get("/api/v1/analytics/overview?from=2026-09-10&to=2026-09-01");
      expect(res.status).toBe(400);
      expect(errorOf(res.raw).code).toBe("validation_failed");
    });

    it("gelecek tarih kabul edilir ve veri boş döner", async () => {
      f.cookie = await login();
      const res = await get("/api/v1/analytics/overview?from=2030-01-01&to=2030-01-05");
      expect(res.status).toBe(200);
      const data = dataOf<{
        platforms: Array<{ totals: Record<string, number>; measuredCount: number }>;
      }>(res.raw);
      for (const item of data.platforms) {
        expect(item.measuredCount).toBe(0);
        expect(item.totals["views"]).toBe(0);
      }
    });

    it("ölçülemeyen içerikleri sebebiyle birlikte sayar", async () => {
      await f.close();
      f = await setup({
        rows: [
          row({ jobId: "j1", metricDate: "2026-09-28", platform: "instagram" }),
          row({
            jobId: "j2",
            metricDate: "2026-09-28",
            platform: "instagram",
            metrics: {},
            unavailable: "not_public",
          }),
          row({
            jobId: "j3",
            metricDate: "2026-09-28",
            platform: "instagram",
            metrics: {},
            unavailable: "no_scope",
          }),
        ],
      });
      f.cookie = await login();
      const res = await get("/api/v1/analytics/overview?from=2026-09-28&to=2026-09-28");
      const data = dataOf<{
        platforms: Array<{
          platform: Platform;
          unavailableCount: number;
          unavailableReasons: Record<string, number>;
          measuredCount: number;
          available: { configured: boolean; reason: string | null };
        }>;
      }>(res.raw);
      const ig = data.platforms.find((p) => p.platform === "instagram");
      expect(ig?.unavailableCount).toBe(2);
      expect(ig?.unavailableReasons["not_public"]).toBe(1);
      expect(ig?.unavailableReasons["no_scope"]).toBe(1);
      expect(ig?.measuredCount).toBe(1);
      // Adaptör bağlı değilken kart dürüstçe "bağlı değil" der.
      expect(ig?.available.configured).toBe(false);
      expect(ig?.available.reason).toContain("bağlı değil");
    });

    it("adaptör bağlı platform mode=live olur", async () => {
      await f.close();
      f = await setup({ analyticsPlatforms: ["youtube"] });
      f.cookie = await login();
      const res = await get("/api/v1/analytics/overview");
      const data = dataOf<{ mode: string }>(res.raw);
      expect(data.mode).toBe("live");
    });

    it("veri gecikmesi günlerini eksik saymaz", async () => {
      await f.close();
      f = await setup({
        rows: [
          row({ jobId: "j1", metricDate: "2026-09-28", platform: "instagram" }),
          // 29 ve 30 Eylül: satır var ama hiç değer yok → 48 saat gecikmesi.
          row({ jobId: "j1", metricDate: "2026-09-29", platform: "instagram", metrics: {} }),
          row({ jobId: "j1", metricDate: "2026-09-30", platform: "instagram", metrics: {} }),
        ],
      });
      f.cookie = await login();
      const res = await get("/api/v1/analytics/overview?from=2026-09-28&to=2026-09-30");
      const data = dataOf<{
        platforms: Array<{
          platform: Platform;
          missingDataDays: number;
          noDataCount: number;
          completeness: { pendingDays: string[]; delayDays: number };
        }>;
      }>(res.raw);
      const ig = data.platforms.find((p) => p.platform === "instagram");
      expect(ig?.noDataCount).toBe(1);
      expect(ig?.missingDataDays).toBe(0);
      expect(ig?.completeness.delayDays).toBe(2);
      expect(ig?.completeness.pendingDays).toContain("2026-09-30");
    });
  });

  describe("GET /api/v1/analytics/content/:id", () => {
    it("içerik yoksa 404", async () => {
      f.cookie = await login();
      const res = await get("/api/v1/analytics/content/yok-boyle-bir-kimlik");
      expect(res.status).toBe(404);
      expect(errorOf(res.raw).code).toBe("not_found");
    });

    it("günlük seri + önceki dönem + yüzde değişim döner", async () => {
      await f.close();
      f = await setup({
        rows: [
          row({ jobId: "c1", metricDate: "2026-09-10", platform: "instagram", metrics: { views: 100, interactions: 10, saves: 4, shares: 2 } }),
          row({ jobId: "c1", metricDate: "2026-09-11", platform: "instagram", metrics: { views: 150, interactions: 15, saves: 6, shares: 3 } }),
          row({ jobId: "c1", metricDate: "2026-09-08", platform: "instagram", metrics: { views: 50, interactions: 5, saves: 2, shares: 1 } }),
          row({ jobId: "c1", metricDate: "2026-09-09", platform: "instagram", metrics: { views: 100, interactions: 10, saves: 4, shares: 2 } }),
        ],
      });
      const content = seedContent("b.mp4");
      f.cookie = await login();
      const res = await get(
        `/api/v1/analytics/content/${content}?from=2026-09-10&to=2026-09-11`,
      );
      expect(res.status).toBe(200);
      const data = dataOf<{
        contentId: string;
        series: Array<{ date: string; platform: Platform; metrics: Record<string, number | null> }>;
        previous: { window: { from: string; to: string }; rollup: RollupResult } | null;
        change: { deltas: Array<{ key: string; changePct: number | null }> } | null;
        viewsCountingChangeDate: string;
      }>(res.raw);
      expect(data.contentId).toBe(content);
      expect(data.series.map((s) => s.date)).toEqual(["2026-09-10", "2026-09-11"]);
      expect(data.series[1]?.metrics["views"]).toBe(150);
      expect(data.previous?.window).toEqual({ from: "2026-09-08", to: "2026-09-09" });
      const viewsDelta = data.change?.deltas.find((d) => d.key === "views");
      expect(viewsDelta?.changePct).toBeCloseTo(50, 5);
      expect(data.viewsCountingChangeDate).toBe("2026-08-27");
    });

    it("ölçülemeyen seride sebep yazılıdır", async () => {
      await f.close();
      f = await setup({
        rows: [
          row({
            jobId: "c2",
            metricDate: "2026-09-11",
            platform: "tiktok",
            metrics: {},
            unavailable: "not_public",
          }),
        ],
      });
      const content = seedContent("c.mp4");
      f.cookie = await login();
      const res = await get(
        `/api/v1/analytics/content/${content}?from=2026-09-11&to=2026-09-11`,
      );
      const data = dataOf<{
        series: Array<{ unavailable: { reason: string } | null }>;
        rollup: RollupResult;
      }>(res.raw);
      expect(data.series[0]?.unavailable?.reason).toBe("not_public");
      expect(data.rollup.unavailableCount).toBe(1);
      // "Ölçülemedi" sayılan bir iş, ölçülmüş sayılmaz.
      expect(data.rollup.measuredCount).toBe(0);
    });
  });

  describe("GET /api/v1/analytics/series", () => {
    it("gün × platform noktaları döner", async () => {
      await f.close();
      f = await setup({
        rows: [
          row({ jobId: "s1", metricDate: "2026-09-10", platform: "instagram" }),
          row({ jobId: "s2", metricDate: "2026-09-11", platform: "instagram" }),
        ],
      });
      f.cookie = await login();
      const res = await get(
        "/api/v1/analytics/series?from=2026-09-10&to=2026-09-11&platform=instagram",
      );
      const data = dataOf<{
        points: Array<{ date: string; views: number | null; measured: number }>;
      }>(res.raw);
      expect(data.points).toHaveLength(2);
      expect(data.points[0]?.views).toBe(100);
    });

    it("hiç satır olmayan gün tabloya girmez", async () => {
      await f.close();
      f = await setup({ rows: [row({ jobId: "s1", metricDate: "2026-09-10", platform: "instagram" })] });
      f.cookie = await login();
      const res = await get(
        "/api/v1/analytics/series?from=2026-09-08&to=2026-09-11&platform=instagram",
      );
      const data = dataOf<{ points: Array<{ date: string }> }>(res.raw);
      expect(data.points.map((p) => p.date)).toEqual(["2026-09-10"]);
    });

    it("değeri olmayan metrik null döner, 0 değil", async () => {
      await f.close();
      f = await setup({
        rows: [
          row({ jobId: "s3", metricDate: "2026-09-10", platform: "youtube", metrics: { views: 0 } }),
        ],
      });
      f.cookie = await login();
      const res = await get(
        "/api/v1/analytics/series?from=2026-09-10&to=2026-09-10&platform=youtube",
      );
      const data = dataOf<{
        points: Array<{ views: number | null; saves: number | null; shares: number | null }>;
      }>(res.raw);
      // Ölçüldü ve sıfır → 0. Hiç ölçülmemiş → null (YouTube `shares` örneği).
      expect(data.points[0]?.views).toBe(0);
      expect(data.points[0]?.saves).toBeNull();
      expect(data.points[0]?.shares).toBeNull();
    });

    it("ölçülemeyen günü gerekçesiyle bildirir", async () => {
      await f.close();
      f = await setup({
        rows: [
          row({
            jobId: "s4",
            metricDate: "2026-09-10",
            platform: "tiktok",
            metrics: {},
            unavailable: "not_public",
          }),
        ],
      });
      f.cookie = await login();
      const res = await get(
        "/api/v1/analytics/series?from=2026-09-10&to=2026-09-10&platform=tiktok",
      );
      const data = dataOf<{
        points: Array<{ views: number | null; unavailable: { count: number; byReason: Record<string, number> } | null }>;
      }>(res.raw);
      expect(data.points[0]?.views).toBeNull();
      expect(data.points[0]?.unavailable?.count).toBe(1);
      expect(data.points[0]?.unavailable?.byReason["not_public"]).toBe(1);
    });

    it("geçersiz platform ve limit 400 verir", async () => {
      f.cookie = await login();
      expect((await get("/api/v1/analytics/series?platform=x")).status).toBe(400);
      expect((await get("/api/v1/analytics/series?limit=0")).status).toBe(400);
      expect((await get("/api/v1/analytics/series?limit=abc")).status).toBe(400);
    });

    it("çok uzun aralık 400 verir", async () => {
      f.cookie = await login();
      const res = await get("/api/v1/analytics/series?from=2000-01-01&to=2026-01-01");
      expect(res.status).toBe(400);
      expect(errorOf(res.raw).code).toBe("validation_failed");
    });
  });

  describe("GET /api/v1/analytics/coverage", () => {
    it("sebebe göre gruplar", async () => {
      await f.close();
      f = await setup({
        rows: [
          row({ jobId: "k1", metricDate: "2026-09-10", platform: "instagram" }),
          row({ jobId: "k2", metricDate: "2026-09-10", platform: "instagram", metrics: {}, unavailable: "not_public" }),
          row({ jobId: "k3", metricDate: "2026-09-10", platform: "instagram", metrics: {}, unavailable: "not_public" }),
          row({ jobId: "k4", metricDate: "2026-09-10", platform: "tiktok", metrics: {}, unavailable: "no_scope" }),
        ],
      });
      f.cookie = await login();
      const res = await get("/api/v1/analytics/coverage?from=2026-09-10&to=2026-09-10");
      const data = dataOf<{
        totalJobs: number;
        measurable: number;
        unavailable: Array<{ platform: Platform; count: number; byReason: Record<string, number> }>;
      }>(res.raw);
      expect(data.totalJobs).toBe(4);
      expect(data.measurable).toBe(1);
      expect(data.unavailable.map((u) => u.platform)).toEqual(["instagram", "tiktok"]);
      const ig = data.unavailable.find((u) => u.platform === "instagram");
      expect(ig?.count).toBe(2);
      expect(ig?.byReason["not_public"]).toBe(2);
      expect(ig?.byReason["no_scope"]).toBe(0);
    });
  });

  describe("POST /api/v1/analytics/collect", () => {
    it("oturum ister", async () => {
      const res = await f.server.inject({
        method: "POST",
        url: "/api/v1/analytics/collect",
        headers: { origin: "http://localhost", host: "localhost", cookie: "sp_session=yok" },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res.payload).code).toBe("unauthorized");
    });

    it("X-Api-Key ile de kabul edilir", async () => {
      const res = await f.server.inject({
        method: "POST",
        url: "/api/v1/analytics/collect?days=2",
        headers: { "x-api-key": f.harness.apiKey ?? "" },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const data = dataOf<{ results: Array<{ jobId: string; ok: boolean }> }>(res.payload);
      expect(Array.isArray(data.results)).toBe(true);
    });

    it("geçersiz anahtar 401 verir", async () => {
      const res = await f.server.inject({
        method: "POST",
        url: "/api/v1/analytics/collect",
        headers: { "x-api-key": "yanlis-anahtar" },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });

    it("kimlik eksikliği hata değil sonuç döner", async () => {
      await f.close();
      f = await setup({
        rows: [row({ jobId: "r1", metricDate: "2026-09-30", platform: "instagram" })],
      });
      f.cookie = await login();
      const res = await f.server.inject({
        method: "POST",
        url: "/api/v1/analytics/collect",
        headers: authHeaders(),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const data = dataOf<{
        collected: number;
        skipped: number;
        results: Array<{ jobId: string; ok: boolean; reason: string | null }>;
      }>(res.payload);
      expect(data.collected).toBe(1);
      // Adaptörü olmayan platform "atlandı" olarak döner, HTTP hatası DEĞİL.
      expect(data.skipped).toBe(1);
      expect(data.results.some((r) => r.ok === false && r.reason !== null)).toBe(true);
    });

    it("ölçülemeyen kayıt ok=false ve sebep yazar", async () => {
      await f.close();
      f = await setup({
        rows: [
          row({
            jobId: "r2",
            metricDate: "2026-09-30",
            platform: "tiktok",
            metrics: {},
            unavailable: "not_public",
          }),
        ],
        analyticsPlatforms: ["tiktok"],
      });
      f.cookie = await login();
      const res = await f.server.inject({
        method: "POST",
        url: "/api/v1/analytics/collect",
        headers: authHeaders(),
        payload: {},
      });
      const data = dataOf<{ results: Array<{ jobId: string; ok: boolean; reason: string | null }> }>(
        res.payload,
      );
      const entry = data.results.find((r) => r.jobId === "r2");
      expect(entry?.ok).toBe(false);
      expect(entry?.reason).toBe("not_public");
    });

    it("days parametresi doğrulanır ve toplama sınırına bağlanır", async () => {
      f.cookie = await login();
      const bad = await f.server.inject({
        method: "POST",
        url: "/api/v1/analytics/collect?days=0",
        headers: authHeaders(),
        payload: {},
      });
      expect(bad.statusCode).toBe(400);
      expect(errorOf(bad.payload).code).toBe("validation_failed");

      const ok = await f.server.inject({
        method: "POST",
        url: "/api/v1/analytics/collect?days=3",
        headers: authHeaders(),
        payload: {},
      });
      expect(ok.statusCode).toBe(200);
      const call = f.analytics?.collectCalls.at(-1);
      expect(call?.limit).toBe(75);
    });

    it("tick'i bloklamaz: zamanlayıcı sözü korunur", async () => {
      f.cookie = await login();
      await f.server.inject({
        method: "POST",
        url: "/api/v1/analytics/collect",
        headers: authHeaders(),
        payload: {},
      });
      const res = await get("/api/v1/scheduler");
      const data = dataOf<{ tickMs: number; running: boolean }>(res.raw);
      expect(data.tickMs).toBe(f.harness.config.schedulerTickMs);
      expect(data.running).toBe(false);
    });
  });
});
