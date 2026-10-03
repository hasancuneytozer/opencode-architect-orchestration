/**
 * Izin siralamasi regresyon testi.
 *
 * Calistirma: npm test
 *   (veya dogrudan: node --experimental-strip-types --no-warnings scripts/permissions.test.mjs)
 *
 * Kapsam: TAMAMEN SAF metin islemi. Canli opencode calistirmaz, gercek tehlikeli
 * komut YETMEZ; yalnizca `opencode.jsonc` ile rol dosyalarini okuyup metin
 * eslestirmesi yapar.
 *
 * Yakaladigi hata: opencode V2 izin cozumunde **son eslesen kural kazanir**.
 * `opencode.jsonc` yasaklari once, genel joker `allow`lari sonra yaziyordu; boylece
 * `{"action":"shell","resource":"*","effect":"allow"}` taban yasaklarin USTUNE
 * biniyor ve `rm -rf C:\` "serbest" kaliyordu. Test siralamayi metin uzerinden
 * kanitlar; canli izin motorunu degil, ONUN SORDUGU SORUYU cevaplar.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join, dirname, sep } from "node:path"
import { fileURLToPath } from "node:url"

const KOK = join(dirname(fileURLToPath(import.meta.url)), "..")

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

// ─────────────────────────────────────────────────────────────────────────────
// 1) SAF IZIN DEGERLENDIRICISI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MOTORUN OLCULEN SEMANTIGI (testin modellendigi varsayim degil, olcum):
 *
 *   1) `\` -> `/` normalization `action` VE `resource` icin, HER isletim
 *      sisteminde yapilir. Windows harf duyarsizligi AYRI bir konudur.
 *   2) Desenler REGEX DEGILDIR. Yalniz `*` (0+ karakter) ve `?` (tam 1
 *      karakter) jokerdir; `.[]()+^|{}` gibi karakterler DEGERINDE kalir.
 *   3) `*` sifir karakteri de kapsar. Buna sonu " *" ile biten desenler de
 *      dahil: `git reset --hard *` deseni `git reset --hard` komutunu da yakalar.
 *   4) Buyuk/kucuk harf duyarsizligi yalniz YOL kaynaklarinda ve Windows'ta.
 */

// Yol (dosya) kaynaklarini tasiyan eylemler. Bunlar harf duyarsizligi ve
// buyuk/kucuk harf karsilastirmasindan gecer.
const YOL_EYLEMLERI = new Set(["read", "edit", "write", "glob", "grep", "patch", "external_directory"])
const WINDOWS = process.platform === "win32"

// `windows` parametre verilebilir ki test her isletim sisteminde ayni sonucu
// uretsin; aksi halde "Windows'ta duyarsiz" kontrolu Linux'ta yanlis yaslanirdi.
// Her OS'ta, action VE resource icin: backslash -> slash.
const slash = (s) => s.replace(/\\/g, "/")

