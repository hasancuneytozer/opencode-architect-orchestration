/**
 * ORCHESTRA görev defteri + bütçe — durum makinesi, yazma yüzeyi kesişimi,
 * döngüsel bağımlılık, kanıt zorunluluğu, kalıcılık, rol kapısı.
 *
 * Çalıştırma:
 *   node --experimental-strip-types --experimental-transform-types \
 *        --no-warnings .opencode/scripts/tasks.test.mjs
 *
 * Bu dosya `.opencode/scripts/loop.test.mjs` YANINA ek gelir; ona dokunmaz.
 * (package.json'a ekleme işi mimarındır.)
 *
 * ÖNEMLİ: testler ASLA depodaki gerçek `.opencode/memory/` dizinine dokunmaz.
 * Her bölüm kendi `mkdtempSync(tmpdir()+"/orchestra-tasks-…")` dizinini açar,
 * sonda hepsi silinir.
 *
 * YÜKLEME: `memory.ts` parametre özelliği kullandığı için
 * `--experimental-transform-types` zorunludur. `tasks.ts` strip-only
 * yüklenebilirdir ama test, `tools.ts`'in onu DEĞER olarak import ettiği
 * zinciri de çalıştırdığı için aynı bayraklarla çalışır.
 *
 * İSİMLİ İMPORT YOK: `tasks.ts` bu turda yeni export'lar kazandı. İsimli import
 * kullanılsaydı ESKİ kodda dosya link hatasıyla ölür ve hangi kontrolün
 * kırıldığı görünmezdi (bkz. loop.test.mjs başlığı). Namespace import +
 * `yeni()` yardımcısı kullanılır.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as hafizaMod from "../plugins/orchestra/memory.ts"
import * as gorev from "../plugins/orchestra/tasks.ts"
import * as araclar from "../plugins/orchestra/tools.ts"

const { Memory } = hafizaMod
/** Yeni export eski kodda yoktur; kontrol bunu "KALDI" olarak raporlar. */
const yeni = (isim) => (typeof gorev[isim] === "function" ? gorev[isim] : gorev[isim])

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
const checkDogru = (name, kosul) => check(name, kosul === true, true)
const checkYok = (name, kosul) => check(name, kosul === false, false)

/** Bölüm çökerse de dosya sonuna kadar çalışsın. */
const bolum = async (baslik, fn) => {
  console.log("")
  console.log("=== " + baslik + " ===")
  try {
    await fn()
  } catch (error) {
    fail++
    console.log("  KALDI  " + baslik + " bolumu coktu: " + (error instanceof Error ? error.stack : String(error)))
  }
}

const geciciler = []
const geciciDizin = (etiket) => {
  const dir = mkdtempSync(join(tmpdir(), "orchestra-tasks-" + etiket + "-"))
  geciciler.push(dir)
  return dir
}
const okunur = (dosya) => readFileSync(dosya, "utf8")
const statePath = (dir) => join(dir, "state.json")

/** Görev kaydı üretir (saf, diske dokunmaz). */
const kayit = (ek = {}) => ({
  id: "P1",
  title: "ornek",
  dependsOn: [],
  writeSurface: [],
  acceptance: "test gecer",
  status: "planned",
  evidence: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...ek,
})

/** Sahte opencode bağlamı: `location` + `tool.transform` kayıt toplayıcı. */
const sahteCtx = (dizin = "") => {
  let editor = null
  const ctx = {
    location: { directory: dizin },
    tool: {
      transform: (fn) => {
        editor = { namespace: () => undefined, add: (t) => (editor[t.name] = t) }
        fn(editor)
        return Promise.resolve()
      },
    },
  }
  return { ctx, editor: () => editor }
}

// ---------------------------------------------------------------------------
// 1. DURUM MAKİNESİ (saf)
// ---------------------------------------------------------------------------

await bolum("1. DURUM MAKİNESİ", async () => {
  const canTransition = yeni("canTransition")
  check("durum listesi tam", gorev.TASK_STATUSES.slice(), ["planned", "running", "verifying", "done", "blocked", "failed"])

  check("planned -> running", canTransition("planned", "running"), true)
  check("running -> verifying", canTransition("running", "verifying"), true)
  check("verifying -> done", canTransition("verifying", "done"), true)
  check("verifying -> running (reddetildi)", canTransition("verifying", "running"), true)
  check("planned -> blocked", canTransition("planned", "blocked"), true)
  check("running -> failed", canTransition("running", "failed"), true)

  // Çekirdek zorlama: kanıtsız bitirme yolu YOK.
  check("planned -> done REDDEDILIR", canTransition("planned", "done"), false)
  check("planned -> verifying REDDEDILIR", canTransition("planned", "verifying"), false)
  check("running -> done REDDEDILIR", canTransition("running", "done"), false)
  check("done -> done REDDEDILIR", canTransition("done", "done"), false)
  check("blocked -> running REDDEDILIR", canTransition("blocked", "running"), false)
  check("failed -> running REDDEDILIR", canTransition("failed", "running"), false)
  check("bitis halleri kalici", [gorev.isTerminal("done"), gorev.isTerminal("blocked"), gorev.isTerminal("failed")], [true, true, true])
  check("ara haller kalici degil", [gorev.isTerminal("planned"), gorev.isTerminal("running"), gorev.isTerminal("verifying")], [false, false, false])

  const isTaskStatus = yeni("isTaskStatus")
  check("gecerli durum", isTaskStatus("running"), true)
  check("gecersiz durum reddedilir", isTaskStatus("finished"), false)
  check("sayi reddedilir", isTaskStatus(3), false)

  const nextTaskId = yeni("nextTaskId")
  check("ilk kimlik P1", nextTaskId([]), "P1")
  check("sayac devam eder", nextTaskId([kayit({ id: "P1" }), kayit({ id: "P7" })]), "P8")
  check("sayisiz kimlikler sayaci bozmaz", nextTaskId([kayit({ id: "eski" }), kayit({ id: "P2" })]), "P3")
})

// ---------------------------------------------------------------------------
// 2. YAZMA YUZEYI KESISIMI (saf)
// ---------------------------------------------------------------------------

