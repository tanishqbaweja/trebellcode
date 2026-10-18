import { spawn } from "node:child_process";
import crossSpawn from "cross-spawn";
import { randomUUID } from "node:crypto";
import { buildRuntimeEnvironment, runtimeEnvironmentKeys } from "./runtime-environment.mjs";
import { redactSecretText } from "./secret-redactor.mjs";

const DEFAULT_OUTPUT_BYTES=512*1024;
const MAX_OUTPUT_BYTES=2*1024*1024;
const STOP_BOUND_MS=10_000;
// A status call may wait this long at most for its process to end.
export const MAX_PROCESS_WAIT_MS=60_000;

function boundedBytes(value,fallback=DEFAULT_OUTPUT_BYTES){
  const number=Math.trunc(Number(value));return Number.isFinite(number)?Math.max(1024,Math.min(MAX_OUTPUT_BYTES,number)):fallback;
}

// The end of text, at most maxBytes long. A cut inside a multi-byte character drops the rest of that character instead of
// leaving a replacement character, so the kept text is exactly the last bytes written and its offsets stay exact.
function trimTail(text,maxBytes){
  const value=String(text||"");if(Buffer.byteLength(value,"utf8")<=maxBytes)return value;
  const bytes=Buffer.from(value,"utf8");let from=Math.max(0,bytes.length-maxBytes);
  while(from<bytes.length&&(bytes[from]&0xc0)===0x80)from++;
  return bytes.subarray(from).toString("utf8");
}

function cursorOffset(cursor){
  if(cursor==null||cursor==="")return 0;
  const match=/^native-bg-v1:(\d+)$/.exec(String(cursor));if(!match)throw Object.assign(new Error("Invalid Native background-process cursor"),{code:-32602});
  return Number(match[1]);
}

function processLabel(command,args=[]){return [String(command||""),...(args||[]).map(String)].join(" ").trim().slice(0,1000)}

function abortError(signal){
  const reason=signal?.reason;if(reason?.name==="AbortError")return reason;
  const error=new Error(reason instanceof Error?(reason.message||"Native process wait was cancelled."):String(reason||"Native process wait was cancelled."));error.name="AbortError";return error;
}

// The one drain process releaseAll starts: it reads every pipe it inherited (fds 3 and up, as many as its argument says) until
// the process writing to it closes it, and keeps nothing.
const DRAIN_SCRIPT="const net=require('node:net');const count=Number(process.argv[1])||0;for(let fd=3;fd<3+count;fd++){try{const pipe=new net.Socket({fd,readable:true,writable:false});pipe.on('error',()=>{});pipe.resume()}catch{}}";

const PROCESS_TOOLS=Object.freeze({trebell_process:new Set(["start","status","stop","list"]),trebell_terminal:new Set(["start_background","background_status","stop_background"])});
const HANDLE_FIELD=/"(?:handle|process_id)"\s*:\s*"p(\d{1,9})"/gi;

// The highest short handle (pN) a thread's history names in its process tool calls and results, or 0. A thread outlives the
// app, while its processes and the manager's counters do not, so a new manager starts the thread's handles above it.
export function highestProcessHandle(thread={}){
  let highest=0;
  for(const turn of Array.isArray(thread?.turns)?thread.turns:[]){
    for(const item of Array.isArray(turn?.items)?turn.items:[]){
      if(item?.type!=="dynamicToolCall"||!PROCESS_TOOLS[String(item.namespace||"")]?.has(String(item.tool||"")))continue;
      for(const value of [item.arguments,item.rawOutput,...(Array.isArray(item.contentItems)?item.contentItems.map(part=>part?.text):[])]){
        if(value==null)continue;
        let text;try{text=typeof value==="string"?value:JSON.stringify(value)}catch{continue}
        for(const match of String(text).matchAll(HANDLE_FIELD))highest=Math.max(highest,Number(match[1]));
      }
    }
  }
  return highest;
}

function signalLocalProcessTree(child,{platform=process.platform,force=false}={}){
  const pid=Number(child?.pid);if(!Number.isInteger(pid)||pid<=0){try{child?.kill?.(force?"SIGKILL":"SIGTERM")}catch{};return}
  if(platform==="win32"){
    try{
      const args=["/pid",String(pid),"/t",...(force?["/f"]:[])],killer=spawn("taskkill",args,{windowsHide:true,stdio:"ignore"});
      killer.once("error",()=>{try{child?.kill?.(force?"SIGKILL":"SIGTERM")}catch{}});killer.unref?.();return;
    }catch{}
  }else{
    try{process.kill(-pid,force?"SIGKILL":"SIGTERM");return}catch{}
  }
  try{child?.kill?.(force?"SIGKILL":"SIGTERM")}catch{}
}

