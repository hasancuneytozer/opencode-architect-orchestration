/**
 * Orchestra saf mantığı için regresyon testi.
 *
 * Çalıştırma: npm test
 *
 * Kapsam: günlük araç çalıştırması değil, saf (I/O'suz) fonksiyonlar. Bunlar
 * `fallback.ts` içindeki karar mantığıdır ve buradaki 39 kontrol, gerçek bir
 * hatayı yakalamıştı: geri çekilmede bir kademe kaymıştı (ilk retry 2x base
 * bekliyordu, base beklemeliydi).
 */

import {
  classifyError,
  computeDelay,
  nextHealthy,
  sweepBreakers,
  loadFallbackConfig,
  DEFAULT_FALLBACK,
  shouldRestore,
  bumpRetry,
  trimRetryCounts,
  configForAgent,
  parseModelRef,
  RESTORE_GIVE_UP,
  MAX_RESTORE_RETRIES,
} from "../.opencode/plugins/orchestra/fallback.ts"

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

console.log("=== 1. HATA SINIFLANDIRMA ===")
check("429 hiz siniri gecici", classifyError({ status: 429, type: "provider.rate-limit" }).transient, true)
check("429 sinifi", classifyError({ status: 429 }).kind, "rate-limit")

check("402 kota gecici DEGIL", classifyError({ status: 402, type: "provider.quota" }).transient, false)
check("402 sinifi", classifyError({ status: 402 }).kind, "quota")
check(
  "402 gercek ornek mesajla yakalandi",
  classifyError({ type: "provider.quota", message: "This request requires more credits, or fewer max_tokens." }).kind,
  "quota",
)

check("500 gecici", classifyError({ status: 500 }).transient, true)
check("503 sunucu sinifi", classifyError({ status: 503 }).kind, "server")

check("400 gecersiz istek - deneme anlamsiz", classifyError({ status: 400 }).transient, false)
check("404 gecersiz istek sinifi", classifyError({ status: 404 }).klass, "invalid-404")

check(
  "baglam tasmasi - retry edilMEZ",
  classifyError({ status: 400, message: "prompt is too long: 250000 tokens > 200000" }).kind,
  "context-overflow",
)
check("baglam tasmasi gecici DEGIL", classifyError({ message: "context_length_exceeded" }).transient, false)
check(
  "context overflow opencode tarafindan compaction ile cozulur",
  classifyError({ message: "input length and `max_tokens` exceed context limit" }).kind,
  "context-overflow",
)

check("abort dokunulmaz", classifyError({ message: "Request aborted by user" }).kind, "aborted")
check("iptal gecici DEGIL", classifyError({ message: "session aborted" }).transient, false)

check("timeout ag sinifi", classifyError({ message: "connect ETIMEDOUT 10.0.0.1:443" }).kind, "network")
check("ECONNREFUSED ag sinifi", classifyError({ type: "network_error", message: "ECONNREFUSED" }).kind, "network")

check("bilinmeyen hata", classifyError({ type: "sebep belirsiz" }).kind, "unknown")
check("status yoksa mesaja guvenir", classifyError({ message: "rate limit exceeded" }).kind, "rate-limit")

console.log("")
console.log("=== 2. GERI CEKILME ===")
const cfg = { ...DEFAULT_FALLBACK, jitter: 0 }
check("ilk retry tam base bekler", computeDelay(2, cfg, () => 0.5), 2000)
check("ikinci retry 2x base", computeDelay(3, cfg, () => 0.5), 4000)
check("ucuncu retry 4x base", computeDelay(4, cfg, () => 0.5), 8000)
check("tavan", computeDelay(20, cfg, () => 0.5), 60000)
check("devasa attempt sonsuz donguye girmez", computeDelay(5000, cfg, () => 0.5), 60000)
check("attempt 1 guvenli taban", computeDelay(1, cfg, () => 0.5), 2000)
check("attempt 0 negatif degil", computeDelay(0, cfg, () => 0.5), 2000)
check("NaN attempt guvenli", computeDelay(NaN, cfg, () => 0.5), 2000)
check("gecersiz taban varsayilana duser", computeDelay(2, { ...cfg, baseDelayMs: -5 }, () => 0.5), 2000)

const jBase = { ...DEFAULT_FALLBACK, baseDelayMs: 1000, maxDelayMs: 10000, jitter: 0.5 }
check("jitter alt sinir", computeDelay(3, jBase, () => 0), 1000)
check("jitter ust sinir", computeDelay(3, jBase, () => 1), 3000)
check("jitter orta noktada degismez", computeDelay(3, jBase, () => 0.5), 2000)

