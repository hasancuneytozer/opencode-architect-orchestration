/**
 * Analitik panelinin SAF mantığı. Ağ yok, React yok, `Date.now()` YOK —
 * `today`/referans günü DAİMA parametreyle gelir.
 *
 * ── ÜÇ KURAL BU DOSYANIN VAR OLMA NEDENİ ───────────────────────────────────
 *
 * 1) **`0` ile `null` AYRI GÖSTERİLİR.**
 *    `0` = "ölçüldü ve sıfır". `null` = "bu metrik yok / ölçülemedi".
 *    Aynı sütunda ikisi de "0" görünürse kullanıcı iki ayrı olguyu birleştirip
 *    "reklam işe yaramadı" der. `formatCount(null)` bu yüzden `DASH` döner ve
 *    `0` için "0" yazar.
 *
 * 2) **Yüzde değişimde temel 0 ise `—`.**
 *    0'dan herhangi bir sayıya oran matematiksel olarak tanımsızdır. "∞%"
 *    yazmak sahte bir kesinlik üretir; `null` dönmek "hesaplanamadı" demektir.
 *
 * 3) **KALDIRILMIŞ İKİ SAYAÇ YOK.**
 *    Instagram'ın kaldırdığı iki sayaç (adları `src/analytics/metrics.ts`'te)
 *    panelde HİÇBİR YERDE geçmez — ne sütun, ne etiket, ne ipucu. Gerekçe:
 *    kaldırılmış bir sayacı göstermek "ölçtük" izlenimi yaratır.
 */
import { DASH, formatPercent, trNumber } from "./format.js";
import type { Tone } from "./labels.js";
import type {
  AdditiveMetricKey,
  DataCompleteness,
  MetricUnavailableReason,
  Platform,
  RollupResult,
} from "../api/types.js";

/** YouTube view sayımı "oynatma başlangıcı"na geçtiği gün. */
export const VIEWS_COUNTING_CHANGE_DATE = "2026-08-27";

/** Varsayılan dönem genişliği (gün). */
export const DEFAULT_RANGE_DAYS = 30;

