import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { Memory } from "../plugins/orchestra/memory.ts"
import { TaskLedger } from "../plugins/orchestra/tasks.ts"
import { registerWorkProgress } from "../plugins/orchestra/work-progress.ts"

const reference = "http://127.0.0.1:5173/is-akisi?project=plan&work=flow&task=step"
const delivery = { summary: "Teslim", evidence: "Test" }
const failed = { summary: "Eksik çıktı", evidence: "Sınır testi", outcome: "failed" }
const passed = { summary: "Kabul", evidence: "Tümleşim testi", outcome: "passed" }

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "orchestra-progress-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const memory = await Memory.open(path.join(directory, ".opencode", "memory"))
  const ledger = () => TaskLedger.open(memory, directory, "parent")
  const sessions = {
    parent: { id: "parent", agent: "architect" },
    other: { id: "other", agent: "architect" },
    maker: { id: "maker", parentID: "parent", agent: "crew/maker" },
    verifier: { id: "verifier", parentID: "parent", agent: "crew/verifier" },
    sibling: { id: "sibling", parentID: "parent", agent: "crew/maker" },
    outsider: { id: "outsider", parentID: "other", agent: "crew/maker" },
  }
  const tools = new Map(),
    notifications = [],
    clients = new Map(),
    attempts = []
  let onPrompt,
    callCount = 0,
    clientCount = 0,
    revision = 1,
    lost = false,
    failNotification = false,
    prereq = "done"
  const task = { id: "step", title: "Fixture", status: "waiting", update: "Mevcut plan", reports: [] }
  const dispose = { dispose: async () => {} }
  const ctx = {
    location: { directory },
    session: {
      hook: async (_, cb) => {
        onPrompt = cb
        return dispose
      },
      get: async ({ sessionID }) => sessions[sessionID],
      prompt: async ({ sessionID }) => {
        if (failNotification) {
          failNotification = false
          throw Error("prompt interruption")
        }
        notifications.push(sessionID)
      },
    },
    tool: {
      transform: async (fn) => {
        fn({ namespace() {}, add: (tool) => tools.set(tool.name, tool) })
        return dispose
      },
    },
  }
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = async (url, init) => {
    const pathname = new URL(url).pathname
    const body = init.body && JSON.parse(init.body)
    if (pathname === "/work-progress/reference")
      return Response.json({ projectId: "plan", revision, task, prerequisites: [{ status: prereq }] })
    if (pathname === "/work-progress/flow/tasks" && init.method === "PUT") {
      if (revision !== body.revision || body.id !== task.id) return new Response(null, { status: 409 })
      task.update = body.update
      revision++
      return Response.json({ revision, task })
    }
    if (pathname === "/mcp/clients" && init.method === "POST") {
      if (task.status === "done") return new Response(null, { status: 403 })
      const clientId = String(++clientCount)
      clients.set(clientId, body.assignment)
      return Response.json({ clientId, clientToken: clientId })
    }
    if (init.method === "DELETE") {
      clients.delete(pathname.split("/").at(-1))
      return Response.json({ revoked: true })
    }
    assert.equal(pathname, "/mcp/call")
    const { actor, role, taskId, flowId } = clients.get(init.headers.Authorization.slice(7))
    assert.deepEqual([taskId, flowId], ["step", "flow"])
    const scopedTask = () => ({ ...task, reports: task.reports.map(({ requestId, ...entry }) => entry) })
    if (body.tool === "work_progress_task") return Response.json({ task: scopedTask() })
    assert.equal(body.tool, "work_progress_report")
    attempts.push(body.args)
    const maker = role === "maker"
    assert.deepEqual(
      Object.keys(body.args).sort(),
      maker ? ["evidence", "summary"] : ["deliveryId", "evidence", "outcome", "summary"]
    )
    const prior = task.reports.findLast((r) => r.role === "maker")
    if (
      maker
        ? !["waiting", "active", "blocked"].includes(task.status)
        : task.status !== "review" || prior.id !== body.args.deliveryId || prior.actor === actor
    )
      return new Response(null, { status: 409 })
    task.status = maker ? "review" : body.args.outcome === "passed" ? "done" : "blocked"
    const report = {
      id: "receipt-" + (task.reports.length + 1),
      actor,
      role,
      requestId: body.idempotencyKey,
      deliveryId: null,
      outcome: "delivered",
      ...body.args,
    }
    task.reports.push(report)
    revision++
    if (lost) {
      lost = false
      throw Error("ack lost")
    }
    return Response.json({ reportId: report.id, task: scopedTask() })
  }
  let release = await registerWorkProgress(ctx, memory)
  t.after(() => release())
  const invoke = (name, sessionID, args = {}, id = String(++callCount), agent = sessions[sessionID].agent) =>
    tools.get(name).execute(args, { sessionID, agent, signal: new AbortController().signal, id })
  const assign = (workerId, extra = {}) =>
    invoke("assign", "parent", {
      reference,
      workerId,
      acceptance: "Test koşulu",
      writeSurface: workerId === "verifier" ? [] : ["src/a.ts"],
      ...extra,
    })
  return {
    invoke,
    ledger,
    notifications,
    task,
    clients,
    attempts,
    assign,
    linked: (id) => release.isLinked(id),
    authorize: (id = "parent", text = reference) => onPrompt({ sessionID: id, prompt: { text } }),
    restart: async () => {
      await release()
      release = await registerWorkProgress(ctx, memory)
    },
    loseAck: () => {
      lost = true
    },
    failPrompt: () => {
      failNotification = true
    },
    prerequisite: (state) => {
      prereq = state
    },
  }
}

