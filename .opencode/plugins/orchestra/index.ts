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

import { promises as fs } from "node:fs"
import path from "node:path"
// NEDEN `import type`: bu satır plugin'in **tek** paket bağımlılığıydı ve plugin'in
// yüklenmesini `node_modules`'a bağımlı kılıyordu. Ölçüldü: `@opencode/plugin`
// çözülemediğinde opencode plugin'i sessizce YÜKLEMİYOR ("Cannot find package
// '@opencode/plugin'") ve altı aracın hepsi — rapor, görev, ders dahil — kayboluyor.
// `Plugin.define` ise saf kimliktir (`dist/promise/plugin.js`: `define(p){return p}`),
// yani yalnız TypeScript çıkarımı içindir. Bu yüzden değer importu yerine TİP
// importu kullanılır: `verbatimModuleSyntax` ve Node'un type-stripping'i bunu
// çalışma anında tamamen siler. Plugin artık **sıfır runtime bağımlılığıyla**
// yüklenir; `npm install` yalnız `tsc`/test için gereklidir.
import type { Plugin } from "@opencode/plugin/promise/plugin"
import { registerTools } from "./tools.ts"
import { registerLoop } from "./loop.ts"
import { registerFallback, type FallbackHandle } from "./fallback.ts"
import { TaskLedger } from "./tasks.ts"

/**
 * Plugin'in kendi araçlarının etkin adları namespace uygulanmış hâliyle gelir
 * (`orchestra_recall`, `orchestra_lesson`, ...). Code Mode'da ise araçlar
 * `execute` sarmalayıcısının içinden çağrılır ve çıktılarını oraya yazar.
 * Her iki yolda da kendi gürültümüzü yakalamamak için eliyoruz.
 *
 * `orchestra_task`/`orchestra_status` da burada: yoksa kendi görev defteri
 * çıktımız hata sanılır ve hafızaya ders olarak yazılır.
 */
export const SELF_TOOLS: ReadonlySet<string> = new Set([
  "orchestra_recall",
  "orchestra_lesson",
  "orchestra_forget",
  "orchestra_report",
  "orchestra_task",
  "orchestra_status",
])
const SELF_MARKER = "ORCHESTRA HAFIZA"

/**
 * Yalnız bu araçların "başarılı" çıktısı hata taşıyabilir.
 *
 * V2'de sıfır dışı çıkış kodu hata sayılmaz; hata yalnız çıktının içinden okunur.
 * Ama bu, "çıktıda `error` kelimesi geçiyor" demek DEĞİLDİR. `read` ile okunan bir
 * `.ts` dosyasındaki `error TS2345` bir **veridir**, çalıştırılmış bir hatadır
 * değildir. Taranmadığı için gerçek `shell:TipHatasi:TS2345` sayacı şişmez ve
 * hafıza okunan kodun kendi hata imzalarını gerçek sanmaz.
 *
 * `execute` BİLEREK DIŞARIDA: Code Mode'da `execute` sarmalayıcısının "başarılı"
 * çıktısı, içinden çağrılan `read`/`grep` çıktılarıyla sarmalayıcının kendi
 * açıklamalarının karışımıdır — yani taranacaksa aynı gürültü sorunu orada da
 * yaşanır. Sarmalayıcının kendi hataları zaten `status === "error"` yolundan
 * gelir; o yol araç sınırına tabi değildir.
 *
 * `orchestra.json` → `capture.scanTools` ile genişletilebilir.
 */
export const ERROR_SCAN_TOOLS: ReadonlySet<string> = new Set(["shell"])

/**
 * Hafızamızın kendi kayıtlarının işaretleri.
 *
 * Bunlar hata kaynağı olamaz; tam tersine hata imzasının kendisidir. Tarama
 * yapılırsa "lessons.jsonl'yi okuyup kendi hata imzalarımı gerçek sanma"
 * döngüsü kapanmaz. (Bu, hafızadaki kalıcı bir yanlış sınıflandırmanın kaynağıydı.)
 */
