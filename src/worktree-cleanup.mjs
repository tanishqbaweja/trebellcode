import { posix, resolve } from "node:path";
import { git, gitInfo, removeWorktree, restoreWorktree } from "./git-service.mjs";

function key(path){const value=resolve(String(path||""));return process.platform==="win32"?value.toLowerCase():value}
function remoteKey(path){const value=posix.normalize(String(path||"").replace(/\\/g,"/"));return value.length>1?value.replace(/\/$/,""):value}
export function resolveCleanupPolicy(project,settings={}){return project?.worktreeCleanup??settings?.worktreeCleanup??{mode:"off"}}

const LOCAL_OPS=Object.freeze({key,git,gitInfo,removeWorktree,restoreWorktree});
async function refSha(ops,cwd,ref){const result=await ops.git(cwd,["rev-parse",ref],{allowFailure:true});return result.ok?result.stdout.trim():null}
async function isAncestor(ops,cwd,ancestor,descendant){const result=await ops.git(cwd,["merge-base","--is-ancestor",ancestor,descendant],{allowFailure:true});return result.ok}

async function inspectManagedWorktreeWithOps(project,{settings={},activePaths=[],referencedPaths=[],reason=null,now=Date.now()}={},ops=LOCAL_OPS){
  const managed=project?.managedWorktree;if(!managed?.root||!managed?.branch)return {eligible:false,reason:"not_managed"};
  const policy=resolveCleanupPolicy(project,settings);if(policy?.mode!=="custom")return {eligible:false,reason:"cleanup_off",policy};
  const pathKeyFn=ops.key||key,rules=policy.rules||{},pathKey=pathKeyFn(project.path),active=new Set(activePaths.map(pathKeyFn)),referenced=new Set(referencedPaths.map(pathKeyFn));
  if(managed.cleanedAt)return {eligible:false,reason:"already_cleaned",policy};
  if(active.has(pathKey))return {eligible:false,reason:"active",policy};
  if(reason==="thread-delete"&&rules.worktreeOnDelete&&referenced.has(pathKey))return {eligible:false,reason:"threads_remain",policy};
  const info=await ops.gitInfo(project.path);if(!info.isGit)return {eligible:false,reason:"missing_or_not_git",policy};
  if(info.status.length)return {eligible:false,reason:"dirty",policy};
  const rootInfo=await ops.gitInfo(managed.root);if(!rootInfo.isGit)return {eligible:false,reason:"source_missing",policy};
  if(!rootInfo.worktrees.some(item=>pathKeyFn(item.path)===pathKey))return {eligible:false,reason:"not_registered",policy};
  const triggers=[];
  if(reason==="thread-delete"&&rules.worktreeOnDelete&&!referenced.has(pathKey))triggers.push("thread_deleted");
  if(rules.worktreeAfterDays!=null){const cutoff=Number(rules.worktreeAfterDays)*86400000;if(now-Number(project.lastOpenedAt||managed.createdAt||now)>=cutoff)triggers.push("inactive")}
  const base=managed.baseBranch||null;
  if(base){
    const [headSha,baseSha]=await Promise.all([refSha(ops,project.path,"HEAD"),refSha(ops,project.path,base)]);
    if(headSha&&baseSha){
      if(rules.worktreeUnchanged){const ahead=await ops.git(project.path,["rev-list","--count",`${base}..HEAD`],{allowFailure:true});if(ahead.ok&&Number(ahead.stdout.trim())===0)triggers.push("unchanged")}
      if(rules.worktreeOnMerge&&headSha!==baseSha&&await isAncestor(ops,project.path,"HEAD",base))triggers.push("merged");
    }
  }
  if(!triggers.length)return {eligible:false,reason:"no_rule_matched",policy};
  return {eligible:true,reason:triggers[0],triggers,policy,info};
}
export async function inspectManagedWorktree(project,options={}){return inspectManagedWorktreeWithOps(project,options,LOCAL_OPS)}

