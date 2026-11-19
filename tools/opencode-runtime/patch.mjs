#!/usr/bin/env node
/**
 * orchestra-project-opencode-runtime · SessionContext await-activation patcher.
 *
 * Upstream `@opencode/core@2.0.18` builds `SessionContext.select` so that it can read the
 * plugin activation latch *after* it has already picked the agent. The upstream fix inserts a
 * five-line barrier between `yield* mcpTools.flush` and `const agent = yield* agents.select(...)`,
 * plus two import bindings (`Option` on the `effect` import, and the **named** `Plugin` export
 * from the plugin service barrel). Canonical upstream diff: `session-context-2.0.18.patch`
 * (tag `v2.0.18`, MIT, `packages/core/src/session/context.ts`).
 *
 * Why it is resolved instead of hardcoded: the published `dist/session/context.js` is a barrel
 * only. It re-exports the implementation from a content-hashed chunk whose name changes between
 * builds, so the target is discovered through the barrel's first re-export import and then
 * validated by content (`SessionContext.select` must exist in it).
 *
 * Safety contract:
 *   - the target must resolve (realpath) to a path *inside* the project-local runtime dir; a
 *     junction/symlink that escapes the root is refused, so this can never touch a global install
 *   - only two byte-identical inputs are accepted: ORIGINAL_SHA256 -> write, PATCHED_SHA256 -> no-op.
 *     Anything else is reported as `conflict` and NOTHING is overwritten
 *   - the patched text is hashed *before* it is written; a recipe that does not reproduce
 *     PATCHED_SHA256 byte-for-byte writes nothing
 *   - the pristine original is snapshotted once into `<runtimeDir>/patch/` and never rewritten
 *   - writes are temp-file + rename, so a crash cannot leave a half-written chunk
 *   - the patcher never kills processes. Restoring a chunk under a live runtime is refused
 *     instead; starting/stopping the runtime is the controller's job.
 *
 * CLI (no `--core`: there is no arbitrary global target by design)
 *   node tools/opencode-runtime/patch.mjs [apply|restore|status] [--runtime-dir <path>]
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const ORIGINAL_SHA256 = "09b0ed4dae1749183a35f2a034b294702100bc1d9867e78a08fe4d9585a6722b"
export const PATCHED_SHA256 = "8059d066210bbfd04511aeacbe13589f6ca5481254b8c8c2215b8869943a36cc"
export const CORE_NAME = "@opencode/core"
export const CORE_VERSION = "2.0.18"

/** Exact insertion recipe. Any drift must fail the hash check, not produce a "close enough" file. */
const EFFECT_IMPORT_BEFORE = 'import { Context, Effect, Layer } from "effect";'
const EFFECT_IMPORT_AFTER = 'import { Option, Context, Effect, Layer } from "effect";'
const PLUGIN_IMPORT = 'import { Plugin } from "../plugin/service.js";'
const GUARD_LINES = [
  "    yield* Effect.serviceOption(Plugin.Service).pipe(",
  "      Effect.flatMap((maybe) =>",
  "        Option.isNone(maybe) ? Effect.void : maybe.value.awaitActivation,",
  "      ),",
  "    );",
]
const FLUSH_ANCHOR = "yield* mcpTools.flush;"
const SELECT_ANCHOR = "const agent = yield* agents.select(session.agent);"
/** First `} from "...";` — the end of the leading import group; the Plugin import follows it. */
const IMPORT_BLOCK_END = /^} from "[^"]+";$/

const BARREL_SEGMENTS = ["dist", "session", "context.js"]
/** Authoritative first, legacy second. Both are live checks; a missing file means "nothing running". */
const INSTANCE_STATE_FILES = ["state/instance.json", "state.json"]

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

function uniqueIndex(lines, predicate, label) {
  const hits = []
  for (let i = 0; i < lines.length; i++) if (predicate(lines[i])) hits.push(i)
  if (hits.length !== 1)
    throw new Error(`anchor "${label}" ${hits.length} kez bulundu, tam 1 olmalı (${hits.join(",") || "yok"})`)
  return hits[0]
}