const SELF_CONTENT: readonly RegExp[] = [
  /\.opencode[\\/]memory[\\/]/i,
  /lessons\.jsonl/i,
  /<orchestra-memory>/i,
  /"kind"\s*:\s*"auto"/i,
  /\bneedsLesson\b/,
  /"signature"\s*:/i,
  /ORCHESTRA-STATUS:/i,
]

/** İptal/abort bir hata değildir, gürültüdür. */
const ABORT = /\b(abort(ed)?|cancell?ed|interrupt(ed)?|session (closed|aborted))\b/i

/** Çıktı metninde taranacak azami karakter. Devasa logları tarama. */
const MAX_SCAN = 20_000

interface Reason {
  name: string
  pattern: RegExp
  /** İmzayı ayrıştıran kararlı kod (hata sınıfı, TS kodu, errno vb.). */
  code?: RegExp
  /**
   * Desenin YALNIZCA bazı alternatifleri satır başına anlamlıdır (`^...`).
   * Çıktı düzleştirildiği için `pattern` içindeki `^` ölüdür; bu alan onları
   * satır bazlı dener. `anchored` ile karıştırma: `anchored` tüm deseni satır
   * başına çeker (gömülü benzerlik elenir), `linePattern` ek bir güvenlik
   * katmanıdır ve sınıf adı aynı kalır.
   */
  linePattern?: RegExp
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
    pattern: /\bNode\.js v\d+|\bat [^\s:()]+:\d+:\d+/i,
    code: /\b([A-Za-z_]*(?:Error|Exception))\b\s*[:(]/,
    // Yığın çerçevesi `[dosya]:satır` kendi satırında gelir. Düzleştirilmiş
    // metinde `\s*$` yalnız metnin EN SONUNA denk geldiği için pratikte ölüydü;
    // desenden çıkarmak yerine satır bazlı denemeye alındı (yığın biçimini
    // korur, gömülü benzerlikleri yine eler).
    linePattern: /^\s*\[[\w/.-]+\]:\d+(?::\d+)?\s*$/,
  },
  { name: "PaketHatasi", pattern: /(?:^|\s)(?:npm|pnpm|yarn|npx) ERR!|ELIFECYCLE|ERR_PNPM_/i },
  // `fatal:` her zaman ilk satır değildir (git önce uyarı/bilgi yazar); bu yüzden
  // düz metinde `^` ölüydü ve "not a git repository" hiç yakalanmıyordu.
  { name: "GitHatasi", pattern: /^\s*fatal: /i, anchored: true },
  {
    name: "TestBasarisiz",
    pattern: /\b\d+ (?:failing|failed)\b|Tests?:\s+.*fail|AssertionError/i,
    // Aynı ölü-`^` sorunu: `FAIL`/`FAILED` satır başında gelir, düzleştirmede
    // satır başı bilgisi kaybolur. Sınıf adı `TestBasarisiz` olarak korunur.
    linePattern: /^\s*(?:FAIL|FAILED)\b/,
  },
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
 * Gizli değerleri örnek metinden siler.
 *
 * Hata çıktısı token taşıyabilir (`Bearer ...`, `api_key=...`, kimlik bilgisi
 * içeren URL). Hafıza bu metni kalıcı diske yazdığı için maskeleme yapılmazsa
 * sır kalıcılaşır. Sınıf (`klass`) maskelemeden ÖNCE hesaplanır; sır sınıf
 * tespitine dokunamaz.
 */
export function redact(text: string): string {
  if (!text) return text
  return text
    // Authorization: Bearer <token>
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, "Bearer [REDACTED]")
    // ÖNCEKİ ÖNEK TANIYICI. Sağlayıcı hata mesajları sırrı çoğunlukla
    // BİÇİMSİZ bırakır: "OPENAI_API_KEY=sk-proj-…", "AWS_SECRET_ACCESS_KEY=…".
    // Değişken adı deseni aşağıda bunları YAKALAMAZDI (ölçüldü: 6 sızıntı),
    // çünkü `_` bir word karakteridir ve `\b` geçişte sınır üretmez.
    // Bu yüzden bilinen token ön ekleri doğrudan hedeflenir.
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    // api_key=… / apikey: … / "token": "…" / password = …
    //
    // Sınır DÜZELTMESİ: `\b` yerine `(?<![A-Za-z0-9])` kullanılıyor. `_` bir
    // word karakteri olduğu için `OPENAI_API_KEY` içindeki `API_KEY` için
    // `\b` tetiklenmiyordu ve sır kalıcı diske yazılıyordu. Negatif bakış,
    // kelimenin önündeki `_`/harf/rakamı da "kelime başı" sayar.
    // Aralara `_*` konarak `MY_API_KEY`, `AWS_SECRET_ACCESS_KEY` gibi
    // bileşik adlar da yakalanır (anahtarın TAMAMI maskelenir).
    .replace(
      /(?<![A-Za-z0-9])((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|apikey|token|password|passwd|secret|access[_-]?key|private[_-]?key|authorization|credential[s]?))(["']?\s*[:=]\s*)(["']?)([^\s"',;&)\]}]+)\3/gi,
      (_all, key: string, sep: string, quote: string) => `${key}${sep}${quote}[REDACTED]${quote}`,
    )
    // scheme://kullanici:sifre@host → scheme://[REDACTED]@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]*:[^/\s@]*@/gi, (_all, scheme: string) => `${scheme}[REDACTED]@`)
    // Ön ek tanıyıcısı DEĞERİ maskeler, sonra değişken-adı deseni aynı bölgeye
    // ikinci kez yazar: `secret=[hf_…]` → ön ek `secret=[[REDACTED]]` →
    // değişken adı `secret=[REDACTED]]]`. Sonuç `[REDACTED]]` kalıntısıdır
    // (ölçüldü).
    //
    // DÜZELTME: eski temizlik `\[REDACTED\](?=\])` → `[REDACTED` idi ve BAYT
    // BAZINDA HİÇBİR ŞEY YAPMIYORDU: silinen `]` yerine aynı `]` kalıyordu
    // (`secret=[hf_…]` → `secret=[REDACTED]]` ölçüldü). Artık maskenin
    // ARDINDAN gelen parantez YIĞINI hedefleniyor: `\[REDACTED\]\]+` tek geçişte
    // hepsini yutar (`+` şart: `replace` eşleştiği metni taramaz, tek `]` gider
    // kalan `]` kalırdı). Yalnız `[REDACTED]`den hemen sonra gelen `]`ler
    // sıkışır; sıradan `]]` (örn. `[[1,2]]`) etkilenmez.
    // Maske böylece idempotent olur: ikinci geçişte kalıntı yeniden doğmaz.
    .replace(/\[REDACTED\]\]+/g, "[REDACTED]")
}

