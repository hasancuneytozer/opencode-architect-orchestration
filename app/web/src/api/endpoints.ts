/**
 * Sunucu uç noktalarının tek yerden bağlanması. Her sayfa bu modülü çağırır;
 * böylece bir uç adı değişirse tek dosya güncellenir.
 */
import { ApiError, api, appendQueuedFile, xhrUpload, type XhrUploadHandle } from "./client.js";
import { asArray, asList, asRecord } from "../lib/apiShape.js";
import { isSafeRedirectUrl } from "../lib/accounts.js";
import type { ListResult } from "../lib/apiShape.js";
import type {
  Account,
  AnalyticsCollectResult,
  AnalyticsContentDetail,
  AnalyticsCoverage,
  AnalyticsOverview,
  AnalyticsSeries,
  Asset,
  ContentItem,
  HealthPayload,
  IngestKey,
  Platform,
  PublishJob,
  Project,
  SchedulerPayload,
  SessionPayload,
  SetupPayload,
  ValidationFinding,
} from "./types.js";
import type { IngestResult } from "./types.js";
import type {
  AssetReportPayload,
  ContentDetail,
  AssetDetail,
} from "./types.js";

export const endpoints = {
  health: () => api.get<HealthPayload>("/health"),
  session: () => api.get<SessionPayload>("/v1/session"),
  login: (password: string) => api.post<{ ok: boolean }>("/v1/auth/login", { password }),
  logout: () => api.post<{ ok: boolean }>("/v1/auth/logout"),
  setup: () => api.get<SetupPayload>("/v1/setup"),
  scheduler: () => api.get<SchedulerPayload>("/v1/scheduler"),
  schedulerTick: () => api.post<SchedulerPayload>("/v1/scheduler/tick"),
  ingestKeys: () => api.get<{ keys: Array<{ id: string; project: string; prefix: string; createdAt: string; lastUsedAt: string | null }> }>(
    "/v1/ingest/keys",
  ),
  createIngestKey: (project: string) => api.post<IngestKey>("/v1/ingest/keys", { project }),
} as const;

export async function listProjects(): Promise<ListResult<Project>> {
  return asList<Project>(await api.get<unknown>("/v1/projects"));
}

export async function listAssets(params: {
  projectId?: string | null;
  limit?: number;
  offset?: number;
}): Promise<ListResult<Asset>> {
  return asList<Asset>(
    await api.get<unknown>("/v1/assets", {
      projectId: params.projectId ?? undefined,
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
    }),
  );
}

export function getAsset(id: string): Promise<AssetDetail> {
  return api.get<AssetDetail>(`/v1/assets/${encodeURIComponent(id)}`);
}

// ── Yükleme (XHR · ilerlemeli) ─────────────────────────────────────────────

/**
 * `POST /api/v1/assets` — yalnız varlık (içerik kaydı YOK).
 *
 * Neden `api.upload` değil: ilerleme göstergesi için `XMLHttpRequest` gerekiyor
 * (bkz. `client.ts` → `xhrUpload`). Aynı dosya ikinci kez gelirse sunucu 200 +
 * mevcut varlığı döner; çağıran `Asset.id` ile yeni varlığı bulur.
 */
export function uploadAsset(
  file: File,
  opts: { projectId?: string | null; onProgress?: (percent: number) => void } = {},
): XhrUploadHandle<Asset> {
  const form = new FormData();
  appendQueuedFile(form, "file", file);
  const projectId = opts.projectId;
  if (projectId !== null && projectId !== undefined && projectId !== "") {
    form.append("projectId", projectId);
  }
  return xhrUpload<Asset>("/v1/assets", { form, onProgress: opts.onProgress });
}

/**
 * `POST /api/v1/ingest` — varlık + içerik + kuyruk işi.
 *
 * Oturum ÇEREZİYLE de çalışır: sunucu bu yolu `X-Api-Key` ya da oturum kabul
 * eder (`src/http/server.ts` → `requireSessionOrKey`). Panelde `X-Api-Key`
 * gönderilmez; kimlik çerezdedir.
 */
export function ingestVideo(
  file: File,
  fields: Record<string, string>,
  opts: { onProgress?: (percent: number) => void } = {},
): XhrUploadHandle<IngestResult> {
  const form = new FormData();
  appendQueuedFile(form, "file", file);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return xhrUpload<IngestResult>("/v1/ingest", { form, onProgress: opts.onProgress });
}