await bolum("2. YAZMA YUZEYI KESISIMI", async () => {
  const kesisiyor = yeni("surfacesIntersect")
  const normalize = yeni("normalizeSurface")

  // Tam yol kümesi alt yollari kapsar.
  check("src/ ile src/a.ts KESISIR", kesisiyor("src/", "src/a.ts"), true)
  check("src ile src/a.ts KESISIR", kesisiyor("src", "src/a.ts"), true)
  check("yol, kendisiyle kesisir", kesisiyor("src/a.ts", "src/a.ts"), true)
  check("farkli dosyalar KESISMEZ", kesisiyor("src/a.ts", "tests/a.ts"), false)
  check("komsu klasorler KESISMEZ", kesisiyor("src", "srcfoo"), false)
  check("oneki olan baska yol KESISMEZ", kesisiyor("src/a.ts", "src/a.ts.bak"), false)

  // Joker desenler.
  check("src/* ile src/a.ts KESISIR", kesisiyor("src/*", "src/a.ts"), true)
  check("src/*.ts ile src/a.ts KESISIR", kesisiyor("src/*.ts", "src/a.ts"), true)
  check("src/* ile tests/a.ts KESISMEZ", kesisiyor("src/*", "tests/a.ts"), false)
  check("joker her seyi kapsar", kesisiyor("*", "src/a.ts"), true)
  check("iki jokerli uzak desen KESISMEZ", kesisiyor("src/*.ts", "tests/**/*.ts"), false)
  check("joker ile ust dizin KESISIR", kesisiyor("src/*", "src"), true)

  // Windows yol normalizasyonu.
  check("ters eğik çizgi normalize edilir", kesisiyor("src\\a.ts", "src/a.ts"), true)
  check("nokta öneki atılır", kesisiyor(".\\src\\a.ts", "src/a.ts"), true)
  check("çift ayraç tekilleşir", kesisiyor("src//a.ts", "src/a.ts"), true)
  check("üst dizin çözülür", kesisiyor("src/lib/../a.ts", "src/a.ts"), true)
  check("sürücü harfi HER platformda küçük harfe iner", normalize("C:\\Proj\\src").startsWith("c:/"), true)
  // Harf duyarlılığı artık ÇALIŞAN PLATFORMUN KURALIDIR (tasks.ts: WINDOWS_YOL_SEMANTIGI).
  const WIN = process.platform === "win32"
  check("platform kuralı export ediliyor", gorev.WINDOWS_YOL_SEMANTIGI, WIN)
  check("sürücü + büyük harf: Windows'ta aynı, POSIX'te farklı", normalize("C:\\Proj\\SRC") === normalize("c:\\proj\\src"), WIN)
  check("göreli yolda da aynı kural", normalize("SRC/a.ts") === normalize("src/A.ts"), WIN)
  check("ters eğik çizgi + üst dizin", normalize("src\\lib\\..\\a.ts"), "src/a.ts")
  check("normalize sondaki eğik çizgiyi siler", normalize("src/"), "src")
  check("normalize boş girdi", normalize("   "), "")
  check("joker tespiti", gorev.isWildcardSurface("src/*"), true)
  check("jokersiz yol joker sayilmaz", gorev.isWildcardSurface("src/a.ts"), false)
})

// ---------------------------------------------------------------------------
// 3. CAKISMA TESPITI (saf)
// ---------------------------------------------------------------------------

await bolum("3. CAKISMA TESPITI (yalniz TESPIT, engel degil)", async () => {
  const findConflicts = yeni("findConflicts")
  const kosan = [
    kayit({ id: "P1", status: "running", writeSurface: ["src/"] }),
    kayit({ id: "P2", status: "running", writeSurface: ["src/a.ts"] }),
    kayit({ id: "P3", status: "running", writeSurface: ["docs/x.md"] }),
  ]
  const bulunan = findConflicts(kosan)
  check("tek çakışma bulundu", bulunan.length, 1)
  check("çakışan çift P1-P2", [bulunan[0].a, bulunan[0].b], ["P1", "P2"])
  check("kesişen yüzey raporlandı", bulunan[0].surface, "src")
  check("yalnız bir görev sorulursa aynı sonuç", findConflicts(kosan, "P2").length, 1)
  check("ilgisiz görev için boş", findConflicts(kosan, "P3").length, 0)

  // Yalnız `running` görevler karşılaştırılır.
  const yarim = [
    kayit({ id: "P1", status: "planned", writeSurface: ["src/"] }),
    kayit({ id: "P2", status: "running", writeSurface: ["src/a.ts"] }),
  ]
  check("planned görev çakışma üretmez", findConflicts(yarim).length, 0)

  // AYNI kesişen yüzey iki kez geçiyorsa çift kayıt üretilmez (anahtar
  // normalize yüzey + görev çiftidir), ama FARKLI iki kesişen yüzey iki kayıt
  // olarak raporlanır: hangi dosyanın çakıştığını bilmek gerekir.
  const cift = [
    kayit({ id: "P1", status: "running", writeSurface: ["src/a.ts"] }),
    kayit({ id: "P2", status: "running", writeSurface: ["src/a.ts", "src/a.ts"] }),
  ]
  check("ayni yuzey iki kez geçse tek kayıt", findConflicts(cift).length, 1)
  const ikiYuzey = [
    kayit({ id: "P1", status: "running", writeSurface: ["src/", "src/a.ts"] }),
    kayit({ id: "P2", status: "running", writeSurface: ["src/a.ts"] }),
  ]
  check("farkli iki kesişen yüzey iki kayıt", findConflicts(ikiYuzey).map((c) => c.surface).sort(), ["src", "src/a.ts"])
})

// ---------------------------------------------------------------------------
// 4. DONGUSEL BAGIMLILIK (saf)
// ---------------------------------------------------------------------------

await bolum("4. DONGUSEL BAGIMLILIK", async () => {
  const detectCycle = yeni("detectCycle")
  check("A->B->A DONGSU BULUNUR", detectCycle({ A: ["B"], B: ["A"] }, "A"), ["A", "B", "A"])
  check("A->B->C zinciri dongusuz", detectCycle({ A: ["B"], B: ["C"], C: [] }, "A"), undefined)
  check("ters yonlu dongu de bulunur", detectCycle({ A: ["B"], B: ["A"] }, "B"), ["B", "A", "B"])
  check("kendi kendine baglanti", detectCycle({ A: ["A"] }, "A"), ["A", "A"])
  check("uc dugunlu dongu", detectCycle({ A: ["B"], B: ["C"], C: ["A"] }, "A"), ["A", "B", "C", "A"])
  check("havada kalan kenar sorun degil", detectCycle({ A: [], B: ["A"] }, "B"), undefined)

  // Girdi HARİTASI MUTASYONA UĞRAMAZ (saflık).
  const harita = { A: ["B"], B: [] }
  detectCycle(harita, "A")
  check("girdi haritasi degismedi", harita, { A: ["B"], B: [] })

  const graph = yeni("dependencyGraph")
  const cizge = graph([kayit({ id: "P1", dependsOn: ["P0"] })])
  check("komsuluk haritasi kurulur", cizge.P1, ["P0"])
  check("bagimsiz gorev bos liste", graph([kayit({ id: "P2" })]).P2, [])
})

// ---------------------------------------------------------------------------
// 5. BUTCE (saf)
// ---------------------------------------------------------------------------

