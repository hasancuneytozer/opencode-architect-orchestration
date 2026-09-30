/**
 * ORCHESTRA — dayanıklılık katmanı (fallback).
 *
 * Amaç: sağlayıcı hatalarında iki şeyi yapmak.
 *   1. BOŞuna deneme harcamamak. Kota (402) ve geçersiz istek (400/422) hatalarında
 *      tekrar denemek anlamsızdır; hazır deneme bütçesini yakıp bitiririz. Buna karşılık
 *      hız sınırı (429) ve sunucu (5xx) hataları geçicidir, üstel geri çekilmeyle
 *      yeniden denemeye değer.
 *   2. Bu kalıpları UNUTMAMAK. Aynı sağlayıcı/model kombinasyonu arka arkaya
 *      başarısız olduğunda bunu hafızaya sinyal olarak yazarız. Böylece sistem
 *      "bu sağlayıcı bana rate-limit atıyor" derdini kendi dilinde öğrenir ve
 *      mimar bir sonraki işte daha bilinçli davranır.
 *
 * Tasarım kararı: hazır `retry` hook'unu kullanırız. Hook içinde uyuyup elle yeniden
 * prompt atmak yerine `event.decision` değiştiririz; böylece opencode kendi attempt
 * muhasebesini, sert tavanını ve retry geçmişini yönetmeye devam eder. Başka bir
 * plugin de aynı hook'u kullanıyorsa kararlar kayıt sırasına göre birikir.
 *
 * Model geçişi (autoSwitch) varsayılan olarak KAPALI. Nedeni açıkça belgelenmiştir:
 * `ctx.session.switchModel` oturum düzeyinde kalıcı bir değişikliktir ve "az önce
 * seçtiğin modele dönme" davranışını biz geri yüklemek zorundayız. Küçük ama kalıcı
 * bir durum sızıntısı riski taşır; kullanıcı bilerek açmalıdır.
 */

import { promises as fs } from "node:fs"
import path from "node:path"
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin"
import type { Memory } from "./memory"

// ─────────────────────────────────────────────────────────────────────────────
// Yapılandırma
// ─────────────────────────────────────────────────────────────────────────────

export interface FallbackConfig {
  enabled: boolean
  /** Kaç ardışık hatadan sonra devre açılır (o model artık denenmez). */
  cooldownThreshold: number
  /** Devre açık kalacağı süre. */
  cooldownMs: number
  /** Üstel geri çekilmenin tabanı. */
  baseDelayMs: number
  /** Üstel geri çekilmenin tavanı. */
  maxDelayMs: number
  /** Rastgelelik oranı (0..1). Sağlayıcı tarafında eşzamanlı denemeyi kırar. */
  jitter: number
  /** Kota (402) ve geçersiz istek hatalarında tekrar deneme. Varsayılan: hayır. */
  retryNonTransient: boolean
  /** Model zinciri. Sırayla denenir. Boşsa sadece backoff uygulanır. */
  chain: string[]
  /** Başarısızlıktan sonra bir sonraki modele geç. Varsayılan KAPALI. */
  autoSwitch: boolean
  /** Model düzelince ilk modele geri dön. */
  restoreOnRecovery: boolean
  /** Başarısızlıkları hafızaya sinyal olarak yaz. */
  learnFromFailures: boolean
  /** Rol bazlı geçersiz kılma. */
  perAgent: Record<string, Partial<Omit<FallbackConfig, "perAgent">>>
}

export const DEFAULT_FALLBACK: FallbackConfig = {
  enabled: true,
  cooldownThreshold: 3,
  cooldownMs: 60_000,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  jitter: 0.25,
  retryNonTransient: false,
  chain: [],
  autoSwitch: false,
  restoreOnRecovery: true,
  learnFromFailures: true,
  perAgent: {},
}

const CONFIG_FILE = "orchestra.json"

export async function loadFallbackConfig(root: string): Promise<FallbackConfig> {
  const file = path.join(root, ".opencode", CONFIG_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return { ...DEFAULT_FALLBACK } // dosya yoksa geçerli varsayılanlar
  }
  const block = (raw as { fallback?: Partial<FallbackConfig> } | null)?.fallback
  if (!block || typeof block !== "object") return { ...DEFAULT_FALLBACK }
  return { ...DEFAULT_FALLBACK, ...block, perAgent: block.perAgent ?? {} }
}

