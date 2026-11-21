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