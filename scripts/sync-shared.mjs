import {readFile,writeFile,mkdir,realpath,lstat} from "node:fs/promises"
import {resolve,dirname,relative,isAbsolute,join} from "node:path"
import {fileURLToPath} from "node:url"
import {createHash} from "node:crypto"
const hash=s=>createHash("sha256").update(s.replace(/\r\n/g,"\n")).digest("hex")
const inside=(root,p)=>{const rel=relative(root,p);return !isAbsolute(rel)&&rel!==".."&&!rel.startsWith(".."+ (process.platform==="win32"?"\\":"/"))}
async function read(p){try{return await readFile(p,"utf8")}catch(e){if(e.code==="ENOENT")return null;throw e}}
async function safe(root,path){
 if(isAbsolute(path)||path.split(/[\\/]/).includes(".."))throw Error("Unsafe manifest path")
 const full=resolve(root,path);if(!inside(root,full))throw Error("Path outside target")
 let p=full
 while(p!==root){try{if((await lstat(p)).isSymbolicLink())throw Error("Symlink/junction not allowed: "+p)}catch(e){if(e.code!=="ENOENT")throw e}p=dirname(p)}
 return full
}
export async function syncShared(source,target,apply=false){
 source=await realpath(source);target=await realpath(target)
 if(source===target)throw Error("Source and target must differ")
 const manifest=JSON.parse(await readFile(join(source,"docs/orchestra-shared.json"),"utf8"))
 const tracking=await safe(target,"docs/orchestra-shared-state.json")
 const old=JSON.parse(await read(tracking)??'{"files":{}}')
 const plan=[]
 for(const [path,expected] of Object.entries(manifest.files)){
  if(!/^(\.opencode\/(plugins\/orchestra|scripts)\/|tools\/opencode-runtime\/|scripts\/(route-task|sync-shared)\.)/.test(path))throw Error("Unmanaged path: "+path)
  const from=await safe(source,path),to=await safe(target,path),body=await readFile(from,"utf8")
  if(hash(body)!==expected)throw Error("Source manifest stale: "+path)
  const before=await read(to),current=before===null?null:hash(before)
  const action=current===expected?"same":current===null?"create":old.files?.[path]===current?"update":"conflict"
  plan.push({path,to,body,before,action,expected})
 }
 if(plan.some(p=>p.action==="conflict"))return {applied:false,conflicts:plan.filter(p=>p.action==="conflict").map(p=>p.path),plan:plan.map(({path,action})=>({path,action}))}
 if(apply){
  // Preflight all targets before any write; no user/config/memory paths in this bundle.
  for(const p of plan)if(await read(p.to)!==p.before)throw Error("Target changed during preflight: "+p.path)
  const backupRoot=join(target,".orchestra-sync-backups",new Date().toISOString().replace(/[:.]/g,"-"))
  for(const p of plan){
   if(p.action==="same")continue
   if(p.before!==null){const backup=await safe(target,relative(target,join(backupRoot,p.path)));await mkdir(dirname(backup),{recursive:true});await writeFile(backup,p.before,{flag:"wx"})}
   await mkdir(dirname(p.to),{recursive:true});await writeFile(p.to,p.body,{flag:p.action==="create"?"wx":"w"})
   if(hash(await readFile(p.to,"utf8"))!==p.expected)throw Error("Post-write verification failed: "+p.path)
  }
  await mkdir(dirname(tracking),{recursive:true});await writeFile(tracking,JSON.stringify({version:1,files:manifest.files},null,2)+"\n")
 }
 return {applied:apply,conflicts:[],plan:plan.map(({path,action})=>({path,action}))}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),at=args.indexOf("--target")
 try{
  if(at<0||!args[at+1])throw Error("Usage: node scripts/sync-shared.mjs --target <existing-project> [--apply]; default dry-run")
  const result=await syncShared(resolve(dirname(fileURLToPath(import.meta.url)),".."),args[at+1],args.includes("--apply"));console.log(JSON.stringify(result,null,2));if(result.conflicts.length)process.exitCode=2
 }catch(e){console.error(e.message);process.exitCode=1}
}
