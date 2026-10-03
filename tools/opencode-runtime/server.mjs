#!/usr/bin/env node
/**
 * tools/opencode-runtime/server.mjs — the ACTUAL opencode server process for one Orchestra
 * instance. The controller spawns this file directly (`node server.mjs`), so this child *is*
 * the server: no wrapper process, no supervisor, no pid-kill fallback anywhere. Ownership is
 * proven over HTTP with the instance nonce instead.
 *
 * Everything below was read from the published 2.0.18 dist, not guessed:
 *
 *   @opencode/server/dist/fetch.js
 *     exports { exports_fetch as ServerFetch, make3 as make } from ./chunks/service-status-*.js
 *     - `make` is an EFFECT that returns a (Request -> Response) handler, not the handler itself
 *     - it builds a Layer, so the environment needs a `Scope.Scope`
 *     - `Effect.scoped(...)` is WRONG: it would close the scope on return and release the very
 *       resources the handler needs. The scope is owned manually and closed only at shutdown.
 *
 * Resolution rules (the reason this file has no bare package import at all):
 *   - this file lives in a git-tracked directory, so `import "@opencode/server/fetch"` would walk
 *     up to the REPOSITORY's node_modules, which does not carry the runtime packages. Every
 *     package is resolved to an absolute path under `<ORCHESTRA_RUNTIME_DIR>/node_modules` and
 *     imported dynamically by file URL.
 *   - `@opencode/server@2.0.18` publishes only `{"./*":{"import":"./dist/*.js","types":…}}`:
 *     there is no `"."` export and no `dist/index.js`, so the server entry is pinned to
 *     `dist/fetch.js` and its text is checked for the `ServerFetch` re-export before importing.
 *   - `@opencode/*` publishes the "import" condition only (no "require"), so `require.resolve`
 *     fails for every subpath; dist paths are used directly and validated for existence.
 *   - `effect@4.0.0-rc.112` exports `"." -> "./dist/index.js"`, read from its own package.json.
 *   - the core barrel `dist/session/context.js` is a re-export barrel; the implementation lives
 *     in a content-hashed chunk. The chunk is discovered through the barrel's first
 *     `from "../chunks/…"` import, checked to implement `SessionContext.select`, and its sha256
 *     must equal the patched digest below. A mismatch means the runtime is not the patched
 *     project-local copy, so booting is refused instead of running an unpatched dist.
 *   - core/server/sdk must all read 2.0.18 from their own package.json.
 *
 * Isolation contract. Evaluation order matters and is enforced: the environment/ownership checks
 * and the config-content check all run BEFORE the first `import()` of a runtime package, because
 * importing one is what executes its global providers. Only then comes the Node capability gate
 * and the dist identity checks. `readContract` is side-effect free (no mkdir, no writes) so it can
 * be unit tested without a runtime.
 *
 * Environment (all required):
 *   ORCHESTRA_RUNTIME_DIR     absolute path of the owned runtime (root/.orchestra-runtime)
 *   ORCHESTRA_PROJECT_ROOT    absolute project root; must equal the cwd realpath
 *   ORCHESTRA_INSTANCE_NONCE  random per-instance owner token
 *   OPENCODE_SERVER_PASSWORD  random Basic-auth password
 *   ORCHESTRA_PROJECT_MEMORY  absolute, runtime-owned memory dir
 *   OPENCODE_DB               absolute, runtime-owned sqlite path
 *   XDG_CONFIG_HOME           absolute, runtime-owned
 *   XDG_DATA_HOME             absolute, runtime-owned
 *   XDG_STATE_HOME            absolute, runtime-owned
 *   OPENCODE_CONFIG_CONTENT   JSON object; NOT read by native make(); the launcher validates it (env content is the highest-ranked
 *                             config source), so it is validated and then passed through
 *                             untouched. No config file is written and no personal config is
 *                             ever copied into the runtime.
 * Optional:
 *   ORCHESTRA_RUNTIME_PORT    0 (default) means ephemeral
 *   XDG_CACHE_HOME            validated for runtime ownership when present
 *   OPENCODE_SERVER_USERNAME  defaults to "opencode"
 *
 * Control surface (the only routes this file owns; everything else is the native API untouched):
 *   GET  /__orchestra_runtime/info       Basic auth -> identity, no secret
 *   POST /__orchestra_runtime/shutdown   Basic auth + JSON {nonce} equal to the instance nonce
 *
 * On listen, `<runtime>/state/instance.json` is written atomically so the controller can wait for
 * readiness and authenticate. It is removed on exit only if it still carries this pid and nonce.
 */
