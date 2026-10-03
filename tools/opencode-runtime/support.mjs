#!/usr/bin/env node
/**
 * orchestra-project-opencode-runtime · SAF yardimcilar.
 *
 * Buradaki her fonksiyon dosya sistemine YAZMAZ ve ag erisimi kurmaz; `projectPaths`,
 * `singleReplace`, `configContent`, `generatedPackageJson` saf veri uretir, `makeEnvironment`
 * saf bir ortam nesnesi kurar, `redactState` kopyalar, `validateIdentity` yalnizca OKUR ve
 * eslesmezse HATA FIRLATIR. Bu ayrim bilincli: `local.mjs` tek yazan yuzey, bu dosya test
 * edilebilir cekirdek.
 *
 * Iki cift TIKANAK burada sabitlenmistir; ikisi de kirpilan (mirror) plugin kaynaginda
 * TAM OLARAK BIRER kez gecmelidir:
 *
 *   1. `id: "orchestra",`  ->  `id:"orchestra.project-local",`
 *      Config `plugins: ["-orchestra", …]` ile YERLESIK plugin'i kapatir; kirpilan kopya
 *      farkli id tasidigi icin ayni listede yasamaya devam eder. Iki kopya ayni id'yi
 *      tasisaydi `-orchestra` ikisini de sustururdu.
 *   2. `Memory.open(path.join(ctx.location.directory, ".opencode", "memory"))`
 *      ->  `Memory.open(process.env.ORCHESTRA_PROJECT_MEMORY)`
 *      Proje-yerel hafiza; `.opencode/memory` ASLA okunmaz/yazilmaz. Ortam degeri `start`
 *      tarafindan her zaman atanir; atanmazsa `Memory.open(undefined)` icinde hata verir,
 *      yani sessizce yanlis dizine yazmak yerine gorunur sekilde durur.
 *
 * `id` ve `Memory` kirpilmasi yalnizca `index.ts` icindir; diger dosyalar bayt bayt kopyalanir.
 */
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { dirname, isAbsolute, join, parse, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, "..", "..")

/** Tum durum bu dizinin altinda; depo disina cikmasina izin verilmez. */
export const RUNTIME_DIR_NAME = ".orchestra-runtime"
/** P5'in sunucu betigi. `local.mjs` yalnizca bu yola spawn eder. */
export const SERVER_SCRIPT_NAME = "server.mjs"
/** Kaynak plugin dizini. YALNIZCA okunur; hafiza dizini icermez. */
export const SOURCE_PLUGIN_DIR_REL = [".opencode", "plugins", "orchestra"]
/** Kirpilan dosyalar: bunun disindaki hicbir sey kopyalanmaz. */
export const PLUGIN_SOURCE_FILES = ["index.ts", "memory.ts", "loop.ts", "fallback.ts", "tasks.ts", "tools.ts"]
export const INDEX_FILE = "index.ts"
export const MIRRORED_PLUGIN_DIR_NAME = "orchestra"

export const DISABLED_PLUGIN_ID = "orchestra"
export const GENERATED_PLUGIN_ID = "orchestra.project-local"
export const GENERATED_PACKAGE_NAME = "orchestra-project-local-plugin"

export const ID_ANCHOR = 'id: "orchestra",'
export const ID_REPLACEMENT = 'id:"orchestra.project-local",'
export const MEMORY_ANCHOR = 'Memory.open(path.join(ctx.location.directory, ".opencode", "memory"))'
export const MEMORY_REPLACEMENT = "Memory.open(process.env.ORCHESTRA_PROJECT_MEMORY)"

/** Manifest `runtime-package.json` ile ayni sürümleri paylasir (pinned, asla `^`). */
export const PINNED = {
  core: "2.0.18",
  server: "2.0.18",
  sdk: "2.0.18",
  plugin: "2.0.20",
  node: "24.21.0",
}
export const MIN_NODE_MAJOR = 24
export const NODE_DIST_BASE = "https://nodejs.org/dist"

