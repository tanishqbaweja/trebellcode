import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import {
  environmentWorkspaceFile,
  environmentWorkspaceTree,
  environmentWorkspaceWriteFile,
  environmentWorkspacePath,
} from "./workspace.mjs";
import { buildRuntimeEnvironment, runtimeEnvironmentKeys } from "./runtime-environment.mjs";

const DEFAULT_READ_BYTES=256*1024;
const MAX_EDIT_BYTES=2*1024*1024;
const DEFAULT_OUTPUT_BYTES=512*1024;

function abortError(signal){
  const reason=signal?.reason;if(reason?.name==="AbortError")return reason;
  const error=new Error(reason instanceof Error?(reason.message||"Native tool execution was cancelled."):String(reason||"Native tool execution was cancelled."));error.name="AbortError";return error;
}

function boundedInteger(value,fallback,min,max){
  const number=Math.trunc(Number(value));return Number.isFinite(number)?Math.max(min,Math.min(max,number)):fallback;
}

function inside(base,candidate,pathApi={relative,isAbsolute,sep}){
  const rel=pathApi.relative(base,candidate);return !rel||(!rel.startsWith(".."+pathApi.sep)&&rel!==".."&&!pathApi.isAbsolute(rel));
}

async function nearestExistingLocalParent(candidate){
  let current=dirname(candidate);
  for(;;){
    try{await access(current);return current}catch{}
    const next=dirname(current);if(next===current)return current;current=next;
  }
}

async function localSafePath(root,requested,{mustExist=false}={}){
  const base=resolve(String(root||process.cwd())),candidate=resolve(base,String(requested||"."));
  if(!inside(base,candidate))throw new Error("Path is outside the active workspace");
  const realBase=await realpath(base);
  if(mustExist){
    const realCandidate=await realpath(candidate);if(!inside(realBase,realCandidate))throw new Error("Path resolves outside the active workspace");return candidate;
  }
  try{
    const realCandidate=await realpath(candidate);if(!inside(realBase,realCandidate))throw new Error("Path resolves outside the active workspace");return candidate;
  }catch(error){
    if(error?.message?.includes("outside the active workspace"))throw error;
    const existingParent=await nearestExistingLocalParent(candidate),realParent=await realpath(existingParent);
    if(!inside(realBase,realParent))throw new Error("Path resolves outside the active workspace");return candidate;
  }
}

async function remoteRealpath(environments,environmentId,path){
  const result=await environments.executeArgv(environmentId,{command:"realpath",args:[String(path)],cwd:"",timeoutMs:8000,maxOutput:64*1024,environmentNames:runtimeEnvironmentKeys("native")});
  if(result.exitCode!==0)throw new Error(result.stderr||`Could not resolve remote path: ${path}`);
  return String(result.stdout||"").trim();
}

async function nearestExistingRemoteParent(environments,environmentId,candidate,base){
  let current=posix.dirname(candidate);
  for(;;){
    const test=await environments.executeArgv(environmentId,{command:"test",args:["-e",current],cwd:"",timeoutMs:5000,maxOutput:16*1024,environmentNames:runtimeEnvironmentKeys("native")}).catch(()=>null);
    if(test?.exitCode===0)return current;
    const next=posix.dirname(current);if(next===current||!inside(base,next,posix))return base;current=next;
  }
}

async function safeWorkspacePath(root,requested,{environments=null,environmentId=null,mustExist=false}={}){
  const profile=environmentId&&environments?environments.get(environmentId):null;
  if(!profile||profile.type==="local")return {path:await localSafePath(root,requested,{mustExist}),remote:false,profile};
  const located=environmentWorkspacePath(root,requested,{environments,environmentId}),base=located.root,candidate=located.path;
  const realBase=await remoteRealpath(environments,environmentId,base);
  if(mustExist){
    const realCandidate=await remoteRealpath(environments,environmentId,candidate);if(!inside(realBase,realCandidate,posix))throw new Error("Path resolves outside the active workspace");return {path:candidate,remote:true,profile};
  }
  try{
    const realCandidate=await remoteRealpath(environments,environmentId,candidate);if(!inside(realBase,realCandidate,posix))throw new Error("Path resolves outside the active workspace");
  }catch(error){
    if(error?.message?.includes("outside the active workspace"))throw error;
    const parent=await nearestExistingRemoteParent(environments,environmentId,candidate,base),realParent=await remoteRealpath(environments,environmentId,parent);
    if(!inside(realBase,realParent,posix))throw new Error("Path resolves outside the active workspace");
  }
  return {path:candidate,remote:true,profile};
}

