/**
 * Unit tests for tools/opencode-runtime/patch.mjs.
 *
 * Run: node --test tools/opencode-runtime/patch.test.mjs
 *
 * The runtime under test is built here, in a throwaway temp dir, from the tracked fixture
 * `fixtures/session-context-original.js`. That fixture is a byte-exact copy of the real
 * `@opencode/core@2.0.18` chunk `dist/chunks/config-sf0wnj4a.js` (5819 bytes, sha256 09b0ed4d…),
 * so these tests exercise the real production bytes. The chunk is never imported — it pulls in
 * hundreds of sibling chunks and Effect 4, and none of that is what is under test. What is under
 * test is the text transform and its guards, and those are exactly what the hashes pin down.
 *
 * No network, no npm install, no global runtime, nothing outside mkdtemp.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

import { ORIGINAL_SHA256, PATCHED_SHA256, patchRuntime } from "./patch.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(HERE, "fixtures", "session-context-original.js")

/** Shape of the real published barrel: implementation re-exported from a content-hashed chunk. */
const BARREL = [
  "import {",
  "  Service28,",
  "  node31,",
  "  exports_context",
  '} from "../chunks/config-sf0wnj4a.js";',
  "export {",
  "  Service28 as Service,",
  "  exports_context as SessionContext,",
  "  node31 as node",
  "};",
  "",
].join("\n")

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const shaFile = (path) => sha(readFileSync(path))
const CHUNK = "dist/chunks/config-sf0wnj4a.js"