export class NativeBackgroundProcessManager{
  constructor({environments=null,environment=process.env,platform=process.platform,onEvent=null,maxOutputBytes=DEFAULT_OUTPUT_BYTES}={}){
    this.environments=environments;this.environment=environment;this.platform=platform;this.onEvent=onEvent;this.maxOutputBytes=boundedBytes(maxOutputBytes);this.processes=new Map();
    // Short handles (p1, p2, ...) count per thread and are never reused, so a handle the model kept never names a later process.
    // A thread restored after a restart reserves the handles its history already names (reserveHandles), so they stay unused.
    this.handleCounts=new Map();this.handles=new Map();
  }
  #nextHandle(threadId){const next=(this.handleCounts.get(threadId)||0)+1;this.handleCounts.set(threadId,next);return "p"+next}
  // Raises a thread's handle count to at least `used`: the next process it starts gets p(used+1) or later.
  reserveHandles(threadId,used=0){
    const thread=String(threadId||""),count=Math.max(0,Math.trunc(Number(used)||0));if(!thread)return;
    if(count>(this.handleCounts.get(thread)||0))this.handleCounts.set(thread,count);
  }
  // A process by its full id or by its short handle, within one thread.
  #record(threadId,processId){
    const thread=String(threadId||""),key=String(processId||"").trim();
    const record=this.processes.get(key)||this.processes.get(this.handles.get(thread+"\u0000"+key.toLowerCase())||"");
    if(!record||record.threadId!==thread)throw Object.assign(new Error("Native background process not found"),{code:-32002});
    return record;
  }
  #public(record,{includeOutput=false}={}){
    const base={
      processId:record.id,handle:record.handle,threadId:record.threadId,command:redactSecretText(record.label,{environment:this.environment}),cwd:record.cwd,environmentId:record.environmentId||null,environmentType:record.environmentType,
      running:record.running,exitCode:record.exitCode,signal:record.signal,createdAt:record.createdAt,updatedAt:record.updatedAt,
      ...(record.remote?{}:{osPid:record.child?.pid??record.osPid??null}),
    };
    if(includeOutput){
      // Where each stream's retained text sits in everything the process wrote to it: absolute UTF-8 byte offsets, counted
      // before redaction. They come before the text so a capped audit record still has them.
      const stdout=redactSecretText(record.stdout||"",{environment:this.environment}),stderr=redactSecretText(record.stderr||"",{environment:this.environment});
      base.outputOffsets={stdout:this.#offsets(record,"stdout",stdout),stderr:this.#offsets(record,"stderr",stderr)};
      base.stdout=stdout;base.stderr=stderr;base.truncated=Boolean(record.truncated);
    }
    return base;
  }
  // redacted: redaction changed the stream's text, so offsets into what the process wrote no longer point into the text shown.
  #offsets(record,key,shown){
    const text=String(record[key]||""),end=record.written[key];
    return {start:end-Buffer.byteLength(text,"utf8"),end,...(shown===text?{}:{redacted:true})};
  }
  #append(record,key,chunk){
    const text=String(chunk),before=String(record[key]||""),next=before+text,limit=record.maxOutputBytes;
    record.written[key]+=Buffer.byteLength(text,"utf8");
    if(Buffer.byteLength(next,"utf8")>limit)record.truncated=true;
    record[key]=trimTail(next,limit);record.updatedAt=Date.now();
  }
  // Ends every wait on this process (it has exited or failed).
  #settle(record){const waiters=[...record.waiters];record.waiters.clear();for(const resolve of waiters)resolve()}
  #emit(record,name,status,data={}){try{this.onEvent?.({threadId:record.threadId,name,status,data:{processId:record.id,command:redactSecretText(record.label,{environment:this.environment}),cwd:record.cwd,environmentId:record.environmentId||null,...data,...(data.message?{message:redactSecretText(data.message,{environment:this.environment})}:{})}})}catch{}}
  start({threadId,command,args=[],cwd,environmentId=null,environmentNames=null,maxOutputBytes=null}={}){
    const executable=String(command||"").trim();if(!threadId)throw new Error("Native background process requires a thread");if(!executable)throw new Error("command is required");
    const commandArgs=Array.isArray(args)?args.map(String).slice(0,256):[],profile=environmentId&&this.environments?this.environments.get(environmentId):null,remote=Boolean(profile&&profile.type!=="local");
    const safeNames=Array.isArray(environmentNames)&&environmentNames.length?environmentNames:runtimeEnvironmentKeys("native");
    let child;
    if(profile&&this.environments){
      child=this.environments.spawnArgv(profile.id,{command:executable,args:commandArgs,cwd,stdio:["ignore","pipe","pipe"],environmentNames:safeNames,environment:profile.type==="local"?buildRuntimeEnvironment("native",{parent:this.environment,platform:this.platform}):null,detached:profile.type==="local"&&this.platform!=="win32"});
    }else{
      // cross-spawn runs Windows .cmd/.bat launchers (npm, npx, yarn, pnpm) through cmd.exe with escaped arguments, as the
      // harness launchers do; on other platforms it is child_process.spawn.
      child=crossSpawn(executable,commandArgs,{cwd,env:buildRuntimeEnvironment("native",{parent:this.environment,platform:this.platform}),windowsHide:true,stdio:["ignore","pipe","pipe"],detached:this.platform!=="win32"});
    }
    const id=randomUUID(),handle=this.#nextHandle(String(threadId)),record={id,handle,threadId:String(threadId),command:executable,args:commandArgs,label:processLabel(executable,commandArgs),cwd:String(cwd||""),environmentId:profile?.id||null,environmentType:profile?.type||"local",remote,child,osPid:child.pid??null,running:true,exitCode:null,signal:null,stdout:"",stderr:"",written:{stdout:0,stderr:0},truncated:false,maxOutputBytes:boundedBytes(maxOutputBytes,this.maxOutputBytes),createdAt:Date.now(),updatedAt:Date.now(),waiters:new Set()};
    this.processes.set(id,record);this.handles.set(record.threadId+"\u0000"+handle,id);child.stdout?.on("data",chunk=>this.#append(record,"stdout",chunk));child.stderr?.on("data",chunk=>this.#append(record,"stderr",chunk));
    child.once("error",error=>{const text=(record.stderr?"\n":"")+String(error?.message||error);record.running=false;record.written.stderr+=Buffer.byteLength(text,"utf8");record.stderr=trimTail(record.stderr+text,record.maxOutputBytes);record.updatedAt=Date.now();this.#settle(record);this.#emit(record,"native.background.failed","error",{message:String(error?.message||error).slice(0,500)})});
    child.once("close",(code,signal)=>{record.running=false;record.exitCode=code==null?null:Number(code);record.signal=signal||null;record.updatedAt=Date.now();this.#settle(record);this.#emit(record,"native.background.exited","completed",{exitCode:record.exitCode,signal:record.signal})});
    this.#emit(record,"native.background.started","running",{remote});return this.#public(record,{includeOutput:true});
  }
  status(threadId,processId){
    return this.#public(this.#record(threadId,processId),{includeOutput:true});
  }
  // Waits until the process ends or waitMs (at most MAX_PROCESS_WAIT_MS) passes, whichever is first. New output does not end
  // the wait. An aborted signal ends it with an AbortError; an aborted wake signal (the person steered the turn) ends it as
  // the time passing would.
  async waitForExit(threadId,processId,{waitMs=0,signal=null,wake=null}={}){
    const record=this.#record(threadId,processId),limit=Math.max(0,Math.min(MAX_PROCESS_WAIT_MS,Math.trunc(Number(waitMs))||0));
    if(signal?.aborted)throw abortError(signal);
    if(!record.running||limit<=0||wake?.aborted)return;
    await new Promise((resolve,reject)=>{
      let timer=null;
      const finish=error=>{clearTimeout(timer);record.waiters.delete(done);signal?.removeEventListener?.("abort",onAbort);wake?.removeEventListener?.("abort",done);error?reject(error):resolve()};
      const done=()=>finish(null),onAbort=()=>finish(abortError(signal));
      record.waiters.add(done);timer=setTimeout(done,limit);
      signal?.addEventListener?.("abort",onAbort,{once:true});
      wake?.addEventListener?.("abort",done,{once:true});
    });
  }
  list(threadId,{cursor=null,limit=50}={}){
    const offset=cursorOffset(cursor),pageSize=Math.max(1,Math.min(200,Number(limit)||50));
    const entries=[...this.processes.values()].filter(record=>record.threadId===String(threadId||"")&&record.running).sort((a,b)=>b.createdAt-a.createdAt),data=entries.slice(offset,offset+pageSize).map(record=>this.#public(record));
    const next=offset+data.length;return {data,nextCursor:next<entries.length?`native-bg-v1:${next}`:null};
  }
  async terminate(threadId,processId){
    const record=this.#record(threadId,processId);
    if(!record.running)return this.#public(record,{includeOutput:true});
    const child=record.child;
    await new Promise(resolve=>{
      let settled=false,forceTimer=null,doneTimer=null;const done=()=>{if(settled)return;settled=true;if(forceTimer)clearTimeout(forceTimer);if(doneTimer)clearTimeout(doneTimer);resolve()};
      child.once("close",done);
      if(record.remote){try{child.kill("SIGTERM")}catch{done();return}}
      else signalLocalProcessTree(child,{platform:this.platform,force:false});
      forceTimer=setTimeout(()=>{if(!record.running)return;if(record.remote){try{child.kill("SIGKILL")}catch{}}else signalLocalProcessTree(child,{platform:this.platform,force:true})},750);forceTimer.unref?.();
      // A stop returns as soon as the process closes. The bound is for one that never does: on a loaded Windows host, taskkill took
      // 1.2-2.6 s to close a plain node child (2026-10-15), and the old 2 s bound called 3 of 8 stops failed that then closed.
      doneTimer=setTimeout(done,STOP_BOUND_MS);doneTimer.unref?.();
    });
    if(record.running)throw new Error(`Native background process did not stop within ${STOP_BOUND_MS/1000} seconds`);
    record.updatedAt=Date.now();this.#emit(record,"native.background.terminated","completed");return this.#public(record,{includeOutput:true});
  }
  async clean(threadId){
    const owned=[...this.processes.values()].filter(record=>record.threadId===String(threadId||"")&&record.running);for(const record of owned)await this.terminate(threadId,record.id).catch(()=>{});return {stopped:owned.length};
  }
  async closeAll(){
    const running=[...this.processes.values()].filter(record=>record.running);for(const record of running)await this.terminate(record.threadId,record.id).catch(()=>{});this.processes.clear();this.handles.clear();this.handleCounts.clear();
  }
  // For a run that ends on its own (the headless runner): lets this process exit and leaves every local process it started
  // running, as the app leaves them when a turn ends. The run's end is not a request to stop the server, watcher or daemon the
  // agent left up. Their output pipes pass to one detached Node process that reads them until they close, so a process that
  // writes after this one has exited gets no EPIPE or SIGPIPE. Remote processes, and on Windows every process, are stopped as
  // closeAll stops them. Returns the processes left running.
  async releaseAll({execPath=process.execPath}={}){
    const running=[...this.processes.values()].filter(record=>record.running);
    const kept=this.platform==="win32"?[]:running.filter(record=>!record.remote&&record.child);
    for(const record of running)if(!kept.includes(record))await this.terminate(record.threadId,record.id).catch(()=>{});
    const pipes=kept.flatMap(record=>[record.child.stdout,record.child.stderr]).filter(pipe=>pipe&&!pipe.destroyed);
    if(pipes.length){
      // A drain that cannot start leaves the processes running anyway: a write to a closed pipe may fail, which still beats a stop.
      try{const drain=spawn(execPath,["-e",DRAIN_SCRIPT,String(pipes.length)],{stdio:["ignore","ignore","ignore",...pipes],detached:true,windowsHide:true,env:{}});drain.once("error",()=>{});drain.unref()}catch{}
    }
    const released=kept.map(record=>{
      for(const pipe of [record.child.stdout,record.child.stderr])pipe?.destroy();
      record.child.unref?.();record.updatedAt=Date.now();this.#settle(record);
      this.#emit(record,"native.background.released","completed",{osPid:record.child.pid??record.osPid??null});return this.#public(record);
    });
    this.processes.clear();this.handles.clear();this.handleCounts.clear();
    return released;
  }
}
