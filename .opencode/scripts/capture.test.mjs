/**
 * ORCHESTRA hata yakalama (köken denetimi) regresyon testi.
 *
 * Çalıştırma: node --experimental-strip-types .opencode/scripts/capture.test.mjs
 * (package.json'a ekleme işi mimarındır.)
 *
 * Kapsam:
 *  - `index.ts` içindeki SAF gözlem kararı — `shouldScanOutput`,
 *    `extractFailure`, `redact` ve `loadCaptureConfig`. `memory.ts`'e dokunulmadığı
 *    için burada gerçek hafıza açılmaz; her bölüm kendi `mkdtempSync` geçici
 *    dizinini kullanır ve sonda silinir.
 *  - `tools.ts` içindeki SAF okuma-çözümleyici — `okunacakOturum` (sahte
 *    `ctx`/`memory` ile, disk yok). Gerçek `TaskLedger` açılmaz.
 *
 * YÜKLEME NOTU: `index.ts` saf-only modda (`--experimental-strip-types`) yüklenebilir
 * olmalı. Bunun için `memory.ts`'in DEĞER import'u `setup()` içine alındı; çünkü
 * `memory.ts` TypeScript parametre özelliği kullanıyor ve strip-only mod onu
 * YÜKLEYEMEZ. Geri kalan modüller zaten yalnız `import type` kullanıyor.
 * `tools.ts` bu grafikte DEĞER olarak `./tasks.ts` içe aktarır (parametre özelliği
 * YOK); `./memory` yalnız `import type`. Doğrulayan kontrol:
 *   node --experimental-strip-types -e "import('./tools.ts')"
 *
 * BU TESTLER ESKİ KODDA BAŞARISIZ OLUR. Kanıt:
 *   git stash push -- .opencode/plugins/orchestra/index.ts .opencode/plugins/orchestra/tools.ts
 *   node --experimental-strip-types .opencode/scripts/capture.test.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Depo kökü: `.opencode/orchestra.json`'un GERÇEK içeriğini okumak için. */
const KOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
import {
  DEFAULT_CAPTURE,
  ERROR_SCAN_TOOLS,
  SELF_TOOLS,
  extractFailure,
  loadCaptureConfig,
  redact,
  shouldScanOutput,
} from "../plugins/orchestra/index.ts"
// Okuma yolunun oturum çözümleyicisi. Saf fonksiyon; sahte ctx/memory ile
// sınanır (disk, oturum veritabanı ve gerçek hafıza YOK).
import { YURUYUS_TAVANI, okunacakOturum } from "../plugins/orchestra/tools.ts"

let pass = 0
let fail = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log("  gecti  " + name)
  } else {
    fail++
    console.log("  KALDI  " + name)
    console.log("          beklenen: " + JSON.stringify(expected))
    console.log("          gelen   : " + JSON.stringify(actual))
  }
}

/** mtime çakışması olmasın diye. */
const bekle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Geçici dizinler burada toplanır, sonda hepsi silinir. */
const geciciler = []
const geciciDizin = (etiket) => {
  const dir = mkdtempSync(join(tmpdir(), "orchestra-cap-" + etiket + "-"))
  geciciler.push(dir)
  return dir
}
/** `<gecici>/.opencode/orchestra.json` yazar; `govde` null ise dosya hiç oluşmaz. */
const yazConfig = (dir, govde) => {
  const kok = join(dir, ".opencode")
  mkdirSync(kok, { recursive: true })
  if (govde !== null) writeFileSync(join(kok, "orchestra.json"), typeof govde === "string" ? govde : JSON.stringify(govde), "utf8")
}

/**
 * `observeHook`'un saf karar zinciri: önce karar, izin varsa imza.
 * Testler gerçek kayıt yazmaz; "imza üretildi mi" sorusuna yanıt verir.
 */
const yakala = (tool, text, status = "completed") => {
  if (!shouldScanOutput({ tool, status, text }).scan) return undefined
  return extractFailure(text)
}

// Gerçek `tsc` çıktısı parçası: okunan bir dosyanın İÇİNDE hata metni var.
const TSC_CIKTISI = [
  "src/orchestra/index.ts(412,31): error TS2345: Argument of type 'number' is not assignable to",
  "  parameter of type 'string'.",
  "    412 |   const head = flat.slice(0, maxSampleChars).trim()",
  "        |                                ^^^^^^^^^^^^^^",
].join("\n")