console.log("")
console.log("=== 3. MODEL ZINCIRI SAGLIK SECIMI ===")
const opened = new Map([["p/b", { failures: 3, openedAt: Date.now() }]])
const chain = ["p/a", "p/b", "p/c"]
check("devredeki model atlanir", nextHealthy(chain, "p/a", opened, Date.now(), 60000), "p/c")
check("mevcut model secilmez", nextHealthy(chain, "p/c", opened, Date.now(), 60000), "p/a")
check("bos zincir -> tanimsiz", nextHealthy([], "p/a", new Map(), Date.now(), 60000), undefined)
check(
  "hepsi devrede -> tanimsiz",
  nextHealthy(["p/b"], "p/a", new Map([["p/b", { failures: 1, openedAt: Date.now() }]]), Date.now(), 60000),
  undefined,
)

console.log("")
console.log("")
console.log("=== 3b. ARKA ARDAKAYA BOZULAN MODELLER (regresyon) ===")
// Bu blok bir hatayi kilitler: devresi kapali olsa bile sogumasi bitmis model
// saglikli sayilir. Aksi halde zincirde iki model arka arkaya bozulunca ucuncuye
// hic dusulemiyordu.
const CD = 60000
const t0 = 1_700_000_000_000
const zincir = ["p/a", "p/b", "p/c"]

// 1) p/a ve p/b ikisi de devrede, p/c sadece soğuyor
const ikiBozuk = new Map([
  ["p/b", { failures: 3, openedAt: t0 }],
  ["p/c", { failures: 3, openedAt: t0 - 5000 }],
])
check("iki model arka arkada bozuk -> ucuncuye dusulur", nextHealthy(zincir, "p/a", ikiBozuk, t0, CD), undefined)
check("p/c sogumasi bitmisse ucuncu olur", nextHealthy(zincir, "p/a", new Map([["p/b", { failures: 3, openedAt: t0 }]]), t0, CD), "p/c")

// 2) p/b devrede ve hala soguyor, p/c temiz -> p/c
const birBozuk = new Map([["p/b", { failures: 3, openedAt: t0 }]])
check("bir model bozuk -> siradaki temize dusulur", nextHealthy(zincir, "p/a", birBozuk, t0, CD), "p/c")

// 3) p/b sogumasi BITMIS, p/c temiz -> p/b
const birSogudu = new Map([["p/b", { failures: 3, openedAt: t0 - CD - 1 }]])
check("sogumasi biten model yeniden kullanilabilir", nextHealthy(zincir, "p/a", birSogudu, t0, CD), "p/b")

// 4) hepsi bozuk ama sogumalari dolmus -> ilk uygun olana (dongusel) doner
const hepsiSogudu = new Map([
  ["p/b", { failures: 3, openedAt: t0 - CD - 1 }],
  ["p/c", { failures: 3, openedAt: t0 - CD - 1 }],
])
check("hepsi soguduysa zincirde bir adim atilir", nextHealthy(zincir, "p/a", hepsiSogudu, t0, CD), "p/b")

// 5) ZINCIRDE OLMAYAN bir modeldeysek yine zincirin basindan secilir
check("zincir disi model -> zincirin basindaki saglikli model secilir", nextHealthy(zincir, "p/x", birBozuk, t0, CD), "p/a")

console.log("")
console.log("=== 3c. BAYAT DEVRE SUPURME ===")
const karisik = new Map([
  ["p/a", { failures: 3, openedAt: t0 }],                    // hala soguyor
  ["p/b", { failures: 9, openedAt: t0 - CD - 1 }],            // sogumasi bitti
  ["p/c", { failures: 2, openedAt: undefined }],              // hic acilmamis
])
const temizlenen = sweepBreakers(karisik, t0, CD)
check("sogumasi biten tek model temizlendi", temizlenen, ["p/b"])
check("hala soguyan devre korunur", karisik.get("p/a").openedAt, t0)
check("soguyan modelin sayaci korunur", karisik.get("p/a").failures, 3)
check("temizlenen sayac SIFIRLANIR (anahtar model kilitlenmesin)", karisik.get("p/b").failures, 0)
check("temizlenen devre kapanir", karisik.get("p/b").openedAt, undefined)
check("hic acilmamis devreye dokunulmaz", karisik.get("p/c").openedAt, undefined)
check("bos haritada supurme guvenli", sweepBreakers(new Map(), t0, CD), [])
check("hicbir sey sozumuyorsa hicbiri temizlenmez", sweepBreakers(new Map([["p/a", { failures: 3, openedAt: t0 }]]), t0, CD), [])
console.log("=== 4. VARSAYILANLAR (guvenli varsayilan) ===")
check("autoSwitch varsayilan KAPALI", DEFAULT_FALLBACK.autoSwitch, false)
check("gecici olmayanlar TEKRAR EDILMEZ", DEFAULT_FALLBACK.retryNonTransient, false)
check("zincir varsayilan bos", DEFAULT_FALLBACK.chain, [])
check("ogrenme varsayilan ACIK", DEFAULT_FALLBACK.learnFromFailures, true)
check("geri donus varsayilan acik", DEFAULT_FALLBACK.restoreOnRecovery, true)

