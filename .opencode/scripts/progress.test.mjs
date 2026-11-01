import {test} from "node:test"
import assert from "node:assert/strict"
import {mkdtemp,rm} from "node:fs/promises"
import {join} from "node:path"
import {tmpdir} from "node:os"
import {Memory} from "../plugins/orchestra/memory.ts"
import {TaskLedger,acceptanceState,blockedCriterion,pruneTasks} from "../plugins/orchestra/tasks.ts"
import {runLoop,DEFAULT_LOOP_CONFIG} from "../plugins/orchestra/loop.ts"
import {registerTools} from "../plugins/orchestra/tools.ts"
const verification={commit:"a".repeat(40),command:"npm test",exitCode:0,artifact:"result.log",reviewer:"verifier"}
async function api(memory){
 const tools={}
 const ctx={tool:{transform:async fn=>fn({namespace(){},add:t=>tools[t.name]=t})},session:{
  get:async({sessionID})=>sessionID==="s"?{agent:"architect"}:{parentID:"s"},interrupt:async()=>{},synthetic:async()=>{},wait:async()=>{},prompt:async()=>{},
 }}
 await registerTools(ctx,memory)
 const call=async(name,input)=> (await tools[name].execute(input,{sessionID:"s",agent:"architect"})).content
 return {ctx,call}
}
async function setup(t){
 const dir=await mkdtemp(join(tmpdir(),"orchestra-progress-"));t.after(()=>rm(dir,{recursive:true,force:true}))
 const memory=await Memory.open(dir);const ledger=await TaskLedger.open(memory,undefined,"s")
 return {dir,memory,ledger}
}
const attempt=(id,outcome="failed",blockerID="compile")=>({id,blockerID,outcome,evidence:[`${id}.log`]})
test("third completed failure survives rename, prune and reopen; independent work proceeds",async t=>{
 const {dir,memory,ledger}=await setup(t)
 const a=await ledger.add({title:"a",criterionID:"A",acceptance:"build"})
 await ledger.add({title:"b",criterionID:"B",acceptance:"independent"})
 assert.equal((await ledger.recordAttempt("A",attempt("one"))).ok,true)
 await ledger.update({id:a.task.id,title:"renamed",status:"failed"})
 const before=memory.getTaskVault("s")
 await memory.setTaskVault("s",{...before,tasks:pruneTasks(before.tasks,1)},before)
 const reopened=await Memory.open(dir), next=await TaskLedger.open(reopened,undefined,"s")
  assert.equal((await next.add({title:"retry",criterionID:"A",acceptance:"build",supersedes:[a.task.id],nextWork:"changed approach",evidence:["retry-plan.log"]})).ok,true)
 await next.recordAttempt("A",attempt("two"))
 await next.recordAttempt("A",attempt("progress","progress"))
 await next.recordAttempt("A",attempt("three"))
 assert.equal(blockedCriterion(next.defter().criteria.find(c=>c.id==="A")),true)
 assert.equal((await next.add({title:"retry again",criterionID:"A",acceptance:"build"})).ok,false)
 assert.equal(acceptanceState(next.defter()).actionable,true)
  assert.equal((await next.recordAttempt("A",{...attempt("resolve","resolved"),evidence:[verification.artifact],reason:"successful check confirms compiler repair",verification})).ok,true)
  const blocked=next.defter().tasks.filter(t=>t.criterionID==="A"&&t.status==="blocked").map(t=>t.id)
  assert.equal((await next.add({title:"retry resolved",criterionID:"A",acceptance:"build",supersedes:blocked,nextWork:"verify repaired build",evidence:["repair.log"]})).ok,true)
 assert.equal((await next.recordAttempt("A",attempt("one"))).ok,false)
})
test("evidence required, acceptance immutable, incomplete done rejected",async t=>{
 const {ledger}=await setup(t)
 const a=await ledger.add({title:"a",acceptance:"test",criterionID:"A"})
 assert.equal((await ledger.recordAttempt("A",{...attempt("empty"),evidence:[]})).ok,false)
 assert.equal((await ledger.update({id:a.task.id,acceptance:"easier"})).ok,false)
 assert.equal((await ledger.recordAttempt("A",attempt("verified","verified"))).ok,false)
 await ledger.recordAttempt("A",attempt("advance","progress"))
 assert.equal((await ledger.recordAttempt("A",{...attempt("advance","progress"),id:"different"})).ok,false)
 assert.equal(acceptanceState(ledger.defter()).done,false)
})
test("unbounded loop advances beyond 50 iterations then stops explicitly and reloads checkpoint",async t=>{
 const {dir,memory,ledger}=await setup(t)
 await ledger.add({title:"long acceptance",criterionID:"A",acceptance:"61 artifacts"})
 let n=0
 const {ctx,call}=await api(memory)
 ctx.session.prompt=async()=>{
   n++;assert.match(await call("task",{criterionID:"A",attempt:attempt(`step-${n}`,"progress")}),/tamamlandı/)
   assert.match(await call("report",{status:"continue",summary:"same prose"}),/Rapor kaydedildi/)
   if(n===61)await memory.setLoop("s",{status:"stopped"})
 }
 await runLoop(ctx,memory,{sessionID:"s",prompt:"continue acceptance"},{config:{...DEFAULT_LOOP_CONFIG,idleTimeoutMs:100,stopPollMs:10}})
 assert.equal(n,61)
 const reopened=await Memory.open(dir)
 assert.equal(reopened.getTaskVault("s").checkpoint.revision,61)
 assert.equal(reopened.getLoop("s").status,"stopped")
})
test("changing report prose without ledger evidence is a technical fault",async t=>{
 const {memory,ledger}=await setup(t);await ledger.add({title:"a",acceptance:"pending"})
 const {ctx,call}=await api(memory)
 ctx.session.prompt=async()=>{
  assert.match(await call("report",{status:"done",summary:"claimed"}),/INCOMPLETE_ACCEPTANCE/)
  await call("report",{status:"continue",summary:"changed prose"})
 }
 await runLoop(ctx,memory,{sessionID:"s",prompt:"verify"},{config:{...DEFAULT_LOOP_CONFIG,idleTimeoutMs:100,stopPollMs:10}})
 assert.equal(memory.getLoop("s").status,"blocked")
 assert.match(memory.getLoop("s").stopReason,/technical fault/)
})
test("verified acceptance survives reload and stale snapshots cannot erase attempts",async t=>{
 const {dir,memory,ledger}=await setup(t)
 const a=await ledger.add({title:"accept",criterionID:"A",acceptance:"tests pass"})
 const stale=memory.getTaskVault("s")
 await ledger.update({id:a.task.id,status:"running"})
 await ledger.update({id:a.task.id,status:"verifying"})
 await ledger.update({id:a.task.id,status:"done",evidence:["result.log"],verification:{commit:"a".repeat(40),command:"npm test",exitCode:0,artifact:"result.log",reviewer:"verifier"}})
 assert.equal(acceptanceState(ledger.defter()).done,false)
 assert.equal((await ledger.recordAttempt("A",attempt("verification","verified"))).ok,true)
 assert.equal(acceptanceState(ledger.defter()).done,true)
 const reopened=await Memory.open(dir)
 await assert.rejects(reopened.setTaskVault("s",stale,stale),/TASK_VAULT_CONFLICT/)
 assert.equal(acceptanceState(reopened.getTaskVault("s")).done,true)
 assert.equal(reopened.getTaskVault("s").criteria[0].attempts.length,1)
})
test("production tools allow planning, dispatch and a parked child wait without fake attempts",async t=>{
 const {memory}=await setup(t),{ctx,call}=await api(memory)
 let turn=0,waits=0
 ctx.session.wait=async({sessionID})=>{if(sessionID==="worker")waits++}
 ctx.session.prompt=async()=>{
  turn++
  if(turn===1){
   assert.match(await call("task",{title:"planned",acceptance:"checked",criterionID:"A"}),/P1/)
  }else if(turn===2){
   assert.match(await call("task",{id:"P1",status:"running",workerID:"worker"}),/running/)
  }else if(turn===3){
   assert.match(await call("report",{status:"continue",summary:"invented worker",waitingFor:["unknown"]}),/UNKNOWN_ACTIVE_WORKER/)
   assert.match(await call("report",{status:"continue",summary:"waiting",waitingFor:["worker"]}),/Rapor kaydedildi/)
   return
  }else{
   await call("task",{id:"P1",status:"verifying"})
   await call("task",{id:"P1",status:"done",verification,evidence:["result.log"]})
   await call("task",{criterionID:"A",attempt:attempt("verified","verified")})
   assert.match(await call("report",{status:"done",summary:"complete"}),/Rapor kaydedildi/)
   return
  }
  assert.match(await call("report",{status:"continue",summary:"concrete lifecycle"}),/Rapor kaydedildi/)
 }
 await runLoop(ctx,memory,{sessionID:"s",prompt:"deliver"},{config:{...DEFAULT_LOOP_CONFIG,idleTimeoutMs:500,stopPollMs:10}})
 assert.equal(turn,4);assert.equal(waits,1);assert.equal(memory.getLoop("s").status,"done")
 assert.equal(memory.getTaskVault("s").criteria[0].attempts.length,1)
 assert.equal(memory.getTaskVault("s").budget.iterations,1,"waiting is not an admission or solution attempt")
})
test("production loop rejects task churn and cannot heartbeat a completed worker forever",async t=>{
 for(const mode of ["churn","heartbeat","worker-churn"]){
  const {memory}=await setup(t),{ctx,call}=await api(memory);let n=0
  ctx.session.prompt=async()=>{
   n++
   if(mode==="churn" || mode==="worker-churn"){
    await call("task",{title:`new ${n}`,acceptance:`criterion ${n}`})
    if(mode==="worker-churn")await call("task",{id:`P${n}`,status:"running",workerID:`worker${n}`})
   }
   else if(n===1){await call("task",{title:"work",acceptance:"criterion"});await call("task",{id:"P1",status:"running",workerID:"worker"})}
   await call("report",{status:"continue",summary:`heartbeat ${n}`,...(mode==="heartbeat"?{waitingFor:["worker"]}:mode==="worker-churn"?{waitingFor:[`worker${n}`]}:{})})
  }
  await runLoop(ctx,memory,{sessionID:"s",prompt:mode},{config:{...DEFAULT_LOOP_CONFIG,idleTimeoutMs:500,stopPollMs:10}})
  assert.equal(n,2);assert.equal(memory.getLoop("s").status,"blocked")
  assert.match(memory.getLoop("s").stopReason,/technical fault/)
 }
})
test("historical verification cannot certify a failed current contributor",async t=>{
 const {memory}=await setup(t),{call}=await api(memory)
 await call("task",{title:"first",criterionID:"A",acceptance:"checked"})
 await call("task",{id:"P1",status:"running"});await call("task",{id:"P1",status:"verifying"})
 await call("task",{id:"P1",status:"done",verification,evidence:["one.log"]})
 await call("task",{criterionID:"A",attempt:attempt("v1","verified")})
 await call("task",{title:"new work",criterionID:"A",acceptance:"checked"})
 await call("task",{id:"P2",status:"running"});await call("task",{id:"P2",status:"failed"})
 await call("task",{criterionID:"A",attempt:attempt("failed2")})
 assert.match(await call("task",{criterionID:"A",attempt:attempt("v2","verified")}),/VERIFICATION_REQUIRED/)
 assert.match(await call("report",{status:"done",summary:"wrong"}),/INCOMPLETE_ACCEPTANCE/)
 assert.equal(acceptanceState(memory.getTaskVault("s")).actionable,false)
 assert.deepEqual(acceptanceState(memory.getTaskVault("s")).retryEligible,["A"])
 assert.match(await call("task",{title:"blind retry",criterionID:"A",acceptance:"checked"}),/RETRY_PLAN_REQUIRED/)
 assert.match(await call("task",{title:"planned retry",criterionID:"A",acceptance:"checked",supersedes:["P2"],nextWork:"replace broken import",evidence:["diagnosis.log"]}),/Görev açıldı/)
 assert.equal(acceptanceState(memory.getTaskVault("s")).actionable,true)
 await call("task",{id:"P3",status:"running"});await call("task",{id:"P3",status:"verifying"})
 await call("task",{id:"P3",status:"done",verification,evidence:["retry-result.log"]})
 assert.match(await call("task",{criterionID:"A",attempt:attempt("v3","verified")}),/tamamlandı/)
 assert.equal(acceptanceState(memory.getTaskVault("s")).done,true)
})
test("external-input blocked is terminal; independent paths remain actionable",async t=>{
 const {memory}=await setup(t),{call}=await api(memory)
 await call("task",{title:"needs input",acceptance:"external",criterionID:"A"})
 await call("task",{id:"P1",status:"blocked",evidence:["missing credentials"]})
 assert.equal(acceptanceState(memory.getTaskVault("s")).actionable,false)
 assert.match(await call("report",{status:"blocked",summary:"needs input"}),/Rapor kaydedildi/)
 await call("task",{title:"independent",acceptance:"local",criterionID:"B"})
 assert.match(await call("report",{status:"blocked",summary:"stop all"}),/ACTIONABLE_WORK_REMAINS/)
})
test("completion proof survives pruning behind over 300 live planned tasks",async t=>{
 const {memory,ledger}=await setup(t)
 await ledger.add({title:"complete",criterionID:"A",acceptance:"checked"})
 await ledger.update({id:"P1",status:"running"});await ledger.update({id:"P1",status:"verifying"})
 // Add through production ledger, so history and budget remain genuine.
 for(let i=0;i<301;i++)await ledger.add({title:`draft ${i}`})
 assert.equal((await ledger.update({id:"P1",status:"done",verification,evidence:["result.log"]})).ok,true)
 assert.equal(ledger.get("P1"),undefined)
 assert.equal((await ledger.recordAttempt("A",attempt("verify-pruned","verified"))).ok,true)
 assert.equal(memory.getTaskVault("s").criteria[0].work[0].verification.commit,verification.commit)
 assert.equal(acceptanceState(ledger.defter()).done,false,"unfilled drafts are still required work")
})
test("exact acceptance aliases cannot evade block; resolution requires distinct successful evidence",async t=>{
 const {memory}=await setup(t),{call}=await api(memory)
 await call("task",{title:"a",criterionID:"A",acceptance:"same exact acceptance"})
 for(let i=1;i<=3;i++)await call("task",{criterionID:"A",attempt:attempt(`fail${i}`)})
 assert.match(await call("task",{title:"alias",criterionID:"B",acceptance:"same exact acceptance"}),/CRITERION_ALIAS_COLLISION/)
 assert.match(await call("task",{criterionID:"A",attempt:{...attempt("resolve","resolved"),evidence:["fail3.log"],reason:"claimed",verification}}),/RESOLUTION_CHECK_REQUIRED/)
 assert.match(await call("task",{criterionID:"A",attempt:attempt("resolve","resolved")}),/RESOLUTION_CHECK_REQUIRED/)
 assert.match(await call("task",{criterionID:"A",attempt:{...attempt("resolve","resolved"),evidence:[verification.artifact],reason:"fixed dependency; check now passes",verification}}),/tamamlandı/)
 const details=await call("status",{criterionID:"A",offset:0,limit:2})
 assert.match(details,/blockerID/);assert.match(details,/fail1/);assert.doesNotMatch(details,/fail3.log/)
 assert.equal(memory.getTaskVault("s").criteria[0].attempts.length,4)
})
test("draft can bind acceptance before starting; semantic CAS survives reordered reopen",async t=>{
 const {dir,memory}=await setup(t),{call}=await api(memory)
 await call("task",{title:"draft"})
 assert.match(await call("task",{id:"P1",status:"running"}),/ACCEPTANCE_REQUIRED/)
 assert.equal(acceptanceState(memory.getTaskVault("s")).done,false)
 await call("task",{id:"P1",acceptance:"bound"})
 assert.match(await call("task",{id:"P1",status:"running"}),/running/)
 assert.match(await call("task",{id:"P1",acceptance:"replacement"}),/IMMUTABLE_ACCEPTANCE/)
 const snapshot=memory.getTaskVault("s"), reopened=await Memory.open(dir)
 const reordered=Object.fromEntries(Object.entries(snapshot).reverse())
 await reopened.setTaskVault("s",snapshot,reordered)
 await call("task",{id:"P1",status:"verifying"})
  await assert.rejects(reopened.setTaskVault("s",snapshot,reordered),/TASK_VAULT_CONFLICT/)
})

