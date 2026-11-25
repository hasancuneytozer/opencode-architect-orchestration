import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises'
import { resolve, dirname, relative, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const hash = value => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex')
const inside = (root, file) => {
  const rel = relative(root, file)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
}
async function read(file) {
  try { return await readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function safe(root, file) {
  if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw Error('Unsafe policy path')
  const full = resolve(root, file)
  if (!inside(root, full)) throw Error('Path outside target')
  let current = full
  while (current !== root) {
    try { if ((await lstat(current)).isSymbolicLink()) throw Error('Symlink/junction not allowed: ' + current) } catch (error) { if (error.code !== 'ENOENT') throw error }
    current = dirname(current)
  }
  return full
}

const architectBlock = `<!-- orchestra-skill-policy:start -->
### Yetenek seçimi

- Göreve uygun yetenek gerekiyorsa \`yetenek-kullanimi\` akışını kullan: \`library_search\` ile en fazla beş adayı seç, \`skill_prepare\` ile 1–4 etkin yeteneği hazırla ve \`{id, versionId, digest}\` manifestosunu görev paketine ekle.
- \`unchanged\` dönen içeriği tekrar okuma; sürüm veya digest değiştiyse yeni içeriği yükle. MCP yoksa işi durdurma, mevcut izinli talimatla devam et ve eksik erişimi kaydet.
- \`skill_update_propose\` yalnız host yetkisiyle çalışır ve insan onayı olmadan etkinleştirilmez.
<!-- orchestra-skill-policy:end -->`

const makerBlock = `<!-- orchestra-skill-policy:start -->
## Yetenek kullanımı

- Architect \`{id, versionId, digest}\` manifestosu verdiyse \`skill_prepare\` sonucundaki bu sürümü kullan. \`unchanged\` dönerse içeriği tekrar okuma; önceki yüklenen talimatı kullan.
- Sürüm veya digest değiştiyse eski talimatla devam etme. Erişim yoksa bunu teslimde belirt ve mevcut izinli yöntemle sınırlı devam et.
- Teslimde kullanılan yetenek kimliğini, sürümünü ve digest’ini yaz. Talimat eksik veya yanlışsa \`skill_update_propose\` ile gerekçeli öneri hazırla; öneriyi kendin etkinleştirme.
<!-- orchestra-skill-policy:end -->`

function replaceMarkedBlock(content, block) {
  const pattern = /<!-- orchestra-skill-policy:start -->[\s\S]*?<!-- orchestra-skill-policy:end -->/
  if (pattern.test(content)) return content.replace(pattern, block)
  return null
}
function insertBefore(content, anchor, block) {
  const index = content.indexOf(anchor)
  if (index < 0) return null
  return content.slice(0, index) + block + '\n\n' + content.slice(index)
}
function insertAfterHeading(content, heading, block) {
  const index = content.indexOf(heading)
  if (index < 0) return null
  const end = index + heading.length
  return content.slice(0, end) + '\n\n' + block + content.slice(end)
}
function patchArchitect(content) {
  const marked = replaceMarkedBlock(content, architectBlock)
  if (marked !== null) return marked
  return insertBefore(content, '### 1. Brifing', architectBlock) ?? insertAfterHeading(content, '## Çalışma protokolü', architectBlock)
}
function patchMaker(content) {
  const marked = replaceMarkedBlock(content, makerBlock)
  if (marked !== null) return marked
  return insertBefore(content, '## Çalışma düzeni', makerBlock) ?? insertBefore(content, '## Ne döneceksin', makerBlock)
}

function lastProperty(object, name) {
  if (!ts.isObjectLiteralExpression(object)) return null
  return [...object.properties].reverse().find(property => ts.isPropertyAssignment(property) && property.name.getText().replace(/["']/g, '') === name) ?? null
}
function insertAfterBrace(content, node, sourceFile, text) {
  const index = node.getStart(sourceFile) + 1
  return content.slice(0, index) + text + content.slice(index)
}
function patchConfig(content) {
  if (content === null) throw Error('opencode.jsonc missing')
  const sourceFile = ts.createSourceFile('opencode.jsonc', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSON)
  const root = sourceFile.statements[0]?.expression
  if (!root || !ts.isObjectLiteralExpression(root)) throw Error('opencode.jsonc root invalid')
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const localServer = `{ "type": "local", "command": ["node", "scripts/skill-library-mcp.mjs"], "codemode": false }`
  let next = content
  let mcp = lastProperty(root, 'mcp')
  if (!mcp) {
    const permissions = lastProperty(root, 'permissions')
    if (!permissions) throw Error('permissions anchor missing')
    const index = permissions.getStart(sourceFile)
    const block = `  "mcp": {${newline}    "servers": {${newline}      "skill_library": ${localServer}${newline}    }${newline}  },${newline}${newline}`
    next = next.slice(0, index) + block + next.slice(index)
  } else {
    const mcpObject = mcp.initializer
    const direct = lastProperty(mcpObject, 'skill_library')
    const servers = lastProperty(mcpObject, 'servers')
    if (!direct && !servers) {
      next = insertAfterBrace(next, mcpObject, sourceFile, `${newline}    "servers": { "skill_library": ${localServer} },`)
    } else if (servers && !lastProperty(servers.initializer, 'skill_library')) {
      next = insertAfterBrace(next, servers.initializer, sourceFile, `${newline}      "skill_library": ${localServer},`)
    }
  }

  const updated = ts.createSourceFile('opencode.jsonc', next, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSON)
  const updatedRoot = updated.statements[0]?.expression
  const permissions = lastProperty(updatedRoot, 'permissions')
  if (!permissions || !ts.isArrayLiteralExpression(permissions.initializer)) throw Error('permissions array missing')
  const parsedForPermission = ts.parseConfigFileTextToJson('opencode.jsonc', next)
  const hasPermission = Array.isArray(parsedForPermission.config?.permissions) && parsedForPermission.config.permissions.some(rule => rule.action === 'skill_library_*' && rule.effect === 'allow')
  if (!hasPermission) next = insertAfterBrace(next, permissions.initializer, updated, `${newline}    { "action": "skill_library_*", "resource": "*", "effect": "allow" },`)

  const parsed = ts.parseConfigFileTextToJson('opencode.jsonc', next)
  if (parsed.error?.length) throw Error('opencode.jsonc parse failed: ' + ts.flattenDiagnosticMessageText(parsed.error[0].messageText, ' '))
  const server = parsed.config?.mcp?.servers?.skill_library ?? parsed.config?.mcp?.skill_library
  if (server?.type !== 'local') throw Error('skill_library MCP config invalid')
  if (!Array.isArray(parsed.config?.permissions) || !parsed.config.permissions.some(rule => rule.action === 'skill_library_*' && rule.effect === 'allow')) throw Error('skill_library permission invalid')
  return next
}

export async function syncSkillPolicy(source, target, apply = false) {
  source = await realpath(source); target = await realpath(target)
  if (source === target) throw Error('Source and target must differ')
  const stateFile = await safe(target, 'docs/orchestra-skill-state.json')
  const old = JSON.parse(await read(stateFile) ?? '{"files":{}}')
  const skill = await readFile(join(source, '.opencode/skills/yetenek-kullanimi/SKILL.md'), 'utf8')
  const wrapper = await readFile(join(source, 'scripts/skill-library-mcp.mjs'), 'utf8')
  const definitions = [
    { path: '.opencode/skills/yetenek-kullanimi/SKILL.md', expected: skill, exact: true },
    { path: 'scripts/skill-library-mcp.mjs', expected: wrapper, exact: true },
    { path: '.opencode/agents/architect.md', patch: patchArchitect, exact: false },
    { path: '.opencode/agents/crew/maker.md', patch: patchMaker, exact: false },
    { path: 'opencode.jsonc', patch: patchConfig, exact: false },
  ]
  const plan = []
  for (const definition of definitions) {
    const file = await safe(target, definition.path)
    const before = await read(file)
    let expected = definition.expected
    if (definition.patch) {
      expected = definition.patch(before)
      if (expected === null) throw Error('Policy anchor missing: ' + definition.path)
    }
    const current = before === null ? null : hash(before), expectedHash = hash(expected)
    let action
    if (current === expectedHash) action = 'same'
    else if (current === null) action = 'create'
    else if (old.files?.[definition.path] === current) action = 'update'
    else if (!definition.exact && !old.files?.[definition.path]) action = 'adopt'
    else action = 'conflict'
    plan.push({ path: definition.path, file, before, expected, expectedHash, action })
  }
  const conflicts = plan.filter(item => item.action === 'conflict')
  if (conflicts.length) return { applied: false, conflicts: conflicts.map(item => item.path), plan: plan.map(({ path, action }) => ({ path, action })) }
  if (apply) {
    const backupRoot = join(target, '.orchestra-skill-backups', new Date().toISOString().replace(/[:.]/g, '-'))
    for (const item of plan) {
      if (item.action === 'same') continue
      if (await read(item.file) !== item.before) throw Error('Target changed during preflight: ' + item.path)
      if (item.before !== null) {
        const backup = await safe(target, relative(target, join(backupRoot, item.path)))
        await mkdir(dirname(backup), { recursive: true }); await writeFile(backup, item.before, { flag: 'wx' })
      }
      await mkdir(dirname(item.file), { recursive: true }); await writeFile(item.file, item.expected, { flag: item.action === 'create' ? 'wx' : 'w' })
      if (hash(await readFile(item.file, 'utf8')) !== item.expectedHash) throw Error('Post-write verification failed: ' + item.path)
    }
    const files = Object.fromEntries(plan.map(item => [item.path, item.expectedHash]))
    await mkdir(dirname(stateFile), { recursive: true }); await writeFile(stateFile, JSON.stringify({ version: 1, files }, null, 2) + '\n')
  }
  return { applied: apply, conflicts: [], plan: plan.map(({ path, action }) => ({ path, action })) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), targetIndex = args.indexOf('--target'), sourceIndex = args.indexOf('--source')
  try {
    if (targetIndex < 0 || !args[targetIndex + 1]) throw Error('Usage: node scripts/sync-skill-policy.mjs --target <existing-project> [--source <orchestra-source>] [--apply]; default dry-run')
    const source = sourceIndex >= 0 ? args[sourceIndex + 1] : resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const result = await syncSkillPolicy(source, args[targetIndex + 1], args.includes('--apply'))
    console.log(JSON.stringify(result, null, 2)); if (result.conflicts.length) process.exitCode = 2
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