/** Gözlenen metin bizim kendi kayıtlarımızı mı taşıyor? */
function isSelfContent(text: string): boolean {
  return text.includes(SELF_MARKER) || SELF_CONTENT.some((pattern) => pattern.test(text))
}

export interface ScanDecision {
  /** Bu gözlem için hata taraması yapılsın mı? */
  scan: boolean
  /** `status === "error"` ise hatayı biz alırız; çıktı metni değil, mesaj geçerlidir. */
  message?: string
  /** Neden tarandı / neden tarandı. Test ve teşhis için açık tutulur. */
  reason: string
}

/**
 * Gözlemi iki yola böler.
 *
 * 0. `SELF_TOOLS`: kendi araçlarımız. HİÇBİR yolda taranmaz — kendi kayıtlarımızı
 *    kendi hatamız sanmayalım.
 * 1. `status === "error"`: hata bize doğrudan geldi, çıktıyı okumuyoruz.
 *    Bu yol TÜM araçlar için açıktır; okunan veri değil, araç hatasıdır.
 * 2. `status === "completed"`: hata ancak metinden okunabilir (V2'de sıfır dışı
 *    çıkış kodu böyledir). Burada yalnız `scanTools` içindeki araçlar taranır;
 *    `read`/`grep`/`glob` çıktısındaki hata metni veridir, hatadır sanılmaz.
 */
