/**
 * ORCHESTRA otonom döngüsü — oturum ayrımı, gerçek iptal, bütçe, rapor tazeliği.
 *
 * Çalıştırma:
 *   node --experimental-strip-types --experimental-transform-types \
 *        .opencode/scripts/loop.test.mjs
 *
 * Bu dosya `.opencode/scripts/memory.test.mjs` (96) ve
 * `.opencode/scripts/memory-durability.test.mjs` (101) YANINA ek gelir;
 * onlara dokunmaz.
 *
 * Kapsam: `loop.ts` (döngü mantığı) + `tools.ts` (`orchestra_report` aracı) +
 * `memory.ts`'in OTURUMLU döngü/rapor yuvası.
 *
 * ÖNEMLİ: testler ASLA depodaki gerçek `.opencode/memory/` dizinine dokunmaz.
 * Her bölüm kendi `mkdtempSync(tmpdir()+"/orchestra-…")` dizinini açar, sonda
 * hepsi silinir.
 *
 * YÜKLEME: `memory.ts` parametre özelliği kullandığı için
 * `--experimental-transform-types` zorunludur (bkz. memory.test.mjs başlığı).
 *
 * İSİMLİ İMPORT YOK: `loop.ts` bu turda yeni export'lar kazandı (`runLoop`,
 * `parseArgs`, `loadLoopConfig`, `DEFAULT_LOOP_CONFIG`, `waitForIteration`).
 * İsimli import kullanılsaydı ESKİ kodda dosya link hatasıyla ölür ve hangi
 * kontrolün kırıldığı görünmezdi. Bu yüzden namespace import + `yeni()`
 * yardımcısı kullanılır; yoksa kontrol "KALDI" olarak raporlanır.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as hafizaMod from "../plugins/orchestra/memory.ts"
import * as dongu from "../plugins/orchestra/loop.ts"
import * as araclar from "../plugins/orchestra/tools.ts"

const { Memory } = hafizaMod
/** Yeni export eski kodda yoktur; kontrol bunu "KALDI" olarak raporlar. */
const yeni = (isim) => (typeof dongu[isim] === "function" ? dongu[isim] : null)

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

const bekle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  const dir = mkdtempSync(tmpdir() + "/orchestra-loop-" + etiket + "-")
  geciciler.push(dir)
  return dir
}
const okunur = (dosya) => readFileSync(dosya, "utf8")
const statePath = (dir) => join(dir, "state.json")

/** Süresiz asılı kalan bekleme: `Promise.race` kilitlemesin diye sınır koyarız. */
const sinirla = (soz, ms, etiket) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(etiket + ": " + ms + "ms icinde bitmedi")), ms)
    Promise.resolve(soz).then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })

/**
 * Sahte opencode bağlamı.
 *
 * `secenek.tur`: her `session.prompt` SONRASINDA çalışır; döngünün o turda
 * rapor verip vermeyeceğini burada belirleriz. `undefined` dönerse
 * `session.wait` hemen çözülür (iterasyon anında biter).
 * `secenek.wait`: özel bekleme (süresiz asılı kalmak dâhil).
 */
const sahteCtx = (memory, secenek = {}) => {
  const kayit = {
    promptlar: [],
    sentetik: [],
    interrupt: 0,
    ajanGecisleri: [],
    ajan: secenek.ajan ?? "mimar",
    tur: secenek.tur ?? (async () => undefined),
    wait: secenek.wait ?? null,
  }
  const ctx = {
    location: { directory: secenek.dizin ?? "" },
    session: {
      prompt: async (girdi) => {
        kayit.promptlar.push(girdi.text)
        await kayit.tur(memory, { ...girdi, sira: kayit.promptlar.length })
      },
      wait: (girdi) => (kayit.wait ? kayit.wait(girdi) : Promise.resolve()),
      synthetic: async (girdi) => {
        kayit.sentetik.push(girdi.text)
      },
      interrupt: async () => {
        kayit.interrupt += 1
      },
      get: async () => ({ agent: kayit.ajan }),
      switchAgent: async (girdi) => {
        kayit.ajanGecisleri.push(girdi.agent)
        kayit.ajan = girdi.agent
      },
    },
  }
  return { ctx, kayit }
}

/** Mimarinin bu tur verdiği rapor (araç yolunu taklit eder). */
const raporYaz = async (memory, sessionID, secenek = {}) => {
  const loop = memory.getLoop(sessionID)
  await memory.setReport({
    sessionID,
    runID: secenek.runID === undefined ? loop.runID : secenek.runID,
    status: secenek.status ?? "continue",
    summary: secenek.summary ?? `tur ${loop.iteration ?? 0}`,
    next: secenek.next ?? "siradaki",
    blockers: secenek.blockers ?? [],
    evidence: secenek.evidence ?? [],
    iteration: secenek.iteration === undefined ? (loop.iteration ?? 0) : secenek.iteration,
    at: new Date().toISOString(),
  })
}

