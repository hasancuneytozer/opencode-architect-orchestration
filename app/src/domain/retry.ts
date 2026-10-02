/**
 * Yeniden deneme politikası. SAF FONKSİYON: ağ çağrısı yok, sayaç yok,
 * `Date.now()` yok. Zaman ve rastgelelik DIŞARIDAN verilir; bu sayede
 * kuyruk işçisi, panel ve test aynı kararı verir.
 *
 * `attempt` NEDEN FİZİKSEL DENEMEDİR:
 * deneme sayacı denendiği işi sayar, "kaç kez planlandı" sayısını değil.
 * İlk deneme 1, ilk retry 2'dir. İlk retry tam `baseDelayMs` bekler, sonraki
 * retry'ler ikiye katlar:
 *
 *   attempt (fiziksel) | bekleme (varsayılan politika)
 *   ------------------ | ---------------------------
 *   1                  | baseDelayMs (klamp: aşağıda)
 *   2 = ilk retry      | baseDelayMs   = 2s
 *   3                  | 2 × base      = 4s
 *   4                  | 4 × base      = 8s
 *   5                  | 8 × base      = 16s
 *   6                  | 16 × base     = 32s
 *   7+                 | tavan: maxDelayMs = 300s
 *
 * `ratelimit` ve `network` için çarpan uygulanır (tavuk–karşı–la):
 * hız sınırı olan bir API'yi normal 2s ile yoklamak, durumu düzeltmeden
 * cezalandırılma penceresini büyütür. Kural `attempt` ile belgelenmiştir:
 * `base × multiplier × 2^(attempt − 2)`.
 *
 *   attempt | ratelimit (×4) | network (×2) | diğer (×1)
 *   ------- | -------------- | ------------ | ----------
 *   2       | 8s             | 4s           | 2s
 *   3       | 16s            | 8s           | 4s
 *   4       | 32s            | 16s          | 8s
 *   5       | 64s            | 32s          | 16s
 *   6       | 128s           | 64s          | 32s
 *   7+      | 300s (tavan)   | 300s (tavan) | 64s
 */
import { isRetryableKind } from "../contract/index.js";
import type { PublishErrorKind } from "../contract/index.js";

// ── Politika ──────────────────────────────────────────────────────────────

export interface RetryPolicy {
  /** Fiziksel deneme sayısı üst sınırı. Varsayılan 5. */
  maxAttempts?: number;
  /** İlk retry beklemesi. Varsayılan 2000 ms. */
  baseDelayMs?: number;
  /** Sert tavan; jitter ve retryAfter bu tavanı AŞAMAZ. Varsayılan 300_000 ms. */
  maxDelayMs?: number;
  /** Rötrez yayılımı, 0..1. Varsayılan 0.2 (±%20). */
  jitter?: number;
  /** Sınıfa özel üst sınır; yoksa `maxAttempts` kullanılır. */
  perKindMaxAttempts?: Partial<Record<PublishErrorKind, number>>;
}

export const DEFAULT_RETRY_POLICY = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 300_000,
  jitter: 0.2,
} as const;

/**
 * Uzun bekleme gerektiren sınıflar ve çarpanları. Gerekçe: `ratelimit`
 * kısa aralıkta tekrarlanırsa hesap kısıtlanır; `network` kısa aralıkta
 * tekrarlanırsa bağlantı ya da sağlayıcı tarafı zorlanır.
 */
export const SLOW_KIND_MULTIPLIER: Readonly<Partial<Record<PublishErrorKind, number>>> = {
  ratelimit: 4,
  network: 2,
};