import { createHash, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { Readable } from "node:stream"
import { pathToFileURL } from "node:url"

// ------------------------------------------------------------------- constants
export const RUNTIME_PREFIX = "/__orchestra_runtime/"
export const INFO_PATH = "/__orchestra_runtime/info"
export const SHUTDOWN_PATH = "/__orchestra_runtime/shutdown"
export const DEFAULT_AUTH_USERNAME = "opencode"
export const CORE_VERSION = "2.0.18"
export const SERVER_VERSION = "2.0.18"
export const SDK_VERSION = "2.0.18"
/** sha256 of the patched `@opencode/core` SessionContext chunk (patch.mjs PATCHED_SHA256). */
export const CORE_CONTEXT_SHA256 = "8059d066210bbfd04511aeacbe13589f6ca5481254b8c8c2215b8869943a36cc"
export const SHUTDOWN_GRACE_MS = 8_000
const SOCKET_DRAIN_MS = 250
const MAX_SHUTDOWN_BODY = 4_096
/**
 * Carrier env for the config, and the only config name accepted here. Native 2.0.18
 * `ServerFetch.make` never reads it: it resolves the config from `options.config?.content`
 * (`Config.configured({ project, file, content })`). This launcher validates the env and forwards
 * the exact text through `makeServerOptions`. The unprefixed `CONFIG_CONTENT` is read by nothing,
 * so it is not accepted as a substitute.
 */
export const CONFIG_ENV = "OPENCODE_CONFIG_CONTENT"

class BootError extends Error {}

// ------------------------------------------------------------------ pure utils
/**
 * Length-independent comparison. Both sides are hashed first so `timingSafeEqual` never throws
 * on a length mismatch and no early return leaks the first differing byte position.
 */
export function constantTimeEquals(left, right) {
  const a = createHash("sha256").update(String(left ?? ""), "utf8").digest()
  const b = createHash("sha256").update(String(right ?? ""), "utf8").digest()
  return timingSafeEqual(a, b)
}

/** `Authorization: Basic dXNlcjpwYXNz` -> { username, password } | null */
export function parseBasicAuth(header) {
  if (typeof header !== "string") return null
  const match = /^Basic[ \t]+([A-Za-z0-9+/]+={0,2})$/i.exec(header.trim())
  if (!match) return null
  let decoded
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8")
  } catch {
    return null
  }
  const sep = decoded.indexOf(":")
  if (sep < 0) return null
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) }
}

/** The pure auth guard: the only thing the runtime routes are allowed to trust. */
export function isAuthorized(header, expected) {
  const credentials = parseBasicAuth(header)
  if (!credentials) return false
  if (!expected || typeof expected.password !== "string" || expected.password === "") return false
  const user = constantTimeEquals(credentials.username, expected.username ?? DEFAULT_AUTH_USERNAME)
  const pass = constantTimeEquals(credentials.password, expected.password)
  return user && pass
}

// --------------------------------------------------------------- path safety
const norm = (value) => (process.platform === "win32" ? value.toLowerCase() : value)

