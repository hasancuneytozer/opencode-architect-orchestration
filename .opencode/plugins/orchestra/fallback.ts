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

/** Dosyanin son degisiklik zamani. Yoksa -1. */
async function stampOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch {
    return -1
  }
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Geri dönüş kararı (saf ve test edilebilir)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bir basarisiz geri donus denemesinden sonra en fazla bu kadar kez DAHA denenir.
 *
 * Geri donus `ctx.session.switchModel` ile yapilir ve bu cagri hata VEREBILIR.
 * Kayitlar `once` silinseydi (eski davranis) oturum kalici olarak yedek modelde
 * kalirdi: geri donus bir daha denenmezdi. Kayitlar simdi SILINMEDEN sonraki tura
 * tasinir; sinir bu tekrarin sonsuz olmasini engeller.
 */
export const MAX_RESTORE_RETRIES = 1

/** `"provider/model"` referansini ayirir. Gecersizse tanimsiz doner. */
export function parseModelRef(ref: string | undefined): { providerID: string; id: string } | undefined {
  const raw = String(ref ?? "").trim()
  if (!raw) return undefined
  const [providerID, ...rest] = raw.split("/")
  const id = rest.join("/")
  if (!providerID || !id) return undefined
  return { providerID, id }
}

/**
 * Rol bazli gecersiz kilma. Ajan bilinmiyorsa taban config doner.
 *
 * NOT: `perAgent` gecersiz kilmalari YALNIZCA buradan okunmalidir. Karari
 * `baseConfig` ile vermek, ayari sessizce yok saymak demektir.
 */
export function configForAgent(base: FallbackConfig, agent?: string): FallbackConfig {
  if (!agent) return base
  const override = base.perAgent[agent]
  return override ? { ...base, ...override } : base
}

export type RestoreReason =
  | "config-off" // autoSwitch/restoreOnRecovery/enabled kapali
  | "no-mark" // bu oturumda gecis yapilmamis
  | "still-retrying" // gecisten sonra da retry oldu
  | "no-original" // ilk model kaydi yok
  | "invalid-original" // ilk model referansi bozuk
  | "restore-limit" // basarisiz deneme siniri asildi
  | "restore"

/** Bu gerekçelerde bekleyen gecis kaydi BIRAKILIR; donus bir daha denenmez. */
export const RESTORE_GIVE_UP: readonly RestoreReason[] = [
  "config-off",
  "no-original",
  "invalid-original",
  "restore-limit",
]

/**
 * "Model duzeldi, ilk modele donelim mi?" kararini verir.
 *
 * Saf fonksiyon: `switchModel` cagrisi iceride degildir, bu yuzden karar
 * laboratuvarda test edilebilir. Gerekce `reason` ile doner.
 *
 * `nextFailedRestores` = "bu turda gecis denendi ve BASARISIZ olduysa saklanacak
 * deger". Kural:
 *   - `restore` -> failed + 1 (deneme yapildi, sayac ilerlemeli)
 *   - digerleri -> failed (deneme YAPILMADI, sayac yerinde durur)
 * Basarili geciste cagiran taraf kaydi tamamen siler, sayaca gerek kalmaz.
 */
export function shouldRestore(input: {
  config: FallbackConfig
  mark: number | undefined
  retryTotal: number | undefined
  original: string | undefined
  failedRestores: number
}): { restore: boolean; nextFailedRestores: number; reason: RestoreReason } {
  const { config, mark, retryTotal, original } = input
  const failed =
    Number.isFinite(input.failedRestores) && input.failedRestores > 0 ? Math.floor(input.failedRestores) : 0
  const no = (reason: RestoreReason) => ({ restore: false, nextFailedRestores: failed, reason })

  if (!config.enabled || !config.autoSwitch || !config.restoreOnRecovery) return no("config-off")
  if (mark === undefined) return no("no-mark")
  // Sayac OTURUM bazlidir ve gecis aninda isaretlenir. Degistiyse gecisten
  // sonra da retry oldu demektir; yedek model de tutmuyor, bekle.
  if (retryTotal !== mark) return no("still-retrying")
  if (!original) return no("no-original")
  if (!parseModelRef(original)) return no("invalid-original")
  // Sinir asildi: bir daha deneme. Kayit birakilacak, dongu kapatilir.
  if (failed > MAX_RESTORE_RETRIES) return no("restore-limit")
  return { restore: true, nextFailedRestores: failed + 1, reason: "restore" }
}

/** Oturum bazli retry sayacini bir artirir, yeni degeri dondurur. */
export function bumpRetry(counts: Map<string, number>, sessionID: string): number {
  const next = (counts.get(sessionID) ?? 0) + 1
  counts.set(sessionID, next)
  return next
}

/**
 * Sayac haritasini sinirla; harita sinirsiz buyumesin.
 *
 * `pending` icindeki oturumlar SILINMEZ. Sebep: isareti silinen oturumda
 * `retryTotal` tanimsiz olur, `mark` ile esitlenmez ve geri donus kalici olarak
 * engellenmis olur. Yalnizca yalnizlik (isaretsiz) oturumlar atilir.
 */