const hizliConfig = (ek = {}) => ({ max: 3, idleTimeoutMs: 300, maxWallClockMs: 0, stopPollMs: 15, ...ek })

/** Koşul doğru olana kadar kısa aralıklarla bekler; süre aşılırsa reddeder. */
const kapiBasla = (kosul, ms = 3000) =>
  new Promise((resolve, reject) => {
    const baslangic = Date.now()
    const t = setInterval(() => {
      if (kosul()) {
        clearInterval(t)
        resolve(undefined)
      } else if (Date.now() - baslangic > ms) {
        clearInterval(t)
        reject(new Error("kosul " + ms + "ms icinde saglanmadi"))
      }
    }, 5)
  })

const sonMetin = (kayit) => kayit.sentetik[kayit.sentetik.length - 1] ?? ""

// ---------------------------------------------------------------------------
// 1. OTURUMLU DÖNGÜ/ RAPOR YUVASI (memory.ts)
// ---------------------------------------------------------------------------

await bolum("1. OTURUMLU DÖNGU/RAPOR YUVASI", async () => {
  const dir = geciciDizin("yuva")
  const m = await Memory.open(dir)

  await m.setLoop("ses_A", { status: "running", goal: "A hedefi", iteration: 2 })
  await m.setLoop("ses_B", { status: "running", goal: "B hedefi", iteration: 7 })

  check("A kendi hedefini goruyor", m.getLoop("ses_A").goal, "A hedefi")
  check("B kendi hedefini goruyor", m.getLoop("ses_B").goal, "B hedefi")
  check("A iterasyonu A'nin", m.getLoop("ses_A").iteration, 2)
  check("B iterasyonu B'nin", m.getLoop("ses_B").iteration, 7)
  check("kayitli olmayan oturum idle", m.getLoop("ses_C").status, "idle")
  check("kayitli olmayan oturum yalin (A'yi gormuyor)", Object.keys(m.getLoop("ses_C")).sort(), ["status"])
  check("oturumsuz yuva kirli degil", m.getLoop().status, "idle")

  await m.setReport({ sessionID: "ses_A", runID: "r1", status: "done", summary: "A bitti", iteration: 2, at: "2026-01-01T00:00:00.000Z" })
  check("A raporu A'da", m.getReport("ses_A").summary, "A bitti")
  check("B raporu YOK (A'nin raporu B'ye tasmadi)", m.getReport("ses_B"), undefined)
  check("oturumsuz rapor YOK", m.getReport(), undefined)

  await m.clearReport("ses_A")
  check("A raporu silindi", m.getReport("ses_A"), undefined)
  check("A dongusu silinmedi", m.getLoop("ses_A").goal, "A hedefi")
  check("B dongusu duruyor", m.getLoop("ses_B").goal, "B hedefi")

  const disk = JSON.parse(okunur(statePath(dir)))
  check("diskte oturum haritasi var", typeof disk.loops, "object")
  check("diskte iki oturum ayri", Object.keys(disk.loops).sort(), ["ses_A", "ses_B"])
  check("diskte oturum kimligi yazili", disk.loops.ses_A.sessionID, "ses_A")

  // Geriye uyum: oturumsuz yuva eski yazma yolunu bozmaz.
  await m.setLoop({ goal: "eski yol", status: "running" })
  check("tek arganli setLoop oturumsuz yuvaya yaziyor", JSON.parse(okunur(statePath(dir))).loop.goal, "eski yol")
  check("tek arganli setLoop donusu", m.getLoop().goal, "eski yol")
  check("oturumlu yuva etkilenmedi", m.getLoop("ses_B").goal, "B hedefi")
})

// ---------------------------------------------------------------------------
// 2. ESKI SEMA GECISI
// ---------------------------------------------------------------------------

await bolum("2. ESKI SEMADAN GECIS (veri silinmez)", async () => {
  const dir = geciciDizin("legacy")
  await fs.writeFile(
    statePath(dir),
    JSON.stringify({
      loop: { status: "running", sessionID: "ses_eski", goal: "eski hedef", iteration: 4 },
      report: { status: "continue", summary: "eski rapor", iteration: 4, at: "2026-01-01T00:00:00.000Z", sessionID: "ses_eski" },
    }),
    "utf8",
  )
  const m = await Memory.open(dir)
  check("eski loop oturum anahtarina tasindi", m.getLoop("ses_eski").goal, "eski hedef")
  check("eski loop oturumsuz yuvada da duruyor", m.getLoop().goal, "eski hedef")
  check("eski rapor oturum anahtarinda", m.getReport("ses_eski").summary, "eski rapor")
  const saglik = m.health() ?? ""
  check("eski sema UYARILDI", saglik.includes("eski şema"), true)

  await m.setDiagnostics({ startedAt: new Date().toISOString(), steps: { tools: "ok" } })
  await m.setLoop("ses_eski", { iteration: 5 })
  const sonSaglik = m.health() ?? ""
  check("ilk yazimdan sonra eski sema uyarisi SONDU", sonSaglik.includes("eski şema"), false)
  check("eski veri yazimdan sonra da duruyor", m.getLoop("ses_eski").goal, "eski hedef")

  const bozukDizin = geciciDizin("legacy2")
  await fs.writeFile(statePath(bozukDizin), "{bu gecerli JSON degil", "utf8")
  const m2 = await Memory.open(bozukDizin)
  check("bozuk dosyada uyari YOK (belirsiz sema)", (m2.health() ?? "").includes("eski şema"), false)
  check("bozuk dosyada oturumlu yuva idle", m2.getLoop("x").status, "idle")
})

