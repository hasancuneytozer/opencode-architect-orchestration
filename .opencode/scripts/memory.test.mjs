/**
 * ORCHESTRA hafıza katmanı için regresyon testi.
 *
 * Çalıştırma: npm test
 *
 * Kapsam: `memory.ts` — ders deposu (lessons.jsonl), döngü durumu (state.json),
 * dış değişiklik resync'i ve saf `tokenize()`. `fallback.ts` saf mantığının
 * testi `scripts/orchestra.test.mjs` içindedir; burada o sıra dışıdır.
 *
 * ÖNEMLİ: testler ASLA depodaki gerçek `.opencode/memory/` dizinine dokunmaz.
 * Her bölüm kendi `mkdtempSync` geçici dizinini açar, sonunda hepsi silinir.
 * (Gerçek dizinde kişiye özel dersler var; bir test onları bozarsa hafıza
 * kalıcı olarak zehirlenir.)
 *
 * YÜKLEME NOTU: `memory.ts` TypeScript *parametre özelliği* kullanıyor
 * (memory.ts:919-923, `private constructor(private readonly dir: string ...)`).
 * Bu bir emit dönüşümüdür, sadece tip söz dizimi değildir; bu yüzden Node'un
 * strip-only modu (`--experimental-strip-types`) bu dosyayı YÜKLEYEMEZ:
 * "TypeScript parameter property is not supported in strip-only mode".
 * Bu yüzden package.json'daki ikinci komut ayrıca `--experimental-transform-types`
 * taşır. memory.ts'e dokunulmadığı için bu bayrak zorunludur.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { Memory, tokenize } from "../plugins/orchestra/memory.ts"

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

/** mtime çakışması olmasın diye: dosya zaman damgaları kaba çözünürlüklü olabilir. */
const bekle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Geçici dizinler burada toplanır, sonda hepsi silinir. */
const geciciler = []
const geciciDizin = (etiket) => {
  const dir = mkdtempSync(tmpdir() + "/orchestra-mem-" + etiket + "-")
  geciciler.push(dir)
  return dir
}

const lessonsPath = (dir) => dir + "/lessons.jsonl"
const statePath = (dir) => dir + "/state.json"
const okunur = (dosya) => readFileSync(dosya, "utf8")

/** Elle yazılan geçerli bir ders satırı (d) ve (g) bölümleri için. */
const gecerliDers = (id, title) => ({
  id,
  kind: "agent",
  title,
  rule: "harici kural",
  body: "",
  tags: ["harici"],
  seen: 0,
  hits: 0,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
})

// ---------------------------------------------------------------------------

console.log("=== 1. DERS EKLEME / RELOAD / GET ===")
{
  const dir = geciciDizin("a")
  const m = await Memory.open(dir)
  check("bos depo acilir", m.list().length, 0)
  check("acilis durumu idle", m.getLoop().status, "idle")

  const ders = await m.add({
    title: "  Test Dersi  ",
    rule: "  once oku sonra yaz  ",
    body: "  gerekce  ",
    tags: ["test"],
  })
  check("add L-0001 dondurdu", ders.id, "L-0001")
  check("add basligi kirpirdi", ders.title, "Test Dersi")
  check("add kurali kirpirdi", ders.rule, "once oku sonra yaz")
  check("add govdesi kirpirdi", ders.body, "gerekce")
  check("varsayilan tur agent", ders.kind, "agent")
  check("varsayilan durum active", ders.status, "active")
  check("get(id) dogru dersi dondurur", m.get("L-0001")?.rule, "once oku sonra yaz")
  check("get() tanimsiz id -> undefined", m.get("L-9999"), undefined)
  check("verilen etiket korunur", m.get("L-0001")?.tags.includes("test"), true)
  check("baslik/rule tokenize ile etiketlendi", m.get("L-0001")?.tags.includes("once"), true)
  check("stopword etiket OLUSMAZ ('sonra')", m.get("L-0001")?.tags.includes("sonra"), false)

  const ikinci = await m.add({ title: "Ikinci", rule: "ikinci kural", kind: "curated" })
  check("id artmasi (L-0002)", ikinci.id, "L-0002")
  check("curated turu yazildi", m.get("L-0002")?.kind, "curated")

  check("add dosyaya yazdi", okunur(lessonsPath(dir)).includes("L-0001"), true)
  await m.reload()
  check("reload sonrasi ders okunur", m.get("L-0001")?.title, "Test Dersi")
  check("reload sonrasi iki ders var", m.list().length, 2)
  check("reload sonrasi etiketler duruyor", m.get("L-0002")?.tags.length > 0, true)
  check("liste filtresi tur", m.list({ kind: "curated" }).length, 1)
}