// ─────────────────────────────────────────────────────────────────────────────
// Saf mantık (test edilebilir)
// ─────────────────────────────────────────────────────────────────────────────

export type FailureClass =
  | "rate-limit" // 429 → geçici, uzun bekle
  | "quota" // 402 / kota bitti → deneme anlamsız
  | "server" // 5xx → geçici
  | "network" // bağlantı/timeout → kısa bekle
  | "invalid" // 4xx istek → deneme anlamsız
  | "context-overflow" // bağlam taşması → opencode compaction ile halleder
  | "aborted" // iptal → dokunma
  | "unknown"

export interface Failure {
  kind: FailureClass
  /** Bu hata yeniden denenmeli mi? */
  transient: boolean
  /** Hafızaya yazılacaksa sınıf imzası. */
  klass: string
  summary: string
}

const CONTEXT_OVERFLOW =
  /context[_\s-]*(?:length|window|limit|overflow)|too many tokens|prompt is too long|maximum context|context_length_exceeded|input length and `max_tokens` exceed/i

const ABORTED = /\b(abort(?:ed)?|cancell?ed|interrupt(?:ed)?|session (?:closed|aborted))\b/i

/**
 * Sağlayıcı hatasını sınıflandırır.
 *
 * `status` varsa öncelik ondadır (en güvenilir sinyal). Yoksa tip ve mesaj metnine
 * düşülür. Mesaj metni tek başına güvenilmezdir: log çıktıları da hata kelimesi
 * içerebilir; bu yüzden son çare olarak kullanılır.
 */
export function classifyError(error: { type?: string; message?: string; status?: number } | undefined): Failure {
  const type = String(error?.type ?? "")
  const message = String(error?.message ?? "")
  const status = typeof error?.status === "number" ? error.status : undefined

  if (ABORTED.test(message) || /abort/i.test(type)) {
    return { kind: "aborted", transient: false, klass: "aborted", summary: "istek iptal edildi" }
  }
  if (status === 429 || /rate[_ -]?limit|too many requests/i.test(type + " " + message)) {
    return { kind: "rate-limit", transient: true, klass: "rate-limit", summary: "hız sınırı (429)" }
  }
  if (status === 402 || /quota|insufficient[_ -]?(?:credit|quota)|billing/i.test(type + " " + message)) {
    // Kota bittiyse beklemek işe yaramaz; tekrar denemek sadece bütçe yakar.
    return { kind: "quota", transient: false, klass: "quota", summary: "kota/kredi bitti (402)" }
  }
  if (CONTEXT_OVERFLOW.test(type + " " + message)) {
    // opencode bağlam taşmasını ayrı yolla compaction ile çözer; tekrar denemek
    // aynı taşmayı tekrar üretir.
    return { kind: "context-overflow", transient: false, klass: "context-overflow", summary: "bağlam taşması" }
  }
  if (status !== undefined && status >= 500) {
    return { kind: "server", transient: true, klass: "server", summary: `sunucu hatası (${status})` }
  }
  if (status !== undefined && status >= 400) {
    return { kind: "invalid", transient: false, klass: `invalid-${status}`, summary: `geçersiz istek (${status})` }
  }
  if (/econnrefused|etimedout|enotfound|econnreset|epipe|network|timeout|socket|dns/i.test(type + " " + message)) {
    return { kind: "network", transient: true, klass: "network", summary: "ağ/bağlantı hatası" }
  }
  if (/overloaded|rate_limited|server_error|api_error/i.test(type)) {
    return { kind: "server", transient: true, klass: "server", summary: `sağlayıcı hatası (${type})` }
  }
  return { kind: "unknown", transient: true, klass: "unknown", summary: type || "bilinmeyen hata" }
}

/**
 * Üstel geri çekilme. `attempt` fiziksel denemedir; ilk istek 1'dir, ilk retry 2'dir.
 * Geçersiz değerler (NaN, Infinity, negatif) güvenli tabana düşürülür.
 */
