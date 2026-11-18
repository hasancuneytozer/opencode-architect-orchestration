import type { Plugin } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"

const bridge = "http://127.0.0.1:5179"
const namespace = "work_progress"
const roles = { maker: "crew/maker", verifier: "crew/verifier" } as const
type Role = keyof typeof roles
type Grant = { clientId: string; clientToken: string; role: Role }
type Receipt = { id: string; actor: string; role: Role }
type TaskView = { task: { status: string; reports: Receipt[] } }

function reference(value: string) {
  try {
    const url = new URL(value)
    if (url.origin !== "http://127.0.0.1:5173" && url.origin !== "http://localhost:5173") return
    if (url.username || url.password || url.pathname !== "/is-akisi") return
    const projectId = url.searchParams.get("project")
    const flowId = url.searchParams.get("work")
    const taskId = url.searchParams.get("task")
    if (!projectId || !flowId || !taskId) return
    const key = JSON.stringify([projectId, flowId, taskId])
    return { projectId, flowId, taskId, key, href: url.href }
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

function assigned<T>(grant: Grant, tool: string, args = {}, idempotencyKey?: string) {
  return request<T>("/mcp/call", "POST", { tool, args, idempotencyKey }, grant.clientToken)
}

const fields = {
  summary: { type: "string", maxLength: 1800 },
  evidence: { type: "string", maxLength: 1000 },
  outcome: { type: "string", enum: ["passed", "failed"] },
  deliveryId: { type: "string" },
} as const

const plugin: Plugin = {
  id: "orchestra-work-progress",
  async setup(ctx) {
    const userReferences = new Map<string, Set<string>>()
    const grants = new Map<string, Grant>()
    const running = new Set<string>()
    const prompts = await ctx.session.hook("prompt", (event) => {
      const links = new Set<string>()
      for (const match of (event.prompt.text ?? "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
        const target = reference(match[0].replace(/[.,;]+$/, ""))
        if (target) links.add(target.key)
      }
      if (links.size) userReferences.set(event.sessionID, links)
      else userReferences.delete(event.sessionID)
    })

    function grantFor(call: ToolContext) {
      const grant = grants.get(call.sessionID)
      if (!grant || roles[grant.role] !== call.agent) throw new Error("Bu oturuma yazılabilir bir görev atanmamış.")
      return grant
    }

    const tools = await ctx.tool.transform(editor => {
      editor.namespace({ name: namespace, description: "Atanmış İş Akışı görevinin teslimi ve doğrulaması" })
      editor.add({
        name: "dispatch",
        description: "Architect, son kullanıcı iletisinde paylaşılan görev bağlantısına bir Maker veya Verifier ata.",
        options: { namespace },
        input: {
          type: "object",
          properties: {
            reference: { type: "string" },
            role: { type: "string", enum: ["maker", "verifier"] },
            instructions: { type: "string" },
          },
          required: ["reference", "role", "instructions"], additionalProperties: false,
        },
        async execute(raw, call) {
          const input = raw as { reference: string; role: Role; instructions: string }
          const target = reference(input.reference)
          const parent = await ctx.session.get({ sessionID: call.sessionID })
          if (parent.parentID || call.agent !== "architect" || !target ||
              !userReferences.get(call.sessionID)?.has(target.key) || !Object.hasOwn(roles, input.role)) {
            throw new Error("Atama için Architect ana oturumunun son kullanıcı iletisindeki görev bağlantısı gerekir.")
          }

          const lock = JSON.stringify([target.flowId, target.taskId])
          if (running.has(lock)) throw new Error("Bu görev için bir atama zaten çalışıyor.")
          running.add(lock)
          let childId: string | undefined
          let grant: Grant | undefined
          try {
            call.signal.throwIfAborted()
            const task = await request<{ projectId: string }>("/work-progress/reference?ref=" + encodeURIComponent(target.href), "GET")
            if (task.projectId !== target.projectId) throw new Error("Görev bağlantısının proje bilgisi eşleşmiyor.")
            const childInput = {
              parentID: parent.id,
              agent: roles[input.role],
              title: "İş Akışı · " + input.role,
              permissions: parent.permissions,
            }
            const child = await ctx.session.create(childInput)
            if (child.parentID !== parent.id || child.agent !== roles[input.role]) {
              throw new Error("OpenCode atanan alt oturumu doğrulayamadı.")
            }
            childId = child.id
            const credentials = await request<Omit<Grant, "role">>("/mcp/clients", "POST", {
              mode: "task_reporter",
              name: "Orchestra " + input.role,
              assignment: { flowId: target.flowId, taskId: target.taskId, role: input.role, actor: childId },
            })
            grant = { ...credentials, role: input.role }
            grants.set(childId, grant)

            const requirement = input.role === "maker"
              ? "Teslim özeti ve test kanıtını kaydet."
              : "Son Maker tesliminin kimliğini oku. Bağımsız kontrolünü, kanıtını ve sonucunu kaydet."
            call.signal.throwIfAborted()
            await ctx.session.prompt({
              sessionID: childId,
              text: [
                "Atanmış görev: " + target.href,
                "Önce work_progress_read_assigned aracını çağır. Ardından yalnız work_progress_report_assigned aracına kendi sonucunu yaz.",
                requirement,
                input.instructions,
              ].join("\n"),
            }, { signal: call.signal })
            await ctx.session.wait({ sessionID: childId }, { signal: call.signal })
            const view = await assigned<TaskView>(grant, "work_progress_task")
            const receipt = view.task.reports.findLast(item => item.actor === childId && item.role === input.role)
            return { content: JSON.stringify({ sessionId: childId, status: view.task.status, reportId: receipt?.id ?? null }) }
          } finally {
            running.delete(lock)
            if (childId) grants.delete(childId)
            if (grant) await request("/mcp/clients/" + encodeURIComponent(grant.clientId), "DELETE")
          }
        },
      })
      editor.add({
        name: "read_assigned",
        description: "Bu oturuma atanmış görevi ve teslim kanıtını oku.",
        options: { namespace },
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_raw, call) {
          return { content: JSON.stringify(await assigned(grantFor(call), "work_progress_task")) }
        },
      })
      editor.add({
        name: "report_assigned",
        description: "Maker özet ve kanıt yazar. Verifier bunlarla birlikte outcome ve önceki Maker deliveryId değerini verir.",
        options: { namespace },
        input: {
          type: "object", properties: fields, required: ["summary", "evidence"], additionalProperties: false,
        },
        async execute(raw, call) {
          const grant = grantFor(call)
          const result = await assigned(grant, "work_progress_report", raw as object, call.id)
          return { content: JSON.stringify(result) }
        },
      })
    })

    return async () => {
      userReferences.clear()
      const remaining = [...grants.values()]
      grants.clear()
      await Promise.allSettled(remaining.map(grant => request("/mcp/clients/" + encodeURIComponent(grant.clientId), "DELETE")))
      await Promise.allSettled([prompts.dispose(), tools.dispose()])
    }
  },
}

export default plugin
