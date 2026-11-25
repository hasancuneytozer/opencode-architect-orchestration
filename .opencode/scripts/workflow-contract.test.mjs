import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { Memory } from "../plugins/orchestra/memory.ts"
import { TaskLedger, detectCycle } from "../plugins/orchestra/tasks.ts"
import { phase } from "../plugins/orchestra/work-progress.ts"

const reference = "http://127.0.0.1:5173/is-akisi?project=plan&work=flow&task=step"
const delivery = (id = "d1", actor = "maker") => ({ id, actor, role: "maker", summary: "Teslim", evidence: "Test", outcome: "delivered", deliveryId: null })
const verification = (id, outcome, deliveryId = "d1", actor = "verifier") => ({ id, actor, role: "verifier", summary: outcome === "failed" ? "Eksik" : "Kabul", evidence: "Test", outcome, deliveryId })

test("workflow phase contract maps server states without inventing acceptance", () => {
  assert.equal(phase({ status: "waiting", reports: [] }), undefined)
  assert.equal(phase({ status: "active", reports: [] }), undefined)
  assert.equal(phase({ status: "review", reports: [delivery()] }), "review")
  assert.equal(phase({ status: "done", reports: [delivery(), verification("v1", "passed")] }), "done")
  assert.equal(phase({ status: "done", reports: [delivery(), verification("v1", "passed", "d1", "maker")] }), "hold")
  assert.equal(phase({ status: "done", reports: [delivery()] }), "hold")
  assert.equal(phase({ status: "blocked", reports: [delivery(), verification("v1", "failed")] }), "blocked")
  assert.equal(phase({ status: "blocked", reports: [delivery(), verification("v1", "failed"), verification("v2", "failed"), verification("v3", "failed")] }), "hold")
  assert.equal(phase({ status: "active", reports: [], recoverySource: { version: 1 } }), "hold")
})

test("DAG contract rejects the same cycles in the local ledger", () => {
  assert.deepEqual(detectCycle({ A: ["B"], B: ["A"] }, "A"), ["A", "B", "A"])
  assert.equal(detectCycle({ A: ["B"], B: ["C"], C: [] }, "A"), undefined)
  assert.deepEqual(detectCycle({ A: ["A"] }, "A"), ["A", "A"])
})

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "orchestra-contract-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const memory = await Memory.open(path.join(directory, ".opencode", "memory"))
  return { directory, memory, ledger: () => TaskLedger.open(memory, directory, "parent") }
}

async function admitted(ledger, role, workerID, writeSurface) {
  const added = await ledger.add({ title: role, role, acceptance: "Kabul", writeSurface })
  await ledger.update({ id: added.task.id, status: "running", workerID })
  await ledger.bindWorkflow(added.task.id, reference)
  return added.task.id
}

test("syncWorkflow projects review and done onto both worker slots", async (t) => {
  const f = await fixture(t), ledger = await f.ledger()
  await admitted(ledger, "crew/maker", "maker", ["src/a.ts"])
  await admitted(ledger, "crew/verifier", "verifier", [])
  await ledger.syncWorkflow(reference, "review", 1)
  assert.deepEqual((await f.ledger()).list().map(item => item.status), ["verifying", "running"])
  await ledger.syncWorkflow(reference, "done", 2)
  assert.deepEqual((await f.ledger()).list().map(item => item.status), ["done", "done"])
})

test("syncWorkflow projects blocked and hold without releasing scope locks", async (t) => {
  const f = await fixture(t), ledger = await f.ledger()
  await admitted(ledger, "crew/maker", "maker", ["src/a.ts"])
  await admitted(ledger, "crew/verifier", "verifier", [])
  await ledger.syncWorkflow(reference, "blocked", 1)
  assert.deepEqual((await f.ledger()).list().map(item => item.status), ["running", "verifying"])
  await ledger.syncWorkflow(reference, "hold", 2)
  const held = (await f.ledger()).list()
  assert.deepEqual(held.map(item => item.status), ["verifying", "verifying"])
  assert.equal(held.every(item => item.workflowNeedsDecision === true), true)
})