test("downstream dependencies follow successful replacement chains after pruning",async t=>{
 const {memory,ledger}=await setup(t)
 await ledger.add({title:"upstream",acceptance:"upstream",criterionID:"A"})
 await ledger.add({title:"downstream",acceptance:"downstream",dependsOn:["P1"]})
 await ledger.update({id:"P1",status:"running"});await ledger.update({id:"P1",status:"failed"})
 const cyclic=await ledger.add({title:"cyclic retry",acceptance:"upstream",criterionID:"A",dependsOn:["P2"],supersedes:["P1"],nextWork:"retry",evidence:["plan.log"]})
 assert.equal(cyclic.ok,false);assert.match(cyclic.error,/döngüsel/)
 assert.equal((await ledger.add({title:"retry",acceptance:"upstream",criterionID:"A",supersedes:["P1"],nextWork:"repair",evidence:["plan.log"]})).ok,true)
 await ledger.update({id:"P3",status:"running"});await ledger.update({id:"P3",status:"failed"})
 assert.equal((await ledger.add({title:"second retry",acceptance:"upstream",criterionID:"A",supersedes:["P3"],nextWork:"new repair",evidence:["plan2.log"]})).ok,true)
 assert.equal((await ledger.update({id:"P2",status:"running"})).ok,false)
 await ledger.update({id:"P4",status:"running"});await ledger.update({id:"P4",status:"verifying"})
 assert.equal((await ledger.update({id:"P4",status:"done",verification,evidence:["result.log"]})).ok,true)
 const snapshot=memory.getTaskVault("s")
 await memory.setTaskVault("s",{...snapshot,tasks:snapshot.tasks.filter(t=>!["P1","P3","P4"].includes(t.id))},snapshot)
 const reopened=await TaskLedger.open(memory,undefined,"s")
 assert.ok(acceptanceState(reopened.defter()).runnable.includes("P2"))
 assert.equal((await reopened.update({id:"P2",status:"running"})).ok,true)
})

