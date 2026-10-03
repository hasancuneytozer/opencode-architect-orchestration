#!/usr/bin/env node
/**
 * orchestra-project-opencode-runtime · yerel runtime kumandanasi.
 *
 * Amac: **global** opencode kurulumuna dokunmadan, ayni deponun icinde ikinci bir acik kod
 * runtime'i calistirmak. Genel kurulum (kullanicinin pid'i, ~/.local/share/opencode, global
 * yetenekler) aynen yasar; buradaki her sey `.orchestra-runtime/` altinda ve `.gitignore`'lidir.
 *
 * Komutlar: setup | start | status | stop | restore | attach
 *
 * Katlar:
 *   setup    runtime/package.json yazar, Node >= 24 cozer (gerekirse sabitlenmis Node indirir),
 *            SADECE bu runtime'a npm install yapar, sonra cekirdek yamasi uygular.
 *   start    HICBIR ag erisimi yoktur. Node/cozumleme/hash denetimi yapar, plugin'i kirpar,
 *            ayri bir Node 24 sureci baslatir ve kimligini kanitlayana kadar bekler.
 *   status   url/pid/surum/hash/hafiza yolu/Yetkilendirme VAR/YOK — parola veya token YOK.
 *   stop     Yalnizca HTTP `shutdown` + nonce korumasi. Surec isareti YOK, desenle oldurme YOK.
 *   restore  yalnizca cekirdek chunk'i geri alir. git/stash/kisisel veri DOKUNULMAZ.
 *   attach   kullanicinin opencode CLI'sini `--server <url>` ile baglar (kimlik dosyasi kopyalanmaz).
 *
 * Guvenlik sinirlari (hepsi fikirdir, "belki olur" degil):
 *   - baskasinin pid'i ASLA isaretlenmez. `kill` yalniz `start`in BIRAZ ONCE kendi dogurdugu
 *     cocuga, hata durumunda uygulanir (`child.kill()`).
 *   - calisan bir sunucu altinda `restore`/ikinci `start` reddedilir; otomatik yeniden baslatma
 *     veya supervisor YOKTUR.
 *   - kimlik dogrulama fail-closed'dur (`validateIdentity`): eslesmezse sessizce devam etmek
 *     yerine hata firlatir. `start` kendi urettigi nonce ile eslesmezse o instance.json'a
 *     dokunmaz.
 *   - global config/profil verisi KOPYALANMAZ. Kimlik bilgileri (auth.json) kopyalanmaz; yerel
 *     profilin model girisi kullaniciya aittir (`attach` kendi kimligiyle konusur).
 *   - `ORCHESTRA_NODE` yoksa sistemdeki Node >= 24 kullanilir; 24'un altindaki bir Node ile
 *     "hata ayiklamak" icin calistirma yolu sunulmaz (kotu nedeni gizler).
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { PATCHED_SHA256, patchRuntime } from "./patch.mjs"
import {
  HERE,
  MIN_NODE_MAJOR,
  PINNED,
  REPO_ROOT,
  autoDownloadSupported,
  configContent,
  generatedPackageJson,
  makeEnvironment,
  mirrorPlan,
  nodeExeSha256,
  nodeExeUrl,
  projectPaths,
  redactState,
  runtimePaths,
  transformIndexText,
  validateIdentity,
  verifyDiagnostics,
  verifyPluginInventory,
} from "./support.mjs"

const SERVER_USER = "opencode"
const INFO_PATH = "/__orchestra_runtime/info"
const SHUTDOWN_PATH = "/__orchestra_runtime/shutdown"
const STARTUP_TIMEOUT_MS = 45_000
const SHUTDOWN_TIMEOUT_MS = 30_000
const POLL_MS = 250
const RUNTIME_MANIFEST = join(HERE, "runtime-package.json")

const USAGE = `orchestra · proje-yerel opencode runtime

  npm run opencode:local:setup     runtime kurar + cekirdek yamasi (ag erisimi: sadece burada)
  npm run opencode:local:start     yerel sunucuyu baslatir (ag erisimi yok)
  npm run opencode:local:status    url/pid/surum/hash/hafiza yolu/Yetkilendirme
  npm run opencode:local:stop      yalnizca HTTP shutdown (nonce korumali)
  npm run opencode:local:restore   cekirdek chunk'i geri alir (git/veri dokunulmaz)
  npm run opencode:local:attach    opencode CLI'yi yerel sunucuya baglar

Ortam:
  ORCHESTRA_NODE   Node >= ${MIN_NODE_MAJOR} mutlak yol (setup/start). Verilmezse: once runtime/bin,
                  sonra sistem Node'u, sonra (sadece setup) sabitlenmis Node ${PINNED.node} indirmesi.
  ORCHESTRA_CLI    attach icin opencode CLI mutlak yolu (platform varsayilani yoksa gerekli).

Not: model kimlik bilgileri kopyalanmaz. Yerel profilin model girisi kullaniciya aittir
(attach kendi kimligiyle calisir). Global kurulum hicbir komutla degistirilmez.`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const die = (msg) => {
  throw new Error(msg)
}
// TEK cikti kapisi: her sey `redactState`ten gecer. `status`/`start` zaten izinli alanlari
// seciyor; bu, yarim kalmis bir alanin (nonce/sifre/token) birakilma riskine karsi ag emniyet.
const emit = (value) => console.log(JSON.stringify(redactState(value), null, 2))

function parseArgs(argv) {
  const out = { action: undefined, root: undefined, runtime: undefined, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") out.help = true
    else if (arg === "--root" || arg === "--runtime-dir") {
      const value = argv[i + 1]
      if (!value || value.startsWith("--")) die(`${arg} bir deger istiyor`)
      if (arg === "--root") out.root = value
      else out.runtime = value
      i++
    } else if (arg.startsWith("-")) die(`bilinmeyen arguman: ${arg}\n${USAGE}`)
    else if (out.action === undefined) out.action = arg
    else die(`beklenmeyen arguman: ${arg}`)
  }
  return out
}

// ── durum / kimlik ────────────────────────────────────────────────────────────────────────

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (err.code === "ESRCH") return false
    // EPERM: pid var, sinyal gonderemiyoruz (Windows/izin) — yasayan sayilir.
    if (err.code === "EPERM") return true
    die(`pid ${pid} kontrol edilemedi (${err.code}); belirsiz durum, iptal`)
  }
}

function readInstance(paths) {
  if (!existsSync(paths.instanceFile)) return null
  const raw = readFileSync(paths.instanceFile, "utf8")
  let state
  try {
    state = JSON.parse(raw)
  } catch (err) {
    die(`state okunamadi (${paths.instanceFile}): ${err.message}; belirsiz durum, dokunulmadi`)
  }
  return { raw, state }
}

const authHeader = (password) => `Basic ${Buffer.from(`${SERVER_USER}:${password}`).toString("base64")}`

async function httpJson(url, init, timeoutMs, label) {
  let res
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    die(`${label} ulasilamadi (${url}): ${err.message}`)
  }
  if (!res.ok) die(`${label} reddedildi: ${res.status} ${res.statusText} (${url})`)
  try {
    const body = await res.json()
    return body && typeof body.data === "object" && body.data !== null ? body.data : body
  } catch {
    die(`${label} yaniti JSON degil (${url})`)
  }
}

const infoRequest = (state, timeoutMs = 5000) =>
  httpJson(
    `${state.url.replace(/\/+$/, "")}${INFO_PATH}`,
    { headers: { authorization: authHeader(state.password) } },
    timeoutMs,
    "info",
  )

/**
 * Native plugin listesi: `GET /api/plugin?location[directory]=<root>`.
 *
 * `location[directory]` DERIN (deep) sorgu parametresidir ve agentList ile ayni cozumleme
 * yolunu kullanir. Bu istek ayni zamanda o location icin plugin'i GERCEKTEN boot eder:
 * "bizim sunucumuz ayakta" demek "orkestra ayakta" demek DEGILDIR.
 */
