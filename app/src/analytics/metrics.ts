/**
 * Metrik NORMALLEŞTİRME — saf fonksiyonlar. Ağ yok, veritabanı yok, `Date.now()`
 * YOK. Zaten hesaplanmış `metricDate`/`fetchedAt` `ref` ile gelir.
 *
 * ── BU DOSYANIN VAR OLMA NEDENİ ─────────────────────────────────────────────
 * Üç sağlayıcı aynı soruya üç farklı adla cevap veriyor: "kaç kişi izledi?"
 *   IG       → `reach` / `views` / `plays`(KALDIRILDI) / `impressions`(KALDIRILDI)
 *   TikTok   → `view_count`
 *   YouTube  → `views`
 * Ham adı tabloya yazmak, üç platformu karşılaştırmayı imkânsız kılar ve
 * her yeni özellikte üç ayrı `if (platform === ...)` dalı üretir. Burada
 * TEK kanonik ad kümesi vardır; her platformun ham adı bir kez eşlenir.
 *
 * ── KANONİK AD KÜMESI ───────────────────────────────────────────────────────
 * Kural: bir kanonik ad ya (a) üç platformda da anlamı AYNI olan bir sayaç,
 * ya da (b) tek bir platforma ait ve o zaman da o platformun adıyla anılan
 * bir sayıdır. İkinci grup toplama GİRMEZ (bkz. `ADDITIVE_METRIC_KEYS`).
 *
 * ── BİRİMİ FARKLI OLAN İKİ SÜRE ─────────────────────────────────────────────
 *   `avg_watch_time_sec` → ORTALAMA izleme süresi, saniye (IG `ig_reels_avg_watch_time`,
 *                          YouTube `averageViewDuration`). İkisi de ortalama,
 *                          ikisi de saniye → TEK ad.
 *   `watch_time_min`     → TOPLAM izlenen dakika (YouTube `estimatedMinutesWatched`).
 *                          Bu bir TOPLAM'dır, ortalamayla aynı ölçekte değildir;
 *                          ikisini birleştirmek "ortalama + toplam" hatasıdır.
 *   IG `ig_reels_avg_watch_time` saniye cinsindendir (ortalama), bu yüzden
 *   `avg_watch_time_sec`'e gider. Dakikaya çevirmek BİLEREK yapılmaz: çevrim
 *   bir daha yapılsa geri döner ve "3 sn" gibi ondalıklı ortalama değerleri
 *   dakikaya çevrilince okunabilirliğini yitirir.
 *
 * ── KALDIRILMIŞ METRİKLER ───────────────────────────────────────────────────
 *   IG `plays`      → 21 Nisan 2025'te kaldırıldı.
 *   IG `impressions`→ 2 Temmuz 2024 sonrası medya için kaldırıldı.
 * Bunlar kanonik kümenin DIŞINDA tutulur, `deprecated[]` içine yazılır ve
 * `rollup`'a HİÇ GİRMEZ. Kanonik tabloya eklenseydi, geçmiş kodun kırılması
 * ve panelde "ölçülemeyen metrik" görünürken hesapta kullanılması aynı anda
 * olurdu.
 *
 * ── `0` ile `null` ──────────────────────────────────────────────────────────
 * `null` = "sağlayıcı bu alanı vermedi". `0` = "sağlayıcı verdi, değeri sıfır".
 * Birleştirilirse "kimse izlememiş" ile "henüz ölçülmedi" aynı görünür ve
 * panel kullanıcıya YANLIŞ "reklam işe yaramadı" der. Ayrım burada korunur
 * ve `tests` ile kilitlenir.
 */
import { isValidTimeZone, tzOffsetMs } from "../contract/index.js";
import type { Platform } from "../contract/index.js";
import type {
  DeprecatedMetric,
  MetricUnavailable,
  NormalizedEnvelope,
} from "./types.js";

/** Panelde ve hesapta kullanılan kanonik metrik adları. */
export const CANONICAL_METRIC_NAMES = [
  // Dağıtım
  "reach",
  "views",
  // Etkileşim
  "interactions",
  "likes",
  "comments",
  "saves",
  "shares",
  "reposts",
  // Niyet (en güçlü sinyaller)
  "downloads",
  // Süre / kalite
  "avg_watch_time_sec",
  "watch_time_min",
  "skip_rate",
  "avg_view_percent",
  "watch_ratio",
  // Büyüme
  "subs_gained",
  "dislikes",
  // Platforma özel, bilgilendirme amaçlı (toplama GİRMEZ)
  "crossposted_views",
  "facebook_views",
] as const;
export type CanonicalMetricName = (typeof CANONICAL_METRIC_NAMES)[number];

const CANONICAL_SET: ReadonlySet<string> = new Set<string>(CANONICAL_METRIC_NAMES);