// ---------------------------------------------------------------------------
// 3. orchestra_report OTURUMA YAZAR (tools.ts)
// ---------------------------------------------------------------------------

await bolum("3. orchestra_report OTURUMA YAZAR", async () => {
  const dir = geciciDizin("rapor")
  const m = await Memory.open(dir)
  await m.setLoop("ses_A", { runID: "rA", status: "running", iteration: 1 })
  await m.setLoop("ses_B", { runID: "rB", status: "running", iteration: 5 })

  let editor = null
  const ctx = {
    tool: {
      transform: (fn) => {
        editor = { namespace: () => undefined, add: (t) => (editor[t.name] = t) }
        fn(editor)
        return Promise.resolve()
      },
    },
  }
  await araclar.registerTools(ctx, m)
  const rapor = editor.report
  checkDogru("orchestra_report kayitli", !!rapor)

  const c = await rapor.execute({ status: "done", summary: "A TAMAM" }, { agent: "architect", sessionID: "ses_A" })
  checkDogru("A cagrisi raporladi", c.content.includes("iterasyon 1"))
  check("A raporu A oturumunda", m.getReport("ses_A").summary, "A TAMAM")
  check("A raporunun runID'si A dongusunden", m.getReport("ses_A").runID, "rA")
  check("B raporu etkilenmedi", m.getReport("ses_B"), undefined)

  await rapor.execute({ status: "continue", summary: "B devam" }, { agent: "architect", sessionID: "ses_B" })
  check("B raporunun iterasyonu B'den", m.getReport("ses_B").iteration, 5)
  check("B runID'si B dongusunden", m.getReport("ses_B").runID, "rB")
  check("A raporu B tarafından EZILMEDI", m.getReport("ses_A").summary, "A TAMAM")

  // Rol kapisi duruyor mu?
  await rapor.execute({ status: "done", summary: "isci mudahi" }, { agent: "coder", sessionID: "ses_C" })
  check("isci rolunun raporu YAZILMADI", m.getReport("ses_C"), undefined)
  const bozuk = await rapor.execute({ status: "bitmedi", summary: "x" }, { agent: "architect", sessionID: "ses_A" })
  checkDogru("gecersiz status reddedildi", bozuk.content.includes("HATA"))
})

// ---------------------------------------------------------------------------
// 4. BAYAT RAPOR YENI TURDA "TAZE" SAYILMAZ
// ---------------------------------------------------------------------------

