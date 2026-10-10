import { EventEmitter } from "node:events";
import readline from "node:readline";
import spawn from "cross-spawn";
import { redactSecretText } from "./secret-redactor.mjs";
import { createRunTemp } from "./acp-runtime-temp.mjs";

const DEFAULT_TIMEOUT_MS=180_000;
export const ACP_STDERR_TAIL_MAX_CHARS=4096;

export function appendAcpStderrTail(current,chunk){
  const next=String(current||"")+String(chunk||"");
  return next.length<=ACP_STDERR_TAIL_MAX_CHARS?next:next.slice(-ACP_STDERR_TAIL_MAX_CHARS);
}

export function sanitizeAcpStderrExcerpt(text,environment=process.env){
  return redactSecretText(text,{environment,redactHomes:true,trim:true});
}

function processError(command,error){
  const detail=error instanceof Error?error.message:String(error);
  return new Error(`Could not start ACP runtime '${command}': ${detail}`);
}
function processExitError(code,signal,stderr,environment){
  const base=`ACP runtime exited code=${code} signal=${signal}`;
  const detail=sanitizeAcpStderrExcerpt(stderr,environment);
  return new Error(detail?base+"\n"+detail:base);
}

// A JSON-RPC error keeps its code and data. Agents put the useful text in data.message (or in
// data itself) and a generic "Internal error" in message, so the detail wins.
export function acpRequestError(error){
  const data=error?.data;
  const message=(data&&typeof data==="object"&&typeof data.message==="string"&&data.message.trim())
    ||(typeof data==="string"&&data.trim())
    ||String(error?.message||"").trim()
    ||JSON.stringify(error);
  return Object.assign(new Error(message),{code:error?.code,...(data!==undefined?{data}:{})});
}

function directoriesParam(list){
  const directories=(Array.isArray(list)?list:[]).map(item=>String(item||"").trim()).filter(Boolean);
  return directories.length?{additionalDirectories:directories}:{};
}

export function defaultAcpClientCapabilities(){
  return {
    fs:{readTextFile:true,writeTextFile:true},
    terminal:true,
    auth:{terminal:true},
    plan:{},
    session:{compaction:{}},
    elicitation:{form:{},url:{}},
  };
}

/** Lightweight ACP v1 JSON-RPC/NDJSON client used by Cursor, Grok, Antigravity and OpenCode. */
export class AcpClient extends EventEmitter{
  // runTempRoot: start the process with TEMP/TMP (TMPDIR) pointing at its own folder under this
  // root and delete the folder once the process is gone (Antigravity's PyInstaller unpack).
  constructor({command,args=[],cwd=process.cwd(),env=process.env,onRequest=null,onStderr=null,timeoutMs=DEFAULT_TIMEOUT_MS,spawnProcess=null,runTempRoot=null}={}){
    super();
    this.command=command;
    this.args=[...args];
    this.cwd=cwd;
    this.env={...env};
    this.onRequest=onRequest;
    this.onStderr=onStderr;
    this.timeoutMs=timeoutMs;
    this.spawnProcess=spawnProcess;
    this.runTempRoot=runTempRoot;
    this.runTemp=null;
    this.runTempRemoval=null;
    this.nextId=1;
    this.pending=new Map();
    this.child=null;
    this.stdoutReader=null;
    this.started=false;
    this.closed=false;
    this.stderrTail="";
    this.terminationError=null;
  }

