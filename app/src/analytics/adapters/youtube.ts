/**
 * YouTube ANALİTİK adaptörü — `GET https://youtubeanalytics.googleapis.com/v2/reports`.
 *
 * ── KAPSAM ÇELİŞKİSİ ───────────────────────────────────────────────────────
 * Doküman uyarısı bu yöntemin artık `youtube.readonly` istediğini söylüyor; aynı
 * sayfadaki tablo hâlâ `yt-analytics.readonly` listeliyor. ÜÇÜ DE talep edilir
 * (bkz. `scopes.ts`); eksik kapsam 403 `insufficientPermissions` demektir ve
 * rapor HİÇ gelmez.
 *
 * ── MALİYET: SIFIR ─────────────────────────────────────────────────────────
 * Analytics API, Data API'nin 10.000 birimlik günlük bütçesinden AYRI bir
 * sistemdir. Bu yüzden bu adaptör yayın kotanın bir parçasını TÜKETMEZ ve
 * yayın öncesi engelleme kararına girmez.
 *
 * ── TARİH KIRILMASI: 27 AĞUSTOS 2026 ───────────────────────────────────────
 * O tarihten sonra view sayımı TÜM formatlarda "oynatma başlangıcı"na sayılıyor.
 * Bu yüzden `metric_date` bu tarihi işaretler ve `comparePeriods` iki tarafı
 * AYRIŞTIRIR: bir dönem bu tarihi içeriyorsa yüzde değişim yanıltıcı olur.
 * `VIEWS_COUNTING_CHANGE_DATE` tek kaynaktır.
 *
 * ── PAYLAŞIM (SHARES) YOKTUR ───────────────────────────────────────────────
 * YouTube Analytics paylaşım sayısı VERMEZ. `shares` sahte bir metrik olarak
 * UYDURULMAZ; YouTube satırında `shares` hiç bulunmaz ve panelde `null` görünür.
 *
 * ── RAPOR YAPISI ───────────────────────────────────────────────────────────
 * `columnHeaders[].name` + satır dizisi. Satırlar `[["100","5","..."], ...]`.
 * Sütun adı ile indeks eşleştirilir; pozisyona güvenilmez.
 */
import type { Platform } from "../../contract/index.js";
import type { AnalyticsAdapter } from "../../ports/index.js";
import { asRecord, asText, createAnalyticsHttpClient } from "../http.js";
import type { AnalyticsHttpClient, AnalyticsHttpResponse } from "../http.js";
import { noScopeDecision, unavailableFromTransport } from "../errors.js";
import { YOUTUBE_ANALYTICS_SCOPES, missingScopes } from "../scopes.js";
import type { MetricQueryItem, MetricRecord } from "../types.js";
import { noScopeOrResponse } from "./shared.js";

/** Reports uç noktası. */
export const YOUTUBE_ANALYTICS_BASE = "https://youtubeanalytics.googleapis.com/v2/reports";

/** İstenen metrikler. `dislikes` PublicData'da YOKTUR (kaldırıldı) ve
 *  istenmez; `shares` YouTube'da hiç yoktur. */
export const YOUTUBE_ANALYTICS_METRICS: readonly string[] = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "audienceWatchRatio",
  "likes",
  "comments",
  "subscribersGained",
];

/**
 * 27 Ağustos 2026: view sayımı "oynatma başlangıcı"na sayılmaya başladı.
 * Karşılaştırma yaparken bu tarihi işaretlemek zorunlu; dönemler birleştirilirse
 * yüzde değişim yapay bir sıçrama gösterir.
 */
export const VIEWS_COUNTING_CHANGE_DATE = "2026-08-27";

/** Bir dönem bu tarihi içeriyor mu? Karşılaştırma uyarısı için. */
export function periodCrossesViewsChange(from: string, to: string): boolean {
  return from <= VIEWS_COUNTING_CHANGE_DATE && to >= VIEWS_COUNTING_CHANGE_DATE;
}

export interface YoutubeAnalyticsOptions {
  /** Zaman kaynağı. **Varsayılanı YOKTUR.** */
  now: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** `startDate` (YYYY-MM-DD). Vermezse kanal en son veriden başlar. */
  startDate?: string;
  /** `endDate` (YYYY-MM-DD). Vermezse bugünün YEREL günü hesaplanır. */
  endDate?: string;
  /** `metric=` listesi. Test kısaltmak için değiştirilebilir. */
  metrics?: readonly string[];
  ignoreScopes?: boolean;
  apiBase?: string;
  signal?: AbortSignal | null;
}

/** Reports sorgu dizesi. `dimensions=video` + `filters=video==ID`. */
export function buildReportQuery(input: {
  videoId: string;
  metrics: readonly string[];
  startDate: string;
  endDate: string;
}): string {
  const params = new URLSearchParams();
  params.set("ids", "channel==MINE");
  params.set("startDate", input.startDate);
  params.set("endDate", input.endDate);
  params.set("dimensions", "video");
  params.set("metrics", input.metrics.join(","));
  params.set("filters", `video==${input.videoId}`);
  return params.toString();
}

/**
 * Rapor gövdesi → ham metrik sözlüğü.
 *
 * Sütun adı → indeks eşlemesi kurulur; satır boşsa `{}` döner (rapor bulunamadı
 * demektir, `0` DEĞİL). Sayı metni kabul edilir: Google bazı yanıtlarda
 * `averageViewPercentage` değerini metin gönderir.
 */