await bolum("4. BAYAT RAPOR YENI TURDA TASIMAZ", async () => {
  const runLoop = yeni("runLoop")
  if (!runLoop) {
    check("runLoop export VAR", "yok", "var")
    return
  }

  // 4a. 1. tur rapor verir, 2. ve 3. tur VERMEZ -> "2 tur rapor vermedi".
  {
    const dir = geciciDizin("bayat")
    const m = await Memory.open(dir)
    const { ctx, kayit } = sahteCtx(m, {
      tur: async (mm, { sira }) => {
        if (sira === 1) await raporYaz(mm, "ses_X", { summary: "birinci tur" })
      },
    })
    await sinirla(runLoop(ctx, m, { sessionID: "ses_X", prompt: "hedef" }, { config: hizliConfig({ max: 4 }) }), 4000, "bayat dongu")
    check("2 tur rapor verilmedigi icin durdu", kayit.sentetik.join("\n").includes("raporunu vermedi"), true)
    check("bayat rapor sayesinde dongu dongusuz bitmedi", m.getLoop("ses_X").status, "exhausted")
    check("bitis nedeni rapor eksikligi", (m.getLoop("ses_X").stopReason ?? "").includes("raporunu vermedi"), true)
    check("tam olarak 3 tur yurutuldu", kayit.promptlar.length, 3)
  }

  // 4b. Onceki turun raporu bu calistirmaya tasmaz.
  {
    const dir = geciciDizin("calistirma")
    const m = await Memory.open(dir)
    await m.setReport({ sessionID: "ses_Y", runID: "eski-run", status: "done", summary: "eski", iteration: 9, at: "2026-01-01T00:00:00.000Z" })
    const { ctx, kayit } = sahteCtx(m, { tur: async () => undefined })
    await sinirla(runLoop(ctx, m, { sessionID: "ses_Y", prompt: "hedef" }, { config: hizliConfig({ max: 2 }) }), 4000, "calistirma dongu")
    check("onceki calistirmanin raporu KAPATMADI", (m.getLoop("ses_Y").stopReason ?? "").includes("raporunu vermedi"), true)
    check("dongu done degil exhausted", m.getLoop("ses_Y").status, "exhausted")
  }

  // 4c. runID eslesmeyen rapor kapatiyor mu? (yeni kod: hayir)
  {
    const dir = geciciDizin("runid")
    const m = await Memory.open(dir)
    const { ctx, kayit } = sahteCtx(m, {
      tur: async (mm, { sira }) => {
        if (sira === 1) await raporYaz(mm, "ses_Z", { status: "done", summary: "baska calistirma", runID: "run-baska" })
      },
    })
    await sinirla(runLoop(ctx, m, { sessionID: "ses_Z", prompt: "hedef" }, { config: hizliConfig({ max: 2 }) }), 4000, "runid dongu")
    check("runID uymayan rapor donguyu kapattirmadi", m.getLoop("ses_Z").status, "exhausted")
    checkDogru("tamamlandi mesaji YOK", !kayit.sentetik.join("\n").includes("Döngü tamamlandı"))
  }

  // 4d. Bu turun raporu dogru ise dongu kapanir (pozitif kontrol).
  {
    const dir = geciciDizin("dogru")
    const m = await Memory.open(dir)
    const { ctx, kayit } = sahteCtx(m, {
      tur: async (mm, { sira }) => {
        if (sira === 1) await raporYaz(mm, "ses_D", { status: "done", summary: "hedef bitti" })
      },
    })
    await sinirla(runLoop(ctx, m, { sessionID: "ses_D", prompt: "hedef" }, { config: hizliConfig({ max: 3 }) }), 4000, "dogru dongu")
    check("dogru rapor donguyu kapatti", m.getLoop("ses_D").status, "done")
    checkDogru("tamamlandi mesaji var", kayit.sentetik.join("\n").includes("Döngü tamamlandı"))
  }

  // 4e. Ilerleme yoksupa: ayni ozet/kanit 2 kez -> exhausted.
  {
    const dir = geciciDizin("ayni")
    const m = await Memory.open(dir)
    const { ctx } = sahteCtx(m, {
      tur: async (mm, { sira }) => {
        await raporYaz(mm, "ses_E", { summary: "ayni sonuc", evidence: ["test 1"] })
      },
    })
    await sinirla(runLoop(ctx, m, { sessionID: "ses_E", prompt: "hedef" }, { config: hizliConfig({ max: 5 }) }), 4000, "ayni dongu")
    check("ayni kanit -> exhausted", m.getLoop("ses_E").status, "exhausted")
    checkDogru("bitis nedeni ilerleme yok", (m.getLoop("ses_E").stopReason ?? "").includes("ilerleme yok"))
  }
})

// ---------------------------------------------------------------------------
// 5. /loop stop GERCEK IPTAL
// ---------------------------------------------------------------------------

await bolum("5. /loop stop GERCEK IPTAL", async () => {
  const runLoop = yeni("runLoop")
  if (!runLoop) {
    check("runLoop export VAR", "yok", "var")
    return
  }

  // 5a. Calisan donguyu `/loop stop` keser VE oturumu iptal eder.
  {
    const dir = geciciDizin("stop")
    const m = await Memory.open(dir)
    const { ctx, kayit } = sahteCtx(m, { wait: () => new Promise(() => undefined) })
    const dolasan = runLoop(ctx, m, { sessionID: "ses_S", prompt: "hedef" }, { config: hizliConfig({ max: 5, idleTimeoutMs: 60000 }) })
    await sinirla(kapiBasla(() => kayit.promptlar.length === 1), 3000, "dongu basladi")
    check("dongu gercekten calisiyor", kayit.promptlar.length, 1)
    await sinirla(runLoop(ctx, m, { sessionID: "ses_S", prompt: "stop" }, { config: hizliConfig() }), 2000, "stop komutu")
    check("stop durumu yazildi", m.getLoop("ses_S").status, "stopped")
    checkDogru("stop calisan oturumu IPTAL ETTI", kayit.interrupt >= 1)
    await sinirla(dolasan, 3000, "durdurulen dongu")
    check("dongu kontrollu bitti", kayit.promptlar.length, 1)
    check("bitis nedeni durdurma", (m.getLoop("ses_S").stopReason ?? "").includes("stop"), true)
  }

  // 5b. BASKA SURECTEN gelen stop gorunur: dis yazim sonrasi EK iterasyon yok.
  {
    const dir = geciciDizin("disstop")
    const m = await Memory.open(dir)
    const { ctx, kayit } = sahteCtx(m, {
      tur: async (mm) => {
        // Dis surecte yazan ikinci bir ornek (ayni state.json).
        const diger = await Memory.open(dir)
        await diger.setLoop("ses_D", { status: "stopped", stopReason: "diger surec durdurdu" })
      },
    })
    await sinirla(runLoop(ctx, m, { sessionID: "ses_D", prompt: "hedef" }, { config: hizliConfig({ max: 3 }) }), 4000, "dis stop dongu")
    check("dis stop goruldu", m.getLoop("ses_D").stopReason, "diger surec durdurdu")
    check("stop sonrasi EK iterasyon calismadi", kayit.promptlar.length, 1)
  }

  // 5c. Zaman asimi turu da iptal eder (onceden yalnizca sonraki turu etkiliyordu).
  {
    const dir = geciciDizin("asimi")
    const m = await Memory.open(dir)
    const { ctx, kayit } = sahteCtx(m, { wait: () => new Promise(() => undefined) })
    await sinirla(runLoop(ctx, m, { sessionID: "ses_T", prompt: "hedef" }, { config: hizliConfig({ max: 3, idleTimeoutMs: 40 }) }), 4000, "asim dongu")
    checkDogru("zaman asimi oturumu iptal etti", kayit.interrupt >= 1)
    checkDogru("bitis nedeni zaman asimi", sonMetin(kayit).includes("zaman aşımına uğradı"))
    check("zaman asiminda tek tur", kayit.promptlar.length, 1)
  }

  // 5d. session.wait reddederse kilitlenme: "idle" sayilip kontrollu cikilir.
  {
    const dir = geciciDizin("red")
    const m = await Memory.open(dir)
    const { ctx, kayit } = sahteCtx(m, { wait: () => Promise.reject(new Error("oturum kapandi")) })
    await sinirla(runLoop(ctx, m, { sessionID: "ses_R", prompt: "hedef" }, { config: hizliConfig({ max: 2 }) }), 4000, "red dongu")
    check("wait reddi donguyu kilitlemedi", m.getLoop("ses_R").status, "exhausted")
    checkDogru("bitis nedeni oturum kapanmasi", sonMetin(kayit).includes("kontrollü sonlandırıldı"))
    check("redden sonra tek tur", kayit.promptlar.length, 1)
  }
})

