/**
 * TikTok ANALİTİK adaptörü — `POST /v2/video/query/`.
 *
 * ── SINIR: İSTEK BAŞINA EN FAZLA 20 `video_id` ───────────────────────────────
 * Bu bir DOKÜMAN LİMİTİDİR ve adaptörün işidir; çağırane devredilmez. 25 öğe
 * gelirse adaptör `TIKTOK_VIDEO_QUERY_BATCH` (20) boyutunda PARTİLERE böler:
 *   * 25'i tek istekte göndermek 400 döndürür ve 25 ölçümün HİÇBİRİ gelmez,
 *   * partilerden biri çökerse diğerleri yine de sonuç verir.
 * Çıktı yine girişle aynı uzunlukta ve aynı sırada olur; bir öğe için alınan
 * sonuç indeksle eşleştirilir.
 *
 * ── `NOT_PUBLIC`: EN ÖNEMLİ DAVRANIŞ ─────────────────────────────────────────
 * `publicaly_available_post_id` yalnız HERKESE AÇIK yayınlanmış içerik için
 * döner. Onaylı olmayan istemci `SELF_ONLY` yayın yapar ve TikTok o videoyu
 * `videos` dizisinde **hiç döndürmez** — hata vermez, sessizce yok sayar.
 *
 * Bu yüzden "yanıtta yok" = `not_public` yazılır. Sessizce 0 yazmak, kullanıcıya
 * "reklam hiç izlenmedi" der ve o içeriğin aslında ölçülemez olduğunu gizler.
 * Bilinen belirsizlik: metrikler gecikmelidir, yeni yayınlanan herkese açık
 * video da kısa süre dizide çıkmayabilir; bu yüzden mesaj gecikmeyi de söyler
 * ve `not_public` kaydı bir sonraki `collect` turunda güncellenebilir
 * (`UNIQUE(job_id, metric_date)` → aynı gün yeniden yazılır).
 *
 * ── KAPSAM ──────────────────────────────────────────────────────────────────
 * `video.list`. Eksikse AĞ ÇAĞRISI YAPILMAZ: 403 her çağrıda döner ve 600/dk
 * hız sınırını harcar.
 *
 * ── HIZ SINIRI ──────────────────────────────────────────────────────────────
 * 600 istek/dk (kayan pencere). Partiler SIRALI gönderilir.
 *
 * ── ALAN LİSTESİ ────────────────────────────────────────────────────────────
 * Yalnız dokümanda LİSTELENEN sayaçlar istenir. `download_count` yayınlanmış
 * doğrulanmış alan listesinde olmadığı için `fields` içine YAZILMAZ —
 * desteklenmeyen bir alan 400 döndürür ve tüm partiyi düşürür.
 */
import type { Platform } from "../../contract/index.js";
import type { AnalyticsAdapter } from "../../ports/index.js";
import { asRecord, asText, createAnalyticsHttpClient } from "../http.js";
import type { AnalyticsHttpClient, AnalyticsHttpResponse } from "../http.js";
import { noScopeDecision, unavailableFromTransport } from "../errors.js";
import { TIKTOK_LIST_SCOPE, missingScopes } from "../scopes.js";
import type { MetricQueryItem, MetricRecord } from "../types.js";
import { noScopeOrResponse, tiktokLogId } from "./shared.js";

/** TikTok açık API kökü. Test kancasıyla değiştirilebilir. */
export const TIKTOK_OPEN_API_BASE = "https://open.tiktokapis.com";

/** `video/query` yolu (SONDAKİ EĞİRME ÇİZGİSİ DOKÜMANDA ZORUNLUDUR). */
export const TIKTOK_VIDEO_QUERY_PATH = "/v2/video/query/";

/** Doküman limiti: istek başına en fazla 20 `video_id`. */
export const TIKTOK_VIDEO_QUERY_BATCH = 20;

/** Doküman hız sınırı: dakikada 600 istek (kayan pencere). */
export const TIKTOK_RATE_LIMIT_PER_MIN = 600;

/** İstenen alanlar: kimlik + dört sayaç. */
export const TIKTOK_VIDEO_FIELDS: readonly string[] = [
  "id",
  "view_count",
  "like_count",
  "comment_count",
  "share_count",
];