/**
 * Otomatik indirme YALNIZCA burada kanitli platform icindir.
 *
 * win-x64 `node.exe` dosyasinin sha256'si nodejs.org SHASUMS256.txt'ten alinmistir; indirme
 * SONRASI ve calistirilmadan ONCE dogrulanir. arm64 (dff59…) ve diger platformlar bilincli
 * olarak YOK: test edilmeyen bir hash'i "kaynak" diye gostermek, dogrulanmamis ikiliyi
 * calistirmaktan iyidir. O platformlarda sistem Node >= 24 veya `ORCHESTRA_NODE` gerekir.
 */
export const NODE_EXE_SHA256 = {
  "win-x64": "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32",
}

/** nodejs.org dagitim adlari platform kodundan FARKLIDIR: `win32` -> `win`. */
export function distPlatform(platform = process.platform) {
  return platform === "win32" ? "win" : platform
}

export function nodeExeUrl(platform = process.platform, arch = process.arch) {
  return `${NODE_DIST_BASE}/v${PINNED.node}/${distPlatform(platform)}-${arch}/node.exe`
}

/** Bu platformda otomatik indirme kanitli mi? */
export function autoDownloadSupported(platform = process.platform, arch = process.arch) {
  return Object.hasOwn(NODE_EXE_SHA256, `${distPlatform(platform)}-${arch}`)
}

export function nodeExeSha256(platform = process.platform, arch = process.arch) {
  const key = `${distPlatform(platform)}-${arch}`
  const sha = NODE_EXE_SHA256[key]
  if (!sha)
    throw new Error(
      `${key} icin kanitli Node ${PINNED.node} hash'i yok; ` +
        `sistemde Node >= ${MIN_NODE_MAJOR} kullan ya da ORCHESTRA_NODE ile mutlak yol ver`,
    )
  return sha
}

/** Klasor adi olarak kullanilabilir, kisaltilmis proje parmak izi (saf, fs'siz). */
export function projectHash(root) {
  const norm = resolve(root).split("\\").join("/")
  const key = process.platform === "win32" ? norm.toLowerCase() : norm
  return createHash("sha256").update(key).digest("hex").slice(0, 16)
}

/**
 * Tum yollari tek yerden uretir. `runtime` verilmezse `<root>/.orchestra-runtime`.
 * Saf: hicbir yolun var olup olmadigina bakmaz.
 */
export function runtimePaths(root, runtime) {
  if (typeof root !== "string" || root.trim() === "") throw new Error("runtimePaths: root gerekli")
  const repoRoot = resolve(root)
  const runtimeDir = resolve(runtime ?? join(repoRoot, RUNTIME_DIR_NAME))
  const home = join(runtimeDir, "home")
  const projectId = projectHash(repoRoot)
  return {
    root: repoRoot,
    projectId,
    runtime: runtimeDir,
    runtimePackage: join(runtimeDir, "package.json"),
    nodeModules: join(runtimeDir, "node_modules"),
    corePackage: join(runtimeDir, "node_modules", "@opencode", "core", "package.json"),
    pluginPackage: join(runtimeDir, "node_modules", "@opencode", "plugin", "package.json"),
    binDir: join(runtimeDir, "bin"),
    nodeExe: join(runtimeDir, "bin", process.platform === "win32" ? "node.exe" : "node"),
    patchDir: join(runtimeDir, "patch"),
    stateDir: join(runtimeDir, "state"),
    instanceFile: join(runtimeDir, "state", "instance.json"),
    // Veritabani ACIKCA yazilir: opencode varsayilani profil cozumlemesinden bulur; global
    // bir dosya devralinirsa iki calisma ayni DB'yi paylasir ve kirpilmamis kalinti olur.
    database: join(runtimeDir, "state", "project.sqlite"),
    logsDir: join(runtimeDir, "logs"),
    serverLog: join(runtimeDir, "logs", "server.log"),
    // `plugins` yalnizca UST klasordur. Configteki `{package:…}` degeri `mirroredPluginDir`
    // OLMALIDIR: native Host girdi dizininde `index.*` arar, `package.json` main/exports'i
    // GORMES (bkz. configContent). `generatedPackageFile` yalnizca ESM/metin metadata'si.
    pluginsDir: join(runtimeDir, "plugins"),
    generatedPackageFile: join(runtimeDir, "plugins", "package.json"),
    mirroredPluginDir: join(runtimeDir, "plugins", MIRRORED_PLUGIN_DIR_NAME),
    memoryDir: join(runtimeDir, "memory"),
    projectMemory: join(runtimeDir, "memory", projectId),
    home,
    dataHome: join(home, "data"),
    cacheHome: join(home, "cache"),
    stateHome: join(home, "state"),
    configHome: join(home, "config"),
    tmpDir: join(runtimeDir, "tmp"),
    npmCache: join(runtimeDir, "npm-cache"),
    sourcePluginDir: join(repoRoot, ...SOURCE_PLUGIN_DIR_REL),
    orchestraConfig: join(repoRoot, ".opencode", "orchestra.json"),
    repoConfig: join(repoRoot, "opencode.jsonc"),
    serverScript: join(HERE, SERVER_SCRIPT_NAME),
  }
}