// ---------------------------------------------------------------------------
// 6. BUTCE: TOPLAM DUVAR SAATI TAVANI
// ---------------------------------------------------------------------------

await bolum("6. TOPLAM DUVAR SAATI TAVANI", async () => {
  const runLoop = yeni("runLoop")
  if (!runLoop) {
    check("runLoop export VAR", "yok", "var")
    return
  }
  const dir = geciciDizin("butce")
  const m = await Memory.open(dir)
  // Saat ENJEKTE edilir: gerçek duvar saati testi kırılgandır (disk yavaşken
  // 1. iterasyon bile tavanı geçebilirdi). Buradaki sözleşme: bütçe dolunca
  // döngü kontrollü kapanır ve oturum iptal edilir.
  let saat = 1_000
  const { ctx, kayit } = sahteCtx(m, {
    tur: async () => {
      saat += 10_000
    },
  })
  await sinirla(
    runLoop(ctx, m, { sessionID: "ses_B", prompt: "hedef" }, { now: () => saat, config: hizliConfig({ max: 50, maxWallClockMs: 3000 }) }),
    4000,
    "butce dongu",
  )
  check("tavan asilinda dongu kapandi", m.getLoop("ses_B").status, "exhausted")
  checkDogru("bitis nedeni sure tavani", (m.getLoop("ses_B").stopReason ?? "").includes("toplam süre tavanı"))
  checkDogru("tavan iptal ile birlikte geldi", kayit.interrupt >= 1)
  check("tavan 50 iterasyonda degil 1'de kesildi", kayit.promptlar.length, 1)
  check("dongu --max=50 aldi (yapilandirma max'i degil)", m.getLoop("ses_B").max, 50)

  // max verilmezse orchestra.json -> loop.max uygulanir.
  const dir2 = geciciDizin("butce2")
  const m2 = await Memory.open(dir2)
  const c2 = sahteCtx(m2, { tur: async () => undefined })
  await sinirla(runLoop(c2.ctx, m2, { sessionID: "ses_M", prompt: "hedef" }, { config: hizliConfig({ max: 7 }) }), 4000, "butce2 dongu")
  check("varsayilan max yapilandirmadan geldi", m2.getLoop("ses_M").max, 7)
})

// ---------------------------------------------------------------------------
// 7. ROL GERI YUKLENIR
// ---------------------------------------------------------------------------