await bolum("5. BUTCE", async () => {
  const overflow = yeni("budgetOverflow")
  const config = { maxWallClockMs: 1000, maxIterations: 5, maxConcurrentTasks: 2, maxTasksPerGoal: 200 }
  const temiz = { startedAt: 0, iterations: 0, tasks: 0 }
  const pro = (ek) => overflow({ config, state: temiz, running: 0, now: 100, ...ek })

  check("sınır altında aşım yok", pro({}), [])
  // SÖZLEŞME: probe POST-INCREMENT GERÇEK DEĞERLERİ ölçer; "bir tane daha
  // olacak" varsayımı (yeniGorev/yeniIterasyon) YOKTUR. Aynı sayacı hem
  // post-increment sayaçla hem varsayımla saymak sınırda YANLIŞ aşım üretiyordu.
  check("limit tam sınırda aşım DEĞİL", overflow({ config, state: { ...temiz, iterations: 5 }, running: 0, now: 100 }), [])
  check("limit + 1 aşım", overflow({ config, state: { ...temiz, iterations: 6 }, running: 0, now: 100 })[0].axis, "iterations")
  check("eski varsayım alanı ÇİFT SAYMAZ", overflow({ config, state: { ...temiz, iterations: 5 }, running: 2, now: 100, yeniGorev: true, yeniIterasyon: true }), [])

  // Duvar saati: sayaç başlamadan aşım üretilmez (yeni hedef eskisi sayılmaz).
  check("sayaç başlamadan duvar saati ölçülmez", overflow({ config, state: temiz, running: 0, now: 999_999 }), [])
  const duvar = overflow({ config, state: { ...temiz, startedAt: 100 }, running: 0, now: 1200 })
  check("duvar saati aşımı", duvar[0].axis, "wallclock")
  check("duvar saati gerçek değeri", duvar[0].actual, 1100)

  // Eşzamanlılık: `running` DENETİMDEN SONRAKİ koşan sayıdır (çağıran
  // hesaplar). `planned` görev koşmaz: görev AÇILIŞI bu ekseni artırmaz.
  check("eşzamanlılık sınırda", pro({ running: 2 }), [])
  const es = overflow({ config, state: temiz, running: 3, now: 100 })
  check("eşzamanlılık aşımı", es[0].axis, "concurrency")
  check("eşzamanlılık gerçeği", es[0].actual, 3)
  check("eşzamanlılık limitte KAPALI (0)", overflow({ config: { ...config, maxConcurrentTasks: 0 }, state: temiz, running: 99, now: 100 }), [])

  // maxTasksPerGoal budalamayı tetikler.
  check("görev sayısı sınır altında", pro({ state: { ...temiz, tasks: 199 } }), [])
  check("görev sayısı tam sınırda aşım DEĞİL", pro({ state: { ...temiz, tasks: 200 } }), [])
  const adet = overflow({ config, state: { ...temiz, tasks: 201 }, running: 0, now: 100 })
  check("görev sayısı sınır+1 aşımı", adet[0].axis, "taskCount")
  checkDogru("görev sayısı gerekçesi budamayı söyler", adet[0].reason.includes("budandı"))

  // BudgetTracker: durum sayacı.
  const Tracker = gorev.BudgetTracker
  const t = new Tracker()
  t.start(1_000)
  t.start(5_000) // ikinci start sayacı sıfırlamaz
  check("sayac ilk start'ta sabitlendi", t.state.startedAt, 1_000)
  t.countIteration()
  t.countTask()
  t.countTask()
  check("iterasyon sayaci", t.state.iterations, 1)
  check("görev sayaci", t.state.tasks, 2)
  check("temiz bütçede aşım yok", t.probe(config, 0, 1_500), [])
  // Tracker de aynı sözleşmeyi ölçer: sayaç post-increment, tavan tam sınırda aşım DEĞİL.
  check("tracker: tam sınırda aşım yok", new Tracker({ iterations: 5 }).probe(config, 0, 1_500), [])
  check("tracker: sınır+1 aşımı", new Tracker({ iterations: 6 }).probe(config, 0, 1_500)[0].axis, "iterations")
  check("tracker durumu KOPYA döner", Tracker.from(t.state).state, { startedAt: 1_000, iterations: 1, tasks: 2 })
  check("bozuk durum savunmacı", Tracker.from({ startedAt: "x", iterations: -4 }).state, { startedAt: 0, iterations: 0, tasks: 0 })

  check("varsayilan bütçe 4 saat", gorev.DEFAULT_BUDGET.maxWallClockMs, 14_400_000)
  check("varsayilan es zamanli", gorev.DEFAULT_BUDGET.maxConcurrentTasks, 8)
  check("varsayilan gorev tavani", gorev.DEFAULT_BUDGET.maxTasksPerGoal, 200)
})

// ---------------------------------------------------------------------------
// 6. BUDALAMA (saf)
// ---------------------------------------------------------------------------

await bolum("6. BUDALAMA (MAX_STORED_TASKS)", async () => {
  const prune = yeni("pruneTasks")
  check("tavan değişken", gorev.MAX_STORED_TASKS, 300)

  const eski = kayit({ id: "old", status: "done", updatedAt: "2020-01-01T00:00:00.000Z" })
  const yeniKayit = kayit({ id: "now", status: "running", updatedAt: "2030-01-01T00:00:00.000Z" })
  const sonuc = prune([eski, yeniKayit], 1)
  check("done görev önce atılır", sonuc.map((t) => t.id), ["now"])
  check("koşan görev KORUNUR", prune([yeniKayit, kayit({ id: "b", status: "planned" })], 1).map((t) => t.id), ["now"])
  check("sınır altında dokunulmaz", prune([yeniKayit], 5).length, 1)
  check("sınır sıfırsa hepsi düşer", prune([eski, yeniKayit], 0).length, 0)
  check("atılacak aday yoksa dokunulmaz", prune([kayit({ id: "a", status: "running" }), kayit({ id: "b", status: "running" })], 2, "now").length, 2)
  check("keepId ASLA atılmaz", prune([kayit({ id: "now", status: "running" }), kayit({ id: "b", status: "running" })], 1, "now").map((t) => t.id), ["now"])

  const sirali = [
    kayit({ id: "a", status: "done", updatedAt: "2030-01-01T00:00:00.000Z" }),
    kayit({ id: "b", status: "failed", updatedAt: "2020-01-01T00:00:00.000Z" }),
    kayit({ id: "c", status: "verifying", updatedAt: "2020-01-01T00:00:00.000Z" }),
  ]
  check("öncelik sırası: failed > verifying", prune(sirali, 2).map((t) => t.id).sort(), ["b", "c"])
  check("girdi dizisi degismedi", sirali.map((t) => t.id), ["a", "b", "c"])
})

// ---------------------------------------------------------------------------
// 7. KALICILIK (state.json)
// ---------------------------------------------------------------------------

