/**
 * ORCHESTRA otonom döngüsü.
 *
 * `/loop` komutu: bir hedefi alır, her iterasyonda oturuma bir tur promptu gönderir,
 * iterasyon bitince `orchestra_report` raporunu okur ve buna göre devam/dur kararı verir.
 *
 * Bitiş koşulları (herhangi biri sağlanınca döngü biter):
 *   - architect `orchestra_report(status="done")` çağırdı
 *   - architect `orchestra_report(status="blocked")` çağırdı (insan kararı gerekiyor)
 *   - `max` iterasyon doldu
 *   - eksik rapor / kanıtsız checkpoint teknik arızası
 *   - toplam duvar saati tavanı aşıldı
 *   - kullanıcı `/loop stop` dedi
 *
 * OTURUM AYRIMI: döngü durumu ve rapor `state.json` içinde OTURUM ANAHTARLIDIR
 * (`loops[oturum]` / `reports[oturum]`). Daha önce tek yuvadaydı; iki oturum
 * birbirinin raporunu eziyor, birinin `done` raporu diğerinin döngüsünü kapatıyordu.
 */

import { promises as fs } from "node:fs"
import path from "node:path"
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin"
import type { Memory } from "./memory"
import { acceptanceState } from "./tasks.ts"

/** Optional per-iteration diagnostic deadline; disabled by default, not an activity detector. */
export const DEFAULT_IDLE_TIMEOUT_MS = 0
/**
 * Döngünün TOPLAM duvar saati tavanı. 0 → kapalı.
 *
 * Varsayılan kapalı; yalnız açık yapılandırma toplam süreyi sınırlar.
 */
export const DEFAULT_MAX_WALL_CLOCK_MS = 0
/** Durdurma/duvar saati yoklaması aralığı. */
export const DEFAULT_STOP_POLL_MS = 1_000
/** Sıfır rapor vermeye devam eden kaç tur sonra döngü kapanır. */
export const STALL_LIMIT = 2

const DEFAULT_MAX = 0

interface LoopArgs {
  goal: string
  /**
   * Kullanıcı `--max=N` / "N iterasyon" DİYSE verir. Verilmediğinde
   * `undefined` döner: aksi hâlde varsayılan değer (`orchestra.json`'daki
   * `loop.max`) hiç uygulanamaz duruma düşerdi.
   */
  max?: number
  action: "run" | "stop" | "status"
}

/** Süreç içinde çalışan döngüler. Durumun kalıcı yuvası `state.json`'daki `loops`. */
const running = new Set<string>()

export interface LoopConfig {
  /** Varsayılan iterasyon sayısı (`--max` ile ezilebilir). */
  max: number
  /** Optional absolute iteration deadline. 0 disables it, including worker waits. */
  idleTimeoutMs: number
  /** Döngünün toplam duvar saati tavanı. 0 → kapalı. */
  maxWallClockMs: number
  /** Çalışan döngünün durdurulduğunu yoklama aralığı. */
  stopPollMs: number
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  max: DEFAULT_MAX,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS,
  stopPollMs: DEFAULT_STOP_POLL_MS,
}

/**
 * `.opencode/orchestra.json` → `loop` bloğunu okur.
 *
 * Dosya yoksa, bozuksa ya da alan eksikse GÜVENLİ VARSAYILANA düşer: gözlem
 * ve döngü, kullanıcının yapılandırması yüzünden hiç çalışmamamalıdır.
 * (Ayar `orchestra.json`'a yazılır; şema mimarın yüzeyinde.)
 */
export async function loadLoopConfig(root: string | undefined): Promise<LoopConfig> {
  if (!root) return { ...DEFAULT_LOOP_CONFIG }
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(path.join(root, ".opencode", "orchestra.json"), "utf8"))
  } catch {
    return { ...DEFAULT_LOOP_CONFIG }
  }
  const block = (raw as { loop?: Partial<LoopConfig> } | null)?.loop
  if (!block || typeof block !== "object" || Array.isArray(block)) return { ...DEFAULT_LOOP_CONFIG }
  const sayi = (value: unknown, varsayilan: number, enKucuk = 0): number =>
    typeof value === "number" && Number.isFinite(value) && value >= enKucuk ? Math.floor(value) : varsayilan
  return {
    max: sayi(block.max, DEFAULT_LOOP_CONFIG.max),
    idleTimeoutMs: sayi(block.idleTimeoutMs, DEFAULT_LOOP_CONFIG.idleTimeoutMs, 0),
    maxWallClockMs: sayi(block.maxWallClockMs, DEFAULT_LOOP_CONFIG.maxWallClockMs, 0),
    stopPollMs: Math.max(10, sayi(block.stopPollMs, DEFAULT_LOOP_CONFIG.stopPollMs, 1)),
  }
}

