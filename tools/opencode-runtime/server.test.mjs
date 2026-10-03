/**
 * tools/opencode-runtime/server.test.mjs — pure guards for server.mjs.
 *
 * Nothing here boots a server, opens a socket or touches a runtime install: importing server.mjs
 * is side-effect free because its main body is guarded by an `import.meta.url === argv[1]` check,
 * and `readContract` performs reads only (no mkdir, no writes).
 *
 * The contract tests deliberately need no fixture: the runtime is not installed in this repo, so
 * every path they use is resolved through `realpathBestEffort` against the cwd. That is the point
 * — it proves OPENCODE_CONFIG_CONTENT is validated *before* any runtime package is looked up.
 *
 * The options tests need no runtime either: `makeServerOptions` is pure and takes a fake contract.
 */
import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"

import {
  CONFIG_ENV,
  CORE_CONTEXT_SHA256,
  CORE_VERSION,
  DEFAULT_AUTH_USERNAME,
  INFO_PATH,
  RUNTIME_PREFIX,
  SDK_VERSION,
  SERVER_VERSION,
  SHUTDOWN_GRACE_MS,
  SHUTDOWN_PATH,
  constantTimeEquals,
  isAuthorized,
  makeServerOptions,
  parseBasicAuth,
  readContract,
} from "./server.mjs"