await bolum("7. OTURUM ROLU GERI YUKLENIR", async () => {
  const runLoop = yeni("runLoop")
  if (!runLoop) {
    check("runLoop export VAR", "yok", "var")
    return
  }

  // 7a. done yolu
  {
    const dir = geciciDizin("rol1")
    const m = await Memory.open(dir)
    const { ctx, kayit } = sahteCtx(m, {
      ajan: "coder",
      tur: async (mm, { sira }) => {
        if (sira === 1) await raporYaz(mm, "ses_R1", { status: "done", summary: "bitti" })
      },
    })
    await sinirla(runLoop(ctx, m, { sessionID: "ses_R1", prompt: "hedef" }, { config: hizliConfig() }), 4000, "rol1 dongu")
    check("once mimar yapildi", kayit.ajanGecisleri[0], "architect")
    check("bitince eski rol geri yuklendi", kayit.ajanGecisleri[kayit.ajanGecisleri.length - 1], "coder")
    check("rol iki kez degisti", kayit.ajanGecisleri, ["architect", "coder"])
  }

  // 7b. Hata/erken cikis yolu: rol de finally icinde geri doner.
  {
    const dir = geciciDizin("rol2")
    const m = await Memory.open(dir)
    const { ctx, kayit } = sahteCtx(m, { ajan: "mimar2", wait: () => new Promise(() => undefined) })
    await sinirla(runLoop(ctx, m, { sessionID: "ses_R2", prompt: "hedef" }, { config: hizliConfig({ max: 2, idleTimeoutMs: 30 }) }), 4000, "rol2 dongu")
    check("zaman asiminda da rol geri dondu", kayit.ajanGecisleri, ["architect", "mimar2"])
  }

  // 7c. Rol okunamiyorsa dokunulmaz.
  {
    const dir = geciciDizin("rol3")
    const m = await Memory.open(dir)
    const { ctx, kayit } = sahteCtx(m, { ajan: undefined })
    ctx.session.get = async () => {
      throw new Error("oturum okunamadi")
    }
    await sinirla(runLoop(ctx, m, { sessionID: "ses_R3", prompt: "hedef" }, { config: hizliConfig({ max: 1 }) }), 4000, "rol3 dongu")
    check("rol okunamayinca hicbir gecis yapilmadi", kayit.ajanGecisleri, [])
  }
})

// ---------------------------------------------------------------------------
// 8. IKİ OTURUM BIRBIRININ DONGUSUNU EZMIYOR
// ---------------------------------------------------------------------------

await bolum("8. IKİ OTURUM BIRBIRININ DONGUSUNU EZMIYOR", async () => {
  const runLoop = yeni("runLoop")
  if (!runLoop) {
    check("runLoop export VAR", "yok", "var")
    return
  }
  const dir = geciciDizin("cift")
  const m = await Memory.open(dir)

  // A dongusu doner; B dongusu kendi raporunu bekleyip kapanir.
  // Bekleme KAPII ile denetlenir: `bekle(150)` gibi süreler yüklü makinede
  // belirsizdir ve testi kırılganlaştırıyordu.
  let ac = () => undefined
  const kapi = new Promise((resolve) => {
    ac = () => resolve(undefined)
  })
  const a = sahteCtx(m, { wait: () => new Promise(() => undefined) })
  const b = sahteCtx(m, { wait: () => kapi })
  const donguA = runLoop(a.ctx, m, { sessionID: "ses_A", prompt: "A hedefi" }, { config: hizliConfig({ max: 5, idleTimeoutMs: 60000 }) })
  const donguB = runLoop(b.ctx, m, { sessionID: "ses_B", prompt: "B hedefi" }, { config: hizliConfig({ max: 5, idleTimeoutMs: 60000 }) })
  await sinirla(kapiBasla(() => a.kayit.promptlar.length === 1 && b.kayit.promptlar.length === 1), 3000, "A ve B prompt gonderdi")

  check("A kendi hedefinde", m.getLoop("ses_A").goal, "A hedefi")
  check("B kendi hedefinde", m.getLoop("ses_B").goal, "B hedefi")
  check("A runID'si B'den farkli", m.getLoop("ses_A").runID !== m.getLoop("ses_B").runID, true)

  // B "done" bildiriyor -> yalnizca B kapanmali.
  await raporYaz(m, "ses_B", { status: "done", summary: "B bitti" })
  ac()
  await sinirla(donguB, 3000, "B dongusu")
  check("B done oldu", m.getLoop("ses_B").status, "done")
  check("A hala calisiyor", m.getLoop("ses_A").status, "running")
  check("A raporu B'ninkinden etkilenmedi", m.getReport("ses_A"), undefined)

  await runLoop(a.ctx, m, { sessionID: "ses_A", prompt: "stop" }, { config: hizliConfig() })
  await sinirla(donguA, 4000, "A dongusu")
  check("A de kendi stop'uyla kapandi", m.getLoop("ses_A").stopReason, "kullanıcı /loop stop çağırdı")
})

// ---------------------------------------------------------------------------
// 9. AYRI OTURUMUN RAPORU BU DONGUYU KAPATMAZ
// ---------------------------------------------------------------------------

await bolum("9. YABANCI RAPOR DONGUYU KAPATMAZ", async () => {
  const runLoop = yeni("runLoop")
  if (!runLoop) {
    check("runLoop export VAR", "yok", "var")
    return
  }
  const dir = geciciDizin("yabanci")
  const m = await Memory.open(dir)
  // 1. turda BASKI oturum "done" bildiriyor. Kendi oturumum rapor vermiyor.
  const { ctx, kayit } = sahteCtx(m, {
    tur: async (mm, { sira }) => {
      if (sira === 1) await raporYaz(mm, "ses_Baski", { status: "done", summary: "baski oturum bitti" })
    },
  })
  await sinirla(runLoop(ctx, m, { sessionID: "ses_Kendi", prompt: "hedef" }, { config: hizliConfig({ max: 3 }) }), 4000, "yabanci dongu")
  check("baski oturumun done raporu benim dongumu kapattirmadi", m.getLoop("ses_Kendi").status, "exhausted")
  checkDogru("bitis nedeni kendi raporumun eksikligi", (m.getLoop("ses_Kendi").stopReason ?? "").includes("raporunu vermedi"))
  checkDogru("baski raporu oldu yuvasinda duruyor", m.getReport("ses_Baski").summary === "baski oturum bitti")
  check("kendi rapor yuvam bos kaldi", m.getReport("ses_Kendi"), undefined)
})