const pluginRequest = (state, root, timeoutMs = 15_000) => {
  const url = new URL(`${state.url.replace(/\/+$/, "")}/api/plugin`)
  url.searchParams.set("location[directory]", root)
  return httpJson(url.toString(), { headers: { authorization: authHeader(state.password) } }, timeoutMs, "api/plugin")
}

const shutdownRequest = (state, timeoutMs = 10_000) =>
  httpJson(
    `${state.url.replace(/\/+$/, "")}${SHUTDOWN_PATH}`,
    {
      method: "POST",
      headers: { authorization: authHeader(state.password), "content-type": "application/json" },
      body: JSON.stringify({ nonce: state.nonce }),
    },
    timeoutMs,
    "shutdown",
  )

/**
 * Komut oncesi kapı: yasayan bir PID varsa ya bizimdir (o zaman "zaten calisiyor") ya da
 * karisabilir (o zaman dokunma). Ikisinde de devam etmez; `restore` ve `start` icin gecerlidir.
 */
async function assertOwnIdle(ctx, action) {
  const instance = readInstance(ctx.paths)
  if (!instance) return null
  const pid = instance.state?.pid
  if (!Number.isInteger(pid) || pid <= 0)
    die(`state.json pid okunamadi (${ctx.paths.instanceFile}); belirsiz durum, ${action} iptal`)
  if (!pidAlive(pid)) return instance // eski kayit: kendi dosyamiz, temizlenebilir
  let info
  try {
    info = await infoRequest(instance.state)
    validateIdentity(instance.state, info, ctx.paths.root, instance.state.coreSha256 ?? PATCHED_SHA256)
  } catch (err) {
    die(
      `pid ${pid} yasaliyor ama bizim yerel sunucumuz DEGIL (kimlik dogrulanamadi: ${err.message}); ` +
        `${action} iptal. Baska bir surece dokunulmaz.`,
    )
  }
  die(`yerel runtime zaten calisiyor (${info.url}, pid ${pid}); once 'npm run opencode:local:stop' (${action} iptal)`)
}