function captureProcess(child,{signal=null,timeoutMs=30_000,maxOutput=DEFAULT_OUTPUT_BYTES}={}){
  return new Promise((resolveCapture,reject)=>{
    let stdout="",stderr="",settled=false,timedOut=false,truncated=false,aborted=false;
    const append=(current,chunk)=>{
      const text=current+String(chunk);if(Buffer.byteLength(text,"utf8")<=maxOutput)return text;
      truncated=true;return Buffer.from(text,"utf8").subarray(0,maxOutput).toString("utf8");
    };
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener?.("abort",onAbort)};
    const finish=(error,code=null,processSignal=null)=>{if(settled)return;settled=true;cleanup();error?reject(error):resolveCapture({exitCode:code??1,signal:processSignal,stdout,stderr,timedOut,truncated})};
    const onAbort=()=>{aborted=true;try{child.kill("SIGKILL")}catch{}};
    child.stdout?.on("data",chunk=>{stdout=append(stdout,chunk)});child.stderr?.on("data",chunk=>{stderr=append(stderr,chunk)});
    child.once("error",error=>finish(aborted?abortError(signal):error));child.once("close",(code,processSignal)=>aborted?finish(abortError(signal)):finish(null,code,processSignal));
    const timer=setTimeout(()=>{timedOut=true;try{child.kill("SIGKILL")}catch{}},timeoutMs);
    if(signal?.aborted)return onAbort();signal?.addEventListener?.("abort",onAbort,{once:true});
  });
}

async function runArgv({root,environments,environmentId,environment,platform,command,args=[],cwd=".",timeoutMs=30_000,maxOutput=DEFAULT_OUTPUT_BYTES,signal=null}){
  const located=await safeWorkspacePath(root,cwd||".",{environments,environmentId,mustExist:true});
  const info=located.remote?null:await stat(located.path);if(info&&!info.isDirectory())throw new Error("Command working directory is not a directory");
  const started=Date.now(),profile=located.profile;
  let child;
  if(profile&&profile.type!=="local")child=environments.spawnArgv(profile.id,{command,args,cwd:located.path,stdio:["ignore","pipe","pipe"],environmentNames:runtimeEnvironmentKeys("native")});
  else child=spawn(command,args,{cwd:located.path,env:buildRuntimeEnvironment("native",{parent:environment,platform}),windowsHide:true,stdio:["ignore","pipe","pipe"]});
  const result=await captureProcess(child,{signal,timeoutMs,maxOutput});
  return {...result,durationMs:Date.now()-started,cwd:located.path,command,args};
}

function occurrences(text,needle){
  if(!needle)return 0;let count=0,offset=0;for(;;){const index=text.indexOf(needle,offset);if(index<0)return count;count++;offset=index+needle.length}
}

