/**
 * ORCHESTHA araçları.
 *
 * Hafıza motorunu agent'lara açar. Plugin, araç hatalarını kendiliğinden yakalar;
 * bu araçlar "ham hatayı kalıcı derse çevirme" ve "hatırlama" tarafını tamamlar.
 */

import type { Context as PluginContext } from "@opencode/plugin/promise/plugin"
// DİKKAT: `./memory` DEĞER olarak import EDİLMEZ. `memory.ts` parametre özelliği
// kullandığı için Node'un strip-only modunda YÜKLENEMEZ; `capture.test.mjs` bu
// modda `index.ts` → `tools.ts` zincirini çalıştırıyor. Bu yüzden süzgeç,
// tip olarak gelen `Memory` ÜZERİNDEN çağrılır (bkz. `Memory.sanitize`).
import type { Memory, ReportState } from "./memory"
// `./tasks` DEĞER olarak import EDİLEBİLİR: parametre özelliği kullanmaz ve
// strip-only modda yüklenebilir (doğrulayan kontrol: `node --experimental-
// strip-types -e "import('./tasks.ts')"`). Defter OTURUMA BAĞLIDIR, bu yüzden
// her çağrıda `context.sessionID` ile açılır.
import { TaskLedger, type LedgerResult } from "./tasks.ts"

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

/**
 * `orchestra_task` girdisi. Tek araç, üç iş yapar:
 *  - `id` YOKSA → yeni görev açar (title zorunlu)
 *  - `id` + `status` → durum geçişi (kanıt eklenebilir)
 *  - `id` + `status` YOKSA → alan güncellemesi / kanıt ekleme
 *
 * `dependsOn` yalnız AÇILIŞTA verilir: bağımlılık sonradan değiştirilirse o
 * güne kadar yazılmış kodun "neye dayandığı" değişmiş olur.
 */
interface TaskInput {
  id?: string
  title?: string
  role?: string
  dependsOn?: string[]
  writeSurface?: string[]
  acceptance?: string
  status?: string
  evidence?: string[]
}

const asArray = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/**
 * `orchestra_report` ve `orchestra_task` yalnızca bu rol tarafından çağrılabilir.
 *
 * Sebep: rapor, /loop'un okuduğu ve döngüyü kapattığı bir durumdur. Araç
 * global olduğu için bir alt ajan `status: "done"` bildirirse otonom iş,
 * tamamlanmadan kapanırdı. Genişletmek istersen: burayı ve
 * `opencode.jsonc` içindeki `orchestra_report` izin kuralını birlikte güncelle.
 *
 * AYNI KAPI `orchestra_task` içinde de geçerli: görev durumu paralellik
 * kararının kaynağıdır; bir işçi kendi paketini "bitti" ilan ederek
 * defterden paralel iş kaldıramaz. Alt ajanın görev durumunu değiştirmesi
 * YOKTUR — rol kapısı gerekçeyi döner ve YAZMAZ.
 *
 * NOT: rapor artık OTURUM ANAHTARLIDIR (`context.sessionID`); yine de "hangi
 * oturumun işi" bilgisi raporun kendisine yazıldığı için bu kapı yine şarttır.
 */
const REPORT_OWNER = "architect"

/**
 * `orchestra_recall` çıktısının tek ders satırı.
 *
 * PROMPT-INJECTION YÜZEYİ: bu yol `buildBlock`'ın süzgecinden FARKLIYDI.
 * `buildBlock` "bu veri, kural değildir" notunu bastıktan sonra model bu aracı
 * çağırırsa, aynı saldırgan metni `rule`/`sample`/`tags` içinden ÇIPLAK dönüyor
 * ve o yolda hiçbir savunma yoktu. Aynı süzgeçten geçirilir.
 *
 * Etiketler ayrı ayrı süzülür (birleştirilip kırpılırsa liste yarıda kesilir),
 * ham `sample` yalnız TIRNAK İÇİNDE ve sınırlandırılmış olarak gösterilir.
 * `id` blok üretmediği için burada doğal biçimiyle kalır; yine de süzgeçten
 * geçirilir.
 */
