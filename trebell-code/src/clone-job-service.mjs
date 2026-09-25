import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { posix } from "node:path";
import { redactSecretText } from "./secret-redactor.mjs";

const ACTIVE=new Set(["running","cancelling"]);

function trim(text,limit=16000){
  const value=String(text||"");
  return value.length>limit?value.slice(value.length-limit):value;
}
function projectNameFromUrl(url){
  const raw=String(url||"").replace(/[\\/]+$/,"");
  const name=(raw.split(/[\\/:]/).filter(Boolean).pop()||"repository").replace(/\.git$/i,"");
  return name||"repository";
}
function persistentCloneUrl(value,environment){
  const raw=String(value||"").trim();
  try{
    const parsed=new URL(raw);
    parsed.username="";parsed.password="";
    for(const key of [...parsed.searchParams.keys()])if(/(?:token|key|secret|password|credential|authorization)/i.test(key))parsed.searchParams.delete(key);
    return redactSecretText(parsed.toString(),{environment});
  }catch{return redactSecretText(raw,{environment})}
}
function publicJob(job,environment=process.env){
  if(!job)return null;
  return {
    id:job.id,url:persistentCloneUrl(job.url,environment),destination:job.destination,environmentId:job.environmentId||null,status:job.status,
    progress:job.progress,phase:job.phase,error:job.error?redactSecretText(job.error,{environment}):null,startedAt:job.startedAt,completedAt:job.completedAt||null,
    output:trim(redactSecretText(job.output||"",{environment}),8000),
  };
}
export function parseCloneProgress(text,current={progress:0,phase:"Cloning"}){
  const value=String(text||"");let progress=Number(current.progress)||0,phase=String(current.phase||"Cloning");
  const lines=value.split(/\r?\n|\r/).filter(Boolean);
  for(const line of lines){
    const match=line.match(/(?:remote:\s*)?([^:]+):\s*(\d{1,3})%/);
    if(match){phase=match[1].trim();progress=Math.max(progress,Math.min(99,Number(match[2])||0));continue}
    if(/Cloning into/i.test(line))phase="Cloning";
    else if(/Enumerating objects/i.test(line))phase="Enumerating objects";
    else if(/Counting objects/i.test(line))phase="Counting objects";
    else if(/Compressing objects/i.test(line))phase="Compressing objects";
    else if(/Receiving objects/i.test(line))phase="Receiving objects";
    else if(/Resolving deltas/i.test(line))phase="Resolving deltas";
  }
  return {progress,phase};
}

