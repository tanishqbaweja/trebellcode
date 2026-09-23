import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import { trebellHome } from "./paths.mjs";

const DAY_MS=24*60*60*1000;

function retentionDays(value){
  if(value==null||value==="")return null;
  const numeric=Math.trunc(Number(value));
  return Number.isFinite(numeric)&&numeric>=1?Math.min(3650,numeric):null;
}

function inside(root,target){
  const rel=relative(root,target);
  return rel===""||(!isAbsolute(rel)&&rel!==".."&&!rel.startsWith(".."+sep));
}

function referencedAttachmentPaths(state){
  const refs=new Set();
  for(const stash of state.listStashes?.()||[]){
    for(const path of stash?.attachments||[])if(path)refs.add(resolve(String(path)));
    for(const chip of stash?.contextChips||[])if(chip?.path)refs.add(resolve(String(chip.path)));
  }
  return refs;
}

export class StorageCleanupService{
  constructor({state,env=process.env,terminals=null,worktreeCleanup=null,log=()=>{}}={}){
    this.state=state;this.env=env;this.terminals=terminals;this.worktreeCleanup=worktreeCleanup;this.log=log;
  }

  settings(){
    const raw=this.state.settings?.().storageCleanup||{};
    return {
      attachmentsAfterDays:retentionDays(raw.attachmentsAfterDays),
      terminalHistoryAfterDays:retentionDays(raw.terminalHistoryAfterDays),
    };
  }

  async #attachmentFiles(){
    const root=join(trebellHome(this.env),"attachments");
    let rootStat;try{rootStat=await lstat(root)}catch{return {root,files:[]}}
    if(!rootStat.isDirectory()||rootStat.isSymbolicLink())return {root,files:[]};
    const realRoot=await realpath(root).catch(()=>null);if(!realRoot)return {root,files:[]};
    const entries=await readdir(realRoot,{withFileTypes:true}).catch(()=>[]);
    const files=[];
    for(const entry of entries){
      if(!entry.isFile()||entry.isSymbolicLink?.())continue;
      const path=join(realRoot,entry.name);
      const target=await realpath(path).catch(()=>null);if(!target||!inside(realRoot,target))continue;
      const info=await stat(target).catch(()=>null);if(!info?.isFile())continue;
      files.push({path:target,size:info.size,mtimeMs:info.mtimeMs});
    }
    return {root:realRoot,files};
  }

  async snapshot(){
    const {files}=await this.#attachmentFiles();
    const terminalSessions=this.terminals?.list?.()||[];
    const stopped=terminalSessions.filter(item=>!item.running);
    return {
      settings:this.settings(),
      attachments:{count:files.length,bytes:files.reduce((sum,item)=>sum+Number(item.size||0),0)},
      terminalHistory:{count:stopped.length,total:terminalSessions.length},
      worktrees:{managed:(this.state.projects?.()||[]).filter(project=>project?.managedWorktree&&!project.managedWorktree.cleanedAt).length},
    };
  }

  async #cleanAttachments(days,now){
    if(days==null)return {removed:0,bytes:0,enabled:false};
    const cutoff=now-days*DAY_MS;
    const protectedPaths=referencedAttachmentPaths(this.state);
    const {files}=await this.#attachmentFiles();
    let removed=0,bytes=0;
    for(const file of files){
      if(file.mtimeMs>=cutoff||protectedPaths.has(resolve(file.path)))continue;
      try{await rm(file.path,{force:true});removed++;bytes+=Number(file.size||0)}catch{}
    }
    if(removed)this.log("cleaned "+removed+" stale attachment"+(removed===1?"":"s"));
    return {removed,bytes,enabled:true};
  }

  #cleanTerminalHistory(days,now){
    if(days==null||!this.terminals?.pruneStopped)return {removed:0,enabled:false};
    const result=this.terminals.pruneStopped({before:now-days*DAY_MS});
    if(result.removed)this.log("cleaned "+result.removed+" stopped terminal histor"+(result.removed===1?"y":"ies"));
    return {...result,enabled:true};
  }

  async sweep({now=Date.now(),reason=null}={}){
    const settings=this.settings();
    const [worktrees,attachments]=await Promise.all([
      this.worktreeCleanup?.sweep?this.worktreeCleanup.sweep({now,reason}).catch(error=>({removed:0,results:[],error:error.message||String(error)})):Promise.resolve({removed:0,results:[]}),
      this.#cleanAttachments(settings.attachmentsAfterDays,now),
    ]);
    const terminalHistory=this.#cleanTerminalHistory(settings.terminalHistoryAfterDays,now);
    return {at:now,settings,worktrees,attachments,terminalHistory};
  }
}

