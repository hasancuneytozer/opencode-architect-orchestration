import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const root = process.env.SKILL_LIBRARY_ROOT
  ? path.resolve(process.env.SKILL_LIBRARY_ROOT)
  : path.resolve(process.cwd(), '..', 'skill-and-extensions', 'skill-library')

const server = path.join(root, 'server', 'library-mcp.mjs')

if (!existsSync(server)) {
  process.stderr.write(
    `Skill Library MCP could not start: server file not found at ${server}.\n` +
    `Set SKILL_LIBRARY_ROOT to the Skill Library project root containing server/library-mcp.mjs, ` +
    `or place this repository beside skill-and-extensions/skill-library.\n`
  )
  process.exit(1)
}

const child = spawn(process.execPath, ['--no-warnings', server, '--skills-only'], {
  stdio: 'inherit',
  env: process.env,
})

child.on('error', (error) => {
  process.stderr.write(`Skill Library MCP wrapper failed: ${error.message}\n`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