await bolum("7. KALICILIK VE OTURUM AYRIMI", async () => {
  const dir = geciciDizin("kalicilik")
  const m = await Memory.open(dir)

  check("yoksa bos yuva", m.getTaskVault("A").tasks, [])
  check("yoksa bos butce", m.getTaskVault("A").budget, { startedAt: 0, iterations: 0, tasks: 0 })

  await m.setTaskVault("A", { tasks: [kayit({ id: "P1", sessionID: "A" })], budget: { startedAt: 7, iterations: 2, tasks: 1 } })
  await m.setTaskVault("B", { tasks: [kayit({ id: "P9", sessionID: "B" })], budget: { startedAt: 9, iterations: 0, tasks: 1 } })

  check("A kendi gorevini goruyor", m.getTaskVault("A").tasks[0].id, "P1")
  check("A butcesi A'nin", m.getTaskVault("A").budget.startedAt, 7)
  check("B kendi gorevini goruyor", m.getTaskVault("B").tasks[0].id, "P9")
  check("iki oturum birbirinin gorevini GORMUYOR", m.getTaskVault("A").tasks.length, 1)
  check("B butcesi A'nin degil", m.getTaskVault("B").budget.startedAt, 9)

  const disk = JSON.parse(okunur(statePath(dir)))
  check("diskte oturumlu yuva var", typeof disk.taskVaults, "object")
  check("diskte iki ayri oturum", Object.keys(disk.taskVaults).sort(), ["A", "B"])
  check("geriye uyum yuvasi (loop) duruyor", typeof disk.loop, "object")

  // Yeniden acilis: yeni ornek ayni dosyayi okur.
  const m2 = await Memory.open(dir)
  check("yeniden acilista gorevler okundu", m2.getTaskVault("A").tasks[0].id, "P1")
  check("yeniden acilista butce okundu", m2.getTaskVault("A").budget.iterations, 2)

  // Bozuk yuva savunmacı: kimliksiz kayıt düşer, bozuk alanlar düzelir.
  // Dikkat: `state.json` ELLE EZİLDİĞİ için B yuvası da gider — kayıp bir hata
  // değil, kullanıcının yaptığı değişikliktir. Ölçtüğümüz A'nın dayanıklılığı.
  await fsYaz(dir, { taskVaults: { A: { tasks: [{ id: "", title: "kimliksiz" }, { id: "P2", status: 7, writeSurface: "yol", dependsOn: null }], budget: { startedAt: "x" } } } })
  const m3 = await Memory.open(dir)
  check("kimliksiz kayit ATILDI", m3.getTaskVault("A").tasks.length, 1)
  check("bozuk dizi alanı bos diziye dustu", m3.getTaskVault("A").tasks[0].writeSurface, [])
  check("bozuk butce alani 0 oldu", m3.getTaskVault("A").budget, { startedAt: 0, iterations: 0, tasks: 0 })
  check("ellenen dosyada B yuvası yok", m3.getTaskVault("B").tasks, [])

  // Bozuk TUM dosya karantinaya gider (memory.ts'in kendi yolu).
  const bozukDir = geciciDizin("bozuk")
  writeFileSync(statePath(bozukDir), "{bu gecerli JSON degil", "utf8")
  const m4 = await Memory.open(bozukDir)
  check("bozuk dosyada uyari var", (m4.health() ?? "").includes("state.json"), true)
  check("bozuk dosyada yuva bos", m4.getTaskVault("A").tasks, [])
})

async function fsYaz(dir, govde) {
  const { promises: fs } = await import("node:fs")
  await fs.writeFile(statePath(dir), JSON.stringify(govde), "utf8")
}

// ---------------------------------------------------------------------------
// 8. DEFTER UCUNDAN UCA (durum makinesi + kanit + bagimlilik)
// ---------------------------------------------------------------------------

