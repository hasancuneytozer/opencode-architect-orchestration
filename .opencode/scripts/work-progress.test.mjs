import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { Memory } from "../plugins/orchestra/memory.ts"
import { TaskLedger } from "../plugins/orchestra/tasks.ts"
import { registerWorkProgress } from "../plugins/orchestra/work-progress.ts"

test("only the actual running Orchestra worker can report its assigned workflow task", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "orchestra-progress-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const memory = await Memory.open(path.join(directory, ".opencode", "memory"))
  const ledger = await TaskLedger.open(memory, directory, "parent")
  for (const [role, workerID] of [["maker", "maker"], ["verifier", "verifier"]]) {
    assert.equal((await ledger.add({ title: role, role: "crew/" + role, acceptance: "Evidence: " + role })).ok, true)
    assert.equal((await ledger.update({ id: ledger.list().at(-1).id, status: "running", workerID })).ok, true)
  }
  const sessions = {
    parent: { id: "parent", agent: "architect" },
    maker: { id: "maker", parentID: "parent", agent: "crew/maker" },
    verifier: { id: "verifier", parentID: "parent", agent: "crew/verifier" },
    sibling: { id: "sibling", parentID: "parent", agent: "crew/maker" },
  }
  const dispose = { dispose: async () => {} }
  const tools = new Map(), requests = [], notifications = []
  let prompt, latestDelivery = "fixture-report"
  const ctx = {
    location: { directory },
    session: {
      hook: async (_, callback) => { prompt = callback; return dispose },
      get: async ({ sessionID }) => sessions[sessionID],
      prompt: async ({ sessionID }) => { notifications.push(sessionID) },
    },
    tool: {
      transform: async fn => { fn({ namespace() {}, add: tool => tools.set(tool.name, tool) }); return dispose },
    },
  }
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null
    requests.push([new URL(url).pathname, init.method, body])
    if (init.headers.Authorization) assert.equal(init.headers.Authorization, "Bearer fixture")
    if (url.includes("/reference?")) return Response.json({
      projectId: "plan",
      task: { status: "review", reports: [
        { id: latestDelivery, role: "maker" },
        { id: "older-verification", role: "verifier", deliveryId: "older-delivery" },
      ] },
    })
    if (init.method === "DELETE") return Response.json({ revoked: true })
    if (url.endsWith("/mcp/clients")) return Response.json({ clientId: "fixture-client", clientToken: "fixture" })
    if (body.tool === "work_progress_task") {
      return Response.json({ task: { status: "review", reports: [{ id: latestDelivery, role: "maker" }] } })
    }
    if (body.args.deliveryId && body.args.deliveryId !== latestDelivery) return new Response(null, { status: 409 })
    return Response.json({ reportId: "fixture-report" })
  }
  const release = await registerWorkProgress(ctx, memory)
  t.after(release)
  const invoke = (tool, sessionID, args, agent = sessions[sessionID].agent) => tools.get(tool).execute(args, {
    sessionID, agent, signal: new AbortController().signal, id: "call-fixture",
  })
  const reference = "http://127.0.0.1:5173/is-akisi?project=plan&work=flow&task=step"
  const assign = { reference, ledgerId: ledger.list()[0].id, workerId: "maker" }
  await assert.rejects(invoke("bind", "parent", assign), /son kullanıcı/)
  await assert.rejects(invoke("inspect_delivery", "parent", { reference }), /son kullanıcı/)
  prompt({ sessionID: "parent", prompt: { text: reference } })
  await assert.rejects(invoke("bind", "parent", { ...assign, workerId: "sibling" }), /görev defterinde/)
  await invoke("bind", "parent", assign)
  await assert.rejects(invoke("report_assigned", "sibling", {}), /raporlanabilir/)
  await assert.rejects(invoke("report_assigned", "maker", {}, "crew/verifier"), /yalnız Maker/)
  await invoke("read_assigned", "maker", {})
  await invoke("report_assigned", "maker", { summary: "Teslim", evidence: "Test" })
  await assert.rejects(invoke("report_assigned", "maker", {}), /zaten/)
  await invoke("bind", "parent", { ...assign, ledgerId: ledger.list()[1].id, workerId: "verifier" })
  const verification = { summary: "Kontrol", evidence: "Test kanıtı", outcome: "failed" }
  assert.deepEqual(Object.keys(tools.get("report_assigned").input.properties), ["summary", "evidence"])
  assert.deepEqual(Object.keys(tools.get("verify_assigned").input.properties), ["summary", "evidence", "outcome"])
  await assert.rejects(invoke("verify_assigned", "maker", verification), /yalnız Verifier/)
  await assert.rejects(invoke("verify_assigned", "verifier", verification), /Önce/)
  await invoke("read_assigned", "verifier", {})
  latestDelivery = "new-delivery"
  await assert.rejects(invoke("verify_assigned", "verifier", verification), /409/)
  await invoke("read_assigned", "verifier", {})
  await invoke("verify_assigned", "verifier", verification)
  const reports = requests.filter(([, , body]) => body?.tool === "work_progress_report").map(([, , b]) => b.args)
  assert.deepEqual(reports, [{ summary: "Teslim", evidence: "Test" }, { ...verification, deliveryId: "fixture-report" }, { ...verification, deliveryId: "new-delivery" }])
  const inspected = JSON.parse((await invoke("inspect_delivery", "parent", { reference })).content)
  assert.deepEqual(inspected, { status: "review", delivery: { id: "new-delivery", role: "maker" } })
  assert.deepEqual(requests.filter(([, , body]) => body?.assignment).map(([, , b]) => b.assignment), [
    { flowId: "flow", taskId: "step", role: "maker", actor: "maker" },
    { flowId: "flow", taskId: "step", role: "maker", actor: "maker" },
    { flowId: "flow", taskId: "step", role: "verifier", actor: "verifier" },
    { flowId: "flow", taskId: "step", role: "verifier", actor: "verifier" },
    { flowId: "flow", taskId: "step", role: "verifier", actor: "verifier" },
    { flowId: "flow", taskId: "step", role: "verifier", actor: "verifier" },
  ])
  assert.equal(requests.filter(([, method]) => method === "DELETE").length, 6)
  assert.deepEqual(notifications, ["maker", "verifier"])
  assert.equal((await ledger.update({ id: assign.ledgerId, status: "verifying" })).ok, true)
  await assert.rejects(invoke("read_assigned", "maker", {}), /görev defterinde/)
})