export function createNativeBuiltins({root,environments=null,environmentId=null,environment=process.env,platform=process.platform,backgroundProcesses=null,threadId=null,environmentNames=null}={}){
  if(!root)throw new Error("Native built-in tools require an active workspace root");
  return async function execute(call={}){
    const namespace=String(call.namespace||""),name=String(call.name||""),args=call.arguments&&typeof call.arguments==="object"?call.arguments:{};
    if(namespace==="trebell_workspace"){
      if(name==="list"){
        const located=await safeWorkspacePath(root,args.path||".",{environments,environmentId,mustExist:true});
        return await environmentWorkspaceTree(located.path,{depth:boundedInteger(args.depth,3,1,8),limit:boundedInteger(args.limit,500,1,1000),environments,environmentId});
      }
      if(name==="read_file"){
        const located=await safeWorkspacePath(root,args.path,{environments,environmentId,mustExist:true});
        return await environmentWorkspaceFile(located.path,boundedInteger(args.max_bytes,DEFAULT_READ_BYTES,1,1024*1024),{root,environments,environmentId});
      }
      if(name==="write_file"){
        const content=String(args.content??"");if(Buffer.byteLength(content,"utf8")>MAX_EDIT_BYTES)throw new Error("File content exceeds the 2 MB Native edit limit");
        const located=await safeWorkspacePath(root,args.path,{environments,environmentId,mustExist:false});
        const written=await environmentWorkspaceWriteFile(located.path,content,{root,environments,environmentId});return {path:written.path,size:written.size,createdOrReplaced:true};
      }
      if(name==="replace_text"){
        const oldText=String(args.old_text??"");if(!oldText)throw new Error("old_text must not be empty");
        const located=await safeWorkspacePath(root,args.path,{environments,environmentId,mustExist:true});
        const file=await environmentWorkspaceFile(located.path,MAX_EDIT_BYTES,{root,environments,environmentId}),expected=boundedInteger(args.expected_replacements,1,1,100),count=occurrences(file.content,oldText);
        if(count!==expected)throw new Error(`Expected ${expected} exact replacement${expected===1?"":"s"} in ${args.path}, found ${count}. No changes were written.`);
        const next=file.content.split(oldText).join(String(args.new_text??""));if(Buffer.byteLength(next,"utf8")>MAX_EDIT_BYTES)throw new Error("Edited file exceeds the 2 MB Native edit limit");
        const written=await environmentWorkspaceWriteFile(located.path,next,{root,environments,environmentId});return {path:written.path,size:written.size,replacements:count};
      }
      throw new Error(`Unknown Native workspace tool: ${name}`);
    }
    if(namespace==="trebell_terminal"){
      if(name==="run"){
        const command=String(args.command||"").trim();if(!command)throw new Error("command is required");
        const commandArgs=Array.isArray(args.args)?args.args.map(value=>String(value)).slice(0,256):[];
        return await runArgv({root,environments,environmentId,environment,platform,command,args:commandArgs,cwd:String(args.cwd||"."),timeoutMs:boundedInteger(args.timeout_ms,30_000,1000,300_000),maxOutput:boundedInteger(args.max_output_bytes,DEFAULT_OUTPUT_BYTES,1024,2*1024*1024),signal:call.signal||null});
      }
      if(name==="start_background"){
        if(!backgroundProcesses||!threadId)throw new Error("Native background processes are unavailable");
        const command=String(args.command||"").trim();if(!command)throw new Error("command is required");
        const commandArgs=Array.isArray(args.args)?args.args.map(value=>String(value)).slice(0,256):[],located=await safeWorkspacePath(root,String(args.cwd||"."),{environments,environmentId,mustExist:true});
        const info=located.remote?null:await stat(located.path);if(info&&!info.isDirectory())throw new Error("Command working directory is not a directory");
        return backgroundProcesses.start({threadId,command,args:commandArgs,cwd:located.path,environmentId,maxOutputBytes:boundedInteger(args.max_output_bytes,DEFAULT_OUTPUT_BYTES,1024,2*1024*1024),environmentNames});
      }
      if(name==="background_status"){
        if(!backgroundProcesses||!threadId)throw new Error("Native background processes are unavailable");return backgroundProcesses.status(threadId,String(args.process_id||""));
      }
      if(name==="stop_background"){
        if(!backgroundProcesses||!threadId)throw new Error("Native background processes are unavailable");return await backgroundProcesses.terminate(threadId,String(args.process_id||""));
      }
      throw new Error(`Unknown Native terminal tool: ${name}`);
    }
    throw new Error(`Native built-in executor does not own ${namespace}/${name}`);
  };
}