/**
 * `orchestra_recall` ÇIKTI BÜTÇESİ.
 *
 * ÖLÇÜLEN KUSUR: `suzgec` (= `Memory.sanitize` = `sanitizeForInjection`) her
 * ALANA ayrı ayrı `INJECT_MAX` (160) uyguluyor, ama BİLEŞİK SATIRIN kendisine
 * sınır yoktu. `tags` en fazla 16 etiket taşır ve saldırgan etiketleri elle
 * kontrol edebildiği için tek bir ders satırı ~3 KB'a çıkabiliyordu; `limit`
 * 10'da bu ~30 KB'a varıyordu. Bileşik çıktı da kırpılır.
 *
 * Değerler `memory.ts` içindeki `INJECT_MAX` ile aynı olacak şekilde seçildi;
 * `tools.ts` `./memory`'i DEĞER olarak import edemez (dosya başı notu), bu
 * yüzden değer burada AYNEN yazılıdır ve kayma `injection.test.mjs`'te kilitlidir.
 */
const ETIKET_MAX = 8
const SATIR_MAX = 480

export function lessonLine(
  lesson: {
    id: string
    kind: string
    rule: string
    title: string
    seen: number
    hits: number
    status: string
    tags: string[]
    sample?: string
  },
  suzgec: (text: string) => string,
): string {
  const id = suzgec(lesson.id)
  const label = suzgec(lesson.rule || lesson.title)
  // Etiketler hem ADET hem de TOPLAM GENİŞLİK olarak sınırlanır: 8 etiket ×
  // 160 karakter sütunda yine sınırı zorlar.
  const etiketler: string[] = []
  let etiketGenislik = 0
  for (const tag of lesson.tags.map((t) => suzgec(t)).filter(Boolean)) {
    if (etiketler.length >= ETIKET_MAX) break
    if (etiketGenislik + tag.length > 120) break
    etiketler.push(tag)
    etiketGenislik += tag.length + 2
  }
  const meta = `— etiketler: ${etiketler.join(", ") || "-"} | görülme: ${lesson.seen}, hatırlanma: ${lesson.hits}`
  const ornek = lesson.sample ? suzgec(lesson.sample) : ""
  const satir = `${id} [${lesson.kind}/${lesson.status}] ${label} ${meta}`
  const kirp = (metin: string) => (metin.length > SATIR_MAX ? `${metin.slice(0, SATIR_MAX - 1).trimEnd()}…` : metin)
  return ornek
    ? `${kirp(satir)}\n    örnek (veri): "${ornek}"`
    : kirp(satir)
}

/**
 * `LedgerResult` → modele giden tek satırlık özet.
 *
 * `ok: false` çıktısının `HATA` ile başlaması ZORUNLUDUR: V2'de araç hatası
 * yalnız metinden okunur (sıfır dışı çıkış kodu hata sayılmaz) ve
 * `orchestra_recall`/`buildBlock` çıktısı tarama dışıdır. Yani bu satır
 * kullanıcıya gider; modelin "yaptım" demesini engelleyen şey budur.
 */
function ledgerMetni(result: LedgerResult, eylem: string): string {
  if (!result.ok) return result.error
  const satirlar: string[] = []
  const task = result.task
  if (task) {
    satirlar.push(`${eylem}: ${task.id} [${task.status}] ${task.title}`)
    if (task.dependsOn.length > 0) satirlar.push(`  bağımlılık: ${task.dependsOn.join(", ")}`)
    if (task.writeSurface.length > 0) satirlar.push(`  yazma yüzeyi: ${task.writeSurface.join(", ")}`)
    if (task.evidence.length > 0) satirlar.push(`  kanıt (${task.evidence.length}): ${task.evidence.join(" | ")}`)
  } else {
    satirlar.push(`${eylem} tamamlandı.`)
  }
  for (const note of result.notes) satirlar.push(`  ${note.tur === "uyari" ? "UYARI" : "bilgi"}: ${note.metin}`)
  if (result.overflow.length > 0) {
    satirlar.push(`  BÜTÇE AŞIMI: ${result.overflow.map((o) => `${o.axis} ${o.actual}/${o.limit} — ${o.reason}`).join("; ")}`)
  }
  return satirlar.join("\n")
}