await bolum("8. DEFTER UCUNDAN UCA", async () => {
  const TaskLedger = gorev.TaskLedger
  if (typeof TaskLedger?.open !== "function") {
    check("TaskLedger.open export VAR", "yok", "var")
    return
  }

  // 8a. Kanit zorunlulugu + kabul kriteri.
  {
    const dir = geciciDizin("kanit")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    const acilis = await d.add({ title: "Paket", acceptance: "npm test yesil", writeSurface: ["src/"] })
    check("görev açıldı", acilis.ok, true)
    check("kimlik P1", acilis.task.id, "P1")
    check("varsayilan durum planned", acilis.task.status, "planned")

    check("planned -> done reddi", (await d.update({ id: "P1", status: "done", evidence: ["x"] })).ok, false)
    const gecen = await d.update({ id: "P1", status: "running" })
    check("running'e gecti", gecen.task.status, "running")
    check("startedAt yazildi", typeof gecen.task.startedAt, "string")
    check("running -> done reddi", (await d.update({ id: "P1", status: "done" })).ok, false)
    const kanitsiz = await d.update({ id: "P1", status: "verifying" })
    check("verifying'e gecti", kanitsiz.task.status, "verifying")
    const kanitsizSon = await d.update({ id: "P1", status: "done" })
    check("kanitsiz done REDDEDILDI", kanitsizSon.ok, false)
    checkDogru("gerekce kanit eksikligini soyluyor", kanitsizSon.error.includes("kanıt yok"))
    check("durum done'a degismedi", d.get("P1").status, "verifying")
    const kanitli = await d.update({ id: "P1", status: "done", evidence: ["npm test: 25 gecti"] })
    check("kanitli done KABUL EDILDI", kanitli.task.status, "done")
    check("finishedAt yazildi", typeof kanitli.task.finishedAt, "string")
    check("kanit kaydedildi", d.get("P1").evidence, ["npm test: 25 gecti"])
    check("bitmis gorev yeniden acilamaz", (await d.update({ id: "P1", status: "running" })).ok, false)
    check("bilinmeyen id reddi", (await d.update({ id: "P99", status: "running" })).ok, false)
    checkDogru("bilinmeyen id gerekcesi", (await d.update({ id: "P99", status: "running" })).error.includes("bilinmeyen görev"))
  }

  // 8b. Kabul kriteri bosken done reddi.
  {
    const dir = geciciDizin("kabul")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    await d.add({ title: "Kriteri yok" })
    await d.update({ id: "P1", status: "running" })
    await d.update({ id: "P1", status: "verifying" })
    const sonuc = await d.update({ id: "P1", status: "done", evidence: ["test ok"] })
    check("kabul kriteri yoksa done reddi", sonuc.ok, false)
    checkDogru("gerekce kabul kriterini soyluyor", sonuc.error.includes("kabul kriteri"))
    // REDDEDİLEN GÜNCELLEME HİÇBİR ŞEY YAZMAZ: kanıt, reddedilen çağrıyla
    // geldiği için düşer. Kanıt ayrı bir çağrıda eklenmelidir.
    check("reddedilen cagri kaniti da YAZMADI", d.get("P1").evidence, [])
    await d.update({ id: "P1", evidence: ["test ok"] })
    check("kanit ayri cagriyla eklendi", d.get("P1").evidence, ["test ok"])
    await d.update({ id: "P1", acceptance: "test yesil" })
    check("kriter eklendi", d.get("P1").acceptance, "test yesil")
    check("kriter eklendi", (await d.update({ id: "P1", status: "done" })).ok, true)
  }

  // 8c. Bagimlilik sirasi: P1 bitmeden P2 calisamaz.
  {
    const dir = geciciDizin("bagimlilik")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    await d.add({ title: "Sema", acceptance: "a" })
    await d.add({ title: "Uygulama", dependsOn: ["P1"], acceptance: "b" })
    const red = await d.update({ id: "P2", status: "running" })
    check("bitmemis bagimlilikla running REDDEDILDI", red.ok, false)
    checkDogru("gerekce bagimligi adıyla soyluyor", red.error.includes("P1 (planned)"))
    check("P2 durumu degismedi", d.get("P2").status, "planned")
    await d.update({ id: "P1", status: "running" })
    await d.update({ id: "P1", status: "verifying" })
    await d.update({ id: "P1", status: "done", evidence: ["ok"] })
    check("bagimlik bitince running serbest", (await d.update({ id: "P2", status: "running" })).ok, true)
  }

  // 8d. Dongusel bagimlilik reddi (A->B->A).
  {
    const dir = geciciDizin("dongu")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    await d.add({ title: "A", dependsOn: ["P2"] })
    const sonuc = await d.add({ title: "B", dependsOn: ["P1"] })
    check("A->B->A dongusu REDDEDILDI", sonuc.ok, false)
    checkDogru("gerekce dongu yolunu gosteriyor", sonuc.error.includes("P2 → P1 → P2"))
    check("B eklenmedi", d.list().length, 1)
    const uyari = await d.add({ title: "C", dependsOn: ["P99"] })
    check("ileri bagimlilik KABUL edilir", uyari.ok, true)
    checkDogru("eksik bagimlilik UYARI olarak bildirildi", uyari.notes.some((n) => n.metin.includes("EKSİK BAĞIMLILIK")))
  }

  // 8e. Yazma yuzeyi cakismasi TESPIT edilir, ENGELLEMEZ.
  {
    const dir = geciciDizin("cakisma")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    await d.add({ title: "A", writeSurface: ["src/"] })
    await d.update({ id: "P1", status: "running" })
    const ikinci = await d.add({ title: "B", writeSurface: ["src/a.ts"] })
    check("cakisma tespit edilir", ikinci.notes.some((n) => n.metin.includes("ÇAKIŞMA")), true)
    checkDogru("tespit engelleMEZ", ikinci.ok, true)
    const ikinciKosu = await d.update({ id: "P2", status: "running" })
    check("ikinci kosus da baslar", ikinciKosu.task.status, "running")
    check("kosanlar defterde", d.conflicts().length, 1)
    checkDogru("gerekce karisar mi diye soruyor", ikinciKosu.notes.some((n) => n.metin.includes("ENGELLEMEZ")))
  }

  // 8f. Kalicilik: yeniden acilan ornek ayni gorevleri goruyor.
  {
    const dir = geciciDizin("yeniden")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    await d.add({ title: "Kalici paket", acceptance: "a" })
    await d.update({ id: "P1", status: "running" })
    const d2 = await TaskLedger.open(m, undefined, "S")
    check("yeniden acilan defter gorevi goruyor", d2.get("P1").title, "Kalici paket")
    check("durum da korunuyor", d2.get("P1").status, "running")
    check("butce sayaci korunuyor", d2.defter().budget.iterations, 1)
    const yabanci = await TaskLedger.open(m, undefined, "B")
    check("baska oturumun defteri BOS", yabanci.list().length, 0)
    checkDogru("baska oturumun defterinde P1 yok", yabanci.get("P1") === undefined)
  }

  // 8g. Basliksiz gorev reddi.
  {
    const dir = geciciDizin("baslik")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    const sonuc = await d.add({ title: "   " })
    check("basliksiz gorev reddi", sonuc.ok, false)
    checkDogru("gerekce baslik istiyor", sonuc.error.includes("başlığı"))
  }
})

// ---------------------------------------------------------------------------
// 9. YAPILANDIRMA (canli okuma)
// ---------------------------------------------------------------------------

await bolum("9. BUTCE YAPILANDIRMASI", async () => {
  const load = yeni("loadBudgetConfig")
  check("kok verilmezse varsayilan", (await load(undefined)).maxConcurrentTasks, gorev.DEFAULT_BUDGET.maxConcurrentTasks)
  const kok = geciciDizin("yapilandirma")
  check("dosya yoksa varsayilan", (await load(kok)).maxIterations, gorev.DEFAULT_BUDGET.maxIterations)

  mkdirSync(join(kok, ".opencode"), { recursive: true })
  const yaz = (govde) => writeFileSync(join(kok, ".opencode", "orchestra.json"), typeof govde === "string" ? govde : JSON.stringify(govde), "utf8")
  yaz("{bozuk")
  check("bozuk yapilandirma varsayilana duser", (await load(kok)).maxTasksPerGoal, gorev.DEFAULT_BUDGET.maxTasksPerGoal)
  yaz({ capture: { scanTools: ["shell"] } })
  check("budget blogu yoksa varsayilan", (await load(kok)).maxWallClockMs, gorev.DEFAULT_BUDGET.maxWallClockMs)
  yaz({ budget: { maxWallClockMs: 1000, maxIterations: 3, maxConcurrentTasks: 2, maxTasksPerGoal: 9 } })
  const ayar = await load(kok)
  check("maxWallClockMs okundu", ayar.maxWallClockMs, 1000)
  check("maxIterations okundu", ayar.maxIterations, 3)
  check("maxConcurrentTasks okundu", ayar.maxConcurrentTasks, 2)
  check("maxTasksPerGoal okundu", ayar.maxTasksPerGoal, 9)
  yaz({ budget: { maxIterations: "cok", maxConcurrentTasks: -1 } })
  const bozuk = await load(kok)
  check("tip hatasi varsayilana duser", bozuk.maxIterations, gorev.DEFAULT_BUDGET.maxIterations)
  check("negatif deger varsayilana duser", bozuk.maxConcurrentTasks, gorev.DEFAULT_BUDGET.maxConcurrentTasks)

  // Depodaki GERCEK yapilandirma da okunabilir ve sözleşmeyi tutar.
  const gercek = await load(join(process.cwd(), ".."))
  check("depodaki budget blogu okunuyor", gercek.maxTasksPerGoal, 200)
})

// ---------------------------------------------------------------------------
// 10. ARAÇLAR: ROL KAPISI + CIKTI
// ---------------------------------------------------------------------------

