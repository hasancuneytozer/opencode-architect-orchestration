import {test} from "node:test"
import assert from "node:assert/strict"
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises"
import {join} from "node:path"
import {tmpdir} from "node:os"
import {Memory} from "../plugins/orchestra/memory.ts"
import {TaskLedger} from "../plugins/orchestra/tasks.ts"
import {runLoop} from "../plugins/orchestra/loop.ts"
import {routeTask,resolvedRoute} from "../../scripts/route-task.mjs"
async function setup(t,budget={}) {
 const root=await mkdtemp(join(tmpdir(),"orchestra-hardening-"));t.after(()=>rm(root,{recursive:true,force:true}))
 await mkdir(join(root,".opencode"));await writeFile(join(root,".opencode/orchestra.json"),JSON.stringify({budget:{mode:"autonomous",maxConcurrentTasks:2,...budget}}))
 const memory=await Memory.open(join(root,"memory"));const ledger=await TaskLedger.open(memory,root,"s")
 return {root,memory,ledger}
}
test("autonomous conflict rejects atomically including attempted evidence updates",async t=>{
 const {ledger}=await setup(t)
 const a=await ledger.add({title:"a",writeSurface:["src/a.ts"],acceptance:"checked"})
 const b=await ledger.add({title:"b",writeSurface:["src/a.ts"],acceptance:"checked"})
 assert.equal((await ledger.update({id:a.task.id,status:"running"})).ok,true)
 const before=ledger.defter()
 assert.equal((await ledger.update({id:b.task.id,status:"running",evidence:["not committed"]})).ok,false)
 assert.deepEqual(ledger.defter(),before)
 assert.equal((await ledger.update({id:a.task.id,status:"verifying"})).ok,true)
 assert.equal((await ledger.update({id:b.task.id,status:"running"})).ok,false)
})
test("budget admission and verification bind to an attempt",async t=>{
 const {ledger}=await setup(t,{maxConcurrentTasks:1,maxTasksPerGoal:2})
 const a=await ledger.add({title:"a",acceptance:"checked"});const b=await ledger.add({title:"b"})
 assert.equal((await ledger.add({title:"over budget"})).ok,false)
 await ledger.update({id:a.task.id,status:"running"})
 assert.equal((await ledger.update({id:b.task.id,status:"running"})).ok,false)
 await ledger.update({id:a.task.id,status:"verifying"})
 assert.equal((await ledger.update({id:a.task.id,status:"done",evidence:["claim"]})).ok,false)
 const verification={commit:"a".repeat(40),command:"npm test",exitCode:0,artifact:"report.log",reviewer:"critic"}
 assert.equal((await ledger.update({id:a.task.id,status:"done",evidence:["report.log"],verification})).ok,true)
 assert.equal((await ledger.update({id:b.task.id,status:"running"})).ok,true)
})
test("stale cross-instance writer cannot erase a newer task",async t=>{
 const {root,memory,ledger}=await setup(t);const stale=memory.getTaskVault("s")
 const other=await Memory.open(join(root,"memory"))
 await ledger.add({title:"preserve me"})
 await assert.rejects(other.setTaskVault("s",stale,stale),/TASK_VAULT_CONFLICT/)
 await memory.syncStore();assert.equal(memory.getTaskVault("s").tasks[0].title,"preserve me")
})
test("deadline remaining after prompt is used instead of restarting total budget",async t=>{
 const {memory}=await setup(t);let clock=0;let interrupted=false
 const ctx={session:{get:async()=>({agent:"architect"}),prompt:async()=>{clock=999},wait:()=>new Promise(()=>{}),interrupt:async()=>{interrupted=true},synthetic:async()=>{}}}
 const start=Date.now()
 await runLoop(ctx,memory,{sessionID:"deadline",prompt:"test"},{now:()=>clock,config:{max:2,idleTimeoutMs:2000,maxWallClockMs:1000,stopPollMs:1000}})
 assert.ok(Date.now()-start<700,"must use remaining 1ms, not a fresh 1000ms")
 assert.equal(interrupted,true)
})
test("routing is bounded and does not spawn or silently fallback",()=>{
 assert.equal(routeTask("implementation","low").reviewer,null)
 assert.equal(routeTask("implementation","high").architecturalDecision,true)
 assert.equal(routeTask("implementation","high").maxParallel,1)
 assert.equal(routeTask("review").automaticFallback,false)
 assert.equal(routeTask("research").spawn,false)
 assert.throws(()=>routeTask("../../outside"))
})