export function readReportMetrics(json: unknown): Record<string, number | null> {
  const root = asRecord(json);
  if (root === null) return {};
  const headers = Array.isArray(root["columnHeaders"]) ? (root["columnHeaders"] as unknown[]) : [];
  const names: string[] = [];
  for (const h of headers) {
    const cell = asRecord(h);
    names.push(cell === null ? "" : (asText(cell["name"]) ?? ""));
  }
  const rows = Array.isArray(root["rows"]) ? (root["rows"] as unknown[]) : [];
  if (rows.length === 0) return {};

  const first = Array.isArray(rows[0]) ? (rows[0] as unknown[]) : [];
  const out: Record<string, number | null> = {};
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (name === undefined || name === "") continue;
    const raw = first[i];
    if (raw === undefined) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[name] = raw;
    } else if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
      out[name] = Number(raw.trim());
    } else {
      // Boş hücre → "veri yok". `0` yazmak ölçülmemiş bir videoyu sıfır izlenme
      // gibi göstermek olurdu.
      out[name] = null;
    }
  }
  return out;
}

export class YoutubeAnalyticsAdapter implements AnalyticsAdapter {
  readonly platform: Platform = "youtube";
  private readonly client: AnalyticsHttpClient;
  private readonly now: () => number;
  private readonly metrics: readonly string[];
  private readonly startDate: string;
  private readonly endDate: string | null;
  private readonly ignoreScopes: boolean;
  private readonly apiBase: string;
  private readonly signal: AbortSignal | null;
  private calls = 0;

  constructor(options: YoutubeAnalyticsOptions) {
    this.now = options.now;
    this.client = createAnalyticsHttpClient({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      now: options.now,
    });
    this.metrics = options.metrics ?? YOUTUBE_ANALYTICS_METRICS;
    this.startDate = options.startDate ?? "2005-02-14";
    this.endDate = options.endDate ?? null;
    this.ignoreScopes = options.ignoreScopes ?? false;
    this.apiBase = options.apiBase ?? YOUTUBE_ANALYTICS_BASE;
    this.signal = options.signal ?? null;
  }

  callCount(): number {
    return this.calls;
  }

  /** Tek çağrı: TEK video. `dimensions=video` + `filters=video==ID` yüzeyi
   *  video başına bir çağrı ister; toplu uç nokta YOKTUR (maliyet sıfır olduğu
   *  için "toplu rapor" sınırı da yoktur, ama `filters` tek video ile sınırlı). */
  reportUrl(videoId: string): string {
    const end = this.endDate ?? new Date(this.now()).toISOString().slice(0, 10);
    return `${this.apiBase}?${buildReportQuery({
      videoId,
      metrics: this.metrics,
      startDate: this.startDate,
      endDate: end,
    })}`;
  }

  async fetchMetrics(items: ReadonlyArray<MetricQueryItem>): Promise<MetricRecord[]> {
    const out: MetricRecord[] = [];
    for (const item of items) {
      out.push(await this.fetchOne(item));
    }
    return out;
  }

  private async fetchOne(item: MetricQueryItem): Promise<MetricRecord> {
    const fetchedAt = new Date(this.now()).toISOString();
    // `as const` YOK — gerekçe `instagram.ts → fetchOne` ile aynı: `platform`
    // alanı portta `Platform` tipindedir, daraltmaya ihtiyaç yoktur.
    const base = { platform: this.platform, remoteId: item.remoteId, fetchedAt };

    const missing = this.ignoreScopes ? [] : missingScopes(this.platform, item.scopes);
    if (missing.length > 0) {
      return {
        ...base,
        metrics: {},
        unavailable: noScopeDecision({
          what: "YouTube Analytics raporu",
          missingScopes: missing,
        }).unavailable,
        logId: null,
      };
    }

    const token = item.accessToken;
    if (typeof token !== "string" || token.trim() === "") {
      return {
        ...base,
        metrics: {},
        unavailable: noScopeDecision({
          what: "YouTube Analytics raporu",
          missingScopes: [...YOUTUBE_ANALYTICS_SCOPES],
        }).unavailable,
        logId: null,
      };
    }

    this.calls += 1;
    let response: AnalyticsHttpResponse;
    try {
      response = await this.client.send({
        method: "GET",
        url: this.reportUrl(item.remoteId),
        headers: { authorization: `Bearer ${token}` },
        ...(this.signal === null ? {} : { signal: this.signal }),
      });
    } catch (err) {
      const decision = unavailableFromTransport({
        platform: this.platform,
        what: "YouTube Analytics raporu okunamadı",
        message: err instanceof Error ? err.message : String(err),
      });
      return { ...base, metrics: {}, unavailable: decision.unavailable, logId: decision.logId };
    }

    const denied = noScopeOrResponse(
      this.platform,
      "YouTube Analytics raporu okunamadı",
      response,
      YOUTUBE_ANALYTICS_SCOPES,
    );
    if (denied !== null) {
      return { ...base, metrics: {}, unavailable: denied.unavailable, logId: denied.logId };
    }

    // 200 + `rows: []` → rapor YOK. Bu "ölçülemedi" değil, "henüz veri yok":
    // yeni yayınlanan videonun raporu 24-48 saat gecikmeli olabilir.
    return { ...base, metrics: readReportMetrics(response.json), unavailable: null, logId: null };
  }
}

/** Test yardımcısı: ham gövdenin `error` nesnesi var mı? */
export function reportHasError(json: unknown): boolean {
  const root = asRecord(json);
  if (root === null) return false;
  return Array.isArray(root["errors"]) || asRecord(root["error"]) !== null;
}