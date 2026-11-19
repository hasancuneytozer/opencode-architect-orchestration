import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { Memory } from "./memory.ts"
import { TaskLedger } from "./tasks.ts"
import { compareGitBaseline } from "./baseline.ts"

const bridge = "http://127.0.0.1:5179"
const namespace = "work_progress"
const roles = { "crew/maker": "maker", "crew/verifier": "verifier" } as const
const escalation = "[Architect kararı gerekiyor] "
type Agent = keyof typeof roles
type Delivery = { summary: string; evidence: string }
type Decision = Delivery & { outcome: "passed" | "failed"; scopeChange?: boolean }
type Submission = Delivery & { outcome?: string; deliveryId?: string }
type Report = Submission & { id: string; actor: string; role: string; requestId?: string }
type Task = { id: string; title: string; status: string; update: string; executionVersion?: number; recoverySource?: { version: number }; assignment?: { state: string }; reports?: Report[] }
type View = {
  projectId: string
  revision: number
  archivedAt?: number
  task: Task
  prerequisites?: { status: string }[]
}
const evidenceFields = {
  summary: { type: "string", maxLength: 1800 },
  evidence: { type: "string", maxLength: 1000 },
}
const referenceField = { type: "string" }

function reference(value: string) {
  try {
    const url = new URL(value)
    const projectId = url.searchParams.get("project")
    const flowId = url.searchParams.get("work")
    const taskId = url.searchParams.get("task")
    if (
      !["http://127.0.0.1:5173", "http://localhost:5173"].includes(url.origin) ||
      url.username ||
      url.password ||
      url.pathname !== "/is-akisi" ||
      !projectId ||
      !flowId ||
      !taskId ||
      ![flowId, taskId].every((id) => /^[a-z0-9-]+$/.test(id))
    )
      return
    const canonical = new URL("/is-akisi", "http://127.0.0.1:5173")
    canonical.search = new URLSearchParams({ project: projectId, work: flowId, task: taskId }).toString()
    return { projectId, flowId, taskId, href: canonical.href }
  } catch {
    return undefined
  }
}
type Target = NonNullable<ReturnType<typeof reference>>