console.log("=== 1. KOKEN DENETIMI: OKUNAN VERI HATA SANILMAZ ===")
{
  // Salt sınırların yetmediği kanıtı: metin GERÇEKTEN bir imza üretir.
  check("read ciktisi desende imza uretir (yalnizca arac siniri durdurur)", extractFailure(TSC_CIKTISI)?.klass, "TipHatasi:TS2345")
  check("read ciktisi IMZA URETMEZ", yakala("read", TSC_CIKTISI), undefined)
  check("grep ciktisi IMZA URETMEZ", yakala("grep", "index.ts:412: error TS2345: not assignable"), undefined)
  check("glob ciktisi IMZA URETMEZ", yakala("glob", "**/*.ts  ->  src/index.ts"), undefined)
  check("webfetch ciktisi IMZA URETMEZ", yakala("webfetch", "docs sayfasi: <code>error TS2345</code>"), undefined)
  check("edit ciktisi IMZA URETMEZ", yakala("edit", "eski: error TS2345\nyeni: duzeltildi"), undefined)
  check("write ciktisi IMZA URETMEZ", yakala("write", "yazildi: error TS2345 not assignable"), undefined)
  check("list ciktisi IMZA URETMEZ", yakala("list", "src/index.ts  error TS2345"), undefined)
  // execute (Code Mode sarmalayicisi) bilerek disarida.
  check("execute sarmalayicisi taranmaz", yakala("execute", TSC_CIKTISI), undefined)
  // Gercek hata hala yakalaniyor: sinirlama asiriya kacmadi.
  check("shell gercek TS2345 YAKALAR", yakala("shell", TSC_CIKTISI)?.klass, "TipHatasi:TS2345")
  check("taranmayan arac listesi yalniz shell", [...ERROR_SCAN_TOOLS], ["shell"])
}

console.log("=== 2. KENDI KAYITLARIMIZ HATA KAYNAGI OLAMAZ ===")
{
  const OZET = "not assignable to parameter of type 'number'"
  check(
    "lessons.jsonl yolu tasiyan shell ciktisi elenir",
    shouldScanOutput({ tool: "shell", status: "completed", text: "cat .opencode/memory/lessons.jsonl\nerror TS2345: " + OZET }).reason,
    "self-content",
  )
  check(
    "lessons.jsonl icerigi tasiyan shell ciktisi IMZA URETMEZ",
    yakala("shell", '{"kind":"auto","signature":"shell:TipHatasi:TS2345"} lessons.jsonl ' + OZET),
    undefined,
  )
  check("state.json yolu elenir", yakala("shell", "cat .opencode/memory/state.json\nerror TS2345: " + OZET), undefined)
  check("<orchestra-memory> isareti elenir", yakala("shell", "<orchestra-memory>\nerror TS2345: " + OZET + "\n</orchestra-memory>"), undefined)
  check("ORCHESTRA HAFIZA isareti elenir", yakala("shell", "ORCHESTRA HAFIZA — bu proje icin dersler\n" + OZET), undefined)
  check('"kind":"auto" alani elenir', yakala("shell", '{"kind":"auto","title":"x"} ' + OZET), undefined)
  check("needsLesson alani elenir", yakala("shell", "needsLesson=false " + OZET), undefined)
  check('"signature" alani elenir', yakala("shell", '"signature":"shell:TipHatasi:TS2345" ' + OZET), undefined)
  check("ORCHESTRA-STATUS isareti elenir", yakala("shell", "ORCHESTRA-STATUS: tools ok " + OZET), undefined)
  // Kontrol: eleme gercek hatayi yutmamali.
  check("kendi kaydi yoksa gercek hata YAKALANIR", yakala("shell", "error TS2345: " + OZET)?.klass, "TipHatasi:TS2345")
}