/**
 * Toplama giren metrikler.
 *
 * NEDEN BU ALT KÜME: bunlar "birikimli" sayaçlardır (bir videonun ömür boyu
 * toplamı) ve panelde "toplam reach / toplam views" diye okunur. Diğer
 * kanonik adlar ya bir ORTALAMADIR (`avg_watch_time_sec`, `skip_rate`) ya da
 * bir dönem toplamıyla karıştırıldığında anlam kaybettiren bilgilendirme
 * alanlarıdır (`crossposted_views`, `facebook_views`). Ortalamaları toplamak
 * "ortalama izleme süresi 180 saniye" gibi anlamsız bir sayı üretir.
 */
export const ADDITIVE_METRIC_KEYS = [
  "reach",
  "views",
  "interactions",
  "likes",
  "comments",
  "saves",
  "shares",
] as const;
export type AdditiveMetricKey = (typeof ADDITIVE_METRIC_KEYS)[number];

export function isCanonicalMetricName(name: string): name is CanonicalMetricName {
  return CANONICAL_SET.has(name);
}

// ── Platform başına ad eşlemeleri ───────────────────────────────────────────

/**
 * IG ham adı → kanonik ad. Anahtarlar küçük harf KABUL EDİLMEZ: Graph API
 * alan adları büyük/küçük harf duyarlı değildir ama sessizce küçültmek, yeni
 * bir alanın sessizce `unknown`'a düşmesine yol açardı.
 */
export const INSTAGRAM_METRIC_ALIASES: ReadonlyMap<string, CanonicalMetricName> = new Map([
  ["reach", "reach"],
  ["views", "views"],
  ["likes", "likes"],
  ["comments", "comments"],
  ["saved", "saves"],
  ["shares", "shares"],
  ["reposts", "reposts"],
  ["total_interactions", "interactions"],
  ["ig_reels_avg_watch_time", "avg_watch_time_sec"],
  ["reels_skip_rate", "skip_rate"],
  ["crossposted_views", "crossposted_views"],
  ["facebook_views", "facebook_views"],
]);

/** TikTok ham adı → kanonik ad. */
export const TIKTOK_METRIC_ALIASES: ReadonlyMap<string, CanonicalMetricName> = new Map([
  ["view_count", "views"],
  ["like_count", "likes"],
  ["comment_count", "comments"],
  ["share_count", "shares"],
  ["download_count", "downloads"],
]);

/**
 * YouTube ham adı → kanonik ad.
 *
 * DİKKAT: YouTube Analytics **paylaşım (shares)** sayısı VERMEZ. Bu bir eksik
 * kusur değil, API'nin sunmadığı bir metriktir. YouTube satırında `shares`
 * YOKTUR; panelde "0" değil `null` görünmesi gerekir ve bu yüzden buraya
 * sahte bir eşleme UYDURULMAZ.
 */
export const YOUTUBE_METRIC_ALIASES: ReadonlyMap<string, CanonicalMetricName> = new Map([
  ["views", "views"],
  ["likes", "likes"],
  ["comments", "comments"],
  ["dislikes", "dislikes"],
  ["subscribersGained", "subs_gained"],
  ["estimatedMinutesWatched", "watch_time_min"],
  ["averageViewDuration", "avg_watch_time_sec"],
  ["averageViewPercentage", "avg_view_percent"],
  ["audienceWatchRatio", "watch_ratio"],
]);

const ALIASES: Readonly<Record<Platform, ReadonlyMap<string, CanonicalMetricName>>> = {
  instagram: INSTAGRAM_METRIC_ALIASES,
  tiktok: TIKTOK_METRIC_ALIASES,
  youtube: YOUTUBE_METRIC_ALIASES,
};

// ── Kaldırılmış metrikler ───────────────────────────────────────────────────

/** Platform başına kaldırılmış ham adlar ve gerekçeleri. */
const DEPRECATED: Readonly<
  Record<Platform, ReadonlyMap<string, string>>
> = {
  instagram: new Map([
    [
      "plays",
      "Instagram `plays` metriği 21 Nisan 2025'te kaldırıldı. Kullanım yerine `views` okunmalı.",
    ],
    [
      "impressions",
      "Instagram `impressions` metriği 2 Temmuz 2024 sonrası medya için kaldırıldı. Yerine `reach`/`views` okunmalı.",
    ],
  ]),
  // TikTok ve YouTube'da kaldırılmış sayaç YOKTUR; eşlemeleri boş.
  tiktok: new Map(),
  youtube: new Map(),
};

// ── Değer okuma ─────────────────────────────────────────────────────────────

/** Sağlayıcı ham değeri. Sayı metni de kabul edilir (YouTube bazı yanıtlarda
 *  sayıyı metin verir). `undefined` ve `null` "veri yok"tur. */