export async function getAssetReport(id: string): Promise<AssetReportPayload> {
  const raw = await api.get<AssetReportPayload>(`/v1/assets/${encodeURIComponent(id)}/report`);
  return {
    info: raw.info ?? null,
    findings: Array.isArray(raw.findings) ? raw.findings : [],
    perPlatform: {
      instagram: Array.isArray(raw.perPlatform?.instagram) ? raw.perPlatform.instagram : [],
      tiktok: Array.isArray(raw.perPlatform?.tiktok) ? raw.perPlatform.tiktok : [],
      youtube: Array.isArray(raw.perPlatform?.youtube) ? raw.perPlatform.youtube : [],
    },
  };
}

export async function listContent(params: {
  state?: string;
  projectId?: string | null;
  campaign?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
  offset?: number;
}): Promise<ListResult<ContentItem>> {
  return asList<ContentItem>(
    await api.get<unknown>("/v1/content", {
      state: params.state ?? undefined,
      projectId: params.projectId ?? undefined,
      campaign: params.campaign ?? undefined,
      from: params.from ?? undefined,
      to: params.to ?? undefined,
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
    }),
  );
}

export function getContent(id: string): Promise<ContentDetail> {
  return api.get<ContentDetail>(`/v1/content/${encodeURIComponent(id)}`);
}

export function patchContent(id: string, body: unknown): Promise<ContentDetail> {
  return api.patch<ContentDetail>(`/v1/content/${encodeURIComponent(id)}`, body);
}

export function approveContent(id: string): Promise<ContentDetail> {
  return api.post<ContentDetail>(`/v1/content/${encodeURIComponent(id)}/approve`, {});
}

export function publishNow(id: string): Promise<ContentDetail> {
  return api.post<ContentDetail>(`/v1/content/${encodeURIComponent(id)}/publish-now`, {});
}

export function cancelContent(id: string): Promise<ContentDetail> {
  return api.post<ContentDetail>(`/v1/content/${encodeURIComponent(id)}/cancel`, {});
}

export async function listJobs(params: {
  state?: string;
  contentId?: string | null;
  platform?: Platform | null;
  limit?: number;
  offset?: number;
}): Promise<ListResult<PublishJob>> {
  return asList<PublishJob>(
    await api.get<unknown>("/v1/jobs", {
      state: params.state ?? undefined,
      contentId: params.contentId ?? undefined,
      platform: params.platform ?? undefined,
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
    }),
  );
}

export function getJob(id: string): Promise<PublishJob> {
  return api.get<PublishJob>(`/v1/jobs/${encodeURIComponent(id)}`);
}

export function retryJob(id: string): Promise<PublishJob> {
  return api.post<PublishJob>(`/v1/jobs/${encodeURIComponent(id)}/retry`, {});
}

export async function listAccounts(): Promise<Account[]> {
  const result = asList<Account>(await api.get<unknown>("/v1/accounts"));
  return result.items;
}

/**
 * `GET /v1/auth/:platform/start` — OAuth yetkilendirme adresi (`data.url`).
 *
 * Sunucu `state` üretir, bellekte bekletir ve sağlayıcının `authorizeUrl`
 * adresini döner. Panel bu adrese `location.href` ile GİDER; dönüş
 * `/#/accounts?linked=<platform>&ok=1` ya da `&error=<kısa kod>` olur.
 *
 * ⚠️ İki savunma katmanı:
 *  - `url` alanı eksik/boşsa `ApiError` — yoksa `undefined` `location.href`'e
 *    yazılır ve sayfa "undefined" adresine gider.
 *  - Şema `http(s)` ya da aynı kaynaklı yol olmalı (`isSafeRedirectUrl`).
 *    Değer kendi sunucumuzdan geldiği için "güvenilir" saymak yanlıştır:
 *    `javascript:` gibi bir şema panelde kod çalıştırır.
 *
 * HTTP hatası zarf açılırken `ApiError` olarak yükselir; çağıran `try/catch`
 * ile tek yolu ele alır.
 */
export async function authStart(platform: Platform): Promise<string> {
  const raw = asRecord(await api.get<unknown>(`/v1/auth/${encodeURIComponent(platform)}/start`));
  const url = raw["url"];
  if (typeof url !== "string" || !isSafeRedirectUrl(url)) {
    throw new ApiError(
      "invalid_auth_start",
      "Yetkilendirme adresi alınamadı (sunucu güvenli bir dönüş adresi vermedi).",
      null,
      null,
    );
  }
  return url.trim();
}

