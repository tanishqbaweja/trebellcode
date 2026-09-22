import { resolve } from "node:path";
import { git, gitInfo, removeWorktree, restoreWorktree } from "./git-service.mjs";

function key(path){const value=resolve(String(path||""));return process.platform==="win32"?value.toLowerCase():value}
export function resolveCleanupPolicy(project,settings={}){return project?.worktreeCleanup??settings?.worktreeCleanup??{mode:"off"}}

async function refSha(cwd,ref){const result=await git(cwd,["rev-parse",ref],{allowFailure:true});return result.ok?result.stdout.trim():null}
async function isAncestor(cwd,ancestor,descendant){const result=await git(cwd,["merge-base","--is-ancestor",ancestor,descendant],{allowFailure:true});return result.ok}

export async function inspectManagedWorktree(project,{settings={},activePaths=[],referencedPaths=[],reason=null,now=Date.now()}={}){
  const managed=project?.managedWorktree;if(!managed?.root||!managed?.branch)return {eligible:false,reason:"not_managed"};
  const policy=resolveCleanupPolicy(project,settings);if(policy?.mode!=="custom")return {eligible:false,reason:"cleanup_off",policy};
  const rules=policy.rules||{};const pathKey=key(project.path);const active=new Set(activePaths.map(key));const referenced=new Set(referencedPaths.map(key));
  if(managed.cleanedAt)return {eligible:false,reason:"already_cleaned",policy};
  if(active.has(pathKey))return {eligible:false,reason:"active",policy};
  if(reason==="thread-delete"&&rules.worktreeOnDelete&&referenced.has(pathKey))return {eligible:false,reason:"threads_remain",policy};
  const info=await gitInfo(project.path);if(!info.isGit)return {eligible:false,reason:"missing_or_not_git",policy};
  if(info.status.length)return {eligible:false,reason:"dirty",policy};
  const rootInfo=await gitInfo(managed.root);if(!rootInfo.isGit)return {eligible:false,reason:"source_missing",policy};
  if(!rootInfo.worktrees.some(item=>key(item.path)===pathKey))return {eligible:false,reason:"not_registered",policy};
  const triggers=[];
  if(reason==="thread-delete"&&rules.worktreeOnDelete&&!referenced.has(pathKey))triggers.push("thread_deleted");
  if(rules.worktreeAfterDays!=null){const cutoff=Number(rules.worktreeAfterDays)*86400000;if(now-Number(project.lastOpenedAt||managed.createdAt||now)>=cutoff)triggers.push("inactive")}
  const base=managed.baseBranch||null;
  if(base){
    const [headSha,baseSha]=await Promise.all([refSha(project.path,"HEAD"),refSha(project.path,base)]);
    if(headSha&&baseSha){
      if(rules.worktreeUnchanged){const ahead=await git(project.path,["rev-list","--count",`${base}..HEAD`],{allowFailure:true});if(ahead.ok&&Number(ahead.stdout.trim())===0)triggers.push("unchanged")}
      if(rules.worktreeOnMerge&&headSha!==baseSha&&await isAncestor(project.path,"HEAD",base))triggers.push("merged");
    }
  }
  if(!triggers.length)return {eligible:false,reason:"no_rule_matched",policy};
  return {eligible:true,reason:triggers[0],triggers,policy,info};
}

export class WorktreeCleanupService{
  constructor({state,getUsage=()=>({activePaths:[],referencedPaths:[]}),log=()=>{}}={}){this.state=state;this.getUsage=getUsage;this.log=log}
  async inspect(project,options={}){const usage=this.getUsage();return inspectManagedWorktree(project,{settings:this.state.settings(),...usage,...options})}
  async cleanupProject(project,{reason=null,now=Date.now()}={}){
    const inspection=await this.inspect(project,{reason,now});if(!inspection.eligible)return {removed:false,projectId:project.id,path:project.path,...inspection};
    await removeWorktree(project.managedWorktree.root,project.path,{force:false});
    const updated=this.state.touchProject(project.path,{managedWorktree:{...project.managedWorktree,cleanedAt:Date.now(),cleanupReason:inspection.reason}});
    this.log(`cleaned worktree ${project.path} (${inspection.reason})`);return {removed:true,projectId:project.id,path:project.path,reason:inspection.reason,triggers:inspection.triggers,project:updated};
  }
  async sweep({reason=null,path=null,now=Date.now()}={}){
    const wanted=path?key(path):null;const results=[];
    for(const project of this.state.projects()){
      if(!project.managedWorktree)continue;if(wanted&&key(project.path)!==wanted)continue;
      try{results.push(await this.cleanupProject(project,{reason,now}))}catch(error){results.push({removed:false,projectId:project.id,path:project.path,reason:"error",error:error.message||String(error)})}
    }
    return {results,removed:results.filter(item=>item.removed).length};
  }
  async ensure(path){
    const project=this.state.projects().find(item=>key(item.path)===key(path));if(!project?.managedWorktree)return {restored:false,project};
    const info=await gitInfo(project.path);
    if(info.isGit){
      if(project.managedWorktree.cleanedAt){const updated=this.state.touchProject(project.path,{managedWorktree:{...project.managedWorktree,cleanedAt:null,cleanupReason:null}});return {restored:false,reconciled:true,project:updated}}
      return {restored:false,project};
    }
    const restored=await restoreWorktree(project.managedWorktree.root,{branch:project.managedWorktree.branch,path:project.path,submodules:project.managedWorktree.submodules});
    const updated=this.state.touchProject(project.path,{managedWorktree:{...project.managedWorktree,cleanedAt:null,cleanupReason:null}});return {restored:true,project:updated,result:restored};
  }
}