const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function makeRuntime({ version = "2.0.18", name = "@opencode/core" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-runtime-patch-"))
  roots.push(root)
  const core = join(root, "node_modules", "@opencode", "core")
  mkdirSync(join(core, "dist", "session"), { recursive: true })
  mkdirSync(join(core, "dist", "chunks"), { recursive: true })
  writeFileSync(join(core, "package.json"), `${JSON.stringify({ name, version }, null, 2)}\n`)
  writeFileSync(join(core, "dist", "session", "context.js"), BARREL, "utf8")
  writeFileSync(join(core, CHUNK), readFileSync(FIXTURE))
  return { root, core, impl: join(core, CHUNK) }
}

const ledgerPath = (root) => join(root, "patch", "ledger.json")
const backupPath = (root) =>
  join(root, "patch", "backup", "node_modules__@opencode__core__dist__chunks__config-sf0wnj4a.js.2.0.18.bak")

test("fixture is the real, unmodified 2.0.18 chunk", () => {
  assert.equal(statSync(FIXTURE).size, 5819)
  assert.equal(shaFile(FIXTURE), ORIGINAL_SHA256)
})

test("apply -> patched -> restore, and the ledger records both hashes", () => {
  const { root, impl } = makeRuntime()

  const before = patchRuntime(root, "status")
  assert.equal(before.state, "original")
  assert.equal(before.actualSha256, ORIGINAL_SHA256)

  const applied = patchRuntime(root, "apply")
  assert.deepEqual(Object.keys(applied).sort(), [
    "actualSha256",
    "afterSha256",
    "beforeSha256",
    "implementationPath",
    "state",
    "version",
  ])
  assert.equal(applied.state, "patched")
  assert.equal(applied.version, "2.0.18")
  assert.equal(applied.beforeSha256, ORIGINAL_SHA256)
  assert.equal(applied.afterSha256, PATCHED_SHA256)
  assert.equal(applied.actualSha256, PATCHED_SHA256)
  assert.equal(shaFile(impl), PATCHED_SHA256)

  const text = readFileSync(impl, "utf8")
  assert.match(text, /import \{ Plugin \} from "\.\.\/plugin\/service\.js";/)
  assert.match(text, /import \{ Option, Context, Effect, Layer \} from "effect";/)
  // barrier sits between the flush and the agent lookup, in that order
  const flush = text.indexOf("yield* mcpTools.flush;")
  const guard = text.indexOf("yield* Effect.serviceOption(Plugin.Service).pipe(")
  const select = text.indexOf("const agent = yield* agents.select(session.agent);")
  assert.ok(flush < guard && guard < select, "guard must sit between flush and agents.select")
  assert.equal(text.split("\n").filter((l) => l.includes("serviceOption")).length, 1)

  const ledger = JSON.parse(readFileSync(ledgerPath(root), "utf8"))
  assert.equal(ledger.records.length, 1)
  assert.equal(ledger.records[0].beforeSha256, ORIGINAL_SHA256)
  assert.equal(ledger.records[0].afterSha256, PATCHED_SHA256)
  assert.equal(shaFile(backupPath(root)), ORIGINAL_SHA256, "backup must hold the pristine original")

  assert.equal(patchRuntime(root, "status").state, "patched")

  const restored = patchRuntime(root, "restore")
  assert.equal(restored.state, "original")
  assert.equal(restored.actualSha256, ORIGINAL_SHA256)
  assert.equal(shaFile(impl), ORIGINAL_SHA256)
  assert.equal(shaFile(backupPath(root)), ORIGINAL_SHA256, "restore must not consume the backup")
})

test("apply twice is a no-op", () => {
  const { root, impl } = makeRuntime()
  const first = patchRuntime(root, "apply")
  const afterFirst = readFileSync(impl)
  const ledgerFirst = readFileSync(ledgerPath(root))

  const second = patchRuntime(root, "apply")
  assert.equal(second.state, "patched")
  assert.equal(second.actualSha256, first.actualSha256)
  assert.deepEqual(readFileSync(impl), afterFirst)
  assert.deepEqual(readFileSync(ledgerPath(root)), ledgerFirst)
})

test("restore twice is a no-op", () => {
  const { root, impl } = makeRuntime()
  patchRuntime(root, "apply")
  const first = patchRuntime(root, "restore")
  const ledgerFirst = readFileSync(ledgerPath(root))

  const second = patchRuntime(root, "restore")
  assert.equal(second.state, "original")
  assert.equal(second.actualSha256, first.actualSha256)
  assert.equal(shaFile(impl), ORIGINAL_SHA256)
  assert.deepEqual(readFileSync(ledgerPath(root)), ledgerFirst)
})

test("a modified target is reported as conflict and never overwritten", () => {
  const { root, impl } = makeRuntime()
  patchRuntime(root, "apply")
  const tampered = readFileSync(impl).toString("utf8") + "\n// local edit\n"
  writeFileSync(impl, tampered)

  for (const action of ["apply", "restore", "status"]) {
    const res = patchRuntime(root, action)
    assert.equal(res.state, "conflict", `${action} must refuse`)
    assert.equal(res.actualSha256, sha(tampered))
    assert.equal(readFileSync(impl).toString("utf8"), tampered, `${action} must not write`)
  }
})

test("a corrupt backup refuses to restore", () => {
  const { root, impl } = makeRuntime()
  patchRuntime(root, "apply")
  writeFileSync(backupPath(root), "// truncated backup\n")

  assert.throws(() => patchRuntime(root, "restore"), /yedek bozuk/)
  assert.equal(shaFile(impl), PATCHED_SHA256, "a refused restore must leave the file alone")
})

test("a wrong core version is rejected before anything is read", () => {
  const { root } = makeRuntime({ version: "2.0.19" })
  assert.throws(() => patchRuntime(root, "apply"), /sürümü 2\.0\.19 desteklenmiyor/)
  assert.equal(existsSync(ledgerPath(root)), false)
})

test("a foreign package name is rejected", () => {
  const { root } = makeRuntime({ name: "@opencode/plugin" })
  assert.throws(() => patchRuntime(root, "apply"), /paket adı/)
})

test("a missing runtime is reported, not thrown at as ENOENT", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-runtime-patch-"))
  roots.push(root)
  assert.throws(() => patchRuntime(join(root, "nope"), "apply"), /runtime dizini yok/)
})

test("an unknown action is rejected", () => {
  const { root } = makeRuntime()
  assert.throws(() => patchRuntime(root, "repatch"), /bilinmeyen action/)
})

