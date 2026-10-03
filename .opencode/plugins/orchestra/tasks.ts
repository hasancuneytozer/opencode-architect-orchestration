/**
 * ORCHESTRA görev defteri ve bütçe takibi.
 *
 * NEDEN VAR: bugün iş paketleri yalnız MODELİN UYMASI BEKLENEN metin
 * (`skills/dispatch/SKILL.md`). Kod, "iki paket aynı dosyaya yazıyor" ya da
 * "bağımlılığı bitmemiş görev başladı" kararının hiçbir satırını görmüyor.
 * Protokol güzel ama zorlanmıyor. Bu dosya o kararları SAF fonksiyonlara
 * indirger: durum makinesi, yazma yüzeyi kesişimi, bağımlılık sırası,
 * döngüsel bağımlılık ve kanıt zorunluluğu artık modele bırakılmıyor.
 *
 * İKİ KURAL, TASARIMIN BELİRLEYİCİSİ:
 *  1. Yazma yüzeyi çakışması ENGELLEMEZ, **TESPİT EDER**. Eşleşen iki `running`
 *     görevi bulmak mimarın işidir; sistem yalnız görünür kılar ve gerekçeyi
 *     döner. (Sessizce engelleyen bir sistem, nedenini açıklayamayan bir
 *     mimardan daha kötüdür.)
 *     KAPSAMI: bu kural GÖREVLER ARASI çakışma içindir. Kendi beyanını geri
 *     almak — yani `planned` dışındayken `writeSurface`'i daraltmak — çakışmayı
 *     silmektir, o yüzden ayrı ve atomik bir REDDEDİLME'dir (bkz. `update`).
 *  2. Bütçe AŞIMI bildirir, **DURDURMAZ**. Durduran `/loop`'tur (bkz. `loop.ts`);
 *     bu katman yalnız ölçer.
 *
 * YÜKLEME: bu dosya Node'un strip-only modunda (`--experimental-strip-types`)
 * yüklenebilir olmalıdır; `capture.test.mjs` `index.ts` → `tools.ts` →
 * `tasks.ts` zincirini o modda çalıştırır. Bu yüzden PARAMETRE ÖZELLİĞİ
 * KULLANILMAZ ve `memory.ts` yalnız `import type` ile dokunulur.
 *
 * PERSİSTANS: `state.json` içindeki OTURUM ANAHTARLI `taskVaults` yuvası
 * (`memory.ts` → `getTaskVault`/`setTaskVault`). Yazma yolu, kilit ve bozuk
 * dosya karantinası `memory.ts`'in kendisindedir; burada TEKRAR YAZILMAZ.
 */

import { promises as fs } from "node:fs"
import path from "node:path"
// DİKKAT: `./memory` DEĞER olarak import EDİLMEZ (dosya başı notu). Yalnız tip.
import type { Memory } from "./memory"

// ─────────────────────────────────────────────────────────────────────────────
// 1. Şema
// ─────────────────────────────────────────────────────────────────────────────

export type TaskStatus = "planned" | "running" | "verifying" | "done" | "blocked" | "failed"

export const TASK_STATUSES: readonly TaskStatus[] = [
  "planned",
  "running",
  "verifying",
  "done",
  "blocked",
  "failed",
]

export interface TaskRecord {
  /** Kısa, kalıcı kimlik: P1, P2 … */
  id: string
  title: string
  /** Hangi crew rolü bu paketi yapacak. */
  role?: string
  /** Bu paket başlamadan önce `done` olması gereken görevler. */
  dependsOn: string[]
  /** Dokunacağı yollar. Kesişim karşılaştırması bu alanda yapılır. */
  writeSurface: string[]
  /** Kabul kriteri. `done`'a geçişte zorunludur. */
  acceptance: string
  status: TaskStatus
  /** Doğrulama kanıtı. `done`'a geçişte BOŞ OLAMAZ. */
  evidence: string[]
  startedAt?: string
  finishedAt?: string
  /** Bu kaydın ait olduğu oturum. */
  sessionID?: string
  createdAt?: string
  updatedAt?: string
}

/**
 * Durum makinesi.
 *
 * `planned → running → verifying → done` omurgası KIRILAMAZ; `planned`'dan
 * `done`'a atlamak reddedilir (yapılan iş kanıtlanmadan bitti sayılmaz).
 * `verifying` → `running` geri dönüşü vardır: doğrulama reddedince iş devam
 * eder, görev yeniden açılmaz.
 *
 * BİTİŞ HALİ `blocked`/`failed` DA KALICI. Yeniden deneme YENİ bir görev
 * kimliği demektir; aksi halde "defterde kaç iş yapıldı" sorusunun cevabı
 * sessizce düzeltilmiş olurdu.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  planned: ["running", "blocked", "failed"],
  running: ["verifying", "blocked", "failed"],
  verifying: ["done", "running", "blocked", "failed"],
  done: [],
  blocked: [],
  failed: [],
}

export interface BudgetConfig {
  /** Toplam duvar saati. 0 → kapalı. */
  maxWallClockMs: number
  /** Toplam iş adımı (görev `running`'e geçiş sayısı). 0 → kapalı. */
  maxIterations: number
  /** Aynı anda koşabilecek görev sayısı. 0 → kapalı. */
  maxConcurrentTasks: number
  /** Bir hedef için açılabilecek görev sayısı. 0 → kapalı. */
  maxTasksPerGoal: number
}

/**
 * GÜVENLİ VARSAYILANLAR.
 *
 * `maxWallClockMs` bilerek `loop.ts`'in `DEFAULT_MAX_WALL_CLOCK_MS` ile AYNI
 * değerdedir (4 saat) ama AYRI bir sayacı ölçer: `/loop` kendi çalıştırmasının
 * duvar saatini, buradaki bütçe o hedefin defter ömrünü sayar. İkisi
 * çelişirse (biri diğerini geçerse) raporda belirtilir.
 */
export const DEFAULT_BUDGET: BudgetConfig = {
  maxWallClockMs: 14_400_000,
  maxIterations: 50,
  maxConcurrentTasks: 8,
  maxTasksPerGoal: 200,
}

/**
 * Bir oturumun görev defterinde tutulan TEK görev sayısı.
 *
 * `state.json`'ın ölçülen kusuru sınırsız büyümekti (1000 oturum → 328 KB).
 * Aynı hatanın görev tarafına taşınmaması için sert bir tavan var. `done`
 * görevler ÖNCE atılır; koşan görev asla atılmaz.
 */
