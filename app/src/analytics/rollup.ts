/**
 * Toplama (rollup) — saf fonksiyonlar. Ağ yok, veritabanı yok, `Date.now()` YOK.
 *
 * ── EN ÖNEMLİ KURAL: GÜNLÜK ANLIK GÖRÜNTÜLER TOPLANMAZ ──────────────────────
 * IG insights ve TikTok `video/query` bir videonun **ÖMÜR BOYU** sayaçlarını
 * döndürür (dünkü değeri değil, bugüne kadarki toplamı). YouTube Analytics ise
 * verilen tarih aralığının toplamını döndürür. Yani satırlar gün gün
 * FARKLI ÖLÇÜM DEĞİL, AYNI ÖLÇÜMÜN ZAMAN İÇİNDEKİ FARKLI ANLIK
 * GÖRÜNTÜSÜDÜR.
 *
 * Bu yüzden `rows.reduce((s, r) => s + r.metrics.views)` YANLIŞTIR: 3 günlük
 * tablo 300/450/600 gösteriyorsa toplam 1350 yazarsın, gerçekte 600 kişi izlemiş.
 * Doğru toplam, her işin KENDİ EN SON değerinin toplamıdır. Bu yüzden:
 *   - `totals` = Σ (iş başına son değer)
 *   - gün gün satırlar toplanmaz.
 *
 * ── ÜÇ AYRI "VERİ YOK" DURUMU ───────────────────────────────────────────────
 * Bunları birbirine karıştırmak kullanıcıya YANLIŞ teşhis verir:
 *   1) `unavailable` dolu  → "ölçülemiyor" (kapsam yok / herkese açık değil)
 *   2) satır var, tüm değerler `null` → "daha gelmedi" (IG 48 saat gecikmesi)
 *   3) satır var, değer `0`        → "ölçüldü ve sıfır"
 * Üçü ayrı sayaçtır: `unavailableCount`, `noDataCount`, `contributors`.
 *
 * ── `DEĞER EKLEMEYEN` ÖLÇÜMLER ─────────────────────────────────────────────
 * `rollup` yalnız `ADDITIVE_METRIC_KEYS` kümesini toplar. Ortalama süre,
 * atlama oranı gibi değerler toplanmaz; ortalama+ortalama "ortalama" değildir.
 */
import { ADDITIVE_METRIC_KEYS, dayCount, isMetricDate, safeDivide } from "./metrics.js";
import type { AdditiveMetricKey } from "./metrics.js";
import type { DeprecatedMetric, MetricUnavailable, MetricUnavailableReason } from "./types.js";
import { METRIC_UNAVAILABLE_REASONS } from "./types.js";

// ── Girdi ───────────────────────────────────────────────────────────────────

/** Toplama için gereken EN AZ satır şekli. `MetricsRepo` kayıtları yapısal
 *  olarak bu şekle uyar (fazla alan sorun değildir). */
export interface RollupRow {
  jobId: string;
  contentId?: string | null;
  platform?: string | null;
  metricDate: string;
  metrics: Record<string, number | null>;
  unavailable: MetricUnavailable | null;
  deprecated?: readonly DeprecatedMetric[];
  unknown?: readonly string[];
}

export type RollupScope = "content" | "platform";

export interface RollupOptions {
  /**
   * `content`: satırlar TEK bir içeriğe ait; `latest` o içeriğin son günkü
   * değerleridir.
   * `platform`: satırlar birçok içeriğe ait olabilir; `latest` o günün satırlarının
   * TOPLAMLIDIR (yalnız toplanabilir anahtarlar için).
   */
  scope: RollupScope;
  /** `YYYY-MM-DD` (dahil). Verilmezse satırların en küçük günü. */
  from?: string;
  /** `YYYY-MM-DD` (dahil). Verilmezse satırların en büyük günü. */
  to?: string;
  /**
   * Sağlayıcının veri gecikmesi (gün). Instagram 48 saat gecikmelidir, bu yüzden
   * varsayılan 2. Pencere sonundaki bu kadar gün "henüz gelmesi beklenmiyor"
   * sayılır ve `completeness.complete` onları eksiklik saymaz.
   */
  delayDays?: number;
}

/** Varsayılan gecikme: IG verisi 48 saat gecikmeli. */
export const DEFAULT_DELAY_DAYS = 2;

