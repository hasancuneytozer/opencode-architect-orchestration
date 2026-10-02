/**
 * Instagram ANALİTİK adaptörü — `GET /{ig-media-id}/insights`.
 *
 * ── AYRI İZİN, AYRI UÇ NOKTA ────────────────────────────────────────────────
 * Yayın `/{ig-user-id}/media` + `media_publish` ile yapılır; ölçüm tamamen
 * BAŞKA bir uç noktadır ve AYRI bir izin ister: `instagram_manage_insights`.
 * Yayın izni (`instagram_content_publish`) insights için YETMEZ.
 *
 * ── TALEP EDİLEN METRİKLER ──────────────────────────────────────────────────
 * Reels için desteklenen 12 metrik istenir ve `plays` / `impressions`
 * İSTENMEZ:
 *   * `plays`       21 Nisan 2025'te kaldırıldı,
 *   * `impressions` 2 Temmuz 2024 sonrası medya için kaldırıldı.
 * İstemek 400 döndürür ve çağrı IG'nin BUC kotasını harcar. Bu iki ad
 * `normalize()` tarafından da `deprecated` olarak işaretlenir: eski bir arşiv
 * kaydında geçse bile hesaplamaya GİRMEZ.
 *
 * 9:16 reklam için anlamlı olanlar: `reels_skip_rate` (ilk 3 sn'nin çekiciliği
 * = hook kalitesi), `ig_reels_avg_watch_time` (tutma gücü), `saved` + `shares`
 * (en güçlü niyet sinyalleri), `reach`/`views` (dağıtım), `total_interactions`.
 * Tamamı istenir; "en anlamlı 5'i seç" kısıtı kotayı değil panel gürültüsünü
 * azaltırdı ve hangi metriğin günün hangi sorusuna cevap verdiği kaybolurdu.
 *
 * ── BELİRTEÇ NEREDE? ───────────────────────────────────────────────────────
 * Insights çağrısı `access_token` sorgu parametresiyle de belgelenmiştir.
 * Burada `Authorization: Bearer` başlığı KULLANILIR ve `access_token`
 * parametresi EKLENMEZ: belirteç URL'de taşındığında HTTP loglarına, hata
 * mesajlarına ve ekran görüntülerine sızar. Graph API her iki biçimi de kabul
 * eder; bu seçim yayıncı adaptörle de aynıdır.
 *
 * ── 48 SAATLIK GECİKME VE BOŞ KÜME ─────────────────────────────────────────
 * Insights verisi gecikmelidir; yeni yayınlanan bir Reels için ilk gün yanıt
 * `{"data": []}` gelir ve bu **hata değildir**. Bu yüzden:
 *   * boş küme → `unavailable: null`, tüm metrikler `null` (SIFIR DEĞİL),
 *   * eksiklik panelde `noDataCount`/`missingDataDays` olarak görünür.
 * Boş kümeyi `0`'a çevirmek, kullanıcıya "kimse izlememiş" der ve reklamı
 * yanlışlıkla başarısız saydırır.
 *
 * ── RATE LIMIT ──────────────────────────────────────────────────────────────
 * Insights BUC kotası 4800 × Impressions çağrısı / 24 saattir ve bir çağrı
 * TEK media id içindir (toplu uç nokta YOKTUR). Bu yüzden:
 *   * 12 metrik TEK çağrıda istenir (metrik başına çağrı yapılmaz),
 *   * `metric=all` kullanılmaz; kaldırılmış alanlar da çekilmez,
 *   * çağrılar SIRALI yapılır (eşzamanlı 25 çağrı = 300 BUC bir anda).
 * Gün içi sıklık kararı `AnalyticsService`'te: bugünkü satır varsa yeniden
 * çekilmez.
 */