async function request<T>(path: string, method: string, body?: object, token?: string): Promise<T> {
  const headers: Record<string, string> = token
    ? { Authorization: "Bearer " + token }
    : { "X-Skill-Platform-Local": "1" }
  const response = await fetch(bridge + path, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error("İş Akışı servisi isteği reddetti (" + response.status + ").")
  return (await response.json()) as T
}

async function viewOf(target: Target) {
  const view = await request<View>("/work-progress/reference?ref=" + encodeURIComponent(target.href), "GET")
  if (view.projectId !== target.projectId || view.task.id !== target.taskId)
    throw new Error("Görev bağlantısının proje veya görev bilgisi eşleşmiyor.")
  return view
}

type Owner = { parentId: string; workerId: string; agent: Agent; acceptance: string; writeSurface: string[] }
function packageLine(owner: Owner) {
  const label = "Orchestra " + roles[owner.agent] + " · "
  const entry =
    label +
    JSON.stringify({
      parent: owner.parentId,
      worker: owner.workerId,
      acceptance: owner.acceptance,
      surface: owner.writeSurface,
    })
  return { label, entry }
}
function checkPackage(task: Task, owner: Owner, required = true) {
  const { label, entry } = packageLine(owner)
  const lines = (task.update ?? "").split("\n").filter((line) => line.startsWith(label))
  if (lines.length === 1 && lines[0] === entry) return true
  if (required || lines.length)
    throw new Error("İş Akışı kaydında bu rolün sahibi veya kapsamı değişti. Architect atamayı kontrol etmeli.")
  return false
}
async function storePackage(target: Target, view: View, owner: Owner, required: boolean) {
  if (checkPackage(view.task, owner, required)) return
  // Preserve the existing plan and reserve ownership with the service's compare-and-swap revision.
  const { entry } = packageLine(owner)
  const update = [view.task.update, entry].filter(Boolean).join("\n")
  if (update.length > 1800) throw new Error("Atama ve mevcut açıklama İş Akışı adımının 1800 karakter sınırını aşıyor.")
  await request("/work-progress/" + target.flowId + "/tasks", "PUT", {
    revision: view.revision,
    id: target.taskId,
    update,
  })
}
function receipts(task: Task) {
  const delivery = task.reports?.findLast((item) => item.role === "maker")
  const verification =
    delivery && task.reports?.findLast((item) => item.role === "verifier" && item.deliveryId === delivery.id)
  return { delivery, verification }
}

const decisionLabel = "Architect kararı · "
function approvedRejection(task: Task) {
  const line = (task.update ?? "").split("\n").findLast((item) => item.startsWith(decisionLabel))
  if (!line) return
  try {
    const parsed = JSON.parse(line.slice(decisionLabel.length))
    if (typeof parsed.verificationId === "string" && typeof parsed.decision === "string" && parsed.decision.trim())
      return parsed.verificationId as string
  } catch {
    /* Unstructured user notes never release a hold. */
  }
}
function awaitsRecoveryAssignment(task: Task) {
  return !!task.recoverySource && task.assignment?.state !== "active"
}

function requireRecoveryAssignment(task: Task) {
  if (awaitsRecoveryAssignment(task))
    throw new Error("Adım aynı kayıtta yeniden açıldı. Güncel ajan atamasını İş Akışında doğrulayın.")
}

function phase(task: Task) {
  if (awaitsRecoveryAssignment(task)) return "hold"
  const { delivery, verification } = receipts(task)
  if (task.status === "review" && delivery && !verification) return "review"
  if (task.status === "done" && delivery && verification?.outcome === "passed" && delivery.actor !== verification.actor)
    return "done"
  if (task.status === "done") return "hold"
  if (task.status !== "blocked") return
  if (verification?.outcome !== "failed") return "hold"
  const approved = approvedRejection(task)
  if (approved === verification.id) return "blocked"
  const reports = task.reports ?? []
  const since = approved ? reports.findIndex((report) => report.id === approved) : -1
  const failures = reports
    .slice(since + 1)
    .filter((report) => report.role === "verifier" && report.outcome === "failed")
  return verification.summary.startsWith(escalation) || failures.length >= 3 ? "hold" : "blocked"
}
export function workflowReferences(text: string): string[] {
  const links = new Set<string>()
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    const target = reference(match[0].replace(/[.,;]+$/, ""))
    if (target) links.add(target.href)
  }
  return [...links]
}

export async function readWorkflowPhase(href: string) {
  const target = reference(href)
  if (!target) throw new Error("Geçerli bir İş Akışı görevi gerekir.")
  const view = await viewOf(target)
  return {
    archived: view.archivedAt != null,
    status: view.task.status,
    phase: phase(view.task),
    executionVersion: view.task.executionVersion ?? 1,
    reportCount: view.task.reports?.length ?? 0,
    revision: view.revision,
  }
}

