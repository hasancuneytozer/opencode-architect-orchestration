import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { Memory } from "./memory.ts"
import { TaskLedger } from "./tasks.ts"

const bridge = "http://127.0.0.1:5179"
const namespace = "work_progress"
const roles = { "crew/maker": "maker", "crew/verifier": "verifier" } as const
type Agent = keyof typeof roles
type Assignment = { parentId: string; ledgerId: string; agent: Agent; flowId: string; taskId: string }

function reference(value: string) {
  try {
    const url = new URL(value)
    const projectId = url.searchParams.get("project")
    const flowId = url.searchParams.get("work")
    const taskId = url.searchParams.get("task")
    if (!["http://127.0.0.1:5173", "http://localhost:5173"].includes(url.origin) ||
        url.username || url.password || url.pathname !== "/is-akisi" || !projectId || !flowId || !taskId) return
    return { projectId, flowId, taskId, href: url.href, key: JSON.stringify([projectId, flowId, taskId]) }
  } catch {
    return undefined
  }
}

async function request<T>(path: string, method: string, body?: object, token?: string): Promise<T> {
  const headers: Record<string, string> = token ? { Authorization: "Bearer " + token } : { "X-Skill-Platform-Local": "1" }
  const response = await fetch(bridge + path, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error("İş Akışı servisi isteği reddetti (" + response.status + ").")
  return await response.json() as T
}

export async function registerWorkProgress(ctx: Context, memory: Memory) {
  const links = new Map<string, Set<string>>()
  const assignments = new Map<string, Assignment>()
  const reported = new Set<string>()
  const writing = new Set<string>()
  const prompts = await ctx.session.hook("prompt", event => {
    const supplied = new Set<string>()
    for (const match of (event.prompt.text ?? "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
      const target = reference(match[0].replace(/[.,;]+$/, ""))
      if (target) supplied.add(target.key)
    }
    if (supplied.size) links.set(event.sessionID, supplied)
    else links.delete(event.sessionID)
  })

  async function checkWorker(worker: string, parentId: string, ledgerId: string) {
    await memory.sync()
    const ledger = await TaskLedger.open(memory, ctx.location.directory, parentId)
    const task = ledger.get(ledgerId)
    const child = await ctx.session.get({ sessionID: worker })
    const agent = child.agent
    if (child.parentID !== parentId || !agent || !Object.hasOwn(roles, agent) ||
        task?.status !== "running" || task.workerID !== worker || task.role !== agent || !task.acceptance?.trim()) {
      throw new Error("Bu alt oturum Orchestra görev defterinde çalışan bir Maker veya Verifier olarak atanmalı.")
    }
    return agent as Agent
  }

  async function callAssigned(call: ToolContext, args?: object) {
    const worker = call.sessionID
    const grant = assignments.get(worker)
    if (!grant || call.agent !== grant.agent || await checkWorker(worker, grant.parentId, grant.ledgerId) !== grant.agent) {
      throw new Error("Bu oturumda raporlanabilir bir İş Akışı görevi yok.")
    }
    if (args && (reported.has(worker) || writing.has(worker))) throw new Error("Bu oturum için teslim zaten yazıldı veya sürüyor.")
    if (args) writing.add(worker)
    try {
      call.signal.throwIfAborted()
      const access = await request<{ clientId: string; clientToken: string }>("/mcp/clients", "POST", {
        mode: "task_reporter", name: "Orchestra " + roles[grant.agent],
        assignment: { flowId: grant.flowId, taskId: grant.taskId, role: roles[grant.agent], actor: worker },
      })
      try {
        call.signal.throwIfAborted()
        const result = await request("/mcp/call", "POST", {
          tool: args ? "work_progress_report" : "work_progress_task",
          args: args ?? {}, ...(args ? { idempotencyKey: call.id } : {}),
        }, access.clientToken)
        if (args) reported.add(worker)
        return { content: JSON.stringify(result) }
      } finally {
        await request("/mcp/clients/" + encodeURIComponent(access.clientId), "DELETE")
      }
    } finally {
      if (args) writing.delete(worker)
    }
  }

  const tools = await ctx.tool.transform(editor => {
    editor.namespace({ name: namespace, description: "Orchestra görev defterinde atanmış İş Akışı teslimi" })
    editor.add({
      name: "bind",
      description: "Architect, görev defterindeki çalışan alt oturuma kullanıcı tarafından verilen İş Akışı görevini bağlar.",
      options: { namespace, permission: "orchestra_task" },
      input: {
        type: "object", properties: { reference: { type: "string" }, ledgerId: { type: "string" }, workerId: { type: "string" } },
        required: ["reference", "ledgerId", "workerId"], additionalProperties: false,
      },
      async execute(raw, call) {
        const input = raw as { reference: string; ledgerId: string; workerId: string }
        const target = reference(input.reference)
        const parent = await ctx.session.get({ sessionID: call.sessionID })
        if (parent.parentID || call.agent !== "architect" || !target || !links.get(call.sessionID)?.has(target.key)) {
          throw new Error("Bağlamak için Architect ana oturumunun son kullanıcı iletisindeki görev bağlantısı gerekir.")
        }
        const agent = await checkWorker(input.workerId, parent.id, input.ledgerId)
        const view = await request<{ projectId: string }>("/work-progress/reference?ref=" + encodeURIComponent(target.href), "GET")
        if (view.projectId !== target.projectId) throw new Error("Görev bağlantısının proje bilgisi eşleşmiyor.")
        const next = { parentId: parent.id, ledgerId: input.ledgerId, agent, flowId: target.flowId, taskId: target.taskId }
        const previous = assignments.get(input.workerId)
        if (previous && JSON.stringify(previous) !== JSON.stringify(next)) {
          throw new Error("Bağlı oturumun İş Akışı görevi değiştirilemez.")
        }
        if (!previous) {
          assignments.set(input.workerId, next)
          try {
            await ctx.session.prompt({
              sessionID: input.workerId,
              text: "İş Akışı erişimi hazır. Atanmış görevi work_progress_read_assigned ile aç. Kabul ölçütündeki kendi sonucunu work_progress_report_assigned ile kaydet.",
            }, { signal: call.signal })
          } catch (error) {
            assignments.delete(input.workerId)
            throw error
          }
        }
        return { content: "Görev bağlandı. Alt oturum atanmış görevi okuyabilir ve kendi kanıtını kaydedebilir." }
      },
    })
    editor.add({
      name: "read_assigned",
      description: "Bu oturuma atanmış görevi ve teslim kanıtını oku.",
      options: { namespace },
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_raw, call) => callAssigned(call),
    })
    editor.add({
      name: "report_assigned",
      description: "Maker özet ve kanıt yazar. Verifier bunlarla birlikte outcome ve Maker deliveryId değerini verir.",
      options: { namespace },
      input: {
        type: "object",
        properties: {
          summary: { type: "string", maxLength: 1800 }, evidence: { type: "string", maxLength: 1000 },
          outcome: { type: "string", enum: ["passed", "failed"] }, deliveryId: { type: "string" },
        },
        required: ["summary", "evidence"], additionalProperties: false,
      },
      execute: async (raw, call) => callAssigned(call, raw as object),
    })
  })

  return async () => {
    links.clear()
    assignments.clear()
    reported.clear()
    await Promise.allSettled([prompts.dispose(), tools.dispose()])
  }
}