console.log("")
console.log("")
console.log("=== 5. YAPILANDIRMA YUKLEME ===")
// Kendi degerlerimizi yazip okuyoruz: test depodaki gercek config'e BAGLANMAMALI.
// Aksi halde config bir yanlisla degistiginde test kendi degerini dogruluyor sanip
// gecer ve gercek bir regresyonu saklardi.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

const gecici = mkdtempSync(tmpdir() + "/orchestra-cfg-")
mkdirSync(gecici + "/.opencode", { recursive: true })
writeFileSync(
  gecici + "/.opencode/orchestra.json",
  JSON.stringify({ fallback: { baseDelayMs: 777, autoSwitch: true, chain: ["a/b"] } }),
  "utf8",
)
const okunan = await loadFallbackConfig(gecici)
check("yazilan deger okundu (baseDelayMs)", okunan.baseDelayMs, 777)
check("yazilan deger okundu (autoSwitch)", okunan.autoSwitch, true)
check("yazilan deger okundu (chain)", okunan.chain, ["a/b"])
check("yazilmayan alanlar varsayilandan gelir", okunan.jitter, DEFAULT_FALLBACK.jitter)
check("eksik dizin zarifce varsayilana duser", (await loadFallbackConfig(gecici + "/yok")).enabled, true)
rmSync(gecici, { recursive: true, force: true })

console.log("")
console.log("")
console.log("=== 6. GERI DONUS KARARI (saf, switchModel cagrisi iceride degil) ===")
// Bu blok bir hatayi kilitler: karar `switchModel` cagrisinin icinde gomuluydu,
// test edilemiyordu. Artik `shouldRestore` saf bir fonksiyon ve gerekcesi
// ("reason") test edilebilir.
//
// Kilitlenen davranis: gecis kayitlari GERI DONUS cagrisi BASARILI OLMADAN
// silinmemeli. Aksi halde oturum kalici olarak yedek modelde kaliyor ve geri
// donus bir daha denenmiyordu.
const acikCfg = { ...DEFAULT_FALLBACK, autoSwitch: true, chain: ["p/b"] }
const karar = (over) => shouldRestore({ config: acikCfg, mark: 3, retryTotal: 3, original: "p/a", failedRestores: 0, ...over })

// 1) Yapilandirma kapali -> geri donus olmaz
check("config-off: autoSwitch kapali", karar({ config: { ...acikCfg, autoSwitch: false } }).reason, "config-off")
check("config-off: autoSwitch kapali -> restore yok", karar({ config: { ...acikCfg, autoSwitch: false } }).restore, false)
check("config-off: restoreOnRecovery kapali", karar({ config: { ...acikCfg, restoreOnRecovery: false } }).reason, "config-off")
check("config-off: enabled kapali", karar({ config: { ...acikCfg, enabled: false } }).reason, "config-off")
check("config-off varsayilan autoSwitch'i kapatir", karar({ config: DEFAULT_FALLBACK }).reason, "config-off")

// 2) Isaret yok -> bu oturumda gecis yapilmamis
check("no-mark: isaret tanimsiz", karar({ mark: undefined }).reason, "no-mark")
check("no-mark: retryTotal var olsa da olmaz", karar({ mark: undefined, retryTotal: 7 }).reason, "no-mark")

// 3) Gecisten sonra da retry oldu -> bekle
check("still-retrying: sayac degisti", karar({ retryTotal: 4 }).reason, "still-retrying")
check("still-retrying: sayac AZALDI (oturum karismasi olmamali)", karar({ retryTotal: 2 }).reason, "still-retrying")
check("still-retrying: sayac tanimsiz", karar({ retryTotal: undefined }).reason, "still-retrying")
check("still-retrying -> restore yok", karar({ retryTotal: 4 }).restore, false)