function isInside(root, candidate) {
  const r = norm(root)
  const c = norm(candidate)
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/**
 * realpath of `target`, tolerating a not-yet-created tail: the nearest existing ancestor is
 * realpath-resolved (so a symlink hop is followed, not ignored) and the missing segments are
 * re-appended. A symlinked escape therefore shows up as a path outside the root.
 */
function realpathBestEffort(target) {
  const missing = []
  let current = path.resolve(target)
  for (;;) {
    if (fs.existsSync(current)) return path.join(fs.realpathSync(current), ...missing.reverse())
    const parent = path.dirname(current)
    if (parent === current) throw new BootError(`no existing ancestor for ${target}`)
    missing.push(path.basename(current))
    current = parent
  }
}

/** Require `candidate` inside `root` after symlink resolution. Returns the absolute path. */
function requireOwned(root, candidate, label) {
  if (typeof candidate !== "string" || candidate.trim() === "")
    throw new BootError(`${label} is not set`)
  if (!path.isAbsolute(candidate)) throw new BootError(`${label} must be absolute, got "${candidate}"`)
  const absolute = path.resolve(candidate)
  const real = realpathBestEffort(absolute)
  if (!isInside(root, real))
    throw new BootError(
      `${label} escapes the runtime dir\n  path  ${absolute}\n  real  ${real}\n  root  ${root}`,
    )
  return absolute
}

function pickExportsTarget(entry) {
  if (typeof entry === "string") return entry
  if (!entry || typeof entry !== "object") return null
  for (const key of ["import", "node", "default"]) {
    const nested = entry[key]
    const picked = pickExportsTarget(nested)
    if (picked) return picked
  }
  return null
}

/** Read `<modulesDir>/<name>/package.json` by path — never through a specifier resolver. */
function readPackage(modulesDir, name) {
  const pkgPath = path.join(modulesDir, ...name.split("/"), "package.json")
  if (!fs.existsSync(pkgPath)) throw new BootError(`${name} is not installed in ${modulesDir}`)
  try {
    return { pkg: JSON.parse(fs.readFileSync(pkgPath, "utf8")), pkgPath }
  } catch (error) {
    throw new BootError(`${name}/package.json is unreadable: ${error?.message ?? error}`)
  }
}

/** Absolute ESM entry of a package that has a real `"."` export (effect). */
function packageEntry(modulesDir, name, candidates) {
  const { pkg, pkgPath } = readPackage(modulesDir, name)
  const tried = [pickExportsTarget(pkg.exports?.["."]), pkg.module, ...candidates].filter(Boolean)
  for (const relative of tried) {
    if (!relative.startsWith(".")) continue
    const absolute = path.resolve(path.dirname(pkgPath), relative)
    if (fs.existsSync(absolute)) return { pkg, entry: absolute }
  }
  throw new BootError(`${name} has no reachable ESM entry (tried ${tried.join(", ") || "nothing"})`)
}

function packageVersion(pkg, name) {
  if (typeof pkg.version !== "string") throw new BootError(`${name}/package.json has no version`)
  return pkg.version
}

const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex")

// ------------------------------------------------------------------- contract
/**
 * Everything checkable without executing a single line of the runtime packages, and without
 * touching the filesystem for writing. Throws BootError on the first violation; the caller turns
 * that into a non-zero exit. Evaluation order is the contract: env -> ownership -> config
 * content -> Node capability -> package/dist identity.
 */
export function readContract(env = process.env, cwd = process.cwd()) {
  for (const name of [
    "ORCHESTRA_RUNTIME_DIR",
    "ORCHESTRA_PROJECT_ROOT",
    "ORCHESTRA_INSTANCE_NONCE",
    "OPENCODE_SERVER_PASSWORD",
    "ORCHESTRA_PROJECT_MEMORY",
    "OPENCODE_DB",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    CONFIG_ENV,
  ]) {
    if (typeof env[name] !== "string" || env[name].trim() === "")
      throw new BootError(`${name} is required`)
  }

  for (const name of ["ORCHESTRA_RUNTIME_DIR", "ORCHESTRA_PROJECT_ROOT"]) {
    if (!path.isAbsolute(env[name])) throw new BootError(`${name} must be absolute, got "${env[name]}"`)
  }

  const projectRoot = realpathBestEffort(env.ORCHESTRA_PROJECT_ROOT)
  const cwdReal = realpathBestEffort(cwd)
  if (norm(projectRoot) !== norm(cwdReal))
    throw new BootError(
      `ORCHESTRA_PROJECT_ROOT must be the cwd\n  projectRoot ${projectRoot}\n  cwd          ${cwdReal}`,
    )

  const runtimeDir = realpathBestEffort(env.ORCHESTRA_RUNTIME_DIR)
  if (!isInside(projectRoot, runtimeDir))
    throw new BootError(
      `ORCHESTRA_RUNTIME_DIR must live inside the project root\n  runtime ${runtimeDir}\n  root    ${projectRoot}`,
    )

  const modulesDir = path.join(runtimeDir, "node_modules")
  if (!isInside(runtimeDir, realpathBestEffort(modulesDir)))
    throw new BootError("runtime node_modules escapes the runtime dir")

  const owned = {
    memoryDir: requireOwned(runtimeDir, env.ORCHESTRA_PROJECT_MEMORY, "ORCHESTRA_PROJECT_MEMORY"),
    database: requireOwned(runtimeDir, env.OPENCODE_DB, "OPENCODE_DB"),
    configHome: requireOwned(runtimeDir, env.XDG_CONFIG_HOME, "XDG_CONFIG_HOME"),
    dataHome: requireOwned(runtimeDir, env.XDG_DATA_HOME, "XDG_DATA_HOME"),
    stateHome: requireOwned(runtimeDir, env.XDG_STATE_HOME, "XDG_STATE_HOME"),
  }
  if (typeof env.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME.trim() !== "")
    owned.cacheHome = requireOwned(runtimeDir, env.XDG_CACHE_HOME, "XDG_CACHE_HOME")

  // The launcher is the config boundary. Native 2.0.18 ServerFetch.make does NOT read
  // OPENCODE_CONFIG_CONTENT: it resolves the config from options.config.content only
  // (Config.configured({ project, file, content })). That env is therefore just the carrier —
  // we validate it here and hand the EXACT validated text to makeServerOptions, which puts it in
  // options.config.content. The text is never rewritten and no config file is written.
  let parsedConfig
  try {
    parsedConfig = JSON.parse(env[CONFIG_ENV])
  } catch (error) {
    throw new BootError(`${CONFIG_ENV} is not valid JSON: ${error?.message ?? error}`)
  }
  if (parsedConfig === null || typeof parsedConfig !== "object" || Array.isArray(parsedConfig))
    throw new BootError(
      `${CONFIG_ENV} must be a JSON object, got ${Array.isArray(parsedConfig) ? "array" : typeof parsedConfig}`,
    )
  // Immutable snapshot: the very string ServerFetch.make will receive as options.config.content.
  const configContent = env[CONFIG_ENV]

  // Capability gate, after the contract and before any package import.
  const nodeMajor = Number(process.versions.node.split(".")[0])
  if (nodeMajor < 24)
    throw new BootError(
      `Node >= 24 is required by the published 2.0.18 dist, running ${process.versions.node}`,
    )

  const serverPkg = readPackage(modulesDir, "@opencode/server")
  const corePkg = readPackage(modulesDir, "@opencode/core")
  const sdkPkg = readPackage(modulesDir, "@opencode/sdk")
  const effectPkg = packageEntry(modulesDir, "effect", ["dist/index.js", "dist/esm/index.js"])

  for (const [name, resolved, wanted] of [
    ["@opencode/core", corePkg, CORE_VERSION],
    ["@opencode/server", serverPkg, SERVER_VERSION],
    ["@opencode/sdk", sdkPkg, SDK_VERSION],
  ]) {
    const version = packageVersion(resolved.pkg, name)
    if (version !== wanted) throw new BootError(`${name}@${version} is installed, ${wanted} is required`)
  }

  // Pinned: `@opencode/server` has no "." export and ships no dist/index.js.
  const serverEntry = path.join(modulesDir, "@opencode", "server", "dist", "fetch.js")
  if (!fs.existsSync(serverEntry)) throw new BootError(`server entry not found: ${serverEntry}`)
  if (!fs.readFileSync(serverEntry, "utf8").includes("ServerFetch"))
    throw new BootError(`${serverEntry} does not re-export ServerFetch`)
  if (!isInside(runtimeDir, realpathBestEffort(serverEntry)))
    throw new BootError("@opencode/server entry resolves outside the runtime dir")
  if (!isInside(runtimeDir, realpathBestEffort(effectPkg.entry)))
    throw new BootError("effect entry resolves outside the runtime dir")

  // Barrel -> content-hashed implementation chunk.
  const distRoot = path.join(modulesDir, "@opencode", "core", "dist")
  const barrel = path.join(distRoot, "session", "context.js")
  if (!fs.existsSync(barrel)) throw new BootError(`core barrel not found: ${barrel}`)
  const match = /from\s+"(\.\.\/chunks\/[^"]+)"/.exec(fs.readFileSync(barrel, "utf8"))
  if (!match) throw new BootError(`no chunk re-export found in ${barrel}`)
  const chunkReal = realpathBestEffort(path.resolve(path.dirname(barrel), match[1]))
  if (!isInside(distRoot, chunkReal))
    throw new BootError(
      `SessionContext chunk escapes the runtime core dist\n  chunk ${chunkReal}\n  dist  ${distRoot}`,
    )
  if (!fs.readFileSync(chunkReal, "utf8").includes('Effect.fn("SessionContext.select")'))
    throw new BootError(`${chunkReal} does not implement SessionContext.select`)

  const coreSha256 = sha256File(chunkReal)
  if (coreSha256 !== CORE_CONTEXT_SHA256)
    throw new BootError(
      `SessionContext chunk digest mismatch\n  expected ${CORE_CONTEXT_SHA256}\n  actual   ${coreSha256}\n` +
        `  run tools/opencode-runtime/patch.mjs apply against this runtime first`,
    )

  return {
    projectRoot,
    runtimeDir,
    modulesDir,
    configContent,
    stateDir: path.join(runtimeDir, "state"),
    instanceFile: path.join(runtimeDir, "state", "instance.json"),
    nonce: env.ORCHESTRA_INSTANCE_NONCE,
    password: env.OPENCODE_SERVER_PASSWORD,
    username: env.OPENCODE_SERVER_USERNAME?.trim() || DEFAULT_AUTH_USERNAME,
    coreSha256,
    coreChunk: chunkReal,
    serverEntry,
    effectEntry: effectPkg.entry,
    serverVersion: packageVersion(serverPkg.pkg, "@opencode/server"),
    coreVersion: packageVersion(corePkg.pkg, "@opencode/core"),
    sdkVersion: packageVersion(sdkPkg.pkg, "@opencode/sdk"),
    ...owned,
  }
}

