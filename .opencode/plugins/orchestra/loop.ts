/**
 * ORCHESTHA otonom döngüsü.
 *
 * `/loop` komutu: bir hedefi alır, her iterasyonda oturuma bir tur promptu gönderir,
 * iterasyon bitince `orchestra_report` raporunu okur ve buna göre devam/dur kararı verir.
 *
 * Bitiş koşulları (herhangi biri sağlanınca döngü biter):
 *   - architect `orchestra_report(status="done")` çağırdı
 *   - architect `orchestra_report(status="blocked")` çağırdı (insan kararı gerekiyor)
 *   - `max` iterasyon doldu
 *   - 2 ardışık iterasyonda ilerleme yok (düğüm / rapor eksik / kanıt değişmedi)
 *   - kullanıcı `/loop stop` dedi
 */

import type { Context as PluginContext } from "@opencode/plugin/promise/plugin"
import type { Memory } from "./memory"

const IDLE_TIMEOUT_MS = 20 * 60 * 1000
const DEFAULT_MAX = 10

interface LoopArgs {
  goal: string
  max: number
  action: "run" | "stop" | "status"
}

const running = new Set<string>()

function parseArgs(raw: string): LoopArgs {
  const text = raw.trim()
  const action: LoopArgs["action"] = /^stop\b/i.test(text) ? "stop" : /^status\b/i.test(text) ? "status" : "run"
  let max = DEFAULT_MAX
  let goal = text
  goal = goal.replace(/^\s*(stop|status)\b\s*/i, "")
  const maxMatch = goal.match(/(?:^|\s)--max[=\s]+(\d+)/i)
  if (maxMatch) {
    max = Math.max(1, Math.min(50, Number(maxMatch[1])))
    goal = goal.replace(maxMatch[0], " ")
  }
  const bare = goal.match(/(?:^|\s)(\d{1,2})\s+iterasyon/i)
  if (bare && !maxMatch) {
    max = Math.max(1, Math.min(50, Number(bare[1])))
    goal = goal.replace(bare[0], " ")
  }
  return { goal: goal.trim(), max, action }
}

function buildIterationPrompt(input: {
  goal: string
  iteration: number
  max: number
  stalled: number
}): string {
  const { goal, iteration, max, stalled } = input
  return [
    `## ORCHESTRA OTONOM DÖNGÜ — iterasyon ${iteration}/${max}`,
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
      ? `6. DİKKAT: ${stalled} iterasyondur ilerleme kaydı yok. Aynı yaklaşımı tekrarlama; yaklaşımı değiştir, ya da engeli \`blocked\` olarak bildir.`
      : "6. Bu turun sonunda `orchestra_report` çağrısı ZORUNLU.",
    "",
    "Rapor şekli:",
    '- `orchestra_report({status:"continue", summary:"...", next:"...", evidence:["..."]})` — hedefe ulaşıldıysa `status:"done"`.',
    '- `orchestra_report({status:"blocked", summary:"...", blockers:["..."]})` — karar gerekiyorsa; döngü durur ve insana sorar.',
    "",
    "Tur bitince tek satırla `ORCHESTRA-STATUS: continue|done|blocked` yaz.",
  ].join("\n")
}

async function waitForIdle(ctx: PluginContext, sessionID: string): Promise<"idle" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), IDLE_TIMEOUT_MS)
  })
  const idle = ctx.session.wait({ sessionID }).then(() => "idle" as const)
  const result = await Promise.race([idle, timeout])
  if (timer) clearTimeout(timer)
  return result
}

async function ensureArchitect(ctx: PluginContext, sessionID: string): Promise<void> {
  try {
    const session = await ctx.session.get({ sessionID })
    const agent = (session as { agent?: string } | undefined)?.agent
    if (agent && agent !== "architect") await ctx.session.switchAgent({ sessionID, agent: "architect" })
  } catch {
    /* oturum okunamıyorsa dokunma */
  }
}

