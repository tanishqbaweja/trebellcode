import { createWorktree, removeWorktree } from "./git-service.mjs";

function normalizeSubmodules(value){return ["recursive","top-level","none"].includes(String(value||""))?String(value):"recursive"}

export async function createDelegationWorktree({
  sourceCwd,environmentId=null,branch,path,baseBranch=null,submodules="recursive",
  createLocal=createWorktree,removeLocal=removeWorktree,runRemoteGit=null,executeRemoteArgv=null,
}={}){
  const mode=normalizeSubmodules(submodules);
  if(!environmentId)return createLocal(sourceCwd,{branch,path,baseBranch,submodules:mode});
  if(typeof runRemoteGit!=="function")throw new Error("Remote delegation worktrees require a remote Git executor");
  let created=false;
  try{
    const result=await runRemoteGit({action:"worktree-create",name:branch,path,startPoint:baseBranch});created=true;
    if(mode!=="none"){
      if(typeof executeRemoteArgv!=="function")throw new Error("Remote delegation submodule setup requires a remote command executor");
      const args=["submodule","update","--init"];if(mode==="recursive")args.push("--recursive");
      const update=await executeRemoteArgv({command:"git",args,cwd:path,timeoutMs:300000,maxOutput:2*1024*1024});
      if(Number(update?.exitCode)!==0)throw new Error(String(update?.stderr||update?.stdout||"Remote worktree submodule setup failed").trim());
    }
    return {worktree:path,info:result?.info||null,output:result?.output||"",remote:true};
  }catch(error){
    if(created)await runRemoteGit({action:"worktree-remove",path,force:true}).catch(()=>{});
    throw error;
  }
}

export async function cleanupDelegationWorktree({sourceCwd,worktreePath,environmentId=null,removeLocal=removeWorktree,runRemoteGit=null}={}){
  if(!worktreePath)return {ok:true,skipped:true};
  if(environmentId){
    if(typeof runRemoteGit!=="function")throw new Error("Remote delegation worktree cleanup requires a remote Git executor");
    return runRemoteGit({action:"worktree-remove",path:worktreePath,force:true});
  }
  return removeLocal(sourceCwd,worktreePath,{force:true});
}