// Glob -> RegExp. `*` sifir veya daha fazla karakter, `?` tam bir karakter.
// Geri kalan her karakter DEĞİŞMEZ: regex metakarakterleri kaçırılır.
const desenRegExp = (desen) => {
  // Olculen semantik: desen sonu " *" (bosluk + yildiz) opsiyonel bir kuyruktur.
  // Yani `git reset --hard *` deseni hem `git reset --hard HEAD~5` komutunu hem de
  // `git reset --hard` (komutsuz) varyantini yakalar; `git push *` deseni
  // `git pushy`yi YAKALAMAZ (ayrac zorunlu kalir).
  const sonrakiKuyruk = / \*$/.test(desen)
  const govde = sonrakiKuyruk ? desen.slice(0, -2) : desen
  let src = ""
  for (const c of govde) {
    if (c === "*") src += ".*"
    else if (c === "?") src += "."
    else src += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp("^" + src + (sonrakiKuyruk ? "(\\s.*)?" : "") + "$")
}

/**
 * Desen <-> deger karsilastirmasi. `yolMu` ise IKISI de normalize edilir
 * (desen ve deger); boylece normalization tek yerde durur ve test ile
 * degerlendirici ayni yolu izler. Backslash -> slash her zaman yapilir.
 */
const desenEslesir = (desen, deger, yolMu, windows = WINDOWS) => {
  const duzDesen = slash(desen)
  const duzDeger = slash(deger)
  const kucult = yolMu && windows
  return desenRegExp(kucult ? duzDesen.toLowerCase() : duzDesen).test(kucult ? duzDeger.toLowerCase() : duzDeger)
}

const kuralEslesir = (kural, action, resource) =>
  desenEslesir(kural.action, slash(action), false) &&
  desenEslesir(kural.resource, resource, YOL_EYLEMLERI.has(slash(action)))

/** Siradaki tum kurallari tara, SON esleseni dondur (yoksa null). */
const sonEslesme = (kurallar, action, resource) => {
  let bulunan = null
  for (const k of kurallar) {
    if (kuralEslesir(k, action, resource)) bulunan = k
  }
  return bulunan
}

// V2 taban politikasi: hicbir kural eslesmezse `{action:"*",resource:"*",
// effect:"allow"}` devreye girer, yani etki `allow` olur.
const TABAN = [{ action: "*", resource: "*", effect: "allow" }]
const etki = (kurallar, action, resource) => sonEslesme([...TABAN, ...kurallar], action, resource)?.effect ?? "allow"

/** `resource:"*"` + `allow` = o eylemin joker izni. */
const jokerAllowMu = (k) => k.resource === "*" && k.effect === "allow"

/**
 * Config'in "taban guvenlik" dedigi eylemler: yikici komut (shell), sif
 * (read/edit) ve mimari kisit (subagent). Bir rol bu eylemlerde joker allow
 * tasirsa altina config'in yasagini tekrar etmek zorundadir.
 */
const TABAN_GUVENLIK = new Set(["shell", "read", "edit", "subagent"])

/**
 * Genel joker: taban guvenlik eylemlerinden birinin `* allow`'u. Rol dosyasindaki
 * "genel izin" denetimi bunlara bakar. Orkestrasyon kapisi (`orchestra_*`) bir
 * genel izin degil, acikca sozlesilmis rol kapisidir; kendi bolumunde denetlenir.
 */
const genelJokerMu = (k) => jokerAllowMu(k) && TABAN_GUVENLIK.has(k.action)

console.log("=== 1. DESEN ESLESMESI (saf) ===")
const es = (desen, deger, yolMu = false, windows = WINDOWS) => desenEslesir(desen, deger, yolMu, windows)
check("tam eslesme", es("abc", "abc"), true)
check("* sifir karakteri de kapsar", es("abc*", "abc"), true)
check("* birden fazla karakteri kapsar", es("abc*", "abcdef"), true)
check("yol: backslash forward slash'a normalize edilir", es("**/id_rsa*", "C:\\p\\id_rsa", true), true)
check("yol: Windows'ta buyuk/kucuk harf duyarsiz", es("**/.env", "C:\\P\\.ENV", true, true), true)
check("yol: buyuk desen kucuk kaynakla da ESLESIR (desen de kucuk harf)", es("**/.ENV", "c:\\p\\.env", true, true), true)
check("yol: dis sistemde harf duyarli kalir", es("**/.ENV", "c:\\p\\.env", true, false), false)
check("yol: dis sistemde backslash yine normalize edilir", es("**/.env", "C:\\p\\.env", true, false), true)
check("shell hamdir: ~ genisletilmez", es("rm -rf ~*", "rm -rf ~"), true)
check("shell hamdir: yol normalize edilmez", es("**/id_rsa*", "id_rsa"), false)
check("? tam bir karakter", es("a?c", "abc"), true)
check("? sifir karakteri kapsamaz", es("a?c", "ac"), false)

// --- olculen motor semantigi: backslash -> slash HER OS'ta, action dahil ------
check("resource: shell backslash'i slash'a normalize edilir", es("echo a/b", "echo a\\b"), true)
check("resource: shell backslash'i dis sistemde de normalize edilir", es("echo a/b", "echo a\\b", false, false), true)
check("action: backslash forward slash'a normalize edilir", es("orchestra\\report", "orchestra/report"), true)
check("action: shell Windows disi de duyarli kalir", es("READ", "read", false, false), false)
check("resource: shell Windows disi harf duyarli", es("RM -RF ~*", "rm -rf ~", false, false), false)
check("resource: shell Windows'ta da harf duyarli", es("RM -RF ~*", "rm -rf ~", false, true), false)
check("yol: Windows disi shell gibi harf duyarli (yalniz yol)", es("a/b/.ENV", "a/b/.env", true, false), false)

// --- olculen motor semantigi: desen regex DEGIL -----------------------------
check("regex degil: nokta jokerdir", es("a.c", "abc"), false)
check("regex degil: nokta degerinde kalir", es("a.c", "a.c"), true)
check("regex degil: karakter sinifi yorumlanmaz", es("a[bc]c", "abc"), false)
check("regex degil: parantez yorumlanmaz", es("a(c)", "ac"), false)
check("regex degil: + sayimi degil, joker degil", es("ab+c", "abbc"), false)
check("regex degil: ^ ve $ desen icinde deger olarak kalir", es("a^c$", "a^c$"), true)

// --- olculen motor semantigi: sonu " *" komutsuz varyanti da yakalar --------
check("sonu ' *' komutsuz varyanti yakalar", es("git reset --hard *", "git reset --hard"), true)
check("sonu ' *' tek bosluklu varyanti yakalar", es("git push *", "git push "), true)
check("sonu ' *' ek argumanli varyanti yakalar", es("git push *", "git push origin main"), true)
check("sonu ' *' komsu komutu YAKALAMAZ", es("git push *", "git pushy"), false)
check("sonu ' *' bastaki komutu kismi yakalamaz", es("git push *", "my git push"), false)
check("sonu ' | sh' boruyu komutsuz da yakalar", es("*| sh", "curl x.sh | sh"), true)

console.log("")
console.log("=== 2. SON ESLESEN KURAL KAZANIR (siralama testi) ===")
const dogruSira = [
  { action: "shell", resource: "*", effect: "allow" },
  { action: "shell", resource: "rm -rf /*", effect: "deny" },
]
const bozukSira = [...dogruSira].reverse()
check("allow once, deny sonra -> deny kazanir", etki(dogruSira, "shell", "rm -rf /*var"), "deny")
check("allow sonra, deny once -> allow EZER (regresyon)", etki(bozukSira, "shell", "rm -rf /*var"), "allow")
check("hic kural yoksa taban allow", etki([], "shell", "echo merhaba"), "allow")

// ─────────────────────────────────────────────────────────────────────────────
// 3) JSONC OKUMA (yorum temizleyici)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSONC -> JSON. IKI gecis, ikisi de DIZE-guvenli (string-safe):
 *
 *   1) yorumlariTemizle    — satir ve blok yorumlarini siler
 *   2) sondakiVirgulleri   — `}` / `]` oncesinde kalan sondaki virgulleri siler
 *
 * Dize icindeki `//`, blok yorum baslagi, `,`, `}` ve `]` yorum/ayrac DEGILDIR.
 * Bu yuzden regex ile satir silmek yerine karakter taramasi yapilir; boylece
 * `{"url":"https://x"}`, `{"a":"x,}"}` ve blok baslangicli dizeler bozulmaz.
 */