/** `projectPaths(root)` — varsayilan runtime diziniyle. */
export function projectPaths(root) {
  return runtimePaths(root, undefined)
}

/**
 * Anchor'i TAM OLARAK bir kez degistirir. 0 veya >1 eslesme reddedilir: sessizce hicbir
 * sey yazmaktan ya da yanlis yeri degistirmekten iyidir. `String.replace` zaten ilkini
 * degistirir; buradaki sayim olmadan "ilk eslesmeyi degistirdim" sessiz hatasi olurdu.
 */
export function singleReplace(input, anchor, replacement) {
  if (typeof input !== "string") throw new Error("singleReplace: input metin olmali")
  if (typeof anchor !== "string" || anchor === "") throw new Error("singleReplace: anchor gerekli")
  if (typeof replacement !== "string") throw new Error("singleReplace: replacement gerekli")
  const count = input.split(anchor).length - 1
  if (count !== 1)
    throw new Error(`anchor ${count} kez bulundu, tam 1 olmali: ${JSON.stringify(anchor.slice(0, 60))}`)
  return input.replace(anchor, replacement)
}

/** `index.ts` metnine uygulanacak iki kirpma. Sira onemsiz, sayim onemli. */
export function transformIndexText(text) {
  return singleReplace(singleReplace(text, ID_ANCHOR, ID_REPLACEMENT), MEMORY_ANCHOR, MEMORY_REPLACEMENT)
}

/** Kopyalanacak dosyalarin saf plani (fs'siz); testler bunu dogrudan dogrular. */
export function mirrorPlan(root, runtime) {
  const paths = runtimePaths(root, runtime)
  return PLUGIN_SOURCE_FILES.map((file) => ({
    file,
    source: join(paths.sourcePluginDir, file),
    target: join(paths.mirroredPluginDir, file),
    transformed: file === INDEX_FILE,
  }))
}

/** ESM/metin metadata dosyasi. Native Host `main`/`exports` OKUMAZ (bkz. configContent): bu dosya acilisi SEBEBI DEGIL, yalnizca duzenli paket imzasi. */
export function generatedPackageJson() {
  const entry = `./${MIRRORED_PLUGIN_DIR_NAME}/${INDEX_FILE}`
  return `${JSON.stringify(
    {
      name: GENERATED_PACKAGE_NAME,
      version: "1.0.0",
      private: true,
      type: "module",
      main: entry,
      exports: { ".": entry },
    },
    null,
    2,
  )}\n`
}

