import { spawn } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const wrapper = 'C:\\projects\\opencode-architect-orchestration\\scripts\\skill-library-mcp.mjs'
const validRoot = 'C:\\projects\\skill-and-extensions\\skill-library'

test('wrong SKILL_LIBRARY_ROOT exits 1 with actionable message', async () => {
  const child = spawn(process.execPath, [wrapper], {
    env: { ...process.env, SKILL_LIBRARY_ROOT: 'C:\\this\\path\\does\\not\\exist' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(code, 1)
  assert.match(stderr, /server file not found/i)
  assert.match(stderr, /SKILL_LIBRARY_ROOT/)
})

test('valid root starts and answers MCP initialize', async () => {
  const child = spawn(process.execPath, [wrapper], {
    env: { ...process.env, SKILL_LIBRARY_ROOT: validRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n')
  await new Promise((resolve) => setTimeout(resolve, 500))
  child.kill()
  assert.match(stdout, /skill-library/)
})

async function visibleTools(proposalFlag) {
  const child = spawn(process.execPath, [wrapper], {
    env: { ...process.env, SKILL_LIBRARY_ROOT: validRoot, SKILL_LIBRARY_SKILL_PROPOSE: proposalFlag },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  const tools = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.id === 2) resolve(message.result.tools.map(tool => tool.name))
      }
    })
    child.on('error', reject)
  })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
  const names = await tools
  child.kill()
  return names
}

test('skills-only wrapper hides proposals unless host authorization is enabled', async () => {
  const hidden = await visibleTools('0')
  const visible = await visibleTools('1')
  assert.equal(hidden.includes('skill_prepare'), true)
  assert.equal(hidden.includes('skill_update_propose'), false)
  assert.equal(visible.includes('skill_update_propose'), true)
})