test("legacy duplicate acceptance identities share retry history and allow recovery",async t=>{
 const {memory}=await setup(t)
 const legacy=(id,status)=>({id,title:id,status,acceptance:"same legacy acceptance",dependsOn:[],writeSurface:[],evidence:["legacy.log"],...(status==="done"?{verification}:{})})
 await memory.setTaskVault("s",{tasks:[legacy("P1","done"),legacy("P2","failed")],budget:{startedAt:1,tasks:2,iterations:2}})
 const ledger=await TaskLedger.open(memory,undefined,"s")
 const board=ledger.defter(), criterionID=board.tasks.find(t=>t.id==="P2").criterionID
 assert.equal(board.criteria.length,1)
 assert.equal(board.tasks[0].criterionID,criterionID)
 assert.equal((await ledger.add({title:"retry legacy",acceptance:"same legacy acceptance",criterionID,supersedes:["P2"],nextWork:"repair old failure",evidence:["plan.log"]})).ok,true)
})

test("legacy active work without acceptance can bind or explicitly leave active state",async t=>{
 const {memory}=await setup(t)
 const legacy=id=>({id,title:id,status:"running",acceptance:"",dependsOn:[],writeSurface:[id+".ts"],evidence:[]})
 await memory.setTaskVault("s",{tasks:[legacy("P1"),legacy("P2")],budget:{startedAt:1,tasks:2,iterations:2}})
 const ledger=await TaskLedger.open(memory,undefined,"s")
 assert.equal((await ledger.update({id:"P1",acceptance:"recovered acceptance"})).ok,true)
 assert.equal((await ledger.update({id:"P1",acceptance:"changed again"})).ok,false)
 assert.equal((await ledger.update({id:"P2",status:"blocked",evidence:["legacy worker unavailable"]})).ok,true)
 assert.equal((await ledger.update({id:"P2",acceptance:"second recovered acceptance"})).ok,true)
 assert.equal((await ledger.add({title:"fresh draft"})).ok,true)
 assert.equal((await ledger.update({id:"P3",status:"running"})).ok,false)
})