export function parseArgs(raw: string): LoopArgs {
  const text = raw.trim()
  const action: LoopArgs["action"] = /^stop\b/i.test(text) ? "stop" : /^status\b/i.test(text) ? "status" : "run"
  let max: number | undefined
  let goal = text
  goal = goal.replace(/^\s*(stop|status)\b\s*/i, "")
  const maxMatch = goal.match(/(?:^|\s)--max[=\s]+(\d+)/i)
  if (maxMatch) {
    max = Number(maxMatch[1])
    goal = goal.replace(maxMatch[0], " ")
  }
  const bare = goal.match(/(?:^|\s)(\d{1,2})\s+iterasyon/i)
  if (bare && max === undefined) {
    max = Number(bare[1])
    goal = goal.replace(bare[0], " ")
  }
  return { goal: goal.trim(), max, action }
}

export function buildIterationPrompt(input: {
  goal: string
  iteration: number
  max: number
  stalled: number
}): string {
  const { goal, iteration, max, stalled } = input
  return [
    `## ORCHESTRA OTONOM DÖNGÜ — iterasyon ${iteration}/${max || "unbounded"}`,
    "Use orchestra_task criterionID + attempt {id, blockerID, outcome, evidence} for COMPLETED solution attempts, not planning or waiting. Three failures of one stable blocker block only that criterion. Resolve with causal reason, distinct evidence including a successful verification artifact, and structured verification. Retry via supersedes + nextWork + evidence. Verify all current contributors before done.",
    "Concrete planning/binding/dispatch/status transitions have a separate lifecycle revision. Link child session workerID and report waitingFor:[workerID] to await live work without fabricated attempts. Metadata, repeated status cycling, task churn and prose are not progress. Retrieve durable context with orchestra_status({criterionID,offset:0,limit:10}).",
    "",
    `**HEDEF (değişmez):** ${goal}`,
    "",
    "Bu turun kuralları:",
    "1. Önce `orchestra_recall` ile bu hedefle ilgili dersleri getir; ihlal etme.",
    "2. Durum tespiti: hedefe ne kadar yaklaşıldı, geriye ne kaldı? Mevcut durumu *kanıtla* (dosya, komut çıktısı, test).",
    "3. İş bölümü: geriye kalan işi bağımsız iş paketlerine böl. Bağımlılığı ve yazma yüzeyi kesişmeyen paketleri AYNI mesajda birden fazla `subagent` çağrısıyla arka planda paralel başlat.",
    "4. En küçük anlamlı adımı seç, bitir, doğrula. Yarım kalmış değişiklik bırakma.",
    "5. Yeni bir hata/desen öğrendysen `orchestra_lesson` ile kalıcı derse dönüştür.",
    stalled > 0
      ? `6. DİKKAT: ${stalled} iterasyondur bu turun raporu gelmedi. Aynı yaklaşımı tekrarlama; yaklaşımı değiştir, ya da engeli \`blocked\` olarak bildir.`
      : "6. Bu turun sonunda `orchestra_report` çağrısı ZORUNLU.",
    "",
    "Rapor şekli:",
    '- `orchestra_report({status:"continue", summary:"...", next:"...", evidence:["..."]})` — hedefe ulaşıldıysa `status:"done"`.',
    '- `orchestra_report({status:"blocked", summary:"...", blockers:["..."]})` — karar gerekiyorsa; döngü durur ve insana sorar.',
    "",
    "Rapor aracı zaten bu turun durumunu döngüye bildirir; ayrıca bir durum satırı yazma.",
    "Rapordan sonra hiçbir şey yapma: turun kapanması için turun bitmesini bekle.",
  ].join("\n")
}

const USAGE = "ORCHESTRA: Hedef boş. Kullanım: `/loop <hedef> [--max=10]`  ·  `/loop stop`  ·  `/loop status`"