/**
 * Ozel hafizanin KENDI kaniti: `<projectMemory>/state.json` -> diagnostics.steps.
 * Buradaki dosya global degil, `.orchestra-runtime/memory/<projectHash>` altindadir.
 */
function readDiagnostics(paths) {
  const file = join(paths.projectMemory, "state.json")
  if (!existsSync(file)) throw new Error(`plugin tanilari yok: ${file} bulunamadi`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch (err) {
    throw new Error(`${file} okunamadi: ${err.message}`)
  }
  return verifyDiagnostics(parsed)
}

function readVersions(paths) {
  const out = {}
  for (const [key, file] of [
    ["core", paths.corePackage],
    ["plugin", paths.pluginPackage],
  ]) {
    try {
      out[`${key}Version`] = JSON.parse(readFileSync(file, "utf8")).version ?? null
    } catch {
      out[`${key}Version`] = null
    }
  }
  return out
}

function patchStatus(runtime) {
  try {
    const res = patchRuntime(runtime, "status")
    return { state: res.state, version: res.version, actualSha256: res.actualSha256, patched: res.state === "patched" }
  } catch (err) {
    return { state: "unknown", error: err.message }
  }
}

/** `status` ciktisi. Parola/token/nonce YAZILMAZ; yalnizca "yetkilendirme var mi" bilgisi. */
function report(ctx, { state = null, info = null, running, node = null, note = null, extra = {} } = {}) {
  const paths = ctx.paths
  const versions = readVersions(paths)
  return {
    action: "status",
    running,
    url: state?.url ?? info?.url ?? null,
    pid: state?.pid ?? null,
    startedAt: state?.startedAt ?? null,
    projectRoot: state?.projectRoot ?? paths.root,
    ...versions,
    ...(info?.coreVersion ? { serverCoreVersion: info.coreVersion } : {}),
    coreSha256: state?.coreSha256 ?? info?.coreSha256 ?? null,
    patched: (state?.coreSha256 ?? info?.coreSha256) === PATCHED_SHA256,
    memoryPath: paths.projectMemory,
    runtimeDir: paths.runtime,
    serverScript: paths.serverScript,
    node,
    authConfigured: Boolean(state?.password),
    ...(note ? { note } : {}),
    ...extra,
  }
}

// ── Node cozumleme ────────────────────────────────────────────────────────────────────────

function nodeMajor(exe) {
  const res = spawnSync(exe, ["--version"], { encoding: "utf8", windowsHide: true })
  if (res.error || res.status !== 0) return null
  const match = /^v(\d+)/.exec(String(res.stdout ?? "").trim())
  return match ? Number(match[1]) : null
}

function assertNode24(exe, label) {
  const major = nodeMajor(exe)
  if (major === null) die(`${label} calistirilamadi: ${exe}`)
  if (major < MIN_NODE_MAJOR)
    die(
      `${label} Node >= ${MIN_NODE_MAJOR} istiyor, ${label} v${major}. ` +
        `Dusuk surumle devam etmek hatayi gizler; kok nedeni gider (ORCHESTRA_NODE=<mutlak yol> veya 'npm run opencode:local:setup').`,
    )
  return major
}

/** Sabitlenmis Node .exe'sini indirir ve CALISTIRMADAN ONCE hash dogrular. */
async function downloadNode(paths) {
  const url = nodeExeUrl()
  const expected = nodeExeSha256()
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  } catch (err) {
    die(`Node ${PINNED.node} indirilemedi (${url}): ${err.message}`)
  }
  if (!res.ok) die(`Node ${PINNED.node} indirilemedi (${url}): ${res.status} ${res.statusText}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const sha = createHash("sha256").update(bytes).digest("hex")
  if (sha !== expected) die(`${url} sha256 ${sha}, beklenen ${expected}; HIC BIR SEY CALISTIRILMADI.`)
  mkdirSync(paths.binDir, { recursive: true })
  const tmp = join(paths.binDir, `node.download-${process.pid}`)
  writeFileSync(tmp, bytes)
  renameSync(tmp, paths.nodeExe)
  return paths.nodeExe
}

/**
 * Sira: ORCHESTRA_NODE -> runtime/bin/node -> sistem Node >= 24 -> (yalniz setup) sabitlenmis Node.
 * `allowDownload:false` iken ag erisimi yapilmaz; `start` bu yolu kullanir.
 */
async function resolveNode(paths, { allowDownload }) {
  const explicit = process.env.ORCHESTRA_NODE
  if (explicit) {
    if (!isAbsolute(explicit) || !existsSync(explicit))
      die(`ORCHESTRA_NODE mutlak ve var olan bir yol olmali: ${JSON.stringify(explicit)}`)
    assertNode24(explicit, "ORCHESTRA_NODE")
    return explicit
  }
  if (existsSync(paths.nodeExe)) {
    assertNode24(paths.nodeExe, "runtime Node")
    return paths.nodeExe
  }
  if (nodeMajor(process.execPath) >= MIN_NODE_MAJOR) {
    assertNode24(process.execPath, "sistem Node")
    return process.execPath
  }
  if (!allowDownload)
    die(
      `Node >= ${MIN_NODE_MAJOR} bulunamadi ve 'start' indirme YAPMAZ. ` +
        `Once 'npm run opencode:local:setup' ya da ORCHESTRA_NODE=<mutlak yol>.`,
    )
  if (!autoDownloadSupported())
    die(
      `${process.platform}-${process.arch} icin otomatik Node ${PINNED.node} indirmesi kanitli degil ` +
        `(hash tablosunda yok). Sistemde Node >= ${MIN_NODE_MAJOR} kur ya da ORCHESTRA_NODE ver.`,
    )
  const exe = await downloadNode(paths)
  assertNode24(exe, "indirilen Node")
  return exe
}

function npmCliPath() {
  const candidate = process.env.ORCHESTRA_NPM_CLI || process.env.npm_execpath
  if (!candidate)
    die(
      "npm_execpath yok. Komutlari `npm run opencode:local:*` ile calistir " +
        "(ya da ORCHESTRA_NPM_CLI=<npm-cli.js mutlak yol> ver).",
    )
  const absolute = resolve(candidate)
  if (!existsSync(absolute)) die(`npm CLI bulunamadi: ${absolute}`)
  return absolute
}

// ── komutlar ──────────────────────────────────────────────────────────────────────────────

async function cmdSetup(ctx) {
  await assertOwnIdle(ctx, "setup")
  const paths = ctx.paths
  mkdirSync(paths.runtime, { recursive: true })

  // Kendi manifestimiz: kok deps ASLA degismez (runtime bump repoyu yukseltmez).
  if (!existsSync(RUNTIME_MANIFEST)) die(`runtime manifesti yok: ${RUNTIME_MANIFEST}`)
  const manifest = JSON.parse(readFileSync(RUNTIME_MANIFEST, "utf8"))
  const deps = manifest.dependencies ?? {}
  if (deps["@opencode/core"] !== PINNED.core || deps["@opencode/plugin"] !== PINNED.plugin)
    die(`runtime-package.json beklenen surumleri tasiyor: ${JSON.stringify(deps)}`)
  writeFileSync(paths.runtimePackage, readFileSync(RUNTIME_MANIFEST))

  const node = await resolveNode(paths, { allowDownload: true })
  const cli = npmCliPath()
  const res = spawnSync(
    node,
    [cli, "install", "--prefix", paths.runtime, "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: paths.runtime,
      stdio: "inherit",
      // Global npm cache'i ve global prefix'i dokunmamak icin cache de runtime'a yazilir.
      env: { ...process.env, npm_config_cache: paths.npmCache },
      windowsHide: true,
    },
  )
  if (res.error) die(`npm install calistirilamadi (${node} ${cli}): ${res.error.message}`)
  if (res.status !== 0) die(`npm install ${res.status} ile bitti; runtime kurulmadi`)
  if (!existsSync(paths.corePackage)) die(`npm install bitti ama bulunamadi: ${paths.corePackage}`)

  const patch = patchRuntime(paths.runtime, "apply")
  if (patch.state !== "patched") die(`cekirdek yamasi uygulanmadi: ${patch.state}`)
  ctx.node = node
  emit({
    action: "setup",
    ok: true,
    node,
    nodeMajor: nodeMajor(node),
    runtimeDir: paths.runtime,
    manifest: paths.runtimePackage,
    ...readVersions(paths),
    patch: { state: patch.state, version: patch.version, actualSha256: patch.actualSha256 },
  })
}

/** `.opencode/plugins/orchestra` -> `<runtime>/plugins/orchestra` + uretilen package.json. */
function mirrorPlugins(ctx) {
  const paths = ctx.paths
  const plan = mirrorPlan(paths.root, paths.runtime)
  mkdirSync(paths.mirroredPluginDir, { recursive: true })
  const files = []
  for (const item of plan) {
    if (!existsSync(item.source)) die(`kaynak plugin dosyasi yok: ${item.source}`)
    const text = readFileSync(item.source).toString("utf8")
    const next = item.transformed ? transformIndexText(text) : text
    writeFileSync(item.target, next, "utf8")
    files.push({ file: item.file, transformed: item.transformed, bytes: Buffer.byteLength(next) })
  }
  writeFileSync(paths.generatedPackageFile, generatedPackageJson(), "utf8")
  return files
}

async function cmdStart(ctx) {
  const previous = await assertOwnIdle(ctx, "start")
  const paths = ctx.paths
  // --- ag erisimi YOK: yalnizca var olan cozumleme/hash denetimi ---
  const node = await resolveNode(paths, { allowDownload: false })
  if (!existsSync(paths.corePackage))
    die(`runtime kurulmamadi: ${paths.corePackage} yok. Once 'npm run opencode:local:setup'.`)
  const patch = patchRuntime(paths.runtime, "status")
  if (patch.state !== "patched")
    die(
      `cekirdek yamali degil (${patch.state}). Calisan kodun altini sessizce degistirmiyoruz; ` +
        `'npm run opencode:local:setup' calistir.`,
    )
  const mirrored = mirrorPlugins(ctx)
  mkdirSync(paths.projectMemory, { recursive: true })

  const password = randomBytes(32).toString("hex")
  const nonce = randomBytes(16).toString("hex")
  const env = makeEnvironment(paths.root, paths.runtime, { password, nonce })
  if (!existsSync(paths.serverScript)) die(`sunucu betigi yok: ${paths.serverScript}`)
  mkdirSync(paths.logsDir, { recursive: true })
  const logFd = openSync(paths.serverLog, "a")
  let child
  try {
    child = spawn(node, ["--experimental-transform-types", paths.serverScript], {
      cwd: paths.root,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    })
  } finally {
    closeSync(logFd)
  }
  child.unref()
  ctx.node = node

  const previousRaw = previous?.raw ?? null
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let failure = null
  let info = null
  let state = null
  let plugin = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      failure = `sunucu ${child.signalCode ?? child.exitCode} ile sonlandi`
      break
    }
    const instance = readInstance(paths) // okunamayan state = belirsiz, burada fatal
    if (instance && instance.raw !== previousRaw) {
      const candidate = instance.state
      if (candidate?.nonce === nonce) {
        try {
          const probed = await infoRequest(candidate)
          validateIdentity(candidate, probed, paths.root, PATCHED_SHA256, nonce)
          // KABUL ARTIK IKI KATMANLI: (1) bu bizim sunucumuz, (2) GERCEKTEN orkestra ayakta.
          // Plugin dogrulanmadan `state` ATANMAZ: hata donguye doner, 45 s dolunca asagida
          // yalnizca HAZIR BU ADIMDA dogurdugumuz cocuk oldurulur.
          const inventory = verifyPluginInventory(await pluginRequest(candidate, paths.root))
          plugin = { ...inventory, diagnostics: readDiagnostics(paths) }
          info = probed
          state = candidate
          break
        } catch (err) {
          failure = err.message // sicak basliyor olabilir; yoksa dongu sonunda raporlanir
        }
      } else if (typeof candidate?.nonce === "string" && candidate.nonce !== nonce) {
        failure = `state.json yazan sunucu bizim nonce'umuzu tasimiyor; dokunulmadi`
        break
      }
    }
    await sleep(POLL_MS)
  }

  if (!state) {
    // Yalnizca HAZIR BU ADIMDA dogurdugumuz cocugu oldururuz. Baaska hicbir pid isaretlenmez.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill()
      } catch {
        /* cocuk zaten kapandi */
      }
    }
    die(
      `yerel runtime HAZIR degil (${failure ?? "zaman asimi"}). Kabul olcutu: bizim sunucu + ` +
        `nonce/proje/hash dogrusu + "orchestra.project-local" etkin olmasi + ` +
        `diagnostics.steps (tools/loop/fallback/tasks). Gunluk: ${paths.serverLog}`,
    )
  }

  emit(
    report(ctx, {
      state,
      info,
      running: true,
      node,
      extra: {
        action: "start",
        ok: true,
        // hazir = bizim sunucu + kimlik dogrusu + GERCEK plugin aktivasyonu + tani adimlari.
        // Ucu de tutmuyorsa buraya hic gelinmez.
        ready: plugin.state === "active",
        plugin,
        mirroredPlugins: mirrored.length,
        configContent: configContent(paths.mirroredPluginDir),
      },
    }),
  )
}