await bolum("10. orchestra_task / orchestra_status", async () => {
  const dir = geciciDizin("arac")
  const m = await Memory.open(dir)
  const { ctx, editor } = sahteCtx(dir)
  await araclar.registerTools(ctx, m)
  const task = editor().task
  const status = editor().status
  checkDogru("orchestra_task kayitli", !!task)
  checkDogru("orchestra_status kayitli", !!status)
  if (!task || !status) return

  const mimar = { agent: "architect", sessionID: "S" }
  const isci = { agent: "coder", sessionID: "S" }

  // Rol kapisi.
  const red = await task.execute({ title: "isci denemesi" }, isci)
  checkDogru("alt ajan reddedildi", red.content.includes("HATA"))
  checkDogru("gerekce reddedildigini soyluyor", red.content.includes("YAZILMADI"))
  check("alt ajan HICBIR SEY yazmadi", m.getTaskVault("S").tasks.length, 0)

  const acilis = await task.execute({ title: "Tasarim", acceptance: "typecheck yesil", writeSurface: ["src/"] }, mimar)
  checkDogru("mimar gorev acabiliyor", acilis.content.includes("Görev açıldı: P1"))
  check("gorev yazildi", m.getTaskVault("S").tasks.length, 1)
  checkDogru("yuzey araci ciktisinda", acilis.content.includes("src/"))

  const gecersiz = await task.execute({ id: "P1", status: "done" }, mimar)
  checkDogru("gecersiz gecis aracidan da reddediliyor", gecersiz.content.includes("HATA"))

  await task.execute({ id: "P1", status: "running" }, mimar)
  await task.execute({ id: "P1", status: "verifying" }, mimar)
  const kanit = await task.execute({ id: "P1", status: "done", evidence: ["npm test: 25 gecti"] }, mimar)
  checkDogru("kanitli done kabul", kanit.content.includes("[done]"))
  checkDogru("kanit ciktida gorunuyor", kanit.content.includes("kanıt (1)"))

  // Status her rolde okunur.
  const ozet = await status.execute({}, isci)
  checkDogru("status basligi", ozet.content.includes("ORCHESTRA GÖREV DEFTERİ"))
  checkDogru("status butceyi gosteriyor", ozet.content.includes("Bütçe:"))
  checkDogru("status gorevi listeliyor", ozet.content.includes("P1 [done]"))
  const butce = await status.execute({ section: "budget" }, isci)
  check("butce bolumu tek satir", butce.content.split("\n").length, 1)
  const cakisma = await status.execute({ section: "conflicts" }, isci)
  checkDogru("cakisma yoksa acikca soyluyor", cakisma.content.includes("çakışması yok"))

  // Cikti HATA ile baslamayan bir red olmamali: V2'de hata metinden okunur.
  const bilinmeyen = await task.execute({ id: "P42", status: "running" }, mimar)
  checkDogru("bilinmeyen id ciktisi HATA ile basliyor", bilinmeyen.content.startsWith("HATA"))
})

// ---------------------------------------------------------------------------
// 11. YAZMA YÜZEYİ SÖZLEŞMESİ (planned değilken daraltma YOK) + ATOMİK RET
// ---------------------------------------------------------------------------