/**
 * Oturumun görev defterini açar.
 *
 * Defter oturum anahtarlıdır (`state.json` → `taskVaults[oturum]`); iki oturum
 * birbirinin görevini göremez. `location` yoksa bütçe güvenli varsayılana
 * düşer (`loadBudgetConfig`), yani kök bilinmese bile defter çalışır.
 *
 * AÇILAMAZSA fırlatmaz, `undefined` döner: görev defteri plugin'in kritik
 * olmayan bir parçasıdır ve model çağrısını bozmamalıdır.
 */
/**
 * Alt ajana hangi defterin gösterildiğini söyler — aksi halde "Toplam görev: 0"
 * gerçek bir bulgu gibi görünür ve alt ajan yanlış bilgiye güvenir.
 */
function notEkle(okunanOturum: string, istenenOturum: string): string {
  if (okunanOturum === istenenOturum) return ""
  return `\n\nNot: alt ajan oturumundasın; bu, ${okunanOturum} oturumunun görev defteridir. Kendi oturumunda görev yoktur.`
}

async function openLedger(ctx: PluginContext, memory: Memory, sessionID: string): Promise<TaskLedger | undefined> {
  try {
    return await TaskLedger.open(memory, ctx.location?.directory, sessionID)
  } catch {
    return undefined
  }
}

/** Oturum okuma yüzeyi — `ctx.session.get`'in bu dosyada kullanılan KISMIDIR. */
export interface OturumOkuyucu {
  session: {
    get(input: { sessionID: string }): Promise<{ parentID?: string } | undefined>
  }
}

/** Görev yuvası okuma yüzeyi — `Memory.getTaskVault` bunu karşılar. */
export interface YuvaOkuyucu {
  getTaskVault(sessionID: string): {
    tasks?: unknown[]
    budget?: { startedAt?: number; iterations?: number; tasks?: number }
  }
}

/** Yürüyüş tavanı. `index.ts → ensureGoal` ile AYNI (döngü ve derinlik). */
export const YURUYUS_TAVANI = 6

/**
 * Bu oturumun defteri anlamlı bilgi taşıyor mu?
 *
 * "Dolu" = görev var YA da bütçe sayacı iş görmüş (duvar saati başlamış, iş
 * adımı sayılmış, görev sayılmış). Hepsi sıfırsa defter boştur ve `status`
 * oradan okursa "Toplam görev: 0" der — gerçek bir bulgu gibi görünür.
 */