async function cmdStatus(ctx) {
  const instance = readInstance(ctx.paths)
  if (!instance) {
    emit(
      report(ctx, {
        running: false,
        node: `${process.execPath} (v${nodeMajor(process.execPath) ?? "?"})`,
        extra: { note: "calisan yerel sunucu yok", patch: patchStatus(ctx.paths.runtime) },
      }),
    )
    return
  }
  const state = instance.state
  const alive = pidAlive(state?.pid)
  if (!alive) {
    emit(
      report(ctx, {
        state,
        running: false,
        node: `${process.execPath} (v${nodeMajor(process.execPath) ?? "?"})`,
        note: "state.json var ama pid yasamiyor (eski kayit); 'stop' temizler",
        extra: { patch: patchStatus(ctx.paths.runtime) },
      }),
    )
    return
  }
  let info = null
  let note = null
  try {
    info = await infoRequest(state)
    validateIdentity(state, info, ctx.paths.root, state.coreSha256 ?? PATCHED_SHA256)
  } catch (err) {
    note = `kimlik dogrulanamadi: ${err.message}`
  }
  emit(
    report(ctx, {
      state,
      info,
      running: true,
      node: `${process.execPath} (v${nodeMajor(process.execPath) ?? "?"})`,
      ...(note ? { note } : {}),
      extra: { patch: patchStatus(ctx.paths.runtime) },
    }),
  )
}

