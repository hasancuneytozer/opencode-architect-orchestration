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
  let prompt
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
    if (url.includes("/reference?")) return Response.json({ projectId: "plan" })
    if (init.method === "DELETE") return Response.json({ revoked: true })
    if (url.endsWith("/mcp/clients")) return Response.json({ clientId: "fixture-client", clientToken: "fixture" })
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
  prompt({ sessionID: "parent", prompt: { text: reference } })
  await assert.rejects(invoke("bind", "parent", { ...assign, workerId: "sibling" }), /görev defterinde/)
  await invoke("bind", "parent", assign)
  await assert.rejects(invoke("report_assigned", "sibling", {}), /raporlanabilir/)
  await assert.rejects(invoke("report_assigned", "maker", {}, "crew/verifier"), /raporlanabilir/)
  await invoke("read_assigned", "maker", {})
  await invoke("report_assigned", "maker", { summary: "Teslim", evidence: "Test" })
  await assert.rejects(invoke("report_assigned", "maker", {}), /zaten/)
  await invoke("bind", "parent", { ...assign, ledgerId: ledger.list()[1].id, workerId: "verifier" })
  await invoke("report_assigned", "verifier", { summary: "Kontrol", evidence: "Test", outcome: "passed", deliveryId: "fixture-report" })
  assert.deepEqual(requests.filter(([, , body]) => body?.assignment).map(([, , b]) => b.assignment), [
    { flowId: "flow", taskId: "step", role: "maker", actor: "maker" },
    { flowId: "flow", taskId: "step", role: "maker", actor: "maker" },
    { flowId: "flow", taskId: "step", role: "verifier", actor: "verifier" },
  ])
  assert.equal(requests.filter(([, method]) => method === "DELETE").length, 3)
  assert.deepEqual(notifications, ["maker", "verifier"])
  assert.equal((await ledger.update({ id: assign.ledgerId, status: "verifying" })).ok, true)
  await assert.rejects(invoke("read_assigned", "maker", {}), /görev defterinde/)
})