function readPort(env) {
  const raw = env.ORCHESTRA_RUNTIME_PORT
  if (raw === undefined || String(raw).trim() === "") return 0
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new BootError(`ORCHESTRA_RUNTIME_PORT must be an integer 0..65535, got "${raw}"`)
  return port
}

/**
 * PURE builder for the exact options object handed to `ServerFetch.make`.
 *
 * This exists because the wiring is easy to get silently wrong. Native 2.0.18 `make()` configures
 * core as:
 *   Global.node.replace(Global.layerWith(options.config?.directory ? { config: options.config.directory } : {}), …)
 *   Config.configured({ project: options.config?.project, file: options.config?.file, content: options.config?.content })
 * Both fields matter and both fail silently when missing:
 *   - without `content` core processes no config at all — no orchestra plugin list, no `-orchestra`
 *     alias, no agents — while the server still boots and looks healthy;
 *   - without `directory` `Global.node` falls back to its own default config root, i.e. not the
 *     project-local one. Pinning it to the validated, runtime-owned config home keeps that lookup
 *     inside this instance instead of relying on an implicit global profile.
 * `project` and `file` stay unset on purpose: this launcher never writes a config file, and a
 * missing profile directory is fine (the owner creates it before start).
 *
 * Fail closed: missing content, password, database path or config home is refused instead of
 * building a half-configured server. Nothing here reads env or fs, so it is testable without a
 * runtime install.
 */
