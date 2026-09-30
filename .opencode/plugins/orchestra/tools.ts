/**
 * ORCHESTHA araçları.
 *
 * Hafıza motorunu agent'lara açar. Plugin, araç hatalarını kendiliğinden yakalar;
 * bu araçlar "ham hatayı kalıcı derse çevirme" ve "hatırlama" tarafını tamamlar.
 */

import type { Context as PluginContext } from "@opencode/plugin/promise/plugin"
import type { Memory, ReportState } from "./memory"

const OBJECT = { type: "object" } as const
const STRING = { type: "string" } as const
const STRING_ARRAY = { type: "array", items: { type: "string" } } as const

function text(value: string) {
  return { content: value }
}

interface RecallInput {
  query?: string
  role?: string
  limit?: number
  include_retired?: boolean
}

interface LessonInput {
  title: string
  rule: string
  body?: string
  tags?: string[]
  promote?: string
  supersedes?: string
}

interface ForgetInput {
  id?: string
  signature?: string
  reason?: string
}

interface ReportInput {
  status: string
  summary: string
  next?: string
  blockers?: string[]
  evidence?: string[]
}

const asArray = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/**
 * `orchestra_report` yalnızca bu rol tarafından çağrılabilir.
 *
 * Sebep: rapor TEK yuva olarak tutulur (`state.json → report`) ve /loop onu okuyarak
 * döngüyü durdurur. Araç global olduğu için bir alt ajan `status: "done"` bildirirse
 * otonom iş, tamamlanmadan kapanırdı. Genişletmek istersen: burayı ve
 * `opencode.jsonc` içindeki `orchestra_report` izin kuralını birlikte güncelle.
 */
const REPORT_OWNER = "architect"

function lessonLine(lesson: {
  id: string
  kind: string
  rule: string
  title: string
  seen: number
  hits: number
  status: string
  tags: string[]
  sample?: string
}): string {
  const label = lesson.rule || lesson.title
  const meta = `— etiketler: ${lesson.tags.join(", ") || "-"} | görülme: ${lesson.seen}, hatırlanma: ${lesson.hits}`
  return lesson.sample
    ? `${lesson.id} [${lesson.kind}/${lesson.status}] ${label} ${meta}\n    örnek: ${lesson.sample}`
    : `${lesson.id} [${lesson.kind}/${lesson.status}] ${label} ${meta}`
}