/**
 * Oturumu gerçekten iptal eder.
 *
 * `SessionInterruptInput` = `{ sessionID, resume? }`; `continue` alanı API'de
 * YOKTUR. `resume` bayrağının anlamı tipte belgelenmediği için gönderilmiyor
 * (varsayılan davranış: tur iptal edilir, kaldığı yerden devam etmez).
 *
 * İptal başarısız olabilir (oturum kapanmış olabilir); bu bir hata değil.
 */
async function interrupt(ctx: PluginContext, sessionID: string): Promise<void> {
  try {
    await ctx.session.interrupt({ sessionID })
  } catch {
    /* oturum yoksa / kapanmışsa dokunma */
  }
}

/**
 * Bir iterasyonun bitmesini bekler.
 *
 * `Promise.race`'in kilitlememesi için üç güvenlik önlemi var:
 *  1. `ctx.session.wait` REDDEDERSE "idle" sayılır (bkz. `broken` çıktısı):
 *     oturum kapanmış demektir, döngü kontrollü çıkar.
 *  2. Zaman aşımı olursa yalnız çıkılır — bekleme `interrupt` sonrası da
 *     çözülmese bile `Promise.race` zaten timeout koluna düşmüştür.
 *  3. Bekleme sırasında periyodik olarak döngü durumu YOKLANIR: `/loop stop`
 *     başka bir opencode örneğinde çalışıyor olabilir ve `getLoop()` saf bir
 *     getter olduğu için diski kendiliğinden görmez.
 */
export type WaitOutcome = "idle" | "timeout" | "stopped" | "wallclock" | "broken"

export async function waitForIteration(
  ctx: PluginContext,
  memory: Memory,
  sessionID: string,
  options: { idleTimeoutMs: number; maxWallClockMs: number; stopPollMs: number; runID: string },
): Promise<WaitOutcome> {
  let zamanAsimi: ReturnType<typeof setTimeout> | undefined
  let duvar: ReturnType<typeof setTimeout> | undefined
  let yoklama: ReturnType<typeof setInterval> | undefined

  const zamanAsimiSozu = options.idleTimeoutMs > 0
    ? new Promise<WaitOutcome>((resolve) => {
        zamanAsimi = setTimeout(() => resolve("timeout"), options.idleTimeoutMs)
      })
    : new Promise<WaitOutcome>(() => undefined)
  const duvarSozu =
    options.maxWallClockMs > 0
      ? new Promise<WaitOutcome>((resolve) => {
          duvar = setTimeout(() => resolve("wallclock"), options.maxWallClockMs)
        })
      : new Promise<WaitOutcome>(() => undefined)
  const yoklamaSozu = new Promise<WaitOutcome>((resolve) => {
    yoklama = setInterval(() => {
      void (async () => {
        try {
          await memory.syncStore()
          const loop = memory.getLoop(sessionID)
          if (loop.status === "stopped") return resolve("stopped")
          if (loop.runID !== options.runID) return resolve("stopped")
        } catch {
          /* yoklama hatası beklemeyi bozmaz */
        }
      })()
    }, options.stopPollMs)
  })
  // `wait` reddederse "idle" sayılır: oturum kapanmıştır, döngü kontrollü çıkar.
  const bos = ctx.session
    .wait({ sessionID })
    .then(
      () => "idle" as WaitOutcome,
      () => "broken" as WaitOutcome,
    )

  try {
    return await Promise.race([bos, zamanAsimiSozu, duvarSozu, yoklamaSozu])
  } finally {
    if (zamanAsimi) clearTimeout(zamanAsimi)
    if (duvar) clearTimeout(duvar)
    if (yoklama) clearInterval(yoklama)
  }
}

/**
 * Oturumun rolünü `architect` yapar ve GERİ YÜKLEME fonksiyonu döndürür.
 *
 * Önceden rol kalıcı `architect` yapılıyor, geri alma yolu yoktu: kullanıcı
 * `/loop` bittikten sonra kendi rolüne dönmüyordu. Rol okunamıyorsa hiç
 * dokunulmaz; okunduysa ve değiştirildiyse `finally` içinde geri konur.
 */