export function makeServerOptions(contract, { port = 0 } = {}) {
  if (!contract || typeof contract !== "object") throw new BootError("makeServerOptions: contract is missing")
  const content = contract.configContent
  if (typeof content !== "string" || content.trim() === "")
    throw new BootError(
      `makeServerOptions: ${CONFIG_ENV} was not validated into contract.configContent; ` +
        "refusing to boot a config-less server",
    )
  if (typeof contract.password !== "string" || contract.password === "")
    throw new BootError("makeServerOptions: OPENCODE_SERVER_PASSWORD is not set")
  if (typeof contract.database !== "string" || contract.database === "")
    throw new BootError("makeServerOptions: OPENCODE_DB is not set")
  // Already ownership-checked by readContract: absolute and inside the runtime dir, symlink-safe.
  if (typeof contract.configHome !== "string" || !path.isAbsolute(contract.configHome))
    throw new BootError("makeServerOptions: XDG_CONFIG_HOME was not validated into contract.configHome")
  return {
    hostname: "127.0.0.1",
    port,
    password: contract.password,
    app: { name: "orchestra-project-local", version: contract.coreVersion, channel: "dev" },
    database: { path: contract.database },
    // `directory` pins ONLY the config root. data/state keep coming from the private XDG env.
    config: { content, directory: path.join(contract.configHome, "opencode") },
  }
}