/** 20'lik partilere böler. Girdi boşsa boş dizi. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Number.isFinite(size) && size > 0 ? Math.floor(size) : TIKTOK_VIDEO_QUERY_BATCH;
  for (let i = 0; i < items.length; i += step) {
    out.push(items.slice(i, i + step));
  }
  return out;
}

export interface TiktokAnalyticsOptions {
  /** Zaman kaynağı. **Varsayılanı YOKTUR.** */
  now: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Parti boyutu (varsayılan 20 = doküman limiti). */
  batchSize?: number;
  ignoreScopes?: boolean;
  apiBase?: string;
  signal?: AbortSignal | null;
}

/**
 * `POST /v2/video/query/` gövdesi.
 *
 * `filters.video_ids` DOKÜMANDA MAKS 20 eleman kabul eder; sınırı aşmak 400
 * döndürür. `fields` boş bırakılırsa sağlayıcı TÜM alanları döner ve
 * kaldırılmış/hesaplanmayan alanlar da gelir.
 */
export function buildVideoQueryBody(
  videoIds: readonly string[],
  fields: readonly string[] = TIKTOK_VIDEO_FIELDS,
): Record<string, unknown> {
  return { filters: { video_ids: [...videoIds] }, fields: [...fields] };
}

/**
 * Yanıttan `id → ham metrikler`.
 *
 * `videos` dizisinde olmayan kimlikler burada YOKTUR; onları `not_public`
 * saymak çağırana bırakılır (`videos` sözlüğü yalnız dönenleri içerir).
 */
export function readVideoMetrics(json: unknown): Record<string, Record<string, number | null>> {
  const root = asRecord(json);
  if (root === null) return {};
  const data = asRecord(root["data"]);
  const videos = data === null ? [] : data["videos"];
  if (!Array.isArray(videos)) return {};
  const out: Record<string, Record<string, number | null>> = {};
  for (const entry of videos) {
    const row = asRecord(entry);
    if (row === null) continue;
    const id = asText(row["id"]);
    if (id === null) continue;
    const metrics: Record<string, number | null> = {};
    for (const key of ["view_count", "like_count", "comment_count", "share_count"]) {
      const raw = row[key];
      if (raw === undefined) continue;
      if (typeof raw === "number" && Number.isFinite(raw)) metrics[key] = raw;
      else if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
        metrics[key] = Number(raw.trim());
      } else if (raw === null) {
        // Alan geldi ama boş: "veri yok" 0 DEĞİLDİR.
        metrics[key] = null;
      }
    }
    out[id] = metrics;
  }
  return out;
}

export class TiktokAnalyticsAdapter implements AnalyticsAdapter {
  readonly platform: Platform = "tiktok";
  private readonly client: AnalyticsHttpClient;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly ignoreScopes: boolean;
  private readonly apiBase: string;
  private readonly signal: AbortSignal | null;
  private calls = 0;

  constructor(options: TiktokAnalyticsOptions) {
    this.now = options.now;
    this.client = createAnalyticsHttpClient({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      now: options.now,
    });
    this.batchSize = options.batchSize ?? TIKTOK_VIDEO_QUERY_BATCH;
    this.ignoreScopes = options.ignoreScopes ?? false;
    this.apiBase = options.apiBase ?? TIKTOK_OPEN_API_BASE;
    this.signal = options.signal ?? null;
  }

  /** Test kancası: yapılan HTTP çağrısı sayısı = parti sayısı. */
  callCount(): number {
    return this.calls;
  }

  queryUrl(): string {
    return `${this.apiBase}${TIKTOK_VIDEO_QUERY_PATH}`;
  }

  async fetchMetrics(items: ReadonlyArray<MetricQueryItem>): Promise<MetricRecord[]> {
    const fetchedAt = new Date(this.now()).toISOString();
    const results = new Array<MetricRecord>(items.length);

    // Kimlik/izin eksikliği ve eksik belirteç PARTİYE GİRMEZ: her öğe için
    // `no_scope` yazılır ve AĞ ÇAĞRISI YAPILMAZ.
    const usable: number[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item === undefined) continue;
      const missing = this.ignoreScopes ? [] : missingScopes(this.platform, item.scopes);
      const tokenOk = typeof item.accessToken === "string" && item.accessToken.trim() !== "";
      if (missing.length > 0 || !tokenOk) {
        results[i] = {
          platform: this.platform,
          remoteId: item.remoteId,
          fetchedAt,
          metrics: {},
          unavailable: noScopeDecision({
            what: "TikTok video/query",
            missingScopes: missing.length > 0 ? missing : [TIKTOK_LIST_SCOPE],
          }).unavailable,
          logId: null,
        };
        continue;
      }
      usable.push(i);
    }