/**
 * OPENCODE_CONFIG_CONTENT govdesi.
 *
 * Bu ortam degiskeni bir TASIYICIDIR: yerel sunucu (`server.mjs`) onu okuyup SDK'nin
 * `options.config.content` alanina gecer. Node SDK ortami KENDI okumaz.
 * `options.config.content` birlestirme zincirinde EN YUKSEK onceliktir; proje
 * `opencode.jsonc`'si ile birlestirilir, yalnizca `plugins` uzerine yazar (dizi birlestirmesi
 * additive: global config dizisi de korunur).
 * Burada model yazmazsak projenin mevcut modeli gecerli kalir (komutlar model tahmini yapmaz).
 * `plugins:["-orchestra",{package:<uretilen dizin>}]` iki is yapar: yerlesik kopyayi kapatir,
 * uretilen dizini acar.
 *
 * ONEMLI — native Host sozlesmesi: `{package:…}` degeri, girdi dosyasini DOGRUDAN iceren
 * dizin olmalidir. Host `directory/index(.ts|.js|…)` cozulecegi icin ust klasoru vermek
 * plugin'i SESSIZCE dusurur (core `plugin.js` uzerinden kanit: entry yok -> server `[]`
 * donuyor, hata yok). `package.json` `main`/`exports` alanlari bu yolda HIC kullanilmaz.
 */
export function configContent(generatedDir) {
  if (typeof generatedDir !== "string" || generatedDir.trim() === "") throw new Error("configContent: dizin gerekli")
  if (!isAbsolute(generatedDir)) throw new Error(`configContent: mutlak yol gerekli, ${generatedDir}`)
  return JSON.stringify({ plugins: [`-${DISABLED_PLUGIN_ID}`, { package: resolve(generatedDir) }] })
}

/** `makeEnvironment`in kendi yazdigi OPENCODE_* anahtarlari. */
export const OWN_OPENCODE_ENV = [
  "OPENCODE_TEST_HOME",
  "OPENCODE_DB",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_API_KEY",
  "OPENCODE_API_KEY_URL",
]

/**
 * Miras alinan OPENCODE_* icinde SADEce bunlar gecer. Anahtar tabanli saglayici kimlik
 * bilgileri ortamdan tasinir; bunlari silmek model erisimini sessizce dusururdu. Kimlik
 * dosyalari (auth.json) KOPYALANMAZ — yerel profilin girisi kullaniciya aittir.
 */
export const PRESERVED_OPENCODE_ENV = ["OPENCODE_API_KEY", "OPENCODE_API_KEY_URL"]

export function makeEnvironment(root, runtime, { password, nonce }, base = process.env) {
  if (typeof password !== "string" || password.length < 8)
    throw new Error("makeEnvironment: en az 8 karakterli password gerekli")
  if (typeof nonce !== "string" || nonce.length < 8) throw new Error("makeEnvironment: en az 8 karakterli nonce gerekli")
  const paths = runtimePaths(root, runtime)
  // Windows'ta profil cozumlemesi HOME/USERPROFILE yaninda HOMEDRIVE+HOMEPATH ciftini ve
  // APPDATA/LOCALAPPDATA'yi da okur; bunlar global kalirsa izolasyon delik kalir.
  // homeStem = "C:" (win) | "" (posix): HOMEPATH bu kadan sonra kalan kisimdir.
  const homeStem = parse(paths.home).root.replace(/[\\/]+$/, "")
  const out = {}
  for (const [key, value] of Object.entries(base ?? {})) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (!upper.startsWith("OPENCODE_")) {
      out[key] = value
      continue
    }
    // OPENCODE_CONFIG / OPENCODE_CONFIG_DIR / OPENCODE_SESSION / OPENCODE_DISABLE_* gibi
    // miras degerler dusurulur: hepsi global kuruluma aittir ve yerel runtime'i bozardi.
    if (PRESERVED_OPENCODE_ENV.includes(upper)) out[upper] = value
  }
  const own = {
    OPENCODE_TEST_HOME: paths.home,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CONFIG_CONTENT: configContent(paths.mirroredPluginDir),
    OPENCODE_DB: paths.database,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.dataHome,
    LOCALAPPDATA: paths.dataHome,
    HOMEDRIVE: homeStem,
    HOMEPATH: paths.home.slice(homeStem.length),
    XDG_DATA_HOME: paths.dataHome,
    XDG_CACHE_HOME: paths.cacheHome,
    XDG_STATE_HOME: paths.stateHome,
    XDG_CONFIG_HOME: paths.configHome,
    TMPDIR: paths.tmpDir,
    TMP: paths.tmpDir,
    TEMP: paths.tmpDir,
    ORCHESTRA_RUNTIME_DIR: paths.runtime,
    ORCHESTRA_PROJECT_ROOT: paths.root,
    ORCHESTRA_INSTANCE_NONCE: nonce,
    ORCHESTRA_PROJECT_MEMORY: paths.projectMemory,
  }
  for (const [key, value] of Object.entries(own)) out[key.toUpperCase()] = value
  return out
}