export function trimRetryCounts(counts: Map<string, number>, pending: Iterable<string>, maxSessions: number): string[] {
  const cap = Number.isFinite(maxSessions) && maxSessions > 0 ? Math.floor(maxSessions) : 0
  if (cap <= 0 || counts.size <= cap) return []
  const keep = new Set(pending)
  const dropped: string[] = []
  for (const key of [...counts.keys()]) {
    // `counts.size` canli degerdir; silinenleri bir daha saymamak icin
    // `dropped.length` ile TOPLAMAK yanlis olurdu.
    if (counts.size <= cap) break
    if (keep.has(key)) continue
    counts.delete(key)
    dropped.push(key)
  }
  return dropped
}

export interface FallbackHandle {
  /**
   * `prompt` hook'una bağlanır: model düzelince ilk modele dönüşü tetikler.
   *
   * Neden `prompt` ve `context` değil: `context` model gönderilmeden hemen önce
   * çalıştığı için oradaki bir switch o turun isteğini etkilemez (bir tur
   * kaybedilir) ve araç çağrısından sonra da tetiklendiği için geri dönüş
   * turun ortasında devreye girebilirdi. `prompt` kabul anıdır; bir sonraki
   * turun modeli henüz çözülmemiştir.
   */
  onTurnStart(sessionID: string): Promise<void>
  /** Tanılama için. */
  stats(): { openBreakers: string; switches: number; learned: number }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kayıt
// ─────────────────────────────────────────────────────────────────────────────

export async function registerFallback(ctx: PluginContext, memory: Memory, root: string): Promise<{ handle: FallbackHandle; steps: Record<string, "ok" | "hata"> }> {
  const steps: Record<string, "ok" | "hata"> = {}
  // Yapilandirma CANLI tutulur. Daha once yalnizca setup() icinde okunuyordu;
  // bu da orchestra.json duzenlemeleri plugin yeniden yuklenene kadar etkisiz
  // kaliyordu (canli testte "ozellik calismiyor" diye yanlis okundu).
  // Maliyeti yalnizca saglayici hatasi oldugunda odenir; normal akista sifir.
  const configFile = path.join(root, ".opencode", CONFIG_FILE)
  let baseConfig = await loadFallbackConfig(root)
  let configStamp = await stampOf(configFile)
  const refreshConfig = async () => {
    const current = await stampOf(configFile)
    if (current === configStamp) return
    baseConfig = await loadFallbackConfig(root)
    configStamp = current
  }
  const breakers = new Map<string, Breaker>()
  const switches = new Map<string, SwitchRecord>()
  const originals = new Map<string, string>()
  /** Son `context` çağrısından bu yana retry oldu mu? Başarı çıkarımı için. */
  // Geri donus karari: gecis anindaki retry sayacini hatirlar. Bir sonraki
  // context'te sayac DEGISMEMISSE, gecisten sonra hic retry olmadi demektir;
  // yani gecilen tur basarili bitmis ve ilk modele donebiliriz. Bayat bayat
  // isaret yontemi BIR TUR kaybediyordu; bu yontem kaybetmez.
  const switchMark = new Map<string, number>()
  /**
   * Retry sayaci OTURUM bazlidir.
   *
   * Tek global sayac paralel oturumlari birbirine karistiriyordu: baska bir
   * oturumun tek bir retry'i bu oturumun `mark`ini degistiriyor ve geri donus
   * hic gerceklesmiyordu. Artik her oturum kendi sayacini tasir.
   */
  const retryTotals = new Map<string, number>()
  /** Oturum basina basarisiz geri donus denemesi. Sinirli: MAX_RESTORE_RETRIES. */
  const failedRestores = new Map<string, number>()
  let learned = 0

  /** Sayac haritasinin ust siniri. Cok eski oturumlar atilir. */
  const MAX_TRACKED_SESSIONS = 200

  /** Bir oturumun gecis kaydini tamamen birakir. */
  const forgetSwitch = (sessionID: string) => {
    switchMark.delete(sessionID)
    switches.delete(sessionID)
    originals.delete(sessionID)
  }

  const configFor = (agent?: string): FallbackConfig => configForAgent(baseConfig, agent)

  const note = (agent: string | undefined, failure: Failure, key: string) => {
    // Ajan kimligi karara girdi: `perAgent.learnFromFailures: false` yazan bir rol
    // icin bu not YAZILMAMALI. Once taban config okunuyordu, ayar sessizce yok
    // sayiliyordu.
    if (!configFor(agent).learnFromFailures) return
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

  // Sağlıklı bir modele geçmeyi dener. Zaten bu oturumda `from` modelinden
  // geçilmişse tekrar dener; yoksa geçiş denemeleri döngüye döner.
  const trySwitch = async (sessionID: string, from: string, config: FallbackConfig, now: number): Promise<boolean> => {
    if (!config.autoSwitch || config.chain.length === 0) return false
    if (switches.get(sessionID)?.from === from) return false // bu modelden zaten geçilmiş
    const target = nextHealthy(config.chain, from, breakers, now, config.cooldownMs)
    if (!target) return false
    const model = parseModelRef(target)
    if (!model) return false
    originals.set(sessionID, originals.get(sessionID) ?? from)
    switches.set(sessionID, { from, to: target, at: now })
    // Geri donus icin isaret: bu oturumun O ANKI retry sayaci (global degil).
    switchMark.set(sessionID, retryTotals.get(sessionID) ?? 0)
    // Yeni gecis basliyor: bu oturumun geri donus deneme bütcesi sifirlanir.
    failedRestores.delete(sessionID)
    await ctx.session.switchModel({ sessionID, model })
    return true
  }

  const retryHook = await ctx.session.hook("retry", async (event) => {
    try {
      // Yapilandirmayi canli tazele; karar ESKI config ile hesaplanmasin.
      await refreshConfig()
      const config = configFor(event.agent)
      bumpRetry(retryTotals, event.sessionID)
      // Sayaci sinirla; bekleyen gecis isareti olan oturumlar korunur.
      trimRetryCounts(retryTotals, switchMark.keys(), MAX_TRACKED_SESSIONS)
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

      // Devre AÇIKKEN: aynı modele tekrar gitmek anlamsız. Ama sagliкli bir
      // alternatif varsa VAZGEÇMEK en ucuz yol değil — GECMEK en ucuz yoldur.
      // Daha once burada dogrudan retry:false donuluyordu; bu, devre acik
      // kaldigi surece zincirin hic ilerlemesine yol aciyordu.
      if (breaker.openedAt && now - breaker.openedAt < config.cooldownMs) {
        if (failure.transient || config.retryNonTransient) {
          if (await trySwitch(event.sessionID, key, config, now)) {
            event.decision = { retry: true, delay: Math.min(config.baseDelayMs, 1000) }
            return
          }
        }
        event.decision = { retry: false }
        return
      }

      if (breaker.openedAt) {
        // Soguma bitti: sayaci sifirla.
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
        // kota/geçersiz istek: yeniden denemek işe yaramaz, sessizce dur.
        event.decision = { retry: false }
        note(event.agent, failure, key)
        return
      }

      if (breaker.openedAt) {
        if (await trySwitch(event.sessionID, key, config, now)) {
          event.decision = { retry: true, delay: Math.min(config.baseDelayMs, 1000) }
          return
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
    async onTurnStart(sessionID: string) {
      try {
        // Bekleyen gecis kaydi yoksa yapacak is yok; erken cikis ayrica pahalı
        // oturum okumasini da atlar.
        if (!switchMark.has(sessionID)) return
        await refreshConfig()

        // Oturumun ajanini oku. `configFor(undefined)` kullanmak, `perAgent`
        // gecersiz kilmalarini BU YOLDA tamamen gecersiz kiliyordu.
        let agent: string | undefined
        try {
          const session = (await ctx.session.get({ sessionID })) as { agent?: string } | undefined
          if (typeof session?.agent === "string") agent = session.agent
        } catch {
          /* oturum okunamıyorsa ajansız devam et */
        }

        const decision = shouldRestore({
          // `context` bir agent-loop isteğinden hemen ÖNCE çalışır; yani burada
          // gördüğümüz retry'lar bir ÖNCEKİ tura aittir. Geçiş anında bu oturumun
          // retry sayacını not ettik; sayac aynıysa geçişten sonra HİÇ retry
          // olmamış demektir, yani geçilen tur tuttu ve ilk modele dönebiliriz.
          config: configFor(agent),
          mark: switchMark.get(sessionID),
          retryTotal: retryTotals.get(sessionID),
          original: originals.get(sessionID),
          failedRestores: failedRestores.get(sessionID) ?? 0,
        })

        if (!decision.restore) {
          // Vazgecme gerekcelerinde kayit birakilir: ayni gecis kartsiz kalmasin.
          if (RESTORE_GIVE_UP.includes(decision.reason)) {
            forgetSwitch(sessionID)
            failedRestores.set(sessionID, decision.nextFailedRestores)
          }
          return
        }

        const model = parseModelRef(originals.get(sessionID))
        if (!model) return // shouldRestore "invalid-original" derdi; savunma amaçlı

        try {
          await ctx.session.switchModel({ sessionID, model })
        } catch {
          // Kayit KORUNUR; bir sonraki tur tekrar dener. Sayac sinirli oldugu icin
          // sonsuz dongu olmaz: MAX_RESTORE_RETRIES asilirsa "restore-limit".
          failedRestores.set(sessionID, decision.nextFailedRestores)
          return
        }

        // ONCE basarili ol, SONRA temizle. Tersi bir hata halinde kaydi kaybeder
        // ve oturum kalici olarak yedek modelde kalirdi.
        forgetSwitch(sessionID)
        failedRestores.delete(sessionID)
      } catch {
        /* geri dönüş başarısız olursa isteği bozma */
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