function doluMu(memory: YuvaOkuyucu, sessionID: string): boolean {
  try {
    const yuva = memory.getTaskVault(sessionID)
    if (Array.isArray(yuva?.tasks) && yuva.tasks.length > 0) return true
    const butce = yuva?.budget
    if (!butce) return false
    return (butce.startedAt ?? 0) > 0 || (butce.iterations ?? 0) > 0 || (butce.tasks ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * OKUMA YOLUNDA hangi oturumun defteri gösterilecek?
 *
 * ÖLÇÜLEN KUSUR (v1 → v2): `mimarOturumu` `parentID` zincirini sonuna kadar
 * yürüyor, yani **en üst köke** çıkıyor. İki kademe arasındaki oturumun defteri
 * doluysa o görevler hiç görünmüyordu: `child → parent(dolu) → root(boş)`
 * zincirinde `status` boş kök defterini gösteriyordu.
 *
 * KURAL (okuma yolu):
 *  1. **Kendi defteri doluysa** hiç yürünmez. Alt ajanın kendi işi varken
 *     mimarın defteri gösterilmez — defter OTURUMA bağlıdır, karıştırılırsa
 *     yanlış bilgi okunur.
 *  2. Aksi halde **EN YAKIN** dolu ata seçilir (aradaki her oturum denenir).
 *  3. Hiçbiri dolu değilse en üste çıkılan oturum döner: mimarın kendi boş
 *     defteri eski davranışta da buydu ve bu yol bilgi KAYBETMEZ.
 *
 * BAĞIMSIZ OTURUMA YÜKSELME YOK: yalnızca `parentID` kenarı izlenir, yani
 * soy zincirinin dışına (kardeşe, yabancı oturuma) asla çıkılmaz.
 *
 * GÜVENLİK: derinlik `YURUYUS_TAVANI` ile sınırlı, görülen oturumlar küme
 * ile takip edilir (döngü `A→B→A` sonsuza kadar yürümez) ve `session.get`
 * hata verirse o anda durulur — çağıran (bir ARAÇ çıktısı) asla çıplak
 * fırlatmaz.
 *
 * YAZMA YOLU BU ÇÖZÜMLEMEYİ KULLANMAZ: `orchestra_task` yalnızca
 * `context.sessionID` ile yazar. Bir alt ajanın görevi mimarın defterine
 * yazılırsa defter kimliği kaybolur; ayrıca aracın kendi `context.agent` kapısı
 * zaten alt ajanın yazmasını reddeder.
 */
export async function okunacakOturum(ctx: OturumOkuyucu, memory: YuvaOkuyucu, sessionID: string): Promise<string> {
  if (doluMu(memory, sessionID)) return sessionID
  const gorulen = new Set<string>([sessionID])
  let current = sessionID
  let kok = sessionID
  for (let depth = 0; depth < YURUYUS_TAVANI; depth++) {
    let parent: string | undefined
    try {
      const session = await ctx.session.get({ sessionID: current })
      const aday = session?.parentID
      if (typeof aday === "string" && aday.length > 0) parent = aday
    } catch {
      return kok /* oturum okunamıyorsa burada dur */
    }
    if (!parent) return kok /* köke gelindi */
    if (gorulen.has(parent)) return kok /* döngü: tekrar görülen oturum */
    gorulen.add(parent)
    kok = parent
    if (doluMu(memory, parent)) return parent /* EN YAKIN dolu ata */
    current = parent
  }
  return kok
}

const DEFTER_YOK =
  "HATA: görev defteri açılamadı. Plugin tanılamasına bak (orchestra_recall çıktısındaki UYARI satırı). Bu çağrıda HİÇBİR ŞEY yazılmadı."

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
        return text([header, "", ...lessons.map((lesson) => lessonLine(lesson, memory.sanitize)), ...(health ? ["", `UYARI: ${health}`] : [])].join("\n"))
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
        "Bu oturumdaki otonom döngünün (/loop) her iterasyon sonunda çağrılır. Durumu bildir: continue | done | blocked. " +
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
        // Rapor /loop'un okuyup döngüyü kapattığı bir durumdur ve araç global
        // olduğu için alt ajanlar da erişebilir. Bir işçi rol status="done"
        // bildirirse otonom iş erkenden kapanır (ve üstelik kendi oturumu
        // dışındaki bir döngüyü de kapatabilirdi). Bu yüzden yalnızca orkestratör
        // yazar.
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
        // Döngü durumu ARTIK oturum anahtarlıdır: parametresiz `getLoop()` çağırmak
        // başka bir oturumun döngüsünü okurdu (ve raporu o yazıya yazardı).
        const sessionID = context.sessionID
        await memory.syncStore()
        const loop = memory.getLoop(sessionID)
        const report: ReportState = {
          sessionID,
          runID: loop.runID,
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
          `Rapor kaydedildi (oturum ${sessionID}, iterasyon ${report.iteration}, durum: ${status}).${
            status === "continue" ? " /loop bir sonraki iterasyona geçecek." : " /loop döngüyü durduracak."
          }`,
        )
      },
    })

    editor.add({
      name: "task",
      description:
        "Görev defterini yaz: iş paketi aç, durum değiştir, kanıt ekle. Reddedilen şeyler koda gömülüdür: " +
        "geçersiz durum geçişi (planned→done atlamak), bitmemiş bağımlılıkla running, döngüsel bağımlılık ve " +
        "kanıtsız/kabul kriterisiz done. Yazma yüzeyi kesişimi ENGELLEMEZ, raporlar — karar senin.",
      options: { namespace: "orchestra", permission: "orchestra_task" },
      input: {
        ...OBJECT,
        properties: {
          id: { ...STRING, description: "Görev kimliği (P1, P2…). Boş bırakılırsa YENİ görev açılır." },
          title: { ...STRING, description: "Yeni görevin tek satırlık konu başlığı." },
          role: { ...STRING, description: "Bu paketi hangi crew rolü yapacak." },
          dependsOn: { ...STRING_ARRAY, description: "Bu görev başlamadan önce 'done' olması gereken görevler. YALNIZ açılışta." },
          writeSurface: { ...STRING_ARRAY, description: "Dokunacağı yollar. Kesişen koşan görevler TESPİT edilir (engel değil)." },
          acceptance: { ...STRING, description: "Kabul kriteri. 'done' geçişi için zorunludur." },
          status: { ...STRING, description: "Hedef durum: planned | running | verifying | done | blocked | failed." },
          evidence: { ...STRING_ARRAY, description: "Kanıt: test çıktısı, dosya yolu, komut sonucu. 'done' için zorunludur." },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        const input = raw as TaskInput
        // ── ROL KAPISI ────────────────────────────────────────────────────
        // `orchestra_report` ile AYNI gerekçe: görev durumu, o işin
        // paralellik ve bağımlılık kararının kaynağıdır. Alt ajan kendi
        // paketini "bitti" ilan ederek defterden iş kaldıramaz; kanıtını
        // mimar aracılığıyla ekler. Programatik kapı, izin boru hattı
        // değişse bile korur.
        if (context.agent !== REPORT_OWNER) {
          return text(
            `HATA: orchestra_task yalnızca '${REPORT_OWNER}' rolü tarafından çağrılabilir; ` +
              `bu çağrı ${context.agent} rolünden geldi ve YAZILMADI. ` +
              `Kanıtını rapor metnine yaz; görev durumunu mimar günceller.`,
          )
        }
        // YAZMA YOLU ASLA YÜKSELMEZ: defter daima `context.sessionID` ile
        // açılır. Alt ajan kanıtını/başlığını mimar defterine yazmaz.
        const defter = await openLedger(ctx, memory, context.sessionID)
        if (!defter) return text(DEFTER_YOK)
        const id = asString(input.id)?.trim()
        try {
          if (!id) {
            const sonuc = await defter.add({
              title: asString(input.title) ?? "",
              role: asString(input.role),
              dependsOn: asArray(input.dependsOn),
              writeSurface: asArray(input.writeSurface),
              acceptance: asString(input.acceptance),
            })
            return text(ledgerMetni(sonuc, "Görev açıldı"))
          }
          const sonuc = await defter.update({
            id,
            status: asString(input.status),
            evidence: input.evidence === undefined ? undefined : asArray(input.evidence),
            title: asString(input.title),
            role: asString(input.role),
            acceptance: asString(input.acceptance),
            writeSurface: input.writeSurface === undefined ? undefined : asArray(input.writeSurface),
          })
          return text(ledgerMetni(sonuc, input.status ? `Durum güncellendi (${input.status})` : "Görev güncellendi"))
        } catch (error) {
          return text(`HATA: görev defteri yazılamadı: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })

    editor.add({
      name: "status",
      description:
        "Görev defteri + bütçe tek ekranda: kim ne yapıyor, hangi yüzeyler çakışıyor, bütçe nerede. " +
        "/standup komutunun veri kaynağı. Her rol çağırabilir (yalnızca OKUR).",
      options: { namespace: "orchestra" },
      input: {
        ...OBJECT,
        properties: {
          section: { ...STRING, description: "Yalnız 'budget' ya da 'conflicts' ile tek bölüm iste (opsiyonel)." },
        },
        additionalProperties: false,
      },
      execute: async (raw, context) => {
        // Alt ajan kendi oturumundaki BOŞ defteri görmemeli: en yakın dolu
        // ata defteri okunur (bkz. `okunacakOturum`).
        const okumaOturumu = await okunacakOturum(ctx, memory, context.sessionID)
        const defter = await openLedger(ctx, memory, okumaOturumu)
        if (!defter) return text(DEFTER_YOK)
        const section = asString((raw as { section?: string } | undefined)?.section)?.trim()
        try {
          await defter.refreshConfig()
          const satirlar = defter.status()
          if (section === "budget") {
            const butce = satirlar.filter((satir) => satir.includes("Bütçe:") || satir.includes("AŞIM:"))
            return text(butce.join("\n") || "Bütçe kaydı yok.")
          }
          if (section === "conflicts") {
            const cakisma = satirlar.filter((satir) => satir.includes("ÇAKIŞMA:"))
            return text(cakisma.join("\n") || "Yazma yüzeyi çakışması yok.")
          }
          return text(satirlar.join("\n") + notEkle(okumaOturumu, context.sessionID))
        } catch (error) {
          return text(`HATA: görev defteri okunamadı: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
  })
}