export function computeDelay(attempt: number, config: FallbackConfig, random: () => number = Math.random): number {
  const base = Number.isFinite(config.baseDelayMs) && config.baseDelayMs > 0 ? config.baseDelayMs : 2000
  const cap = Number.isFinite(config.maxDelayMs) && config.maxDelayMs > 0 ? config.maxDelayMs : 60_000
  const step = Number.isFinite(attempt) && attempt > 2 ? attempt - 2 : 0
  // 2^step çok büyürse cap'a kilitle; sonsuz döngüye girmesin.
  const raw = base * 2 ** Math.min(step, 20)
  const capped = Math.min(cap, raw)
  const jitter = Number.isFinite(config.jitter) ? Math.max(0, Math.min(1, config.jitter)) : 0
  if (jitter === 0) return Math.round(capped)
  const spread = capped * jitter
  const offset = (random() * 2 - 1) * spread
  return Math.max(0, Math.round(capped + offset))
}

// ─────────────────────────────────────────────────────────────────────────────
// Çalışma zamanı durumu
// ─────────────────────────────────────────────────────────────────────────────

interface Breaker {
  failures: number
  openedAt?: number
}

interface SwitchRecord {
  from: string
  to: string
  at: number
}

const modelKey = (ref: { providerID: string; id: string } | undefined): string =>
  ref ? `${ref.providerID}/${ref.id}` : "bilinmiyor"

/**
 * Zincirde bir sonraki sağlıklı modeli seçer.
 *
 * ÖNEMLİ: Bir modelin devresi kapalı olsa bile, soğuması bitmiş olması onu
 * hâlâ sağlıklı sayar. Daha önce "herhangi bir devre açık modeli atla" kuralı
 * vardı; bu, zincirde iki model arka arkaya bozulduğunda üçüncüye hiç
 * düşülememeye yol açıyordu (devreler yalnızca o anki model için sıfırlanıyordu).
 */
export function nextHealthy(
  chain: string[],
  current: string,
  breakers: Map<string, Breaker>,
  now: number,
  cooldownMs: number,
): string | undefined {
  const start = chain.indexOf(current)
  const ordered = start >= 0 ? [...chain.slice(start + 1), ...chain.slice(0, start)] : chain
  for (const candidate of ordered) {
    if (candidate === current) continue
    const breaker = breakers.get(candidate)
    // Yalnızca soğuması BİTMEMİŞ devre atlanır.
    if (breaker?.openedAt !== undefined && now - breaker.openedAt < cooldownMs) continue
    return candidate
  }
  return undefined
}

/**
 * Soğuması bitmiş devreleri temizler ve sayaçlarını sıfırlar.
 *
 * Sayacı sıfırlamak önemli: yoksa 5 hatadan sonra devreye girmiş bir model,
 * tek bir yeni hatada anında yeniden devreye girer ve kullanıcı o modeli hiç
 * kullanamaz. Bu da anahtar modelin baştan sona kırılmadan olduğu anlamına gelir.
 */
export function sweepBreakers(breakers: Map<string, Breaker>, now: number, cooldownMs: number): string[] {
  const cleared: string[] = []
  for (const [key, breaker] of breakers) {
    if (breaker.openedAt === undefined) continue
    if (now - breaker.openedAt < cooldownMs) continue
    breaker.openedAt = undefined
    breaker.failures = 0
    cleared.push(key)
  }
  return cleared
}

