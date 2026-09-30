/**
 * ORCHESTHA — opencode için mimar-merkezli orkestrasyon çekirdeği.
 *
 * Bu plugin dört şey yapar:
 *   1. AĞA: `orchestra_recall/lesson/forget/report` araçlarını ve `/loop` komutunu kaydeder.
 *   2. GÖZLEM: her araç çağrısının sonucunu izler ve **başarısızlığı yakalar**.
 *   3. HAFIZA: her kullanıcı turunda alakalı dersleri modele bir kez enjekte eder.
 *   4. DÖNGÜ: `/loop` komutuyla sınırlı, rapor tabanlı otonom iterasyon yürütür.
 *
 * Roller, beceriler ve komutlar plugin değil, saf yapılandırmadır; bu yüzden
 * gerektiğinde eklenip çıkarılabilirler. Hafıza ise plugin'de yaşar çünkü yakalama
 * disiplinini modele bırakırsak güvenilmez olur.
 */

import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { Memory } from "./memory"
import { registerTools } from "./tools"
import { registerLoop } from "./loop"

/**
 * Plugin'in kendi araçlarının etkin adları namespace uygulanmış hâliyle gelir
 * (`orchestra_recall`, `orchestra_lesson`, ...). Code Mode'da ise araçlar
 * `execute` sarmalayıcısının içinden çağrılır ve çıktılarını oraya yazar.
 * Her iki yolda da kendi gürültümüzü yakalamamak için eliyoruz.
 */
const SELF_TOOLS = new Set(["orchestra_recall", "orchestra_lesson", "orchestra_forget", "orchestra_report"])
const SELF_MARKER = "ORCHESTRA HAFIZA"

/** İptal/abort bir hata değildir, gürültüdür. */
const ABORT = /\b(abort(ed)?|cancell?ed|interrupt(ed)?|session (closed|aborted))\b/i

/** Çıktı metninde taranacak azami karakter. Devasa logları tarama. */
const MAX_SCAN = 20_000

interface Reason {
  name: string
  pattern: RegExp
  /** İmzayı ayrıştıran kararlı kod (hata sınıfı, TS kodu, errno vb.). */
  code?: RegExp
  /** Satır başına, düzleştirilmiş metne değil bakılır (gömülü benzerlikleri eler). */
  anchored?: boolean
  /** Zayıf işaret: tek başına anlamsız, ancak bağlamıyla anlamlı. */
  weak?: boolean
}

/**
 * Sıralama önemlidir: önce en kararlı işaretler taranır.
 * V2'de sıfır dışı çıkış kodu "hata" sayılmaz; hata metin olarak döner ve
 * yakalamak bizim işimizdir.
 */