console.log("")
console.log("=== 2. EMEKLIYE AYIRMA (forget) ===")
{
  const dir = geciciDizin("b")
  const m = await Memory.open(dir)
  const ders = await m.add({ title: "Eski ders", rule: "eski kural", body: "not" })

  const emekliler = await m.forget({ id: ders.id, reason: "yanlis" })
  check("forget tek ders dondurdu", emekliler.length, 1)
  check("forget dogru dersi secer", emekliler[0]?.id, "L-0001")
  check("durum retired", m.get("L-0001")?.status, "retired")
  check("govdeye EMEKLI etiketi eklendi", m.get("L-0001")?.body.includes("EMEKLI: yanlis"), true)
  check("aktif listeden cikti", m.list({ status: "active" }).length, 0)
  check("emekli listesinde", m.list({ status: "retired" }).length, 1)
  check("emeklilik diske yazildi", okunur(lessonsPath(dir)).includes("retired"), true)
  check("olmayan id sessizce bos liste", (await m.forget({ id: "L-9999" })).length, 0)
  check("olmayan id hata firlatmadi", m.list().length, 1)
}

// ---------------------------------------------------------------------------

console.log("")
console.log("=== 3. YAKALAMA KUYRUK (capture / persistCapture) ===")
{
  const dir = geciciDizin("c")
  const m = await Memory.open(dir)
  const dosya = lessonsPath(dir)

  // capture() SENKRON olmalı: kuyruğa alır, belleğe ve diske dokunmaz.
  const ilk = m.capture({ tool: "shell", role: "coder", message: "npm run build patladi", klass: "komut-yok" })
  check("capture signature donduruyor", typeof ilk.signature, "string")
  check("capture queued = 1", ilk.queued, 1)
  check("capture sinif imzasi", ilk.signature, "shell:komut-yok")
  check("capture DISKE YAZMADI (dosya yok)", existsSync(dosya), false)
  check("capture listeye dokunmadi", m.list().length, 0)

  await m.persistCapture()
  check("persist sonra dosya olustu", existsSync(dosya), true)
  check("auto kayit eklendi", m.get("L-0001")?.kind, "auto")
  check("auto kaydin araci", m.get("L-0001")?.tool, "shell")
  check("auto kaydin rolu", m.get("L-0001")?.role, "coder")
  check("1. kez seen 1", m.get("L-0001")?.seen, 1)
  check("1. kez needsLesson YOK", m.get("L-0001")?.needsLesson, undefined)

  m.capture({ tool: "shell", role: "coder", message: "npm run build patladi", klass: "komut-yok" })
  await m.persistCapture()
  check("ayni imza 2. kez -> YENI kayit acilmadi", m.list().length, 1)
  check("2. kez seen 2", m.get("L-0001")?.seen, 2)
  check("2. kez needsLesson hala YOK (esik 3)", m.get("L-0001")?.needsLesson, undefined)

  m.capture({ tool: "shell", role: "coder", message: "npm run build patladi", klass: "komut-yok" })
  await m.persistCapture()
  check("3. kez needsLesson TRUE", m.get("L-0001")?.needsLesson, true)
  check("3. kez seen 3", m.get("L-0001")?.seen, 3)
  check("3. kez hala tek kayit", m.list().length, 1)
  check("needsLesson istatistikte sayildi", m.stats().pending, 1)
  check("otomatik kayit diske yazildi", okunur(dosya).includes("shell:komut-yok"), true)

  // klass verilmezse imza normalize edilmiş mesajin hash'idir.
  const hashli = m.capture({ tool: "edit", message: "bilinen mesaj" })
  check("klass yoksa imza arac:hash", hashli.signature.startsWith("edit:"), true)

  // Kuyruk, dis sifirlamadan SONRA uygulanir (memory.ts:1214-1216): kullanici
  // dosyayi silerse, henuz yazilmamis kayit sifirlamayi gormemeli.
  await fs.writeFile(dosya, "", "utf8")
  await m.persistCapture()
  check("dis sifirlamadan sonra kuyruk yine yazildi", existsSync(dosya), true)
  check("sifirlamadan sonra 1 kayit var", m.list().length, 1)
  check("kuyruktaki kayit aracini tasiyor", m.get("L-0001")?.tool, "edit")
}

// ---------------------------------------------------------------------------