export class CloneJobService{
  constructor({state,environments=null,env=process.env,spawnProcess=spawn,log=()=>{}}={}){
    this.state=state;this.environments=environments;this.env=env;this.spawnProcess=spawnProcess;this.log=log;this.jobs=new Map();
  }
  profile(environmentId){
    return environmentId?this.environments?.get(environmentId):null;
  }
  isRemote(environmentId){
    const profile=this.profile(environmentId);return Boolean(profile&&profile.type!=="local");
  }
  normalizeDestination(destination,environmentId){
    const value=String(destination||"").trim();if(!value)throw new Error("Clone destination is required");
    return this.isRemote(environmentId)?value:resolve(value);
  }
  parent(destination,environmentId){
    return this.isRemote(environmentId)?posix.dirname(destination):dirname(destination);
  }
  async pathExists(path,environmentId){
    if(!this.isRemote(environmentId)){try{await stat(path);return true}catch{return false}}
    const result=await this.environments.executeArgv(environmentId,{command:"test",args:["-e",path],cwd:"",timeoutMs:10000,maxOutput:64*1024});
    return Number(result.exitCode)===0;
  }
  async ensureParent(path,environmentId){
    const parent=this.parent(path,environmentId);
    if(!this.isRemote(environmentId)){await mkdir(parent,{recursive:true});return}
    const result=await this.environments.executeArgv(environmentId,{command:"mkdir",args:["-p",parent],cwd:"",timeoutMs:15000,maxOutput:128*1024});
    if(Number(result.exitCode)!==0)throw new Error((result.stderr||result.stdout||"Could not create clone destination").trim());
  }
  async cleanupTemp(path,environmentId){
    if(!path)return;
    if(!this.isRemote(environmentId)){await rm(path,{recursive:true,force:true}).catch(()=>{});return}
    await this.environments.executeArgv(environmentId,{command:"rm",args:["-rf","--",path],cwd:"",timeoutMs:30000,maxOutput:128*1024}).catch(()=>{});
  }
  async moveIntoPlace(tempPath,destination,environmentId){
    if(await this.pathExists(destination,environmentId))throw new Error("Clone destination already exists");
    if(!this.isRemote(environmentId)){await rename(tempPath,destination);return}
    const result=await this.environments.executeArgv(environmentId,{command:"mv",args:["--",tempPath,destination],cwd:"",timeoutMs:30000,maxOutput:128*1024});
    if(Number(result.exitCode)!==0)throw new Error((result.stderr||result.stdout||"Could not finalize cloned repository").trim());
  }
  persist(job){
    const project=this.state.project(job.destination,job.environmentId||null);
    if(!project)return;
    this.state.setProjectCloneJob(job.destination,job.environmentId||null,{
      id:job.id,url:persistentCloneUrl(job.url,this.env),status:job.status,progress:job.progress,phase:job.phase,error:job.error?redactSecretText(job.error,{environment:this.env}):null,
      startedAt:job.startedAt,completedAt:job.completedAt||null,tempPath:job.tempPath,
    });
  }
  spawnClone(job){
    const args=["clone","--progress",job.url,job.tempPath];const parent=this.parent(job.tempPath,job.environmentId);
    if(this.isRemote(job.environmentId))return this.environments.spawnArgv(job.environmentId,{command:"git",args,cwd:parent,stdio:["ignore","pipe","pipe"]});
    return this.spawnProcess("git",args,{cwd:parent,env:this.env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  }
  updateFromOutput(job,chunk){
    const text=String(chunk||"");job.output=trim((job.output||"")+text);
    const next=parseCloneProgress(text,job);const changed=next.progress!==job.progress||next.phase!==job.phase;
    job.progress=next.progress;job.phase=next.phase;if(changed)this.persist(job);
  }
  async finish(job,{code=1,signal=null,error=null}={}){
    if(job.settled)return;job.settled=true;
    if(job.cancelRequested){
      await this.cleanupTemp(job.tempPath,job.environmentId);job.status="cancelled";job.phase="Cancelled";job.completedAt=Date.now();job.error=null;this.persist(job);job.resolve?.(publicJob(job,this.env));return;
    }
    if(error||Number(code)!==0){
      await this.cleanupTemp(job.tempPath,job.environmentId);job.status="failed";job.phase="Clone failed";job.completedAt=Date.now();
      job.error=String(error?.message||trim(job.output||"",4000)||("git clone exited with code "+String(code)+(signal?" ("+signal+")":"")));this.persist(job);job.resolve?.(publicJob(job,this.env));return;
    }
    try{
      await this.moveIntoPlace(job.tempPath,job.destination,job.environmentId);job.status="completed";job.progress=100;job.phase="Ready";job.completedAt=Date.now();job.error=null;this.persist(job);job.resolve?.(publicJob(job,this.env));
    }catch(moveError){
      await this.cleanupTemp(job.tempPath,job.environmentId);job.status="failed";job.phase="Clone failed";job.completedAt=Date.now();job.error=moveError.message||String(moveError);this.persist(job);job.resolve?.(publicJob(job,this.env));
    }
  }
  async start({url,destination,environmentId=null,name=null}={}){
    const remote=String(url||"").trim();if(!remote)throw new Error("Repository URL is required");
    const envId=environmentId||null;if(envId&&!this.profile(envId))throw new Error("Environment profile was not found");
    const target=this.normalizeDestination(destination,envId);if(await this.pathExists(target,envId))throw new Error("Clone destination already exists");
    const active=[...this.jobs.values()].find(job=>job.destination===target&&(job.environmentId||null)===envId&&ACTIVE.has(job.status));
    if(active)return publicJob(active,this.env);
    await this.ensureParent(target,envId);
    const id=randomUUID();const tempPath=target+".trebell-clone-"+id.slice(0,8);
    await this.cleanupTemp(tempPath,envId);
    this.state.touchProject(target,{environmentId:envId,name:name||projectNameFromUrl(remote),cloneJob:{id,url:persistentCloneUrl(remote,this.env),status:"running",progress:0,phase:"Starting clone",error:null,startedAt:Date.now(),completedAt:null,tempPath}});
    const job={id,url:remote,destination:target,environmentId:envId,tempPath,status:"running",progress:0,phase:"Starting clone",error:null,output:"",startedAt:Date.now(),completedAt:null,child:null,cancelRequested:false,settled:false};
    job.completion=new Promise(resolveJob=>{job.resolve=resolveJob});this.jobs.set(id,job);this.persist(job);
    try{
      const child=this.spawnClone(job);job.child=child;job.phase="Cloning";this.persist(job);
      child.stdout?.on("data",chunk=>this.updateFromOutput(job,chunk));child.stderr?.on("data",chunk=>this.updateFromOutput(job,chunk));
      child.once("error",err=>this.finish(job,{error:err}).catch(()=>{}));
      child.once("close",(code,signal)=>this.finish(job,{code,signal}).catch(()=>{}));
    }catch(error){await this.finish(job,{error})}
    this.log(redactSecretText("clone started "+remote+" -> "+target,{environment:this.env}));return publicJob(job,this.env);
  }
  get(id){
    const live=this.jobs.get(String(id||""));if(live)return publicJob(live,this.env);
    for(const project of this.state.projects())if(project.cloneJob?.id===id)return {...project.cloneJob,destination:project.path,environmentId:project.environmentId||null,output:""};
    return null;
  }
  list(){
    const byId=new Map();
    for(const project of this.state.projects())if(project.cloneJob?.id)byId.set(project.cloneJob.id,{...project.cloneJob,destination:project.path,environmentId:project.environmentId||null,output:""});
    for(const job of this.jobs.values())byId.set(job.id,publicJob(job,this.env));
    return [...byId.values()].sort((a,b)=>(b.startedAt||0)-(a.startedAt||0));
  }
  async cancel(id){
    const job=this.jobs.get(String(id||""));if(!job)throw new Error("Clone job is not running");
    if(!ACTIVE.has(job.status))return publicJob(job,this.env);
    job.cancelRequested=true;job.status="cancelling";job.phase="Cancelling";this.persist(job);
    try{job.child?.kill("SIGTERM")}catch{}
    setTimeout(()=>{if(!job.settled){try{job.child?.kill("SIGKILL")}catch{}}},2500).unref?.();
    return publicJob(job,this.env);
  }
  async retry(id){
    const previous=this.get(id);if(!previous)throw new Error("Clone job was not found");
    if(ACTIVE.has(previous.status))throw new Error("Clone is still running");
    return this.start({url:previous.url,destination:previous.destination,environmentId:previous.environmentId||null});
  }
  async wait(id,{timeoutMs=10*60_000}={}){
    const job=this.jobs.get(String(id||""));if(!job)return this.get(id);
    if(!ACTIVE.has(job.status))return publicJob(job,this.env);
    return new Promise(resolveWait=>{
      const timer=setTimeout(()=>resolveWait(publicJob(job,this.env)),Math.max(1000,Number(timeoutMs)||10*60_000));timer.unref?.();
      job.completion.then(result=>{clearTimeout(timer);resolveWait(result)});
    });
  }
  async recoverInterrupted(){
    for(const project of this.state.projects()){
      const cloneJob=project.cloneJob;if(!cloneJob||!ACTIVE.has(cloneJob.status))continue;
      await this.cleanupTemp(cloneJob.tempPath,project.environmentId||null);
      this.state.setProjectCloneJob(project.path,project.environmentId||null,{...cloneJob,status:"failed",phase:"Clone interrupted",progress:Number(cloneJob.progress)||0,error:"Clone was interrupted by a Trebell restart. Retry the clone.",completedAt:Date.now()});
    }
  }
  async shutdown(){
    const active=[...this.jobs.values()].filter(job=>ACTIVE.has(job.status));
    await Promise.all(active.map(job=>this.cancel(job.id).catch(()=>null)));
  }
}
