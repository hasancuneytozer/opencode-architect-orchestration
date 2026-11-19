import {test} from "node:test"
import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {mkdtemp, writeFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {captureGitBaseline, compareGitBaseline} from "../plugins/orchestra/baseline.ts"

test("Git baseline distinguishes existing changes from later edits and new files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "orchestra-baseline-"))
  try {
    const git = (...args) => execFileSync("git", args, {cwd: dir, stdio: "pipe"})
    const write = (name, contents) => writeFile(path.join(dir, name), contents)
    git("init")
    await write("tracked", "original")
    git("add", "tracked")
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial")
    assert.deepEqual((await captureGitBaseline(dir)).files, [])
    await write("tracked", "existing dirty")
    await write("existing", "already untracked")
    const initial = await captureGitBaseline(dir)
    assert.ok(initial)
    await write("tracked", "new task change")
    await write("new", "outside scope")
    assert.deepEqual(await compareGitBaseline(dir, initial), {
      status: "compared", changed: ["tracked", "new"], unchangedExisting: ["existing"],
    })
    assert.deepEqual(await compareGitBaseline(dir, undefined), {status: "unknown"})
    git("add", "-A")
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "changed")
    assert.deepEqual(await compareGitBaseline(dir, initial), {status: "unknown"})
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})