export class WorktreeCleanupService{
  constructor({state,environments=null,getUsage=()=>({activePaths:[],referencedPaths:[]}),log=()=>{}}={}){this.state=state;this.environments=environments;this.getUsage=getUsage;this.log=log}
  async #remoteGit(project,cwd,args,{allowFailure=false,timeoutMs=120000}={}){
    const result=await this.environments.executeArgv(project.environmentId,{command:"git",args,cwd,timeoutMs,maxOutput:8*1024*1024}),exitCode=Number(result?.exitCode),ok=Number.isFinite(exitCode)&&exitCode===0&&!result?.timedOut,normalized={ok,stdout:String(result?.stdout||""),stderr:String(result?.stderr||""),code:Number.isFinite(exitCode)?exitCode:1};
    if(!ok&&!allowFailure)throw new Error((normalized.stderr||normalized.stdout||"git failed").trim());return normalized;
  }
  async #remoteGitInfo(project,cwd){
    const rootRes=await this.#remoteGit(project,cwd,["rev-parse","--show-toplevel"],{allowFailure:true});if(!rootRes.ok)return {isGit:false,cwd,root:null,branch:null,status:[],worktrees:[]};
    const root=rootRes.stdout.trim(),branchRes=await this.#remoteGit(project,root,["branch","--show-current"],{allowFailure:true}),statusRes=await this.#remoteGit(project,root,["status","--porcelain=v1","-b"],{allowFailure:true}),worktreeRes=await this.#remoteGit(project,root,["worktree","list","--porcelain"],{allowFailure:true});
    const statusLines=statusRes.stdout.split(/\r?\n/).filter(Boolean),worktrees=[];let current=null;
    for(const line of worktreeRes.stdout.split(/\r?\n/)){if(line.startsWith("worktree ")){if(current)worktrees.push(current);current={path:line.slice(9)}}else if(current&&line.startsWith("HEAD "))current.head=line.slice(5);else if(current&&line.startsWith("branch "))current.branch=line.slice(7).replace(/^refs\/heads\//,"")}
    if(current)worktrees.push(current);return {isGit:true,cwd,root,branch:branchRes.stdout.trim()||null,status:statusLines.slice(1).map(line=>({code:line.slice(0,2),path:line.slice(3)})),statusHeader:statusLines[0]||"",worktrees};
  }
  #ops(project){
    if(!project?.environmentId)return LOCAL_OPS;
    const profile=this.environments?.get?.(project.environmentId);
    if(!profile)throw new Error("Pinned worktree environment could not be found");
    if(profile.type==="local")return LOCAL_OPS;
    return {
      key:remoteKey,
      git:(cwd,args,options={})=>this.#remoteGit(project,cwd,args,options),
      gitInfo:cwd=>this.#remoteGitInfo(project,cwd),
      removeWorktree:async(root,path,{force=false}={})=>{const args=["worktree","remove"];if(force)args.push("--force");args.push(path);await this.#remoteGit(project,root,args,{timeoutMs:180000});return this.#remoteGitInfo(project,root)},
      restoreWorktree:async(root,{branch,path,submodules="recursive"}={})=>{await this.#remoteGit(project,root,["worktree","add",path,branch],{timeoutMs:180000});if(submodules!=="none"){const args=["submodule","update","--init"];if(submodules!=="top-level")args.push("--recursive");await this.#remoteGit(project,path,args,{timeoutMs:300000})}return {worktree:path,submodules,info:await this.#remoteGitInfo(project,root)}},
    };
  }
  #pathKey(path,environmentId=null){const profile=environmentId?this.environments?.get?.(environmentId):null;return environmentId&&profile?.type!=="local"?remoteKey(path):key(path)}
  async inspect(project,options={}){const usage=this.getUsage();const scoped=this.state.projectSettings(project.path,project.environmentId||null);return inspectManagedWorktreeWithOps(project,{settings:{...this.state.settings(),worktreeCleanup:scoped.effective.worktreeCleanup},...usage,...options},this.#ops(project))}
  async cleanupProject(project,{reason=null,now=Date.now()}={}){
    const inspection=await this.inspect(project,{reason,now});if(!inspection.eligible)return {removed:false,projectId:project.id,path:project.path,...inspection};
    await this.#ops(project).removeWorktree(project.managedWorktree.root,project.path,{force:false});
    const updated=this.state.touchProject(project.path,{environmentId:project.environmentId||null,managedWorktree:{...project.managedWorktree,cleanedAt:Date.now(),cleanupReason:inspection.reason}});
    this.log(`cleaned worktree ${project.path} (${inspection.reason})`);return {removed:true,projectId:project.id,path:project.path,reason:inspection.reason,triggers:inspection.triggers,project:updated};
  }
  async sweep({reason=null,path=null,now=Date.now()}={}){
    const results=[];
    for(const project of this.state.projects()){
      if(!project.managedWorktree)continue;if(path&&this.#pathKey(project.path,project.environmentId||null)!==this.#pathKey(path,project.environmentId||null))continue;
      try{results.push(await this.cleanupProject(project,{reason,now}))}catch(error){results.push({removed:false,projectId:project.id,path:project.path,reason:"error",error:error.message||String(error)})}
    }
    return {results,removed:results.filter(item=>item.removed).length};
  }
  async ensure(path,environmentId=null){
    const project=this.state.projects().find(item=>(item.environmentId||null)===(environmentId||null)&&this.#pathKey(item.path,environmentId)===this.#pathKey(path,environmentId));if(!project?.managedWorktree)return {restored:false,project};
    const ops=this.#ops(project),info=await ops.gitInfo(project.path);
    if(info.isGit){
      if(project.managedWorktree.cleanedAt){const updated=this.state.touchProject(project.path,{environmentId:project.environmentId||null,managedWorktree:{...project.managedWorktree,cleanedAt:null,cleanupReason:null}});return {restored:false,reconciled:true,project:updated}}
      return {restored:false,project};
    }
    const restored=await ops.restoreWorktree(project.managedWorktree.root,{branch:project.managedWorktree.branch,path:project.path,submodules:project.managedWorktree.submodules});
    const updated=this.state.touchProject(project.path,{environmentId:project.environmentId||null,managedWorktree:{...project.managedWorktree,cleanedAt:null,cleanupReason:null}});return {restored:true,project:updated,result:restored};
  }
}