export interface FallbackHandle {
  /** `context` hook'una bağlanır: devre kapalıyken ilk modele dönüşü tetikler. */
  onContext(sessionID: string): Promise<void>
  /** Tanılama için. */
  stats(): { openBreakers: string; switches: number; learned: number }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kayıt
// ─────────────────────────────────────────────────────────────────────────────

export async function registerFallback(ctx: PluginContext, memory: Memory, root: string): Promise<{ handle: FallbackHandle; steps: Record<string, "ok" | "hata"> }> {
  const steps: Record<string, "ok" | "hata"> = {}
  const baseConfig = await loadFallbackConfig(root)
  const breakers = new Map<string, Breaker>()
  const switches = new Map<string, SwitchRecord>()
  const originals = new Map<string, string>()
  /** Son `context` çağrısından bu yana retry oldu mu? Başarı çıkarımı için. */
  const retriedSinceContext = new Set<string>()
  let learned = 0

  const configFor = (agent?: string): FallbackConfig => {
    if (!agent) return baseConfig
    const override = baseConfig.perAgent[agent]
    return override ? { ...baseConfig, ...override } : baseConfig
  }

  const note = (agent: string | undefined, failure: Failure, key: string) => {
    if (!baseConfig.learnFromFailures) return
    // Mevcut capture/persist yolunu yeniden kullanırız: aynı eşik, aynı sinyal
    // mantığı, aynı dosya. Yeni bir kayıt türü icat etmeye gerek yok.
    memory.capture({
      tool: "orchestra",
      role: agent,
      message: `${failure.summary} — ${key}`,
      klass: `fallback:${failure.klass}`,
    })
    void memory.persistCapture().catch(() => undefined)
    learned++
  }

  const retryHook = await ctx.session.hook("retry", async (event) => {
    try {
      const config = configFor(event.agent)
      retriedSinceContext.add(event.sessionID)
      if (!config.enabled) return

      const failure = classifyError(event.error)
      if (failure.kind === "aborted") return

      const now = Date.now()
      // Sogumasi bitmis devreleri temizle: donen model tam bir deneme butcesiyle
      // gelsin, tek hatada yeniden devreye girmesin.
      sweepBreakers(breakers, now, config.cooldownMs)
      const key = modelKey(event.model)
      const breaker = breakers.get(key) ?? { failures: 0 }
      breaker.failures += 1
      breakers.set(key, breaker)

      // Devre açıkken tekrar denemek anlamsız; hazır deneme bütçesini koru.
      if (breaker.openedAt && now - breaker.openedAt < config.cooldownMs) {
        event.decision = { retry: false }
        return
      }
      if (breaker.openedAt) {
        // Soğuma bitti: sayacı sıfırla.
        breaker.openedAt = undefined
        breaker.failures = 0
      }

      const threshold = Math.max(1, config.cooldownThreshold)
      if (breaker.failures >= threshold) {
        breaker.openedAt = now
        note(event.agent, failure, key)
      }

      const retryable = failure.transient || config.retryNonTransient
      if (!retryable) {
        // Kota/geçersiz istek: yeniden denemek işe yaramaz, sessizce dur.
        event.decision = { retry: false }
        note(event.agent, failure, key)
        return
      }

      if (breaker.openedAt) {
        // Devre açıldı ve otomatik geçiş açıksa sıradaki modele geç, hemen yeniden dene.
        if (config.autoSwitch && config.chain.length > 0) {
          const target = nextHealthy(config.chain, key, breakers, now, config.cooldownMs)
          if (target) {
            const [providerID, ...rest] = target.split("/")
            const id = rest.join("/")
            if (providerID && id) {
              originals.set(event.sessionID, originals.get(event.sessionID) ?? key)
              switches.set(event.sessionID, { from: key, to: target, at: now })
              await ctx.session.switchModel({ sessionID: event.sessionID, model: { providerID, id } })
              // Model değişti; kısa bir bekleyişle framework'un yeni modelle
              // yeniden denemesine izin ver.
              event.decision = { retry: true, delay: Math.min(config.baseDelayMs, 1000) }
              return
            }
          }
        }
        event.decision = { retry: false }
        return
      }

      event.decision = { retry: true, delay: computeDelay(event.attempt, config) }
    } catch {
      // Dayanıklılık katmanı asla bir isteği bozamamalı.
    }
  })
  steps.retry = "ok"

  const handle: FallbackHandle = {
    async onContext(sessionID: string) {
      try {
        const config = configFor(undefined)
        if (!config.enabled || !config.autoSwitch || !config.restoreOnRecovery) return
        // `context` bir agent-loop isteğinden hemen önce çalışır. Arada `retry`
        // çağrısı olduysa önceki istek başarısızdı, dolayısıyla henüz toparlanmadık.
        if (retriedSinceContext.has(sessionID)) {
          retriedSinceContext.delete(sessionID)
          return
        }
        const record = switches.get(sessionID)
        if (!record) return
        const original = originals.get(sessionID)
        if (!original) return
        const [providerID, ...rest] = original.split("/")
        const id = rest.join("/")
        if (!providerID || !id) return
        switches.delete(sessionID)
        originals.delete(sessionID)
        await ctx.session.switchModel({ sessionID, model: { providerID, id } })
      } catch {
        /* geri dönüş başarısız olursa temizlemeyi ertele, isteği bozma */
      }
    },
    stats() {
      const now = Date.now()
      const open = [...breakers.entries()]
        .filter(([, b]) => b.openedAt !== undefined)
        .map(([key]) => key)
        .join(", ")
      void now
      return { openBreakers: open || "(yok)", switches: switches.size, learned }
    },
  }

  return { handle, steps }
}