/** Build the patched source text in memory. Never touches the filesystem. */
export function buildPatchedText(original) {
  const lines = original.split("\n")
  const effect = uniqueIndex(lines, (l) => l === EFFECT_IMPORT_BEFORE, "effect import")
  const flush = uniqueIndex(lines, (l) => l.trim() === FLUSH_ANCHOR, "mcpTools.flush")
  const select = uniqueIndex(lines, (l) => l.includes(SELECT_ANCHOR), "agents.select")
  if (select !== flush + 1)
    throw new Error(`flush (${flush + 1}) ve agents.select (${select + 1}) bitişik değil; recipe bu sürüme uymuyor`)
  if (original.includes(EFFECT_IMPORT_AFTER) || original.includes(PLUGIN_IMPORT))
    throw new Error("import'ler zaten enjekte edilmiş görünüyor; apply çalıştırılmamalı")
  // the leading import group ends at the first `} from "…";`; every later group has the same
  // shape, so this anchor is positional (first), not unique
  const blockEnd = lines.findIndex((l) => IMPORT_BLOCK_END.test(l))
  if (blockEnd < 0) throw new Error('ilk import blogu sonu bulunamadı; chunk beklenen bicimde degil')

  const out = [...lines]
  out[effect] = EFFECT_IMPORT_AFTER
  out.splice(blockEnd + 1, 0, PLUGIN_IMPORT)
  const shiftedFlush = flush + (blockEnd + 1 <= flush ? 1 : 0)
  out.splice(shiftedFlush + 1, 0, ...GUARD_LINES)
  return out.join("\n")
}

/** temp file + rename in the same directory: readers see either the old or the new file. */
function atomicWrite(target, text) {
  const tmp = `${target}.orchestra-tmp-${process.pid}`
  try {
    writeFileSync(tmp, text, "utf8")
    renameSync(tmp, target)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best effort: a leftover temp file never affects the ledger */
    }
    throw err
  }
}

/** Resolve the implementation chunk through the barrel, refusing anything outside the runtime. */
function locate(runtimeDir) {
  if (typeof runtimeDir !== "string" || runtimeDir.trim() === "")
    throw new Error("runtimeDir gerekli (proje-yerel, .gitignore'li runtime dizini)")
  const runtimeArg = resolve(runtimeDir)
  if (!existsSync(runtimeArg)) throw new Error(`runtime dizini yok: ${runtimeArg}`)
  const runtimeRoot = realpathSync(runtimeArg)

  const coreDir = resolve(runtimeRoot, "node_modules", "@opencode", "core")
  const pkgPath = resolve(coreDir, "package.json")
  if (!existsSync(pkgPath))
    throw new Error(`bulunamadı: ${pkgPath} (runtime kurulmamış)`)
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  if (pkg.name !== CORE_NAME)
    throw new Error(`paket adı ${JSON.stringify(pkg.name)} olmalı, ${CORE_NAME} değil`)
  if (pkg.version !== CORE_VERSION)
    throw new Error(`core sürümü ${pkg.version} desteklenmiyor; bu patch yalnızca ${CORE_VERSION} için`)

  const barrelPath = resolve(coreDir, ...BARREL_SEGMENTS)
  if (!existsSync(barrelPath)) throw new Error(`bulunamadı: ${barrelPath}`)
  const barrel = readFileSync(barrelPath, "utf8")
  const reexport = /^\}? ?from "(\.\.\/[^"]+)";$/m.exec(barrel)
  if (!reexport) throw new Error(`${barrelPath}: yeniden dışa aktarma importu bulunamadı`)

  const implementationPath = resolve(dirname(barrelPath), reexport[1])
  if (!existsSync(implementationPath)) throw new Error(`bulunamadı: ${implementationPath}`)
  const real = realpathSync(implementationPath)
  if (real !== runtimeRoot && !real.startsWith(runtimeRoot + sep))
    throw new Error(
      `hedef runtime disina kaciyor: ${real} (runtime: ${runtimeRoot}). Junction/symlink kacisi reddedildi.`,
    )
  const implementation = readFileSync(real, "utf8")
  if (!implementation.includes("SessionContext.select"))
    throw new Error(`${real} icinde SessionContext.select yok; yanlis chunk cozuldu`)
  return { runtimeRoot, implementationPath: real, text: implementation }
}