await bolum("11. YAZMA YUZEYI SOZLESMESI", async () => {
  const TaskLedger = gorev.TaskLedger
  const normalize = yeni("normalizeSurface")
  const kesisiyor = yeni("surfacesIntersect")
  const findConflicts = yeni("findConflicts")
  const WIN = process.platform === "win32"

  // 11a. ÖLÇÜLEN KUSUR: denetim UZUNLUKTU. `[a,b] -> [c,d]` "daha az yol"
  // sayılmıyordu, yani çakışan yüzey sessizce siliniyordu.
  {
    const dir = geciciDizin("yuzey-esit")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    await d.add({ title: "A", writeSurface: ["src/a.ts", "src/b.ts"] })
    await d.update({ id: "P1", status: "running" })
    const red = await d.update({ id: "P1", writeSurface: ["docs/x.md", "docs/y.md"] })
    check("EŞİT uzunlukta değişim REDDEDİLDİ", red.ok, false)
    checkDogru("gerekçe HATA ile başlıyor", red.error.startsWith("HATA"))
    checkDogru("gerekçe eksik yolları ADIYLA sayıyor", red.error.includes("src/a.ts") && red.error.includes("src/b.ts"))
    check("yüzey DEĞİŞMEDİ", d.get("P1").writeSurface, ["src/a.ts", "src/b.ts"])
  }

  // 11b. Uzun listeden çıkarma, tam boşaltma, ve "daha geniş glob" muhtaresi.
  {
    const dir = geciciDizin("yuzey-uzun")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    await d.add({ title: "A", writeSurface: ["src/a.ts", "src/b.ts", "src/c.ts"] })
    await d.update({ id: "P1", status: "running" })

    const bir = await d.update({ id: "P1", writeSurface: ["src/a.ts", "src/c.ts"] })
    check("uzun listeden BİR yol çıkarılamaz", bir.ok, false)
    checkDogru("gerekçe çıkan yolu adıyla sayıyor", bir.error.includes("src/b.ts"))
    check("yüzey üç yol olarak duruyor", d.get("P1").writeSurface, ["src/a.ts", "src/b.ts", "src/c.ts"])

    const bos = await d.update({ id: "P1", writeSurface: [] })
    check("yüzeyi boşaltma REDDEDİLDİ", bos.ok, false)
    check("boşaltma yüzeyi silmedi", d.get("P1").writeSurface.length, 3)

    // Daha geniş glob eski LITERAL kaydın yerini TUTMAZ: beyan bulanıklaştı.
    const glob = await d.update({ id: "P1", writeSurface: ["src/*"] })
    check("daha geniş glob eski literalı temsil etmiyor", glob.ok, false)
    checkDogru("gerekçe eksik literalı adıyla sayıyor", glob.error.includes("src/a.ts"))

    // GEÇERLİ genişletme: eklemek serbesttir.
    const genis = await d.update({ id: "P1", writeSurface: ["src/a.ts", "src/b.ts", "src/c.ts", "docs/x.md"] })
    check("geçerli genişletme KABUL EDİLDİ", genis.ok, true)
    check("yüzey dört yola çıktı", genis.task.writeSurface, ["src/a.ts", "src/b.ts", "src/c.ts", "docs/x.md"])
    check("genişleme diskte de", (await Memory.open(dir)).getTaskVault("S").tasks[0].writeSurface.length, 4)
  }

  // 11c. `planned` DEĞİLSE kilit, `planned`'ken serbest düzenleme.
  {
    const dir = geciciDizin("yuzey-planned")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    await d.add({ title: "A", writeSurface: ["src/a.ts", "src/b.ts", "src/c.ts"] })
    check("görev planned açıldı", d.get("P1").status, "planned")
    const daralt = await d.update({ id: "P1", writeSurface: ["src/a.ts"] })
    check("planned daraltma KABUL EDİLDİ", daralt.ok, true)
    check("planned yüzey değişti", daralt.task.writeSurface, ["src/a.ts"])
    const bos = await d.update({ id: "P1", writeSurface: [] })
    check("planned boşaltma da KABUL EDİLDİ", bos.ok, true)
    check("planned boşaltma uygulandı", bos.task.writeSurface, [])

    // Başladıktan sonra aynı kapı KİLİTLENİR.
    await d.update({ id: "P1", writeSurface: ["src/a.ts", "src/b.ts"] })
    await d.update({ id: "P1", status: "running" })
    check("running'den sonra daraltma reddedildi", (await d.update({ id: "P1", writeSurface: ["src/a.ts"] })).ok, false)
    check("running'de yüzey iki yol", d.get("P1").writeSurface, ["src/a.ts", "src/b.ts"])
    // Doğrulama aşamasında da kilit kalır (dosya hâlâ düzeltiliyor olabilir).
    await d.update({ id: "P1", status: "verifying" })
    check("verifying'de de daraltma reddedildi", (await d.update({ id: "P1", writeSurface: ["src/b.ts"] })).ok, false)
  }

  // 11d. RET ATOMİKTİR: aynı çağrıdaki kanıt/başlık/rol/kriter/durum/bütçe
  // YAZILMAZ — bellekte de, diskte de. (Eski kod yüzeyi reddederken kanıtı yazıyordu.)
  {
    const dir = geciciDizin("yuzey-atomik")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    await d.add({ title: "Orijinal baslik", writeSurface: ["src/a.ts", "src/b.ts"] })
    await d.update({ id: "P1", status: "running" })
    const butceOnce = d.defter().budget.iterations
    const diskOnce = JSON.parse(okunur(statePath(dir))).taskVaults.S.tasks[0]

    const red = await d.update({
      id: "P1",
      evidence: ["npm test: 25 geçti"],
      title: "Değişen başlık",
      role: "coder",
      acceptance: "yeni kriter",
      writeSurface: ["docs/x.md"],
      status: "verifying",
    })
    check("atomik ret: ok:false", red.ok, false)
    check("ret: başlık değişmedi", d.get("P1").title, "Orijinal baslik")
    check("ret: kanıt YAZILMADI", d.get("P1").evidence, [])
    check("ret: rol değişmedi", d.get("P1").role, undefined)
    check("ret: kabul kriteri değişmedi", d.get("P1").acceptance, "")
    check("ret: durum değişmedi", d.get("P1").status, "running")
    check("ret: yüzey değişmedi", d.get("P1").writeSurface, ["src/a.ts", "src/b.ts"])
    check("ret: bütçe sayacı değişmedi", d.defter().budget.iterations, butceOnce)
    check("ret: updatedAt ilerlemedi", d.get("P1").updatedAt === diskOnce.updatedAt, true)

    const diskSonra = JSON.parse(okunur(statePath(dir))).taskVaults.S.tasks[0]
    check("ret: DİSKTE kanıt yok", diskSonra.evidence, [])
    check("ret: diskte başlık aynı", diskSonra.title, "Orijinal baslik")
    check("ret: diskte durum aynı", diskSonra.status, "running")
    check("ret: diskte yüzey aynı", diskSonra.writeSurface, ["src/a.ts", "src/b.ts"])
    const yeniden = await Memory.open(dir)
    check("ret: yeniden açılışta da temiz", yeniden.getTaskVault("S").tasks[0].evidence, [])
    check("ret: yeniden açılışta bütçe aynı", yeniden.getTaskVault("S").budget.iterations, butceOnce)

    // Ret KALICI bir kilit değil: aynı alanlar ayrı çağrıda yazılabilir.
    const sonra = await d.update({ id: "P1", evidence: ["test ok"], title: "Yeni başlık" })
    check("ret sonrası aynı alanlar yazılabiliyor", [sonra.ok, sonra.task.evidence, sonra.task.title], [true, ["test ok"], "Yeni başlık"])
    check("yüzey hâlâ iki yol", d.get("P1").writeSurface, ["src/a.ts", "src/b.ts"])
  }

  // 11e. `verifying` görev de çakışma hesabına girer (dosya hâlâ değişebilir).
  {
    check(
      "saf: verifying görev çakışma üretir",
      findConflicts([
        kayit({ id: "P1", status: "running", writeSurface: ["src/"] }),
        kayit({ id: "P2", status: "verifying", writeSurface: ["src/a.ts"] }),
      ]).length,
      1,
    )

    const dir = geciciDizin("verifying-cakisma")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    await d.add({ title: "A", writeSurface: ["src/"] })
    await d.update({ id: "P1", status: "running" })
    await d.add({ title: "B", writeSurface: ["src/a.ts"] })
    await d.update({ id: "P2", status: "running" })
    await d.update({ id: "P2", status: "verifying" })

    const ucuncu = await d.add({ title: "C", writeSurface: ["src/a.ts"] })
    check("açılış uyarısı verifying'i de görüyor", ucuncu.notes.some((n) => n.metin.includes("P2 (verifying)")), true)
    checkDogru("açılış uyarısı yine engellemiyor", ucuncu.ok, true)

    const baslat = await d.update({ id: "P3", status: "running" })
    checkDogru("start uyarısı verifying'li görevi adıyla sayıyor", baslat.notes.some((n) => n.metin.includes("ÇAKIŞMA") && n.metin.includes("P2")))
    checkDogru("tespit ENGELLEMEZ", baslat.ok, true)
    check("durum çıktısı verifying çakışmasını gösteriyor", d.status().some((s) => s.includes("ÇAKIŞMA") && s.includes("P2 ↔ P3")), true)
  }

  // 11f. Platform semantiği: backslash her yerde, harf duyarlılığı platforma bağlı.
  {
    check("ters eğik çizgi her platformda aynı yüzey", kesisiyor("src\\a.ts", "src/a.ts"), true)
    check("büyük/küçük harf platform kuralına uyar", kesisiyor("SRC/a.ts", "src/A.ts"), WIN)
    check("sürücü + büyük harf platform kuralına uyar", kesisiyor("C:\\Proj\\A.ts", "c:/proj/a.ts"), WIN)
    check("normalize aynı yolu aynı yazıyor", normalize("C:\\Proj\\A.ts") === normalize("c:/proj/a.ts"), WIN)

    const dir = geciciDizin("yuzey-platform")
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, undefined, "S")
    await d.add({ title: "W", writeSurface: ["C:\\Proj\\A.ts"] })
    await d.update({ id: "P1", status: "running" })
    // Normalleştirilmiş hâli AYNI olan yol koşarken değiştirilebilir.
    const ayniYol = await d.update({ id: "P1", writeSurface: ["c:/proj/a.ts", "docs/x.md"] })
    check("normalleştirilmiş hâli aynı yol: platforma göre", ayniYol.ok, WIN)
    // FARKLI yol her platformda reddedilir.
    const farkli = await d.update({ id: "P1", writeSurface: ["docs/x.md"] })
    check("farklı yol HER platformda reddedilir", farkli.ok, false)
    check("red sonrası yüzey korundu", farkli.ok === false && d.get("P1").writeSurface.length >= 1, true)
  }
})