  async start(){
    if(this.started)return this;
    if(!this.command)throw new Error("ACP command is required");
    if(this.runTempRoot&&!this.runTemp){
      this.runTemp=await createRunTemp(this.runTempRoot);
      Object.assign(this.env,this.runTemp.env);
    }
    let child;
    try{
      child=this.spawnProcess
        ?this.spawnProcess({command:this.command,args:this.args,cwd:this.cwd,env:this.env,stdio:["pipe","pipe","pipe"]})
        :spawn(this.command,this.args,{cwd:this.cwd,env:this.env,windowsHide:true,stdio:["pipe","pipe","pipe"]});
    }catch(error){await this.#removeRunTemp();throw processError(this.command,error)}
    this.child=child;
    this.stdoutReader=readline.createInterface({input:child.stdout,crlfDelay:Infinity});
    this.stdoutReader.on("line",line=>this.#handleLine(line));
    child.stderr?.on("data",chunk=>{
      const text=String(chunk);
      this.stderrTail=appendAcpStderrTail(this.stderrTail,text);
      this.emit("stderr",text);
      try{this.onStderr?.(text)}catch{}
    });
    child.on("error",error=>this.#terminate(processError(this.command,error)));
    child.on("close",(code,signal)=>{this.#terminate(processExitError(code,signal,this.stderrTail,this.env));void this.#removeRunTemp()});
    await new Promise((resolve,reject)=>{
      let settled=false;
      const done=()=>{if(settled)return;settled=true;cleanup();resolve()};
      const fail=error=>{if(settled)return;settled=true;cleanup();reject(processError(this.command,error))};
      const cleanup=()=>{child.off("spawn",done);child.off("error",fail)};
      child.once("spawn",done);
      child.once("error",fail);
    }).catch(async error=>{await this.#removeRunTemp();throw error});
    this.started=true;
    if(this.closed)throw this.terminationError||new Error("ACP runtime exited during startup");
    return this;
  }

  // timeoutMs Infinity arms no timer: a prompt runs until the agent answers, the user cancels
  // or the process exits (T3 runs session/prompt with no timeout).
  request(method,params={},timeoutMs=this.timeoutMs){
    if(!this.child||this.closed)return Promise.reject(this.terminationError||new Error("ACP runtime is not connected"));
    const id=this.nextId++;
    this.#write({jsonrpc:"2.0",id,method,params});
    return new Promise((resolve,reject)=>{
      const timer=timeoutMs===Infinity?null:setTimeout(()=>{
        if(!this.pending.delete(id))return;
        reject(new Error(`${method} timed out`));
      },Math.max(1000,Number(timeoutMs)||this.timeoutMs));
      this.pending.set(id,{resolve,reject,timer,method});
    });
  }

  notify(method,params={}){
    if(!this.child||this.closed)return;
    this.#write({jsonrpc:"2.0",method,params});
  }

  async initialize({name="trebell-code",title="Trebell Code",version="0.0.0",capabilities=null,meta=null,timeoutMs=30_000}={}){
    return this.request("initialize",{
      protocolVersion:1,
      clientInfo:{name,title,version},
      clientCapabilities:capabilities||defaultAcpClientCapabilities(),
      ...(meta?{_meta:meta}:{}),
    },timeoutMs);
  }

  // additionalDirectories (ACP) grants the agent folders beyond cwd; T3 sends it on new, load and resume alike.
  createSession({cwd=this.cwd,mcpServers=[],additionalDirectories=[]}={}){return this.request("session/new",{cwd,mcpServers,...directoriesParam(additionalDirectories)})}
  loadSession({sessionId,cwd=this.cwd,mcpServers=[],additionalDirectories=[],timeoutMs=90_000}={}){return this.request("session/load",{sessionId,cwd,...directoriesParam(additionalDirectories),mcpServers},timeoutMs)}
  resumeSession({sessionId,cwd=this.cwd,mcpServers=[],additionalDirectories=[],timeoutMs=90_000}={}){return this.request("session/resume",{sessionId,cwd,...directoriesParam(additionalDirectories),mcpServers},timeoutMs)}
  listSessions(params={}){return this.request("session/list",params)}
  forkSession({sessionId,cwd=this.cwd,mcpServers=[]}={}){return this.request("session/fork",{sessionId,cwd,mcpServers})}
  closeSession(sessionId,{timeoutMs=5000}={}){return this.request("session/close",{sessionId},timeoutMs)}
  setModel(sessionId,modelId,meta=null){return this.request("session/set_model",{sessionId,modelId,...(meta?{_meta:meta}:{})})}
  setMode(sessionId,modeId){return this.request("session/set_mode",{sessionId,modeId})}
  setConfigOption(sessionId,configId,value){return this.request("session/set_config_option",{sessionId,configId,value})}
  prompt(sessionId,prompt,{messageId=null,meta=null}={}){return this.request("session/prompt",{sessionId,prompt,...(messageId?{messageId}:{}),...(meta?{_meta:meta}:{})},Infinity)}
  cancel(sessionId,meta=null){this.notify("session/cancel",{sessionId,...(meta?{_meta:meta}:{})})}
  authenticate(methodId){return this.request("authenticate",{methodId},120_000)}
  logout(){return this.request("logout",{})}

  async stop(){
    if(this.closed&&!this.child){await this.#removeRunTemp();return}
    this.closed=true;
    for(const [id,pending] of this.pending){clearTimeout(pending.timer);pending.reject(new Error("ACP runtime stopped"));this.pending.delete(id)}
    const child=this.child;
    if(child&&child.exitCode===null){
      if(process.platform==="win32"&&child.pid){
        // Kill the whole Windows process tree while the launcher PID is still
        // alive. Killing only the launcher first can orphan helper processes.
        await new Promise(resolve=>{
          let settled=false;const done=()=>{if(settled)return;settled=true;resolve()};
          try{const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.once("exit",done);killer.once("error",done);setTimeout(done,3000).unref?.()}catch{done()}
        });
      }else{
        try{child.kill("SIGTERM")}catch{}
        await Promise.race([new Promise(resolve=>child.once("exit",resolve)),new Promise(resolve=>setTimeout(resolve,1200))]).catch(()=>{});
        if(child.exitCode===null)try{child.kill("SIGKILL")}catch{}
      }
    }
    try{this.stdoutReader?.close()}catch{}this.stdoutReader=null;
    try{child?.stdin?.destroy()}catch{}try{child?.stdout?.destroy()}catch{}try{child?.stderr?.destroy()}catch{}
    this.child=null;
    await this.#removeRunTemp();
  }

  // Removes the run folder once. The exit handler often starts the removal while the killed tree still holds its files;
  // stop() then waits for that same removal, so a stopped client has left nothing behind.
  #removeRunTemp(){
    if(this.runTemp){const runTemp=this.runTemp;this.runTemp=null;this.runTempRemoval=runTemp.remove()}
    return this.runTempRemoval||Promise.resolve();
  }

  #write(message){
    if(!this.child?.stdin?.writable)throw new Error("ACP runtime stdin is unavailable");
    this.child.stdin.write(JSON.stringify(message)+"\n");
  }

  async #handleLine(line){
    const raw=String(line||"").trim();
    if(!raw)return;
    let message;
    try{message=JSON.parse(raw)}catch{
      this.emit("protocolWarning",{message:"ACP stdout contained non-JSON output",raw:raw.slice(0,4000)});
      return;
    }
    if(Object.prototype.hasOwnProperty.call(message,"id")&&!message.method){
      const pending=this.pending.get(message.id);
      if(!pending)return;
      this.pending.delete(message.id);clearTimeout(pending.timer);
      if(message.error)pending.reject(acpRequestError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if(message.method&&Object.prototype.hasOwnProperty.call(message,"id")){
      try{
        if(!this.onRequest)throw Object.assign(new Error(`Unsupported ACP client request: ${message.method}`),{code:-32601});
        const result=await this.onRequest(message.method,message.params||{},message);
        this.#write({jsonrpc:"2.0",id:message.id,result:result??{}});
      }catch(error){
        try{this.#write({jsonrpc:"2.0",id:message.id,error:{code:Number(error?.code)||-32000,message:error instanceof Error?error.message:String(error)}})}catch{}
      }
      return;
    }
    if(message.method){
      this.emit("notification",{method:message.method,params:message.params||{}});
      if(message.method==="session/update")this.emit("sessionUpdate",message.params||{});
    }
  }

  #terminate(error){
    if(this.closed)return;
    this.terminationError=error;
    this.closed=true;
    for(const [id,pending] of this.pending){clearTimeout(pending.timer);pending.reject(error);this.pending.delete(id)}
    this.emit("terminated",error);
  }
}