export const MAX_STORED_TASKS = 300

export interface BudgetState {
  /** Duvar saatinin başladığı an (epoch ms). 0 → henüz başlamadı. */
  startedAt: number
  /** Kaç kez bir görev `running`'e geçti. */
  iterations: number
  /** Bu oturumda açılan toplam görev sayısı (budalama sayacı DEĞİLDİR). */
  tasks: number
}

export interface TaskBoard {
  tasks: TaskRecord[]
  budget: BudgetState
}

export const EMPTY_BUDGET: BudgetState = { startedAt: 0, iterations: 0, tasks: 0 }

export function emptyBoard(): TaskBoard {
  return { tasks: [], budget: { ...EMPTY_BUDGET } }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Yazma yüzeyi kesişimi (saf)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Yazma yüzeyi desenini normalleştirir.
 *
 * Normalizasyon kuralları:
 *  - `\` → `/` (Windows yazımı POSIX yazımıyla aynı yüzeyi gösterir)
 *  - sürücü harfi küçük harfe iner (`C:` ile `c:` aynı yoldur)
 *  - `./` silinir, `//` tekilleştirilir, `..` çözülür
 *  - sondaki `/` anlamsızdır ve silinir: `src/` ≡ `src`
 *
 * Joker (`*`) varsa sondaki `/` KORUNMAZ: jokerli bir desenin sondaki eğik
 * çizgisi anlamsızdır (yol sonu değil, devamı belirtir).
 *
 * BÜYÜK/KÜÇÜK HARF: **ÇALIŞAN PLATFORMUN KURALI UYGULANIR.** Windows'ta yol
 * karakter duyarsızdır (`C:\Proj\A.ts` ile `c:/proj/a.ts` AYNI dosyadır); POSIX
 * dosya sisteminde duyarlıdır. Ölçülen kusur: harf normalizasyonu HİÇ
 * yapılmadığı için Windows'ta aynı dosyanın iki yazımı iki ayrı yüzey sayılıyor,
 * yani gerçek bir çakışma sessizce KAÇIYORDU (yanlış negatif). Bunu her platformda
 * küçültmekle kapatmak da yanlış POZİTİF üretirdi (POSIX'te var olmayan çakışma).
 * Tek yanıltmayan yer: o an gerçekten koşan platformun kuralı. `WINDOWS_YOL_SEMANTIGI`
 * testte de okunabilir olsun diye export edilir (imza `normalizeSurface` DEĞİŞMEDİ).
 *
 * Bu, çakışma bildiriminin bir **uyarı** olduğu ilkesiyle çelişmez: duyarsızlık
 * eksikliği bir uyarıyı GİZLEMEKTİ, görünür kılıyordu.
 */
export const WINDOWS_YOL_SEMANTIGI: boolean = process.platform === "win32"

export function normalizeSurface(raw: string): string {
  if (typeof raw !== "string") return ""
  const ilk = raw.trim()
  if (ilk === "") return ""
  const jokerli = ilk.includes("*")
  let out = ilk.replace(/\\/g, "/")
  out = out.replace(/^([A-Za-z]):\//, (_all, surucu: string) => `${surucu.toLowerCase()}:/`)
  const unc = out.startsWith("//")
  const parcalar = out.split("/").filter((parca) => parca !== "" && parca !== ".")
  const yigin: string[] = []
  for (const parca of parcalar) {
    if (parca === "..") {
      const son = yigin[yigin.length - 1]
      if (yigin.length > 0 && son !== "..") yigin.pop()
      else yigin.push("..")
      continue
    }
    yigin.push(parca)
  }
  let sonuc = yigin.join("/")
  if (unc) sonuc = `/${sonuc}`
  if (!jokerli && sonuc.length > 1 && sonuc.endsWith("/")) sonuc = sonuc.slice(0, -1)
  // Harf duyarsızlığı yalnız Windows'ta: normalleştirilmiş desen ile normalleştirilmiş
  // tanık aynı ölçekte küçültülür, karşılaştırma simetrik kalır.
  if (WINDOWS_YOL_SEMANTIGI) sonuc = sonuc.toLowerCase()
  return sonuc
}

export function isWildcardSurface(raw: string): boolean {
  return normalizeSurface(raw).includes("*")
}

/** Jokerli deseni tam satır eşleşmesine çevirir. `*` = her şey (`/` dâhil). */
function globDeseni(p: string): RegExp {
  const kacis = p.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${kacis}$`)
}

/** Jokerli bir desenin somut tanığı: `*` → `x`. */
function tanik(p: string): string {
  return p.replace(/\*/g, "x")
}

/** İlk `*`'den önceki DİZİN öneki (`src/*` → `src`, `*` → ""). */
function kok(p: string): string {
  const ilk = p.indexOf("*")
  if (ilk < 0) return p
  const once = p.slice(0, ilk)
  const son = once.lastIndexOf("/")
  return son < 0 ? "" : once.slice(0, son)
}

/** Bir yol diğerinin atası mı? SEGMENT sınırında: `src` ⊃ `srcfoo` DEĞİLDİR. */
function ataMi(buyuk: string, kucuk: string): boolean {
  if (buyuk === "" || kucuk === "") return false
  return buyuk === kucuk || kucuk.startsWith(`${buyuk}/`) || buyuk.startsWith(`${kucuk}/`)
}

/**
 * İki yazma yüzeyi deseni kesişiyor mu?
 *
 * Kesişim iki yönlü kanıtla aranır: `A` deseni `B`'nin somut tanığını
 * tutuyorsa kesişirler (ve tersi). Ham glob eşleştirme tek yönlü olduğu için
 * tek yön yetmez: `src/a.ts` deseni `src/*` deseninin tanığını TUTMAZ, ama
 * ikisi aynı yüzeye yazabilir.
 */
export function surfacesIntersect(a: string, b: string): boolean {
  const na = normalizeSurface(a)
  const nb = normalizeSurface(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes("*") || nb.includes("*")) {
    if (globDeseni(na).test(tanik(nb))) return true
    if (globDeseni(nb).test(tanik(na))) return true
    if (ataMi(kok(na), kok(nb))) return true
  }
  return ataMi(na, nb)
}

export interface Conflict {
  /** İki görevden eski olan (sıra kararlı olsun diye küçük id önce). */
  a: string
  b: string
  /** Kesişen yol deseni. */
  surface: string
}

/**
 * İki görevin yazma yüzeylerinin kesişen DESENLERİ (normalize edilmiş hâli).
 *
 * `findConflicts` ve "yeni görev açılırken" yolu aynı hesabı kullanır: ikincisi
 * henüz `planned` olan yeni görevi `findConflicts`'e sokamaz (o yol yalnız
 * `running` çiftleri arar), ama kesişim yine de şimdiden görünmelidir.
 */
export function conflictsBetween(a: TaskRecord, b: TaskRecord): string[] {
  const gorulen = new Set<string>()
  const cikti: string[] = []
  for (const s1 of a.writeSurface) {
    for (const s2 of b.writeSurface) {
      if (!surfacesIntersect(s1, s2)) continue
      const yuzey = normalizeSurface(s1)
      if (gorulen.has(yuzey)) continue
      gorulen.add(yuzey)
      cikti.push(yuzey)
    }
  }
  return cikti
}

/**
 * `running` görevler arasındaki yazma yüzeyi çakışmaları.
 *
 * `onlyId` verilirse yalnız O görevin çakışmaları döner (kendisi hariç).
 * TESPİTTİR: sonuç boş değilse bile görev `running`'e geçebilir.
 */
/**
 * Çakışan görev çiftleri.
 *
 * `verifying` DAHİLDİR: kanıt toplanırken dosya hâlâ düzeltiliyor olabilir,
 * yani çakışmanın en tehlikeli olduğu an tam olarak budur. Ölçülen kusur:
 * `verifying` görevler tespit dışıydı, "P1 verifying, P2 planlı → çakışma yok"
 * çıkıyordu.
 */
const AKTIF_DURUMLAR: ReadonlySet<TaskStatus> = new Set(["running", "verifying"])

export function findConflicts(tasks: TaskRecord[], onlyId?: string): Conflict[] {
  const kosan = tasks.filter((task) => AKTIF_DURUMLAR.has(task.status))
  const cikti: Conflict[] = []
  const gorulen = new Set<string>()
  for (let i = 0; i < kosan.length; i++) {
    for (let j = i + 1; j < kosan.length; j++) {
      const ilk = kosan[i]
      const ikinci = kosan[j]
      const cift = ilk.id <= ikinci.id ? [ilk, ikinci] : [ikinci, ilk]
      if (onlyId && cift[0].id !== onlyId && cift[1].id !== onlyId) continue
      for (const yuzey of conflictsBetween(ilk, ikinci)) {
        const anahtar = `${cift[0].id}|${cift[1].id}|${yuzey}`
        if (gorulen.has(anahtar)) continue
        gorulen.add(anahtar)
        cikti.push({ a: cift[0].id, b: cift[1].id, surface: yuzey })
      }
    }
  }
  return cikti
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Döngüsel bağımlılık (saf)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `edges[id] = [bağımlı olunanlar]` çizgesinde `start` düğümünden başlayarak
 * bir döngü varsa onu (`A → B → A`) döner, yoksa `undefined`.
 *
 * SAF: girdi haritası MUTASYONA UĞRAMAZ. Çağıran, `dependsOn` değişikliğini
 * önce haritaya yazıp buraya vermelidir (yoksa yeni kenar döngüyü taşımaz).
 */
export function detectCycle(edges: Record<string, string[]>, start: string): string[] | undefined {
  const yigin: string[] = []
  const durum = new Map<string, "acik" | "kapali">()
  const ara = (dugum: string): string[] | undefined => {
    const mevcut = durum.get(dugum)
    if (mevcut === "acik") {
      const bas = yigin.indexOf(dugum)
      return [...yigin.slice(bas < 0 ? 0 : bas), dugum]
    }
    if (mevcut === "kapali") return undefined
    durum.set(dugum, "acik")
    yigin.push(dugum)
    for (const sonraki of edges[dugum] ?? []) {
      const bulunan = ara(sonraki)
      if (bulunan) return bulunan
    }
    yigin.pop()
    durum.set(dugum, "kapali")
    return undefined
  }
  return ara(start)
}

/** Görevlerin `dependsOn` alanından komşuluk haritası üretir. */
export function dependencyGraph(tasks: TaskRecord[]): Record<string, string[]> {
  const harita: Record<string, string[]> = {}
  for (const task of tasks) harita[task.id] = [...task.dependsOn]
  return harita
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Bütçe (saf)
// ─────────────────────────────────────────────────────────────────────────────

export type BudgetAxis = "wallclock" | "iterations" | "concurrency" | "taskCount"

export interface BudgetOverflow {
  axis: BudgetAxis
  limit: number
  actual: number
  /** İnsan okunur gerekçe; `orchestra_status` ve araç çıktısında görünür. */
  reason: string
}

export interface BudgetProbe {
  config: BudgetConfig
  /**
   * DENETİMDEN SONRAKİ GERÇEK sayaçlar (post-increment).
   *
   * SÖZLEŞME: buradaki değerler "olacak" DEĞİL, "oldu" durumlardır. Çağıran
   * ÖNCE sayacı artırır, SONRA ölçer. "Bir tane daha olacak" bayrağı
   * (`yeniGorev`/`yeniIterasyon`) BİLEREK YOKTUR: aynı sayacı hem artırarak
   * hem bayrakla saymak, tavanın tam taşındığı anda çift sayım üretiyordu.
   */
  state: BudgetState
  /**
   * DENETİMDEN SONRAKİ koşan görev sayısı.
   *
   * `planned` görev KOŞMAZ: görev açılışı bu sayıyı artırmaz, yalnız
   * `running`'e geçiş artırır. Çağıran geçişten sonraki sayıyı hesaplar
   * (koşanlar + geçişe giren görev).
   */
  running: number
  /** Duvar saati kaynağı (testte enjekte edilir). */
  now: number
}

/**
 * Bütçe aşımı. Boş dizi = bütçe içinde.
 *
 * Sınır "aşıldı" demektir, "doldu" değil: limitteki durum AŞIM DEĞİLDİR
 * (aksi hâlde `maxIterations: 50` 50. adımda kapanırdı). `0` limit KAPALI
 * demektir — `loop.ts`'teki `maxWallClockMs: 0` geleneğiyle aynı.
 */
export function budgetOverflow(probe: BudgetProbe): BudgetOverflow[] {
  const cikti: BudgetOverflow[] = []
  const { config, state, running, now } = probe

  if (config.maxWallClockMs > 0 && state.startedAt > 0) {
    const gecen = Math.max(0, now - state.startedAt)
    if (gecen > config.maxWallClockMs) {
      cikti.push({
        axis: "wallclock",
        limit: config.maxWallClockMs,
        actual: gecen,
        reason: `duvar saati tavanı aşıldı (${Math.round(config.maxWallClockMs / 60000)} dk)`,
      })
    }
  }

  const iterasyon = state.iterations
  if (config.maxIterations > 0 && iterasyon > config.maxIterations) {
    cikti.push({
      axis: "iterations",
      limit: config.maxIterations,
      actual: iterasyon,
      reason: `iş adımı tavanı aşıldı (${config.maxIterations})`,
    })
  }

  // ÖLÇÜLEN KUSUR: burada `running + (yeniGorev ? 1 : 0)` yazıyordu. Çağıran
  // (TaskLedger) sayacı ÖNCE artırıp `running`'i GEÇİŞTEN SONRAKİ sayı olarak
  // hesapladığı için aynı görev iki kez sayılıyordu; tavanın tam taşındığı anda
  // yanlış aşım üretiyordu. `running` zaten post-increment GERÇEK değerdir.
  const eszamanli = running
  if (config.maxConcurrentTasks > 0 && eszamanli > config.maxConcurrentTasks) {
    cikti.push({
      axis: "concurrency",
      limit: config.maxConcurrentTasks,
      actual: eszamanli,
      reason: `eşzamanlı görev tavanı aşıldı (${config.maxConcurrentTasks}; şu an ${running} koşuyor)`,
    })
  }

  // `state.tasks` zaten post-increment GERÇEK değerdir; ayrı bayrak eklenmez
  // (bkz. BudgetProbe sözleşmesi: aynı sayacı hem artırıp hem bayrakla saymak
  // tavanın tam taşındığı anda çift sayım üretiyordu).
  const adet = state.tasks
  if (config.maxTasksPerGoal > 0 && adet > config.maxTasksPerGoal) {
    cikti.push({
      axis: "taskCount",
      limit: config.maxTasksPerGoal,
      actual: adet,
      reason: `görev sayısı tavanı aşıldı (${config.maxTasksPerGoal}); eski bitmiş görevler budandı`,
    })
  }

  return cikti
}

/** Bütçe sayacı. Saf bellek; diske yazma `TaskLedger`'ın işidir. */
export class BudgetTracker {
  private durum: BudgetState

  constructor(state?: Partial<BudgetState>) {
    this.durum = {
      startedAt: BudgetTracker.sayi(state?.startedAt),
      iterations: BudgetTracker.sayi(state?.iterations),
      tasks: BudgetTracker.sayi(state?.tasks),
    }
  }

  private static sayi(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }

  get state(): BudgetState {
    return { ...this.durum }
  }

  /** Duvar saati sayacını başlatır. Zaten başladıysa dokunmaz (yeniden açılışta). */
  start(now: number): void {
    if (this.durum.startedAt <= 0 && Number.isFinite(now) && now > 0) this.durum.startedAt = Math.floor(now)
  }

  countIteration(): void {
    this.durum.iterations += 1
  }

  countTask(): void {
    this.durum.tasks += 1
  }

  probe(config: BudgetConfig, running: number, now: number, extra?: { yeniGorev?: boolean; yeniIterasyon?: boolean }): BudgetOverflow[] {
    return budgetOverflow({ config, state: this.durum, running, now, ...extra })
  }

  apply(state: BudgetState): void {
    this.durum = {
      startedAt: BudgetTracker.sayi(state.startedAt),
      iterations: BudgetTracker.sayi(state.iterations),
      tasks: BudgetTracker.sayi(state.tasks),
    }
  }

  /** Disk sınırından gelen bozuk değere karşı savunmacı kurulum. */
  static from(value: unknown): BudgetTracker {
    const kaynak = (value && typeof value === "object" ? value : {}) as Partial<BudgetState>
    return new BudgetTracker(kaynak)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Budalama (saf)
// ─────────────────────────────────────────────────────────────────────────────

function yasOf(task: TaskRecord): number {
  for (const alan of [task.updatedAt, task.createdAt, task.finishedAt, task.startedAt]) {
    if (typeof alan !== "string") continue
    const sayi = Date.parse(alan)
    if (Number.isFinite(sayi)) return sayi
  }
  return 0
}

/**
 * KORUMA önceliği (küçük = daha çok korunur):
 *   0. `running`   — koşan görev; en son düşer
 *   1. `verifying` — kanıt toplanıyor
 *   2. `planned`   — henüz başlamadı
 *   3. `blocked`   — insan kararı bekliyor
 *   4. `failed`    — sonucu negatif, yeniden denenecekse yeni kimlikle gelir
 *   5. `done`      — iş bitti; defterden düşmesi bilgi kaybı değil
 *
 * `pruneLessons`'in yaptığı gibi: önce önceliğe, sonra yaşa göre sırala, kesilecek
 * olanı SONDAN al (`slice(len - max)` YANLIŞ, en değersizleri tutardı).
 * Saf fonksiyondur; girdi dizisini değiştirmez.
 */
export function pruneTasks(tasks: TaskRecord[], max: number, keepId?: string): TaskRecord[] {
  if (!Number.isFinite(max) || max <= 0) return []
  if (tasks.length <= max) return tasks.slice()
  const fazla = tasks.length - max
  const atilabilir = tasks.filter((task) => task.id !== keepId)
  // Atılacak kadar aday yoksa koşan görevi düşürmeyiz: canlı iş, dosya
  // boyutundan daha önemlidir (bkz. `pruneSessionSlots`).
  if (atilabilir.length < fazla) return tasks.slice()
  // Tanınmayan bir durum `planned` gibi davranır: yabancı/elle yazılmış veri
  // en değerli kayıt gibi korunmamalı ama panik de yaratmamalı.
  const rank = (task: TaskRecord): number => RANKI[task.status] ?? 2
  const sirali = tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => rank(a.task) - rank(b.task) || yasOf(b.task) - yasOf(a.task) || a.index - b.index)
  const kalan = new Set(sirali.slice(0, max).map((entry) => entry.task))
  return tasks.filter((task) => kalan.has(task))
}

const RANKI: Readonly<Record<TaskStatus, number>> = {
  running: 0,
  verifying: 1,
  planned: 2,
  blocked: 3,
  failed: 4,
  done: 5,
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Durum makinesi yardımcıları (saf)
// ─────────────────────────────────────────────────────────────────────────────

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to)
}

/** Sonraki görev kimliği: P1, P2 … Var olan en büyük sayıdan devam eder. */
export function nextTaskId(tasks: TaskRecord[]): string {
  let enBuyuk = 0
  for (const task of tasks) {
    const sayi = Number(/^P(\d+)$/.exec(task.id ?? "")?.[1])
    if (Number.isFinite(sayi) && sayi > enBuyuk) enBuyuk = sayi
  }
  return `P${enBuyuk + 1}`
}

export function isTerminal(status: TaskStatus): boolean {
  return (TASK_TRANSITIONS[status] ?? []).length === 0
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Yapılandırma (canlı okunur — `fallback.ts` deseni)
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_FILE = "orchestra.json"

async function stampOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch {
    return -1
  }
}

/**
 * `.opencode/orchestra.json` → `budget` bloğu.
 *
 * Dosya yoksa/bozuksa/blok eksikse GÜVENLİ VARSAYILANA düşer: görev defteri
 * kullanıcının yapılandırma hatası yüzünden hiç çalışmamalidir.
 */
export async function loadBudgetConfig(root: string | undefined): Promise<BudgetConfig> {
  if (!root) return { ...DEFAULT_BUDGET }
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(path.join(root, ".opencode", CONFIG_FILE), "utf8"))
  } catch {
    return { ...DEFAULT_BUDGET }
  }
  const block = (raw as { budget?: Partial<BudgetConfig> } | null)?.budget
  if (!block || typeof block !== "object" || Array.isArray(block)) return { ...DEFAULT_BUDGET }
  const sayi = (value: unknown, varsayilan: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : varsayilan
  return {
    maxWallClockMs: sayi(block.maxWallClockMs, DEFAULT_BUDGET.maxWallClockMs),
    maxIterations: sayi(block.maxIterations, DEFAULT_BUDGET.maxIterations),
    maxConcurrentTasks: sayi(block.maxConcurrentTasks, DEFAULT_BUDGET.maxConcurrentTasks),
    maxTasksPerGoal: sayi(block.maxTasksPerGoal, DEFAULT_BUDGET.maxTasksPerGoal),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Görev defteri (oturum anahtarlı, `Memory` üzerinden kalıcı)
// ─────────────────────────────────────────────────────────────────────────────

export interface LedgerNote {
  /** `uyari` = insan kararı gerektirir, `bilgi` = durum. */
  tur: "uyari" | "bilgi"
  metin: string
}

export interface LedgerOk {
  ok: true
  /** Değişen görev (yoksa yalnız alan güncellemesi yapılmışsa `undefined`). */
  task?: TaskRecord
  notes: LedgerNote[]
  overflow: BudgetOverflow[]
  /** Budama yüzünden atılan görev sayısı. */
  dropped: number
}

export interface LedgerNo {
  ok: false
  /** Red gerekçesi: modele ne yapmadığını ve neden yapmadığını söyler. */
  error: string
  notes: LedgerNote[]
  overflow: BudgetOverflow[]
}

export type LedgerResult = LedgerOk | LedgerNo

export interface TaskUpdateInput {
  id: string
  status?: string
  evidence?: string[]
  title?: string
  role?: string
  acceptance?: string
  writeSurface?: string[]
}

export interface TaskAddInput {
  title: string
  role?: string
  dependsOn?: string[]
  writeSurface?: string[]
  acceptance?: string
}

/**
 * Oturumun görev defteri.
 *
 * YAZMA YOLU `memory.ts`'indir (`setTaskVault` → kilit → resync → atomik yazım).
 * Buradaki her mutasyon önce `syncStore()` ile diski tazeler: başka bir
 * opencode örneğinin yazdığı görev, resync yapılmadan ezilirdi.
 */
export class TaskLedger {
  private readonly memory: Memory
  private readonly root: string | undefined
  private readonly sessionID: string
  private config: BudgetConfig
  private configStamp: number
  private board: TaskBoard
  private readonly now: () => number

  private constructor(
    memory: Memory,
    root: string | undefined,
    sessionID: string,
    config: BudgetConfig,
    configStamp: number,
    board: TaskBoard,
    now: () => number,
  ) {
    this.memory = memory
    this.root = root
    this.sessionID = sessionID
    this.config = config
    this.configStamp = configStamp
    this.board = board
    this.now = now
  }

  /** Diskten okur; YAZMAZ. Duvar saati sayacı yalnız ilk mutasyonda başlar. */
  static async open(
    memory: Memory,
    root: string | undefined,
    sessionID: string,
    options: { now?: () => number } = {},
  ): Promise<TaskLedger> {
    const config = await loadBudgetConfig(root)
    const configStamp = await stampOf(path.join(root ?? "", ".opencode", CONFIG_FILE))
    const vault = memory.getTaskVault(sessionID)
    const board: TaskBoard = { tasks: vault.tasks.map((task) => ({ ...task })), budget: { ...vault.budget } }
    return new TaskLedger(memory, root, sessionID, config, configStamp, board, options.now ?? (() => Date.now()))
  }

  get id(): string {
    return this.sessionID
  }

  getConfig(): BudgetConfig {
    return { ...this.config }
  }

  /** Defterin KOPYASI. Çağıran bunu mutasyona uğratamaz. */
  defter(): TaskBoard {
    return { tasks: this.board.tasks.map((task) => ({ ...task })), budget: { ...this.board.budget } }
  }

  list(): TaskRecord[] {
    return this.board.tasks.map((task) => ({ ...task }))
  }

  get(id: string): TaskRecord | undefined {
    const bulunan = this.board.tasks.find((task) => task.id === id)
    return bulunan ? { ...bulunan } : undefined
  }

  running(): TaskRecord[] {
    return this.list().filter((task) => task.status === "running")
  }

  /**
   * Dosyası hâlâ değişebilen görevler: `running` + `verifying`.
   *
   * `findConflicts` zaten bu ikisini karşılaştırır; "yeni görev açılırken"
   * yolu da aynı küseyi görmeli, aksi halde tespit başlamaya bağlı olurdu.
   */
  private aktif(): TaskRecord[] {
    return this.board.tasks.filter((task) => AKTIF_DURUMLAR.has(task.status))
  }

  conflicts(onlyId?: string): Conflict[] {
    return findConflicts(this.board.tasks, onlyId)
  }

  /** Yapılandırma değiştiyse canlı olarak yeniden okur (mtime karşılaştırması). */
  async refreshConfig(): Promise<void> {
    const file = path.join(this.root ?? "", ".opencode", CONFIG_FILE)
    const current = await stampOf(file)
    if (current === this.configStamp) return
    try {
      this.config = await loadBudgetConfig(this.root)
      this.configStamp = current
    } catch {
      /* okunamazsa mevcut (güvenli) değerlerde kal */
    }
  }

  /** Diskteki (başka sürecin yazdığı) hâli tazeler ve yapılandırmayı canlılar. */
  private async sync(): Promise<void> {
    await this.refreshConfig()
    await this.memory.syncStore()
    const vault = this.memory.getTaskVault(this.sessionID)
    this.board = { tasks: vault.tasks.map((task) => ({ ...task })), budget: { ...vault.budget } }
  }

  /** Yuvayı diske yazar; önce `MAX_STORED_TASKS` ile budar. */
  private async persist(): Promise<number> {
    const budanmis = pruneTasks(this.board.tasks, MAX_STORED_TASKS)
    const atilan = this.board.tasks.length - budanmis.length
    this.board = { tasks: budanmis, budget: { ...this.board.budget } }
    await this.memory.setTaskVault(this.sessionID, this.board)
    return atilan
  }

  private bulten(): BudgetTracker {
    return BudgetTracker.from(this.board.budget)
  }

  /**
   * Bütçe aşımı + okunur bir uyarı listesi. Aşım ENGEL DEĞİLDİR.
   *
   * ÖLÇÜLEN KUSUR: `bulten` parametresi yoktu ve `this.bulten()` defterdeki
   * ESKİ durumu okuyordu. Çağıran sayacı artırıp HENÜZ deftere yazmadan
   * ölçtüğü için ölçüm daima bir adım geriden geliyordu: tavanın tam taşındığı
   * anda (`limit + 1`) aşım YOK görünüyor, sınırsız aşılana kadar aşım
   * hiç bildirilmiyordu. Artık ölçülen sayacın kendisi geçilir.
   */
  private olc(
    running: number,
    extra?: { yeniGorev?: boolean; yeniIterasyon?: boolean },
    olculecek?: BudgetTracker,
  ): {
    overflow: BudgetOverflow[]
    notes: LedgerNote[]
  } {
    const overflow = (olculecek ?? this.bulten()).probe(this.config, running, this.now(), extra)
    return {
      overflow,
      notes: overflow.map((item) => ({ tur: "uyari", metin: `BÜTÇE: ${item.reason}` })),
    }
  }

  /**
   * YENİ görev açar.
   *
   * REDDEDİLEN: başlıksız görev, döngüsel bağımlılık.
   * BİLDİRİLEN: henüz tanımlanmış bağımlılık, yazma yüzeyi çakışması, bütçe aşımı.
   *
   * İLERİ BAĞIMLILIK NEDEN REDDEDİLMEZ: `P2`, `P1` açılmadan da `P1`'e bağlı
   * tanımlanabilir. Erken reddedilirse gerçek bir planlama sırası (önce şema,
   * sonra uygulama) ifade edilemez olurdu — ve `A→B→A` döngüsü zaten hiç
   * kurulamazdı, yani döngü denetimi ölü kod olurdu. Bunun yerine eksik
   * bağımlılık UYARI olarak bildirilir; `running` geçişi zaten onu reddeder.
   */
  async add(input: TaskAddInput): Promise<LedgerResult> {
    await this.sync()
    const notes: LedgerNote[] = []
    const overflow: BudgetOverflow[] = []
    const title = String(input.title ?? "").trim()
    if (!title) return { ok: false, error: "HATA: görev başlığı (title) boş olamaz.", notes, overflow }

    const id = nextTaskId(this.board.tasks)
    const dependsOn = [...new Set((input.dependsOn ?? []).map((d) => String(d).trim()).filter(Boolean))]

    const bilinmeyen = dependsOn.filter((d) => !this.board.tasks.some((task) => task.id === d))
    if (bilinmeyen.length > 0) {
      notes.push({
        tur: "uyari",
        metin: `EKSİK BAĞIMLILIK: ${bilinmeyen.join(", ")} henüz tanımlı değil. ${id} onlar 'done' olmadan 'running'e geçemez.`,
      })
    }

    const cizge = dependencyGraph(this.board.tasks)
    cizge[id] = dependsOn
    const dongu = detectCycle(cizge, id)
    if (dongu) {
      return {
        ok: false,
        error: `HATA: döngüsel bağımlılık reddedildi: ${dongu.join(" → ")}. Birbirine bağlı iş paketleri sıraya dizilmez.`,
        notes,
        overflow,
      }
    }

    const task: TaskRecord = {
      id,
      title,
      role: input.role ? String(input.role).trim() : undefined,
      dependsOn,
      writeSurface: (input.writeSurface ?? []).map((p) => String(p).trim()).filter(Boolean),
      acceptance: String(input.acceptance ?? "").trim(),
      status: "planned",
      evidence: [],
      sessionID: this.sessionID,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    }

    const bulten = this.bulten()
    bulten.start(this.now())
    bulten.countTask()
    const olcum = this.olc(this.running().length, { yeniGorev: true }, bulten)
    overflow.push(...olcum.overflow)
    notes.push(...olcum.notes)

    this.board = { tasks: [...this.board.tasks, task], budget: bulten.state }

    // Çakışma TESPİTİ: yeni görev henüz `planned`, ama AKTIF (`running` VEYA
    // `verifying`) bir görevin yüzeyiyle kesişiyorsa ŞİMDİ görünmelidir —
    // görev `running`'e geçene kadar beklemek, mimarın işi bölme kararını
    // bilgilendirmeyi geciktirirdi. `verifying` DAHİLDİR: kanıt toplanırken
    // dosya hâlâ düzeltiliyor olabilir, yani çakışmanın en tehlikeli anı budur.
    // Ölçülen kusur: burada yalnız `running` sayılıyordu, "P1 verifying, P2
    // planlı" ikilisi sessizce çakışmasız görünüyordu.
    for (const kosan of this.aktif()) {
      for (const yuzey of conflictsBetween(task, kosan)) {
        notes.push({
          tur: "uyari",
          metin: `ÇAKIŞMA: ${id} planlanan yüzeyi ${kosan.id} (${kosan.status}) ile kesişiyor (${yuzey}). Bu görev koşmaya başladığında tespit raporlanır; engelleme kararı mimarındır.`,
        })
      }
    }

    const dropped = await this.persist()
    if (dropped > 0) notes.push({ tur: "bilgi", metin: `Defter ${MAX_STORED_TASKS} sınırına budandı: ${dropped} eski görev atıldı.` })
    return { ok: true, task: this.get(id), notes, overflow, dropped }
  }

  /**
   * Görevi günceller: alanlar, kanıt ve (verilirse) durum geçişi.
   *
   * `dependsOn` KULLANILMAZ: bağımlılık görev açılırken sabitlenir. Sonradan
   * değiştirmek, o güne kadar yazılmış kodun "neye dayandığını" değiştirirdi.
   *
   * "REDDEDİLEN HİÇBİR ŞEY YAZMAZ" SÖZLEŞMESİ: değişiklikler bir KOPYAYA
   * uygulanır ve yalnız tüm denetimler geçilince `this.board`'a bağlanır.
   * Aksi halde reddedilen bir çağrı, aynı `id`'yi taşıyan sonraki bir çağrının
   * `sync()`'i diski okuyana kadar bellekte yarım uygulanmış bir alan bırakırdı
   * (gözlenen durum ile kalıcı durum çelişirdi).
   */
  async update(input: TaskUpdateInput): Promise<LedgerResult> {
    await this.sync()
    const notes: LedgerNote[] = []
    const overflow: BudgetOverflow[] = []
    const id = String(input.id ?? "").trim()
    const kayitli = this.board.tasks.find((t) => t.id === id)
    if (!kayitli) {
      return { ok: false, error: `HATA: bilinmeyen görev id '${id}'. Önce orchestra_task ile tanımla.`, notes, overflow }
    }
    // Defterdeki kaydın KOPYASI üzerinde çalış (aşağıdaki `bagla` ile bağlanır).
    const task: TaskRecord = { ...kayitli, dependsOn: [...kayitli.dependsOn], writeSurface: [...kayitli.writeSurface], evidence: [...kayitli.evidence] }
    /** Denetimler geçilince deftere bağla. */
    const bagla = (budget: BudgetState): void => {
      this.board = { tasks: this.board.tasks.map((t) => (t.id === id ? task : t)), budget }
    }

    if (input.evidence !== undefined) {
      const yeni = input.evidence.map((e) => String(e).trim()).filter(Boolean)
      task.evidence = [...task.evidence, ...yeni.filter((e) => !task.evidence.includes(e))]
    }
    if (input.title !== undefined && String(input.title).trim()) task.title = String(input.title).trim()
    if (input.role !== undefined) task.role = String(input.role).trim() || undefined
    if (input.acceptance !== undefined) task.acceptance = String(input.acceptance).trim()
    if (input.writeSurface !== undefined) {
      // ÖLÇÜLEN KUSUR (iki katmanlı):
      //  1. Denetim UZUNLUKTU. `[a,b] → [c,d]` "daha az yol" sayılmadığı için
      //     sessizce geçiyordu: mimar çakışan yüzeyleri yeni, daha temiz bir
      //     listeyle değiştirerek tespiti SİLİYORDU.
      //  2. Red YARIŞTI: yüzey reddedilse bile aynı çağrıdaki kanıt/başlık
      //     değişiklikleri diske yazılıyordu (durum alanı hariç — o kopya
      //     üzerinde çalışıyor). Gözlenen durum ile kalıcı durum ayrışıyordu.
      //
      // SÖZLEŞME (bilerek basit): görev `planned` DEĞİLSE, istenen yüzey mevcut
      // NORMALLEŞTİRİLMİŞ yolların HEPSİNİ içermelidir. Üstüne EKLEMEK serbesttir;
      // bir yolu ÇIKARMAK veya başka bir desenle DEĞİŞTİRMEK reddedilir.
      //
      // NEDEN "daha geniş glob" da yetmez (`src/a.ts` → `src/*`): kayıt kayıtla
      // korunur. Geniş glob "bu dosyayı yazıyorum" beyanının yerine geçmez; kabul
      // edilseydi beyanı yine bulanıklaştırır, tespit ise kaybolurdu. Sonuç:
      // AŞIRI BEYAN UCUZ (en kötü hâlde bir uyarı), EKSİK BEYAN GÖRÜNMEZDİR.
      //
      // UZARI DEĞİL, **RED**: `bagla` henüz çağrılmadığı için bu noktada dönmek
      // tüm çağrıyı atomik biçimde iptal eder (kanıt, başlık, bütçe dahil).
      // Gerçekte dokunulmayan bir yolu beyan etmişsen onu KORUMAK en ucuz yol.
      const istenen = input.writeSurface.map((p) => String(p).trim()).filter(Boolean)
      const istenenNorm = new Set(istenen.map(normalizeSurface).filter(Boolean))
      const kaybolan = [...new Set(task.writeSurface.map(normalizeSurface))].filter(
        (p) => p !== "" && !istenenNorm.has(p),
      )
      if (kaybolan.length > 0 && task.status !== "planned") {
        return {
          ok: false,
          error:
            `HATA: ${id} '${task.status}' durumundayken yazma yüzeyi DARALTILAMAZ; eksik kalan: ${kaybolan.join(", ")}. ` +
            `Genişletmek serbesttir (üstüne ekle), çıkarmak/değiştirmek değil — çakışma giderilmemiş sayılır. ` +
            "Yüzeyi değiştirmek için görevi `planned` durumundayken tanımla; dokunmadığın yolda beyanı sürdürmek en ucuz yol.",
          notes,
          overflow,
        }
      }
      task.writeSurface = istenen
    }
    task.updatedAt = new Date(this.now()).toISOString()

    if (input.status === undefined || input.status === "") {
      bagla({ ...this.board.budget })
      const dropped = await this.persist()
      if (dropped > 0) notes.push({ tur: "bilgi", metin: `Defter budandı: ${dropped} görev atıldı.` })
      return { ok: true, task: this.get(id), notes, overflow, dropped }
    }

    if (!isTaskStatus(input.status)) {
      return {
        ok: false,
        error: `HATA: '${input.status}' geçerli bir durum değil. Seçenekler: ${TASK_STATUSES.join(", ")}.`,
        notes,
        overflow,
      }
    }
    const hedef = input.status
    if (!canTransition(task.status, hedef)) {
      const yollar = TASK_TRANSITIONS[task.status] ?? []
      return {
        ok: false,
        error:
          yollar.length === 0
            ? `HATA: ${id} '${task.status}' durumunda ve bu hal KALICI (bitmiş sayılır). Yeniden denemek yeni bir görev kimliği demektir.`
            : `HATA: ${id} için '${task.status}' → '${hedef}' geçişi geçersiz. İzin verilen: ${yollar.join(", ")}.`,
        notes,
        overflow,
      }
    }

    const bulten = this.bulten()
    bulten.start(this.now())

    if (hedef === "done") {
      // KANIT ZORUNLULUĞU: "yaptım" ile "kanıtladım" ayrımı kodla zorlanır.
      if (task.evidence.length === 0) {
        return {
          ok: false,
          error: `HATA: ${id} 'done' olamaz — kanıt yok. Önce evidence ekle (test çıktısı, dosya yolu, komut sonucu).`,
          notes,
          overflow,
        }
      }
      if (!task.acceptance) {
        return {
          ok: false,
          error: `HATA: ${id} 'done' olamaz — kabul kriteri (acceptance) boş. Kanıt neye göre değerlendirilecek?`,
          notes,
          overflow,
        }
      }
    }

    if (hedef === "running") {
      // BAĞIMLILIK SIRASI: bitmemiş bağımlılık varsa başlanmaz.
      const eksik = task.dependsOn.filter((d) => {
        const bagimli = this.board.tasks.find((t) => t.id === d)
        return !bagimli || bagimli.status !== "done"
      })
      if (eksik.length > 0) {
        const ayrinti = eksik
          .map((d) => {
            const bagimli = this.board.tasks.find((t) => t.id === d)
            return `${d}${bagimli ? ` (${bagimli.status})` : " (tanımsız)"}`
          })
          .join(", ")
        return {
          ok: false,
          error: `HATA: ${id} 'running' olamaz — bağımlılık bitmedi: ${ayrinti}. Önce onları tamamla.`,
          notes,
          overflow,
        }
      }
      bulten.countIteration()
      // `running` alanı GEÇİŞTEN SONRAKİ gerçek sayıdır (BudgetProbe sözleşmesi).
      // Bu görev henüz `planned` olduğu için `running()` içinde sayılmaz; ölçüme
      // geçişe giren görevin kendisi eklenir. ÖLÇÜLEN KUSUR: yalnız "diğer
      // koşanlar" ölçülüyordu, yani tavana dayanmış bir defter 3. koşuda bile
      // aşım üretmiyordu.
      const gecisSonrasi = this.running().filter((t) => t.id !== id).length + 1
      const olcum = this.olc(gecisSonrasi, { yeniGorev: true, yeniIterasyon: true }, bulten)
      overflow.push(...olcum.overflow)
      notes.push(...olcum.notes)
      task.startedAt = task.startedAt ?? new Date(this.now()).toISOString()
    }

    task.status = hedef
    task.updatedAt = new Date(this.now()).toISOString()
    if (isTerminal(hedef)) task.finishedAt = new Date(this.now()).toISOString()
    bagla(bulten.state)

    // Çakışma TESPİTİ (koşan görevler arasında).
    if (hedef === "running") {
      for (const c of this.conflicts(id)) {
        notes.push({
          tur: "uyari",
          metin: `ÇAKIŞMA: ${id} ile ${c.a === id ? c.b : c.a} aynı yüzeye yazıyor (${c.surface}). Sistem ENGELLEMEZ; işi böl veya sıraya al — karar senin.`,
        })
      }
    }

    const dropped = await this.persist()
    if (dropped > 0) notes.push({ tur: "bilgi", metin: `Defter budandı: ${dropped} görev atıldı.` })
    return { ok: true, task: this.get(id), notes, overflow, dropped }
  }

  /** Tek ekranlık özet (`orchestra_status` ve `/standup`'ın veri kaynağı). */
  status(): string[] {
    const bulten = this.bulten()
    const say = (durum: TaskStatus): number => this.board.tasks.filter((t) => t.status === durum).length
    const gecen = this.board.budget.startedAt > 0 ? this.now() - this.board.budget.startedAt : 0
    const dakika = (ms: number): string => `${Math.round(ms / 60000)} dk`
    const cizgiler: string[] = [
      `ORCHESTRA GÖREV DEFTERİ — oturum ${this.sessionID}`,
      `- Toplam görev: ${this.board.tasks.length} (koşan ${say("running")}, doğrulanıyor ${say("verifying")}, bitti ${say("done")}, engelli ${say("blocked")}, başarısız ${say("failed")}, planlı ${say("planned")})`,
      `- Bütçe: duvar saati ${dakika(gecen)}/${dakika(this.config.maxWallClockMs)} · iş adımı ${this.board.budget.iterations}/${this.config.maxIterations} · eşzamanlı ${say("running")}/${this.config.maxConcurrentTasks} · görev ${this.board.budget.tasks}/${this.config.maxTasksPerGoal}`,
    ]
    const asim = bulten.probe(this.config, say("running"), this.now())
    if (asim.length > 0) cizgiler.push(`- AŞIM: ${asim.map((a) => `${a.reason} (${a.actual}/${a.limit})`).join("; ")}`)
    for (const task of this.list()) {
      const kanit = task.evidence.length > 0 ? ` · kanıt ${task.evidence.length}` : ""
      cizgiler.push(
        `- ${task.id} [${task.status}] ${task.title}${task.role ? ` (${task.role})` : ""}${task.dependsOn.length > 0 ? ` ← ${task.dependsOn.join(", ")}` : ""}${kanit}`,
      )
    }
    const cakisma = this.conflicts()
    for (const c of cakisma) cizgiler.push(`- ÇAKIŞMA: ${c.a} ↔ ${c.b} (${c.surface})`)
    return cizgiler
  }
}