// ── Çıktı ───────────────────────────────────────────────────────────────────

export interface DataCompleteness {
  from: string;
  to: string;
  /** Pencere genişliği (gün). */
  expectedDays: number;
  /** En az bir ÖLÇÜLEN satır bulunan gün sayısı. */
  measuredDays: number;
  /** Ölçüm olmayan gün sayısı (gecikme beklentisi HARİÇ değil, ham sayı). */
  missingDataDays: number;
  /** Beklenen gecikme penceresi (gün). */
  delayDays: number;
  /** Pencere sonundaki, veri gecikmesi nedeniyle eksik sayılmayan günler. */
  pendingDays: string[];
  /** Gecikme beklenen günler dışında hiçbir gün eksik değilse true. */
  complete: boolean;
}

export interface MetricRates {
  /** `saves / views` — niyet sinyalinin en güçlü göstergesi. */
  saveRate: number | null;
  /** `shares / views`. */
  shareRate: number | null;
  /** `interactions / views`. */
  interactionRate: number | null;
}

export interface RollupResult {
  scope: RollupScope;
  from: string;
  to: string;
  /** Pencere içinde ölçüm bulunan EN SON gün. `null` = hiç ölçülmedi. */
  latestDate: string | null;
  latest: Record<string, number | null>;
  totals: Record<AdditiveMetricKey, number>;
  /** Her toplamın dayandığı iş sayısı. "Kaç iş bu sayıya katkı verdi?" */
  contributors: Record<AdditiveMetricKey, number>;
  rates: MetricRates;
  /** Pencere içinde görülen ayrı iş sayısı. */
  itemCount: number;
  /** En son satırı gerçek bir ölçüm içeren iş sayısı. */
  measuredCount: number;
  /** En son satırı var ama TÜM değerleri `null` olan iş (veri gecikmesi). */
  noDataCount: number;
  /** En son satırı "ölçülemiyor" diyen iş sayısı. */
  unavailableCount: number;
  /** Sebebe göre kırılım — panelde "neden ölçülemiyor" listesi. */
  unavailableReasons: Record<MetricUnavailableReason, number>;
  /** Eşlenmemiş ham adlar (birleşik, sıralı). Sessizce kaybolmaz. */
  unknown: string[];
  /** Kullanımdan kaldırılmış metrikler; hesaplamaya girmedi. */
  deprecated: DeprecatedMetric[];
  completeness: DataCompleteness;
}

// ── Yardımcılar ─────────────────────────────────────────────────────────────

function zeroTotals(): Record<AdditiveMetricKey, number> {
  return Object.fromEntries(ADDITIVE_METRIC_KEYS.map((k) => [k, 0])) as Record<
    AdditiveMetricKey,
    number
  >;
}

function zeroContributors(): Record<AdditiveMetricKey, number> {
  return Object.fromEntries(ADDITIVE_METRIC_KEYS.map((k) => [k, 0])) as Record<
    AdditiveMetricKey,
    number
  >;
}

function zeroReasons(): Record<MetricUnavailableReason, number> {
  return Object.fromEntries(METRIC_UNAVAILABLE_REASONS.map((r) => [r, 0])) as Record<
    MetricUnavailableReason,
    number
  >;
}

/** Satır gerçek bir ölçüm içeriyor mu? "değer var" = en az biri `null` DEĞİL. */
function rowMeasures(row: RollupRow): boolean {
  if (row.unavailable !== null) return false;
  return Object.values(row.metrics).some((v) => v !== null);
}