/**
 * Live-runtime probe. Authoritative record is `<runtimeDir>/state/instance.json`, the connection
 * file the controller writes ({pid, url, nonce, ...}); the old flat `state.json` is still honoured
 * so a half-migrated runtime cannot hide behind the rename. Both are checked, and both fail CLOSED:
 * unreadable, non-object, pid-less or non-integer pid all throw, because "cannot prove it is
 * stopped" must not read as "stopped". Only an explicit ESRCH (pid does not exist) clears a file.
 *
 * The patcher never signals the process it finds. It only reports whether a restore would swap
 * code out from under a live runtime; stopping the runtime is the controller's job.
 */
function assertRuntimeStopped(runtimeRoot) {
  const probes = []
  for (const rel of INSTANCE_STATE_FILES) {
    const path = resolve(runtimeRoot, ...rel.split("/"))
    if (!existsSync(path)) continue
    let state
    try {
      state = JSON.parse(readFileSync(path, "utf8"))
    } catch (err) {
      throw new Error(`${rel} okunamadi (${path}): ${err.message}; belirsiz durum, restore iptal`)
    }
    if (state === null || typeof state !== "object" || Array.isArray(state))
      throw new Error(`${rel} beklenen nesne degil (${path}); belirsiz durum, restore iptal`)
    const pid = state.pid ?? state.process?.pid ?? state.runtime?.pid
    if (!Number.isInteger(pid) || pid <= 0)
      throw new Error(`${rel} pid okunamadı: ${JSON.stringify(pid)}; belirsiz durum, restore iptal`)
    probes.push({ rel, pid })
  }
  for (const { rel, pid } of probes) {
    try {
      process.kill(pid, 0)
    } catch (err) {
      if (err.code === "ESRCH") continue // stale record, nothing is running
      throw new Error(`pid ${pid} kontrol edilemedi (${err.code}); belirsiz durum, restore iptal`)
    }
    throw new Error(
      `runtime hala calisiyor (pid ${pid}, ${rel}); once yurutmeyi durdur, patcher sureci oldurmez`,
    )
  }
}

const posix = (p) => p.split(/[\\/]/).join("/")
const flatten = (p) => p.replace(/^[./]+/, "").replace(/[\\/:*?"<>|]/g, "__")

function patchPaths(runtimeRoot) {
  const dir = resolve(runtimeRoot, "patch")
  return {
    dir,
    backup: resolve(dir, "backup"),
    ledger: resolve(dir, "ledger.json"),
  }
}

function relativeTo(runtimeRoot, target) {
  const rel = posix(relative(runtimeRoot, target))
  if (rel === "" || rel.startsWith("../") || isAbsolute(rel))
    throw new Error(`runtime disina cikan yol reddedildi: ${target}`)
  return rel
}

function readLedger(paths) {
  if (!existsSync(paths.ledger)) return { schema: 1, records: [] }
  let ledger
  try {
    ledger = JSON.parse(readFileSync(paths.ledger, "utf8"))
  } catch (err) {
    throw new Error(`ledger okunamadi (${paths.ledger}): ${err.message}`)
  }
  if (!Array.isArray(ledger?.records)) throw new Error(`${paths.ledger}: records dizisi bekleniyordu`)
  return ledger
}

function writeLedger(paths, record) {
  const existing = readLedger(paths).records.filter((r) => r?.implementation !== record.implementation)
  atomicWrite(paths.ledger, `${JSON.stringify({ schema: 1, records: [...existing, record] }, null, 2)}\n`)
}

/** Snapshot the pristine chunk once. The backup is immutable: a second apply re-verifies it. */
function ensureBackup(paths, runtimeRoot, implementationPath, bytes) {
  const rel = relativeTo(runtimeRoot, implementationPath)
  const file = resolve(paths.backup, `${flatten(rel)}.${CORE_VERSION}.bak`)
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file)) {
    const sha = sha256(readFileSync(file))
    if (sha !== ORIGINAL_SHA256)
      throw new Error(`yedek bozuk: ${file} sha256 ${sha}, beklenen ${ORIGINAL_SHA256}`)
  } else {
    atomicWrite(file, bytes)
    if (sha256(readFileSync(file)) !== ORIGINAL_SHA256)
      throw new Error(`yedek yazildi ama hash ${ORIGINAL_SHA256} degil: ${file}`)
  }
  return file
}

/**
 * Apply, restore or report the runtime patch.
 * @param {string} runtimeDir project-local runtime dir (owned, git-ignored)
 * @param {"apply"|"restore"|"status"} [action]
 * @returns {{state:"original"|"patched"|"conflict",version:string,implementationPath:string,beforeSha256:string,afterSha256:string,actualSha256:string}}
 */
