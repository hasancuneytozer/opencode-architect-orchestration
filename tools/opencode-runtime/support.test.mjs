/**
 * tools/opencode-runtime/support.test.mjs · saf yardimci testleri.
 *
 * Run: node --test tools/opencode-runtime/support.test.mjs
 *      (veya `npm run test:local-runtime` — patch.mjs testleriyle birlikte)
 *
 * Kapsam: anchor sayimi, ortam izolasyonu, sifre maskeleme, nonce eslesmesi, yol kacisi,
 * OZEL/hafiza dizini, surum sabitlemesi. Ag yok, npm yok, kurulum yok, global kurulum yok,
 * gercek sunucu yok. Yalniz `mkdtemp` + saf fonksiyonlar; gercek plugin kaynagi SALT OKUNUR.
 *
 * Bu testler bir seyi KANITLAMAZ: yerel sunucunun gercekten ayaga kalktigini. O icin
 * `npm run opencode:local:start` sonrasi `status` gerekir.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, parse, resolve, sep } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

import { ORIGINAL_SHA256, PATCHED_SHA256 } from "./patch.mjs"
import {
  DISABLED_PLUGIN_ID,
  GENERATED_PLUGIN_ALIAS,
  GENERATED_PLUGIN_ID,
  ID_ANCHOR,
  ID_REPLACEMENT,
  INDEX_FILE,
  MAX_REPORTED_WARNINGS,
  MEMORY_ANCHOR,
  MEMORY_REPLACEMENT,
  MIN_NODE_MAJOR,
  NODE_EXE_SHA256,
  ORIGINAL_PLUGIN_ID,
  OWN_OPENCODE_ENV,
  PINNED,
  PLUGIN_SOURCE_FILES,
  REDACTED,
  REQUIRED_DIAGNOSTIC_STEPS,
  autoDownloadSupported,
  configContent,
  generatedPackageJson,
  makeEnvironment,
  mirrorPlan,
  nodeExeSha256,
  nodeExeUrl,
  projectHash,
  projectPaths,
  redactState,
  runtimePaths,
  singleReplace,
  transformIndexText,
  validateIdentity,
  verifyDiagnostics,
  verifyPluginInventory,
} from "./support.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL_INDEX = resolve(HERE, "..", "..", ".opencode", "plugins", "orchestra", "index.ts")
const MANIFEST = resolve(HERE, "runtime-package.json")
const NONCE = "f".repeat(32)
const PASSWORD = "p".repeat(64)

const dirs = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
function tempRoot(prefix = "orchestra-support-") {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function identity(root, nonce = NONCE) {
  const state = {
    pid: 4242,
    url: "http://127.0.0.1:51234",
    nonce,
    projectRoot: root,
    coreSha256: PATCHED_SHA256,
    password: PASSWORD,
    startedAt: "2026-01-01T00:00:00.000Z",
  }
  const info = { pid: state.pid, url: state.url, nonce, projectRoot: root, coreSha: PATCHED_SHA256 }
  return { state, info }
}

// ── yollar ────────────────────────────────────────────────────────────────────────────────

test("projectPaths: her turetilmis yol runtime altinda kalir", () => {
  const root = tempRoot()
  const paths = projectPaths(root)
  const keys = [
    "runtimePackage", "nodeModules", "corePackage", "pluginPackage", "binDir", "nodeExe", "patchDir",
    "stateDir", "instanceFile", "database", "logsDir", "serverLog", "pluginsDir", "generatedPackageFile",
    "mirroredPluginDir", "memoryDir", "projectMemory", "home", "dataHome", "cacheHome", "stateHome",
    "configHome", "tmpDir", "npmCache",
  ]
  for (const key of keys)
    assert.ok(paths[key].startsWith(paths.runtime + sep), `${key} runtime disina kacti: ${paths[key]}`)
  assert.equal(paths.root, resolve(root))
  assert.equal(paths.projectMemory, join(paths.runtime, "memory", projectHash(root)))
  assert.equal(paths.database, join(paths.runtime, "state", "project.sqlite"), "veritabani runtime'a acikca yazilmali")
  assert.equal(paths.serverScript, join(HERE, "server.mjs"))
  assert.notEqual(paths.projectMemory, paths.mirroredPluginDir)
  assert.ok(paths.mirroredPluginDir.startsWith(paths.pluginsDir + sep))
  assert.ok(paths.generatedPackageFile.startsWith(paths.pluginsDir + sep))
})

test("projectHash: kararli, kisaltilmis ve kok degisince degisir", () => {
  const root = tempRoot()
  const hash = projectHash(root)
  assert.match(hash, /^[0-9a-f]{16}$/)
  assert.equal(projectHash(root), hash)
  assert.equal(projectHash(resolve(root)), hash)
  assert.notEqual(projectHash(tempRoot()), hash)
  if (process.platform === "win32") assert.equal(projectHash(root.toUpperCase()), hash)
})

test("runtimePaths: acik runtime dizini proje varsayilanini ezebilir", () => {
  const root = tempRoot()
  const custom = join(tempRoot(), "ozel-runtime")
  const paths = runtimePaths(root, custom)
  assert.equal(paths.runtime, resolve(custom))
  assert.ok(paths.projectMemory.startsWith(resolve(custom) + sep))
  assert.equal(paths.root, resolve(root))
  assert.throws(() => runtimePaths(""), /root gerekli/)
})

// ── anchor'lar ────────────────────────────────────────────────────────────────────────────

test("gercek index.ts'te her anchor TAM OLARAK bir kez geciyor", () => {
  const text = readFileSync(REAL_INDEX, "utf8")
  assert.equal(text.split(ID_ANCHOR).length - 1, 1, "id anchoru kaymis")
  assert.equal(text.split(MEMORY_ANCHOR).length - 1, 1, "Memory anchoru kaymis")
  const patched = transformIndexText(text)
  assert.ok(patched.includes(ID_REPLACEMENT))
  assert.ok(patched.includes(MEMORY_REPLACEMENT))
  assert.ok(!patched.includes(ID_ANCHOR))
  assert.ok(!patched.includes(MEMORY_ANCHOR))
  // disi kirpma yok: yalniz iki satir degisti
  assert.equal(patched.split("\n").length, text.split("\n").length)
  assert.ok(!patched.includes('".opencode", "memory"'), "proje hafizasi okunmamali")
})

test("singleReplace: 0 veya >1 eslesme reddedilir (sessiz ilk-eslesme hatasi olmaz)", () => {
  assert.equal(singleReplace("aXa", "X", "Y"), "aYa")
  assert.throws(() => singleReplace("aaa", "X", "Y"), /0 kez/)
  assert.throws(() => singleReplace("aXaXa", "X", "Y"), /2 kez/)
  assert.throws(() => singleReplace("aXa", "", "Y"), /anchor gerekli/)
  assert.throws(() => singleReplace(42, "X", "Y"), /metin olmali/)
  // anchor, replacement icinde gecebilir: sayim girdi metnine bakar
  assert.equal(singleReplace("X", "X", "XX"), "XX")
})

test("transformIndexText: tek bir kayma sessizce gecmez", () => {
  // id anchor iki kez
  assert.throws(() => transformIndexText(`${ID_ANCHOR}\n${ID_ANCHOR}\n${MEMORY_ANCHOR}`), /2 kez/)
  // Memory anchor hic yok (dosya kirpilmis kopyadan kopyalanmis olabilir)
  assert.throws(() => transformIndexText(`${ID_ANCHOR}\n`), /0 kez/)
  // id anchor hic yok
  assert.throws(() => transformIndexText(MEMORY_ANCHOR), /0 kez/)
})

test("mirrorPlan: yalniz alti kaynak dosyasi, yalniz index.ts kirpilir", () => {
  const root = tempRoot()
  const plan = mirrorPlan(root, join(root, ".orchestra-runtime"))
  assert.deepEqual(plan.map((item) => item.file), PLUGIN_SOURCE_FILES)
  assert.deepEqual(plan.filter((item) => item.transformed).map((item) => item.file), ["index.ts"])
  const sourceRoot = join(resolve(root), ".opencode", "plugins", "orchestra") + sep
  const memoryData = join(resolve(root), ".opencode", "memory") + sep
  for (const item of plan) {
    assert.ok(item.source.startsWith(sourceRoot), item.source)
    assert.ok(item.target.endsWith(`${sep}orchestra${sep}${item.file}`), item.target)
    // HAFIZA VERISI (`.opencode/memory`) asla kirpilmaz; `memory.ts` yalnizca plugin kodu
    assert.ok(!item.source.startsWith(memoryData), item.source)
    assert.ok(!item.target.includes(".opencode"), item.target)
  }
})

test("uretilen package.json kirpilmis index'i gosterir", () => {
  const pkg = JSON.parse(generatedPackageJson())
  assert.equal(pkg.private, true)
  assert.equal(pkg.main, "./orchestra/index.ts")
  assert.deepEqual(pkg.exports, { ".": "./orchestra/index.ts" })
})

// ── config icerigi ────────────────────────────────────────────────────────────────────────

test("configContent: yerlesik id kapanir, uretilen dizin acilir (dizin, index dosyasi degil)", () => {
  const dir = resolve(tempRoot(), "plugins")
  const parsed = JSON.parse(configContent(dir))
  assert.deepEqual(parsed.plugins, [`-${DISABLED_PLUGIN_ID}`, { package: dir }])
  assert.ok(!parsed.plugins[1].package.endsWith(".ts"))
  assert.ok(!("model" in parsed), "model burada tahmin edilmemeli; proje config'i gecerli kalmali")
  assert.throws(() => configContent("relative/plugins"), /mutlak yol gerekli/)
  assert.notEqual(GENERATED_PLUGIN_ID, DISABLED_PLUGIN_ID, "kirpilan kopya farkli id tasimali")
})

// ── ortam izolasyonu ──────────────────────────────────────────────────────────────────────

const BASE_ENV = {
  PATH: "C:/nodejs",
  HOME: "C:/Users/x",
  USERPROFILE: "C:/Users/x",
  TEMP: "C:/Users/x/AppData/Local/Temp",
  OPENCODE_CONFIG: "C:/Users/x/AppData/Roaming/opencode/opencode.json",
  OPENCODE_CONFIG_DIR: "C:/Users/x/AppData/Roaming/opencode",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  opencode_session: "global-session",
  OPENCODE_DB: "C:/global/profile.sqlite",
  APPDATA: "C:/Users/x/AppData/Roaming",
  LOCALAPPDATA: "C:/Users/x/AppData/Local",
  HOMEDRIVE: "C:",
  HOMEPATH: "/Users/x",
  OPENCODE_API_KEY: "sk-user-base-url",
  OPENCODE_API_KEY_URL: "https://provider.invalid/v1",
  ANTHROPIC_API_KEY: "ak-user",
}

test("makeEnvironment: global OPENCODE_* dusurulur, profil ve gecici dosyalar runtime'a tasinir", () => {
  const root = tempRoot()
  const paths = projectPaths(root)
  const env = makeEnvironment(root, paths.runtime, { password: PASSWORD, nonce: NONCE }, BASE_ENV)

  for (const gone of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_DISABLE_AUTOUPDATE", "opencode_session"]) {
    assert.equal(env[gone], undefined, `${gone} sizmamali`)
  }
  const leaked = Object.keys(env).filter((key) => key.toUpperCase().startsWith("OPENCODE_") && !OWN_OPENCODE_ENV.includes(key.toUpperCase()))
  assert.deepEqual(leaked, [], `beklenmeyen OPENCODE_* anahtari: ${leaked.join(", ")}`)

  assert.equal(env.HOME, paths.home)
  assert.equal(env.USERPROFILE, paths.home)
  assert.equal(env.OPENCODE_TEST_HOME, paths.home)
  assert.equal(env.OPENCODE_DB, paths.database, "kendi DB'miz yazilmali")
  assert.notEqual(env.OPENCODE_DB, BASE_ENV.OPENCODE_DB, "miras alinan global DB ASLA iletilmemeli")
  assert.equal(env.APPDATA, paths.dataHome)
  assert.equal(env.LOCALAPPDATA, paths.dataHome)
  const homeStem = parse(paths.home).root.replace(/[\\/]+$/, "")
  assert.equal(env.HOMEDRIVE, homeStem)
  assert.equal(env.HOMEPATH, paths.home.slice(homeStem.length))
  assert.notEqual(`${env.HOMEDRIVE}${env.HOMEPATH}`, `${BASE_ENV.HOMEDRIVE}${BASE_ENV.HOMEPATH}`)
  assert.equal(env.XDG_DATA_HOME, paths.dataHome)
  assert.equal(env.TMPDIR, paths.tmpDir)
  assert.equal(env.TEMP, paths.tmpDir)
  assert.equal(env.npm_config_cache, undefined, "npm cache tanimi kumandanaya girmez")

  assert.equal(env.ORCHESTRA_RUNTIME_DIR, paths.runtime)
  assert.equal(env.ORCHESTRA_PROJECT_ROOT, paths.root)
  assert.equal(env.ORCHESTRA_INSTANCE_NONCE, NONCE)
  assert.equal(env.ORCHESTRA_PROJECT_MEMORY, paths.projectMemory)
  assert.ok(env.ORCHESTRA_PROJECT_MEMORY.startsWith(paths.runtime + sep))
  assert.notEqual(env.ORCHESTRA_PROJECT_MEMORY, resolve(root, ".opencode", "memory"))

  // saglayici kimlik bilgileri ENV'DEN gelir; kimlik dosyalari kopyalanmaz
  assert.equal(env.OPENCODE_API_KEY, "sk-user-base-url")
  assert.equal(env.OPENCODE_API_KEY_URL, "https://provider.invalid/v1")
  assert.equal(env.ANTHROPIC_API_KEY, "ak-user")
  assert.equal(env.PATH, BASE_ENV.PATH)
})

test("makeEnvironment: config icerigi uretilen dizini gosterir, parola argv/gunluk disinda kalir", () => {
  const root = tempRoot()
  const paths = projectPaths(root)
  const env = makeEnvironment(root, paths.runtime, { password: PASSWORD, nonce: NONCE }, BASE_ENV)
  assert.equal(env.OPENCODE_SERVER_PASSWORD, PASSWORD)
  const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
  assert.deepEqual(parsed.plugins, ["-orchestra", { package: paths.mirroredPluginDir }])
  assert.notEqual(
    parsed.plugins[1].package,
    paths.pluginsDir,
    "native Host ust klasoru cozmez; index.ts'i dogrudan iceren dizin verilmeli",
  )
  assert.ok(!env.OPENCODE_CONFIG_CONTENT.includes(PASSWORD))
})

test("makeEnvironment: iki runtime birbirine sizmaz ve taban ortamı degistirmez", () => {
  const rootA = tempRoot()
  const rootB = tempRoot()
  const pathsA = projectPaths(rootA)
  const pathsB = projectPaths(rootB)
  const envA = makeEnvironment(rootA, pathsA.runtime, { password: PASSWORD, nonce: NONCE }, BASE_ENV)
  const envB = makeEnvironment(rootB, pathsB.runtime, { password: "q".repeat(64), nonce: "a".repeat(32) }, BASE_ENV)

  assert.ok(!JSON.stringify(envA).includes("q".repeat(64)))
  assert.ok(!JSON.stringify(envA).includes(pathsB.runtime))
  assert.ok(!JSON.stringify(envB).includes(PASSWORD))
  assert.ok(!envA.ORCHESTRA_PROJECT_MEMORY.includes(pathsB.runtime))
  assert.equal(envA.ORCHESTRA_PROJECT_MEMORY, pathsA.projectMemory)
  assert.notEqual(envA.ORCHESTRA_PROJECT_MEMORY, envB.ORCHESTRA_PROJECT_MEMORY)

  const before = JSON.stringify(BASE_ENV)
  makeEnvironment(rootA, pathsA.runtime, { password: PASSWORD, nonce: NONCE }, BASE_ENV)
  assert.equal(JSON.stringify(BASE_ENV), before, "taban ortam nesnesi degistirilmemeli")

  assert.throws(() => makeEnvironment(rootA, pathsA.runtime, { password: "kisa", nonce: NONCE }, {}), /password gerekli/)
  assert.throws(() => makeEnvironment(rootA, pathsA.runtime, { password: PASSWORD, nonce: "" }, {}), /nonce gerekli/)
})

// ── sifre maskeleme ───────────────────────────────────────────────────────────────────────

test("redactState: sirlar isaret olur, yararli alanlar korunur", () => {
  const { state } = identity(tempRoot())
  const redacted = redactState(state)
  const dumped = JSON.stringify(redacted)
  assert.ok(!dumped.includes(PASSWORD))
  assert.ok(!dumped.includes(state.nonce))
  assert.equal(redacted.password, REDACTED)
  assert.equal(redacted.nonce, REDACTED)
  assert.equal(redacted.url, state.url)
  assert.equal(redacted.pid, state.pid)
  assert.equal(state.password, PASSWORD, "girdi nesnesi degistirilmemeli")

  const nested = redactState({ a: { b: [{ apiKey: "k", token: "t" }] }, keep: 1 })
  assert.equal(nested.a.b[0].apiKey, REDACTED)
  assert.equal(nested.a.b[0].token, REDACTED)
  assert.equal(nested.keep, 1)
  assert.equal(redactState(null), null)
  assert.equal(redactState("düz"), "düz")
})

// ── kimlik dogrulama ──────────────────────────────────────────────────────────────────────

test("validateIdentity: eslesen state + info kabul edilir", () => {
  const root = tempRoot()
  const { state, info } = identity(root)
  assert.equal(validateIdentity(state, info, root, PATCHED_SHA256, NONCE), true)
  assert.equal(validateIdentity(state, { ...info, coreSha256: PATCHED_SHA256 }, root, PATCHED_SHA256), true)
})

test("validateIdentity: nonce, pid, host ve hash uyusmazligi FAIL-CLOSED", () => {
  const root = tempRoot()
  const other = tempRoot()
  const { state, info } = identity(root)
  // [beklenen hata deseni, state, info, expectedNonce]
  const cases = [
    ["nonce eslesmedi", state, { ...info, nonce: "b".repeat(32) }, NONCE],
    ["nonce beklenenden farkli", { ...state, nonce: "b".repeat(32) }, { ...info, nonce: "b".repeat(32) }, NONCE],
    ["nonce eksik", { ...state, nonce: "" }, info, NONCE],
    ["pid eslesmedi", state, { ...info, pid: 1 }, NONCE],
    ["pid gecersiz", { ...state, pid: 0 }, info, NONCE],
    ["url eslesmedi", { ...state, url: "http://127.0.0.1:5555" }, info, NONCE],
    [
      "127.0.0.1",
      { ...state, url: "http://localhost:51234" },
      { ...info, url: "http://localhost:51234" },
      NONCE,
    ],
    [
      "protokol",
      { ...state, url: "https://127.0.0.1:51234" },
      { ...info, url: "https://127.0.0.1:51234" },
      NONCE,
    ],
    ["beklenen projeyi gostermiyor", state, { ...info, projectRoot: other }, NONCE],
    ["state.projectRoot eksik", { ...state, projectRoot: undefined }, info, NONCE],
    ["cekirdek hash", state, { ...info, coreSha: ORIGINAL_SHA256 }, NONCE],
    ["beklenen degil", { ...state, coreSha256: ORIGINAL_SHA256 }, info, NONCE],
    ["expectedHash gecersiz", state, info, NONCE, "kisa-hash"],
    ["nesne degil", [], info, NONCE],
  ]
  for (const [pattern, s, i, expectedNonce, expectedHash = PATCHED_SHA256] of cases) {
    assert.throws(
      () => validateIdentity(s, i, root, expectedHash, expectedNonce),
      new RegExp(pattern),
      `bu durum ${pattern} hatasi vermeliydi`,
    )
  }
  // hata mesaji hicbir sir tasiyamaz
  try {
    validateIdentity(state, { ...info, nonce: "b".repeat(32) }, root, PATCHED_SHA256, NONCE)
  } catch (err) {
    assert.ok(!err.message.includes(PASSWORD))
    assert.ok(!err.message.includes(NONCE))
    assert.ok(!err.message.includes("b".repeat(32)))
  }
})

// ── sabitleme ────────────────────────────────────────────────────────────────────────────

test("runtime-package.json ve support sabitlemeleri ayni surumleri gosteriyor", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"))
  assert.deepEqual(manifest.dependencies, {
    "@opencode/core": PINNED.core,
    "@opencode/server": PINNED.server,
    "@opencode/sdk": PINNED.sdk,
    "@opencode/plugin": PINNED.plugin,
  })
  assert.deepEqual(PINNED, { core: "2.0.18", server: "2.0.18", sdk: "2.0.18", plugin: "2.0.20", node: "24.21.0" })
  for (const [name, version] of Object.entries(manifest.dependencies))
    assert.ok(!version.startsWith("^") && !version.startsWith("~"), `${name} sabitlenmemis: ${version}`)
  assert.equal(manifest.private, true)
})

test("Node indirmesi yalniz kanitli platformda; hash 64 haneli ve URL surumlu", () => {
  assert.deepEqual(Object.keys(NODE_EXE_SHA256), ["win-x64"])
  assert.equal(autoDownloadSupported("win32", "x64"), true)
  assert.equal(autoDownloadSupported("linux", "x64"), false)
  assert.equal(autoDownloadSupported("darwin", "arm64"), false)
  assert.equal(autoDownloadSupported("win32", "arm64"), false)
  assert.match(nodeExeSha256("win32", "x64"), /^[0-9a-f]{64}$/)
  assert.throws(() => nodeExeSha256("linux", "x64"), /kanitli/)
  assert.equal(nodeExeUrl("win32", "x64"), `https://nodejs.org/dist/v${PINNED.node}/win-x64/node.exe`)
  assert.equal(MIN_NODE_MAJOR, 24)
})

test("verifyPluginInventory: yalniz kirpilan kopya, tam bir kez ve active", () => {
  const list = [
    { id: "baska-biri", state: { status: "active" } },
    { id: GENERATED_PLUGIN_ALIAS, state: { status: "active" } },
  ]
  const out = verifyPluginInventory(list)
  assert.deepEqual(out, { id: GENERATED_PLUGIN_ALIAS, state: "active", originalDisabled: true, inventorySize: 2 })

  assert.throws(() => verifyPluginInventory([{ id: GENERATED_PLUGIN_ALIAS, state: { status: "failed" } }]), /'active' olmali/)
  assert.throws(() => verifyPluginInventory([{ id: GENERATED_PLUGIN_ALIAS, state: {} }]), /'active' olmali/)
  assert.throws(() => verifyPluginInventory([]), /0 kez listelendi/)
  assert.throws(
    () => verifyPluginInventory([{ id: GENERATED_PLUGIN_ALIAS, state: { status: "active" } }, { id: GENERATED_PLUGIN_ALIAS, state: { status: "active" } }]),
    /2 kez listelendi/,
  )
  assert.throws(() => verifyPluginInventory({ data: [] }), /dizi degil/)
  assert.throws(() => verifyPluginInventory(null), /dizi degil/)
  assert.throws(() => verifyPluginInventory(undefined), /dizi degil/)
})

test("verifyPluginInventory: yerlesik kimlik her durumda reddedilir, hata metni sirmaz", () => {
  assert.equal(ORIGINAL_PLUGIN_ID, DISABLED_PLUGIN_ID, "capalan kimlik, config anahtariyla ayni olmali")
  assert.notEqual(ORIGINAL_PLUGIN_ID, GENERATED_PLUGIN_ALIAS)
  const alias = { id: GENERATED_PLUGIN_ALIAS, state: { status: "active" } }
  for (const status of ["active", "failed"]) {
    assert.throws(
      () => verifyPluginInventory([alias, { id: ORIGINAL_PLUGIN_ID, state: { status } }]),
      new RegExp(`yerlesik plugin listede \\(id orchestra, durum ${status}`),
    )
  }
  // plugin hata metni rapora sizmaz
  try {
    verifyPluginInventory([{ id: ORIGINAL_PLUGIN_ID, state: { status: "failed", error: "sekret-token-123" } }])
    assert.fail("reddedilmeliydi")
  } catch (err) {
    assert.ok(!err.message.includes("sekret"), err.message)
    assert.ok(!err.message.includes("token"), err.message)
  }
})

const STEPS_OK = { tools: "ok", loop: "ok", fallback: "ok", tasks: "ok" }

test("verifyDiagnostics: dort adim da tam ok olmali", () => {
  const out = verifyDiagnostics({ diagnostics: { steps: { ...STEPS_OK }, warns: [] } })
  for (const step of REQUIRED_DIAGNOSTIC_STEPS) assert.equal(out[step], "ok")
  assert.deepEqual(out.warns, [])
  assert.equal(out.warnsTotal, 0)

  assert.throws(() => verifyDiagnostics({}), /diagnostics.steps yok/)
  assert.throws(() => verifyDiagnostics({ diagnostics: {} }), /diagnostics.steps yok/)
  assert.throws(() => verifyDiagnostics({ diagnostics: { steps: null } }), /diagnostics.steps yok/)
  assert.throws(() => verifyDiagnostics({ diagnostics: { steps: [] } }), /diagnostics.steps yok/)
  // eksik adim
  assert.throws(
    () => verifyDiagnostics({ diagnostics: { steps: { tools: "ok", loop: "ok", fallback: "ok" } } }),
    /tasks=null/,
  )
  // bozuk adim
  assert.throws(
    () => verifyDiagnostics({ diagnostics: { steps: { ...STEPS_OK, loop: "skip" } } }),
    /loop="skip"/,
  )
})

test("verifyDiagnostics: warns kisaltilir, girdi degistirilmez", () => {
  const many = Array.from({ length: 9 }, (_, i) => `uyari ${i}`)
  const state = { diagnostics: { steps: { ...STEPS_OK }, warns: many } }
  const out = verifyDiagnostics(state)
  assert.equal(out.warnsTotal, 9)
  assert.equal(out.warns.length, MAX_REPORTED_WARNINGS)
  assert.deepEqual(out.warns, many.slice(0, MAX_REPORTED_WARNINGS))
  assert.equal(state.diagnostics.warns.length, 9, "girdi degistirilmemeli")

  const alt = { diagnostics: { steps: { ...STEPS_OK }, warnings: ["x"] } }
  assert.equal(verifyDiagnostics(alt).warnsTotal, 1)
})

test("native Host sozlesmesi: package degeri index.ts'i DOGRUDAN iceren dizin", () => {
  const root = tempRoot()
  const paths = projectPaths(root)
  const indexTarget = mirrorPlan(root, paths.runtime).find((item) => item.file === INDEX_FILE).target

  // Host `directory/index.*` cozer; bu yuzden package degeri `mirroredPluginDir` OLMALI.
  assert.equal(paths.mirroredPluginDir, join(paths.pluginsDir, "orchestra"))
  assert.equal(join(paths.mirroredPluginDir, INDEX_FILE), indexTarget, "kirpilan index.ts dogrudan giris altinda")
  assert.notEqual(join(paths.pluginsDir, INDEX_FILE), indexTarget, "ust klasor entry'sizdir: sessiz bos liste")

  const env = makeEnvironment(root, paths.runtime, { password: PASSWORD, nonce: NONCE }, BASE_ENV)
  const pkgDir = JSON.parse(env.OPENCODE_CONFIG_CONTENT).plugins[1].package
  assert.equal(pkgDir, paths.mirroredPluginDir, "config gercekten dogrudan giris dizinini gostermeli")
  assert.equal(join(pkgDir, INDEX_FILE), indexTarget)
  assert.equal(dirname(pkgDir), paths.pluginsDir, "kaynak klasor de plugins olmali; ic ice paket yazimi yok")
})