const REASONS: Reason[] = [
  // Windows PowerShell'in en kararlı sinyali: hata sınıfı adı.
  { name: "PowerShellHatasi", pattern: /FullyQualifiedErrorId\s*:\s*[A-Za-z0-9_.]+/i, code: /FullyQualifiedErrorId\s*:\s*([A-Za-z0-9_.]+)/i },
  { name: "KomutBulunamadi", pattern: /is not recognized as the name of a|command not found|Cannot find module|ModuleNotFoundError|No such file or directory/i },
  { name: "TipHatasi", pattern: /\berror TS\d{3,}/i, code: /\berror (TS\d{3,})/i },
  { name: "PythonTraceback", pattern: /Traceback \(most recent call last\)|\bFile "[^"]+", line \d+|\bline \d+, in \w/i },
  {
    name: "NodeHatasi",
    pattern: /\bNode\.js v\d+|\bat [^\s:()]+:\d+:\d+|\[[\w/.-]+\]:\d+\s*$/i,
    code: /\b([A-Za-z_]*(?:Error|Exception))\b\s*[:(]/,
  },
  { name: "PaketHatasi", pattern: /(?:^|\s)(?:npm|pnpm|yarn|npx) ERR!|ELIFECYCLE|ERR_PNPM_/i },
  { name: "GitHatasi", pattern: /^\s*fatal: /i },
  { name: "TestBasarisiz", pattern: /\b\d+ (?:failing|failed)\b|^\s*FAIL\b|^\s*FAILED\b|Tests?:\s+.*fail|AssertionError/i },
  {
    name: "Istisna",
    // Satır başına sabit: günlük çıktısının ortasında geçen "XException" kelimeleri
    // (ör. bir döngü günlüğü) hata değildir. Gerçek araç çıktısı istisnayı
    // neredeyse her zaman satırın başına koyar.
    pattern: /^[A-Za-z_]*(?:Error|Exception)\b\s*[:(]/,
    code: /([A-Za-z_]*(?:Error|Exception))\s*[:(]/,
    anchored: true,
  },
  { name: "SistemHatasi", pattern: /\b(EACCES|EPERM|EADDRINUSE|ECONNREFUSED|ETIMEDOUT|EEXIST|ENOSPC|ENOTFOUND)\b/, code: /\b(EACCES|EPERM|EADDRINUSE|ECONNREFUSED|ETIMEDOUT|EEXIST|ENOSPC|ENOTFOUND)\b/ },
  { name: "CikisKodu", pattern: /Exited with code [1-9]\d*\b/i, code: /Exited with code [1-9](\d*)/i, weak: true },
  { name: "HataSatiri", pattern: /^\s*error[:\s]/i, weak: true },
]

function resultText(result: { content?: unknown }): string {
  const content = result?.content
  if (typeof content === "string") return content.slice(0, MAX_SCAN)
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("\n")
    .slice(0, MAX_SCAN)
}

/**
 * Çıktıdan kararlı bir hata sınıfı ve okunabilir bir örnek çıkarır.
 *
 * İmza (`klass`) mesajdan değil SINIFTAN üretilir: "komut bulunamadı" hatası
 * yüz kez farklı komutla da olsa tek kayıt olarak birikir ve sayaç doğru çalışır.
 * Örnek ise çıktının başından alınır — araç hata çıktısı genellikle mesajla başlar.
 */
function extractFailure(content: string): { klass: string; sample: string } | undefined {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return undefined

  // Satır kaydırma (word wrap) çok kelimeli desenleri böler. Önce tek satıra indirge.
  const flat = lines.join(" ").replace(/\s+/g, " ")
  if (flat.length === 0) return undefined

  const build = (reason: Reason, match: RegExpExecArray | null): { klass: string; sample: string } => {
    const code = match && reason.code ? reason.code.exec(flat)?.[1] : undefined
    const klass = code ? `${reason.name}:${code}` : reason.name
    const at = match?.index ?? 0
    const head = flat.slice(0, 220).trim()
    // Eşleşme baştan uzaksa çevresinden bir bağlam penceresi ekle; pencereyi
    // kelime sınırına yuvarla ki kırık parçalar görünmesin.
    let tail = ""
    if (at > 220) {
      const from = Math.max(0, at - 90)
      const boundary = flat.lastIndexOf(" ", from + 1)
      tail = ` … ${flat.slice(boundary + 1, at + 130).trim()}`
    }
    return { klass, sample: `${head}${tail}`.trim() }
  }

  for (const reason of REASONS) {
    if (reason.weak) continue
    if (reason.anchored) {
      for (const line of lines) {
        if (!reason.pattern.test(line)) continue
        return build(reason, { index: flat.indexOf(line) } as RegExpExecArray)
      }
      continue
    }
    const match = reason.pattern.exec(flat)
    if (match) return build(reason, match)
  }

  for (const reason of REASONS) {
    if (!reason.weak) continue
    for (const line of lines) {
      const match = reason.pattern.exec(line)
      if (match) return build(reason, { ...match, index: flat.indexOf(line) } as RegExpExecArray)
    }
  }

  return undefined
}

export default Plugin.define({
  id: "orchestra",

  async setup(ctx) {
    const memory = await Memory.open(path.join(ctx.location.directory, ".opencode", "memory"))
    const resolving = new Map<string, Promise<void>>()

    // Kayıt adımlarını tek tek ölç. Sessizce kaydedilemeyen bir parça (örn. /loop
    // komutu) kullanıcıyı beklediği bir sistemden mahrum bırakır; bunu görünür kıl.
    const steps: Record<string, "ok" | "hata"> = {}
    let detail: string | undefined
    const record = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run()
        steps[name] = "ok"
      } catch (error) {
        steps[name] = "hata"
        detail = `${name}: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    await record("tools", () => registerTools(ctx, memory))
    await record("loop", () => registerLoop(ctx, memory))
    await memory.setDiagnostics({ startedAt: new Date().toISOString(), steps, detail })
    const failed = Object.entries(steps).filter(([, value]) => value !== "ok")
    if (failed.length > 0) console.error(`[orchestra] ${detail}`)

    // --- 2. GÖZLEM: her araç çağrısının sonucunu incele -------------------
    // İki yol vardır:
    //   a) Araç gerçekten hata fırlattıysa (status === "error")
    //   b) Araç "başarılı" döndü ama çıktı bir hatayı anlatıyordu
    //      → V2'de sıfır dışı çıkış kodu böyledir.
    // (b) yolu gürültü üretebilir; filtreyi tek seferde uygular: auto dersler
    // ancak 3 kez tekrarlanınca hatırlatılır, dolayısıyla gürültü kendiliğinden elenir.
    const observeHook = await ctx.tool.hook("execute.after", (event) => {
      if (SELF_TOOLS.has(event.tool)) return

      if (event.status === "error") {
        const message = event.error?.message ?? ""
        if (!message || ABORT.test(message)) return
        memory.capture({ tool: event.tool, role: event.agent, message })
        void memory.persistCapture().catch(() => undefined)
        return
      }

      const text = resultText(event.result)
      if (!text || ABORT.test(text.slice(0, 2000))) return
      // Code Mode'da araçlar `execute` sarmalayıcısının içinden çağrılır; kendi
      // araçlarımızın çıktısı oraya karışmasın.
      if (text.includes(SELF_MARKER)) return
      const failure = extractFailure(text)
      if (!failure) return

      memory.capture({
        tool: event.tool,
        role: event.agent,
        message: failure.sample,
        klass: failure.klass,
      })
      void memory.persistCapture().catch(() => undefined)
    })

    // --- 3a. Görev bağlamını kaydet ---------------------------------------
    const promptHook = await ctx.session.hook("prompt", (event) => {
      memory.setGoal(event.sessionID, event.prompt.text ?? "", event.messageID)
    })

    // --- 3b. Alt oturumlar (subagent) ana oturumun hedefini miras alsın ----
    async function ensureGoal(sessionID: string): Promise<void> {
      if (memory.getGoal(sessionID)) return
      const pending = resolving.get(sessionID)
      if (pending) return pending
      const task = (async () => {
        try {
          let current = sessionID
          for (let depth = 0; depth < 6; depth++) {
            const session = (await ctx.session.get({ sessionID: current })) as { parentID?: string } | undefined
            const parent = session?.parentID
            if (!parent) break
            memory.inheritGoal(sessionID, parent)
            if (memory.getGoal(sessionID)) break
            current = parent
          }
        } catch {
          /* oturum okunamıyorsa enjekte yok */
        } finally {
          resolving.delete(sessionID)
        }
      })()
      resolving.set(sessionID, task)
      return task
    }

    // --- 3c. Her kullanıcı turunda bir kez hafıza enjeksiyonu ------------
    const contextHook = await ctx.session.hook("context", async (event) => {
      try {
        await memory.sync()
        await ensureGoal(event.sessionID)
        if (!memory.shouldInject(event.sessionID)) return
        const block = memory.buildBlock(event.sessionID, event.agent)
        if (block) event.system.push({ type: "text", text: block })
      } catch {
        /* hafıza asla bir model çağrısını bozamamalı */
      }
    })

    return async () => {
      await Promise.allSettled([observeHook.dispose(), promptHook.dispose(), contextHook.dispose()])
    }
  },
})
