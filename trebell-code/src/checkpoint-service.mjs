import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { trebellHome } from "./paths.mjs";
import { git, gitInfo } from "./git-service.mjs";

const CHECKPOINT_NESTED_REPO_MAX_CANDIDATES=64;
const NESTED_GIT_ENV_KEYS=["GIT_DIR","GIT_WORK_TREE","GIT_COMMON_DIR","GIT_INDEX_FILE","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES"];
const CHECKPOINT_DURABLE_WRITE=["-c","core.fsync=objects,reference","-c","core.fsyncMethod=fsync"];

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
  #durable(args){return [...CHECKPOINT_DURABLE_WRITE,...args]}
  async #stageCheckpoint(root,childEnv){
    const stageArgs=["add","-A","--","."];
    let stageError;
    try{return await this.#captureGit(root,this.#durable(stageArgs),{env:childEnv})}
    catch(error){
      stageError=error;
      if(!/does not have a commit checked out/i.test(String(error?.message||error||"")))throw error;
    }
    const untracked=await this.#captureGit(root,["ls-files","--others","--exclude-standard","-z","--","."],{env:childEnv});
    const candidates=String(untracked.stdout||"").split("\0").filter(entry=>entry.endsWith("/"));
    if(candidates.length>CHECKPOINT_NESTED_REPO_MAX_CANDIDATES)throw stageError;
    const nestedEnv={...process.env};for(const key of NESTED_GIT_ENV_KEYS)delete nestedEnv[key];
    const exclusions=[];
    for(const entry of candidates){
      const nestedCwd=join(root,entry);
      try{await stat(join(nestedCwd,".git"))}catch{continue}
      const head=await this.gitFn(nestedCwd,["rev-parse","--verify","HEAD"],{allowFailure:true,env:nestedEnv});
      if(!head.ok)exclusions.push(":(exclude,literal)"+entry);
    }
    if(!exclusions.length)throw stageError;
    return this.#captureGit(root,this.#durable([...stageArgs,...exclusions]),{env:childEnv});
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
      await this.#stageCheckpoint(info.root,childEnv);
      const tree=(await this.#captureGit(info.root,this.#durable(["write-tree"]),{env:childEnv})).stdout.trim();
      const args=["commit-tree",tree,"-m",label||"Trebell Code checkpoint"];
      if(head.ok) args.push("-p",head.stdout.trim());
      const commit=(await this.#captureGit(info.root,this.#durable(args),{env:childEnv})).stdout.trim();
      const ref=`refs/trebell/checkpoints/${id}`;
      await this.#captureGit(info.root,this.#durable(["update-ref",ref,commit]));
      const item=this.state.addCheckpoint({id,threadId,root:info.root,commit,ref,label:label||null});
      return {supported:true,...item};
    }finally{
      await rm(indexPath,{force:true}).catch(()=>{});
      await rm(indexPath+".lock",{force:true}).catch(()=>{});
    }
  }
  list(threadId=null){return this.state.checkpoints(threadId);}
  link(id,patch){return this.state.updateCheckpoint(id,patch);}
  async changedPaths(id,{threadId=null}={}){
    const cp=this.state.checkpoints().find(item=>item.id===id);
    if(!cp)throw new Error("Checkpoint not found");
    if(threadId&&cp.threadId!==threadId)throw new Error("Checkpoint change inspection is allowed only from the thread that created this checkpoint.");
    const info=await this.gitInfoFn(cp.root);
    if(!info.isGit)throw new Error("Checkpoint repository is unavailable");
    const tmpDir=join(trebellHome(this.env),"checkpoints");
    await mkdir(tmpDir,{recursive:true});
    const indexPath=join(tmpDir,`compare-index-${randomUUID()}`);
    const childEnv={...process.env,GIT_INDEX_FILE:indexPath};
    try{
      await this.#captureGit(info.root,["read-tree",cp.commit],{env:childEnv});
      await this.gitFn(info.root,["update-index","--refresh"],{env:childEnv,allowFailure:true});
      const [modified,untracked,checkpointTree]=await Promise.all([
        this.#captureGit(info.root,["diff-files","--name-only","-z","--"],{env:childEnv}),
        this.#captureGit(info.root,["ls-files","--others","--exclude-standard","-z","--"],{env:childEnv}),
        this.#captureGit(info.root,["ls-tree","-r","--name-only","-z",cp.commit],{env:childEnv}),
      ]);
      const normalizePaths=value=>String(value||"").split("\0").map(item=>item.replace(/\\/g,"/").trim()).filter(Boolean);
      const trackedAtCheckpoint=new Set(normalizePaths(checkpointTree.stdout));
      const paths=[...new Set([
        ...normalizePaths(modified.stdout),
        ...normalizePaths(untracked.stdout).filter(path=>!trackedAtCheckpoint.has(path)),
      ])].sort((a,b)=>a.localeCompare(b));
      return {checkpoint:cp,root:info.root,paths};
    }finally{
      await rm(indexPath,{force:true}).catch(()=>{});
      await rm(indexPath+".lock",{force:true}).catch(()=>{});
    }
  }
  async #assertRestoreIsolation(cp,threadId){
    if(!threadId||cp.threadId!==threadId)throw new Error("Checkpoint file restore is allowed only from the thread that created this checkpoint.");
    const root=await realpath(cp.root).catch(()=>null);
    if(!root)throw new Error("Checkpoint repository is unavailable");
    const meta=this.state.threadMeta?.(threadId)||{};
    const owner=meta.cwd?await realpath(meta.cwd).catch(()=>null):null;
    if(!owner||owner!==root)throw new Error("File restore requires the thread to still own its original isolated worktree.");
    let managed=false;
    for(const project of this.state.projects?.()||[]){
      if(!project?.managedWorktree||project.managedWorktree.cleanedAt)continue;
      const projectPath=await realpath(project.path).catch(()=>null);
      if(projectPath===root){managed=true;break}
    }
    if(!managed)throw new Error("File restore requires an isolated Trebell worktree. Rewind the conversation without restoring files instead.");
    const isWithin=(parent,child)=>{
      const rel=relative(parent,child);
      return rel===""||(!isAbsolute(rel)&&rel!==".."&&!rel.startsWith(".."+sep));
    };
    for(const [otherId,other] of Object.entries(this.state.listThreadMeta?.()||{})){
      if(otherId===threadId||other?.deletedAt||!other?.cwd)continue;
      const otherPath=await realpath(other.cwd).catch(()=>null);if(!otherPath)continue;
      if(isWithin(root,otherPath)||isWithin(otherPath,root)){
        throw new Error("File restore requires an isolated Trebell worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.");
      }
    }
    return root;
  }
  async restore(id,{threadId=null}={}){
    const cp=this.state.checkpoints().find(item=>item.id===id);
    if(!cp) throw new Error("Checkpoint not found");
    await this.#assertRestoreIsolation(cp,threadId);
    const info=await this.gitInfoFn(cp.root);
    if(!info.isGit) throw new Error("Checkpoint repository is unavailable");
    await this.gitFn(cp.root,["restore","--source",cp.commit,"--staged","--worktree","--","."]);
    const trackedAtCheckpoint=new Set((await this.gitFn(cp.root,["ls-tree","-r","--name-only",cp.commit])).stdout.split(/\r?\n/).filter(Boolean));
    const untracked=(await this.gitFn(cp.root,["ls-files","--others","--exclude-standard"])).stdout.split(/\r?\n/).filter(Boolean);
    for(const rel of untracked){if(!trackedAtCheckpoint.has(rel))await rm(join(cp.root,rel),{recursive:true,force:true}).catch(()=>{});}
    return {ok:true,checkpoint:cp,info:await this.gitInfoFn(cp.root)};
  }
}
