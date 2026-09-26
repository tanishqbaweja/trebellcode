import { randomUUID } from "node:crypto";
import { isAbsolute, join, posix, relative, sep } from "node:path";
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
  constructor({state,env=process.env,gitFn=git,gitInfoFn=gitInfo,environments=null,sleepFn=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
    this.state=state;this.env=env;this.gitFn=gitFn;this.gitInfoFn=gitInfoFn;this.environments=environments;this.sleepFn=sleepFn;
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
  #remoteProfile(environmentId){return environmentId?this.environments?.get?.(environmentId)||null:null}
  async #remoteExec(environmentId,{command,args=[],cwd=null,allowFailure=false,timeoutMs=120000,maxOutput=8*1024*1024}={}){
    if(!this.#remoteProfile(environmentId))throw new Error("Remote checkpoint environment is unavailable");
    const result=await this.environments.executeArgv(environmentId,{command,args,cwd,timeoutMs,maxOutput});
    const exitCode=Number(result?.exitCode),ok=Number.isFinite(exitCode)&&exitCode===0&&!result?.timedOut,normalized={ok,stdout:String(result?.stdout||""),stderr:String(result?.stderr||""),code:Number.isFinite(exitCode)?exitCode:1};
    if(!ok&&!allowFailure)throw new Error((normalized.stderr||normalized.stdout||`${command} failed`).trim());
    return normalized;
  }
  async #remoteGit(environmentId,cwd,args,{allowFailure=false,indexPath=null}={}){
    const command=indexPath?"env":"git",argv=indexPath?[`GIT_INDEX_FILE=${indexPath}`,"git",...args]:args;
    return this.#remoteExec(environmentId,{command,args:argv,cwd,allowFailure});
  }
  async #remoteGitInfo(environmentId,cwd){
    const base=String(cwd||"").trim(),root=await this.#remoteGit(environmentId,base,["rev-parse","--show-toplevel"],{allowFailure:true});
    if(!root.ok)return {isGit:false,cwd:base,root:null};
    const branch=await this.#remoteGit(environmentId,root.stdout.trim(),["branch","--show-current"],{allowFailure:true});
    return {isGit:true,cwd:base,root:root.stdout.trim(),branch:branch.stdout.trim()||null};
  }
  async #remoteTempDir(environmentId,cwd){
    const created=await this.#remoteExec(environmentId,{command:"mktemp",args:["-d","-t","trebell-checkpoint.XXXXXX"],cwd});
    const path=created.stdout.trim();if(!path)throw new Error("Remote checkpoint temporary directory was empty");return path;
  }
  async #cleanupRemoteTemp(environmentId,path,cwd){
    if(!path)return;await this.#remoteExec(environmentId,{command:"rm",args:["-rf","--",path],cwd,allowFailure:true,timeoutMs:30000,maxOutput:64*1024}).catch(()=>{});
  }
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
  async #stageRemoteCheckpoint(environmentId,root,indexPath){
    const stageArgs=["add","-A","--","."];
    let stageError;
    try{return await this.#remoteGit(environmentId,root,this.#durable(stageArgs),{indexPath})}
    catch(error){stageError=error;if(!/does not have a commit checked out/i.test(String(error?.message||error||"")))throw error}
    const untracked=await this.#remoteGit(environmentId,root,["ls-files","--others","--exclude-standard","-z","--","."],{indexPath});
    const candidates=String(untracked.stdout||"").split("\0").filter(entry=>entry.endsWith("/"));
    if(candidates.length>CHECKPOINT_NESTED_REPO_MAX_CANDIDATES)throw stageError;
    const exclusions=[];
    for(const entry of candidates){
      const nestedCwd=posix.join(root,entry),gitMarker=posix.join(nestedCwd,".git");
      const marker=await this.#remoteExec(environmentId,{command:"test",args:["-e",gitMarker],cwd:root,allowFailure:true,maxOutput:1024});if(!marker.ok)continue;
      const head=await this.#remoteGit(environmentId,nestedCwd,["rev-parse","--verify","HEAD"],{allowFailure:true});if(!head.ok)exclusions.push(":(exclude,literal)"+entry);
    }
    if(!exclusions.length)throw stageError;
    return this.#remoteGit(environmentId,root,this.#durable([...stageArgs,...exclusions]),{indexPath});
  }
  async #createRemote({cwd,threadId=null,label=null,environmentId}){
    const info=await this.#remoteGitInfo(environmentId,cwd);if(!info.isGit)return {supported:false,reason:"not_git",environmentId};
    const id=randomUUID(),tmpDir=await this.#remoteTempDir(environmentId,info.root),indexPath=posix.join(tmpDir,"index");
    try{
      const head=await this.#remoteGit(environmentId,info.root,["rev-parse","HEAD"],{allowFailure:true});
      if(head.ok)await this.#remoteGit(environmentId,info.root,["read-tree","HEAD"],{indexPath});else await this.#remoteGit(environmentId,info.root,["read-tree","--empty"],{indexPath});
      await this.#stageRemoteCheckpoint(environmentId,info.root,indexPath);
      const tree=(await this.#remoteGit(environmentId,info.root,this.#durable(["write-tree"]),{indexPath})).stdout.trim();
      const args=["commit-tree",tree,"-m",label||"Trebell Code checkpoint"];if(head.ok)args.push("-p",head.stdout.trim());
      const commit=(await this.#remoteGit(environmentId,info.root,this.#durable(args))).stdout.trim(),ref=`refs/trebell/checkpoints/${id}`;
      await this.#remoteGit(environmentId,info.root,this.#durable(["update-ref",ref,commit]));
      const item=this.state.addCheckpoint({id,threadId,root:info.root,commit,ref,label:label||null,environmentId});
      return {supported:true,...item};
    }finally{await this.#cleanupRemoteTemp(environmentId,tmpDir,info.root)}
  }
  async create({cwd,threadId=null,label=null,environmentId=null}){
    if(environmentId)return this.#createRemote({cwd,threadId,label,environmentId});
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
      const item=this.state.addCheckpoint({id,threadId,root:info.root,commit,ref,label:label||null,environmentId:null});
      return {supported:true,...item};
    }finally{
      await rm(indexPath,{force:true}).catch(()=>{});
      await rm(indexPath+".lock",{force:true}).catch(()=>{});
    }
  }
  list(threadId=null){return this.state.checkpoints(threadId);}
  link(id,patch){return this.state.updateCheckpoint(id,patch);}
  async #changedPathsRemote(cp){
    const environmentId=cp.environmentId,info=await this.#remoteGitInfo(environmentId,cp.root);if(!info.isGit)throw new Error("Checkpoint repository is unavailable");
    const tmpDir=await this.#remoteTempDir(environmentId,info.root),indexPath=posix.join(tmpDir,"index");
    try{
      await this.#remoteGit(environmentId,info.root,["read-tree",cp.commit],{indexPath});
      await this.#remoteGit(environmentId,info.root,["update-index","--refresh"],{indexPath,allowFailure:true});
      const modified=await this.#remoteGit(environmentId,info.root,["diff-files","--name-only","-z","--"],{indexPath});
      const untracked=await this.#remoteGit(environmentId,info.root,["ls-files","--others","--exclude-standard","-z","--"],{indexPath});
      const checkpointTree=await this.#remoteGit(environmentId,info.root,["ls-tree","-r","--name-only","-z",cp.commit]);
      const normalizePaths=value=>String(value||"").split("\0").map(item=>item.replace(/\\/g,"/").trim()).filter(Boolean),trackedAtCheckpoint=new Set(normalizePaths(checkpointTree.stdout));
      const paths=[...new Set([...normalizePaths(modified.stdout),...normalizePaths(untracked.stdout).filter(path=>!trackedAtCheckpoint.has(path))])].sort((a,b)=>a.localeCompare(b));
      return {checkpoint:cp,root:info.root,paths};
    }finally{await this.#cleanupRemoteTemp(environmentId,tmpDir,info.root)}
  }
  async changedPaths(id,{threadId=null}={}){
    const cp=this.state.checkpoints().find(item=>item.id===id);
    if(!cp)throw new Error("Checkpoint not found");
    if(threadId&&cp.threadId!==threadId)throw new Error("Checkpoint change inspection is allowed only from the thread that created this checkpoint.");
    if(cp.environmentId)return this.#changedPathsRemote(cp);
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
  #remotePath(value){const normalized=posix.normalize(String(value||"").replace(/\\/g,"/"));return normalized.length>1?normalized.replace(/\/$/,""):normalized}
  async #assertRemoteRestoreIsolation(cp,threadId){
    if(!threadId||cp.threadId!==threadId)throw new Error("Checkpoint file restore is allowed only from the thread that created this checkpoint.");
    const environmentId=cp.environmentId,meta=this.state.threadMeta?.(threadId)||{},root=this.#remotePath(cp.root),owner=this.#remotePath(meta.cwd);
    if(!environmentId||meta.environmentId!==environmentId||!root||owner!==root)throw new Error("File restore requires the thread to still own its original isolated worktree.");
    let managed=false;
    for(const project of this.state.projects?.()||[]){if((project.environmentId||null)!==environmentId||!project?.managedWorktree||project.managedWorktree.cleanedAt)continue;if(this.#remotePath(project.path)===root){managed=true;break}}
    if(!managed)throw new Error("File restore requires an isolated Trebell worktree. Rewind the conversation without restoring files instead.");
    const isWithin=(parent,child)=>{const rel=posix.relative(parent,child);return rel===""||(!rel.startsWith("../")&&rel!==".."&& !posix.isAbsolute(rel))};
    for(const [otherId,other] of Object.entries(this.state.listThreadMeta?.()||{})){if(otherId===threadId||other?.deletedAt||!other?.cwd||(other.environmentId||null)!==environmentId)continue;const otherPath=this.#remotePath(other.cwd);if(isWithin(root,otherPath)||isWithin(otherPath,root))throw new Error("File restore requires an isolated Trebell worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.")}
    return root;
  }
  async #restoreRemote(cp,threadId){
    const root=await this.#assertRemoteRestoreIsolation(cp,threadId),environmentId=cp.environmentId,info=await this.#remoteGitInfo(environmentId,root);if(!info.isGit)throw new Error("Checkpoint repository is unavailable");
    await this.#remoteGit(environmentId,root,["restore","--source",cp.commit,"--staged","--worktree","--","."]);
    const trackedAtCheckpoint=new Set(String((await this.#remoteGit(environmentId,root,["ls-tree","-r","--name-only","-z",cp.commit])).stdout||"").split("\0").filter(Boolean));
    const untracked=String((await this.#remoteGit(environmentId,root,["ls-files","--others","--exclude-standard","-z"])).stdout||"").split("\0").filter(Boolean);
    for(const rel of untracked){if(trackedAtCheckpoint.has(rel))continue;await this.#remoteExec(environmentId,{command:"rm",args:["-rf","--",rel],cwd:root,allowFailure:true,timeoutMs:30000,maxOutput:64*1024})}
    return {ok:true,checkpoint:cp,info:await this.#remoteGitInfo(environmentId,root)};
  }
  async restore(id,{threadId=null}={}){
    const cp=this.state.checkpoints().find(item=>item.id===id);
    if(!cp) throw new Error("Checkpoint not found");
    if(cp.environmentId)return this.#restoreRemote(cp,threadId);
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