    const ordered = usable.map((i) => {
      const item = items[i];
      return item === undefined ? undefined : { index: i, item };
    }).filter((x): x is { index: number; item: MetricQueryItem } => x !== undefined);

    for (const part of chunk(ordered, this.batchSize)) {
      const ids = part.map((p) => p.item.remoteId);
      const token = part[0]?.item.accessToken ?? null;

      this.calls += 1;
      let response: AnalyticsHttpResponse;
      try {
        response = await this.client.send({
          method: "POST",
          url: this.queryUrl(),
          headers: {
            authorization: `Bearer ${token ?? ""}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(buildVideoQueryBody(ids)),
          ...(this.signal === null ? {} : { signal: this.signal }),
        });
      } catch (err) {
        const decision = unavailableFromTransport({
          platform: this.platform,
          what: "TikTok video/query okunamadı",
          message: err instanceof Error ? err.message : String(err),
        });
        for (const p of part) {
          results[p.index] = {
            platform: this.platform,
            remoteId: p.item.remoteId,
            fetchedAt,
            metrics: {},
            unavailable: decision.unavailable,
            logId: decision.logId,
          };
        }
        continue;
      }

      const denied = noScopeOrResponse(
        this.platform,
        "TikTok video/query okunamadı",
        response,
        [TIKTOK_LIST_SCOPE],
      );
      if (denied !== null) {
        const logId = denied.logId ?? tiktokLogId(response.json);
        for (const p of part) {
          results[p.index] = {
            platform: this.platform,
            remoteId: p.item.remoteId,
            fetchedAt,
            metrics: {},
            // `noScopeOrResponse` yalnız KÖK `log_id`'yi okur; TikTok gövdesi
            // `error.log_id` içinde gelir. Üst düzey `logId` burada düzeltiliyor
            // ama zarf eski `null`'ını taşıyor kalırdı — panelde destek talebine
            // yapıştırılan metinde `log_id` görünmez olurdu. İkisi aynı olmalı.
            unavailable: { ...denied.unavailable, logId },
            logId,
          };
        }
        continue;
      }

      const byVideo = readVideoMetrics(response.json);
      const logId = tiktokLogId(response.json);

      for (const p of part) {
        const found = byVideo[p.item.remoteId];
        if (found !== undefined) {
          results[p.index] = {
            platform: this.platform,
            remoteId: p.item.remoteId,
            fetchedAt,
            metrics: found,
            unavailable: null,
            logId,
          };
          continue;
        }
        // Yanıt 200 ama bu kimlik DÖNMEDİ. `publicaly_available_post_id` yalnız
        // herkese açık yayınlanmış içerik için döner.
        results[p.index] = {
          platform: this.platform,
          remoteId: p.item.remoteId,
          fetchedAt,
          metrics: {},
          unavailable: {
            reason: "not_public",
            message:
              "TikTok bu videoyu döndürmedi. Metrikler yalnız `publicaly_available_post_id` " +
              "olan (herkese açık yayınlanmış) içerik için geçerlidir; `SELF_ONLY` yayında " +
              "ölçüm mümkün değildir. Metriklerin gecikmeli olması da (yeni yayınlanan " +
              "içerik kısa süre listede çıkmayabilir) bir sonraki turda doğrulanır.",
            logId,
          },
          logId,
        };
      }
    }

    // Kapsam dışı kalan indeksler (pratikte yok) boş ölçümle doldurulur ki
    // sözleşme "aynı uzunluk" ihlal edilmesin.
    for (let i = 0; i < results.length; i += 1) {
      const existing = results[i];
      if (existing !== undefined) continue;
      const item = items[i];
      results[i] = {
        platform: this.platform,
        remoteId: item === undefined ? "" : item.remoteId,
        fetchedAt,
        metrics: {},
        unavailable: null,
        logId: null,
      };
    }
    return results;
  }
}