console.log("=== 3. OLU DESENLER: SATIR BAZLI DENEME ===")
{
  // Once duzlestirme yapildigi icin `^\s*fatal: ` hicbir zaman eslesmiyordu.
  check("fatal ikinci satirda YAKALANIR", extractFailure("warning: dubious ownership\nfatal: not a git repository")?.klass, "GitHatasi")
  check("fatal ilk satirda YAKALANIR", extractFailure("fatal: not a git repository")?.klass, "GitHatasi")
  check("fatal son satirda YAKALANIR", extractFailure("warning: x\nhint: y\nfatal: could not read from remote repository")?.klass, "GitHatasi")
  // `^\s*FAIL\b` alternatifi de oluydu.
  check("2 failing YAKALANIR", extractFailure("  41 passing\n  2 failing\n\n  1) paket a")?.klass, "TestBasarisiz")
  check("FAIL satiri YAKALANIR", extractFailure("PASS src/a.test.ts\nFAIL src/x.test.ts\nTests: 1 failed, 1 passed")?.klass, "TestBasarisiz")
  check("FAILED satiri YAKALANIR", extractFailure("ok 1 - a\nFAILED tests/2 - b")?.klass, "TestBasarisiz")
  // Node yigin cercevesi `[dosya]:satir` duzlestirilince yalniz metnin SONUNDA
  // anlamliydi; ic satir konumunda hic yakalanmiyordu. Artik satir bazli.
  check(
    "yigin cercevesi ic satirda YAKALANIR",
    extractFailure("Hata: yuklendi\n[proj/src/a.js]:12\nHata: bitti")?.klass,
    "NodeHatasi",
  )
  check("satir ici [a.js]:12 tutulmuyor", extractFailure("Hata: yuklendi [proj/src/a.js]:12 Hata: bitti"), undefined)
  // Kontrol: duz metindeki satir ici "FAIL" kelimesi hala imza acmamali.
  check("satir ici FAIL kelimesi tutulmuyor", extractFailure("rapor: FAIL sayisi bilinmiyor"), undefined)
}

console.log("=== 4. GIZLI VERI REDAKSIYONU ===")
{
  check("Bearer maskeleniyor", redact("Bearer sk-abc123"), "Bearer [REDACTED]")
  check("api_key maskeleniyor", redact("api_key=xyz"), "api_key=[REDACTED]")
  check("apikey maskeleniyor", redact("apikey: xyz"), "apikey: [REDACTED]")
  check("tasiyici token maskeleniyor", redact('"token": "abc123"'), '"token": "[REDACTED]"')
  check("sifre maskeleniyor", redact("PASSWORD=hunter2"), "PASSWORD=[REDACTED]")
  check("kullanici:sifre@host maskeleniyor", redact("https://kullanici:sifre@host/repo.git"), "https://[REDACTED]@host/repo.git")
  check("sir olmayan metin DEGISMEZ", redact("fatal: not a git repository"), "fatal: not a git repository")
  // Sinif tespiti sirdan ETKILENMEZ: klass once hesaplanir.
  const SIRLI = "error TS2345: api_key=supersecret123 not assignable to parameter"
  check("sirli orntekte sinif KORUNUYOR", extractFailure(SIRLI)?.klass, "TipHatasi:TS2345")
  check("sirli orntekte sif YOK", extractFailure(SIRLI).sample.includes("supersecret123"), false)
  check("sirli orntekte maske VAR", extractFailure(SIRLI).sample.includes("api_key=[REDACTED]"), true)
  check("redact kapaliyken sinif AYNI", extractFailure(SIRLI, { redact: false })?.klass, extractFailure(SIRLI)?.klass)
  check("redact kapaliyken sif ornekte kalir", extractFailure(SIRLI, { redact: false }).sample.includes("supersecret123"), true)
  check("redact varsayilan olarak ACIK", extractFailure(SIRLI).sample.includes("supersecret123"), false)
}

