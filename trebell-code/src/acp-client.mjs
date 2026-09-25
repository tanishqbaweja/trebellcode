import { EventEmitter } from "node:events";
import readline from "node:readline";
import spawn from "cross-spawn";
import { redactSecretText } from "./secret-redactor.mjs";

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

/** Lightweight ACP v1 JSON-RPC/NDJSON client used by Cursor, Grok and OpenCode. */
export class AcpClient extends EventEmitter{
  constructor({command,args=[],cwd=process.cwd(),env=process.env,onRequest=null,onStderr=null,timeoutMs=DEFAULT_TIMEOUT_MS,spawnProcess=null}={}){
    super();
    this.command=command;
    this.args=[...args];
    this.cwd=cwd;
    this.env={...env};
    this.onRequest=onRequest;
    this.onStderr=onStderr;
    this.timeoutMs=timeoutMs;
    this.spawnProcess=spawnProcess;
    this.nextId=1;
    this.pending=new Map();
    this.child=null;
    this.started=false;
    this.closed=false;
    this.stderrTail="";
    this.terminationError=null;
  }

  async start(){
    if(this.started)return this;
    if(!this.command)throw new Error("ACP command is required");
    const child=this.spawnProcess
      ?this.spawnProcess({command:this.command,args:this.args,cwd:this.cwd,env:this.env,stdio:["pipe","pipe","pipe"]})
      :spawn(this.command,this.args,{cwd:this.cwd,env:this.env,windowsHide:true,stdio:["pipe","pipe","pipe"]});
    this.child=child;
    readline.createInterface({input:child.stdout,crlfDelay:Infinity}).on("line",line=>this.#handleLine(line));
    child.stderr?.on("data",chunk=>{
      const text=String(chunk);
      this.stderrTail=appendAcpStderrTail(this.stderrTail,text);
      this.emit("stderr",text);
      try{this.onStderr?.(text)}catch{}
    });
    child.on("error",error=>this.#terminate(processError(this.command,error)));
    child.on("close",(code,signal)=>this.#terminate(processExitError(code,signal,this.stderrTail,this.env)));
    await new Promise((resolve,reject)=>{
      let settled=false;
      const done=()=>{if(settled)return;settled=true;cleanup();resolve()};
      const fail=error=>{if(settled)return;settled=true;cleanup();reject(processError(this.command,error))};
      const cleanup=()=>{child.off("spawn",done);child.off("error",fail)};
      child.once("spawn",done);
      child.once("error",fail);
    });
    this.started=true;
    if(this.closed)throw this.terminationError||new Error("ACP runtime exited during startup");
    return this;
  }

  request(method,params={},timeoutMs=this.timeoutMs){
    if(!this.child||this.closed)return Promise.reject(this.terminationError||new Error("ACP runtime is not connected"));
    const id=this.nextId++;
    this.#write({jsonrpc:"2.0",id,method,params});
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
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

  async initialize({name="trebell-code",title="Trebell Code",version="0.0.0",capabilities=null}={}){
    return this.request("initialize",{
      protocolVersion:1,
      clientInfo:{name,title,version},
      clientCapabilities:capabilities||defaultAcpClientCapabilities(),
    },30_000);
  }

  createSession({cwd=this.cwd,mcpServers=[]}={}){return this.request("session/new",{cwd,mcpServers})}
  loadSession({sessionId,cwd=this.cwd,mcpServers=[]}={}){return this.request("session/load",{sessionId,cwd,mcpServers})}
  resumeSession({sessionId,cwd=this.cwd,mcpServers=[]}={}){return this.request("session/resume",{sessionId,cwd,mcpServers})}
  listSessions(params={}){return this.request("session/list",params)}
  forkSession({sessionId,cwd=this.cwd,mcpServers=[]}={}){return this.request("session/fork",{sessionId,cwd,mcpServers})}
  closeSession(sessionId){return this.request("session/close",{sessionId})}
  setModel(sessionId,modelId){return this.request("session/set_model",{sessionId,modelId})}
  setMode(sessionId,modeId){return this.request("session/set_mode",{sessionId,modeId})}
  setConfigOption(sessionId,configId,value){return this.request("session/set_config_option",{sessionId,configId,value})}
  prompt(sessionId,prompt,{messageId=null}={}){return this.request("session/prompt",{sessionId,prompt,...(messageId?{messageId}:{})})}
  cancel(sessionId){this.notify("session/cancel",{sessionId})}
  authenticate(methodId){return this.request("authenticate",{methodId},120_000)}
  logout(){return this.request("logout",{})}

  async stop(){
    if(this.closed)return;
    this.closed=true;
    for(const [id,pending] of this.pending){clearTimeout(pending.timer);pending.reject(new Error("ACP runtime stopped"));this.pending.delete(id)}
    const child=this.child;
    if(child&&child.exitCode===null){
      try{child.kill("SIGTERM")}catch{}
      await Promise.race([
        new Promise(resolve=>child.once("exit",resolve)),
        new Promise(resolve=>setTimeout(resolve,1200)),
      ]).catch(()=>{});
      if(child.exitCode===null){
        if(process.platform==="win32"&&child.pid){
          try{spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"}).unref()}catch{}
        }else try{child.kill("SIGKILL")}catch{}
      }
    }
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
      if(message.error)pending.reject(new Error(message.error.message||JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if(message.method&&Object.prototype.hasOwnProperty.call(message,"id")){
      try{
        if(!this.onRequest)throw Object.assign(new Error(`Unsupported ACP client request: ${message.method}`),{code:-32601});
        const result=await this.onRequest(message.method,message.params||{},message);
        this.#write({jsonrpc:"2.0",id:message.id,result:result??{}});
      }catch(error){
        this.#write({jsonrpc:"2.0",id:message.id,error:{code:Number(error?.code)||-32000,message:error instanceof Error?error.message:String(error)}});
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