// ---------------------------------------------------------------------------
// 10. PROMPT METNI
// ---------------------------------------------------------------------------

await bolum("10. ITERASYON PROMPT METNI", async () => {
  const build = yeni("buildIterationPrompt")
  const parse = yeni("parseArgs")
  if (!build || !parse) {
    check("buildIterationPrompt/parseArgs export VAR", "yok", "var")
    return
  }
  const metin = build({ goal: "hedef", iteration: 2, max: 5, stalled: 0 })
  checkDogru("dekoratif ORCHESTRA-STATUS satiri YOK", !metin.includes("ORCHESTRA-STATUS"))
  checkDogru("rapor araci zorunlu kiliyor", metin.includes("ZORUNLU"))
  checkDogru("rapor aracinin donguye bildirdigi yazili", metin.includes("Rapor aracı zaten bu turun durumunu döngüye bildirir"))
  checkDogru("iterasyon numarasi metinde", metin.includes("iterasyon 2/5"))

  const dikkat = build({ goal: "hedef", iteration: 3, max: 5, stalled: 2 })
  checkDogru("rapor yoksa uyari metni degisiyor", dikkat.includes("bu turun raporu gelmedi"))

  check("stop ayristirilir", parse("stop").action, "stop")
  check("status ayristirilir", parse("status").action, "status")
  check("run varsayilan", parse("hedefi yap").action, "run")
  check("--max okunur", parse("hedefi yap --max=7").max, 7)
  check("--max ust sinir", parse("hedefi yap --max=99").max, 50)
  check("--max alt sinir", parse("hedefi yap --max=0").max, 1)
  check("yabanci 'iterasyon' sayisi", parse("hedefi yap 4 iterasyon").max, 4)
  check("max verilmediginde belirtilmez (yapilandirma uygulanabilsin)", parse("hedefi yap").max, undefined)
  check("hedef metni korunur", parse("stop").goal, "")
})

// ---------------------------------------------------------------------------
// 11. YAPILANDIRMA (orchestra.json -> loop blogu)
// ---------------------------------------------------------------------------

await bolum("11. YAPILANDIRMA OKUMA YOLU", async () => {
  const load = yeni("loadLoopConfig")
  if (!load) {
    check("loadLoopConfig export VAR", "yok", "var")
    return
  }
  const kok = geciciDizin("yapilandirma")
  check("kok dizini verilmezse varsayilan", (await load(undefined)).maxWallClockMs, dongu.DEFAULT_LOOP_CONFIG.maxWallClockMs)
  check("dosya yoksa varsayilan", (await load(kok)).max, dongu.DEFAULT_LOOP_CONFIG.max)

  mkdirSync(join(kok, ".opencode"), { recursive: true })
  writeFileSync(join(kok, ".opencode", "orchestra.json"), "{bozuk", "utf8")
  check("bozuk yapilandirma varsayilana duser", (await load(kok)).idleTimeoutMs, dongu.DEFAULT_LOOP_CONFIG.idleTimeoutMs)

  writeFileSync(join(kok, ".opencode", "orchestra.json"), JSON.stringify({ capture: { scanTools: ["shell"] } }), "utf8")
  check("loop blogu yoksa varsayilan", (await load(kok)).max, dongu.DEFAULT_LOOP_CONFIG.max)

  writeFileSync(
    join(kok, ".opencode", "orchestra.json"),
    JSON.stringify({ loop: { max: 4, idleTimeoutMs: 1234, maxWallClockMs: 0, stopPollMs: 5 } }),
    "utf8",
  )
  const ayar = await load(kok)
  check("max okundu", ayar.max, 4)
  check("idleTimeoutMs okundu", ayar.idleTimeoutMs, 1234)
  check("maxWallClockMs=0 KAPALI", ayar.maxWallClockMs, 0)
  check("stopPollMs okundu (alt sinir 10)", ayar.stopPollMs, 10)

  writeFileSync(join(kok, ".opencode", "orchestra.json"), JSON.stringify({ loop: { max: "cok" } }), "utf8")
  check("tip hatasi varsayilana duser", (await load(kok)).max, dongu.DEFAULT_LOOP_CONFIG.max)

  // Yapilandirma gercekten donguye isler: config verilmediginde varsayilan
  // kullanilir ve dongu rapor yokluk supabina takilir (sahte sure 4 saat surer).
  const runLoop = yeni("runLoop")
  const dir = geciciDizin("yapilandirma2")
  const m = await Memory.open(dir)
  const { ctx, kayit } = sahteCtx(m, { tur: async () => undefined })
  await sinirla(runLoop(ctx, m, { sessionID: "ses_Cf", prompt: "hedef" }, {}), 4000, "yapilandirma dongu")
  check("varsayilan tavan 4 saat", dongu.DEFAULT_LOOP_CONFIG.maxWallClockMs, 4 * 60 * 60 * 1000)
  check("varsayilan max 10", dongu.DEFAULT_LOOP_CONFIG.max, 10)
  check("config verilmeden de dongu calisti", kayit.promptlar.length, 2)
  checkDogru("rapor yokluk supabi devreye girdi", sonMetin(kayit).includes("raporunu vermedi"))
})