console.log("")
console.log("=== 4. BOZUK SATIR TOLERANSI (lessons.jsonl) ===")
{
  const dir = geciciDizin("d")
  await fs.writeFile(
    lessonsPath(dir),
    [
      "{bozuk satir",                        // parse edilemez -> atla
      JSON.stringify(gecerliDers("L-0042", "Gecerli ders")),
      "{'tek tirnak': 1}",                   // gecersiz JSON -> atla
      "123",                                 // JSON ama ders degil -> atla
      JSON.stringify({ id: "L-0043" }),      // tags dizisi yok -> atla (memory.ts:980)
      "",                                    // bos satir -> atla
      JSON.stringify(gecerliDers("L-0044", "Ikinci gecerli")),
    ].join("\n") + "\n",
    "utf8",
  )

  let m = null
  let acildi = "acildi"
  let hata = ""
  try {
    m = await Memory.open(dir)
  } catch (e) {
    acildi = "hata: " + String(e)
    hata = String(e)
  }
  if (hata) console.log("        (open hatasi: " + hata + ")")
  check("bozuk satirlarla acilis HATASIZ", acildi, "acildi")
  check("bozuk satirlar ATLANDI", m.list().length, 2)
  check("ilk gecerli satir okundu", m.get("L-0042")?.title, "Gecerli ders")
  check("ikinci gecerli satir okundu", m.get("L-0044")?.title, "Ikinci gecerli")
  check("tags dizisi olmayan satir elendi", m.get("L-0043"), undefined)
  check("bozuk satirdan sonra akis SURER", m.stats().total, 2)
}

// ---------------------------------------------------------------------------

console.log("")
console.log("=== 5. BOZUK state.json ===")
{
  const dir = geciciDizin("e")
  await fs.writeFile(statePath(dir), "{bu gecerli JSON degil", "utf8")

  let m = null
  let acildi = "acildi"
  try {
    m = await Memory.open(dir)
  } catch (e) {
    acildi = "hata: " + String(e)
  }
  check("bozuk state.json ile acilis HATASIZ", acildi, "acildi")
  check("store sifirlandi", m.getLoop(), { status: "idle" })
  check("getLoop().status idle", m.getLoop().status, "idle")
  check("rapor sifirlandi", m.getReport(), undefined)
  check("tanilama sifirlandi", m.getDiagnostics(), undefined)

  // Bozuk dosya yazma sonrasi da kullanilabilir kalmali.
  const loop = await m.setLoop({ goal: "toparlandi", status: "running" })
  check("bozuk dosyadan sonra yazma calisiyor", loop.status, "running")
  check("dis artik gecerli JSON", JSON.parse(okunur(statePath(dir))).loop.goal, "toparlandi")
  check("getLoop() yeni durumu donduruyor", m.getLoop().goal, "toparlandi")
}

// ---------------------------------------------------------------------------

console.log("")
console.log("=== 6. HARICI YAZMA SONRASI KORUMA (KRITIK) ===")
// Beklenen SIKIL KURAL: bu bolumde kullanici/başka bir ornekce state.json'u
// ELLE yaziyor, biz de hemen ardindan setLoop() cagiriyoruz. Dis yazim
// okunMALI ve hicbir alani EZMEMELI; kendi setLoop({iteration:3}) cagrimizin
// patch'i bu yazimin UZERINE binmemeli.
//
// Gercek kod sirasi (okunarak izlendi ve DUZELTILDI):
//   onceki hal: mutasyon (:551) resync'ten (:552 -> :272) ONCE idi; resync'in
//               reload'u (:211 -> :195) store'u tamamen degistirip patch'i SILIYORDU.
//   simdi:       resync ONCE, sonra mutasyon, sonra yazim — commit() ile ayni sira
//               (memory.ts commit yorumu bu sirayi zaten sart koar).
// Bu bolum birlestirme semantigini kilitler: harici alanlar korunur, patch
// UYGULANIR. Onceki davranis (patch sessizce atilmasi) burada KIRMIZI olurdu.
{
  const dir = geciciDizin("f")
  const dosya = statePath(dir)
  const m = await Memory.open(dir)

  await m.setLoop({ goal: "benim hedefim", status: "running" })
  check("adim 1: kendi yazimimiz diskte", JSON.parse(okunur(dosya)).loop.goal, "benim hedefim")

  const onceki = statSync(dosya).mtimeMs
  await bekle(20)
  await fs.writeFile(dosya, JSON.stringify({ loop: { status: "running", goal: "HARICI", iteration: 7 } }), "utf8")
  check("adim 2: harici yazim mtime'i degistirdi", statSync(dosya).mtimeMs !== onceki, true)

  const donus = await m.setLoop({ iteration: 3 })

  // Dogru birlestirme: harici yazim ONCE okunur, SONRA kendi patch'imiz
  // UZERINE biner. onceki alanlar hariciden gelir, patch edilen alan bizimdir.
  check("adim 3: harici okundu, patch uzerine bindi", m.getLoop(), {
    status: "running",
    goal: "HARICI",
    iteration: 3,
    updatedAt: m.getLoop().updatedAt,
  })
  check("patch UYGULANDI (iteration 3)", m.getLoop().iteration, 3)
  check("harici alan KORUNDU (goal HARICI)", m.getLoop().goal, "HARICI")
  check("onceki patch KAYBOLMADI (goal bizimki ezilmemis)", m.getLoop().goal !== "benim hedefim", true)
  check("setLoop donusu de birlestirilmis durumu yansitir", donus.iteration, 3)
  check("diskte birlestirilmis durum yazili", JSON.parse(okunur(dosya)).loop, {
    status: "running",
    goal: "HARICI",
    iteration: 3,
    updatedAt: donus.updatedAt,
  })
}