console.log("=== 5. SAF KARAR YUZEYI: shouldScanOutput ===")
{
  // status === "error" yolu TUM araclarda acik (orada hata bize geldi).
  for (const tool of ["read", "grep", "glob", "shell", "execute", "webfetch"]) {
    check(`error durumunda ${tool} taranir`, shouldScanOutput({ tool, status: "error", text: "kabuk cildi kapandi" }), {
      scan: true,
      message: "kabuk cildi kapandi",
      reason: "error-status",
    })
  }
  check("shell basarili ciktida taranir", shouldScanOutput({ tool: "shell", status: "completed", text: "fatal: not a git repository" }), {
    scan: true,
    reason: "pattern",
  })
  check("execute basarili ciktida TARANMAZ", shouldScanOutput({ tool: "execute", status: "completed", text: "fatal: not a git repository" }), {
    scan: false,
    reason: "tool-not-scanned",
  })
  check("read basarili ciktida taranmaz", shouldScanOutput({ tool: "read", status: "completed", text: "fatal: not a git repository" }), {
    scan: false,
    reason: "tool-not-scanned",
  })
  check("bos cikti taranmaz", shouldScanOutput({ tool: "shell", status: "completed", text: "" }), { scan: false, reason: "empty-output" })
  check("iptal edilen cikti taranmaz", shouldScanOutput({ tool: "shell", status: "completed", text: "request aborted by user" }), {
    scan: false,
    reason: "aborted",
  })
  check("iptal edilen hata mesaji taranmaz", shouldScanOutput({ tool: "shell", status: "error", text: "session closed" }), {
    scan: false,
    reason: "aborted",
  })
  check("bos hata mesaji taranmaz", shouldScanOutput({ tool: "shell", status: "error", text: "" }), { scan: false, reason: "aborted" })
  // Kendi araclarimiz hicbir yolda taranmaz.
  for (const tool of SELF_TOOLS) {
    check(`kendi aracimiz ${tool} (basarili) taranmaz`, shouldScanOutput({ tool, status: "completed", text: "error TS2345" }).reason, "self-tool")
    check(`kendi aracimiz ${tool} (error) taranmaz`, shouldScanOutput({ tool, status: "error", text: "error TS2345" }).reason, "self-tool")
  }
  // Yapilandirma ile arac siniri genisletilebilir olmali.
  check(
    "scanTools ile execute taranabilir",
    shouldScanOutput({ tool: "execute", status: "completed", text: "fatal: not a git repository" }, ["shell", "execute"]).reason,
    "pattern",
  )
  // GORUNURLUK KAYBI KONTROLU: `capture.scanTools` varsayilandan yalniz `shell`
  // olsaydi, MCP araclarinin "basarili" ciktisindaki GERCEK hatalar (Python
  // yigini, Node yigini, TS kodu) hic yakalanmazdi — o hatadan ders cikmasin
  // diye eklenen sey buydu. Canli liste `.opencode/orchestra.json` icinde;
  // burada AYNI arac adini elle veriyoruz.
  //
  // `"execute"` bu SIZI testte KASITLI olarak veriliyor: yapilandirma genisletirse
  // taranabilir. Canli config ise `execute`'u DIŞARIDA tutar — sarmalayıcının
  // ciktisi icinden cagrilan read/grep ciktilariyla karisir. Canli liste icin
  // asagidaki "CANLI LISTE" kontrolune bakin.
  const MCP = ["shell", "blender_execute_blender_code", "shotcut_edit_project", "browser_tabs_open"]
  check(
    "MCP araci PythonTraceback ciktisini tarar",
    shouldScanOutput({ tool: "blender_execute_blender_code", status: "completed", text: 'Traceback (most recent call last):\n  File "a.py", line 2, in f' }, MCP).reason,
    "pattern",
  )
  // GURLULTU KONTROLU: MCP ciktisini genisletmek, bizim KENDI kayitlarimizi
  // ( lessons.jsonl, signature, vb. ) MCP hatasi sanmamali.
  check(
    "SELF_CONTENT MCP ciktisini eler (kendi kaydimizi tarama)",
    shouldScanOutput({ tool: "blender_execute_blender_code", status: "completed", text: "error TS2345 lessons.jsonl" }, MCP).reason,
    "self-content",
  )
}

