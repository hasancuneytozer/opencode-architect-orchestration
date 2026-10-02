/**
 * Liste filtreleme ve arama. SAF. Girdi dizileri DEĞİŞTİRİLMEZ; boş listede
 * ve `null` alanlarda çökmez (defansif: sunucu alanları yine de eksik gönderebilir).
 */
import type { Asset, ContentItem, ContentState, JobState, Platform } from "../../../src/contract/index.js";
import { trLower } from "./labels.js";

/** Türkçe harfleri aramaya uygun hale getirir: "ç" → "c", "İ" → "i". */
export function foldSearch(text: string | null | undefined): string {
  if (text === null || text === undefined) return "";
  return trLower(text)
    .replace(/[çÇ]/g, "c")
    .replace(/[ğĞ]/g, "g")
    .replace(/[ıİ]/g, "i")
    .replace(/[öÖ]/g, "o")
    .replace(/[şŞ]/g, "s")
    .replace(/[üÜ]/g, "u")
    .replace(/[âÂ]/g, "a")
    .replace(/[îÎ]/g, "i")
    .replace(/[ûÛ]/g, "u")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Çoklu seçimde bir değeri aç/kapa. Yeni dizi döner, girdiye dokunmaz. */
export function toggleValue<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function isSelected<T>(list: readonly T[], value: T): boolean {
  return list.includes(value);
}

export function unique<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}

/** Boş sorgu tümünü geçirir. Arama tüm alanlarda OR olarak çalışır. */
export function matchesQuery(
  query: string,
  ...fields: Array<string | null | undefined>
): boolean {
  const needle = foldSearch(query).trim();
  if (needle === "") return true;
  return fields.some((field) => foldSearch(field).includes(needle));
}

export function countBy<T, K extends string>(items: readonly T[], key: (item: T) => K): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ── Tarih aralığı ─────────────────────────────────────────────────────────

/** `from`/`to` gün sınırları (ISO tarih ya da tam zaman damgası olabilir). */
export interface DateRange {
  from: string | null;
  to: string | null;
}

