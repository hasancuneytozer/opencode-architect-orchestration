/**
 * `web/src/lib/filters.ts` — durum/platform/arama filtreleme, çoklu seçim,
 * boş listede çökme, tarih aralığı ve sayfalama.
 */
import { describe, expect, it } from "vitest";

import type { Asset, ContentItem, PublishJob } from "../../src/contract/index.js";
import {
  assetFindingCount,
  assetHasError,
  assetProblemCount,
  campaigns,
  contentIsApproved,
  contentNeedsApproval,
  countBy,
  emptyAssetFilters,
  emptyContentFilters,
  emptyJobFilters,
  filterAssets,
  filterContent,
  filterJobs,
  foldSearch,
  isSelected,
  matchesQuery,
  pageInfo,
  paginate,
  toggleValue,
  unique,
  withinRange,
} from "../../web/src/lib/filters.js";

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: "a1",
  projectId: "p1",
  storageKey: "k/a.mp4",
  originalName: "reklam.mp4",
  bytes: 1024,
  mimeType: "video/mp4",
  info: {
    path: "a.mp4",
    bytes: 1024,
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 15,
    bitrate: 5_000_000,
    hasAudio: true,
  },
  findings: [],
  coverKey: null,
  derivedFromAssetId: null,
  derivedForPlatform: null,
  createdAt: "2026-09-30T12:00:00Z",
  ...over,
});

const content = (over: Partial<ContentItem> = {}): ContentItem => ({
  id: "c1",
  projectId: "p1",
  assetId: "a1",
  state: "scheduled",
  campaign: "sonbahar",
  tags: ["yeni"],
  copy: {},
  scheduledAt: "2026-10-02T09:00:00Z",
  timezone: "Europe/Istanbul",
  quietHours: null,
  metadata: {},
  aiDisclosure: {
    tiktokIsAigc: true,
    youtubeSyntheticMedia: true,
    instagramIsAiGenerated: true,
    userConfirmed: false,
  },
  requiresApproval: true,
  approvedBy: null,
  approvedAt: null,
  batchId: "b1",
  createdAt: "2026-09-30T12:00:00Z",
  updatedAt: "2026-09-30T12:00:00Z",
  ...over,
});

const job = (over: Partial<PublishJob> = {}): PublishJob => ({
  id: "j1",
  contentId: "c1",
  platform: "instagram",
  accountId: "acc1",
  state: "queued",
  scheduledAt: "2026-10-02T09:00:00Z",
  attempts: 1,
  idempotencyKey: "k1",
  idempotencyFirstUsedAt: null,
  externalId: null,
  uploadUrl: null,
  uploadUrlExpiresAt: null,
  uploadedParts: 0,
  totalParts: null,
  remoteId: null,
  permalink: null,
  error: null,
  nextAttemptAt: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-09-30T12:00:00Z",
  updatedAt: "2026-09-30T12:00:00Z",
  ...over,
});

describe("çoklu seçim", () => {
  it("ekler ve çıkarır, girdiyi değiştirmez", () => {
    const base: Platform[] = ["instagram"];
    const added = toggleValue(base, "tiktok");
    expect(added).toEqual(["instagram", "tiktok"]);
    expect(base).toEqual(["instagram"]);
    expect(toggleValue(added, "instagram")).toEqual(["tiktok"]);
  });

  it("seçim kontrolü", () => {
    const list = ["draft", "ready"] as const;
    expect(isSelected(list, "draft")).toBe(true);
    expect(isSelected(list, "failed")).toBe(false);
  });

  it("tekrar edenleri eler", () => {
    expect(unique(["a", "a", "b"])).toEqual(["a", "b"]);
  });
});

type Platform = "instagram" | "tiktok" | "youtube";

describe("arama", () => {
  it("Türkçe harf katlama: 'ç' ile 'c' eşleşir", () => {
    expect(foldSearch("ÇALIŞAN")).toBe("calisan");
    expect(foldSearch("İSTİKLAL")).toBe("istiklal");
  });

  it("boş sorgu her şeyi geçirir", () => {
    expect(matchesQuery("", "herhangi")).toBe(true);
    expect(matchesQuery("   ", "herhangi")).toBe(true);
  });

  it("alanlardan herhangi birinde bulur", () => {
    expect(matchesQuery("reklam", "reklam-2026.mp4", "x")).toBe(true);
    expect(matchesQuery("mp4", "reklam-2026.mp4", "x")).toBe(true);
    expect(matchesQuery("yok", "reklam", "x")).toBe(false);
  });

  it("null alanlarda çökmez", () => {
    expect(matchesQuery("x", null, undefined)).toBe(false);
  });
});