export function registerLoop(ctx: PluginContext, memory: Memory): Promise<unknown> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: "loop",
      description: "Hedefi otonom ve sınırlı biçimde tamamla: /loop <hedef> [--max=N]  ·  /loop stop  ·  /loop status",
      execute: async ({ sessionID, prompt }) => {
        const args = parseArgs(prompt.text ?? "")

        if (args.action === "stop") {
          const loop = memory.getLoop()
          await memory.setLoop({ status: "stopped", stopReason: "kullanıcı /loop stop çağırdı" })
          void loop
          return
        }

        if (args.action === "status") {
          const loop = memory.getLoop()
          const report = memory.getReport()
          await ctx.session.synthetic({
            sessionID,
            text: [
              "## ORCHESTRA DÖNGÜ DURUMU",
              `- Durum: ${loop.status}`,
              `- Hedef: ${loop.goal ?? "(yok)"}`,
              `- İterasyon: ${loop.iteration ?? 0}/${loop.max ?? 0}`,
              `- Başlangıç: ${loop.startedAt ?? "-"}`,
              `- Güncelleme: ${loop.updatedAt ?? "-"}`,
              loop.stopReason ? `- Bitiş nedeni: ${loop.stopReason}` : "",
              report ? `- Son rapor (${report.status}): ${report.summary}` : "- Son rapor: (yok)",
            ]
              .filter(Boolean)
              .join("\n"),
          })
          return
        }

        if (!args.goal) {
          await ctx.session.synthetic({
            sessionID,
            text: "ORCHESTRA: Hedef boş. Kullanım: `/loop <hedef> [--max=10]`  ·  `/loop stop`  ·  `/loop status`",
          })
          return
        }

        if (running.has(sessionID)) {
          await ctx.session.synthetic({ sessionID, text: "ORCHESTRA: Bu oturumda zaten bir döngü çalışıyor. Bitmesini bekle veya `/loop stop` ile durdur." })
          return
        }

        running.add(sessionID)
        try {
          await ensureArchitect(ctx, sessionID)
          await memory.clearReport()
          memory.setGoal(sessionID, args.goal, `loop-${Date.now()}`)
          await memory.setLoop({
            sessionID,
            goal: args.goal,
            max: args.max,
            iteration: 0,
            status: "running",
            startedAt: new Date().toISOString(),
            stopReason: undefined,
          })

          let stalled = 0
          let lastFingerprint = ""
          let stopReason = "iterasyon sınırı doldu"

          for (let iteration = 1; iteration <= args.max; iteration++) {
            const live = memory.getLoop()
            if (live.status === "stopped") {
              stopReason = "kullanıcı durdurdu"
              break
            }
            await memory.setLoop({ iteration })

            await ctx.session.prompt({
              sessionID,
              text: buildIterationPrompt({ goal: args.goal, iteration, max: args.max, stalled }),
            })

            const outcome = await waitForIdle(ctx, sessionID)
            if (outcome === "timeout") {
              stopReason = `iterasyon ${iteration} zaman aşımına uğradı (${IDLE_TIMEOUT_MS / 60000} dk)`
              break
            }

            const report = memory.getReport()
            if (!report) {
              stalled += 1
              if (stalled >= 2) {
                stopReason = "architect 2 tur üst üste rapor vermedi"
                break
              }
              continue
            }

            if (report.status === "done") {
              stopReason = report.summary
              await memory.setLoop({ status: "done", stopReason })
              running.delete(sessionID)
              await ctx.session.synthetic({
                sessionID,
                text: `ORCHESTRA: Döngü tamamlandı (${iteration} iterasyon). ${report.summary}`,
              })
              return
            }

            if (report.status === "blocked") {
              stopReason = report.summary
              await memory.setLoop({ status: "blocked", stopReason })
              running.delete(sessionID)
              await ctx.session.synthetic({
                sessionID,
                text: [
                  "## ORCHESTRA: Döngü durduruldu — karar gerekiyor",
                  report.summary,
                  ...(report.blockers ?? []).map((b) => `- ENGEL: ${b}`),
                  "",
                  "Engelleri çözüp `/loop` komutunu yeniden çalıştır; döngü kaldığı yerden devam eder.",
                ].join("\n"),
              })
              return
            }

            const fingerprint = `${report.summary}|${(report.evidence ?? []).join(";")}`
            if (fingerprint === lastFingerprint) {
              stalled += 1
              if (stalled >= 2) {
                stopReason = "2 iterasyondur aynı sonuç/kanıt — ilerleme yok"
                await memory.setLoop({ status: "exhausted", stopReason })
                running.delete(sessionID)
                await ctx.session.synthetic({
                  sessionID,
                  text: `ORCHESTRA: Döngü durdu — ilerleme kaydedilmedi. Son durum: ${report.summary}\nYaklaşımı değiştir veya hedefi daralt.`,
                })
                return
              }
            } else {
              stalled = 0
              lastFingerprint = fingerprint
            }
          }

          await memory.setLoop({ status: "exhausted", stopReason })
          const final = memory.getReport()
          running.delete(sessionID)
          await ctx.session.synthetic({
            sessionID,
            text: `ORCHESTRA: Döngü bitti (${stopReason}).${
              final ? `\nSon durum: ${final.summary}\nSıradaki adım: ${final.next ?? "-"}` : ""
            }`,
          })
        } finally {
          running.delete(sessionID)
        }
      },
    })
  })
}
