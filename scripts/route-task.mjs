import {readFile} from "node:fs/promises"
import {resolve,dirname} from "node:path"
import {fileURLToPath} from "node:url"
export function routeTask(kind, risk="normal") {
 const roles={architecture:"architect",implementation:"crew/maker",review:"crew/critic",research:"crew/researcher",docs:"crew/scribe"}
 if(!Object.hasOwn(roles,kind)||!["low","normal","high"].includes(risk)) throw new Error("kind: architecture|implementation|review|research|docs; risk: low|normal|high")
 return {agent:roles[kind], reviewer:risk==="high"?"crew/critic":kind==="implementation"&&risk!=="low"?"crew/verifier":null,
    architecturalDecision:risk==="high"||kind==="architecture",maxParallel:risk==="high"?1:2,maxRepairRounds:3,repairScope:"same acceptance criterion and blocker; completed solution attempts only",
   automaticFallback:false,spawn:false,reason:risk==="high"?"Explicit architecture and independent review required":"Use only the roles needed for this task"}
}
export async function resolvedRoute(root,kind,risk) {
 const plan=routeTask(kind,risk)
 const model=async role=>(await readFile(resolve(root,".opencode/agents",role+".md"),"utf8")).match(/^model:\s*(.+)$/m)?.[1]?.trim()??"inherit"
 return {...plan,model:await model(plan.agent),reviewModel:plan.reviewer?await model(plan.reviewer):null,availability:"not-verified; check the connected runtime catalog before dispatch"}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {console.log(JSON.stringify(await resolvedRoute(resolve(dirname(fileURLToPath(import.meta.url)),".."),process.argv[2],process.argv[3]),null,2))}
 catch(e){console.error(e.message);process.exitCode=1}
}