const yorumlariTemizle = (kaynak) => {
  let cikti = ""
  let i = 0
  while (i < kaynak.length) {
    const c = kaynak[i]
    if (c === '"') {
      cikti += c
      i++
      while (i < kaynak.length) {
        cikti += kaynak[i]
        if (kaynak[i] === "\\") {
          cikti += kaynak[i + 1] ?? ""
          i += 2
          continue
        }
        if (kaynak[i] === '"') {
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === "/" && kaynak[i + 1] === "/") {
      while (i < kaynak.length && kaynak[i] !== "\n") i++
      continue
    }
    if (c === "/" && kaynak[i + 1] === "*") {
      i += 2
      while (i < kaynak.length && !(kaynak[i] === "*" && kaynak[i + 1] === "/")) i++
      i += 2
      continue
    }
    cikti += c
    i++
  }
  return cikti
}

/**
 * Sondaki (trailing) virgulleri siler. Gecis 1 yorumlari SULDUKTAN sonra
 * calisir; bu yuzden ileri bakis sadece bosluk atlamak zorundadir.
 * Virgul disinde hicbir karakter degistirilmez.
 */
const sondakiVirgulleriTemizle = (kaynak) => {
  let cikti = ""
  let i = 0
  const sonrakiAnlamli = (j) => {
    while (j < kaynak.length && /\s/.test(kaynak[j])) j++
    return j < kaynak.length ? kaynak[j] : ""
  }
  while (i < kaynak.length) {
    const c = kaynak[i]
    if (c === '"') {
      cikti += c
      i++
      while (i < kaynak.length) {
        cikti += kaynak[i]
        if (kaynak[i] === "\\") {
          cikti += kaynak[i + 1] ?? ""
          i += 2
          continue
        }
        if (kaynak[i] === '"') {
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === ",") {
      const sonraki = sonrakiAnlamli(i + 1)
      if (sonraki === "}" || sonraki === "]") {
        i++ // sondaki virgul: at
        continue
      }
    }
    cikti += c
    i++
  }
  return cikti
}

const jsoncTemizle = (kaynak) => sondakiVirgulleriTemizle(yorumlariTemizle(kaynak))
const jsoncOku = (yol) => JSON.parse(jsoncTemizle(readFileSync(yol, "utf8")))

// --- gecis 1: yorum temizleyicinin kendisi -----------------------------------
const temiz = (kaynak) => JSON.parse(yorumlariTemizle(kaynak))
check("temizleyici: satir yorumu silinir", temiz('{"a":1} // not'), { a: 1 })
check("temizleyici: blok yorumu silinir", temiz('{/* not */"a":1}'), { a: 1 })
check("temizleyici: cok satirli blok yorumu silinir", temiz('{/* a\nb\nc */"a":1}'), { a: 1 })
check("temizleyici: dize icindeki // bozulmaz", temiz('{"a":"http://x"}'), { a: "http://x" })
check("temizleyici: dize icindeki blok baslagi bozulmaz", temiz('{"a":"/*x"}'), { a: "/*x" })
check("temizleyici: dize icindeki blok sonu bozulmaz", temiz('{"a":"x*/"}'), { a: "x*/" })
check("temizleyici: kacisli tirnakli dizede yorum acilmaz", temiz('{"a":"he said \\"hi\\" // no"}'), {
  a: 'he said "hi" // no',
})
check("temizleyici: cift backslash kacisi diziyi erken bitirmez", temiz('{"a":"C:\\\\","b":2}'), { a: "C:\\", b: 2 })
check("temizleyici: satir yorumu sonrasi satir sonu korunur", yorumlariTemizle('{"a":1}//x\n'), '{"a":1}\n')

// --- gecis 2: sondaki virgul (regresyon: JSONC bunu kabul eder) --------------
const oku = (kaynak) => JSON.parse(jsoncTemizle(kaynak))
check("virgul: dizi sondaki virgulu", oku("[1,2,]"), [1, 2])
check("virgul: nesne sondaki virgulu", oku('{"a":1,}'), { a: 1 })
check("virgul: ic ice sondaki virguller", oku('{"a":[1,{"b":2,},],}'), { a: [1, { b: 2 }] })
check("virgul: blok yorumun sonu virgulu silinmez", oku('{"a":1,/*x*/"b":2,}'), { a: 1, b: 2 })
check("virgul: blok yorum + sondaki virgul", oku('{"a":1,/* , */}'), { a: 1 })
check("virgul: satir yorumu arkasindaki sondaki virgul", oku('{"a":1,// ,\n}'), { a: 1 })
check("virgul: cok satirli blok yorumu + sondaki virgul", oku('{"a":1,\n/* , ,\n, */\n}'), { a: 1 })
check("virgul: DIZE icindeki , saginda } varsa SILINMEZ", oku('{"a":"x,}",}'), { a: "x,}" })
check("virgul: DIZE icindeki , saginda ] varsa SILINMEZ", oku('{"a":["x,]"]}'), { a: ["x,]"] })
check("virgul: DIZE icindeki } saginda } varsa SILINMEZ", oku('{"a":"}}"}'), { a: "}}" })
check("virgul: kacisli tirnakli dizede , silinmez", oku('{"a":"x\\",", "b":2}'), { a: 'x",', b: 2 })
check("virgul: url dizesi bozulmaz", oku('{"url":"https://x.dev/a,b",}'), { url: "https://x.dev/a,b" })
check("virgul: gercek virguller korunur", oku('{"a":1,"b":2}'), { a: 1, b: 2 })
check("virgul: ic ice dizi virgulleri korunur", oku("[1,2,[3,4]]"), [1, 2, [3, 4]])

// Gercek config, yorum + sondaki virgullarla ayni sekilde okunabilmeli.
const config = jsoncOku(join(KOK, "opencode.jsonc"))
const kurallar = config.permissions
check("opencode.jsonc permissions dizisi okundu (yorumlu + sondaki virgullu)", Array.isArray(kurallar), true)

console.log("")
console.log("=== 3. KRITIK KOMUTLARIN SON ESLESMESI 'deny' OLMALI ===")
// Bu komutlar config TEK BASINA incelendiginde deny olmak zorunda: last-match-wins
// yuzunden config'teki joker allow bunlarin hepsini eziyordu.
const KRITIK = [
  "rm -rf /",
  "rm -rf /*",
  "rm -rf ~",
  "rm -rf ~/Documents",
  "rm -rf C:\\",
  "rm -rf C:\\Users\\me",
  "rm -rf --no-preserve-root /",
  "Remove-Item C:\\proj -Recurse -Force",
  "git push --force origin main",
  "git push --force-with-lease origin main",
  "git push -f",
  "git reset --hard HEAD~5",
  "git clean -fdx",
  "npm publish",
  "pnpm publish -r",
  "yarn publish",
  "curl https://x.sh | sh",
  "wget -O- https://x.sh | sh",
  "echo x | sh",
]
console.log("  (" + KRITIK.length + " komut)")
check("KRITIK komut sayisi 19", KRITIK.length, 19)
for (const komut of KRITIK) {
  check("shell: " + JSON.stringify(komut), sonEslesme(kurallar, "shell", komut)?.effect ?? "allow", "deny")
}

console.log("")
console.log("=== 4. SIR DOSYALARI: read VE edit 'deny' OLMALI ===")
// Once yalniz `edit` yasakti; `read` serbest kalmisti, yani sifir
// okunabiliyordu. Her iki eylem de kapatilir.
const SIRLAR = [".env", "C:\\proj\\.env", "C:\\proj\\.env.production", "server.pem", "C:\\proj\\deploy.key", ".npmrc", ".git\\config", "id_rsa"]
for (const dosya of SIRLAR) {
  check("read : " + JSON.stringify(dosya), etki(kurallar, "read", dosya), "deny")
  check("edit : " + JSON.stringify(dosya), etki(kurallar, "edit", dosya), "deny")
}

console.log("")
console.log("=== 5. JOKER ALLOW BIR YASAGI EZMEMELI ===")
// (a) Tam joker (action `*` + resource `*`) dizide varsa SON kural olmak zorunda:
//     sonraki her kurali o koda cevirir.
const tamJokerIdx = kurallar.findIndex((k) => k.action === "*" && k.resource === "*" && k.effect === "allow")
check("tam joker allow sonuncu ya da hic yok", tamJokerIdx === -1 || tamJokerIdx === kurallar.length - 1, true)

// (b) ANLAMLI GENEL KURAL: bir eylemin joker `allow`'u ayni eylemin `deny`'inden
// SONRA geliyorsa o deny'i oldurur. Tek kurtarma yolu ayni eylemin deny'ini
// joker'in ALTINDA yeniden yazmaktir; "bu joker o eylem icin gerekli" diye
// istisna tutulmaz. Olu kapida: orchestra_report/task icin deny vardi, hemen
// ardindan joker allow geliyordu ve altinda hic deny yoktu — yani o yasak TEK
// BASINA HICBIR SEYI KAPATMIYORDU.
const ezilenler = []
for (const [i, k] of kurallar.entries()) {
  if (!jokerAllowMu(k)) continue
  if (!kurallar.slice(0, i).some((x) => x.effect === "deny" && x.action === k.action)) continue
  const altindaDeny = kurallar.slice(i + 1).some((x) => x.effect === "deny" && x.action === k.action)
  if (!altindaDeny) ezilenler.push(k.action + "@" + i)
}
check("joker allow, ayni eylemin deny'ini altinda YENIDEN yazmiyorsa guvenli", ezilenler, [])

check("dizinin son kurali deny (yerlesik roller config'i miras alir)", kurallar[kurallar.length - 1].effect, "deny")

// Genel joker allow'lar (2. blok, idx 0-13) BİTMİŞ olmalı: onlardan sonra
// gelen özel kuralların etkisi ezilmesin. `orchestra_report`/`orchestra_task`
// allow'ları (idx 52-53) joker DEĞİLDİR — mimarın kullanabilmesi için açık
// tutulmuş orkestrasyon kapılarıdır; alt ajanları rol dosyalarındaki `deny`
// kapatır ve ajan kuralları en sona eklendiği için son eşleşen `deny` olur.
// Canlı motor doğrulaması: architect=allow, crew/*=deny.
const genelJokerlar = kurallar
  .map((k, i) => ({ k, i }))
  .filter(({ k }) => jokerAllowMu(k))
check("config'te joker allow'lar orkestrasyon kapisi disinda kalmali", genelJokerlar.map(({ k }) => k.action), [
  "shell", "edit", "read", "glob", "grep", "webfetch", "websearch", "skill",
  "external_directory", "question", "execute",
  "shotcut_*", "blender_*", "blenderlab_*",
])

console.log("")
console.log("=== 6. JSONC agents.<id> ROL DOSYASINI EZMEMELI ===")
// AGENTS.md kurali: opencode.jsonc icindeki `agents.<id>` girisi rolun TAMAMINI
// ezer; frontmatter'daki `permissions` uygulanmaz. JSONC'de yalniz `description`
// ve `model` gibi tanimlayici alanlar olabilir.
const ROL_ALANLARI = ["permissions", "mode", "steps", "tools", "color", "temperature", "prompt"]
for (const [id, tanim] of Object.entries(config.agents ?? {})) {
  check("agents." + id + " rol tanim alani tasimaz", ROL_ALANLARI.filter((a) => a in tanim), [])
}

console.log("")
console.log("=== 7. ROL DOSYALARI: JOKER ALLOW SONRASI YASAKLAR ===")
const rolDosyalariniTopla = (dizin, birikim = []) => {
  for (const g of readdirSync(dizin, { withFileTypes: true })) {
    const yol = join(dizin, g.name)
    if (g.isDirectory()) rolDosyalariniTopla(yol, birikim)
    else if (g.name.endsWith(".md")) birikim.push(yol)
  }
  return birikim
}
const rolDosyalari = rolDosyalariniTopla(join(KOK, ".opencode", "agents")).sort()
check("rol dosyalari bulundu (architect + 9 crew)", rolDosyalari.length, 10)

const frontmatterOku = (yol) => {
  const icerik = readFileSync(yol, "utf8")
  if (!icerik.startsWith("---")) return null
  const son = icerik.indexOf("\n---", 3)
  return son === -1 ? null : icerik.slice(3, son)
}

/**
 * Frontmatter'daki `permissions:` listesini minimal cozer.
 * YAML'in tamamini ayristirmaz; yalnizca `- action:` / `resource:` / `effect:`
 * ucusunu tanir. Rol dosyalarindaki bicim baska degildir.
 */
const izinleriOku = (frontmatter) => {
  if (!frontmatter) return null
  const satirlar = frontmatter.split(/\r?\n/)
  const basIdx = satirlar.findIndex((l) => /^permissions:\s*$/.test(l))
  if (basIdx === -1) return null
  const kurallar = []
  let aktif = null
  for (let i = basIdx + 1; i < satirlar.length; i++) {
    const satir = satirlar[i]
    const kirp = satir.trim()
    if (kirp === "" || kirp.startsWith("#")) continue
    if (!/^\s/.test(satir)) break // frontmatter baska bir uste-duzey anahtara donmus
    // Liste ogeleri iki bicimde yaziliyor: `- action: shell` (anahtar degerin
    // yaninda) ve `- shell` (yalniz deger). Ikisi de ayni yola indirgenir.
    const yeni = satir.match(/^\s*-\s+(\w+):\s*"?([^"]*)"?\s*$/)
    if (yeni) {
      aktif = {}
      aktif[yeni[1]] = yeni[2].trim()
      kurallar.push(aktif)
      continue
    }
    const deger = satir.match(/^\s*-\s+"?([^"]*)"?\s*$/)
    if (deger && !deger[1].includes(":")) {
      aktif = { action: deger[1].trim(), resource: "", effect: "" }
      kurallar.push(aktif)
      continue
    }
    const alan = satir.match(/^\s+(\w+):\s*"?([^"]*)"?\s*$/)
    if (alan && aktif) aktif[alan[1]] = alan[2].trim()
  }
  return kurallar
}

// Her rol kendi joker allow'undan sonra bu dort yasagi tasimak zorunda;
// boylece taban config'den bagimsiz olarak da gecmisi ezme engellenir.
const ASIL_GIT = ["git push --force*", "git push -f*", "git reset --hard *", "git clean *"]

for (const yol of rolDosyalari) {
  const ad = yol.slice(join(KOK, ".opencode", "agents").length + 1).split(sep).join("/")
  const rol = izinleriOku(frontmatterOku(yol))
  check(ad + ": permissions blogu cozulebildi", Array.isArray(rol) && rol.length > 0, true)
  if (!Array.isArray(rol) || rol.length === 0) continue

  const jokerIdx = rol.map(genelJokerMu).lastIndexOf(true)
  const kapsam = jokerIdx === -1 ? rol : rol.slice(jokerIdx + 1)
  if (jokerIdx === -1) {
    check(ad + ": joker allow yok, en az 1 deny var", rol.some((k) => k.effect === "deny"), true)
  } else {
    const sonrasindaDeny = kapsam.filter((k) => k.effect === "deny")
    check(ad + ": joker allow sonrasi " + sonrasindaDeny.length + " deny kurali var (>=1)", sonrasindaDeny.length >= 1, true)
  }

  // Asil git yasaklari joker allow'un ALTINDA olmak zorunda; onun ustunde kalsalari
  // son-eslesen-kural kurali yuzunden joker allow tarafindan ezilir.
  const tasinan = ASIL_GIT.filter((g) => kapsam.some((k) => k.effect === "deny" && k.action === "shell" && k.resource === g))
  check(ad + ": asil git yasaklari " + tasinan.length + "/4 (joker allow sonrasi)", tasinan.length, 4)
}

console.log("")
console.log("=== 8. ROL JOKER'I CONFIG YASAKLARINI EZMEMELI (canli motor bulgusu) ===")

// Bu bolum 5 rolde sessizce 40 (kural x ajan) celisini olusturuyordu.
//
// opencode V2 kurali: alt oncelikli config ONCE, global SONRA, ajan kurallari
// EN SONDA birlestirilir ve SON eslesen kural kazanir. Rol dosyasi joker'i
// `{"action":"shell","resource":"*","effect":"allow"}` config'deki TUM shell
// yasaklarindan SONRA duser ve onlari ezer. 5 rolde bu joker vardi:
//
//   architect.md:23, maker.md:23, operator.md:23, scribe.md:26, verifier.md:17
//
// Canli olcum (opencode debug agents, 17 ajan): architect icin
//   idx 26  shell  rm -rf C:*      deny
//   idx 66  shell  *               allow   <- SON ESLESME = allow
// yani `rm -rf C:\Users\me` architect'te SERBESTTI. Joker'lar kaldirildi;
// config tek dogruluk kaynagi, roller yalniz kendi ek kisitlarini tasirir.
//
// KURAL: hicbir rol, config'de taban guvenlik olan bir eylem icin joker allow
// TASIMAZ. Yazma zorunda olan roller (maker/operator) `edit` joker'i tasiyabilir
// ama o joker'in altina TUM sir yasaklarini tekrar etmek zorundadir.
//
// KAPSAM: burada "taban guvenlik" = config'in yikici komut, sir ve mimari kisit
// bloklari (shell / read / edit / subagent). `orchestra_report` ve
// `orchestra_task` bu kapsamin DISINDA ve kendi bolumunde (10) pozitif olarak
// denetleniyor: mimar icin allow, her crew icin deny. Burada bir istisna
// tutulmaz; tutulsa o yasak denetlenmemis olurdu.

// Config kuralları JSON dizisi olarak gelir (frontmatter YAML değil); aynı
// alan adlarıyla normalize et ki `kuralEslesir` ikisinde de çalışsın.
const configKurallar = (config.permissions ?? []).map((k) => ({
  action: String(k.action ?? ""),
  resource: String(k.resource ?? ""),
  effect: String(k.effect ?? ""),
}))

const rolKurallari = new Map()
for (const yol of rolDosyalari) {
  const ad = yol.slice(join(KOK, ".opencode", "agents").length + 1).split(sep).join("/")
  rolKurallari.set(ad, izinleriOku(frontmatterOku(yol)) ?? [])
}

for (const yol of rolDosyalari) {
  const ad = yol.slice(join(KOK, ".opencode", "agents").length + 1).split(sep).join("/")
  const rol = rolKurallari.get(ad)
  if (!Array.isArray(rol) || rol.length === 0) continue

  const jokerlar = rol.filter(jokerAllowMu)

  // (a) Rol, config'de shell'i tuman TIKIYSA kendi shell joker'ini tasimaz.
  const configShellJoker = jokerAllowMu(configKurallar.find((k) => k.action === "shell" && k.resource === "*") ?? {})
  check(
    ad + ": config shell'i zaten aciksa rol shell joker'i tasimaz",
    configShellJoker ? jokerlar.filter((k) => k.action === "shell").length : 0,
    0,
  )

  // (b) Bir rolun joker'i config'deki taban deny'leri ezmemeli. Birlestirilmis
  // listede config once, rol sonra gelir; rol joker'i son eslesen olurdu.
  const birlestirilmis = [...configKurallar, ...rol]
  const ezilen = configKurallar
    .filter((k) => k.effect === "deny" && TABAN_GUVENLIK.has(k.action))
    .filter((k) => etki(birlestirilmis, k.action, k.resource) !== "deny")
    .map((k) => k.action + ":" + k.resource)
  check(ad + ": config taban deny'lerini ezmiyor (" + ezilen.length + " " + ezilen.join(",") + ")", ezilen.length, 0)
}

// (c) Sirlar: yazan roller kendi `edit` joker'larinin altina TUM sir
// yasaklarini tekrar etmek zorunda. Config'teki tekrar yeterli DEGIL; rol
// joker'i config'ten sonra gelir.
const SIR_KAYNAKLARI = ["*.env", "*.env.*", "*.pem", "*.key", "*.npmrc", "*.git/config", "*id_rsa*"]
const SIR_YOLLERI = [".env", "C:\\proj\\.env", "a/b/.env", ".env.production", "server.pem", "C:\\p\\deploy.key", ".npmrc", "id_rsa", "C:\\p\\.git\\config"]

for (const yol of rolDosyalari) {
  const ad = yol.slice(join(KOK, ".opencode", "agents").length + 1).split(sep).join("/")
  const rol = izinleriOku(frontmatterOku(yol))
  if (!Array.isArray(rol) || rol.length === 0) continue

  // Curator yalnizca hafiza yazabilir; digerleri icin edit joker'i var mi?
  const editJokerIdx = rol.findIndex((k) => jokerAllowMu(k) && k.action === "edit")
  if (editJokerIdx === -1) continue

  const jokerSonrasi = rol.slice(editJokerIdx + 1)
  const birlestirilmis = [...configKurallar, ...rol]
  const sizan = SIR_YOLLERI.filter((dosya) => etki(birlestirilmis, "edit", dosya) !== "deny")
  check(ad + ": edit joker'i altinda " + SIR_KAYNAKLARI.length + " sir yasagi (" + sizan.length + " sizan)", sizan.length, 0)

  // Ve joker'in altinda gercekten kendi yasaklarini tasiyor mu?
  const tasinan = SIR_KAYNAKLARI.filter((d) => jokerSonrasi.some((k) => k.effect === "deny" && k.action === "edit" && k.resource === d))
  check(ad + ": edit joker'i sonrasi " + tasinan.length + "/" + SIR_KAYNAKLARI.length + " sir yasagi", tasinan.length, SIR_KAYNAKLARI.length)
}

// (d) Normal dosyalar KAPANMAMALI: asiri katilik da bir kusurdur.
// Salt-okunur roller shell'i tamamen deny edebilir (bu kasitlidir), ama
// hicbir rol proje kokundeki adi dosyalari okuyamaz hale gelmemeli.
for (const yol of rolDosyalari) {
  const ad = yol.slice(join(KOK, ".opencode", "agents").length + 1).split(sep).join("/")
  const rol = izinleriOku(frontmatterOku(yol))
  if (!Array.isArray(rol) || rol.length === 0) continue
  const birlestirilmis = [...configKurallar, ...rol]
  const kapanan = ["package.json", "README.md", "opencode.jsonc"].filter((d) => etki(birlestirilmis, "read", d) === "deny")
  check(ad + ": normal dosyalar okunabilir (" + kapanan.length + " kapanan)", kapanan.length, 0)
}

console.log("")
console.log("=== 9. CONFIG+ROL BIRLESTIMI: KRITIKLER HICBIR ROLDE ACILAMAZ ===")
// Config tek basina yeterli DEGIL: ajan kurallari config'ten SONRA birlestirilir,
// son eslesen kazanir. Rolun kendi joker'i config yasagini sonradan ezip
// acabilirdi. Oyleyse config'te yazmak tek basina koruma degildir; birlesim
// her rol icin ayri ayri denetlenir.
for (const yol of rolDosyalari) {
  const ad = yol.slice(join(KOK, ".opencode", "agents").length + 1).split(sep).join("/")
  const rol = rolKurallari.get(ad)
  if (!Array.isArray(rol) || rol.length === 0) continue
  const birlestirilmis = [...configKurallar, ...rol]

  const sizan = KRITIK.filter((komut) => etki(birlestirilmis, "shell", komut) !== "deny")
  check(ad + ": " + KRITIK.length + " kritik komutun hepsi deny (" + sizan.length + " sizan)", sizan.length, 0)

  const okunabilen = SIRLAR.filter((dosya) => etki(birlestirilmis, "read", dosya) !== "deny")
  check(ad + ": " + SIRLAR.length + " sir read deny (" + okunabilen.length + " okunabilir)", okunabilen.length, 0)

  const yazilabilen = SIRLAR.filter((dosya) => etki(birlestirilmis, "edit", dosya) !== "deny")
  check(ad + ": " + SIRLAR.length + " sir edit deny (" + yazilabilen.length + " yazilabilir)", yazilabilen.length, 0)
}

console.log("")
console.log("=== 10. ORKESTRASYON KAPISI: YALNIZ ARCHITECT ACIK ===")
// Iki katmanli kapı:
//   1) config dizinin EN SONUNDA deny  → rol dosyasi olmayan her yerlesik rol
//      (build/plan/explore/general/summary/title/compaction) kapanir
//   2) mimar frontmatter'inin EN SONUNDA allow → yalniz orkestratör acar
//   3) crew frontmatter'inda deny       → alt ajan modele hic gosterilmez
// Onceki duzen config'te deny + joker allow idi ve last-match-wins yuzunden
// config TEK BASINA hicbir seyi kapamiyordu.
const KAPILAR = ["orchestra_report", "orchestra_task"]
check("config: iki kapi da deny", KAPILAR.map((a) => etki(configKurallar, a, "*")), ["deny", "deny"])
check("config: kapi deny'leri dizinin en sonunda", kurallar.slice(-2).map((k) => k.action + ":" + k.effect), [
  "orchestra_report:deny",
  "orchestra_task:deny",
])

for (const yol of rolDosyalari) {
  const ad = yol.slice(join(KOK, ".opencode", "agents").length + 1).split(sep).join("/")
  const rol = rolKurallari.get(ad)
  if (!Array.isArray(rol) || rol.length === 0) continue
  const beklenen = ad === "architect.md" ? "allow" : "deny"
  const birlestirilmis = [...configKurallar, ...rol]
  const sonuc = KAPILAR.map((a) => etki(birlestirilmis, a, "*"))
  check(ad + ": " + beklenen + " bekleniyordu, " + sonuc.join("/") + " geldi", sonuc, [beklenen, beklenen])
}

// Mimar bu kapiyi KENDI frontmatter'inda acar; oyun rol dosyasindan tasinmaz
// (config `agents.<id>` rolu ezer diye 6. bolum bunu denetliyor).
const mimar = rolKurallari.get("architect.md") ?? []
const sonKural = mimar[mimar.length - 1]
check("architect: frontmatter'in son kurali acik kapi", sonKural?.action + ":" + sonKural?.effect, "orchestra_task:allow")
check("architect: kapilar frontmatter'in sonunda", mimar.slice(-2).map((k) => k.action + ":" + k.effect), [
  "orchestra_report:allow",
  "orchestra_task:allow",
])

console.log("")
console.log("=== 11. MIMARIN YAYIN YETKISI: NORMAL PUSH ACIK, ZORLAMA KAPALI ===")
// KAPSAM VE SINIR: burada HICBIR komut CALISTIRILMAZ. `git push --force`
// GIBI BIR GERCEK KOMUT BU DOSYADA HICBIR ZAMAN CALISTIRILMAZ, hatta kuru
// calistirilip ciktisi kullanilmaz. Hepsi `opencode.jsonc` + rol dosyalarinin
// METNI uzerinden, ustteki saf eslestiriciyle degerlendirilir.
//
// KURAL: `crew/operator` push'u HAZIRLAR; son YAYINI yalniz mimar yapar.
// Izin bu yuzden config'e degil rol dosyasina, ve yalniz MIMARIN dosyasina
// yazilir. Daraltma burada yapilir; baska rollerin izni degismez.
//
// SIRALAMA (last-match-wins): normal push `allow`u ONCE, zorlayici varyant
// `deny`leri SONRA durmalidir; aksi halde `allow` son eşleşen olup zorlamayi
// acar. Bolum 11 bu sirayi metin uzerinden kanitlar.
const mimarIzin = rolKurallari.get("architect.md") ?? []
const mimarBirlestirilmis = [...configKurallar, ...mimarIzin]

// (a) Izin gercekten rol dosyasinda ACIK YAZILI (config joker'indan miras degil).
check(
  "architect: kendi 'git push *' allow kurali frontmatter'da acik yazili",
  mimarIzin.some((k) => k.action === "shell" && k.resource === "git push *" && k.effect === "allow"),
  true,
)

// (b) Normal push: config + mimar birlestiginde ACIK.
const NORMAL_PUSH = [
  "git push",
  "git push origin main",
  "git push origin HEAD:refs/heads/main",
  "git push --dry-run origin main",
  "git push --set-upstream origin feature/safe",
]
check("normal push ornegi sayisi 5", NORMAL_PUSH.length, 5)
check(
  "mimar: " + NORMAL_PUSH.length + " normal push komutunun hepsi allow",
  NORMAL_PUSH.map((komut) => etki(mimarBirlestirilmis, "shell", komut)),
  ["allow", "allow", "allow", "allow", "allow"],
)

// (c) Zorlayici varyantlar: `allow`a ragmen KAPALI.
//     --force/-f hem BAS hem SON konumda; --mirror ve `+` refspec'i ayrica.
const ZORLAMA_PUSH = [
  "git push --force",
  "git push --force origin main",
  "git push origin main --force",
  "git push origin main --force-with-lease",
  "git push origin main -f",
  "git push --mirror origin",
  "git push origin main --mirror",
  "git push +main:refs/heads/main",
  "git push origin +main:refs/heads/main",
]
check("zorlayici push ornegi sayisi 9", ZORLAMA_PUSH.length, 9)
check(
  "mimar: " + ZORLAMA_PUSH.length + " zorlayici varyantin hepsi deny (acik kalan " +
    ZORLAMA_PUSH.filter((komut) => etki(mimarBirlestirilmis, "shell", komut) !== "deny").length + ")",
  ZORLAMA_PUSH.filter((komut) => etki(mimarBirlestirilmis, "shell", komut) !== "deny"),
  [],
)

// (d) Yetki DEVRETMEDEN: operator normal push'u HALE deny kalmali.
const operatorIzin = rolKurallari.get("crew/operator.md") ?? []
check(
  "crew/operator: normal push YINE deny (yayin yetkisi devredilmedi)",
  etki([...configKurallar, ...operatorIzin], "shell", "git push origin main"),
  "deny",
)

// (e) Orkestrasyon kapilari yeni kuralin ALTINDA kalmali (son iki kural).
check(
  "architect: yayin izni orkestrasyon kapilarini son iki yerden etmedi",
  mimarIzin.slice(-2).map((k) => k.action + ":" + k.effect),
  ["orchestra_report:allow", "orchestra_task:allow"],
)

// (f) AGENTS.md: frontmatter `description` TIRNAK ICINDE olmali. Tirnak
//     disinda kalan bir aciklamada ": " gecerse YAML sessizce bozulur ve rol
//     `primary` olarak yuklenmez. Duz metin denetimi; YAML kutuphanesi yok.
const mimarAciklamaSatiri = readFileSync(join(KOK, ".opencode", "agents", "architect.md"), "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("description:"))
check("architect: frontmatter description'i tirnak icinde", /^description:\s+".+"$/.test(mimarAciklamaSatiri ?? ""), true)

console.log("")
console.log("SONUC: " + pass + " gecti, " + fail + " kaldi")
process.exit(fail === 0 ? 0 : 1)