export async function registerWorkProgress(ctx: Context, memory: Memory) {
  const links = new Map<string, Set<string>>()
  const prompted = new Set<string>()
  const continuing = new Set<string>()
  const readDeliveries = new Map<string, string>()
  const writing = new Set<string>()
  const notified = new Map<string, string>()
  const prompts = await ctx.session.hook("prompt", (event) => {
    const text = (event.prompt.text ?? "").trim().toLocaleLowerCase("tr")
    const continuation =
      /^(?:(?:kaldığın yerden|sadeleştirmeye)\s+)?devam(?: et| edelim)?[.!]?$/u.test(text) ||
      /^(?:evet|tamam|başla|continue|resume)[.!]?$/u.test(text)
    if (
      continuation &&
      (!prompted.has(event.sessionID) || links.has(event.sessionID) || continuing.has(event.sessionID))
    ) {
      continuing.add(event.sessionID)
    } else {
      continuing.delete(event.sessionID)
    }
    prompted.add(event.sessionID)
    const supplied = new Set(workflowReferences(event.prompt.text ?? ""))
    if (supplied.size) links.set(event.sessionID, supplied)
    else links.delete(event.sessionID)
  })
  async function board(parentId: string) {
    await memory.syncStore()
    return TaskLedger.open(memory, ctx.location.directory, parentId)
  }
  async function architectTask(raw: string, call: ToolContext) {
    const target = reference(raw)
    const parent = await ctx.session.get({ sessionID: call.sessionID })
    if (parent.parentID || call.agent !== "architect" || !target)
      throw new Error("Görev bağlantısı ve Architect ana oturumu gerekir.")
    const ledger = await board(parent.id)
    if (!links.get(parent.id)?.has(target.href) && !ledger.list().some((t) => t.workflowRef === target.href))
      throw new Error("Architect ana oturumunun son kullanıcı iletisindeki görev bağlantısı gerekir.")
    const view = await viewOf(target)
    return { parent, ledger, target, view }
  }
  async function workerAdmission(call: ToolContext) {
    const child = await ctx.session.get({ sessionID: call.sessionID })
    if (!child.parentID || child.agent !== call.agent || !Object.hasOwn(roles, call.agent))
      throw new Error("Bu oturumda raporlanabilir bir İş Akışı görevi yok.")
    const ledger = await board(child.parentID)
    const task = ledger
      .list()
      .find((t) => t.workerID === child.id && t.role === child.agent && t.workflowRef && t.acceptance)
    const target = task?.workflowRef && reference(task.workflowRef)
    if (!target || !task) throw new Error("Bu oturumda raporlanabilir bir İş Akışı görevi yok.")
    return { ledger, task, target, agent: call.agent as Agent }
  }
  async function reporter<T>(worker: string, agent: Agent, target: Target, tool: string, args: object, key?: string) {
    const access = await request<{ clientId: string; clientToken: string }>("/mcp/clients", "POST", {
      mode: "task_reporter",
      name: "Orchestra " + roles[agent],
      assignment: { flowId: target.flowId, taskId: target.taskId, role: roles[agent], actor: worker },
    })
    try {
      return await request<T>(
        "/mcp/call",
        "POST",
        { tool, args, ...(key ? { idempotencyKey: key } : {}) },
        access.clientToken
      )
    } finally {
      await request("/mcp/clients/" + encodeURIComponent(access.clientId), "DELETE")
    }
  }
  async function notify(
    ledger: TaskLedger,
    target: Target,
    agent: Agent,
    worker: string,
    signal: AbortSignal,
    key: string
  ) {
    const admission = ledger
      .list()
      .find((t) => t.workerID === worker && t.role === agent && t.workflowRef === target.href)
    const child = await ctx.session.get({ sessionID: worker })
    if (child.parentID !== ledger.id || child.agent !== agent || admission?.status !== "running")
      throw new Error("Bildirim için aynı göreve atanmış çalışan alt oturum gerekir.")
    if (notified.get(worker) === key) return
    const instructions =
      agent === "crew/maker"
        ? "Görevi ve varsa son ret gerekçesini work_progress_read_assigned ile oku. Kendi yazma kapsamındaki işi test et ve work_progress_report_assigned ile teslim et."
        : "Son Maker teslimini work_progress_read_assigned ile oku. Bağımsız test kanıtını ve kararını work_progress_verify_assigned ile kaydet."
    notified.set(worker, key)
    try {
      await ctx.session.prompt(
        {
          sessionID: worker,
          text: [
            target.href,
            instructions,
            "Kabul: " + admission.acceptance,
            "Yazma kapsamı: " + JSON.stringify(admission.writeSurface),
          ].join("\n"),
        },
        { signal }
      )
    } catch (error) {
      if (notified.get(worker) === key) notified.delete(worker)
      throw error
    }
  }
  async function synchronize(ledger: TaskLedger, target: Target, view: View, signal: AbortSignal, wake: boolean) {
    const task = view.task
    if (awaitsRecoveryAssignment(task)) return
    const state = view.archivedAt != null ? "hold" : phase(task)
    const admissions = ledger.list().filter((t) => t.workflowRef === target.href)
    for (const t of admissions) {
      if (t.workerID && t.role && Object.hasOwn(roles, t.role))
        checkPackage(task, {
          parentId: ledger.id,
          workerId: t.workerID,
          agent: t.role as Agent,
          acceptance: t.acceptance,
          writeSurface: t.writeSurface,
        })
    }
    if (!state) return
    const current = receipts(task)
    if (
      current.delivery &&
      admissions.some((t) => t.role === "crew/maker" && t.workerID && t.workerID !== current.delivery?.actor)
    )
      throw new Error("Güncel teslim atanmış Maker ile eşleşmiyor.")
    if (
      current.verification &&
      admissions.some((t) => t.role === "crew/verifier" && t.workerID && t.workerID !== current.verification?.actor)
    )
      throw new Error("Güncel karar atanmış Verifier ile eşleşmiyor.")
    await ledger.syncWorkflow(target.href, state, view.revision)
    if (!wake || ledger.list().some((t) => t.workflowRef === target.href && (t.workflowRevision ?? 0) > view.revision))
      return
    const { delivery, verification } = receipts(task)
    if (state === "blocked" && delivery && verification) {
      await notify(ledger, target, "crew/maker", delivery.actor, signal, verification.id)
    } else if (state === "review" && delivery) {
      const verifier = ledger
        .list()
        .find((t) => t.role === "crew/verifier" && t.workflowRef === target.href && t.status === "running")
      if (verifier?.workerID) await notify(ledger, target, "crew/verifier", verifier.workerID, signal, delivery.id)
    }
  }
  async function submit(call: ToolContext, args: Submission) {
    const worker = call.sessionID
    if (writing.has(worker)) throw new Error("Bu oturum için teslim zaten sürüyor.")
    writing.add(worker)
    try {
      call.signal.throwIfAborted()
      const { ledger, task, target, agent } = await workerAdmission(call)
      const view = await viewOf(target)
      requireRecoveryAssignment(view.task)
      const previous = view.task.reports?.find((r) => r.actor === worker && r.requestId === call.id)
      if (previous) {
        if (
          previous.summary !== args.summary ||
          previous.evidence !== args.evidence ||
          (previous.deliveryId ?? undefined) !== args.deliveryId ||
          previous.outcome !== (args.outcome ?? "delivered")
        )
          throw new Error("Bu çağrı kimliği başka bir teslim için kullanıldı.")
        await synchronize(ledger, target, view, call.signal, true)
        return { content: JSON.stringify({ reportId: previous.id, status: view.task.status }) }
      }
      await synchronize(ledger, target, view, call.signal, false)
      if (ledger.get(task.id)?.status !== "running" || view.archivedAt != null)
        throw new Error("Görev defterinde bu oturum için çalışan atama yok.")
      const { delivery, verification } = receipts(view.task)
      if (
        agent === "crew/maker" &&
        delivery &&
        !(
          view.task.status === "blocked" &&
          verification?.outcome === "failed" &&
          phase(view.task) === "blocked" &&
          delivery.actor === worker
        )
      )
        throw new Error("Teslim zaten yazıldı. Düzeltme yalnız güncel ret üzerine aynı Maker'a açılır.")
      if (
        agent === "crew/verifier" &&
        (!args.deliveryId || delivery?.id !== args.deliveryId || view.task.status !== "review")
      )
        throw new Error("Güncel Maker teslimini önce work_progress_read_assigned ile yeniden oku.")
      call.signal.throwIfAborted()
      const result = await reporter<{ task: Task; reportId: string }>(
        worker,
        agent,
        target,
        "work_progress_report",
        args,
        call.id
      )
      if (!result.reportId) throw new Error("İş Akışı teslim makbuzu eksik.")
      // The service commits before returning. Reconcile from its latest revision, including on retry.
      const current = await viewOf(target)
      await synchronize(ledger, target, current, call.signal, true)
      return { content: JSON.stringify(result) }
    } finally {
      writing.delete(worker)
    }
  }

  async function link(raw: unknown, call: ToolContext, direct: boolean) {
    const input = raw as {
      reference: string
      workerId: string
      ledgerId?: string
      acceptance?: string
      writeSurface?: string[]
    }
    const { parent, ledger, target, view } = await architectTask(input.reference, call)
    requireRecoveryAssignment(view.task)
    const child = await ctx.session.get({ sessionID: input.workerId })
    if (child.parentID !== parent.id || !child.agent || !Object.hasOwn(roles, child.agent))
      throw new Error("Bu alt oturum Architect'in Maker veya Verifier görevi olmalı.")
    const agent = child.agent as Agent
    if (view.archivedAt != null || view.prerequisites?.some((t) => t.status !== "done"))
      throw new Error("Arşivlenmiş veya önkoşulları açık görev atanamaz.")
    const { delivery, verification } = receipts(view.task)
    if (view.task.status === "done") {
      if (phase(view.task) !== "done") throw new Error("Görev kapalı fakat güncel bağımsız kabul makbuzu yok.")
      await synchronize(ledger, target, view, call.signal, false)
      return { content: JSON.stringify({ status: "done", deliveryId: delivery?.id }) }
    }
    if (agent === "crew/maker" && delivery && delivery.actor !== child.id)
      throw new Error("Teslim edilmiş görevin Maker oturumu değiştirilemez.")
    if (direct && agent === "crew/verifier" && (!delivery || view.task.status !== "review"))
      throw new Error("Bağımsız kabul için güncel Maker teslimi gerekir.")
    if (direct && view.task.status === "blocked" && phase(view.task) !== "blocked")
      throw new Error("Bu görev için Architect kararı gerekiyor.")
    const assigned = ledger.list().filter((t) => t.workerID === child.id)
    let task = input.ledgerId ? ledger.get(input.ledgerId) : assigned.length === 1 ? assigned[0] : undefined
    if (task?.workflowRef && task.workflowRef !== target.href)
      throw new Error("Bağlı oturumun İş Akışı görevi değiştirilemez.")
    if (direct) {
      if (
        !input.acceptance?.trim() ||
        !Array.isArray(input.writeSurface) ||
        input.writeSurface.some((s) => typeof s !== "string" || !s.trim()) ||
        (agent === "crew/verifier" && input.writeSurface.length)
      )
        throw new Error("Kabul koşulu ve role uygun yazma kapsamı gerekir.")
      task ??= ledger.list().find((t) => t.workflowRef === target.href && t.role === agent)
      if (
        task &&
        (task.workflowRef !== target.href ||
          task.role !== agent ||
          (task.workerID && task.workerID !== child.id) ||
          task.acceptance !== input.acceptance.trim() ||
          JSON.stringify(task.writeSurface) !== JSON.stringify(input.writeSurface))
      )
        throw new Error("Aynı görev için sahip, kabul veya yazma kapsamı değişti.")
      await synchronize(ledger, target, view, call.signal, false)
      await storePackage(
        target,
        view,
        {
          parentId: parent.id,
          workerId: child.id,
          agent,
          acceptance: input.acceptance.trim(),
          writeSurface: input.writeSurface,
        },
        Boolean(task?.workflowRef)
      )
      if (!task) {
        const added = await ledger.add({
          title: view.task.title,
          role: agent,
          workerID: child.id,
          workflowRef: target.href,
          acceptance: input.acceptance,
          writeSurface: input.writeSurface,
        })
        if (!added.ok || !added.task) throw new Error(added.ok ? "Atama kaydedilemedi." : added.error)
        task = added.task
      }
      if (task.status === "planned") {
        const active = await ledger.update({ id: task.id, status: "running", workerID: child.id })
        if (!active.ok || !active.task) throw new Error(active.ok ? "Atama başlatılamadı." : active.error)
        task = active.task
      }
    }
    if (
      !task ||
      !task.acceptance ||
      task.role !== agent ||
      task.workerID !== child.id ||
      !["running", "verifying"].includes(task.status)
    )
      throw new Error("Bu alt oturum görev defterinde çalışan bir Maker veya Verifier olarak atanmalı.")
    if (!direct)
      await storePackage(
        target,
        view,
        {
          parentId: parent.id,
          workerId: child.id,
          agent,
          acceptance: task.acceptance,
          writeSurface: task.writeSurface,
        },
        Boolean(task.workflowRef)
      )
    if (!task.workflowRef || task.workflowRef !== target.href) await ledger.bindWorkflow(task.id, target.href)
    const fresh = await viewOf(target)
    await synchronize(ledger, target, fresh, call.signal, false)
    const current = receipts(fresh.task)
    requireRecoveryAssignment(fresh.task)
    const currentPhase = phase(fresh.task)
    const canWake =
      fresh.archivedAt == null &&
      (agent === "crew/maker"
        ? (!current.delivery && ["waiting", "active"].includes(fresh.task.status)) || currentPhase === "blocked"
        : currentPhase === "review")
    if (canWake)
      await notify(
        ledger,
        target,
        agent,
        child.id,
        call.signal,
        (agent === "crew/maker" ? current.verification?.id : current.delivery?.id) ?? "first"
      )
    return {
      content: JSON.stringify({
        workerId: child.id,
        ledgerId: task.id,
        reference: target.href,
        status: view.task.status,
      }),
    }
  }

  const tools = await ctx.tool.transform((editor) => {
    editor.namespace({ name: namespace, description: "Atanmış İş Akışı görevinin teslimi ve doğrulaması" })
    editor.add({
      name: "assign",
      description: "Architect, hazır alt oturumu yazma kapsamı ve kabul koşuluyla doğrudan atar.",
      options: { namespace, permission: "orchestra_task" },
      input: {
        type: "object",
        properties: {
          reference: referenceField,
          workerId: { type: "string" },
          acceptance: { type: "string" },
          writeSurface: { type: "array", items: { type: "string" } },
        },
        required: ["reference", "workerId", "acceptance", "writeSurface"],
        additionalProperties: false,
      },
      execute: (raw, call) => link(raw, call, true),
    })
    editor.add({
      name: "bind",
      description: "Architect, mevcut çalışan paketin oturumunu İş Akışı adımına bağlar.",
      options: { namespace, permission: "orchestra_task" },
      input: {
        type: "object",
        properties: { reference: referenceField, ledgerId: { type: "string" }, workerId: { type: "string" } },
        required: ["reference", "workerId"],
        additionalProperties: false,
      },
      execute: (raw, call) => link(raw, call, false),
    })
    editor.add({
      name: "read_assigned",
      description: "Atanmış görevi ve güncel kanıtı oku.",
      options: { namespace },
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute(_raw, call) {
        const { ledger, task, target, agent } = await workerAdmission(call)
        const before = await viewOf(target)
        requireRecoveryAssignment(before.task)
        await synchronize(ledger, target, before, call.signal, false)
        if (before.archivedAt != null || ledger.get(task.id)?.status !== "running")
          throw new Error("Görev defterinde bu oturum için çalışan atama yok.")
        const result = await reporter<{ task: Task }>(call.sessionID, agent, target, "work_progress_task", {})
        if (result.task.status !== before.task.status || result.task.reports?.length !== before.task.reports?.length)
          await synchronize(ledger, target, await viewOf(target), call.signal, false)
        if (ledger.get(task.id)?.status !== "running")
          throw new Error("Görev defterinde bu oturum için çalışan atama yok.")
        const { delivery } = receipts(result.task)
        if (agent === "crew/verifier" && delivery && result.task.status === "review")
          readDeliveries.set(call.sessionID, delivery.id)
        else readDeliveries.delete(call.sessionID)
        if (agent !== "crew/verifier" || !delivery) return { content: JSON.stringify(result) }
        const maker = ledger.list().find(entry => entry.workflowRef === target.href && entry.role === "crew/maker" && entry.workerID === delivery.actor)
        const gitScope = await compareGitBaseline(ctx.location.directory, maker?.gitBaseline)
        return { content: JSON.stringify({ ...result, gitScope }) }
      },
    })
    editor.add({
      name: "report_assigned",
      description: "Maker teslim özeti ve kanıtı yazar.",
      options: { namespace },
      input: {
        type: "object",
        properties: evidenceFields,
        required: ["summary", "evidence"],
        additionalProperties: false,
      },
      async execute(raw, call) {
        if (call.agent !== "crew/maker") throw new Error("Bu teslim aracını yalnız Maker kullanabilir.")
        return submit(call, raw as Delivery)
      },
    })
    editor.add({
      name: "verify_assigned",
      description: "Verifier bağımsız karar verir. Kapsam değişikliği gerekiyorsa scopeChange seçer.",
      options: { namespace },
      input: {
        type: "object",
        properties: {
          ...evidenceFields,
          outcome: { type: "string", enum: ["passed", "failed"] },
          scopeChange: { type: "boolean" },
        },
        required: ["summary", "evidence", "outcome"],
        additionalProperties: false,
      },
      async execute(raw, call) {
        if (call.agent !== "crew/verifier") throw new Error("Bu doğrulama aracını yalnız Verifier kullanabilir.")
        const { scopeChange, summary, evidence, outcome } = raw as Decision
        if (scopeChange && outcome !== "failed") throw new Error("Kapsam kararı yalnız ret ile istenir.")
        let deliveryId = readDeliveries.get(call.sessionID)
        if (!deliveryId) {
          const { target } = await workerAdmission(call)
          const { task } = await viewOf(target)
          deliveryId = task.reports?.find(
            (r) => r.role === "verifier" && r.actor === call.sessionID && r.requestId === call.id
          )?.deliveryId
        }
        if (!deliveryId) throw new Error("Önce work_progress_read_assigned ile incelemedeki Maker teslimini oku.")
        return submit(call, { summary: scopeChange ? escalation + summary : summary, evidence, outcome, deliveryId })
      },
    })
    editor.add({
      name: "resume_correction",
      description: "Architect, bekleyen güncel reddi kayıtlı yazma kapsamında bir kararla sürdürür.",
      options: { namespace, permission: "orchestra_task" },
      input: {
        type: "object",
        properties: {
          reference: referenceField,
          verificationId: { type: "string" },
          decision: { type: "string", maxLength: 500 },
        },
        required: ["reference", "verificationId", "decision"],
        additionalProperties: false,
      },
      async execute(raw, call) {
        const {
          reference: value,
          verificationId,
          decision,
        } = raw as { reference: string; verificationId: string; decision: string }
        const { ledger, target, view } = await architectTask(value, call)
        const { delivery, verification } = receipts(view.task)
        if (
          view.archivedAt != null ||
          !delivery ||
          !verification ||
          verification.id !== verificationId ||
          !ledger
            .list()
            .some((t) => t.workflowRef === target.href && t.workerID === delivery.actor && t.role === "crew/maker") ||
          !decision.trim() ||
          decision.length > 500
        )
          throw new Error("Bekleyen güncel Maker düzeltmesi ve Architect kararı gerekir.")
        if (approvedRejection(view.task) !== verification.id) {
          if (phase(view.task) !== "hold") throw new Error("Görev bir Architect kararı beklemiyor.")
          const update = (view.task.update ?? "").split("\n").filter((line) => line && !line.startsWith(decisionLabel))
          update.push(decisionLabel + JSON.stringify({ verificationId, decision: decision.trim() }))
          const note = update.join("\n")
          if (note.length > 1800) throw new Error("Karar ve görev açıklaması 1800 karakteri aşıyor.")
          await request("/work-progress/" + target.flowId + "/tasks", "PUT", {
            revision: view.revision,
            id: target.taskId,
            update: note,
          })
        }
        const current = await viewOf(target)
        await synchronize(ledger, target, current, call.signal, true)
        return { content: JSON.stringify({ status: current.task.status, verificationId }) }
      },
    })
    editor.add({
      name: "inspect_delivery",
      description: "Architect güncel teslimi ve bağlı kararı okur.",
      options: { namespace, permission: "orchestra_task" },
      input: {
        type: "object",
        properties: { reference: referenceField },
        required: ["reference"],
        additionalProperties: false,
      },
      async execute(raw, call) {
        const { ledger, target, view } = await architectTask((raw as { reference: string }).reference, call)
        await synchronize(ledger, target, view, call.signal, false)
        const assignments = ledger
          .list()
          .filter((task) => task.workflowRef === target.href)
          .map((task) => ({
            workerId: task.workerID,
            role: task.role,
            acceptance: task.acceptance,
            writeSurface: task.writeSurface,
          }))
        return {
          content: JSON.stringify({
            status: view.task.status,
            executionVersion: view.task.executionVersion ?? 1,
            awaitingAssignment: awaitsRecoveryAssignment(view.task),
            phase: phase(view.task),
            assignments,
            ...receipts(view.task),
          }),
        }
      },
    })
  })
  return Object.assign(
    async () => {
      links.clear()
      prompted.clear()
      continuing.clear()
      readDeliveries.clear()
      notified.clear()
      await Promise.allSettled([prompts.dispose(), tools.dispose()])
    },
    {
      async isLinked(sessionID: string) {
        const session = await ctx.session.get({ sessionID }).catch(() => undefined)
        if (!session) return false
        if (!session.parentID && prompted.has(sessionID) && !continuing.has(sessionID))
          return Boolean(links.get(sessionID)?.size)
        const ledger = await board(session.parentID ?? sessionID)
        return ledger
          .list()
          .some(
            (t) =>
              t.workflowRef && (session.parentID ? t.workerID === sessionID : !["done", "failed"].includes(t.status))
          )
      },
    }
  )
}