/** Politika alanlarını normalize eder: sıfır/NaN/negatif değerler varsayılana döner. */
function resolvePolicy(opts: RetryPolicy): Required<Omit<RetryPolicy, "perKindMaxAttempts">> {
  return {
    maxAttempts: positiveInt(opts.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts),
    baseDelayMs: positive(opts.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs),
    maxDelayMs: positive(opts.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs),
    jitter: clamp01(opts.jitter ?? DEFAULT_RETRY_POLICY.jitter),
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInt(value: number | undefined, fallback: number): number {
  const v = positive(value, fallback);
  return Math.floor(v);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > 1 ? 1 : value;
}

// ── Ne kadar deneyelim ────────────────────────────────────────────────────

/** `kind` için geçerli üst sınır (per-kind varsa o, yoksa genel `maxAttempts`). */
export function effectiveMaxAttempts(
  kind: PublishErrorKind,
  policy: RetryPolicy = {},
): number {
  const perKind = policy.perKindMaxAttempts?.[kind];
  return positiveInt(perKind, resolvePolicy(policy).maxAttempts);
}

/**
 * Yeniden denenmeli mi?
 *
 * İKİ KOŞUL birlikte gerekir:
 *  1. sınıf geçici olmalı (`isRetryableKind`) — kalıcı hata yeniden denemek
 *     hesabı kapatmaktan (auth/policy) kotayı yakmaktan (quota) işe yaramaz;
 *  2. `attempt` üst sınırı aşmamalı.
 *
 * Not: `shouldRetry(kind, 1)` false döner. 1 henüz denenmemiştir; yeniden
 * deneme kararı 2. denemeden önce verilir.
 */
export function shouldRetry(
  kind: PublishErrorKind,
  attempt: number,
  policy: RetryPolicy = {},
): boolean {
  if (!isRetryableKind(kind)) return false;
  if (!Number.isFinite(attempt)) return false;
  return Math.floor(attempt) <= effectiveMaxAttempts(kind, policy);
}

// ── Ne kadar bekleyelim ───────────────────────────────────────────────────

export interface NextDelayOptions extends RetryPolicy {
  /** Hangi sınıf için bekleniyor; `ratelimit`/`network` çarpanını belirler. */
  kind?: PublishErrorKind;
  /**
   * Sağlayıcının istediği bekleme (Retry-After). ALT SINIR olarak kullanılır:
   * hesabımız daha kısa süre bekliyorsa sağlayıcının dediğine uyulur. Tavanı
   * aşmaz; 10 dakikalık Retry-After bile `maxDelayMs` ile sınırlıdır, çünkü
   * kuyruk bu süre boyunca kilitli kalır.
   */
  retryAfterMs?: number | null;
  /**
   * Jitter kaynağı. Testler sabit bir fonksiyon enjekte eder; varsayılan
   * `Math.random`. Bu dosyadaki `Math.random` çağrısının TEK yeri budur ve
   * yalnızca bu varsayılanın gövdesinde bulunur.
   */
  random?: () => number;
}

const defaultRandom = (): number => Math.random();

/**
 * `attempt` (bir sonraki FİZİKSEL denemenin numarası) için bekleme süresi.
 *
 * formül: `min(maxDelayMs, max(baseDelayMs × multiplier × 2^(attempt−2), retryAfterMs))`
 * ardından ±jitter ve tavan.
 *
 * `attempt <= 2` için üs 0'a klamp edilir: formülün kendisi `attempt = 1`
 * için `base/2` verir, oysa "ilk denemeden önce beklemek" anlamsızdır.
 * `baseDelayMs` dönmek hem "ilk retry tam baseDelayMs" kuralını korur hem de
 * `attempt` bir sonraki deneme olarak okunduğunda yanlış bir 1000 ms bekleme
 * üretmez.
 */
export function nextDelayMs(attempt: number, opts: NextDelayOptions = {}): number {
  if (!Number.isFinite(attempt)) {
    throw new RangeError(`attempt bir sayı olmalı: ${String(attempt)}`);
  }
  const step = Math.max(2, Math.floor(attempt));
  const policy = resolvePolicy(opts);

  const multiplier =
    (opts.kind !== undefined ? SLOW_KIND_MULTIPLIER[opts.kind] : undefined) ?? 1;
  const raw = policy.baseDelayMs * multiplier * 2 ** (step - 2);

  const rand = opts.random ?? defaultRandom;
  const spread = 1 + (rand() * 2 - 1) * policy.jitter;
  let ms = raw * spread;

  const floorMs = opts.retryAfterMs;
  if (typeof floorMs === "number" && Number.isFinite(floorMs) && floorMs > ms) {
    ms = floorMs;
  }

  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(ms)));
}