async function cmdStop(ctx) {
  const instance = readInstance(ctx.paths)
  if (!instance) {
    emit({ action: "stop", ok: true, note: "calisan yerel sunucu yok" })
    return
  }
  const state = instance.state
  const pid = state?.pid
  if (!Number.isInteger(pid) || pid <= 0)
    die(`state.json pid okunamadi (${ctx.paths.instanceFile}); belirsiz durum, stop iptal`)
  if (!pidAlive(pid)) {
    rmSync(ctx.paths.instanceFile, { force: true })
    emit({ action: "stop", ok: true, note: "state.json eskiydi (pid yasamiyor), dosya kaldirildi", pid })
    return
  }
  const info = await infoRequest(state)
  // Yalnizca KENDI sunucumuzu durdururuz: nonce + proje + cekirdek dogrulanir.
  validateIdentity(state, info, ctx.paths.root, state.coreSha256 ?? PATCHED_SHA256, state.nonce)
  await shutdownRequest(state)
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
  while (Date.now() < deadline && pidAlive(pid)) await sleep(POLL_MS)
  if (pidAlive(pid))
    die(
      `shutdown kabul edildi ama pid ${pid} hala ayakta. Bu bizim sunucumuz olsa da zorlamiyoruz ` +
        `(desenle oldurme/isaret yok). Gunlu: ${ctx.paths.serverLog}`,
    )
  rmSync(ctx.paths.instanceFile, { force: true })
  emit({ action: "stop", ok: true, pid, url: state.url, note: "yalnizca HTTP shutdown + nonce kullanildi" })
}

