import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { trebellHome } from "./paths.mjs";
import { git, gitInfo } from "./git-service.mjs";

export class CheckpointService{
  constructor({state,env=process.env}={}){this.state=state;this.env=env;}
  async create({cwd,threadId=null,label=null}){
    const info=await gitInfo(cwd);
    if(!info.isGit) return {supported:false,reason:"not_git"};
    const id=randomUUID();
    const tmpDir=join(trebellHome(this.env),"checkpoints");
    await mkdir(tmpDir,{recursive:true});
    const indexPath=join(tmpDir,`index-${id}`);
    const childEnv={...process.env,GIT_INDEX_FILE:indexPath};
    try{
      const head=await git(info.root,["rev-parse","HEAD"],{allowFailure:true});
      if(head.ok) await git(info.root,["read-tree","HEAD"],{env:childEnv}); else await git(info.root,["read-tree","--empty"],{env:childEnv});
      await git(info.root,["add","-A","--","."],{env:childEnv});
      const tree=(await git(info.root,["write-tree"],{env:childEnv})).stdout.trim();
      const args=["commit-tree",tree,"-m",label||"Trebell Code checkpoint"];
      if(head.ok) args.push("-p",head.stdout.trim());
      const commit=(await git(info.root,args,{env:childEnv})).stdout.trim();
      const ref=`refs/trebell/checkpoints/${id}`;
      await git(info.root,["update-ref",ref,commit]);
      const item=this.state.addCheckpoint({id,threadId,root:info.root,commit,ref,label:label||null});
      return {supported:true,...item};
    }finally{await rm(indexPath,{force:true}).catch(()=>{});}
  }
  list(threadId=null){return this.state.checkpoints(threadId);}
  link(id,patch){return this.state.updateCheckpoint(id,patch);}
  async restore(id){
    const cp=this.state.checkpoints().find(item=>item.id===id);
    if(!cp) throw new Error("Checkpoint not found");
    const info=await gitInfo(cp.root);
    if(!info.isGit) throw new Error("Checkpoint repository is unavailable");
    await git(cp.root,["restore","--source",cp.commit,"--staged","--worktree","--","."]);
    const trackedAtCheckpoint=new Set((await git(cp.root,["ls-tree","-r","--name-only",cp.commit])).stdout.split(/\r?\n/).filter(Boolean));
    const untracked=(await git(cp.root,["ls-files","--others","--exclude-standard"])).stdout.split(/\r?\n/).filter(Boolean);
    for(const rel of untracked){if(!trackedAtCheckpoint.has(rel))await rm(join(cp.root,rel),{recursive:true,force:true}).catch(()=>{});}
    return {ok:true,checkpoint:cp,info:await gitInfo(cp.root)};
  }
}