export const REDACTED = "[redacted]"
const SECRET_KEY = /(pass(word|wd)?|secret|token|nonce|api[-_]?key|credential|authorization)/i

function scrub(value, depth) {
  if (depth > 8) return "[derinlik limiti]"
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1))
  if (value && typeof value === "object") {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? REDACTED : scrub(item, depth + 1)
    return out
  }
  return value
}

/** `instance.json`i okunabilir/aktarilabilir hale getirir. Sirlar deger degil, isaret olur. */
export function redactState(state) {
  return scrub(state, 0)
}

function realOrFail(target, label, fail) {
  try {
    return realpathSync(resolve(target))
  } catch (err) {
    return fail(`${label} cozulemedi: ${err.message}`)
  }
}

/**
 * instance.json ile `/__orchestra_runtime/info` ayni sunucuyu mi gosteriyor? FAIL-CLOSED:
 * eslesmezse `false` donmek yerine hata firlatir, cunku "bilmiyorum" ile "hayir" ayni
 * sonuca goturmemelidir. `expectedNonce` verildiginde ek olarak kendi urettigimiz nonce ile
 * karsilastirilir — baska bir runtime'in state.json'i bu dosyaya yazilmissa yakalanir.
 *
 * Hata mesajlari hicbir sir yazmaz: sifre/nonce degerleri ASLA metne girmez.
 */