export type RawMetricValue = number | string | boolean | null | undefined;

export type RawMetrics = Readonly<Record<string, RawMetricValue>>;

/**
 * Ham değeri sayıya çevirir.
 *
 * DÖNÜŞ: `number | null` — `null` = "okunamadı". `0` DEĞİLDİR ve
 * `0` olarak kalır. Boş metin (`""`) `null`'dur: YouTube Analytics
 * kırpılmış sayıda boş hücre döner ve bunu `0` saymak "ölçülmedi"yi
 * "sıfır"a çevirirdi.
 */
export function readNumber(value: RawMetricValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Değer "sayıya çevrilebiliyor mu"? `unknown` ayrımı için ayrı soru. */
function isNumericValue(value: RawMetricValue): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return false;
    return Number.isFinite(Number(trimmed));
  }
  return false;
}

// ── Kanonik ad sorguları ────────────────────────────────────────────────────

/** Ham adın kanonik karşılığı. `null` = bilinen eşleme yok. */
export function canonicalName(platform: Platform, providerName: string): CanonicalMetricName | null {
  return ALIASES[platform].get(providerName) ?? null;
}

/** Ham ad kaldırılmış mı? `null` = kaldırılmamış. */
export function deprecatedNote(platform: Platform, providerName: string): string | null {
  return DEPRECATED[platform].get(providerName) ?? null;
}

/** Panelde gösterilecek uyarı metinleri (kaldırılmış metrikler için). */
export function deprecationWarnings(
  platform: Platform,
  deprecated: readonly DeprecatedMetric[],
): string[] {
  return deprecated.map((d) => `${d.providerName}: ${d.note}`);
}

// ── Normalizasyon ───────────────────────────────────────────────────────────

export interface NormalizeRef {
  /** Yayınlanmış içeriğin uzaktaki kimliği. Girdiyle birebir aynıdır. */
  remoteId: string;
  /** `YYYY-MM-DD`, YEREL gün. `metricDate(instant, timezone)` ile üretilir. */
  metricDate: string;
  /** UTC ISO damgası. Sağlayıcının verdiği andan bağımsız, bizim çağrı anımız. */
  fetchedAt: string;
  /** "Neden ölçülemedi" — adaptör bunu doldurduysa korunur. */
  unavailable?: MetricUnavailable | null;
  /** Destek kanıtı (TikTok `log_id`). */
  logId?: string | null;
}

export interface NormalizedMetrics extends NormalizedEnvelope {
  platform: Platform;
  remoteId: string;
  metricDate: string;
  fetchedAt: string;
  unavailable: MetricUnavailable | null;
  logId: string | null;
}

/**
 * Ham sağlayıcı metriklerini kanonik zarfı indirger.
 *
 * `raw` BOŞ KÜME (`{}`) ise sonuç da boş ölçümdür: `metrics` boş, `unknown`
 * boş, `deprecated` boş, `unavailable` `ref`'te ne varsa odur. Bu Instagram'ın
 * "veri yok" davranışıdır (API `0` değil BOŞ KÜME döner) ve `0` üretmek
 * YANLIŞ olurdu: kullanıcı "izlenme yok" sanır, oysa 48 saatlik veri gecikmesi
 * vardır.
 *
 * Tanınmayan ad SESSİZE DÜŞMEZ: `unknown` listesine girer. Sessizce düşen bir
 * metrik, "panelde görünmüyor" demektir ve bu, "ölçüm çalışmıyor" ile
 * ayırt edilemez.
 */
export function normalize(platform: Platform, raw: RawMetrics, ref: NormalizeRef): NormalizedMetrics {
  const metrics: Record<string, number | null> = {};
  const unknown: string[] = [];
  const deprecated: DeprecatedMetric[] = [];

  for (const [providerName, value] of Object.entries(raw)) {
    // Önce kaldırılmış metrik: kanonik tabloya YAZILMAZ.
    const note = deprecatedNote(platform, providerName);
    if (note !== null) {
      deprecated.push({ providerName, value: readNumber(value), note });
      continue;
    }

    const canonical = canonicalName(platform, providerName);
    if (canonical === null) {
      // Sayıya çevrilebilir ama karşılığı yok → `unknown`. Metin değilse
      // (ör. `is_aigc: true`) yine `unknown`: panel bunu "okunamadı" değil,
      // "eşlenmemiş metrik" olarak gösterir.
      unknown.push(providerName);
      continue;
    }

    if (value === undefined) continue;
    metrics[canonical] = readNumber(value);
  }

  // Kaldırılmış olanlar da okunamayan ham değerleri `unknown`'a eklenmez:
  // zaten `deprecated` listesinde ve sayısal olmayanları da saklıyoruz.
  unknown.sort();
  deprecated.sort((a, b) => a.providerName.localeCompare(b.providerName));

  const unavailable = ref.unavailable ?? null;
  return {
    platform,
    remoteId: ref.remoteId,
    metricDate: ref.metricDate,
    fetchedAt: ref.fetchedAt,
    unavailable,
    logId: ref.logId ?? unavailable?.logId ?? null,
    metrics,
    unknown,
    deprecated,
  };
}