function parseBoundary(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Aralığa düşer mi? `from` dahil, `to` DAHİL değil (`to` bir `<input type="date">`
 * ise 00:00'ı ifade eder; gün sonuna kadar almak isteyen kullanıcı `+1 gün`
 * girmelidir — bu belirsizlik gizlenmez, arayüz ipucu gösterir).
 */
export function withinRange(iso: string | null | undefined, range: DateRange): boolean {
  if (range.from === null && range.to === null) return true;
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const from = parseBoundary(range.from);
  const to = parseBoundary(range.to);
  if (from !== null && t < from) return false;
  if (to !== null && t >= to) return false;
  return true;
}

// ── Varlıklar ─────────────────────────────────────────────────────────────

export interface AssetFilterState {
  projectId: string | null;
  query: string;
  range: DateRange;
  /** Yalnız `error` seviyesinde bulgusu olanlar. */
  onlyProblems: boolean;
  /** `error` veya `warning` seviyesinde bulgusu olanlar. */
  onlyWithFindings: boolean;
}

export function emptyAssetFilters(): AssetFilterState {
  return {
    projectId: null,
    query: "",
    range: { from: null, to: null },
    onlyProblems: false,
    onlyWithFindings: false,
  };
}

export function assetHasError(asset: Asset): boolean {
  return (asset.findings ?? []).some((f) => f.severity === "error");
}

export function assetFindingCount(asset: Asset): number {
  return (asset.findings ?? []).length;
}

export function assetProblemCount(asset: Asset): number {
  return (asset.findings ?? []).filter((f) => f.severity === "error").length;
}

export function filterAssets(assets: readonly Asset[], state: AssetFilterState): Asset[] {
  return assets.filter((asset) => {
    if (state.projectId !== null && asset.projectId !== state.projectId) return false;
    if (!withinRange(asset.createdAt, state.range)) return false;
    if (state.onlyProblems && !assetHasError(asset)) return false;
    if (state.onlyWithFindings && assetFindingCount(asset) === 0) return false;
    return matchesQuery(
      state.query,
      asset.originalName,
      asset.mimeType,
      asset.storageKey,
      asset.info?.container ?? null,
      asset.info?.videoCodec ?? null,
    );
  });
}

// ── İçerik ────────────────────────────────────────────────────────────────

export interface ContentFilterState {
  states: ContentState[];
  query: string;
  campaign: string | null;
  range: DateRange;
  projectId: string | null;
  /** Yalnız onay bekleyenler. */
  onlyNeedsApproval: boolean;
}

export function emptyContentFilters(): ContentFilterState {
  return {
    states: [],
    query: "",
    campaign: null,
    range: { from: null, to: null },
    projectId: null,
    onlyNeedsApproval: false,
  };
}

export function contentNeedsApproval(item: ContentItem): boolean {
  return item.requiresApproval === true && item.approvedAt === null;
}

export function contentIsApproved(item: ContentItem): boolean {
  return item.approvedAt !== null || item.requiresApproval !== true;
}

export function filterContent(items: readonly ContentItem[], state: ContentFilterState): ContentItem[] {
  return items.filter((item) => {
    if (state.states.length > 0 && !state.states.includes(item.state)) return false;
    if (state.projectId !== null && item.projectId !== state.projectId) return false;
    if (state.campaign !== null && item.campaign !== state.campaign) return false;
    if (!withinRange(item.scheduledAt ?? item.createdAt, state.range)) return false;
    if (state.onlyNeedsApproval && !contentNeedsApproval(item)) return false;
    return matchesQuery(
      state.query,
      item.campaign,
      item.batchId,
      item.copy?.instagram?.caption ?? null,
      item.copy?.tiktok?.caption ?? null,
      item.copy?.youtube?.title ?? null,
      (item.tags ?? []).join(" "),
    );
  });
}

// ── İşler ─────────────────────────────────────────────────────────────────

export interface JobFilterState {
  states: JobState[];
  platforms: Platform[];
  contentId: string | null;
  query: string;
  /** Yalnız `failed`. */
  onlyFailed: boolean;
  /** Hata taşıyan her iş (failed olması şart değil; `published_no_link` de hata taşıyabilir). */
  onlyWithError: boolean;
}

export function emptyJobFilters(): JobFilterState {
  return {
    states: [],
    platforms: [],
    contentId: null,
    query: "",
    onlyFailed: false,
    onlyWithError: false,
  };
}

export function jobHasError<T extends { error?: unknown }>(job: T): boolean {
  return job.error !== null && job.error !== undefined;
}

export function filterJobs<T extends { state: JobState; platform: Platform; contentId: string; id: string; error?: unknown }>(
  jobs: readonly T[],
  state: JobFilterState,
): T[] {
  return jobs.filter((job) => {
    if (state.states.length > 0 && !state.states.includes(job.state)) return false;
    if (state.platforms.length > 0 && !state.platforms.includes(job.platform)) return false;
    if (state.contentId !== null && job.contentId !== state.contentId) return false;
    if (state.onlyFailed && job.state !== "failed") return false;
    if (state.onlyWithError && !jobHasError(job)) return false;
    if (!matchesQuery(state.query, job.id, job.contentId)) return false;
    return true;
  });
}

// ── Sayfalama ─────────────────────────────────────────────────────────────

export interface PageInfo {
  page: number;
  pages: number;
  total: number;
  from: number;
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/** Sunucudan `limit`/`offset` geldiğinde "N kayıttan M-K arası" bilgisini üretir. */
export function pageInfo(total: number, limit: number, offset: number): PageInfo {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 25;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const pages = safeTotal === 0 ? 1 : Math.ceil(safeTotal / safeLimit);
  const page = Math.floor(safeOffset / safeLimit) + 1;
  const from = safeTotal === 0 ? 0 : safeOffset + 1;
  const to = safeTotal === 0 ? 0 : Math.min(safeTotal, safeOffset + safeLimit);
  return {
    page,
    pages,
    total: safeTotal,
    from,
    to,
    hasPrev: page > 1,
    hasNext: safeOffset + safeLimit < safeTotal,
  };
}

/** İstemci tarafı sayfalama (küçük listeler için). */
export function paginate<T>(items: readonly T[], limit: number, offset: number): T[] {
  if (items.length === 0) return [];
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : items.length;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  return items.slice(safeOffset, safeOffset + safeLimit);
}

/** Kampanyalar (süzülmüş ve sıralanmış). */
export function campaigns(items: readonly ContentItem[]): string[] {
  const set = new Set<string>();
  for (const item of items) {
    if (item.campaign) set.add(item.campaign);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "tr"));
}