function cmdRestore(ctx) {
  // patch.mjs de ayakta bir state.json pid'sini reddeder; burada ayrica kimlik dogrulariz.
  const instance = readInstance(ctx.paths)
  if (instance && pidAlive(instance.state?.pid))
    die(`yerel runtime calisiyor (pid ${instance.state?.pid}); once 'npm run opencode:local:stop'`)
  const res = patchRuntime(ctx.paths.runtime, "restore")
  emit({
    action: "restore",
    ...res,
    note: "yalnizca cekirdek chunk; git/stash/kisisel veri/kimlik dosyasi DOKUNULMADI",
  })
}

function resolveCli() {
  const explicit = process.env.ORCHESTRA_CLI
  if (explicit) {
    if (!isAbsolute(explicit) || !existsSync(explicit))
      die(`ORCHESTRA_CLI mutlak ve var olan bir yol olmali: ${JSON.stringify(explicit)}`)
    return explicit
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA
    const candidate = base ? join(base, "Programs", "@opencodedesktop", "resources", "opencode-cli.exe") : null
    if (candidate && existsSync(candidate)) return candidate
  }
  const probe =
    process.platform === "win32"
      ? spawnSync("where.exe", ["opencode"], { encoding: "utf8" })
      : spawnSync("sh", ["-c", "command -v opencode || true"], { encoding: "utf8" })
  const found = String(probe.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && existsSync(line))
  if (found) return found
  die(
    "opencode CLI bulunamadi (platform varsayilani yok). ORCHESTRA_CLI=<mutlak yol> ver; " +
      "hizmet komutu/bayragi TAHMIN edilmez.",
  )
}