console.log("=== 6. YAPILANDIRMA: capture blogu ===")
{
  check("varsayilan tara listesi", [...DEFAULT_CAPTURE.scanTools], ["shell"])
  check("varsayilan redaksiyon acik", DEFAULT_CAPTURE.redact, true)
  check("varsayilan ornek uzunlugu", DEFAULT_CAPTURE.maxSampleChars, 220)

  const kok = geciciDizin("yok")
  check("dosya yoksa guvenli varsayilan", await loadCaptureConfig(kok), DEFAULT_CAPTURE)

  const bozuk = geciciDizin("bozuk")
  yazConfig(bozuk, "{ bu json degil")
  check("bozuk JSON guvenli varsayilan", await loadCaptureConfig(bozuk), DEFAULT_CAPTURE)

  const bloksuz = geciciDizin("bloksuz")
  yazConfig(bloksuz, { fallback: { enabled: true } })
  check("capture blogu yoksa guvenli varsayilan", await loadCaptureConfig(bloksuz), DEFAULT_CAPTURE)

  const tam = geciciDizin("tam")
  yazConfig(tam, { capture: { scanTools: ["shell", "execute"], redact: false, maxSampleChars: 80 } })
  check("tam blok okunuyor", await loadCaptureConfig(tam), { scanTools: ["shell", "execute"], redact: false, maxSampleChars: 80 })

  const kismi = geciciDizin("kismi")
  yazConfig(kismi, { capture: { scanTools: ["shell"] } })
  check("eksik alanlar varsayilana duser", await loadCaptureConfig(kismi), DEFAULT_CAPTURE)

  const bozukAlan = geciciDizin("alan")
  yazConfig(bozukAlan, { capture: { scanTools: [1, "", "shell"], redact: "evet", maxSampleChars: -5 } })
  check("gecersiz alanlar elenir", await loadCaptureConfig(bozukAlan), { scanTools: ["shell"], redact: true, maxSampleChars: 220 })

  // CANLI LISTE KONTROLÜ — en az bu kadar anlamlı.
  // Ölçülen kusur: canlı `orchestra.json` `execute`'u ve BİR DOKUZ okuma
  // aracını (`browser_preview`, `*_get_*`, `shotcut_*_status`) taramaya almıştı.
  // Bunların başarılı çıktısı VERİDİR; okunan bir `.ts` dosyasındaki
  // "error TS2345" çalıştırılmış bir hata değildir ve `shell:TipHatasi` imzasını
  // şişirip eşik geçirir. P3a'nın tezi bu listeyle kendi kendini iptal ediyordu.
  const canliDizin = mkdtempSync(tmpdir() + "/orchestra-canli-liste-")
  try {
    // `loadCaptureConfig` proje KÖKÜ bekler; dosya `<kok>/.opencode/orchestra.json`.
    const kaynak = readFileSync(join(KOK, ".opencode", "orchestra.json"), "utf8")
    yazConfig(canliDizin, kaynak)
    const canli = await loadCaptureConfig(canliDizin)
    const liste = canli.scanTools
    check("canli liste yuklendi", liste.length > 0, true)
    check("canli liste icinde `shell` var", liste.includes("shell"), true)
    // Okuma araclari disarida olmali.
    for (const okuma of ["execute", "read", "grep", "glob", "webfetch", "browser_preview", "blender_get_scene_info", "shotcut_shotcut_status"]) {
      check("canli liste okuma aracini TARAMAZ: " + okuma, liste.includes(okuma), false)
    }
    // Calistirma yapan araclar iceride olmali.
    for (const calistirma of ["blender_execute_blender_code", "blenderlab_execute_blender_code", "shotcut_edit_project"]) {
      check("canli liste calistirma aracini TARAR: " + calistirma, liste.includes(calistirma), true)
    }
    // Okunan bir .ts dosyasinin icerigi TIKANMAMALI.
    check(
      "okunan .ts icerigi canli listede imza uretmiyor",
      shouldScanOutput({ tool: "read", status: "completed", text: "error TS2345: Cannot find name 'foo'" }, liste).scan,
      false,
    )
  } finally {
    rmSync(canliDizin, { recursive: true, force: true })
  }

  const diziBlok = geciciDizin("dizi")
  yazConfig(diziBlok, { capture: ["shell"] })
  check("capture dizi ise guvenli varsayilan", await loadCaptureConfig(diziBlok), DEFAULT_CAPTURE)

  // Yapilandirma canli okunur: dosya degistiginde deger degismeli.
  const canli = geciciDizin("canli")
  yazConfig(canli, { capture: { scanTools: ["shell"], redact: true, maxSampleChars: 220 } })
  const ilk = await loadCaptureConfig(canli)
  await bekle(20)
  yazConfig(canli, { capture: { scanTools: ["shell", "execute"], redact: false, maxSampleChars: 40 } })
  const ikinci = await loadCaptureConfig(canli)
  check("canli okuma ilk degeri verir", ilk, DEFAULT_CAPTURE)
  check("canli okuma degisikligi yakalar", ikinci, { scanTools: ["shell", "execute"], redact: false, maxSampleChars: 40 })
}