test("restore refuses while a runtime is alive; the patcher never signals it", () => {
  const { root } = makeRuntime()
  patchRuntime(root, "apply")
  const instance = join(root, "state", "instance.json")
  mkdirSync(join(root, "state"), { recursive: true })
  // the authoritative connection file the controller writes
  writeFileSync(
    instance,
    JSON.stringify({ pid: process.pid, url: "http://127.0.0.1:4096", nonce: "test", status: "running" }),
  )

  assert.throws(() => patchRuntime(root, "restore"), /calisiyor/)
  assert.equal(shaFile(join(root, "node_modules", "@opencode", "core", CHUNK)), PATCHED_SHA256)

  // a stale instance file is not a blocker
  writeFileSync(
    instance,
    JSON.stringify({ pid: 0x7ffffffe, url: null, nonce: null, status: "stopped" }),
  )
  assert.equal(patchRuntime(root, "restore").state, "original")
})

test("the legacy state.json is still a live check, and an unreadable record fails closed", () => {
  const legacyRoot = makeRuntime().root
  patchRuntime(legacyRoot, "apply")
  writeFileSync(join(legacyRoot, "state.json"), JSON.stringify({ pid: process.pid, status: "running" }))
  assert.throws(() => patchRuntime(legacyRoot, "restore"), /calisiyor/)

  // a pid-less authoritative record cannot prove the runtime is stopped -> refuse
  const badRoot = makeRuntime().root
  patchRuntime(badRoot, "apply")
  mkdirSync(join(badRoot, "state"), { recursive: true })
  writeFileSync(join(badRoot, "state", "instance.json"), JSON.stringify({ url: null, nonce: null }))
  assert.throws(() => patchRuntime(badRoot, "restore"), /belirsiz durum/)
})

test("a target escaping the runtime root through a junction is refused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestra-runtime-patch-"))
  roots.push(root)
  const outside = mkdtempSync(join(tmpdir(), "orchestra-outside-"))
  roots.push(outside)

  const core = join(outside, "core")
  mkdirSync(join(core, "dist", "session"), { recursive: true })
  mkdirSync(join(core, "dist", "chunks"), { recursive: true })
  writeFileSync(join(core, "package.json"), JSON.stringify({ name: "@opencode/core", version: "2.0.18" }))
  writeFileSync(join(core, "dist", "session", "context.js"), BARREL, "utf8")
  writeFileSync(join(core, CHUNK), readFileSync(FIXTURE))

  mkdirSync(join(root, "node_modules", "@opencode"), { recursive: true })
  try {
    symlinkSync(core, join(root, "node_modules", "@opencode", "core"), "junction")
  } catch {
    t.skip("junction not permitted on this platform/account")
    return
  }
  assert.throws(() => patchRuntime(root, "apply"), /runtime disina kaciyor|disina kaciyor/)
  assert.equal(shaFile(join(core, CHUNK)), ORIGINAL_SHA256, "the escaped target must be untouched")
})

test("the CLI has no arbitrary target flag and defaults to a repo-local runtime dir", () => {
  const cli = resolve(HERE, "patch.mjs")

  // rejection paths only: these exit during argument parsing, before any filesystem write, so
  // running them against the real checkout is safe whatever the real runtime is doing
  const denied = spawnSync(process.execPath, [cli, "--core", "C:/somewhere/else"], { encoding: "utf8" })
  assert.equal(denied.status, 1)
  assert.match(denied.stderr, /bilinmeyen arguman/)

  const usage = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" })
  assert.equal(usage.status, 1)

  // The default-target assertion runs against a *copied* CLI in a throwaway repo, never the real
  // one: the real .orchestra-runtime may be absent, installed, or running, and the result must
  // not depend on that. The copy computes its default as <fixtureRoot>/.orchestra-runtime, which
  // this test owns and knows is absent. Nothing outside the fixture root is read or written.
  const fixtureRoot = mkdtempSync(join(tmpdir(), "orchestra-cli-fixture-"))
  roots.push(fixtureRoot)
  const fixtureCli = join(fixtureRoot, "tools", "opencode-runtime", "patch.mjs")
  mkdirSync(dirname(fixtureCli), { recursive: true })
  copyFileSync(cli, fixtureCli)

  const fixtureRuntime = join(fixtureRoot, ".orchestra-runtime")
  assert.equal(existsSync(fixtureRuntime), false, "fixture runtime must start absent")

  const missing = spawnSync(process.execPath, [fixtureCli, "status"], { encoding: "utf8" })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /runtime dizini yok/)
  assert.equal(existsSync(fixtureRuntime), false, "a read-only status must not create the runtime dir")
})