/**
 * ORCHESTRA bellek motoru.
 *
 * Sorumlulukları:
 *  1. Araç hatalarını otomatik yakalamak ve normalize edilmiş bir "imza"ya indirgemek.
 *  2. Ham hataları kalıcı derslere (agent/curated) dönüştürmek ve tekrarları saymak.
 *  3. Görev metnine göre alakalı dersleri puanlayıp, model çağrısına enjekte etmek.
 *
 * Depo: .opencode/memory/lessons.jsonl (satır satır JSON, git uyumlu, insan okunur)
 */

import { promises as fs } from "node:fs"
import path from "node:path"

export type LessonKind = "auto" | "agent" | "curated"
export type LessonStatus = "active" | "retired"

export interface Lesson {
  /** Kısa, kalıcı kimlik: L-0007 */
  id: string
  kind: LessonKind
  /** Tek satırlık konu başlığı */
  title: string
  /** Uygulanabilir kural: "Bunun yerine şunu yap." */
  rule: string
  /** Ek bağlam / gerekçe */
  body: string
  /** Eşleştirme için etiketler: tool adı, teknoloji, komut adı vb. */
  tags: string[]
  /** Hatanın çıktığı rol (agent id) */
  role?: string
  /** Hatanın çıktığı araç */
  tool?: string
  /** Auto kayıtlar için normalize hata imzası */
  signature?: string
  /** İlk örneklenen normalize hata metni */
  sample?: string
  /** Kaç kez görüldü (auto) / kaç kez hatırlandı (agent) */
  seen: number
  /** Enjeksiyon sayacı */
  hits: number
  status: LessonStatus
  /** 3+ kez tekrarlanıp henüz derse dönüşmediyse true */
  needsLesson?: boolean
  createdAt: string
  updatedAt: string
}

export interface LoopState {
  sessionID?: string
  goal?: string
  max?: number
  iteration?: number
  status: "idle" | "running" | "stopped" | "done" | "blocked" | "exhausted"
  startedAt?: string
  updatedAt?: string
  stopReason?: string
}

export interface ReportState {
  status: "continue" | "done" | "blocked"
  summary: string
  next?: string
  blockers?: string[]
  evidence?: string[]
  iteration: number
  at: string
}

/** Plugin açılışında hangi parçaların başarıyla kaydedildiği. Sessiz kalan arıza olmasın. */
export interface Diagnostics {
  startedAt: string
  steps: Record<string, "ok" | "hata">
  detail?: string
}

interface Store {
  loop: LoopState
  report?: ReportState
  diagnostics?: Diagnostics
}

const MAX_LESSONS = 800
const REPEAT_THRESHOLD = 3
const STOPWORDS = new Set([
  "bir", "bu", "ve", "ile", "için", "olan", "gibi", "daha", "sonra", "veya", "her", "göre",
  "the", "and", "for", "with", "that", "this", "from", "into", "then", "than", "are", "was",
  "ile", "ancak", "çünkü", "olarak", "kadar", "gibi", "yok", "var", "değil",
])

export function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLocaleLowerCase("TR").split(/[^a-z0-9çğıöşü]+/i)) {
    if (raw.length < 4) continue
    if (STOPWORDS.has(raw)) continue
    out.add(raw)
  }
  return out
}

/** Hata mesajını kararlı bir biçime indirger: yol, zaman damgası, sayı, hash gider. */
export function normalizeMessage(message: string): string {
  return (
    message
      .replace(/\r/g, "")
      .replace(/[0-9a-f]{8,}/gi, "<hex>")
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/gi, "<zaman>")
      .replace(/\b\d+ ms\b/gi, "<sure>")
      .replace(/[A-Za-z]:[\\/][^\s"'`|>]*/g, "<yol>")
      .replace(/(?:[\\/])(?:[\w.\-]+[\\/])+[\w.\-]+/g, "<yol>")
      .replace(/:\d+(?::\d+)?/g, ":<n>")
      .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300)
  )
}

function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

function now(): string {
  return new Date().toISOString()
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

/** Dosyanın son değişiklik zamanı. Yoksa -1. */
async function stampOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch {
    return -1
  }
}