export function shouldScanOutput(
  input: { tool: string; status: "error" | "completed"; text: string },
  scanTools: Iterable<string> = ERROR_SCAN_TOOLS,
): ScanDecision {
  if (SELF_TOOLS.has(input.tool)) return { scan: false, reason: "self-tool" }
  if (input.status === "error") {
    const message = input.text ?? ""
    if (!message || ABORT.test(message)) return { scan: false, reason: "aborted" }
    return { scan: true, message, reason: "error-status" }
  }
  const text = input.text ?? ""
  if (!text) return { scan: false, reason: "empty-output" }
  if (!new Set(scanTools).has(input.tool)) return { scan: false, reason: "tool-not-scanned" }
  if (isSelfContent(text)) return { scan: false, reason: "self-content" }
  if (ABORT.test(text.slice(0, 2000))) return { scan: false, reason: "aborted" }
  return { scan: true, reason: "pattern" }
}

export interface ExtractOptions {
  /** Örnek metnin azami uzunluğu. */
  maxSampleChars?: number
  /** Örnek metin gizli değerlerden arındırılsın mı? Varsayılan: evet. */
  redact?: boolean
}

/**
 * Çıktıdan kararlı bir hata sınıfı ve okunabilir bir örnek çıkarır.
 *
 * İmza (`klass`) mesajdan değil SINIFTAN üretilir: "komut bulunamadı" hatası
 * yüz kez farklı komutla da olsa tek kayıt olarak birikir ve sayaç doğru çalışır.
 * Örnek ise çıktının başından alınır — araç hata çıktısı genellikle mesajla başlar.
 */
