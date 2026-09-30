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

import { classifyError, computeDelay, nextHealthy, sweepBreakers, loadFallbackConfig, DEFAULT_FALLBACK } from "../.opencode/plugins/orchestra/fallback.ts"

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
console.log("=== 5. YAPILANDIRMA YUKLEME ===")
const gercek = await loadFallbackConfig(process.cwd())
check("calisma dizinindeki dosya okundu", gercek.baseDelayMs, 2000)
check("eksik dizin zarifce varsayilana duser", (await loadFallbackConfig("C:/olmayan/yol")).enabled, true)

console.log("")
console.log("SONUC: " + pass + " gecti, " + fail + " kaldi")
process.exit(fail === 0 ? 0 : 1)