const EXPECTED = { username: DEFAULT_AUTH_USERNAME, password: "s3cret-pass" }
const header = (username, password) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`

/** Ownership-clean env whose runtime dir lives under the cwd but is never created here. */
const cleanEnv = () => {
  const cwd = process.cwd()
  const runtime = path.join(cwd, ".orchestra-runtime")
  return {
    ORCHESTRA_RUNTIME_DIR: runtime,
    ORCHESTRA_PROJECT_ROOT: cwd,
    ORCHESTRA_INSTANCE_NONCE: "nonce-for-test",
    OPENCODE_SERVER_PASSWORD: "pw-for-test",
    ORCHESTRA_PROJECT_MEMORY: path.join(runtime, "memory"),
    OPENCODE_DB: path.join(runtime, "state", "project.sqlite"),
    XDG_CONFIG_HOME: path.join(runtime, "config"),
    XDG_DATA_HOME: path.join(runtime, "data"),
    XDG_STATE_HOME: path.join(runtime, "state"),
    [CONFIG_ENV]: '{"$schema":"https://opencode.ai/config.json"}',
  }
}

/** A stand-in contract: makeServerOptions is pure, so no installed runtime is required. */
const fakeContract = (configContent) => {
  const runtime = path.join(process.cwd(), ".orchestra-runtime")
  return {
    configContent,
    password: "pw-for-test",
    database: path.join(runtime, "state", "project.sqlite"),
    configHome: path.join(runtime, "config"),
    coreVersion: CORE_VERSION,
    nonce: "nonce-for-test",
    memoryDir: path.join(runtime, "memory"),
  }
}

test("contract constants are the pinned 2.0.18 identity", () => {
  assert.equal(CORE_VERSION, "2.0.18")
  assert.equal(SERVER_VERSION, "2.0.18")
  assert.equal(SDK_VERSION, "2.0.18")
  assert.equal(CORE_CONTEXT_SHA256, "8059d066210bbfd04511aeacbe13589f6ca5481254b8c8c2215b8869943a36cc")
  assert.equal(INFO_PATH, "/__orchestra_runtime/info")
  assert.equal(SHUTDOWN_PATH, "/__orchestra_runtime/shutdown")
  assert.equal(RUNTIME_PREFIX, "/__orchestra_runtime/")
  assert.ok(SHUTDOWN_GRACE_MS <= 8_000)
})

test("constantTimeEquals compares content, not identity", () => {
  assert.equal(constantTimeEquals("abc", "abc"), true)
  assert.equal(constantTimeEquals("abc", "abd"), false)
  assert.equal(constantTimeEquals("abc", "abcd"), false)
  assert.equal(constantTimeEquals("", ""), true)
  assert.equal(constantTimeEquals(undefined, null), true)
})

test("parseBasicAuth splits the first colon only", () => {
  assert.deepEqual(parseBasicAuth(header("opencode", "a:b")), { username: "opencode", password: "a:b" })
  assert.deepEqual(parseBasicAuth(header("opencode", "")), { username: "opencode", password: "" })
  assert.equal(parseBasicAuth(undefined), null)
  assert.equal(parseBasicAuth(""), null)
  assert.equal(parseBasicAuth("Bearer token"), null)
  assert.equal(parseBasicAuth(`Basic ${Buffer.from("no-colon").toString("base64")}`), null)
  assert.equal(parseBasicAuth("Basic !!!not-base64!!!"), null)
})

test("isAuthorized accepts only the exact instance credentials", () => {
  assert.equal(isAuthorized(header("opencode", "s3cret-pass"), EXPECTED), true)
  assert.equal(isAuthorized(header("opencode", "s3cret-pass "), EXPECTED), false)
  assert.equal(isAuthorized(header("opencode", "s3cret"), EXPECTED), false)
  assert.equal(isAuthorized(header("Opencode", "s3cret-pass"), EXPECTED), false)
  assert.equal(isAuthorized(header("admin", "s3cret-pass"), EXPECTED), false)
  assert.equal(isAuthorized(undefined, EXPECTED), false)
  assert.equal(isAuthorized("", EXPECTED), false)
})

test("isAuthorized never trusts an unconfigured password", () => {
  for (const password of [undefined, null, ""]) {
    assert.equal(isAuthorized(header("opencode", password), { username: DEFAULT_AUTH_USERNAME, password }), false)
    assert.equal(isAuthorized(header("opencode", ""), { username: DEFAULT_AUTH_USERNAME, password }), false)
  }
  assert.equal(isAuthorized(header("opencode", "s3cret-pass"), undefined), false)
})

test("honours a non-default username without falling back", () => {
  const expected = { username: "orchestra", password: "pw" }
  assert.equal(isAuthorized(header("orchestra", "pw"), expected), true)
  assert.equal(isAuthorized(header(DEFAULT_AUTH_USERNAME, "pw"), expected), false)
})

test(`${CONFIG_ENV} is required under its opencode-prefixed name only`, () => {
  const env = cleanEnv()
  delete env[CONFIG_ENV]
  assert.throws(() => readContract(env), new RegExp(`${CONFIG_ENV} is required`))
  // The unprefixed name is what core ignores, so it must not satisfy the guard.
  assert.throws(
    () => readContract({ ...env, CONFIG_CONTENT: env[CONFIG_ENV] }),
    new RegExp(`${CONFIG_ENV} is required`),
  )
  assert.throws(
    () => readContract({ ...env, [CONFIG_ENV]: "   " }),
    new RegExp(`${CONFIG_ENV} is required`),
  )
})

test(`${CONFIG_ENV} must be a JSON object`, () => {
  for (const bad of ["{not json", "[1,2]", '"text"', "null", "42"]) {
    assert.throws(
      () => readContract({ ...cleanEnv(), [CONFIG_ENV]: bad }),
      new RegExp(`${CONFIG_ENV} (is not valid JSON|must be a JSON object)`),
      `expected refusal for ${bad}`,
    )
  }
})

test(`${CONFIG_ENV} is validated before any runtime package is looked up`, () => {
  // Invalid config must fail before package lookup, even when a runtime is already installed.
  assert.throws(
    () => readContract({ ...cleanEnv(), [CONFIG_ENV]: "{oops" }),
    new RegExp(`${CONFIG_ENV} is not valid JSON`),
  )
  // And a valid value clears this stage: whatever fails next must not blame the config.
  try {
    readContract(cleanEnv())
    assert.ok(true, "contract satisfied (a fully installed runtime is not required by this test)")
  } catch (error) {
    assert.ok(
      !String(error?.message).includes(CONFIG_ENV),
      `config stage must pass before the next one: ${error?.message}`,
    )
  }
})

test("ownership checks refuse a path outside the runtime dir", () => {
  const env = cleanEnv()
  const outside = process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp"
  assert.throws(
    () => readContract({ ...env, XDG_DATA_HOME: outside }),
    /XDG_DATA_HOME escapes the runtime dir/,
  )
  assert.throws(
    () => readContract({ ...env, ORCHESTRA_PROJECT_MEMORY: "relative/memory" }),
    /ORCHESTRA_PROJECT_MEMORY must be absolute/,
  )
  assert.throws(
    () => readContract({ ...env, ORCHESTRA_PROJECT_ROOT: path.join(env.ORCHESTRA_PROJECT_ROOT, "..") }),
    /ORCHESTRA_PROJECT_ROOT must be the cwd/,
  )
})

test("makeServerOptions hands the validated config to ServerFetch.make as config.content", () => {
  // Native 2.0.18 make() reads options.config?.content and options.config?.directory. This is the
  // regression pin: the orchestra plugin list and the `-orchestra` alias live in this string, and a
  // missing `directory` would silently fall back to Global.node's own (non project-local) root.
  const content = '{"plugins":["-orchestra",{"package":"runtime/plugins/orchestra"}]}'
  const contract = fakeContract(content)
  const options = makeServerOptions(contract, { port: 4321 })

  assert.equal(options.config.content, content, "config content must be the exact validated string")
  assert.equal(options.config.directory, path.join(contract.configHome, "opencode"))
  assert.equal(path.dirname(options.config.directory), contract.configHome)
  assert.ok(options.config.directory.startsWith(contract.configHome + path.sep))
  assert.deepEqual(Object.keys(options.config).sort(), ["content", "directory"])

  assert.equal(options.hostname, "127.0.0.1")
  assert.equal(options.port, 4321)
  assert.equal(options.password, contract.password)
  assert.deepEqual(options.database, { path: contract.database })
  assert.deepEqual(options.app, {
    name: "orchestra-project-local",
    version: CORE_VERSION,
    channel: "dev",
  })
  // Nothing beyond the documented surface: no nonce, no memory dir, no env snapshot.
  assert.equal(options.nonce, undefined)
  assert.equal(options.memoryDir, undefined)
  assert.deepEqual(Object.keys(options).sort(), ["app", "config", "database", "hostname", "password", "port"])
})

test("makeServerOptions defaults to an ephemeral port and fails closed", () => {
  const contract = fakeContract("{}")
  assert.equal(makeServerOptions(contract).port, 0)
  for (const bad of [undefined, null, "", "   ", 42, {}]) {
    assert.throws(
      () => makeServerOptions({ ...contract, configContent: bad }),
      /refusing to boot a config-less server/,
      `expected refusal for ${JSON.stringify(bad)}`,
    )
  }
  assert.throws(() => makeServerOptions({ ...contract, password: "" }), /OPENCODE_SERVER_PASSWORD is not set/)
  assert.throws(() => makeServerOptions({ ...contract, database: undefined }), /OPENCODE_DB is not set/)
  assert.throws(() => makeServerOptions({ ...contract, configHome: undefined }), /configHome/)
  assert.throws(() => makeServerOptions({ ...contract, configHome: "relative/config" }), /configHome/)
  assert.throws(() => makeServerOptions(undefined), /contract is missing/)
})