describe("withinRange", () => {
  it("from dahil, to hariç", () => {
    const range = { from: "2026-10-01", to: "2026-10-03" };
    expect(withinRange("2026-10-01T00:00:00Z", range)).toBe(true);
    expect(withinRange("2026-10-02T23:59:00Z", range)).toBe(true);
    expect(withinRange("2026-10-03T00:00:00Z", range)).toBe(false);
    expect(withinRange("2026-09-30T23:59:00Z", range)).toBe(false);
  });

  it("boş aralık her şeyi geçirir", () => {
    expect(withinRange("2026-01-01T00:00:00Z", { from: null, to: null })).toBe(true);
  });

  it("tarihi olmayan kayıt aralıkta sayılmaz", () => {
    expect(withinRange(null, { from: "2026-10-01", to: null })).toBe(false);
  });
});

describe("varlık filtreleme", () => {
  it("boş listede çökmez", () => {
    expect(filterAssets([], emptyAssetFilters())).toEqual([]);
  });

  it("proje ile süzer", () => {
    const items = [asset({ id: "a", projectId: "p1" }), asset({ id: "b", projectId: "p2" })];
    const out = filterAssets(items, { ...emptyAssetFilters(), projectId: "p2" });
    expect(out.map((a) => a.id)).toEqual(["b"]);
  });

  it("yalnız hatalılar", () => {
    const items = [
      asset({ id: "ok", findings: [{ code: "x", severity: "info", message: "bilgi" }] }),
      asset({ id: "bad", findings: [{ code: "y", severity: "error", message: "hata" }] }),
    ];
    const out = filterAssets(items, { ...emptyAssetFilters(), onlyProblems: true });
    expect(out.map((a) => a.id)).toEqual(["bad"]);
    expect(assetHasError(items[0]!)).toBe(false);
    expect(assetProblemCount(items[1]!)).toBe(1);
  });

  it("bulgu olanlar / tarih / arama birlikte çalışır", () => {
    const items = [
      asset({ id: "a", originalName: "sonbahar.mp4", findings: [{ code: "x", severity: "warning", message: "u" }], createdAt: "2026-10-02T00:00:00Z" }),
      asset({ id: "b", originalName: "kış.mp4", createdAt: "2026-11-02T00:00:00Z" }),
    ];
    const out = filterAssets(items, {
      ...emptyAssetFilters(),
      query: "sonbahar",
      range: { from: "2026-10-01", to: "2026-11-01" },
      onlyWithFindings: true,
    });
    expect(out.map((a) => a.id)).toEqual(["a"]);
    expect(assetFindingCount(items[0]!)).toBe(1);
    expect(assetFindingCount(items[1]!)).toBe(0);
  });
});