test("workflow admission preserves role, user reference, dependencies, owner and write scope", async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.assign("maker"), /son kullanıcı/)
  f.authorize()
  await assert.rejects(f.assign("outsider"), /alt oturum/)
  f.prerequisite("waiting")
  await assert.rejects(f.assign("maker"), /önkoşulları/)
  f.prerequisite("done")
  await f.assign("maker")
  assert.match(f.task.update, /Mevcut plan\nOrchestra maker/u)
  assert.deepEqual(f.notifications, ["maker"])
  await f.assign("maker")
  await assert.rejects(f.assign("sibling"), /sahip|sahibi/)
  await assert.rejects(f.assign("maker", { writeSurface: ["other.ts"] }), /kapsam/)
  await assert.rejects(f.invoke("report_assigned", "sibling", delivery), /raporlanabilir/)
  await assert.rejects(f.invoke("report_assigned", "maker", delivery, "bad", "crew/verifier"), /yalnız Maker/)
  assert.equal(await f.linked("maker"), true)
  assert.equal(await f.linked("sibling"), false)
  await f.restart()
  await assert.rejects(f.invoke("inspect_delivery", "other", { reference }), /son kullanıcı/)
  await f.invoke("inspect_delivery", "parent", { reference })
  assert.equal(await f.linked("parent"), true)
  f.authorize("parent", "Devam et.")
  assert.equal(await f.linked("parent"), true)
  f.authorize("parent", "Yeni bağımsız görev")
  assert.equal(await f.linked("parent"), false)
  assert.equal((await f.ledger()).list().length, 1)
})

test("legacy bind rejects sibling, freezes the link and recovers admitted owner after restart", async (t) => {
  const f = await fixture(t),
    ledger = await f.ledger()
  const added = await ledger.add({ title: "Mevcut iş", role: "crew/maker", acceptance: "Kanıt", writeSurface: ["x"] })
  await ledger.update({ id: added.task.id, status: "running", workerID: "maker" })
  f.authorize()
  await assert.rejects(
    f.invoke("bind", "parent", { reference, workerId: "sibling", ledgerId: added.task.id }),
    /görev defterinde/
  )
  await f.invoke("bind", "parent", { reference, workerId: "maker", ledgerId: added.task.id })
  await f.restart()
  assert.equal(JSON.parse((await f.invoke("read_assigned", "maker")).content).task.id, "step")
  await f.invoke("report_assigned", "maker", delivery)
  assert.equal(f.task.status, "review")
  await assert.rejects(f.invoke("report_assigned", "maker", delivery), /çalışan atama|zaten/)
})