async function cmdAttach(ctx) {
  const instance = readInstance(ctx.paths)
  if (!instance) die("yerel sunucu calismiyor; once 'npm run opencode:local:start'")
  const state = instance.state
  if (!pidAlive(state?.pid)) die(`state.json eski (pid ${String(state?.pid)} yasamiyor); once 'start'`)
  const info = await infoRequest(state)
  validateIdentity(state, info, ctx.paths.root, state.coreSha256 ?? PATCHED_SHA256, state.nonce)
  const cli = resolveCli()
  // Parola argv'de GECMEZ: yalnizca cocuk surecin ortaminda. Gunluge de yazilmaz.
  const res = spawnSync(cli, ["--server", state.url, ctx.paths.root], {
    stdio: "inherit",
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: state.password },
    windowsHide: false,
  })
  if (res.error) die(`CLI calistirilamadi (${cli}): ${res.error.message}`)
  process.exitCode = res.status ?? 1
}

const COMMANDS = { setup: cmdSetup, start: cmdStart, status: cmdStatus, stop: cmdStop, restore: cmdRestore, attach: cmdAttach }

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }
  if (!args.action) {
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  const command = COMMANDS[args.action]
  if (!command) die(`bilinmeyen komut: ${args.action}\n${USAGE}`)
  const root = args.root ? resolve(args.root) : REPO_ROOT
  const ctx = { root, paths: runtimePaths(root, args.runtime), node: null }
  // projectPaths ile ayni uretim: beklenmedik bir sapma olursa kurulum degil, hata gorunur.
  if (ctx.paths.runtime !== projectPaths(root).runtime && !args.runtime)
    die("runtime yolu beklenenden farkli hesaplandi; dur")
  await command(ctx)
}

// Yalniz dogrudan calistirildiginda calisir; bir baska modul bu dosyayi `import` ederse
// yanlislikla komut tetiklenmez (patch.mjs ile ayni kural).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await main()
  } catch (err) {
    console.error(`local: ${err.message}`)
    process.exitCode = 1
  }
}
