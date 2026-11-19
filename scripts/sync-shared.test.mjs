import {test} from "node:test"
import assert from "node:assert/strict"
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {createHash} from "node:crypto"
import {syncShared} from "./sync-shared.mjs"
const hash=s=>createHash("sha256").update(s).digest("hex")
async function fixture(t){
 const base=await mkdtemp(join(tmpdir(),"shared-test-"));t.after(()=>rm(base,{recursive:true,force:true}))
 const source=join(base,"source"),target=join(base,"target")
 for(const root of [source,target]){await mkdir(join(root,"docs"),{recursive:true});await mkdir(join(root,"scripts"))}
 const path="scripts/route-task.mjs"
 const publish=async body=>{await writeFile(join(source,path),body);await writeFile(join(source,"docs/orchestra-shared.json"),JSON.stringify({files:{[path]:hash(body)}}))}
 return {source,target,path,publish}
}
test("dry run, tracked update and backup preserve previous content",async t=>{
 const f=await fixture(t);await f.publish("one")
 assert.equal((await syncShared(f.source,f.target)).plan[0].action,"create")
 await assert.rejects(readFile(join(f.target,f.path)),{code:"ENOENT"})
 await syncShared(f.source,f.target,true);await f.publish("two")
 assert.equal((await syncShared(f.source,f.target,true)).plan[0].action,"update")
 assert.equal(await readFile(join(f.target,f.path),"utf8"),"two")
 const backups=await readdir(join(f.target,".orchestra-sync-backups"))
 assert.equal(await readFile(join(f.target,".orchestra-sync-backups",backups[0],f.path),"utf8"),"one")
})
test("divergent target blocks whole batch without overwriting",async t=>{
 const f=await fixture(t);await f.publish("one");await syncShared(f.source,f.target,true)
 await writeFile(join(f.target,f.path),"user edit");await f.publish("two")
 const result=await syncShared(f.source,f.target,true)
 assert.equal(result.applied,false);assert.deepEqual(result.conflicts,[f.path])
 assert.equal(await readFile(join(f.target,f.path),"utf8"),"user edit")
})
test("stale source and traversal are rejected before writing",async t=>{
 const f=await fixture(t);await f.publish("one");await writeFile(join(f.source,f.path),"untracked")
 await assert.rejects(syncShared(f.source,f.target,true),/manifest stale/)
 await writeFile(join(f.source,"docs/orchestra-shared.json"),JSON.stringify({files:{"scripts/route-task.mjs/../../escape":"bad"}}))
 await assert.rejects(syncShared(f.source,f.target,true),/Unsafe/)
 await assert.rejects(readFile(join(f.target,f.path)),{code:"ENOENT"})
})
