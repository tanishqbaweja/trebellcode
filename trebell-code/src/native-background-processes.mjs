import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildRuntimeEnvironment, runtimeEnvironmentKeys } from "./runtime-environment.mjs";
import { redactSecretText } from "./secret-redactor.mjs";

const DEFAULT_OUTPUT_BYTES=512*1024;
const MAX_OUTPUT_BYTES=2*1024*1024;

function boundedBytes(value,fallback=DEFAULT_OUTPUT_BYTES){
  const number=Math.trunc(Number(value));return Number.isFinite(number)?Math.max(1024,Math.min(MAX_OUTPUT_BYTES,number)):fallback;
}

function trimTail(text,maxBytes){
  const value=String(text||"");if(Buffer.byteLength(value,"utf8")<=maxBytes)return value;
  const bytes=Buffer.from(value,"utf8");return bytes.subarray(Math.max(0,bytes.length-maxBytes)).toString("utf8");
}

function cursorOffset(cursor){
  if(cursor==null||cursor==="")return 0;
  const match=/^native-bg-v1:(\d+)$/.exec(String(cursor));if(!match)throw Object.assign(new Error("Invalid Native background-process cursor"),{code:-32602});
  return Number(match[1]);
}

function processLabel(command,args=[]){return [String(command||""),...(args||[]).map(String)].join(" ").trim().slice(0,1000)}