export function extractFailure(content: string, options: ExtractOptions = {}): { klass: string; sample: string } | undefined {
  const maxSampleChars = options.maxSampleChars && options.maxSampleChars > 0 ? options.maxSampleChars : 220
  const clean = options.redact === false
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return undefined

  // Satır kaydırma (word wrap) çok kelimeli desenleri böler. Önce tek satıra indirge.
  const flat = lines.join(" ").replace(/\s+/g, " ")
  if (flat.length === 0) return undefined

  const build = (reason: Reason, match: RegExpExecArray | null): { klass: string; sample: string } => {
    // Sınıf ham metinden okunur: sır maskesi sınıfı bozmamalı.
    const code = match && reason.code ? reason.code.exec(flat)?.[1] : undefined
    const klass = code ? `${reason.name}:${code}` : reason.name
    const at = match?.index ?? 0
    const head = flat.slice(0, maxSampleChars).trim()
    // Eşleşme baştan uzaksa çevresinden bir bağlam penceresi ekle; pencereyi
    // kelime sınırına yuvarla ki kırık parçalar görünmesin.
    let tail = ""
    if (at > maxSampleChars) {
      const from = Math.max(0, at - 90)
      const boundary = flat.lastIndexOf(" ", from + 1)
      tail = ` … ${flat.slice(boundary + 1, at + 130).trim()}`
    }
    const sample = `${head}${tail}`.trim()
    return { klass, sample: clean ? sample : redact(sample) }
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
    // `^` içeren alternatifler düzleştirmede ölür; satır bazlı da dene.
    if (!reason.linePattern) continue
    for (const line of lines) {
      if (!reason.linePattern.test(line)) continue
      return build(reason, { index: flat.indexOf(line) } as RegExpExecArray)
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// Yapılandırma (canlı okunur)
// ─────────────────────────────────────────────────────────────────────────────

export interface CaptureConfig {
  /** "Başarılı" çıktısı taranacak araçlar. */
  scanTools: string[]
  /** Örnek metinden gizli değerler maskelensin mi? */
  redact: boolean
  /** Örnek metnin azami uzunluğu. */
  maxSampleChars: number
}

export const DEFAULT_CAPTURE: CaptureConfig = {
  scanTools: ["shell"],
  redact: true,
  maxSampleChars: 220,
}

const CONFIG_FILE = "orchestra.json"

const copyDefault = (): CaptureConfig => ({ ...DEFAULT_CAPTURE, scanTools: [...DEFAULT_CAPTURE.scanTools] })

/** Dosyanın son değişiklik zamanı. Yoksa -1. */
async function stampOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch {
    return -1
  }
}

/**
 * `orchestra.json` → `capture` bloğunu okur.
 *
 * Dosya yoksa, bozuksa veya blok eksikse GÜVENLİ VARSAYILANA düşer: gözlem
 * asla plugin'i bozmaz, en kötü halde eski davranış geçerli olur.
 */
export async function loadCaptureConfig(root: string): Promise<CaptureConfig> {
  const file = path.join(root, ".opencode", CONFIG_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return copyDefault()
  }
  const block = (raw as { capture?: Partial<CaptureConfig> } | null)?.capture
  if (!block || typeof block !== "object" || Array.isArray(block)) return copyDefault()
  const scanTools = Array.isArray(block.scanTools)
    ? block.scanTools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
    : [...DEFAULT_CAPTURE.scanTools]
  return {
    scanTools,
    redact: typeof block.redact === "boolean" ? block.redact : DEFAULT_CAPTURE.redact,
    maxSampleChars:
      typeof block.maxSampleChars === "number" && block.maxSampleChars > 0
        ? Math.floor(block.maxSampleChars)
        : DEFAULT_CAPTURE.maxSampleChars,
  }
}

const plugin: Plugin = {
  id: "orchestra",

  async setup(ctx) {
    // `memory.ts` TypeScript *parametre özelliği* (parameter property) kullanıyor;
    // Node'un strip-only modu bunu YÜKLEYEMEZ. Saf yakalama mantığını test
    // edilebilir kılmak için değer import'u buraya, yani ÇALIŞMA anına alındı.
    // (Diğer modüller zaten yalnız `import type` kullanıyor; onlar etkilenmez.)
    const { Memory } = await import("./memory.ts")
    const memory = await Memory.open(path.join(ctx.location.directory, ".opencode", "memory"))
    const resolving = new Map<string, Promise<void>>()

    // `capture` yapılandırması CANLI tutulur: orchestra.json'daki değişiklik
    // plugin yeniden yüklenene kadar etkisiz kalmasın (fallback ile aynı sebep).
    // Maliyet yalnız gözlem anında, `stat` ile ödenir; dosya değişmediyse okuma yok.
    const configFile = path.join(ctx.location.directory, ".opencode", CONFIG_FILE)
    let capture = await loadCaptureConfig(ctx.location.directory)
    let captureStamp = await stampOf(configFile)
    const refreshCapture = async (): Promise<void> => {
      try {
        const current = await stampOf(configFile)
        if (current === captureStamp) return
        capture = await loadCaptureConfig(ctx.location.directory)
        captureStamp = current
      } catch {
        /* yapılandırma okunamazsa mevcut (güvenli) değerlerde kal */
      }
    }

    // Kayıt adımlarını tek tek ölç. Sessizce kaydedilemeyen bir parça (örn. /loop
    // komutu) kullanıcıyı beklediği bir sistemden mahrum bırakır; bunu görünür kıl.
    const steps: Record<string, "ok" | "hata"> = {}
    let detail: string | undefined
    const record = async <T,>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
      try {
        const result = await run()
        steps[name] = "ok"
        return result
      } catch (error) {
        steps[name] = "hata"
        detail = `${name}: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    // Görev defteri çekirdeğini AÇIP denetle. Araçlar defteri kendileri
    // `context.sessionID` ile açar (defter oturum anahtarlıdır); burada
    // ölçtüğümüz şey `tasks.ts`'nin yapılandırmayı okuyup yuvayı
    // çözebildiğidir. Yazma YAPILMAZ. Bütçe yapılandırması `tasks.ts` içinde
    // CANLI okunur (mtime karşılaştırması) — `capture`/`fallback` ile aynı
    // desen: `orchestra.json` değişince plugin yeniden yüklenmeden geçerli olur.
    await record("tasks", () => TaskLedger.open(memory, ctx.location.directory, "tanilama"))
    await record("tools", () => registerTools(ctx, memory))
    await record("loop", () => registerLoop(ctx, memory))
    const fallback = await record("fallback", async () => registerFallback(ctx, memory, ctx.location.directory))
    await memory.setDiagnostics({ startedAt: new Date().toISOString(), steps, detail })
    const failed = Object.entries(steps).filter(([, value]) => value !== "ok")
    if (failed.length > 0) console.error(`[orchestra] ${detail}`)

    // --- 2. GÖZLEM: her araç çağrısının sonucunu incele -------------------
    // İki yol vardır ve ARALARINDA ASİMETRİ VARDIR:
    //   a) Araç gerçekten hata fırlattıysa (status === "error"). Burada çıktıyı
    //      OKUMUYORUZ; hata bize doğrudan geldi. Bu yol tüm araçlar için açıktır.
    //   b) Araç "başarılı" döndü ama çıktı bir hatayı anlatıyordu
    //      → V2'de sıfır dışı çıkış kodu böyledir.
    // (b) yolunda metin taranır ve tarama YALNIZ `capture.scanTools` içindeki
    // araçlarda yapılır: `read` ile okunan dosyadaki "error TS2345" metni
    // çalıştırılmış bir hata değil, veridir. Taranmasaydı hafıza kendi
    // gürültüsüyle dolar ve gerçek `shell:TipHatasi:TS2345` sayacı eşiği geçerdi.
    const observeHook = await ctx.tool.hook("execute.after", async (event) => {
      if (SELF_TOOLS.has(event.tool)) return

      if (event.status === "error") {
        const message = event.error?.message ?? ""
        if (!message || ABORT.test(message)) return
        memory.capture({ tool: event.tool, role: event.agent, message: redact(message) })
        void memory.persistCapture().catch(() => undefined)
        return
      }

      const text = resultText(event.result)
      if (!text) return
      // Yapılandırma yalnız burada, yani taranabilir aday çıktıda kontrol edilir:
      // `status === "error"` yolu (en sık yol) hiç dosya istemine dokunmaz.
      await refreshCapture()
      if (!shouldScanOutput({ tool: event.tool, status: "completed", text }, capture.scanTools).scan) return

      const failure = extractFailure(text, { maxSampleChars: capture.maxSampleChars, redact: capture.redact })
      if (!failure) return

      memory.capture({
        tool: event.tool,
        role: event.agent,
        message: failure.sample,
        klass: failure.klass,
      })
      void memory.persistCapture().catch(() => undefined)
    })

    // --- 3a. Görev bağlamını kaydet + model geri dönüşü -----------------
    // Geri dönüş BURADA yapılır, context hook'unda değil. İki sebeple:
    //   1) context model gönderilmeden hemen önce çalışır; orada yaptığımız
    //      switchModel o turun isteğini etkilemez, yani bir tur kaybedilir.
    //   2) context her model çağrısında çalışır; araç çağrısından sonra da
    //      tetiklenir ve geri dönüş turun ORTASINDA devreye girip bozuk
    //      modele geri atabilirdi.
    // prompt ise kabul anıdır: bir sonraki turun modeli daha çözülmemiştir.
    // `prompt` hook'u opencode tarafından BEKLENİR (`Promise.resolve(callback(...))`),
    // yani async olabilir. Geri dönüşün `await` edilmesi şart: `void` ile
    // bırakıldığında `onTurnStart` tur bitene kadar işe yaramıyordu ve model
    // isteği restorasyondan ÖNCE gönderilebiliyordu — yani "ilk modele dön"
    // kararı bir sonraki tura kalıyordu. Sıra: önce karar, sonra model isteği.
    const promptHook = await ctx.session.hook("prompt", async (event) => {
      try {
        memory.setGoal(event.sessionID, event.prompt.text ?? "", event.messageID)
        await fallback?.handle.onTurnStart(event.sessionID)
      } catch {
        // Hafıza ve dayanıklılık ASLA bir model çağrısını bozamaz: hata burada
        // yutulur, istek normal akışta gönderilir.
      }
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
        // Sıra önemli: dayanıklılık önce karar verir (model geri dönüşü),
        // sonra hafıza tazelenir ve blok enjekte edilir.
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
}

export default plugin