// ----------------------------------------------------------------- state file
/**
 * The instance record holds the Basic-auth password, so it is written with restrictive mode bits
 * and never logged. `0o600` is best effort: on Windows those bits do not restrict access, and no
 * ACL policy (icacls / SID rules) is applied from here on purpose — inventing a filesystem
 * security policy is out of this file's scope. Anyone needing a hard Windows ACL should apply it
 * to the whole runtime dir from the operator side, once.
 */
function writeInstanceFile(contract, record) {
  fs.mkdirSync(contract.stateDir, { recursive: true })
  const tmp = `${contract.instanceFile}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  try {
    fs.chmodSync(tmp, 0o600)
  } catch {
    /* best effort on platforms without POSIX bits */
  }
  fs.renameSync(tmp, contract.instanceFile)
}

/** Remove the state file only when it is still ours: matching pid AND matching nonce. */
function removeInstanceFile(contract) {
  try {
    const parsed = JSON.parse(fs.readFileSync(contract.instanceFile, "utf8"))
    if (parsed.pid !== process.pid || parsed.nonce !== contract.nonce) return false
    fs.rmSync(contract.instanceFile, { force: true })
    return true
  } catch {
    return false
  }
}

// ----------------------------------------------------------------------- main
export async function main(env = process.env) {
  const contract = readContract(env, process.cwd())
  const port = readPort(env)
  const expectedAuth = { username: contract.username, password: contract.password }
  // SQLite opens before the instance record is written; create its validated, owned parent first.
  fs.mkdirSync(path.dirname(contract.database), { recursive: true })

  const identity = {
    nonce: contract.nonce,
    pid: process.pid,
    projectRoot: contract.projectRoot,
    coreSha256: contract.coreSha256,
    coreVersion: contract.coreVersion,
    serverVersion: contract.serverVersion,
    sdkVersion: contract.sdkVersion,
    memoryDir: contract.memoryDir,
  }

  // Import last: this is the first moment the runtime's global providers can execute.
  const { Effect, Exit, Scope } = await import(pathToFileURL(contract.effectEntry).href)
  const { ServerFetch } = await import(pathToFileURL(contract.serverEntry).href)
  if (!ServerFetch || typeof ServerFetch.make !== "function")
    throw new BootError(`${contract.serverEntry} does not export ServerFetch.make`)

  // Own the Scope for the whole process. Effect.scoped() would release the layer on return.
  const scope = await Effect.runPromise(Scope.make())

  // The one and only options builder: pure, unit-tested, and byte-for-byte the object that
  // ServerFetch.make receives — including config.content, without which nothing in the orchestra
  // config would be processed.
  const options = makeServerOptions(contract, { port })

  let handler
  try {
    // `overrides` stays empty on purpose: patching is applied to the installed dist by
    // patch.mjs, not through the service-replacement channel.
    handler = await Effect.runPromise(
      Effect.provideService(ServerFetch.make(options, { overrides: [] }), Scope.Scope, scope),
    )
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {})
    throw new BootError(`ServerFetch.make failed: ${String(error?.stack ?? error)}`)
  }
  if (typeof handler !== "function") {
    await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {})
    throw new BootError(`ServerFetch.make returned ${typeof handler}, expected a function`)
  }

  let closing = false
  let deadline = null

  const hardExit = () => {
    if (deadline) clearTimeout(deadline)
    removeInstanceFile(contract)
    process.exit(0)
  }

  const beginShutdown = (reason) => {
    if (closing) return
    closing = true
    // Not unref'd on purpose: the deadline must keep the event loop alive, otherwise the process
    // could exit before Scope.close finished and the layer would be torn down uncleanly.
    deadline = setTimeout(hardExit, SHUTDOWN_GRACE_MS)
    // 1. stop accepting connections
    server.close(() => {})
    // 2. terminate the sockets this process owns (event/SSE streams are long-lived)
    const drain = setTimeout(() => server.closeAllConnections?.(), SOCKET_DRAIN_MS)
    // 3. release the layer in a finally, then exit — never kill another process
    Effect.runPromise(Scope.close(scope, Exit.void))
      .catch(() => {})
      .finally(() => {
        clearTimeout(drain)
        hardExit()
      })
    void reason
  }

  const server = http.createServer(async (req, res) => {
    const pathname = (req.url ?? "/").split("?")[0]

    if (pathname === INFO_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed" })
      if (!isAuthorized(req.headers.authorization, expectedAuth)) return sendJson(res, 401, { error: "unauthorized" })
      return sendJson(res, 200, { ...identity, url: serverUrl() })
    }

    if (pathname === SHUTDOWN_PATH) {
      if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" })
      if (!isAuthorized(req.headers.authorization, expectedAuth)) return sendJson(res, 401, { error: "unauthorized" })
      let nonce = null
      try {
        const raw = await readBody(req, MAX_SHUTDOWN_BODY)
        const parsed = raw.trim() === "" ? {} : JSON.parse(raw)
        nonce = typeof parsed === "object" && parsed !== null ? parsed.nonce : null
      } catch {
        return sendJson(res, 400, { error: "invalid_body" })
      }
      if (typeof nonce !== "string" || !constantTimeEquals(nonce, contract.nonce))
        return sendJson(res, 403, { error: "forbidden" })
      sendJson(res, 200, { ok: true })
      beginShutdown("http")
      return undefined
    }

    if (pathname.startsWith(RUNTIME_PREFIX)) return sendJson(res, 404, { error: "not_found" })

    // Native opencode API — untouched.
    try {
      const address = server.address()
      const host = req.headers.host ?? `${options.hostname}:${address?.port ?? port}`
      const hasBody = req.method !== "GET" && req.method !== "HEAD"
      const response = await handler(
        new Request(`http://${host}${req.url}`, {
          method: req.method,
          headers: { ...req.headers },
          // Node requires duplex:"half" whenever the request body is a stream.
          ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
        }),
      )
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (!response.body) return res.end()
      // Pipe, never buffer: event/SSE responses must stay incremental.
      Readable.fromWeb(response.body).pipe(res)
      return undefined
    } catch (error) {
      process.stderr.write(`orchestra-runtime: request failed: ${String(error?.message ?? error)}\n`)
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "internal_error" }))
      return undefined
    }
  })

  server.keepAliveTimeout = 5_000
  server.headersTimeout = 10_000

  const serverUrl = () => `http://127.0.0.1:${server.address()?.port ?? port}`

  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => rejectPromise(error)
    server.once("error", onError)
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError)
      resolvePromise()
    })
  })

  const startedAt = new Date().toISOString()
  const record = {
    pid: process.pid,
    url: serverUrl(),
    nonce: contract.nonce,
    password: contract.password,
    startedAt,
    ...identity,
  }
  writeInstanceFile(contract, record)

  // No options object, no password, no headers — url fingerprint only.
  process.stdout.write(
    `orchestra-runtime listening ${JSON.stringify({
      url: record.url,
      pid: record.pid,
      coreVersion: record.coreVersion,
      serverVersion: record.serverVersion,
      coreSha256: record.coreSha256,
      startedAt,
    })}\n`,
  )

  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => beginShutdown(signal))
  process.on("uncaughtException", (error) => {
    process.stderr.write(`orchestra-runtime: uncaught ${String(error?.stack ?? error)}\n`)
    beginShutdown("uncaughtException")
  })
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`orchestra-runtime: unhandled ${String(reason)}\n`)
  })

  return { server, contract, beginShutdown }
}

// ------------------------------------------------------------------- helpers
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        rejectPromise(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")))
    req.on("error", rejectPromise)
  })
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
}

// Importing this module for a pure test must not boot anything: the main body is guarded.
if (isMain()) {
  main().catch((error) => {
    const message = error instanceof BootError ? error.message : String(error?.stack ?? error)
    process.stderr.write(`orchestra-runtime: refusing to start\n${message}\n`)
    process.exit(4)
  })
}