async function ensureArchitect(ctx: PluginContext, sessionID: string): Promise<() => Promise<void>> {
  let previous: string | undefined
  try {
    const session = await ctx.session.get({ sessionID })
    previous = (session as { agent?: string } | undefined)?.agent
  } catch {
    return async () => undefined
  }
  if (!previous || previous === "architect") return async () => undefined
  try {
    await ctx.session.switchAgent({ sessionID, agent: "architect" })
  } catch {
    return async () => undefined
  }
  return async () => {
    try {
      await ctx.session.switchAgent({ sessionID, agent: previous as string })
    } catch {
      /* geri yüklenemezse kullanıcı elle düzeltebilir; döngü patlamaz */
    }
  }
}

async function mesaj(ctx: PluginContext, sessionID: string, text: string): Promise<void> {
  try {
    await ctx.session.synthetic({ sessionID, text })
  } catch {
    /* oturum kapanmışsa kullanıcı zaten görmeyecek */
  }
}

async function stopLoop(ctx: PluginContext, memory: Memory, sessionID: string): Promise<void> {
  await memory.setLoop(sessionID, { status: "stopped", stopReason: "kullanıcı /loop stop çağırdı" })
  // GERÇEK İPTAL: yalnız "sonraki iterasyonu etkilemesin" yetmez; yürüyen tur
  // kesintisiz 20 dakika + model maliyetiyle devam ediyordu.
  await interrupt(ctx, sessionID)
  await mesaj(ctx, sessionID, "ORCHESTRA: döngü durduruldu. Yürüyen tur iptal edildi.")
}

async function showStatus(ctx: PluginContext, memory: Memory, sessionID: string): Promise<void> {
  await memory.syncStore()
  const loop = memory.getLoop(sessionID)
  const report = memory.getReport(sessionID)
  await mesaj(ctx, sessionID, [
    "## ORCHESTRA DÖNGÜ DURUMU",
    `- Oturum: ${sessionID}`,
    `- Durum: ${loop.status}`,
    `- Hedef: ${loop.goal ?? "(yok)"}`,
    `- İterasyon: ${loop.iteration ?? 0}/${loop.max ?? 0}`,
    `- Çalıştırma: ${loop.runID ?? "-"}`,
    `- Başlangıç: ${loop.startedAt ?? "-"}`,
    `- Güncelleme: ${loop.updatedAt ?? "-"}`,
    loop.stopReason ? `- Bitiş nedeni: ${loop.stopReason}` : "",
    report
      ? `- Son rapor (${report.status}, iterasyon ${report.iteration}${report.runID && report.runID !== loop.runID ? ", ESKİ ÇALIŞMA" : ""}): ${report.summary}`
      : "- Son rapor: (yok)",
  ]
    .filter(Boolean)
    .join("\n"))
}

export interface LoopRunOptions {
  /** Explicit compatibility for historical report-only harnesses, never production default. */
  legacyReportOnly?: boolean
  /** Testler/telemetri için saat kaynağı. */
  now?: () => number
  /** Zaman aşımlarını kısaltmak için yapılandırma (yoksa orchestra.json okunur). */
  config?: LoopConfig
}