// ---------------------------------------------------------------------------
// 12. ARAÇ KATMANI: yüzey reddi araç çıktısında da HATA olarak görünür
// ---------------------------------------------------------------------------

await bolum("12. ARAC KATMANINDA YUZEY REDDI", async () => {
  const dir = geciciDizin("arac-yuzey")
  const m = await Memory.open(dir)
  const { ctx, editor } = sahteCtx(dir)
  await araclar.registerTools(ctx, m)
  const task = editor().task
  if (!task) {
    check("orchestra_task kayıtlı", "yok", "var")
    return
  }
  const mimar = { agent: "architect", sessionID: "S" }
  await task.execute({ title: "Paket", writeSurface: ["src/a.ts", "src/b.ts"] }, mimar)
  await task.execute({ id: "P1", status: "running" }, mimar)
  const red = await task.execute({ id: "P1", writeSurface: ["docs/x.md"], evidence: ["kanıt"] }, mimar)
  checkDogru("araç çıktısı HATA ile başlıyor", red.content.startsWith("HATA"))
  checkDogru("araç çıktısı eksik yolu söylüyor", red.content.includes("src/a.ts"))
  check("reddedilen çağrı diske yazmadı", m.getTaskVault("S").tasks[0].evidence, [])
  check("görev koşmaya devam ediyor", m.getTaskVault("S").tasks[0].status, "running")
})

// ---------------------------------------------------------------------------
// 13. BÜTÇE SINIRI UÇTAN UCA (tam sınır = aşım YOK, +1 = aşım)
// ---------------------------------------------------------------------------

/** Bütçe bloğu yazan geçici dizin: `loadBudgetConfig` canlı buradan okur. */
const budgetDizin = (etiket, budget) => {
  const dir = geciciDizin(etiket)
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "orchestra.json"), JSON.stringify({ budget }), "utf8")
  return dir
}

await bolum("13. BUTCE SINIRI UCTAN UCA", async () => {
  const TaskLedger = gorev.TaskLedger

  // 13a. İş adımı: tam sınırda aşım YOK, sınır+1'de aşım.
  {
    const dir = budgetDizin("limit-adim", { maxWallClockMs: 0, maxIterations: 2, maxConcurrentTasks: 8, maxTasksPerGoal: 50 })
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, dir, "S")
    const ekseni = (r) => r.overflow.filter((o) => o.axis === "iterations")
    await d.add({ title: "P1", acceptance: "a" })
    await d.add({ title: "P2", acceptance: "a" })
    await d.add({ title: "P3", acceptance: "a" })
    check("1. adım: aşım yok", ekseni(await d.update({ id: "P1", status: "running" })), [])
    await d.update({ id: "P1", status: "verifying" })
    await d.update({ id: "P1", status: "done", evidence: ["ok"] })
    check("2. adım (tam sınır): aşım YOK", ekseni(await d.update({ id: "P2", status: "running" })), [])
    await d.update({ id: "P2", status: "verifying" })
    await d.update({ id: "P2", status: "done", evidence: ["ok"] })
    const ucuncu = await d.update({ id: "P3", status: "running" })
    check("3. adım (sınır+1): aşım VAR", ekseni(ucuncu).map((o) => o.actual), [3])
    check("adım sayacı gerçekten ilerledi", d.defter().budget.iterations, 3)
  }

  // 13b. Görev sayısı: tam sınırda aşım YOK + `planned → running` SAYMAZ.
  {
    const dir = budgetDizin("limit-gorev", { maxWallClockMs: 0, maxIterations: 50, maxConcurrentTasks: 8, maxTasksPerGoal: 2 })
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, dir, "S")
    const ekseni = (r) => r.overflow.filter((o) => o.axis === "taskCount")
    check("1. görev: aşım yok", ekseni(await d.add({ title: "P1", acceptance: "a" })), [])
    check("2. görev (tam sınır): aşım YOK", ekseni(await d.add({ title: "P2", acceptance: "a" })), [])
    check("görev sayacı iki", d.defter().budget.tasks, 2)
    // ÖLÇÜLEN KUSUR: `planned → running` yeni görev AÇMAZ; eski kodu `yeniGorev`
    // görev sayısını da bir artırıyordu, yani tavana dayanmış bir defter İLK
    // çalıştırmada yanlış görev sayısı aşımı görüyordu.
    const baslat = await d.update({ id: "P1", status: "running" })
    check("planned→running görev sayısını ARTIRMAZ", ekseni(baslat), [])
    const ucuncu = await d.add({ title: "P3", acceptance: "a" })
    check("3. görev (sınır+1): aşım VAR", ekseni(ucuncu).map((o) => o.actual), [3])
    check("görev sayacı üç", d.defter().budget.tasks, 3)
  }

  // 13c. Eşzamanlılık: `planned` açılışı koşan sayıyı ARTIRMAZ.
  {
    const dir = budgetDizin("limit-eszamanli", { maxWallClockMs: 0, maxIterations: 50, maxConcurrentTasks: 2, maxTasksPerGoal: 50 })
    const m = await Memory.open(dir)
    const d = await TaskLedger.open(m, dir, "S")
    const ekseni = (r) => r.overflow.filter((o) => o.axis === "concurrency")
    await d.add({ title: "P1", acceptance: "a" })
    await d.add({ title: "P2", acceptance: "a" })
    check("1. koşu: aşım yok", ekseni(await d.update({ id: "P1", status: "running" })), [])
    check("2. koşu (tam sınır): aşım YOK", ekseni(await d.update({ id: "P2", status: "running" })), [])
    // ÖLÇÜLEN KUSUR: `add` görevi `planned` açar, koşmaz; eski kodu koşan
    // sayıya da 1 ekliyordu → tavana dayanmış bir defter her açılışta YANLIŞ
    // eşzamanlılık aşımı görüyordu.
    const ucuncu = await d.add({ title: "P3", acceptance: "a" })
    check("planlı açılış eşzamanlılığı ARTIRMAZ", ekseni(ucuncu), [])
    check("koşan sayısı değişmedi", d.running().length, 2)
    const baslat = await d.update({ id: "P3", status: "running" })
    check("3. koşu (sınır+1): aşım VAR", ekseni(baslat).map((o) => o.actual), [3])
    checkDogru("aşım modele BÜTÇE notu olarak gidiyor", baslat.notes.some((n) => n.metin.includes("BÜTÇE")))
  }
})

// ---------------------------------------------------------------------------

console.log("")
console.log("=== TEMIZLIK ===")
for (const dir of geciciler) rmSync(dir, { recursive: true, force: true })
check("gecici dizinler silindi", geciciler.filter((d) => existsSync(d)).length, 0)

console.log("")
console.log("SONUC: " + pass + " gecti, " + fail + " kaldi")
process.exit(fail === 0 ? 0 : 1)