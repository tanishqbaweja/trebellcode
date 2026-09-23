import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { trebellHome } from "./paths.mjs";
import { git, gitInfo } from "./git-service.mjs";

export function isTransientCheckpointGitError(error){
  const message=String(error?.message||error||"");
  return /unable to create [^\n]*\.lock['"]?: file exists/i.test(message)
    || /(?:unable to stat|lstat\(|error: open\()[^\n]+: no such file or directory/i.test(message);
}

export class CheckpointService{
  constructor({state,env=process.env,gitFn=git,gitInfoFn=gitInfo,sleepFn=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
    this.state=state;this.env=env;this.gitFn=gitFn;this.gitInfoFn=gitInfoFn;this.sleepFn=sleepFn;
  }
  async #captureGit(cwd,args,options={}){
    let lastError=null;
    for(let attempt=0;attempt<3;attempt++){
      try{return await this.gitFn(cwd,args,options)}
      catch(error){
        lastError=error;
        if(attempt>=2||!isTransientCheckpointGitError(error))throw error;
        await this.sleepFn(75);
      }
    }
    throw lastError;
  }
  async create({cwd,threadId=null,label=null}){
    const info=await this.gitInfoFn(cwd);
    if(!info.isGit) return {supported:false,reason:"not_git"};
    const id=randomUUID();
    const tmpDir=join(trebellHome(this.env),"checkpoints");
    await mkdir(tmpDir,{recursive:true});
    const indexPath=join(tmpDir,`index-${id}`);
    const childEnv={...process.env,GIT_INDEX_FILE:indexPath};
    try{
      const head=await this.gitFn(info.root,["rev-parse","HEAD"],{allowFailure:true});
      if(head.ok) await this.#captureGit(info.root,["read-tree","HEAD"],{env:childEnv}); else await this.#captureGit(info.root,["read-tree","--empty"],{env:childEnv});
      await this.#captureGit(info.root,["add","-A","--","."],{env:childEnv});
      const tree=(await this.#captureGit(info.root,["write-tree"],{env:childEnv})).stdout.trim();
      const args=["commit-tree",tree,"-m",label||"Trebell Code checkpoint"];
      if(head.ok) args.push("-p",head.stdout.trim());
      const commit=(await this.#captureGit(info.root,args,{env:childEnv})).stdout.trim();
      const ref=`refs/trebell/checkpoints/${id}`;
      await this.#captureGit(info.root,["update-ref",ref,commit]);
      const item=this.state.addCheckpoint({id,threadId,root:info.root,commit,ref,label:label||null});
      return {supported:true,...item};
    }finally{
      await rm(indexPath,{force:true}).catch(()=>{});
      await rm(indexPath+".lock",{force:true}).catch(()=>{});
    }
  }
  list(threadId=null){return this.state.checkpoints(threadId);}
  link(id,patch){return this.state.updateCheckpoint(id,patch);}
  async restore(id){
    const cp=this.state.checkpoints().find(item=>item.id===id);
    if(!cp) throw new Error("Checkpoint not found");
    const info=await this.gitInfoFn(cp.root);
    if(!info.isGit) throw new Error("Checkpoint repository is unavailable");
    await this.gitFn(cp.root,["restore","--source",cp.commit,"--staged","--worktree","--","."]);
    const trackedAtCheckpoint=new Set((await this.gitFn(cp.root,["ls-tree","-r","--name-only",cp.commit])).stdout.split(/\r?\n/).filter(Boolean));
    const untracked=(await this.gitFn(cp.root,["ls-files","--others","--exclude-standard"])).stdout.split(/\r?\n/).filter(Boolean);
    for(const rel of untracked){if(!trackedAtCheckpoint.has(rel))await rm(join(cp.root,rel),{recursive:true,force:true}).catch(()=>{});}
    return {ok:true,checkpoint:cp,info:await this.gitInfoFn(cp.root)};
  }
}