/** `/loop` komutunun tüm mantığı. Test edilebilmesi için komuttan ayrıldı. */
export async function runLoop(
  ctx: PluginContext,
  memory: Memory,
  input: { sessionID: string; prompt: string },
  options: LoopRunOptions = {},
): Promise<void> {
  const sessionID = input.sessionID
  const args = parseArgs(input.prompt ?? "")
  const config = options.config ?? (await loadLoopConfig(ctx.location?.directory))
  const now = options.now ?? (() => Date.now())

  if (args.action === "stop") return stopLoop(ctx, memory, sessionID)
  if (args.action === "status") return showStatus(ctx, memory, sessionID)
  if (!args.goal) return mesaj(ctx, sessionID, USAGE)
  if (running.has(sessionID)) {
    return mesaj(ctx, sessionID, "ORCHESTRA: Bu oturumda zaten bir döngü çalışıyor. Bitmesini bekle veya `/loop stop` ile durdur.")
  }

  const max = args.max ?? config.max
  const baslangic = now()
  const runID = `run-${baslangic.toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  running.add(sessionID)
  let geriYukle: (() => Promise<void>) | undefined
  try {
    geriYukle = await ensureArchitect(ctx, sessionID)
    memory.setGoal(sessionID, args.goal, runID)
    await memory.setLoop(sessionID, {
      runID,
      goal: args.goal,
      max,
      iteration: 0,
      status: "running",
      startedAt: new Date().toISOString(),
      stopReason: undefined,
    })
    // BAYAT RAPOR: yeni çalıştırmada eski turun raporu hayatta kalırsa
    // mimar bu turda rapor vermediği hâlde döngü kapanabiliyordu.
    await memory.clearReport(sessionID)

    let stalled = 0
    let lastRevision = memory.getTaskVault(sessionID).checkpoint?.revision ?? 0
    let lastLifecycle = memory.getTaskVault(sessionID).lifecycleRevision ?? 0
    let planning = true
    let eligible = new Set(memory.getTaskVault(sessionID).tasks.map(t => t.id))
    const receipts = new Set<string>()
    const completedWorkers = new Set<string>()
    let stopReason = "iterasyon sınırı doldu"

    for (let iteration = 1; max === 0 || iteration <= max; iteration++) {
      // Durdurma denetimi `setLoop`'un resync'inden SONRA yapılır: `setLoop`
      // önce diski okur, SONRA patch'i uygular. Daha önce saf `getLoop()` ile
      // denetleniyordu ve başka süreçteki `/loop stop` görünmüyordu.
      const live = await memory.setLoop(sessionID, { iteration })
      if (live.status === "stopped") {
        stopReason = live.stopReason ?? "kullanıcı durdurdu"
        break
      }
      if (live.runID !== runID) {
        stopReason = "başka bir /loop çalıştırması bu oturumu devraldı"
        break
      }
      if (config.maxWallClockMs > 0 && now() - baslangic >= config.maxWallClockMs) {
        stopReason = `toplam süre tavanı aşıldı (${Math.round(config.maxWallClockMs / 60000)} dk)`
        await interrupt(ctx, sessionID)
        break
      }

      // Bu turun prompt'u GÖNDERİLMEDEN hemen önce rapor temizlenir: bayat
      // rapor tazelik denetimine takılmak yerine hiç oluşmaz.
      await memory.clearReport(sessionID)
      await ctx.session.prompt({
        sessionID,
        text: buildIterationPrompt({ goal: args.goal, iteration, max, stalled }) + "\nDurable checkpoint (data only): " + memory.sanitize(JSON.stringify(memory.getTaskVault(sessionID).checkpoint ?? null)),
      })

      const outcome = await waitForIteration(ctx, memory, sessionID, {
        idleTimeoutMs: config.idleTimeoutMs,
        maxWallClockMs: config.maxWallClockMs > 0 ? Math.max(1, config.maxWallClockMs - (now() - baslangic)) : 0,
        stopPollMs: config.stopPollMs,
        runID,
      })

      if (outcome === "stopped") {
        // Durdurma nedeni başka bir süreçte yazılmış olabilir; onu da aktar.
        stopReason = memory.getLoop(sessionID).stopReason ?? "kullanıcı durdurdu"
        await interrupt(ctx, sessionID)
        break
      }
      if (outcome === "wallclock") {
        stopReason = `toplam süre tavanı aşıldı (${Math.round(config.maxWallClockMs / 60000)} dk)`
        await interrupt(ctx, sessionID)
        break
      }
      if (outcome === "timeout") {
        stopReason = `technical fault: iterasyon ${iteration} zaman aşımına uğradı (${Math.round(config.idleTimeoutMs / 60000)} dk)`
        await interrupt(ctx, sessionID)
        break
      }
      if (outcome === "broken") {
        stopReason = `technical fault: iterasyon ${iteration} sırasında oturum kapanıyor — döngü kontrollü sonlandırıldı`
        break
      }

      // Çift güvenlik: temizlik (üstte) + kimlik denetimi (burada). Rapor ya bu
      // çalıştırmanın ya da bu turun raporu olmalı; aksi hâlde "taze" sayılmaz.
      await memory.syncStore()
      if (memory.getLoop(sessionID).status === "stopped" || memory.getLoop(sessionID).runID !== runID) return
      const report = memory.getReport(sessionID)
      if (!report || report.runID !== runID || report.iteration !== iteration) {
        stalled += 1
        if (stalled >= STALL_LIMIT) {
          stopReason = `technical fault: architect ${STALL_LIMIT} tur üst üste bu turun raporunu vermedi`
          break
        }
        continue
      }

      const vault = memory.getTaskVault(sessionID)
      const state = acceptanceState(vault)
      const revision = vault.checkpoint?.revision ?? 0
      if (!options.legacyReportOnly) {
        if (report.ledgerRevision !== revision || report.lifecycleRevision !== (vault.lifecycleRevision ?? 0)) {
          stopReason = "technical fault: stale ledger report"; break
        }
        const attemptAdvanced = revision > lastRevision
        if (attemptAdvanced || planning) eligible = new Set(vault.tasks.map(t => t.id))
        const tokens = vault.tasks.filter(t => eligible.has(t.id)).flatMap(t => [
          `${t.id}:${t.status}`, ...(t.acceptance ? [`${t.id}:bound`] : []),
        ])
        const lifecycleAdvanced = (vault.lifecycleRevision ?? 0) > lastLifecycle && tokens.some(t => !receipts.has(t))
        const waiting = (report.waitingFor ?? []).filter(id => state.waiting.some(w => w.workerID === id && eligible.has(w.id)) && !completedWorkers.has(id))
        if (!attemptAdvanced && !lifecycleAdvanced && !waiting.length && !(report.status === "done" && state.done) && !(report.status === "blocked" && !state.actionable)) {
          stopReason = "technical fault: no new lifecycle work, completed attempt or identifiable live worker"; break
        }
        for (const token of tokens) receipts.add(token)
        planning = false
        lastLifecycle = vault.lifecycleRevision ?? 0
        // Park on the child call, rather than accepting unlimited heartbeat/model turns.
        if (waiting.length && report.status === "continue") {
          const workerID = waiting[0]
          try {
            const child = await ctx.session.get({sessionID:workerID})
            if ((child as {parentID?:string})?.parentID !== sessionID) throw new Error("worker parent")
          } catch { stopReason = "technical fault: unknown worker"; break }
          const workerContext = { ...ctx, session: { ...ctx.session, wait: () => ctx.session.wait({sessionID:workerID}) } } as PluginContext
          const waited = await waitForIteration(workerContext, memory, sessionID, {
            idleTimeoutMs:config.idleTimeoutMs, maxWallClockMs:config.maxWallClockMs > 0 ? Math.max(1,config.maxWallClockMs-(now()-baslangic)) : 0,
            stopPollMs:config.stopPollMs,runID,
          })
          if (waited === "stopped") return
          if (waited !== "idle") { stopReason = `technical fault: worker wait ${waited}`; break }
          completedWorkers.add(workerID)
        }
      }
      lastRevision = revision
      if (report.status === "done" && !options.legacyReportOnly && !state.done) {
        stopReason = "technical fault: incomplete acceptance reported done"
        break
      }
      if (report.status === "done") {
        await memory.setLoop(sessionID, { status: "done", stopReason: report.summary })
        return mesaj(ctx, sessionID, `ORCHESTRA: Döngü tamamlandı (${iteration} iterasyon). ${report.summary}`)
      }

      if (options.legacyReportOnly ? report.status === "blocked" : !state.actionable) {
        await memory.setLoop(sessionID, { status: "blocked", stopReason: report.summary })
        return mesaj(ctx, sessionID, [
          "## ORCHESTRA: Döngü durduruldu — karar gerekiyor",
          report.summary,
          ...(report.blockers ?? []).map((b) => `- ENGEL: ${b}`),
          "",
          "Engelleri çözüp `/loop` komutunu yeniden çalıştır; döngü kaldığı yerden devam eder.",
        ].join("\n"))
      }

      stalled = 0
    }

    await memory.syncStore()
    if (memory.getLoop(sessionID).status === "stopped" || memory.getLoop(sessionID).runID !== runID) return
    await memory.setLoop(sessionID, { status: stopReason.startsWith("technical fault:") ? "blocked" : "exhausted", stopReason })
    const final = memory.getReport(sessionID)
    return mesaj(ctx, sessionID, `ORCHESTRA: Döngü bitti (${stopReason}).${final ? `\nSon durum: ${final.summary}\nSıradaki adım: ${final.next ?? "-"}` : ""}`)
  } finally {
    running.delete(sessionID)
    await geriYukle?.()
  }
}

export function registerLoop(ctx: PluginContext, memory: Memory): Promise<unknown> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: "loop",
      description: "Hedefi kanıtlı kabul kriterleriyle tamamla: /loop <hedef> [--max=N]  ·  /loop stop  ·  /loop status",
      execute: async ({ sessionID, prompt }) => {
        await runLoop(ctx, memory, { sessionID, prompt: prompt?.text ?? "" })
      },
    })
  })
}