import type { Platform } from "../../contract/index.js";
import { GRAPH_API_VERSION } from "../../media/specs/instagram.js";
import type { AnalyticsAdapter } from "../../ports/index.js";
import { asRecord, asText, createAnalyticsHttpClient } from "../http.js";
import type { AnalyticsHttpClient, AnalyticsHttpResponse } from "../http.js";
import { noScopeDecision, unavailableFromTransport } from "../errors.js";
import { INSTAGRAM_INSIGHT_SCOPES, missingScopes } from "../scopes.js";
import type { MetricQueryItem, MetricRecord } from "../types.js";
import { noScopeOrResponse } from "./shared.js";

/** Graph API kökü. Test kancasıyla değiştirilebilir. */
export const INSTAGRAM_GRAPH_BASE = "https://graph.facebook.com";

/** Reels için desteklenen ve HENÜZ KALDIRILMAMIŞ metrikler. */
export const INSTAGRAM_INSIGHT_METRICS: readonly string[] = [
  "reach",
  "views",
  "likes",
  "comments",
  "saved",
  "shares",
  "reposts",
  "total_interactions",
  "ig_reels_avg_watch_time",
  "reels_skip_rate",
  "crossposted_views",
  "facebook_views",
];

/** Insights BUC kotası: 24 saatte 4800 × Impressions çağrısı. */
export const INSTAGRAM_INSIGHTS_BUC_PER_DAY = 4800;

export interface InstagramAnalyticsOptions {
  /** Zaman kaynağı. **Varsayılanı YOKTUR** (süre hesabı test edilemez olmasın). */
  now: () => number;
  /** Testler sahte `fetch` verir; verilmezse `globalThis.fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** `metric=` listesi. Test kısaltmak için değiştirebilir. */
  metrics?: readonly string[];
  /**
   * Kapsam listesi boş geldiğinde bile istek atılsın mı? Varsayılan HAYIR:
   * eksik kapsamda yapılan her çağrı 403 döner ve BUC kotasını harcar.
   */
  ignoreScopes?: boolean;
  graphBase?: string;
  signal?: AbortSignal | null;
}

/**
 * `{ data: [ { name, values: [ { value } ] } ] }` → ham metrik sözlüğü.
 *
 * Aynı metrik için birden fazla `values` girebilir (biçim bölüntü parametresi
 * eklendiğinde). Çoklu değerde EN SON `values` girdisi alınır.
 *
 * `value` alanı eksikse `null` yazılır, `0` DEĞİL — ayrım zorunludur.
 */
export function readInsightsMetrics(json: unknown): Record<string, number | null> {
  const root = asRecord(json);
  if (root === null) return {};
  const data = Array.isArray(root["data"]) ? (root["data"] as unknown[]) : [];
  const out: Record<string, number | null> = {};
  for (const entry of data) {
    const row = asRecord(entry);
    if (row === null) continue;
    const name = asText(row["name"]);
    if (name === null) continue;
    const values = Array.isArray(row["values"]) ? (row["values"] as unknown[]) : [];
    let picked: number | null = null;
    for (const v of values) {
      const cell = asRecord(v);
      if (cell === null) continue;
      const raw = cell["value"];
      if (typeof raw === "number" && Number.isFinite(raw)) {
        picked = raw;
      } else if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
        picked = Number(raw.trim());
      }
    }
    out[name] = picked;
  }
  return out;
}

/** Gövdede ölçüm satırı yok mu? `true` ise "veri henüz yok" (hata değil). */
export function insightsHasNoData(json: unknown): boolean {
  const root = asRecord(json);
  if (root === null) return true;
  const data = root["data"];
  return data === undefined || data === null || (Array.isArray(data) && data.length === 0);
}

export class InstagramAnalyticsAdapter implements AnalyticsAdapter {
  readonly platform: Platform = "instagram";
  private readonly client: AnalyticsHttpClient;
  private readonly now: () => number;
  private readonly metrics: readonly string[];
  private readonly ignoreScopes: boolean;
  private readonly graphBase: string;
  private readonly signal: AbortSignal | null;
  private calls = 0;