/**
 * Kanonik olmayan/okunamayan bir ham adı `unknown` listesine ekler.
 * Sağlayıcı alanı istendiği halde `null` geldiyse (ör. IG insights yanıtında
 * `plays` alanı hiç yok) adaptör bunu kullanarak kaydın "sessizce eksik"
 * görünmesini engeller.
 */
export function noteUnknown(normalized: NormalizedMetrics, providerName: string): NormalizedMetrics {
  if (normalized.unknown.includes(providerName)) return normalized;
  return { ...normalized, unknown: [...normalized.unknown, providerName].sort() };
}

// ── Yerel gün hesabı ────────────────────────────────────────────────────────

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `instant`'in `timezone`'deki YEREL günü, `YYYY-MM-DD` olarak.
 *
 * UTC GÜNÜ DEĞİL. Türkiye (UTC+3) için `2026-10-01T22:00Z` → `2026-10-02`.
 * UTC günü kullanmak, panelde "dün" etiketinin akşam 21:00'den sonra yanlış
 * görünmesi demektir; ayrıca gece yarısına yakın yayınlanan reklamın ilk
 * ölçümü yanlış güne yazılır ve 24 saatlik toplamlar kayar.
 *
 * `timezone` IANA adı (`Europe/Istanbul`). Geçersizse hata fırlatır — sessizce
 * UTC'ye düşmek, "hangi gün" sorusunu yanlış cevaplamaktır.
 */
export function metricDate(
  instant: Date | string | number,
  timezone: string = "Europe/Istanbul",
): string {
  const date =
    instant instanceof Date
      ? instant
      : typeof instant === "number"
        ? new Date(instant)
        : new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Geçersiz zaman anı: ${String(instant)}`);
  }
  if (!isValidTimeZone(timezone)) {
    throw new Error(`Geçersiz saat dilimi: ${timezone}`);
  }
  // `tzOffsetMs` o andaki GERÇEK ofseti verir (yaz saati dahil), sabit
  // "+03:00" yazmak yaz saati geçişlerinde bir gün kaydırırdı.
  const offset = tzOffsetMs(date, timezone);
  const local = new Date(date.getTime() + offset);
  return local.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` doğrulaması. `metric_date` sütununun GLOB kısıtının TypeScript karşılığı. */
export function isMetricDate(value: string): boolean {
  if (!DATE_ONLY_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === value;
}

/** `YYYY-MM-DD` → UTC gece yarısı epoch ms. Aralık sayımı için. */
export function dayMs(day: string): number {
  if (!isMetricDate(day)) throw new Error(`Geçersiz metric_date: ${day}`);
  return Date.parse(`${day}T00:00:00Z`);
}

/** `YYYY-MM-DD` → sonraki gün (exclusive üst sınır). */
export function nextDay(day: string): string {
  return new Date(dayMs(day) + 86_400_000).toISOString().slice(0, 10);
}

/** `[from, to]` dahil gün sayısı. `from > to` ise 0. */
export function dayCount(from: string, to: string): number {
  if (!isMetricDate(from) || !isMetricDate(to)) {
    throw new Error(`Geçersiz tarih aralığı: ${from}..${to}`);
  }
  const diff = dayMs(to) - dayMs(from);
  return diff < 0 ? 0 : Math.floor(diff / 86_400_000) + 1;
}

/** Aralıktaki günleri kronolojik üretir (aralık çok büyükse bellek yiyen dizi
 *  yerine jeneratör döner; çağıran `for..of` ile yine sınırsız gezebilir). */
export function* eachDay(from: string, to: string): Generator<string> {
  let cursor = from;
  while (isMetricDate(cursor) && isMetricDate(to) && cursor <= to) {
    yield cursor;
    cursor = nextDay(cursor);
  }
}

// ── Bölme koruması ──────────────────────────────────────────────────────────

/**
 * `a / b`, bölme sıfır korumasıyla.
 *
 * Payda `null`, `0`, negatif-olmayan sayı DEĞİL ya da sonuç sonsuzsa `null`
 * döner. `0` payda olduğunda `Infinity`/`NaN` üretmek, JSON'da `null`a
 * dönüşür ve panelde "tanımsız" yerine `0` ya da boş görünür — hangisi
 * olursa olsun "bu içerik izlenmedi" ile "oran hesaplanamadı" birbirine karışır.
 */
export function safeDivide(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b === 0) return null;
  const result = a / b;
  return Number.isFinite(result) ? result : null;
}