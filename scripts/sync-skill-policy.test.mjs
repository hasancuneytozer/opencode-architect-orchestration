import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { syncSkillPolicy } from './sync-skill-policy.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-policy-sync-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const source = path.join(root, 'source'), target = path.join(root, 'target')
  await mkdir(path.join(source, '.opencode/skills/yetenek-kullanimi'), { recursive: true })
  await mkdir(path.join(source, 'scripts'), { recursive: true })
  await writeFile(path.join(source, '.opencode/skills/yetenek-kullanimi/SKILL.md'), '---\nname: Yetenek Kullanımı\n---\nSkill\n')
  await writeFile(path.join(source, 'scripts/skill-library-mcp.mjs'), '// wrapper\n')
  await mkdir(path.join(target, '.opencode/agents/crew'), { recursive: true })
  await mkdir(path.join(target, 'docs'), { recursive: true })
  await writeFile(path.join(target, '.opencode/agents/architect.md'), '---\nmodel: project/custom-architect\n---\n\n## Çalışma protokolü\n\n### 1. Brifing\nKeep this.\n')
  await writeFile(path.join(target, '.opencode/agents/crew/maker.md'), '---\nmodel: project/custom-maker\n---\n\n## Çalışma düzeni\nKeep this too.\n')
  await writeFile(path.join(target, 'opencode.jsonc'), '{\n  "model": "project/custom",\n  "permissions": [\n    { "action": "skill", "resource": "*", "effect": "allow" }\n  ]\n}\n')
  return { source, target }
}

test('skill policy sync is dry-run first, additive and idempotent', async t => {
  const { source, target } = await fixture(t)
  const dry = await syncSkillPolicy(source, target)
  assert.equal(dry.applied, false)
  assert.equal(dry.conflicts.length, 0)
  assert.equal(await readFile(path.join(target, '.opencode/skills/yetenek-kullanimi/SKILL.md')).catch(() => null), null)

  const applied = await syncSkillPolicy(source, target, true)
  assert.equal(applied.applied, true)
  assert.equal(applied.conflicts.length, 0)
  const architect = await readFile(path.join(target, '.opencode/agents/architect.md'), 'utf8')
  const maker = await readFile(path.join(target, '.opencode/agents/crew/maker.md'), 'utf8')
  const config = await readFile(path.join(target, 'opencode.jsonc'), 'utf8')
  assert.match(architect, /project\/custom-architect/)
  assert.match(architect, /orchestra-skill-policy:start/)
  assert.match(maker, /project\/custom-maker/)
  assert.match(maker, /skill_update_propose/)
  assert.match(config, /scripts\/skill-library-mcp\.mjs/)
  assert.match(config, /skill_library_\*/)
  assert.equal(JSON.parse(config).mcp.servers.skill_library.type, 'local')

  const again = await syncSkillPolicy(source, target, true)
  assert.equal(again.plan.every(item => item.action === 'same'), true)
})

test('skill policy sync stops on divergent managed content', async t => {
  const { source, target } = await fixture(t)
  await syncSkillPolicy(source, target, true)
  const maker = path.join(target, '.opencode/agents/crew/maker.md')
  const changed = (await readFile(maker, 'utf8')).replace('`skill_prepare` sonucundaki', '`skill_get` sonucundaki')
  await writeFile(maker, changed)
  const result = await syncSkillPolicy(source, target, true)
  assert.equal(result.applied, false)
  assert.deepEqual(result.conflicts, ['.opencode/agents/crew/maker.md'])
})

test('config patch preserves existing MCP servers and accepts the supported V1 shape', async t => {
  const first = await fixture(t)
  await writeFile(path.join(first.target, 'opencode.jsonc'), '{\n  "mcp": { "servers": { "penpot": { "type": "remote", "url": "http://localhost:4401/mcp" } } },\n  "permissions": []\n}\n')
  await syncSkillPolicy(first.source, first.target, true)
  const v2 = await readFile(path.join(first.target, 'opencode.jsonc'), 'utf8')
  assert.match(v2, /penpot/)
  assert.match(v2, /skill_library/)

  const second = await fixture(t)
  await writeFile(path.join(second.target, 'opencode.jsonc'), '{\n  "mcp": { "skill_library": { "type": "local", "command": ["node", "scripts/skill-library-mcp.mjs"] } },\n  "permissions": []\n}\n')
  await syncSkillPolicy(second.source, second.target, true)
  const v1 = await readFile(path.join(second.target, 'opencode.jsonc'), 'utf8')
  assert.match(v1, /skill_library_\*/)
})