function value(row: RollupRow, key: AdditiveMetricKey): number | null {
  const raw = row.metrics[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

// ── Toplama ─────────────────────────────────────────────────────────────────

/**
 * Satırları tek bir toplama indirger.
 *
 * Boş satır dizisi de geçerli bir girdidir: `totals` sıfır, `latestDate`
 * `null`, `unavailableCount` 0 döner. "Hiç veri yok" ile "ölçülemedi" ayrımı
 * bozulmaz — ayrım `latestDate === null` ile `unavailableCount > 0` arasındadır.
 */
export function rollup(rows: readonly RollupRow[], opts: RollupOptions): RollupResult {
  const delayDays = opts.delayDays === undefined ? DEFAULT_DELAY_DAYS : Math.max(0, Math.trunc(opts.delayDays));

  // Pencere: verilmişse o, yoksa satırların kapsadığı gün aralığı.
  let from = opts.from ?? "";
  let to = opts.to ?? "";
  if (from === "" || to === "") {
    const dates = rows.map((r) => r.metricDate).filter((d) => isMetricDate(d)).sort();
    const min = dates[0];
    const max = dates[dates.length - 1];
    if (from === "") from = min ?? "";
    if (to === "") to = max ?? "";
  }

  const empty: RollupResult = {
    scope: opts.scope,
    from,
    to,
    latestDate: null,
    latest: {},
    totals: zeroTotals(),
    contributors: zeroContributors(),
    rates: { saveRate: null, shareRate: null, interactionRate: null },
    itemCount: 0,
    measuredCount: 0,
    noDataCount: 0,
    unavailableCount: 0,
    unavailableReasons: zeroReasons(),
    unknown: [],
    deprecated: [],
    completeness: {
      from,
      to,
      expectedDays: from !== "" && to !== "" ? dayCount(from, to) : 0,
      measuredDays: 0,
      missingDataDays: from !== "" && to !== "" ? dayCount(from, to) : 0,
      delayDays,
      pendingDays: [],
      complete: rows.length === 0,
    },
  };

  if (rows.length === 0 || from === "" || to === "") return empty;

  // Pencere dışı satırlar hesaba KATILMAZ: `missingDataDays` yanlış çıkardı.
  const windowed = rows.filter((r) => r.metricDate >= from && r.metricDate <= to);
  if (windowed.length === 0) return empty;

  // İş başına EN SON satır. Aynı gün iki satır olamaz (UNIQUE), ama yine de
  // gün eşitse son yazan kazanır: toplu yazım sırasını bilmiyoruz.
  const latestByJob = new Map<string, RollupRow>();
  for (const row of windowed) {
    const seen = latestByJob.get(row.jobId);
    if (seen === undefined || row.metricDate >= seen.metricDate) latestByJob.set(row.jobId, row);
  }

  const totals = zeroTotals();
  const contributors = zeroContributors();
  const unavailableReasons = zeroReasons();
  const unknownSet = new Set<string>();
  const deprecatedByName = new Map<string, DeprecatedMetric>();
  const latestSum: Record<string, number | null> = {};
  let measuredCount = 0;
  let noDataCount = 0;
  let unavailableCount = 0;

  for (const row of latestByJob.values()) {
    for (const key of ADDITIVE_METRIC_KEYS) {
      const v = value(row, key);
      if (v === null) continue;
      totals[key] += v;
      contributors[key] += 1;
      if (opts.scope === "platform") {
        latestSum[key] = (latestSum[key] ?? 0) + v;
      }
    }

    if (rowMeasures(row)) {
      measuredCount += 1;
      // `scope='content'` için `latest` = bu satırın tamamı.
      if (opts.scope === "content") {
        Object.assign(latestSum, row.metrics);
      }
    } else if (row.unavailable !== null) {
      unavailableCount += 1;
      unavailableReasons[row.unavailable.reason] += 1;
    } else {
      // Satır var, ölçülemiyor YAZMAMIŞ ama hiçbir değer de yok → veri gecikmesi.
      noDataCount += 1;
    }

    for (const name of row.unknown ?? []) unknownSet.add(name);
    for (const dep of row.deprecated ?? []) deprecatedByName.set(dep.providerName, dep);
  }

  // Ölçülen günler: "en az bir satır ölçüm içeriyor" olan günler.
  const measuredDays = new Set<string>();
  for (const row of windowed) {
    if (rowMeasures(row)) measuredDays.add(row.metricDate);
  }

  const latestDate = [...measuredDays].sort().pop() ?? null;
  const completeness = completenessOf(from, to, measuredDays, delayDays);

  return {
    scope: opts.scope,
    from,
    to,
    latestDate,
    latest: latestSum,
    totals,
    contributors,
    rates: {
      saveRate: safeDivide(totals.saves, totals.views),
      shareRate: safeDivide(totals.shares, totals.views),
      interactionRate: safeDivide(totals.interactions, totals.views),
    },
    itemCount: latestByJob.size,
    measuredCount,
    noDataCount,
    unavailableCount,
    unavailableReasons,
    unknown: [...unknownSet].sort(),
    deprecated: [...deprecatedByName.values()].sort((a, b) =>
      a.providerName.localeCompare(b.providerName),
    ),
    completeness,
  };
}

/**
 * Veri tamlığı.
 *
 * `pendingDays` — pencerenin SON `delayDays` kadar günü. Instagram verisi 48
 * saat gecikmeli olduğu için son iki günün eksik olması bir HATA DEĞİLDİR;
 * eksik sayılırsa panel her gün "eksik veri" uyarısı verir ve kullanıcı
 * gerçek bir sorun olmadığı halde alarmı susturmayı öğrenir.
 */
function completenessOf(
  from: string,
  to: string,
  measuredDays: ReadonlySet<string>,
  delayDays: number,
): DataCompleteness {
  const expectedDays = dayCount(from, to);
  const measured = [...measuredDays].filter((d) => d >= from && d <= to);
  const missing: string[] = [];
  const cursor = new Date(Date.parse(`${from}T00:00:00Z`));
  const last = Date.parse(`${to}T00:00:00Z`);
  const pendingDates: string[] = [];
  for (let t = cursor.getTime(); t <= last; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (measuredDays.has(day)) continue;
    // Son `delayDays` gün veri gecikmesi içindedir.
    const daysFromEnd = Math.floor((last - t) / 86_400_000);
    if (daysFromEnd < delayDays) pendingDates.push(day);
    else missing.push(day);
  }
  return {
    from,
    to,
    expectedDays,
    measuredDays: measured.length,
    missingDataDays: missing.length,
    delayDays,
    pendingDays: pendingDates,
    complete: missing.length === 0,
  };
}

// ── Dönem karşılaştırması ───────────────────────────────────────────────────

export interface MetricDelta {
  key: string;
  current: number | null;
  previous: number | null;
  /** `current - previous`. Biri `null` ise `null`. */
  delta: number | null;
  /** Yüzde değişim. `previous` 0 veya `null` ise `null` — bölme koruması. */
  changePct: number | null;
}

export interface PeriodComparison {
  current: { from: string; to: string; totals: Record<AdditiveMetricKey, number>; rates: MetricRates };
  previous: { from: string; to: string; totals: Record<AdditiveMetricKey, number>; rates: MetricRates };
  deltas: MetricDelta[];
  /** Kaç metrik arttı/azaldı/eşit kaldı/hesaplanamadı. */
  direction: { up: number; down: number; flat: number; unknown: number };
}

/**
 * Yüzde değişim. **Temel (önceki) dönem 0 ise `null`.**
 *
 * Neden `null` ve neden sonsuz değil: temel 0 iken "artış yüzdesi" matematiksel
 * olarak tanımsızdır (0'dan herhangi bir sayıya oran sonsuz). `Infinity`
 * üretmek panelde "∞%" gösterir ve kullanıcıya sahte bir kesinlik verir.
 * Aynı sebeple `previous === null` de `null` döner: "ölçülmemiş" ile "sıfır"
 * aynı sayılamaz.
 */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return Number.isFinite(pct) ? pct : null;
}

const RATE_KEYS = ["saveRate", "shareRate", "interactionRate"] as const;

/** İki dönemin toplam ve oranlarını karşılaştırır. */
export function comparePeriods(current: RollupResult, previous: RollupResult): PeriodComparison {
  const deltas: MetricDelta[] = [];

  for (const key of ADDITIVE_METRIC_KEYS) {
    const now = current.totals[key];
    const before = previous.totals[key];
    deltas.push({
      key,
      current: now,
      previous: before,
      delta: now - before,
      changePct: percentChange(now, before),
    });
  }
  for (const key of RATE_KEYS) {
    const now = current.rates[key];
    const before = previous.rates[key];
    deltas.push({
      key,
      current: now,
      previous: before,
      delta: now !== null && before !== null ? now - before : null,
      changePct: percentChange(now, before),
    });
  }

  const direction = { up: 0, down: 0, flat: 0, unknown: 0 };
  for (const d of deltas) {
    if (d.delta === null) {
      direction.unknown += 1;
      continue;
    }
    if (d.delta > 0) direction.up += 1;
    else if (d.delta < 0) direction.down += 1;
    else direction.flat += 1;
  }

  return {
    current: { from: current.from, to: current.to, totals: current.totals, rates: current.rates },
    previous: {
      from: previous.from,
      to: previous.to,
      totals: previous.totals,
      rates: previous.rates,
    },
    deltas,
    direction,
  };
}