export function validateIdentity(state, info, root, expectedHash, expectedNonce) {
  const fail = (msg) => {
    throw new Error(`kimlik dogrulama basarisiz: ${msg}`)
  }
  const obj = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} nesne degil`)
    return value
  }
  const s = obj(state, "instance.json")
  const i = obj(info, "info yaniti")

  const pid = s.pid
  if (!Number.isInteger(pid) || pid <= 0) fail(`pid gecersiz: ${JSON.stringify(pid ?? null)}`)
  if (i.pid !== pid) fail(`pid eslesmedi (state ${pid}, info ${String(i.pid)})`)

  if (typeof s.url !== "string" || s.url === "" || i.url !== s.url)
    fail(`url eslesmedi (state ${String(s.url)}, info ${String(i.url)})`)
  let parsed
  try {
    parsed = new URL(s.url)
  } catch {
    fail(`url okunamadi: ${s.url}`)
  }
  if (parsed.protocol !== "http:") fail(`protokol http: olmali, ${parsed.protocol}`)
  if (parsed.hostname !== "127.0.0.1") fail(`yalnizca 127.0.0.1 dinlenir, ${parsed.hostname}`)
  if (!parsed.port) fail("url port icermiyor")

  if (typeof s.nonce !== "string" || s.nonce.length < 8) fail("nonce eksik veya gecersiz")
  if (i.nonce !== s.nonce) fail("nonce eslesmedi")
  if (expectedNonce !== undefined && s.nonce !== expectedNonce) fail("nonce beklenenden farkli")

  if (typeof expectedHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedHash)) fail("expectedHash gecersiz")
  const rootReal = realOrFail(root, "root", fail)
  for (const [label, value] of [
    ["state.projectRoot", s.projectRoot],
    ["info.projectRoot", i.projectRoot],
  ]) {
    if (typeof value !== "string" || value === "") fail(`${label} eksik`)
    if (realOrFail(value, label, fail) !== rootReal) fail(`${label} beklenen projeyi gostermiyor`)
  }
  const stateSha = s.coreSha256 ?? s.coreSha
  const infoSha = i.coreSha256 ?? i.coreSha
  if (stateSha !== expectedHash) fail(`state cekirdek hash ${String(stateSha)} beklenen degil`)
  if (infoSha !== expectedHash) fail(`info cekirdek hash ${String(infoSha)} beklenen degil`)
  return true
}

/** Native `/api/plugin` listesinde beklenen tek kimlik: kirpilan kopya. */
export const GENERATED_PLUGIN_ALIAS = GENERATED_PLUGIN_ID
/** Config de `-orchestra` ile kapatilmasi beklenen yerlesik kimlik. */
export const ORIGINAL_PLUGIN_ID = DISABLED_PLUGIN_ID
export const REQUIRED_DIAGNOSTIC_STEPS = ["tools", "loop", "fallback", "tasks"]
export const MAX_REPORTED_WARNINGS = 5

/**
 * `/api/plugin` yanitini kabul olcutune sokar (saf, fs'siz).
 *
 * Iki kosul birlikte zorunlu:
 *   1. kirpilan kopya (`orchestra.project-local`) listede TAM OLARAK bir kez ve `active`
 *   2. yerlesik kimlik (`orchestra`) listede HIC YOK. Kapali bir plugin'in listede nasil
 *      gorundugu belgelenmedi; bu yuzden `failed` olsa bile reddediyoruz: yalnizca
 *      "gorunmez" kanitlanabilir, "kapali" ileri surulur.
 *
 * Plugin hata metni (`state.error`) ASLA okunmaz: sirlari loga tasima riski. Rapor yalnizca
 * id + durum.
 *
 * Bu kontrolun degeri: native Host girdi dizininde `index.*` bulamazsa plugin YUKLENMEZ ve
 * liste BOS gelir. Saglam HTTP + bos liste "orkestra ayakta" demek DEGILDIR; olcutu kirilmaz.
 */
export function verifyPluginInventory(list) {
  if (!Array.isArray(list)) throw new Error("plugin listesi alinamadi (dizi degil)")
  const original = list.filter((item) => item?.id === ORIGINAL_PLUGIN_ID)
  if (original.length > 0)
    throw new Error(
      `yerlesik plugin listede (id ${ORIGINAL_PLUGIN_ID}, durum ${original.map((item) => String(item?.state?.status ?? "?")).join(",")}); -orchestra capi ise yaramadi`,
    )
  const ours = list.filter((item) => item?.id === GENERATED_PLUGIN_ALIAS)
  if (ours.length !== 1)
    throw new Error(`uretilen plugin ${GENERATED_PLUGIN_ALIAS} ${ours.length} kez listelendi, tam 1 olmali`)
  const status = ours[0]?.state?.status
  if (status !== "active")
    throw new Error(`uretilen plugin durumu ${JSON.stringify(status ?? null)}, 'active' olmali`)
  return { id: GENERATED_PLUGIN_ALIAS, state: status, originalDisabled: true, inventorySize: list.length }
}

/**
 * Ozel hafiza `state.json` -> `diagnostics.steps` dogrulamasi (saf).
 *
 * `tools/loop/fallback/tasks` dort adim TAM OLARAK "ok" olmali; eksik ya da baska deger
 * plugin'in yarim kuruldugunu kanitlar (donanim hazir ama orkestra yok). Dosya `.orchestra-
 * runtime/memory/<projectHash>` altinda oldugu icin bu kontrol ayni zamanda "hafiza gercekten
 * OZEL dizine yazildi" kanitidir.
 */
export function verifyDiagnostics(state) {
  const steps = state?.diagnostics?.steps
  if (!steps || typeof steps !== "object" || Array.isArray(steps))
    throw new Error("diagnostics.steps yok; plugin bosa yuklenmis olabilir")
  const ok = {}
  const bad = []
  for (const step of REQUIRED_DIAGNOSTIC_STEPS) {
    const value = steps[step]
    if (value === "ok") ok[step] = "ok"
    else bad.push(`${step}=${JSON.stringify(value ?? null)}`)
  }
  if (bad.length > 0) throw new Error(`plugin tanilari eksik/bozuk: ${bad.join(", ")}`)
  const warns = [state.diagnostics.warns, state.diagnostics.warnings].find((item) => Array.isArray(item)) ?? []
  return { ...ok, warns: warns.slice(0, MAX_REPORTED_WARNINGS), warnsTotal: warns.length }
}