console.log("=== 7. REDAKSIYON KILIDI: SAGLAYICI ENV ADLARI + ON EK + KALINTI ===")
{
  // Bu blok "sır ÖRNEĞİ kalıcı diske yazılmasın" kuralının ÖLÇÜLEBİLİR hâli.
  // Daha önce yalnız `api_key`/`Bearer` örnekleri vardı; sağlayıcı hata
  // mesajlarının asıl biçimi (ENV ADI + DEĞER, değer çoğu kez biçimsiz)
  // testlerle kilitli DEĞİLDI.
  const ENV_ADLARI = [
    ["OPENAI_API_KEY=sk-proj-abc123def456ghi789", "OPENAI_API_KEY=[REDACTED]"],
    ["OPENAI_API_KEY=abcdef0123456789", "OPENAI_API_KEY=[REDACTED]"],
    ["ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop", "ANTHROPIC_API_KEY=[REDACTED]"],
    ["ANTHROPIC_API_KEY=plainsecretyalniz", "ANTHROPIC_API_KEY=[REDACTED]"],
    ["ANTHROPIC_API_KEY: sk-ant-api03-abcdefghijklmnop", "ANTHROPIC_API_KEY: [REDACTED]"],
    ["GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "GITHUB_TOKEN=[REDACTED]"],
    ["GITHUB_TOKEN=plainvalue123", "GITHUB_TOKEN=[REDACTED]"],
    ["HF_TOKEN=hf_ABCDEFGHIJKLMNOPQRSTUVWX", "HF_TOKEN=[REDACTED]"],
    ["HF_TOKEN=plainvalue123", "HF_TOKEN=[REDACTED]"],
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY", "AWS_SECRET_ACCESS_KEY=[REDACTED]"],
    ["AWS_SECRET_ACCESS_KEY=short", "AWS_SECRET_ACCESS_KEY=[REDACTED]"],
  ]
  for (const [girdi, beklenen] of ENV_ADLARI) {
    check("env adi maskeleniyor: " + girdi.split("=")[0], redact(girdi), beklenen)
    check("env adi degeri KALMIYOR: " + girdi.split("=")[0], redact(girdi).includes(girdi.split(/[:=]/)[1].trim()), false)
  }

  // DEĞİŞİK (biçimsiz) token: ortada hiçbir `=` yok.
  check("standalone AKIA maskeleniyor", redact("AWS access key id AKIAIOSFODNN7EXAMPLE here"), "AWS access key id [REDACTED] here")
  check("bare AKIA maskeleniyor", redact("bare AKIA1234567890ABCDEF token"), "bare [REDACTED] token")
  check("github_pat maskeleniyor", redact("github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz"), "[REDACTED]")
  check("Google AIza maskeleniyor", redact("key=AIzaSyA1234567890abcdefghijklmnopqrstuv"), "key=[REDACTED]")

  // TIRNAKLI değerlerde MASKE TIRNAĞIN İÇİNDE kalır; tırnak sayısı bozulmaz.
  check("tirnakli env degeri maskeleniyor", redact('{"OPENAI_API_KEY": "sk-proj-abc"}'), '{"OPENAI_API_KEY": "[REDACTED]"}')
  check("tirnakli api_key maskeleniyor", redact('error TS2345: "api_key": "supersecret123" not assignable'), 'error TS2345: "api_key": "[REDACTED]" not assignable')
  check("maskeli tirnakli deger DEGISMEZ", redact('"token": "[REDACTED]"'), '"token": "[REDACTED]"')

  // ÇİFT PARANTEZ KALINTISI: ön ek tanıyıcısı değeri `[REDACTED]` yazar, sonra
  // değişken-adı deseni aynı bölgeye ikinci kez yazar ve değer `]` ile kesildiği
  // için `[REDACTED]]` üretilirdi. Eski temizlik (`[REDACTED](?=\])` → `[REDACTED`)
  // BAYT BAZINDA İŞE YARAMIYORDU: silinen `]` yerine aynı `]` kalıyordu.
  check("cift parantez kalintisi YOK: env + on ek", redact("OPENAI_API_KEY=sk-proj-abcdefghijkl]"), "OPENAI_API_KEY=[REDACTED]")
  check("cift parantez kalintisi YOK: deger tirnakli", redact("secret=[hf_ABCDEFGHIJKLMNOPQRSTUVWX]"), "secret=[REDACTED]")
  // ONCEDEN KALMIŞ kalıntı da temizlenir (idempotent çıktı: tek `]`).
  check("onceki kalinti kapanir", redact("api_key=[REDACTED]]"), "api_key=[REDACTED]")
  check("siradan ]] DEGISMEZ", redact("matris [[1,2],[3,4]] bos"), "matris [[1,2],[3,4]] bos")
  for (const [girdi] of ENV_ADLARI) check("kalinti yok: " + girdi.split("=")[0], redact(girdi).includes("]]"), false)

  // IDEMPOTENS: ikinci geçiş çıktıyı DEĞİŞTİRMEZ (maske yeniden üretilmez).
  const SIRLAR = [...ENV_ADLARI.map(([g]) => g), "AWS access key id AKIAIOSFODNN7EXAMPLE here", "secret=[hf_ABCDEFGHIJKLMNOPQRSTUVWX]", 'x "token": "[REDACTED]"', "api_key=[REDACTED]]"]
  for (const s of SIRLAR) check("redact idempotent: " + s.slice(0, 24), redact(redact(s)), redact(s))

  // NORMAL TANI ÖRNEĞİ ETKİLENMEZ: gizli değer yoksa metin AYNEN kalır.
  const TANILAR = [
    "fatal: not a git repository",
    "npm ERR! code E404 404 Not Found - GET https://example.com/x",
    "FullyQualifiedErrorId : PowerShellHatasi",
    "testler 3 failing\nTests: 3 failed, 10 passed",
    "src/a.ts(1,1): error TS2304: Cannot find name 'x'",
    "PackagesNotFoundError: The following package(s) were not found: yok",
    // ENV ADI TEK BAŞINA sır DEĞİLDİR: `[:=]` yoksa değer de yoktur, tanıyı
    // bozmak maskelemenin değil kaybın işareti olurdu.
    "Environment variable GITHUB_TOKEN not found",
  ]
  for (const t of TANILAR) check("tani etkilenmez: " + t.split("\n")[0].slice(0, 34), redact(t), t)
  // Kontrol: sınıf tespiti redaksiyondan bağımsız kalır.
  check("tani sinifi redaksiyonla degismez", extractFailure(redact(TANILAR[4]))?.klass, extractFailure(TANILAR[4])?.klass)
}

console.log("=== 8. OKUMA YOLU: EN YAKIN DOLU ATA DEFTERI ===")
{
  /** Sahte oturum veritabanı: `harita[oturum] = parentID`. */
  const ctxUret = (harita, hatali) => ({
    session: {
      get: async ({ sessionID }) => {
        if (hatali && hatali.includes(sessionID)) throw new Error("oturum okunamadi")
        return harita[sessionID] === undefined ? undefined : { parentID: harita[sessionID] }
      },
    },
  })
  const BOS = { tasks: [], budget: { startedAt: 0, iterations: 0, tasks: 0 } }
  /** `dolu` kümesindeki oturumlar görevli; `butceli` yalnız bütçesi iş görmüş. */
  const hafizaUret = (dolu = new Set(), butceli = new Set()) => ({
    getTaskVault: (sessionID) => {
      if (dolu.has(sessionID)) return { tasks: [{ id: "P1" }], budget: { startedAt: 1, iterations: 0, tasks: 1 } }
      if (butceli.has(sessionID)) return { tasks: [], budget: { startedAt: 5, iterations: 0, tasks: 0 } }
      return { tasks: [], budget: { ...BOS.budget } }
    },
  })

  // 1) Klasik alt ajan: child boş, parent dolu → PARENT görünür.
  check(
    "alt ajan parent'in dolu defterini gorur",
    await okunacakOturum(ctxUret({ child: "parent", parent: "root" }), hafizaUret(new Set(["parent"])), "child"),
    "parent",
  )
  // 2) ÖLÇÜLEN KUSUR (v1): en üst KÖKE yükseliyordu. root boş, parent dolu,
  //    child boş → sonuç PARENT olmalı, `root` DEĞİL.
  check(
    "bos koke degil en yakin dolu ataya cikar",
    await okunacakOturum(ctxUret({ child: "parent", parent: "root" }), hafizaUret(new Set(["parent"])), "child"),
    "parent",
  )
  // 3) Kendi defteri doluysa hiç yürünmez (kendi defteri tercih edilir).
  check(
    "cocuk kendi dolu defterini tercih eder",
    await okunacakOturum(ctxUret({ child: "parent", parent: "root" }), hafizaUret(new Set(["child", "parent"])), "child"),
    "child",
  )
  // 4) Görevi olmayan ama BÜTÇESİ iş görmüş ata da "dolu" sayılır.
  check(
    "butcesi is gormus ata dolu sayilir",
    await okunacakOturum(ctxUret({ child: "parent" }), hafizaUret(new Set(), new Set(["parent"])), "child"),
    "parent",
  )
  // 5) Hiçbir ata dolu değilse en üst kök döner (mimarın kendi boş defteri).
  check(
    "dolu ata yoksa koke cikar",
    await okunacakOturum(ctxUret({ child: "parent", parent: "root" }), hafizaUret(), "child"),
    "root",
  )
  // 6) DÖNGÜ: A → B → A sonsuza kadar yürümez, çıplak hata fırlatmaz.
  check(
    "dongu sonlanir (A->B->A)",
    await okunacakOturum(ctxUret({ a: "b", b: "a" }), hafizaUret(), "a"),
    "b",
  )
  check(
    "dongu: dolu dugume geri donulur, o secilir",
    await okunacakOturum(ctxUret({ a: "b", b: "a" }), hafizaUret(new Set(["a"])), "b"),
    "a",
  )
  // 7) HATA: `session.get` patlarsa çağıran (bir araç çıktısı) patlamaz.
  check(
    "session.get hatasi guvenli: kendi oturumu doner",
    await okunacakOturum(ctxUret({ child: "parent" }, ["child"]), hafizaUret(new Set(["parent"])), "child"),
    "child",
  )
  check(
    "session.get hatasi guvenli: dolu ata gorunur",
    await okunacakOturum(ctxUret({ child: "parent" }, ["child"]), hafizaUret(new Set(["parent"])), "child"),
    "child",
  )
  // 8) Derinlik tavanı: 8 kademelik zincirin EN DERTTEki defteri görünmez.
  const zincir = {}
  for (let i = 1; i <= 9; i++) zincir["s" + i] = i === 9 ? undefined : "s" + (i + 1)
  check(
    "yuruyus tavana dayanir (" + YURUYUS_TAVANI + ")",
    await okunacakOturum(ctxUret(zincir), hafizaUret(new Set(["s9"])), "s1"),
    "s" + (1 + YURUYUS_TAVANI),
  )
  // 9) Yabancı/bağımsız oturuma yükselme YOK: yalnız `parentID` kenarı izlenir.
  check(
    "yabanci oturuma yukselmez",
    await okunacakOturum(ctxUret({ child: "parent" }), hafizaUret(new Set(["baska-bagimsiz-oturum"])), "child"),
    "parent",
  )

  // 10) YAZMA YOLU YÜKSELMEZ — yapısal kilit: çözümleyici TAM OLARAK bir yerde
  //     çağrılır (tanım + `orchestra_status`). `orchestra_task` kendi
  //     `context.sessionID` ile yazmaya devam eder.
  const kaynak = readFileSync(join(KOK, ".opencode", "plugins", "orchestra", "tools.ts"), "utf8")
  const cagriSayisi = (kaynak.match(/okunacakOturum\(/g) ?? []).length
  check("cozumleyici yalnizca bir kez cagirilir (tanim + status)", cagriSayisi, 2)
  check("yazma yolu context.sessionID ile acilir", /const defter = await openLedger\(ctx, memory, context\.sessionID\)/.test(kaynak), true)
  check("eski cozumleyici KALDIRILDI (cagri/tanim yok)", /mimarOturumu\s*\(/.test(kaynak), false)
}

for (const dir of geciciler) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* gecici dizin temizligi kritik degil */
  }
}

console.log("SONUC: " + pass + " gecti, " + fail + " kaldi")
process.exit(fail === 0 ? 0 : 1)