test("rejection and resubmission use the same workers, recover interruptions and release both slots on acceptance", async (t) => {
  const f = await fixture(t)
  f.authorize()
  await f.assign("maker")
  await f.invoke("report_assigned", "maker", delivery)
  await f.assign("verifier")
  await assert.rejects(f.invoke("verify_assigned", "verifier", failed), /Önce/)
  await f.invoke("read_assigned", "verifier")
  f.failPrompt()
  await assert.rejects(f.invoke("verify_assigned", "verifier", failed, "reject"), /prompt interruption/)
  await f.restart()
  const inspection = JSON.parse((await f.invoke("inspect_delivery", "parent", { reference })).content)
  assert.deepEqual(f.notifications, ["maker", "verifier"])
  assert.equal(inspection.assignments.find((item) => item.role === "crew/maker").workerId, "maker")
  await f.invoke("verify_assigned", "verifier", failed, "reject")
  assert.deepEqual(f.notifications, ["maker", "verifier", "maker"])
  await f.invoke("read_assigned", "maker")
  await f.invoke("report_assigned", "maker", { ...delivery, evidence: "Yeni test" })
  assert.deepEqual(f.notifications, ["maker", "verifier", "maker", "verifier"])
  await f.invoke("read_assigned", "verifier")
  f.loseAck()
  await assert.rejects(f.invoke("verify_assigned", "verifier", passed, "accept"), /ack lost/)
  await f.restart()
  const receipt = JSON.parse((await f.invoke("verify_assigned", "verifier", passed, "accept")).content)
  assert.equal(receipt.reportId, "receipt-4")
  assert.equal(f.task.reports.length, 4)
  assert.deepEqual(
    (await f.ledger()).list().map((t) => t.status),
    ["done", "done"]
  )
  assert.equal(f.clients.size, 0)
})

test("scope change needs a decision tied to the latest rejection; write scope remains locked", async (t) => {
  const f = await fixture(t)
  f.authorize()
  await f.assign("maker")
  await f.invoke("report_assigned", "maker", delivery)
  await f.assign("verifier")
  await f.invoke("read_assigned", "verifier")
  await f.invoke("verify_assigned", "verifier", { ...failed, scopeChange: true })
  assert.deepEqual(f.notifications, ["maker", "verifier"])
  assert.deepEqual(
    (await f.ledger()).list().map((t) => t.status),
    ["verifying", "verifying"]
  )
  await assert.rejects(f.invoke("report_assigned", "maker", delivery), /çalışan atama|güncel ret/)
  const decision = { reference, verificationId: "receipt-2", decision: "Mevcut kapsamda düzelt." }
  await assert.rejects(f.invoke("resume_correction", "parent", { ...decision, verificationId: "old" }), /güncel/)
  await f.invoke("resume_correction", "parent", decision)
  assert.deepEqual(f.notifications, ["maker", "verifier", "maker"])
  assert.match(f.task.update, /Mevcut kapsamda düzelt/)
})

test("three failed independent checks park only this task", async (t) => {
  const f = await fixture(t)
  f.authorize()
  await f.assign("maker")
  for (let round = 0; round < 3; round++) {
    await f.invoke("report_assigned", "maker", { summary: "Teslim " + round, evidence: "Test " + round })
    if (!round) await f.assign("verifier")
    await f.invoke("read_assigned", "verifier")
    await f.invoke("verify_assigned", "verifier", failed)
  }
  assert.equal(f.notifications.filter((id) => id === "maker").length, 3)
  assert.deepEqual(
    (await f.ledger()).list().map((t) => t.status),
    ["verifying", "verifying"]
  )
})

test("remote ownership changes revoke reads, reports and repeat binds; manually closed tasks lack acceptance", async (t) => {
  const f = await fixture(t)
  f.authorize()
  await f.assign("maker")
  const saved = f.task.update
  f.task.update = saved.replace('"worker":"maker"', '"worker":"sibling"')
  await assert.rejects(f.invoke("read_assigned", "maker"), /sahibi veya kapsamı/)
  await assert.rejects(f.invoke("report_assigned", "maker", delivery), /sahibi veya kapsamı/)
  await assert.rejects(f.assign("maker"), /sahibi veya kapsamı/)
  assert.equal(f.attempts.length, 0)
  f.task.update = saved
  f.task.status = "done"
  await assert.rejects(f.assign("maker"), /kabul makbuzu/)
  const inspected = JSON.parse((await f.invoke("inspect_delivery", "parent", { reference })).content)
  assert.equal(inspected.phase, "hold")
  assert.notEqual((await f.ledger()).list()[0].status, "done")
})

test("reopening a workflow step does not dispatch another worker while assignment is pending", async (t) => {
  const f = await fixture(t)
  f.authorize()
  f.task.executionVersion = 2
  f.task.recoverySource = { version: 1 }
  await assert.rejects(f.assign("maker"), /Güncel ajan atamasını/)
  assert.deepEqual(f.notifications, [])
  assert.equal(f.task.update, "Mevcut plan")
})