  constructor(options: InstagramAnalyticsOptions) {
    this.now = options.now;
    this.client = createAnalyticsHttpClient({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      now: options.now,
    });
    this.metrics = options.metrics ?? INSTAGRAM_INSIGHT_METRICS;
    this.ignoreScopes = options.ignoreScopes ?? false;
    this.graphBase = options.graphBase ?? INSTAGRAM_GRAPH_BASE;
    this.signal = options.signal ?? null;
  }

  /** Test kancası: insights çağrısı sayısı (BUC bütçesinin göstergesi). */
  callCount(): number {
    return this.calls;
  }

  /** `/{media-id}/insights?metric=…` — belirteç YOK (başlıkta taşınır). */
  insightsUrl(mediaId: string): string {
    const base = `${this.graphBase}/${GRAPH_API_VERSION}/${encodeURIComponent(mediaId)}/insights`;
    return `${base}?${new URLSearchParams({ metric: this.metrics.join(",") }).toString()}`;
  }

  /**
   * Girişle AYNI UZUNLUKTA çıktı; `result[i]` her zaman `items[i]`.
   *
   * Çağrılar SIRALI: 25 medya için 25 çağrı üst üste gönderilirse IG hız
   * sınırına takılır ve 25 ölçümün hepsi bozulur.
   */
  async fetchMetrics(items: ReadonlyArray<MetricQueryItem>): Promise<MetricRecord[]> {
    const out: MetricRecord[] = [];
    for (const item of items) {
      out.push(await this.fetchOne(item));
    }
    return out;
  }

  private async fetchOne(item: MetricQueryItem): Promise<MetricRecord> {
    const fetchedAt = new Date(this.now()).toISOString();
    // `as const` YOK: `readonly platform: Platform` (port sözleşmesi) zaten
    // `MetricSet.platform` ile aynı tipte. `as const` bir ifadeye uygulanamaz
    // ve alanı daraltmak sözleşmeyi gevşetirdiği için gereksizdir — sınıf
    // içindeki diğer dört yerde de düz `this.platform` kullanılır.
    const base = { platform: this.platform, remoteId: item.remoteId, fetchedAt };

    const missing = this.ignoreScopes ? [] : missingScopes(this.platform, item.scopes);
    if (missing.length > 0) {
      const decision = noScopeDecision({ what: "Instagram insights", missingScopes: missing });
      return { ...base, metrics: {}, unavailable: decision.unavailable, logId: null };
    }

    const token = item.accessToken;
    if (typeof token !== "string" || token.trim() === "") {
      const decision = noScopeDecision({
        what: "Instagram insights",
        missingScopes: [...INSTAGRAM_INSIGHT_SCOPES],
      });
      return { ...base, metrics: {}, unavailable: decision.unavailable, logId: null };
    }

    this.calls += 1;
    let response: AnalyticsHttpResponse;
    try {
      response = await this.client.send({
        method: "GET",
        url: this.insightsUrl(item.remoteId),
        headers: { authorization: `Bearer ${token}` },
        ...(this.signal === null ? {} : { signal: this.signal }),
      });
    } catch (err) {
      const decision = unavailableFromTransport({
        platform: this.platform,
        what: "Instagram insights okunamadı",
        message: err instanceof Error ? err.message : String(err),
      });
      return { ...base, metrics: {}, unavailable: decision.unavailable, logId: decision.logId };
    }

    const denied = noScopeOrResponse(
      this.platform,
      "Instagram insights okunamadı",
      response,
      INSTAGRAM_INSIGHT_SCOPES,
    );
    if (denied !== null) {
      return { ...base, metrics: {}, unavailable: denied.unavailable, logId: denied.logId };
    }

    // 200 + `data: []` → "veri henüz yok". Hata DEĞİLDİR, 0 da DEĞİLDİR.
    return { ...base, metrics: readInsightsMetrics(response.json), unavailable: null, logId: null };
  }
}