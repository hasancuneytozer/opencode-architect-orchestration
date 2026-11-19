import {execFile} from "node:child_process"
import {createHash} from "node:crypto"
import {lstat, realpath, readFile} from "node:fs/promises"
import path from "node:path"
import {promisify} from "node:util"

const exec = promisify(execFile)
const limit = 128

async function git(root: string, args: string[]) {
  return (await exec("git", ["--no-optional-locks", "-C", root, ...args], {
    timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true, encoding: "utf8",
  })).stdout
}

export type GitBaseline = { head: string; files: [string, string][] }
export async function captureGitBaseline(root?: string): Promise<GitBaseline | null> {
  if (!root) return null
  try {
    const repository = await realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim())
    const head = (await git(repository, ["rev-parse", "HEAD"])).trim()
    const statusArgs = ["status", "--porcelain=v2", "-z", "--no-renames", "--untracked-files=all"]
    const status = await git(repository, statusArgs)
    const records = status.split("\0").filter(Boolean)
    if (records.length > limit) return null
    const files: GitBaseline["files"] = []
    for (const record of records) {
      const match = /^(1 (?:[^ ]+ ){7}|[?] )([\s\S]+)$/.exec(record)
      if (!match) return null
      const [, metadata, name] = match
      const target = path.resolve(repository, name)
      const relative = path.relative(repository, target)
      if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null
      let digest = "missing"
      const file = await lstat(target).catch(error => { if (error.code !== "ENOENT") throw error; return null })
      if (file) {
        if (!file.isFile() || file.size > 2 * 1024 * 1024) return null
        const actual = await realpath(target)
        if (path.relative(target, actual) !== "") return null
        const bytes = await readFile(target)
        const after = await lstat(target)
        if (after.size !== file.size || after.mtimeMs !== file.mtimeMs || after.ino !== file.ino) return null
        digest = createHash("sha256").update(bytes).digest("hex")
      }
      files.push([name, metadata + digest])
    }
    if (status !== await git(repository, statusArgs) || head !== (await git(repository, ["rev-parse", "HEAD"])).trim()) return null
    return { head, files }
  } catch {
    return null
  }
}

export async function compareGitBaseline(root: string | undefined, baseline: GitBaseline | null | undefined) {
  if (!baseline) return { status: "unknown" }
  const current = await captureGitBaseline(root)
  if (!current || current.head !== baseline.head) return { status: "unknown" }
  const before = new Map(baseline.files)
  const after = new Map(current.files)
  const paths = [...new Set([...before.keys(), ...after.keys()])]
  return {
    status: "compared",
    changed: paths.filter(name => before.get(name) !== after.get(name)),
    unchangedExisting: paths.filter(name => before.get(name) === after.get(name)),
  }
}