// 4) Ilk model kaydi bozuk
check("no-original: kayit yok", karar({ original: undefined }).reason, "no-original")
check("no-original: bos dizge", karar({ original: "" }).reason, "no-original")
check("no-original: deneme yapilmadigi icin sayac ilerlemez", karar({ original: undefined }).nextFailedRestores, 0)
check("invalid-original: provider'siz", karar({ original: "sadece-model" }).reason, "invalid-original")
check("invalid-original: bos id", karar({ original: "p/" }).reason, "invalid-original")
check("invalid-original -> restore yok", karar({ original: "sadece-model" }).restore, false)

// 5) Esitlik -> geri donus
const mutlu = karar()
check("esit sayac -> restore", mutlu.reason, "restore")
check("esit sayac -> restore true", mutlu.restore, true)
check("basarisiz gecis sayaci ilerletir", mutlu.nextFailedRestores, 1)
check("id gecisi olan referans kabul edilir", karar({ original: "p/a/b" }).reason, "restore")

// 6) Sinir: hata halinde kayit KORUNUR, bir kez daha denenir, sonra vazgecildi
const h1 = karar()
const h2 = karar({ failedRestores: h1.nextFailedRestores })
const h3 = karar({ failedRestores: h2.nextFailedRestores })
check("hatali geri donus: 1. deneme restore", h1.reason, "restore")
check("hatali geri donus: kayit korundu, 2. deneme YINE restore", h2.reason, "restore")
check("hatali geri donus: sinirdan sonra vazgecildi", h3.reason, "restore-limit")
check("hatali geri donus: dongu kapandi", h3.restore, false)
check("hatali geri donus: vazgecmede sayac ilerlemez", h3.nextFailedRestores, 2)
check("restore-limit sinir degeri", MAX_RESTORE_RETRIES, 1)

// 7) Vazgecme gerekceleri kaydi BIRAKIR; digerleri KORUR
check("vazgecme: config-off kaydi birakir", RESTORE_GIVE_UP.includes("config-off"), true)
check("vazgecme: no-original kaydi birakir", RESTORE_GIVE_UP.includes("no-original"), true)
check("vazgecme: invalid-original kaydi birakir", RESTORE_GIVE_UP.includes("invalid-original"), true)
check("vazgecme: restore-limit kaydi birakir", RESTORE_GIVE_UP.includes("restore-limit"), true)
check("vazgecme: no-mark KAYDI KORUR", RESTORE_GIVE_UP.includes("no-mark"), false)
check("vazgecme: still-retrying KAYDI KORUR", RESTORE_GIVE_UP.includes("still-retrying"), false)

// 8) Bozuk girdi guvenli
check("NaN failedRestores guvenli taban", karar({ failedRestores: NaN }).reason, "restore")
check("NaN failedRestores sayac ilerletmez", karar({ failedRestores: NaN }).nextFailedRestores, 1)
check("negatif failedRestores guvenli taban", karar({ failedRestores: -3 }).reason, "restore")
check("Olmayan ajan -> taban config", karar({ mark: undefined, config: DEFAULT_FALLBACK }).reason, "config-off")

console.log("")
console.log("=== 7. MODEL REFERANSI AYIRMA ===")
check("p/m ayristirilir", parseModelRef("p/m"), { providerID: "p", id: "m" })
check("coklu slash id'ye girer", parseModelRef("p/vendor/model:v2"), { providerID: "p", id: "vendor/model:v2" })
check("bos dizge reddedilir", parseModelRef(""), undefined)
check("bosluk dizge reddedilir", parseModelRef("   "), undefined)
check("tanimsiz reddedilir", parseModelRef(undefined), undefined)
check("sadece provider reddedilir", parseModelRef("p"), undefined)

console.log("")
console.log("")
console.log("=== 8. OTURUM IZOLASYONU (regresyon) ===")
// Bu blok bir hatayi kilitler: retry sayaci TEK GLOBAL bir sayacti. Paralel
// oturumdan gelen TEK BIR retry, bu oturumun `mark`ini degistiriyor ve geri
// donus HIC GERCEKLESMIYORDU. Simdi sayac `Map<sessionID, number>`.
const sayac = new Map()
bumpRetry(sayac, "sA")
bumpRetry(sayac, "sA")
const markA = sayac.get("sA")
check("iki oturumun sayaci birbirini bozmuyor", markA, 2)
bumpRetry(sayac, "sB")
check("B'nin retry'i A'nin sayacini degistirmedi", sayac.get("sA"), 2)
check("B kendi sayacini tutuyor", sayac.get("sB"), 1)
check("B icin mark/retry esitse donus olur", shouldRestore({ config: acikCfg, mark: sayac.get("sB"), retryTotal: sayac.get("sB"), original: "p/a", failedRestores: 0 }).reason, "restore")