describe("içerik filtreleme", () => {
  it("boş listede çökmez", () => {
    expect(filterContent([], emptyContentFilters())).toEqual([]);
  });

  it("çoklu durum seçimi OR ile çalışır", () => {
    const items = [
      content({ id: "c1", state: "scheduled" }),
      content({ id: "c2", state: "failed" }),
      content({ id: "c3", state: "published" }),
    ];
    const out = filterContent(items, { ...emptyContentFilters(), states: ["scheduled", "failed"] });
    expect(out.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("kampanya ve arama ile süzer", () => {
    const items = [
      content({ id: "c1", campaign: "sonbahar", copy: { instagram: { caption: "Kışa hazırız" } } }),
      content({ id: "c2", campaign: "yaz", copy: { tiktok: { caption: "Yaz indirimi" } } }),
    ];
    expect(filterContent(items, { ...emptyContentFilters(), campaign: "yaz" }).map((c) => c.id)).toEqual(["c2"]);
    expect(filterContent(items, { ...emptyContentFilters(), query: "KIŞA" }).map((c) => c.id)).toEqual(["c1"]);
  });

  it("onay bekleyenleri süzer", () => {
    const items = [
      content({ id: "c1", requiresApproval: true, approvedAt: null }),
      content({ id: "c2", requiresApproval: true, approvedAt: "2026-09-30T10:00:00Z" }),
      content({ id: "c3", requiresApproval: false, approvedAt: null }),
    ];
    const out = filterContent(items, { ...emptyContentFilters(), onlyNeedsApproval: true });
    expect(out.map((c) => c.id)).toEqual(["c1"]);
    expect(contentNeedsApproval(items[0]!)).toBe(true);
    expect(contentNeedsApproval(items[1]!)).toBe(false);
    expect(contentIsApproved(items[2]!)).toBe(true);
  });

  it("kampanya listesi sıralı ve tekilleştirilmiş", () => {
    const items = [
      content({ id: "c1", campaign: "yaz" }),
      content({ id: "c2", campaign: "bahar" }),
      content({ id: "c3", campaign: "yaz" }),
      content({ id: "c4", campaign: null }),
    ];
    expect(campaigns(items)).toEqual(["bahar", "yaz"]);
  });
});

describe("iş filtreleme", () => {
  it("boş listede çökmez", () => {
    expect(filterJobs([], emptyJobFilters())).toEqual([]);
  });

  it("platform ve durum ile süzer", () => {
    const items = [
      job({ id: "j1", platform: "instagram", state: "failed" }),
      job({ id: "j2", platform: "tiktok", state: "published" }),
      job({ id: "j3", platform: "tiktok", state: "published_no_link" }),
    ];
    expect(filterJobs(items, { ...emptyJobFilters(), platforms: ["tiktok"] }).map((j) => j.id)).toEqual([
      "j2",
      "j3",
    ]);
    expect(filterJobs(items, { ...emptyJobFilters(), states: ["published"] }).map((j) => j.id)).toEqual(["j2"]);
  });

  it("yalnız başarısızlar / hata taşıyanlar", () => {
    const items = [
      job({ id: "j1", state: "failed", error: { kind: "quota", message: "kota", providerCode: null, logId: null, httpStatus: null, retryAfterMs: null, retryable: false, at: "2026-10-01T00:00:00Z" } }),
      job({ id: "j2", state: "published_no_link", error: null }),
      job({ id: "j3", state: "published", error: null }),
    ];
    expect(filterJobs(items, { ...emptyJobFilters(), onlyFailed: true }).map((j) => j.id)).toEqual(["j1"]);
    expect(filterJobs(items, { ...emptyJobFilters(), onlyWithError: true }).map((j) => j.id)).toEqual(["j1"]);
  });

  it("kimlik araması", () => {
    const items = [job({ id: "job-9", contentId: "c9" }), job({ id: "job-1", contentId: "c1" })];
    expect(filterJobs(items, { ...emptyJobFilters(), query: "job-9" }).map((j) => j.id)).toEqual(["job-9"]);
    expect(filterJobs(items, { ...emptyJobFilters(), contentId: "c1" }).map((j) => j.id)).toEqual(["job-1"]);
  });
});

describe("sayfalama", () => {
  it("dilimler", () => {
    const items = [1, 2, 3, 4, 5];
    expect(paginate(items, 2, 0)).toEqual([1, 2]);
    expect(paginate(items, 2, 4)).toEqual([5]);
    expect(paginate([], 10, 0)).toEqual([]);
  });

  it("sayfa bilgisi üretir", () => {
    const info = pageInfo(25, 10, 0);
    expect(info).toEqual({ page: 1, pages: 3, total: 25, from: 1, to: 10, hasPrev: false, hasNext: true });
    expect(pageInfo(25, 10, 20).hasNext).toBe(false);
    expect(pageInfo(25, 10, 20).to).toBe(25);
  });

  it("toplam sıfırken boş durum gösterir", () => {
    const info = pageInfo(0, 10, 0);
    expect(info.from).toBe(0);
    expect(info.to).toBe(0);
    expect(info.hasNext).toBe(false);
  });

  it("bozuk limit/offset çökmez", () => {
    expect(pageInfo(25, 0, 0).pages).toBe(1);
    expect(pageInfo(25, 10, -5).from).toBe(1);
  });
});

describe("countBy", () => {
  it("sayar", () => {
    expect(countBy([content({ state: "failed" }), content({ state: "failed" }), content({ state: "published" })], (c) => c.state)).toEqual({
      failed: 2,
      published: 1,
    });
  });

  it("boş listede boş nesne döner", () => {
    expect(countBy([], (c: ContentItem) => c.state)).toEqual({});
  });
});