// ---------------------------------------------------------------------------
// 12. /loop status VE TEKRAR KORUMASI
// ---------------------------------------------------------------------------

await bolum("12. /loop status VE TEKRAR KORUMASI", async () => {
  const runLoop = yeni("runLoop")
  if (!runLoop) {
    check("runLoop export VAR", "yok", "var")
    return
  }
  const dir = geciciDizin("status")
  const m = await Memory.open(dir)
  const { ctx, kayit } = sahteCtx(m, { ajan: "architect" })
  await sinirla(runLoop(ctx, m, { sessionID: "ses_St", prompt: "status" }, { config: hizliConfig() }), 2000, "status komutu")
  const metin = sonMetin(kayit)
  checkDogru("status basligi", metin.includes("ORCHESTRA DÖNGÜ DURUMU"))
  checkDogru("status oturumu gosteriyor", metin.includes("ses_St"))
  checkDogru("rapor yokken (yok) diyor", metin.includes("Son rapor: (yok)"))
  check("status prompt gondermedi", kayit.promptlar.length, 0)

  await runLoop(ctx, m, { sessionID: "ses_St", prompt: "stop" }, { config: hizliConfig() })
  checkDogru("stop cevabi var", sonMetin(kayit).includes("durduruldu"))

  // Bos hedef -> kullanim
  await runLoop(ctx, m, { sessionID: "ses_St", prompt: "   " }, { config: hizliConfig() })
  checkDogru("bos hedefte kullanim gosteriliyor", sonMetin(kayit).includes("Hedef boş"))

  // Ayni oturumda ikinci dongu reddedilir
  const dir2 = geciciDizin("tekrar")
  const m2 = await Memory.open(dir2)
  const c2 = sahteCtx(m2, { wait: () => new Promise(() => undefined) })
  const ilk = runLoop(c2.ctx, m2, { sessionID: "ses_1", prompt: "hedef" }, { config: hizliConfig({ max: 3, idleTimeoutMs: 60000 }) })
  await sinirla(kapiBasla(() => c2.kayit.promptlar.length === 1), 3000, "ilk dongu basladi")
  await runLoop(c2.ctx, m2, { sessionID: "ses_1", prompt: "baska hedef" }, { config: hizliConfig() })
  checkDogru("ayni oturumda ikinci dongu reddedildi", sonMetin(c2.kayit).includes("zaten bir döngü çalışıyor"))
  check("reddedilen dongu hedefi degistirmedi", m2.getLoop("ses_1").goal, "hedef")
  await runLoop(c2.ctx, m2, { sessionID: "ses_1", prompt: "stop" }, { config: hizliConfig() })
  await sinirla(ilk, 4000, "tekrar dongu")
})

// ---------------------------------------------------------------------------
// 13. blocked YOLU
// ---------------------------------------------------------------------------

await bolum("13. blocked YOLU", async () => {
  const runLoop = yeni("runLoop")
  if (!runLoop) {
    check("runLoop export VAR", "yok", "var")
    return
  }
  const dir = geciciDizin("blocked")
  const m = await Memory.open(dir)
  const { ctx, kayit } = sahteCtx(m, {
    tur: async (mm, { sira }) => {
      if (sira === 1) await raporYaz(mm, "ses_BK", { status: "blocked", summary: "karar gerekiyor", blockers: ["API anahtari yok"] })
    },
  })
  await sinirla(runLoop(ctx, m, { sessionID: "ses_BK", prompt: "hedef" }, { config: hizliConfig({ max: 3 }) }), 4000, "blocked dongu")
  check("durum blocked", m.getLoop("ses_BK").status, "blocked")
  const metin = sonMetin(kayit)
  checkDogru("engel mesajda listelendi", metin.includes("API anahtari yok"))
  check("tek tur yeter", kayit.promptlar.length, 1)
})

// ---------------------------------------------------------------------------

console.log("")
console.log("=== TEMIZLIK ===")
for (const dir of geciciler) rmSync(dir, { recursive: true, force: true })
check("gecici dizinler silindi", geciciler.filter((d) => existsSync(d)).length, 0)

console.log("")
console.log("SONUC: " + pass + " gecti, " + fail + " kaldi")
process.exit(fail === 0 ? 0 : 1)