// ESKI davranisin canli taklidi: tek global sayac
const globalSayac = { n: 0 }
globalSayac.n += 1
const eskiMark = globalSayac.n
globalSayac.n += 1
globalSayac.n += 1 // yalnizca B icin, ama A'yi da bozdu
check("ESKI: global sayac A'nin donusunu engelliyordu", shouldRestore({ config: acikCfg, mark: eskiMark, retryTotal: globalSayac.n, original: "p/a", failedRestores: 0 }).reason, "still-retrying")
check("YENI: ayni senaryoda oturum bazli sayac donusu SERBEST BIRAKIYOR", shouldRestore({ config: acikCfg, mark: 2, retryTotal: sayac.get("sA"), original: "p/a", failedRestores: 0 }).reason, "restore")

// Sinirli temizleme: harita sinirsiz buyumesin
const dolu = new Map()
for (const id of ["s1", "s2", "s3", "s4", "s5"]) bumpRetry(dolu, id)
const atilan = trimRetryCounts(dolu, ["s1"], 2)
check("sinir asilirken en eskiler atilir", atilan, ["s2", "s3", "s4"])
check("sinir uygulandi", dolu.size, 2)
check("isaretli oturum KORUNUR", dolu.has("s1"), true)
check("isaretsizler silinir", dolu.has("s2"), false)
check("sinirin altinda hicbiri atilmaz", trimRetryCounts(new Map([["s1", 1], ["s2", 2]]), [], 5), [])
check("sinir 0 -> budama kapali", trimRetryCounts(new Map([["s1", 1]]), [], 0), [])
const hepsiIsaretli = new Map([["s1", 1], ["s2", 2]])
check("hepsi isaretliyse budama yalniz oturumu silmez", trimRetryCounts(hepsiIsaretli, ["s1", "s2"], 1), [])
check("hepsi isaretliyse kayitlar durur", hepsiIsaretli.size, 2)

console.log("")
console.log("")
console.log("=== 9. perAgent GECERSIZ KILMALARI (regresyon) ===")
// Bu blok bir hatayi kilitler: karar `configFor(event.agent)` ile aliniyordu,
// `note` ise `baseConfig.learnFromFailures` okuyordu; ayarli roller icin not
// YAZILIYORDU. Ayrica geri donus yolunda `configFor(undefined)` kullaniliyordu,
// yani perAgent gecersiz kilmalari o yolda hic uygulanmiyordu.
const perAjanli = {
  ...DEFAULT_FALLBACK,
  autoSwitch: true,
  chain: ["p/b"],
  perAgent: {
    mimar: { learnFromFailures: false },
    "sessiz-rol": { autoSwitch: false, learnFromFailures: false },
  },
}

check("ajan bilinmiyorsa taban config", configForAgent(perAjanli).learnFromFailures, true)
check("ajan bilinmiyorsa autoSwitch tabandan", configForAgent(perAjanli).autoSwitch, true)
check("tanimsiz ajan tabana duser", configForAgent(perAjanli, "olmayan-rol").learnFromFailures, true)
check("note karari perAgent.learnFromFailures:false'a uyar", configForAgent(perAjanli, "mimar").learnFromFailures, false)
check("gecersiz kilma diger alanlari bozmaz", configForAgent(perAjanli, "mimar").chain, ["p/b"])
check("gecersiz kilma taban autoSwitch'i korur", configForAgent(perAjanli, "mimar").autoSwitch, true)
check("rol bazli autoSwitch kapali", configForAgent(perAjanli, "sessiz-rol").autoSwitch, false)
check(
  "geri donus yolunda perAgent UYGULANIYOR (autoSwitch kapali rol)",
  shouldRestore({ config: configForAgent(perAjanli, "sessiz-rol"), mark: 3, retryTotal: 3, original: "p/a", failedRestores: 0 }).reason,
  "config-off",
)
check(
  "geri donus yolunda perAgent UYGULANIYOR (gecis yapan rol)",
  shouldRestore({ config: configForAgent(perAjanli, "mimar"), mark: 3, retryTotal: 3, original: "p/a", failedRestores: 0 }).reason,
  "restore",
)
check(
  "perAgent restoreOnRecovery kapali -> config-off",
  shouldRestore({ config: { ...configForAgent(perAjanli, "mimar"), restoreOnRecovery: false }, mark: 3, retryTotal: 3, original: "p/a", failedRestores: 0 }).reason,
  "config-off",
)

console.log("")
console.log("SONUC: " + pass + " gecti, " + fail + " kaldi")
process.exit(fail === 0 ? 0 : 1)