export class Memory {
  private lessons: Lesson[] = []
  private store: Store = { loop: { status: "idle" } }
  private chain: Promise<unknown> = Promise.resolve()
  private goal = new Map<string, string>()
  private turn = new Map<string, string>()
  private injected = new Map<string, string>()
  /** Diskteki son gördüğümüz değişiklik zamanı. Dış değişiklikleri algılamak için. */
  private lessonsStamp = -1
  private storeStamp = -1
  /** Henüz diske uygulanmamış otomatik yakalamalar. */
  private queue: Array<{ tool: string; role?: string; message: string; klass?: string }> = []

  private constructor(
    private readonly dir: string,
    private readonly lessonsFile: string,
    private readonly stateFile: string,
  ) {}

  static async open(dir: string): Promise<Memory> {
    await fs.mkdir(dir, { recursive: true })
    const memory = new Memory(dir, path.join(dir, "lessons.jsonl"), path.join(dir, "state.json"))
    await memory.reload()
    return memory
  }

  get directory(): string {
    return this.dir
  }

  async reload(): Promise<void> {
    const [raw, stateRaw] = await Promise.all([readIfExists(this.lessonsFile), readIfExists(this.stateFile)])
    this.lessons = []
    for (const line of (raw ?? "").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as Lesson
        if (parsed && typeof parsed.id === "string" && Array.isArray(parsed.tags)) this.lessons.push(parsed)
      } catch {
        /* bozuk satır: atla */
      }
    }
    if (stateRaw) {
      try {
        const parsed = JSON.parse(stateRaw) as Store
        this.store = { loop: parsed.loop ?? { status: "idle" }, report: parsed.report, diagnostics: parsed.diagnostics }
      } catch {
        this.store = { loop: { status: "idle" } }
      }
    }
    this.lessonsStamp = await stampOf(this.lessonsFile)
    this.storeStamp = await stampOf(this.stateFile)
  }

  /**
   * Depo dosyası dışarıdan değişmişse (elle düzenleme, silme, başka bir
   * örnekçenin yazması) belleği yeniden oku. Aksi halde plugin kendi bayat
   * kopyasını geri yazar ve kullanıcının sıfırlama işlemi sessizce geri alınır.
   */
  private async resync(file: string, stamp: number, setStamp: (value: number) => void): Promise<void> {
    const current = await stampOf(file)
    if (current !== stamp) await this.reload()
    setStamp(current === stamp ? current : (await stampOf(file)))
  }

  /**
   * Dış değişiklik varsa belleği tazeler. Yazma yolları `commit` içinde bunu zaten
   * yapar; okuma yolları (recall, stats) kendi çağrısında yapmalı, yoksa kullanıcı
   * dosyayı düzelttiği hâlde bayat sonuç görür.
   */
  async sync(): Promise<void> {
    await this.write(async () => {
      if ((await stampOf(this.lessonsFile)) !== this.lessonsStamp) await this.reload()
    })
  }

  /** Yazma işlemlerini sıraya alarak disk erişimini serileştirir. */
  private write<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }

  /**
   * TUM ders değişiklikleri buradan geçer.
   *
   * Sıra önemlidir: önce dış değişiklik varsa yeniden oku, SONRA değişikliği
   * uygula, en sonunda yaz. Aksi halde resync, henüz yazılmamış yeni dersi
   * silme/sıfırlama sırasında yok ederdi.
   */
  private commit<T>(mutate: () => T): Promise<T> {
    return this.write(async () => {
      await this.resync(this.lessonsFile, this.lessonsStamp, (value) => (this.lessonsStamp = value))
      const result = mutate()
      await this.flushLessons()
      return result
    })
  }

  private nextId(): string {
    let max = 0
    for (const lesson of this.lessons) {
      const parsed = Number(lesson.id.replace(/^L-/, ""))
      if (Number.isFinite(parsed) && parsed > max) max = parsed
    }
    return `L-${String(max + 1).padStart(4, "0")}`
  }

  /** Yalnızca diske yazar. Yeniden okuma yapmaz; `commit` ve `persistCapture` çağırır. */
  private async flushLessons(): Promise<void> {
    const keep = this.lessons.filter((l) => l.kind !== "auto")
    if (this.lessons.length > MAX_LESSONS) {
      // En eski auto kayıtları önce atılır; curated/agent dersleri korunur.
      const room = Math.max(0, MAX_LESSONS - keep.length)
      const autos = this.lessons.filter((l) => l.kind === "auto")
      this.lessons = [...keep, ...autos.slice(-room)]
    }
    await fs.writeFile(this.lessonsFile, this.lessons.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8")
    this.lessonsStamp = await stampOf(this.lessonsFile)
  }

  /** Yalnızca diske yazar. Yeniden okuma yapmaz; çağıran zaten resync etmiş olmalı. */
  private async persistStore(): Promise<void> {
    await fs.writeFile(this.stateFile, JSON.stringify(this.store, null, 2) + "\n", "utf8")
    this.storeStamp = await stampOf(this.stateFile)
  }

  list(filter?: { status?: LessonStatus; kind?: LessonKind; role?: string }): Lesson[] {
    return this.lessons.filter((l) => {
      if (filter?.status && l.status !== filter.status) return false
      if (filter?.kind && l.kind !== filter.kind) return false
      if (filter?.role && l.role !== filter.role) return false
      return true
    })
  }

  get(id: string): Lesson | undefined {
    return this.lessons.find((l) => l.id === id)
  }

  /**
   * Araç hatasını otomatik kaydeder.
   *
   * Bu metot senkrondur ve belleğe hemen dokunmaz; girdiyi kuyruğa alır.
   * Değişiklik `persistCapture()` çağrıldığında, dış değişiklik kontrolünden
   * SONRA uygulanır. Aksi halde kullanıcı belleği sıfırladığında (dosyayı sildiğinde)
   * sıfırlama, henüz yazılmamış yeni kaydı yok ederdi.
   *
   * `klass` verilirse imza sınıftan üretilir ("komut yok" hatası yüz farklı
   * komutla da olsa tek kayıt olarak birikir). Verilmezse mesajın hash'i kullanılır
   * (gerçekten fırlatılan araç hataları için daha kesin).
   */
  capture(input: { tool: string; role?: string; message: string; klass?: string }): {
    queued: number
    signature: string
  } {
    this.queue.push(input)
    return {
      queued: this.queue.length,
      signature: input.klass ? `${input.tool}:${input.klass}` : `${input.tool}:${hash(normalizeMessage(input.message))}`,
    }
  }

  /** Kuyruktaki yakalamaları uygular ve diske yazar. */
  async persistCapture(): Promise<void> {
    return this.commit(() => {
      for (const item of this.queue.splice(0)) this.applyCapture(item)
    })
  }

  private applyCapture(input: { tool: string; role?: string; message: string; klass?: string }): void {
    const normalized = normalizeMessage(input.message)
    const signature = input.klass
      ? `${input.tool}:${input.klass}`
      : `${input.tool}:${hash(normalized)}`
    const existing = this.lessons.find((l) => l.signature === signature && l.status === "active")
    if (existing) {
      existing.seen += 1
      existing.updatedAt = now()
      if (existing.seen >= REPEAT_THRESHOLD) existing.needsLesson = true
      return
    }
    this.lessons.push({
      id: this.nextId(),
      kind: "auto",
      title: input.klass
        ? `${input.tool} · ${input.klass}`
        : `${input.tool} hatası: ${normalized.slice(0, 90)}`,
      rule: "",
      body: "",
      tags: unique([input.tool, input.klass ?? "", ...tokenize(normalized)]).slice(0, 12),
      role: input.role,
      tool: input.tool,
      signature,
      sample: normalized,
      seen: 1,
      hits: 0,
      status: "active",
      createdAt: now(),
      updatedAt: now(),
    })
  }

  /** Agent/curator tarafından yazılan kalıcı ders. */
  async add(input: {
    title: string
    rule: string
    body?: string
    tags?: string[]
    kind?: LessonKind
    supersedes?: string
  }): Promise<Lesson> {
    return this.commit(() => {
      if (input.supersedes) {
        const old = this.get(input.supersedes)
        if (old && old.status === "active") {
          old.status = "retired"
          old.updatedAt = now()
        }
      }
      const lesson: Lesson = {
        id: this.nextId(),
        kind: input.kind ?? "agent",
        title: input.title.trim(),
        rule: input.rule.trim(),
        body: (input.body ?? "").trim(),
        tags: unique([...(input.tags ?? []), ...tokenize(`${input.title} ${input.rule}`)]).slice(0, 16),
        seen: 0,
        hits: 0,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
      }
      this.lessons.push(lesson)
      return lesson
    })
  }

  /** Yanlış/eskimiş dersleri emekliye ayırır. Hafıza zehirlenmesinin panzehiri. */
  async forget(input: { id?: string; signature?: string; reason?: string }): Promise<Lesson[]> {
    return this.commit(() => {
      const targets = this.lessons.filter((l) => {
        if (l.status !== "active") return false
        if (input.id) return l.id === input.id
        if (input.signature) return l.signature === input.signature
        return false
      })
      for (const target of targets) {
        target.status = "retired"
        target.updatedAt = now()
        target.body = [target.body, `EMEKLI: ${input.reason ?? "manuel"}`].filter(Boolean).join("\n")
      }
      return targets
    })
  }

  /** Auto kaydı, agent/curated derse dönüştürür. */
  async promote(input: {
    signature?: string
    id?: string
    title: string
    rule: string
    body?: string
    kind?: LessonKind
  }): Promise<Lesson> {
    return this.commit(() => {
      const target = this.lessons.find(
        (l) => (input.id ? l.id === input.id : input.signature ? l.signature === input.signature : false) && l.kind === "auto",
      )
      const priorTags = target?.tags ?? []
      const priorSeen = target?.seen ?? 0
      if (target) {
        target.kind = input.kind ?? "curated"
        target.title = input.title.trim()
        target.rule = input.rule.trim()
        target.body = [input.body ?? "", `KAYNAK: ${target.signature} (${target.seen} kez görüldü)`, target.sample ?? ""]
          .filter(Boolean)
          .join("\n")
        target.needsLesson = false
        target.updatedAt = now()
        return target
      }
      const lesson: Lesson = {
        id: this.nextId(),
        kind: input.kind ?? "curated",
        title: input.title.trim(),
        rule: input.rule.trim(),
        body: (input.body ?? "").trim(),
        tags: unique([...priorTags, ...tokenize(`${input.title} ${input.rule}`)]).slice(0, 16),
        seen: priorSeen,
        hits: 0,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
      }
      this.lessons.push(lesson)
      return lesson
    })
  }

  // --- Görev / tur takibi -------------------------------------------------

  setGoal(sessionID: string, text: string, turnKey?: string): void {
    this.goal.set(sessionID, text)
    if (turnKey) this.turn.set(sessionID, turnKey)
    this.injected.delete(sessionID)
  }

  inheritGoal(sessionID: string, parentID: string): void {
    const goal = this.goal.get(parentID)
    if (goal && !this.goal.has(sessionID)) {
      this.goal.set(sessionID, goal)
      this.turn.set(sessionID, this.turn.get(parentID) ?? parentID)
    }
  }

  getGoal(sessionID: string): string | undefined {
    return this.goal.get(sessionID)
  }

  shouldInject(sessionID: string): boolean {
    const turn = this.turn.get(sessionID)
    if (!turn) return true
    if (this.injected.get(sessionID) === turn) return false
    this.injected.set(sessionID, turn)
    return true
  }

  // --- Puanlama / enjeksiyon ---------------------------------------------

  recall(query: string, options?: { role?: string; limit?: number; includeRetired?: boolean }): Lesson[] {
    const goalTokens = tokenize(query)
    const limit = options?.limit ?? 8
    const scored: Array<{ lesson: Lesson; score: number }> = []
    for (const lesson of this.lessons) {
      if (lesson.status !== "active" && !options?.includeRetired) continue
      if (lesson.kind === "auto" && !lesson.rule && !lesson.needsLesson) {
        // Tek seferlik gürültü: sadece tekrar edenler anlamlı.
        if (lesson.seen < REPEAT_THRESHOLD) continue
      }
      let score = 0
      if (options?.role && lesson.role === options.role) score += 3
      if (options?.role && lesson.tags.includes(options.role)) score += 2
      for (const tag of lesson.tags) if (goalTokens.has(tag)) score += 3
      const titleTokens = tokenize(lesson.title)
      let titleHits = 0
      for (const token of titleTokens) if (goalTokens.has(token)) titleHits++
      score += Math.min(8, titleHits * 2)
      const ruleTokens = tokenize(lesson.rule)
      let ruleHits = 0
      for (const token of ruleTokens) if (goalTokens.has(token)) ruleHits++
      score += Math.min(4, ruleHits)
      score += Math.min(2, lesson.seen * 0.25)
      if (lesson.needsLesson) score -= 1
      if (score > 0) scored.push({ lesson, score })
    }
    scored.sort((a, b) => b.score - a.score || b.lesson.seen - a.lesson.seen)
    return scored.slice(0, limit).map((entry) => {
      entry.lesson.hits += 1
      return entry.lesson
    })
  }

  /** Model çağrısına enjekte edilecek kompakt hafıza bloğu. */
  buildBlock(sessionID: string, role: string): string | undefined {
    const goal = this.goal.get(sessionID) ?? ""
    const lessons = this.recall(goal, { role, limit: 6 })
    const pending = this.lessons.filter((l) => l.status === "active" && l.needsLesson).slice(0, 3)
    if (lessons.length === 0 && pending.length === 0) return undefined
    const lines: string[] = []
    lines.push("<orchestra-memory>")
    lines.push("ORCHESTRA HAFIZA — bu proje ve rol için daha önce yaşanmış dersler:")
    for (const lesson of lessons) {
      const label = lesson.rule || lesson.title
      const seen = lesson.seen > 1 ? ` (${lesson.seen} kez)` : ""
      lines.push(`- [${lesson.id}${lesson.tool ? `/${lesson.tool}` : ""}] ${label}${seen}`)
    }
    if (pending.length > 0) {
      lines.push("SİNYAL: tekrar eden ama henüz derse dönüşmemiş hatalar:")
      for (const lesson of pending) {
        lines.push(`- [${lesson.id}] ${lesson.signature ?? lesson.title} x${lesson.seen}`)
      }
      lines.push("Bu kalıplardan biri bu görevde geçerliyse `orchestra_lesson` ile kalıcı derse dönüştür.")
    }
    lines.push("Bu blok her kullanıcı turunda bir kez verilir. Kuralları ihlal etme.")
    lines.push("</orchestra-memory>")
    return lines.join("\n")
  }

  // --- Döngü durumu -------------------------------------------------------

  getLoop(): LoopState {
    return this.store.loop
  }

  getReport(): ReportState | undefined {
    return this.store.report
  }

  async setLoop(patch: Partial<LoopState>): Promise<LoopState> {
    return this.write(async () => {
      // Sıra commit() ile aynı: önce harici değişikliği oku, SONRA patch'i uygula.
      // Aksi halde resync'in reload'u henüz uygulanmamış patch'i silerdi.
      await this.resync(this.stateFile, this.storeStamp, (value) => (this.storeStamp = value))
      this.store.loop = { ...this.store.loop, ...patch, updatedAt: now() }
      await this.persistStore()
      return this.store.loop
    })
  }

  async setReport(report: ReportState): Promise<ReportState> {
    return this.write(async () => {
      await this.resync(this.stateFile, this.storeStamp, (value) => (this.storeStamp = value))
      this.store.report = report
      await this.persistStore()
      return report
    })
  }

  async clearReport(): Promise<void> {
    await this.write(async () => {
      await this.resync(this.stateFile, this.storeStamp, (value) => (this.storeStamp = value))
      delete this.store.report
      await this.persistStore()
    })
  }

  /** Kayıt adımlarının sonucunu not eder. Sessiz arıza üretmemek içindir. */
  async setDiagnostics(diagnostics: Diagnostics): Promise<void> {
    return this.write(async () => {
      await this.resync(this.stateFile, this.storeStamp, (value) => (this.storeStamp = value))
      this.store.diagnostics = diagnostics
      await this.persistStore()
    })
  }

  getDiagnostics(): Diagnostics | undefined {
    return this.store.diagnostics
  }

  /** Tanılama özeti: hepsi tamamsa undefined döner. */
  health(): string | undefined {
    const diagnostics = this.store.diagnostics
    if (!diagnostics) return "plugin tanılaması yok (yeniden başlat)"
    const failed = Object.entries(diagnostics.steps).filter(([, value]) => value !== "ok")
    if (failed.length === 0) return undefined
    return `plugin parçaları kaydedilemedi: ${failed.map(([name]) => name).join(", ")}${diagnostics.detail ? ` — ${diagnostics.detail}` : ""}`
  }

  stats(): { total: number; active: number; auto: number; curated: number; pending: number } {
    const active = this.lessons.filter((l) => l.status === "active")
    return {
      total: this.lessons.length,
      active: active.length,
      auto: this.lessons.filter((l) => l.kind === "auto").length,
      curated: this.lessons.filter((l) => l.kind === "curated" || l.kind === "agent").length,
      pending: this.lessons.filter((l) => l.status === "active" && l.needsLesson).length,
    }
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))]
}