// ---------------------------------------------------------------------------

console.log("")
console.log("=== 7. RESYNC (dis degisiklik algilama) ===")
{
  const dir = geciciDizin("g")
  const dosya = lessonsPath(dir)
  const m = await Memory.open(dir)

  const ilk = await m.add({ title: "Ilk", rule: "ilk kural" })
  const t1 = statSync(dosya).mtimeMs
  check("add dosyayi yaratti", existsSync(dosya), true)

  await bekle(20)
  await fs.appendFile(dosya, JSON.stringify(gecerliDers("L-0009", "Harici")) + "\n", "utf8")
  check("harici yazim mtime'i degistirdi", statSync(dosya).mtimeMs !== t1, true)

  await m.sync()
  check("sync() harici dersi goruyor", m.get("L-0009")?.title, "Harici")
  check("sync() kendi dersimizi koruyor", m.get(ilk.id)?.title, "Ilk")
  check("sync() sonrasi 2 ders", m.list().length, 2)

  // commit() yolu resync'i once yapar (memory.ts:1125-1134): harici satirlar
  // silinmemeli, ayni anda yeni ders eklenmeli.
  await fs.appendFile(dosya, JSON.stringify(gecerliDers("L-0010", "Harici iki")) + "\n", "utf8")
  const ucuncu = await m.add({ title: "Ucuncu", rule: "ucuncu kural" })
  check("commit() harici 2. kaydi EZMEDI", m.get("L-0010")?.title, "Harici iki")
  check("commit() kendi dersini ekledi", m.list().length, 4)
  check("yeni id cakismadi (L-0011)", ucuncu.id, "L-0011")
  check("kendi eski dersimiz de duruyor", m.get(ilk.id)?.title, "Ilk")
  check("dosyada dort satir var", okunur(dosya).trim().split("\n").length, 4)
}

console.log("")
console.log("=== 8. TOKENIZE (saf fonksiyon) ===")
check("bos metin bos kume", [...tokenize("")], [])
check("4 harfli token kalir", [...tokenize("test rapor")], ["test", "rapor"])
check("3 harfli token elenir", [...tokenize("abc rapor")], ["rapor"])
check("3 haneli rakam da elenir", [...tokenize("rapor 123")], ["rapor"])
check("STOPWORD 'olan' elenir", [...tokenize("rapor olan")], ["rapor"])
check("STOPWORD 'için' elenir", [...tokenize("için rapor")], ["rapor"])
check("STOPWORD 'than' elenir", [...tokenize("rapor than")], ["rapor"])
check("buyuk harf kucultur (Turkce U)", [...tokenize("GÜNLÜK")], ["günlük"])
check("buyuk harf kucultur (Turkce S/I)", [...tokenize("ŞİMDİ")], ["şimdi"])
check("noktalama ayirici", [...tokenize("rapor, duzen.")], ["rapor", "duzen"])
check("karmasi: buyuk + stopword + kisa", [...tokenize("GÜNLÜK Rapor olan xyz")].sort(), ["günlük", "rapor"])

console.log("")
console.log("=== TEMIZLIK ===")
for (const dir of geciciler) rmSync(dir, { recursive: true, force: true })
check("gecici dizinler silindi", geciciler.filter((d) => existsSync(d)).length, 0)

console.log("")
console.log("SONUC: " + pass + " gecti, " + fail + " kaldi")
process.exit(fail === 0 ? 0 : 1)