export class NativeBackgroundProcessManager{
  constructor({environments=null,environment=process.env,platform=process.platform,onEvent=null,maxOutputBytes=DEFAULT_OUTPUT_BYTES}={}){
    this.environments=environments;this.environment=environment;this.platform=platform;this.onEvent=onEvent;this.maxOutputBytes=boundedBytes(maxOutputBytes);this.processes=new Map();
  }
  #public(record,{includeOutput=false}={}){
    const base={
      processId:record.id,threadId:record.threadId,command:redactSecretText(record.label,{environment:this.environment}),cwd:record.cwd,environmentId:record.environmentId||null,environmentType:record.environmentType,
      running:record.running,exitCode:record.exitCode,signal:record.signal,createdAt:record.createdAt,updatedAt:record.updatedAt,
      ...(record.remote?{}:{osPid:record.child?.pid??record.osPid??null}),
    };
    if(includeOutput){
      base.stdout=redactSecretText(record.stdout||"",{environment:this.environment});base.stderr=redactSecretText(record.stderr||"",{environment:this.environment});base.truncated=Boolean(record.truncated);
    }
    return base;
  }
  #append(record,key,chunk){
    const before=String(record[key]||""),next=before+String(chunk),limit=record.maxOutputBytes;
    if(Buffer.byteLength(next,"utf8")>limit)record.truncated=true;
    record[key]=trimTail(next,limit);record.updatedAt=Date.now();
  }
  #emit(record,name,status,data={}){try{this.onEvent?.({threadId:record.threadId,name,status,data:{processId:record.id,command:redactSecretText(record.label,{environment:this.environment}),cwd:record.cwd,environmentId:record.environmentId||null,...data,...(data.message?{message:redactSecretText(data.message,{environment:this.environment})}:{})}})}catch{}}
  start({threadId,command,args=[],cwd,environmentId=null,environmentNames=null,maxOutputBytes=null}={}){
    const executable=String(command||"").trim();if(!threadId)throw new Error("Native background process requires a thread");if(!executable)throw new Error("command is required");
    const commandArgs=Array.isArray(args)?args.map(String).slice(0,256):[],profile=environmentId&&this.environments?this.environments.get(environmentId):null,remote=Boolean(profile&&profile.type!=="local");
    const safeNames=Array.isArray(environmentNames)&&environmentNames.length?environmentNames:runtimeEnvironmentKeys("native");
    let child;
    if(profile&&this.environments){
      child=this.environments.spawnArgv(profile.id,{command:executable,args:commandArgs,cwd,stdio:["ignore","pipe","pipe"],environmentNames:safeNames,environment:profile.type==="local"?buildRuntimeEnvironment("native",{parent:this.environment,platform:this.platform}):null});
    }else{
      child=spawn(executable,commandArgs,{cwd,env:buildRuntimeEnvironment("native",{parent:this.environment,platform:this.platform}),windowsHide:true,stdio:["ignore","pipe","pipe"]});
    }
    const id=randomUUID(),record={id,threadId:String(threadId),command:executable,args:commandArgs,label:processLabel(executable,commandArgs),cwd:String(cwd||""),environmentId:profile?.id||null,environmentType:profile?.type||"local",remote,child,osPid:child.pid??null,running:true,exitCode:null,signal:null,stdout:"",stderr:"",truncated:false,maxOutputBytes:boundedBytes(maxOutputBytes,this.maxOutputBytes),createdAt:Date.now(),updatedAt:Date.now()};
    this.processes.set(id,record);child.stdout?.on("data",chunk=>this.#append(record,"stdout",chunk));child.stderr?.on("data",chunk=>this.#append(record,"stderr",chunk));
    child.once("error",error=>{record.running=false;record.stderr=trimTail(record.stderr+(record.stderr?"\n":"")+String(error?.message||error),record.maxOutputBytes);record.updatedAt=Date.now();this.#emit(record,"native.background.failed","error",{message:String(error?.message||error).slice(0,500)})});
    child.once("close",(code,signal)=>{record.running=false;record.exitCode=code==null?null:Number(code);record.signal=signal||null;record.updatedAt=Date.now();this.#emit(record,"native.background.exited","completed",{exitCode:record.exitCode,signal:record.signal})});
    this.#emit(record,"native.background.started","running",{remote});return this.#public(record,{includeOutput:true});
  }
  status(threadId,processId){
    const record=this.processes.get(String(processId||""));if(!record||record.threadId!==String(threadId||""))throw Object.assign(new Error("Native background process not found"),{code:-32002});
    return this.#public(record,{includeOutput:true});
  }
  list(threadId,{cursor=null,limit=50}={}){
    const offset=cursorOffset(cursor),pageSize=Math.max(1,Math.min(200,Number(limit)||50));
    const entries=[...this.processes.values()].filter(record=>record.threadId===String(threadId||"")&&record.running).sort((a,b)=>b.createdAt-a.createdAt),data=entries.slice(offset,offset+pageSize).map(record=>this.#public(record));
    const next=offset+data.length;return {data,nextCursor:next<entries.length?`native-bg-v1:${next}`:null};
  }
  async terminate(threadId,processId){
    const record=this.processes.get(String(processId||""));if(!record||record.threadId!==String(threadId||""))throw Object.assign(new Error("Native background process not found"),{code:-32002});
    if(!record.running)return this.#public(record,{includeOutput:true});
    const child=record.child;
    await new Promise(resolve=>{
      let settled=false,forceTimer=null,doneTimer=null;const done=()=>{if(settled)return;settled=true;if(forceTimer)clearTimeout(forceTimer);if(doneTimer)clearTimeout(doneTimer);resolve()};
      child.once("close",done);try{child.kill("SIGTERM")}catch{done();return}
      forceTimer=setTimeout(()=>{if(record.running)try{child.kill("SIGKILL")}catch{}},750);forceTimer.unref?.();
      doneTimer=setTimeout(done,2000);doneTimer.unref?.();
    });
    if(record.running)throw new Error("Native background process did not stop within 2 seconds");
    record.updatedAt=Date.now();this.#emit(record,"native.background.terminated","completed");return this.#public(record,{includeOutput:true});
  }
  async clean(threadId){
    const owned=[...this.processes.values()].filter(record=>record.threadId===String(threadId||"")&&record.running);for(const record of owned)await this.terminate(threadId,record.id).catch(()=>{});return {stopped:owned.length};
  }
  async closeAll(){
    const running=[...this.processes.values()].filter(record=>record.running);for(const record of running)await this.terminate(record.threadId,record.id).catch(()=>{});this.processes.clear();
  }
}