export function registerTools(ctx: PluginContext, memory: Memory): Promise<unknown> {
  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "orchestra",
      description: "Orchestra hafızası: ders yaz, hatırla, emekliye ayır, döngü durumu bildir",
    })

    editor.add({
      name: "recall",
      description:
        "Orchestra hafızasında bu görevle ilgili dersleri ara. Otomatik enjeksiyon zaten ilgili dersleri verir; " +
        "bir konuyu, aracı veya dosyayı taramak istediğinde bunu kullan.",
      options: { namespace: "orchestra" },
      input: {
        ...OBJECT,
        properties: {
          query: { ...STRING, description: "Arama metni. Boş bırakılırsa tüm aktif dersler listelenir." },
          role: { ...STRING, description: "Sadece bu rolün (agent id) derslerini filtrele." },
          limit: { type: "integer", minimum: 1, maximum: 40, description: "En fazla kaç ders dönsün (varsayılan 10)." },
          include_retired: { type: "boolean", description: "Emekliye ayrılmış dersleri de dahil et." },
        },
        additionalProperties: false,
      },
      execute: async (raw) => {
        const input = raw as RecallInput
        // Dışarıdan yapılan düzenlemeler (elle silme, elle ekleme) anında görünsün.
        await memory.sync()
        const lessons = memory.recall(asString(input.query) ?? "", {
          role: asString(input.role),
          limit: typeof input.limit === "number" ? input.limit : 10,
          includeRetired: input.include_retired === true,
        })
        const stats = memory.stats()
        const health = memory.health()
        const header = `ORCHESTRA HAFIZA — ${lessons.length} ders (${stats.active} aktif / ${stats.total} toplam / ${stats.pending} bekleyen sinyal)`
        if (lessons.length === 0) {
          return text(
            [
              `Hafızada eşleşen ders yok. Toplam: ${stats.total} kayıt, ${stats.active} aktif, ${stats.pending} dönüştürülmeyi bekleyen sinyal.`,
              ...(health ? [`UYARI: ${health}`] : []),
            ].join("\n"),
          )
        }
        return text([header, "", ...lessons.map(lessonLine), ...(health ? ["", `UYARI: ${health}`] : [])].join("\n"))
      },
    })

    editor.add({
      name: "lesson",
      description:
        "Bu görevi öğretilebilir kılan bir ders yaz. Hata tekrarlandığında gelecekte seni durduracak tek satırlık, " +
        "uygulanabilir kural yaz. Otomatik yakalanmış bir hata imzasını (signature ya da L-xxxx id) derse dönüştürmek için promote kullan.",
      options: { namespace: "orchestra" },
      input: {
        ...OBJECT,
        properties: {
          title: { ...STRING, description: "Tek cümlelik konu başlığı." },
          rule: { ...STRING, description: "Uygulanabilir kural: gelecekte neyi nasıl yapmalısın?" },
          body: { ...STRING, description: "Gerekçe, bağlam, istisna koşulları." },
          tags: { ...STRING_ARRAY, description: "Eşleştirme için kısa etiketler (araç adı, teknoloji, komut)." },
          promote: { ...STRING, description: "Bu dersi dönüştürmek istediğin auto dersin id'si (L-0007) ya da signature'ı." },
          supersedes: { ...STRING, description: "Geçersiz kıldığı dersin id'si (opsiyonel)." },
        },
        required: ["title", "rule"],
        additionalProperties: false,
      },
      execute: async (raw) => {
        const input = raw as LessonInput
        const title = String(input.title ?? "").trim()
        const rule = String(input.rule ?? "").trim()
        if (!title || !rule) return text("HATA: hem 'title' hem 'rule' dolu olmalı.")

        const promoteKey = asString(input.promote)?.trim()
        if (promoteKey) {
          const lesson = await memory.promote({
            id: promoteKey.startsWith("L-") ? promoteKey : undefined,
            signature: promoteKey.startsWith("L-") ? undefined : promoteKey,
            title,
            rule,
            body: String(input.body ?? ""),
            kind: "curated",
          })
          return text(`Ders kaydedildi ve auto hata derse dönüştürüldü: ${lesson.id} — ${lesson.title}`)
        }

        const lesson = await memory.add({
          title,
          rule,
          body: String(input.body ?? ""),
          tags: asArray(input.tags),
          kind: "agent",
          supersedes: asString(input.supersedes),
        })
        return text(`Ders kaydedildi: ${lesson.id} — ${lesson.rule}`)
      },
    })

    editor.add({
      name: "forget",
      description:
        "Yanlış, geçersiz veya artık geçerli olmayan bir dersi emekliye ayır. Hafıza zehirlenmesini bu engeller.",
      options: { namespace: "orchestra" },
      input: {
        ...OBJECT,
        properties: {
          id: { ...STRING, description: "Emekliye ayrılacak dersin id'si (örn. L-0007)." },
          signature: { ...STRING, description: "Ya da auto dersin signature'ı." },
          reason: { ...STRING, description: "Neden emekliye ayrıldığı." },
        },
        additionalProperties: false,
      },
      execute: async (raw) => {
        const input = raw as ForgetInput
        const id = asString(input.id)
        const signature = asString(input.signature)
        if (!id && !signature) return text("HATA: 'id' ya da 'signature' vermelisin.")
        const removed = await memory.forget({ id, signature, reason: asString(input.reason) ?? "manuel" })
        if (removed.length === 0) return text("Eşleşen aktif ders bulunamadı.")
        return text(`${removed.length} ders emekliye ayrıldı: ${removed.map((l) => l.id).join(", ")}`)
      },
    })

    editor.add({
      name: "report",
      description:
        "Otonom döngünün (/loop) her iterasyon sonunda çağrılır. Durumu bildir: continue | done | blocked. " +
        "/loop bu raporu okuyarak döngüyü durdurur ya da devam ettirir.",
      options: { namespace: "orchestra", permission: "orchestra_report" },
      input: {
        ...OBJECT,
        properties: {
          status: {
            type: "string",
            enum: ["continue", "done", "blocked"],
            description: "Bu iterasyonun sonucu.",
          },
          summary: { ...STRING, description: "Bu iterasyonda ne oldu? Tek paragraf, kanıtlı." },
          next: { ...STRING, description: "status=continue ise sıradaki iterasyonun odağı." },
          blockers: { ...STRING_ARRAY, description: "status=blocked ise engeller ve kullanıcıdan gereken karar." },
          evidence: { ...STRING_ARRAY, description: "Doğrulama kanıtı: komut çıktısı, test sonucu, dosya yolu." },
        },
        required: ["status", "summary"],
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = raw as ReportInput
        // ── ROL KAPISI ────────────────────────────────────────────────────
        // Bu aracın TEK yuva olan bir durumu var (state.json -> report) ve
        // /loop onu okuyarak döngüyü durduruyor. Alt ajanların da erişebildiği
        // bir araç olduğu için, bir işçi rol status="done" bildirirse otonom iş
        // erkenden kapanırdı. Bu yüzden yalnızca orkestratör yazabilir.
        //
        // İzin kuralına (bkz. opencode.jsonc) ek olarak burada programatik
        // kapı var: izin boru hattının adı/şekliği değişse bile koruma yerinde
        // kalsın. `context.agent` aracın çağrıldığı roldür.
        if (context.agent !== REPORT_OWNER) {
          return text(
            `HATA: orchestra_report yalnızca '${REPORT_OWNER}' rolü tarafından çağrılabilir; ` +
              `bu çağrı ${context.agent} rolünden geldi ve YAZILMADI. ` +
              `Rolün kendi durumunu raporlaması gerekiyorsa önce mimara aktar.`,
          )
        }
        const status = String(input.status) as ReportState["status"]
        if (status !== "continue" && status !== "done" && status !== "blocked") {
          return text("HATA: status 'continue', 'done' ya da 'blocked' olmalı.")
        }
        const loop = memory.getLoop()
        const report: ReportState = {
          status,
          summary: String(input.summary ?? ""),
          next: asString(input.next),
          blockers: asArray(input.blockers),
          evidence: asArray(input.evidence),
          iteration: loop.iteration ?? 0,
          at: new Date().toISOString(),
        }
        await memory.setReport(report)
        return text(
          `Rapor kaydedildi (iterasyon ${report.iteration}, durum: ${status}).${
            status === "continue" ? " /loop bir sonraki iterasyona geçecek." : " /loop döngüyü durduracak."
          }`,
        )
      },
    })
  })
}