export function patchRuntime(runtimeDir, action = "apply") {
  if (action !== "apply" && action !== "restore" && action !== "status")
    throw new Error(`bilinmeyen action: ${JSON.stringify(action)} (apply|restore|status)`)

  const { runtimeRoot, implementationPath, text } = locate(runtimeDir)
  const paths = patchPaths(runtimeRoot)
  const actualSha256 = sha256(readFileSync(implementationPath))
  const result = (state) => ({
    state,
    version: CORE_VERSION,
    implementationPath,
    beforeSha256: ORIGINAL_SHA256,
    afterSha256: PATCHED_SHA256,
    // always re-read: the pre-write hash would misreport what the file is now
    actualSha256: sha256(readFileSync(implementationPath)),
  })

  if (actualSha256 !== ORIGINAL_SHA256 && actualSha256 !== PATCHED_SHA256)
    return result("conflict")

  const state = actualSha256 === PATCHED_SHA256 ? "patched" : "original"
  if (action === "status" || (action === "apply" && state === "patched"))
    return result(state)
  if (action === "restore" && state === "original") return result(state)
  if (action === "restore") {
    assertRuntimeStopped(runtimeRoot)
    const record = readLedger(paths).records.find((r) => r?.implementation === relativeTo(runtimeRoot, implementationPath))
    if (!record) throw new Error(`ledger kaydi yok: ${relativeTo(runtimeRoot, implementationPath)}`)
    const backup = resolve(runtimeRoot, record.backup)
    if (!existsSync(backup)) throw new Error(`yedek dosya yok: ${backup}`)
    const backupBytes = readFileSync(backup)
    const backupSha = sha256(backupBytes)
    if (backupSha !== ORIGINAL_SHA256)
      throw new Error(`yedek bozuk: ${backup} sha256 ${backupSha}, beklenen ${ORIGINAL_SHA256}`)
    atomicWrite(implementationPath, backupBytes)
    const restored = sha256(readFileSync(implementationPath))
    if (restored !== ORIGINAL_SHA256)
      throw new Error(`restore sonrasi hash ${restored}, beklenen ${ORIGINAL_SHA256}`)
    return result("original")
  }

  // apply
  assertRuntimeStopped(runtimeRoot)
  const patched = buildPatchedText(text)
  const patchedSha = sha256(Buffer.from(patched, "utf8"))
  if (patchedSha !== PATCHED_SHA256)
    throw new Error(
      `uretilen metin ${PATCHED_SHA256} degil (${patchedSha}); HIC BIR SEY YAZILMADI.`,
    )
  mkdirSync(paths.dir, { recursive: true })
  const backup = ensureBackup(paths, runtimeRoot, implementationPath, readFileSync(implementationPath))
  atomicWrite(implementationPath, patched)
  const written = sha256(readFileSync(implementationPath))
  if (written !== PATCHED_SHA256)
    throw new Error(`yazilan dosya hash ${written}, beklenen ${PATCHED_SHA256}`)
  writeLedger(paths, {
    version: CORE_VERSION,
    implementation: relativeTo(runtimeRoot, implementationPath),
    backup: relativeTo(runtimeRoot, backup),
    beforeSha256: ORIGINAL_SHA256,
    afterSha256: PATCHED_SHA256,
  })
  return result("patched")
}

const here = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(here), "..", "..")
const DEFAULT_RUNTIME_DIR = resolve(repoRoot, ".orchestra-runtime")

function runCli(argv) {
  let action = "status"
  let runtimeDir = DEFAULT_RUNTIME_DIR
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--runtime-dir") {
      const next = argv[i + 1]
      if (!next || next.startsWith("--")) throw new Error("--runtime-dir bir deger istiyor")
      runtimeDir = next
      i++
    } else if (arg === "apply" || arg === "restore" || arg === "status") action = arg
    else throw new Error(`bilinmeyen arguman: ${arg}\nkullanim: patch.mjs [apply|restore|status] [--runtime-dir <path>]`)
  }
  const res = patchRuntime(runtimeDir, action)
  console.log(JSON.stringify(res, null, 2))
  return res.state === "conflict" ? 4 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(here)) {
  try {
    process.exitCode = runCli(process.argv.slice(2))
  } catch (err) {
    console.error(`patch: ${err.message}`)
    process.exitCode = 1
  }
}