/** Varlık listesi tarafındaki `findings` alanı her zaman dizi olsun. */
export function normalizeAsset(asset: Asset): Asset {
  return { ...asset, findings: Array.isArray(asset.findings) ? asset.findings : [] };
}

/** İçerik detayındaki `findings` her zaman dizi olsun. */
export function normalizeContentDetail(detail: ContentDetail): ContentDetail {
  return {
    ...detail,
    jobs: Array.isArray(detail.jobs) ? detail.jobs : [],
    findings: Array.isArray(detail.findings) ? detail.findings : ([] as ValidationFinding[]),
    tags: Array.isArray(detail.tags) ? detail.tags : [],
  };
}

// ── Analitik ───────────────────────────────────────────────────────────────

export interface AnalyticsWindow {
  from?: string | null;
  to?: string | null;
  platform?: Platform | null;
}

/**
 * `GET /v1/analytics/overview` — platform kartları + dönem penceresi.
 *
 * Tanımsız alanlar `null`'a indirgenir; sunucu eksik bir alan gönderirse
 * panel "veri yok" der, `undefined` okuyup çökmez.
 */
export async function analyticsOverview(
  params: AnalyticsWindow = {},
): Promise<AnalyticsOverview> {
  const raw = asRecord(
    await api.get<unknown>("/v1/analytics/overview", {
      from: params.from ?? undefined,
      to: params.to ?? undefined,
      platform: params.platform ?? undefined,
    }),
  );
  const previous = asRecord(raw["previous"]);
  return {
    mode: raw["mode"] === "live" ? "live" : "mock",
    from: String(raw["from"] ?? ""),
    to: String(raw["to"] ?? ""),
    previous: {
      from: String(previous["from"] ?? ""),
      to: String(previous["to"] ?? ""),
    },
    platforms: asArray(raw["platforms"]) as AnalyticsOverview["platforms"],
  };
}

/** `GET /v1/analytics/series` — günlük tablo satırları. */
export async function analyticsSeries(
  params: AnalyticsWindow & { limit?: number } = {},
): Promise<AnalyticsSeries> {
  const raw = asRecord(
    await api.get<unknown>("/v1/analytics/series", {
      from: params.from ?? undefined,
      to: params.to ?? undefined,
      platform: params.platform ?? undefined,
      limit: params.limit ?? undefined,
    }),
  );
  return {
    from: String(raw["from"] ?? ""),
    to: String(raw["to"] ?? ""),
    points: asArray(raw["points"]) as AnalyticsSeries["points"],
  };
}

/** `GET /v1/analytics/coverage` — "neden ölçülemiyor" dökümü. */
export async function analyticsCoverage(
  params: { from?: string | null; to?: string | null } = {},
): Promise<AnalyticsCoverage> {
  const raw = asRecord(
    await api.get<unknown>("/v1/analytics/coverage", {
      from: params.from ?? undefined,
      to: params.to ?? undefined,
    }),
  );
  const total = raw["totalJobs"];
  const measurable = raw["measurable"];
  return {
    from: String(raw["from"] ?? ""),
    to: String(raw["to"] ?? ""),
    totalJobs: typeof total === "number" ? total : 0,
    measurable: typeof measurable === "number" ? measurable : 0,
    unavailable: asArray(raw["unavailable"]) as AnalyticsCoverage["unavailable"],
  };
}

/** `GET /v1/analytics/content/:id` — günlük seri + önceki dönem karşılaştırması. */
export function analyticsContent(
  id: string,
  params: { from?: string | null; to?: string | null } = {},
): Promise<AnalyticsContentDetail> {
  return api.get<AnalyticsContentDetail>(
    `/v1/analytics/content/${encodeURIComponent(id)}`,
    { from: params.from ?? undefined, to: params.to ?? undefined },
  );
}

/**
 * `POST /v1/analytics/collect` — ölçüm tetikler.
 *
 * `days` sunucuya gider; sunucu bunu azami iş sayısına çevirir. Kimlik/izin
 * eksikliği HTTP HATASI değildir: gövde `results[]` içinde sebeple döner.
 */
export function collectAnalytics(days = 1): Promise<AnalyticsCollectResult> {
  return api.post<AnalyticsCollectResult>("/v1/analytics/collect?days=" + encodeURIComponent(String(days)), {});
}