/** Sağlayıcı veri gecikmesi (gün). Instagram 48 saat gecikmelidir. */
export const ANALYTICS_DELAY_DAYS = 2;

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Tarih ──────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` mi? Takvimsel olarak var olan bir gün olmalı. */
export function isDayString(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * `days` kadar gün kaydır.
 *
 * UTC günü üzerinden çalışır (`YYYY-MM-DD` metninde saat dilimi bilgisi yoktur);
 * tarayıcının saat dilimi 30 günlük pencereyi bir gün kaydırabilir.
 */
export function shiftDay(day: string, days: number): string {
  if (!isDayString(day)) return day;
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** `[from, to]` dahil gün sayısı. `from > to` ise 0. */
export function daysInRange(from: string, to: string): number {
  if (!isDayString(from) || !isDayString(to)) return 0;
  const diff = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return diff < 0 ? 0 : Math.floor(diff / DAY_MS) + 1;
}

/** Son `days` gün: `[today - days + 1, today]`. */
export function rangeOf(days: number, today: string): { from: string; to: string } {
  const span = Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_RANGE_DAYS;
  return { from: shiftDay(today, -(span - 1)), to: today };
}

/**
 * Bir önceki, EŞİT UZUNLUKTA dönem.
 *
 * Gün sayısı iki kez hesaplanırsa (pencere elle kırpılırsa) yüzde değişim
 * yanlış çıkar; bu yüzden `from`'a göre kaydırılır.
 */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const days = Math.max(1, daysInRange(from, to));
  const prevTo = shiftDay(from, -1);
  return { from: shiftDay(prevTo, -(days - 1)), to: prevTo };
}

// ── Sayı biçimleme ─────────────────────────────────────────────────────────

const THOUSAND = 1_000;
const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

/**
 * `null` → `—`, `0` → `"0"`.
 *
 * Kompakt gösterim Türkçe birimlerle: `bin` / `mn` / `Mr`. "B" kullanılmaz çünkü
 * bu arayüzde `B` bayt anlamına gelir (`formatBytes`) ve "1,2 B" sayıyı
 * gereğinden küçük gösterir.
 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  // 10 bindan küçük sayılar tam yazılır: yuvarlama tabloyu bozmaz.
  if (abs < 10_000) return `${sign}${groupDigits(Math.round(abs))}`;
  if (abs < MILLION) return `${sign}${trNumber(abs / THOUSAND, 1)} bin`;
  if (abs < BILLION) return `${sign}${trNumber(abs / MILLION, 1)} mn`;
  return `${sign}${trNumber(abs / BILLION, 1)} Mr`;
}

/** `1.234.567` — binlik ayırıcı nokta, ondalık yok. */
export function groupDigits(value: number): string {
  const rounded = Math.round(Math.abs(value));
  const text = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return value < 0 ? `-${text}` : text;
}

/** Oran (0..1) → `"%3,4"`. `null` → `—`. */
export function formatRate(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return DASH;
  return formatPercent(ratio, 1);
}

/**
 * Yüzde değişim → `"+%12,3"` / `"−%4,1"` / `"—"`.
 *
 * `null` (temel 0 ya da ölçülmemiş) `DASH` döner; bkz. dosya başlığı.
 */
export function formatChangePct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return DASH;
  if (pct === 0) return "±%0";
  const sign = pct > 0 ? "+" : "-";
  return `${sign}%${trNumber(Math.abs(pct), 1)}`;
}

/** Yüzde değişimin yönü: renk/rozet kararı buradan. */
export function changeTone(pct: number | null | undefined): Tone {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "muted";
  if (pct > 0) return "ok";
  if (pct < 0) return "danger";
  return "muted";
}

// ── Neden metinleri ───────────────────────────────────────────────────────

export interface ReasonMeta {
  label: string;
  /** Tek cümlelik,/teknik jargon içermeyen gerekçe. */
  detail: string;
  tone: Tone;
}

/**
 * "Neden ölçülemiyor" metinleri.
 *
 * TikTok'ta `not_public` EN SIK görülen durumdur: onaysız istemci `SELF_ONLY`
 * yayın yapar ve `publicaly_available_post_id` hiç dönmez. Bu bir hata değil,
 * yayın erişim ayarının sonucudur; metin de öyle yazılmıştır.
 */
export const UNAVAILABLE_REASON_META: Record<MetricUnavailableReason, ReasonMeta> = {
  not_public: {
    label: "Herkese açık değil",
    detail: "İçerik herkese açık yayınlanmadığı için ölçüm alınamıyor (TikTok SELF_ONLY).",
    tone: "orange",
  },
  not_found: {
    label: "Platformda yok",
    detail: "İçerik platform tarafında bulunamadı; silinmiş ya da taşınmış olabilir.",
    tone: "danger",
  },
  no_scope: {
    label: "İzin eksik",
    detail: "Ölçüm için gereken izinler hesapta yok. Hesabı yeniden bağlamak gerekir.",
    tone: "warn",
  },
  provider_error: {
    label: "Sağlayıcı hatası",
    detail: "Platform tarafında hata oluştu; ölçüm alınamadı.",
    tone: "danger",
  },
  deleted: {
    label: "Silinmiş",
    detail: "İçerik platform tarafında silinmiş.",
    tone: "danger",
  },
};

export function unavailableReasonMeta(reason: string): ReasonMeta {
  const known = UNAVAILABLE_REASON_META[reason as MetricUnavailableReason];
  if (known !== undefined) return known;
  return {
    label: reason,
    detail: "Bilinmeyen bir ölçülemezlik sebebi; sunucudan gelen kod olduğu gibi gösterilir.",
    tone: "muted",
  };
}

/** `byReason` sözlüğünden yalnız sıfırdan FARKLI olanları sırayla döndürür. */
export function activeReasons(
  byReason: Partial<Record<string, number>> | null | undefined,
): Array<{ reason: MetricUnavailableReason; count: number; meta: ReasonMeta }> {
  const out: Array<{ reason: MetricUnavailableReason; count: number; meta: ReasonMeta }> = [];
  for (const [reason, count] of Object.entries(byReason ?? {})) {
    if (typeof count !== "number" || count <= 0) continue;
    out.push({
      reason: reason as MetricUnavailableReason,
      count,
      meta: unavailableReasonMeta(reason),
    });
  }
  // En çok etkilenen sebep önce: kullanıcı ilk satırda çözüm arar.
  return out.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

// ── Durum metinleri ───────────────────────────────────────────────────────

export interface StateMeta {
  label: string;
  tone: Tone;
}

/**
 * Bir günün durumu.
 *
 * Üç ayrı hâl vardır ve ÜÇÜ DE FARKLIDIR:
 *   * `unavailable.count > 0` → "N içerik ölçülemedi" (sebep listede),
 *   * `measured === 0`       → "veri bekleniyor" (sağlayıcı gecikmesi, HATA DEĞİL),
 *   * aksi halde              → "ölçüldü".
 */
export function seriesState(point: {
  items: number;
  measured: number;
  unavailable: { count: number } | null;
}): StateMeta {
  if (point.unavailable !== null && point.unavailable.count > 0) {
    return { label: `${point.unavailable.count} içerik ölçülemedi`, tone: "warn" };
  }
  if (point.measured === 0) {
    return { label: "veri bekleniyor", tone: "info" };
  }
  return { label: "ölçüldü", tone: "ok" };
}

/**
 * Veri gecikmesi notu.
 *
 * Son `delayDays` gün eksikse bu bir ARIZA DEĞİLDİR: Instagram insights 48 saat
 * gecikmelidir. Kullanıcı "eksik veri" uyarısını görüp alarmı susturmayı
 * öğrenmemeli; panel "henüz gelmedi" demeli.
 */
export function completenessNote(
  completeness: DataCompleteness | null | undefined,
): string | null {
  if (completeness === null || completeness === undefined) return null;
  if (completeness.pendingDays.length === 0) return null;
  return (
    `Son ${completeness.pendingDays.length} gün (${completeness.pendingDays.join(", ")}) ` +
    `${completeness.delayDays} günlük veri gecikmesi içinde; eksik sayılmaz.`
  );
}

/** Kart üstündeki "ölçülemeyen N içerik" rozeti metni. */
export function unavailableBadge(count: number): string {
  return `ölçülemeyen ${count} içerik`;
}

// ── Tarih kırılması uyarısı ───────────────────────────────────────────────

export interface ViewsChangeInput {
  from: string;
  to: string;
  previousFrom: string | null;
  previousTo: string | null;
  /** Sunucudan gelen sabit (panelde sabit yazılmaz). */
  changeDate?: string;
}

/**
 * Karşılaştırma 27 Ağustos 2026'yı içeriyorsa uyarı metni.
 *
 * O tarihten sonra YouTube view sayımı "oynatma başlangıcı"na sayılıyor. İki
 * dönem farklı kurallarla ölçülmüşse yüzde değişim YAPAY BİR SICRAMA gösterir
 * ve kullanıcı reklamın patladığını sanır. Karşılaştırma yapılan dönemlerden
 * BİRİ bu tarihi içeriyorsa `null` yerine uyarı döner.
 */
export function viewsChangeWarning(input: ViewsChangeInput): string | null {
  const changeDate = input.changeDate ?? VIEWS_COUNTING_CHANGE_DATE;
  const crosses = (from: string | null, to: string | null): boolean => {
    if (!isDayString(from) || !isDayString(to)) return false;
    return from <= changeDate && to >= changeDate;
  };
  const current = crosses(input.from, input.to);
  const previous = crosses(input.previousFrom, input.previousTo);
  if (!current && !previous) return null;
  const sides = [
    current ? "bu dönem" : null,
    previous ? "önceki dönem" : null,
  ].filter((v): v is string => v !== null);
  return (
    `${changeDate} tarihinde YouTube görüntülenme sayımı "oynatma başlangıcı"na sayılmaya ` +
    `başladı. ${sides.join(" ve ")} bu tarihi içerdiği için yüzde değişim ` +
    "yapay bir sıçrama gösterebilir; iki dönem aynı kuralda ölçülmüyor."
  );
}

// ── Sıralama ───────────────────────────────────────────────────────────────

interface SortablePlatform {
  platform: Platform;
  totals: Record<string, number>;
}

/**
 * Platform kartlarını oynatmaya göre sıralar.
 *
 * Kararlılık: aynı oynatma değerinde `PLATFORM_META` sırası (IG → TT → YT)
 * korunur; "sıralama rastgele değişiyor" gibi bir izlenim bırakmamak için
 * eşitlikte platform adına göre deterministik kırılım uygulanır.
 */
export function sortPlatforms<T extends SortablePlatform>(items: readonly T[]): T[] {
  const order: Record<string, number> = { instagram: 0, tiktok: 1, youtube: 2 };
  return [...items].sort((a, b) => {
    const av = a.totals["views"] ?? 0;
    const bv = b.totals["views"] ?? 0;
    if (bv !== av) return bv - av;
    return (order[a.platform] ?? 9) - (order[b.platform] ?? 9);
  });
}

/** Tablonun gösterilecek satırları: tarih yeniden eskiye. */
export function newestFirst<T extends { date: string }>(points: readonly T[]): T[] {
  return [...points].sort((a, b) => b.date.localeCompare(a.date));
}

/** Özet satırı: toplamlar `null` DEĞERLİ göz ardı edilerek toplanır. */
export function sumMeasured(values: ReadonlyArray<number | null>): number | null {
  let sum = 0;
  let seen = false;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    sum += value;
    seen = true;
  }
  return seen ? sum : null;
}

/** `rollup`un `contributors` sayesinde "ölçülmüş mü" kararı: 0 katkı → `null`. */
export function measuredValue(
  rollup: Pick<RollupResult, "totals" | "contributors">,
  key: AdditiveMetricKey,
): number | null {
  const contributors = rollup.contributors[key];
  if (typeof contributors !== "number" || contributors <= 0) return null;
  const total = rollup.totals[key];
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}
