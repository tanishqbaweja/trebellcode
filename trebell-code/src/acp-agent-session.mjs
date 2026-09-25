import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, posix } from "node:path";
import { AcpClient } from "./acp-client.mjs";

function inside(root,candidate){
  const rel=relative(resolve(root),resolve(candidate));
  return rel===""||(!rel.startsWith("..")&&!isAbsolute(rel));
}

function boundedPath(root,path){
  const candidate=resolve(path);
  if(!inside(root,candidate))throw Object.assign(new Error(`Path is outside the active workspace: ${path}`),{code:-32602});
  return candidate;
}

function permissionChoice(options=[],mode="supervised"){
  const find=kind=>options.find(option=>option.kind===kind)?.optionId;
  if(mode==="full"||mode==="auto")return find("allow_always")||find("allow_once")||options[0]?.optionId||null;
  if(mode==="edits")return find("allow_once")||find("allow_always")||options[0]?.optionId||null;
  if(mode==="read-only")return find("reject_always")||find("reject_once")||options.at(-1)?.optionId||null;
  return null;
}
function decisionChoice(options=[],decision="decline"){
  const find=kind=>options.find(option=>option.kind===kind)?.optionId;
  if(decision==="acceptForSession")return find("allow_always")||find("allow_once")||null;
  if(decision==="accept")return find("allow_once")||find("allow_always")||null;
  return find("reject_once")||find("reject_always")||null;
}

export class AcpAgentSession{
  constructor({runtime,command,args=[],cwd,env=process.env,terminals,permissionMode="supervised",onUpdate,onPermission,onElicitation,version="0.0.0",spawnProcess=null,remoteIo=null,mcpServers=[]}={}){
    this.runtime=runtime;this.command=command;this.args=args;this.cwd=remoteIo?String(cwd||remoteIo.root||"/"):resolve(cwd||process.cwd());this.env=env;this.terminals=terminals;
    this.permissionMode=permissionMode;this.onUpdate=onUpdate;this.onPermission=onPermission;this.onElicitation=onElicitation;this.version=version;
    this.spawnProcess=spawnProcess;this.remoteIo=remoteIo;
    this.mcpServers=Array.isArray(mcpServers)?mcpServers.map(server=>({...server,args:[...(server.args||[])],env:(server.env||[]).map(item=>({...item}))})):[];
    this.client=null;this.sessionId=null;this.initializeResult=null;this.sessionSetup=null;this.terminalIds=new Set();
    this.remoteTerminals=new Map();
  }

  async start({providerSessionId=null,model=null}={}){
    const client=new AcpClient({command:this.command,args:this.args,cwd:this.cwd,env:this.env,spawnProcess:this.spawnProcess,onRequest:(method,params)=>this.#clientRequest(method,params)});
    this.client=client;
    client.on("sessionUpdate",params=>this.onUpdate?.(params));
    client.on("notification",message=>{
      if(message?.method==="elicitation/complete")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"elicitation_complete",elicitationId:message.params?.elicitationId||null}});
    });
    client.on("protocolWarning",warning=>this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"protocol_warning",...warning}}));
    client.on("terminated",error=>this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:error.message}}));
    await client.start();
    this.initializeResult=await client.initialize({version:this.version});
    let setup;
    if(providerSessionId){
      const caps=this.initializeResult?.agentCapabilities?.sessionCapabilities||{};
      if(caps.resume!=null) setup=await client.resumeSession({sessionId:providerSessionId,cwd:this.cwd,mcpServers:this.mcpServers}).catch(()=>null);
      if(!setup&&this.initializeResult?.agentCapabilities?.loadSession)setup=await client.loadSession({sessionId:providerSessionId,cwd:this.cwd,mcpServers:this.mcpServers}).catch(()=>null);
    }
    if(!setup)setup=await client.createSession({cwd:this.cwd,mcpServers:this.mcpServers});
    this.sessionSetup=setup;this.sessionId=setup.sessionId;
    if(model&&setup.models?.availableModels?.some(item=>item.modelId===model)&&setup.models.currentModelId!==model){
      await client.setModel(this.sessionId,model).catch(()=>{});
    }
    return {initialize:this.initializeResult,session:setup};
  }

  async prompt(content,{messageId=null}={}){
    if(!this.client||!this.sessionId)throw new Error("ACP session is not started");
    return this.client.prompt(this.sessionId,content,{messageId});
  }
  cancel(){if(this.client&&this.sessionId)this.client.cancel(this.sessionId)}
  async setModel(model){return this.client?.setModel(this.sessionId,model)}
  async setMode(mode){return this.client?.setMode(this.sessionId,mode)}
  async setConfigOption(id,value){return this.client?.setConfigOption(this.sessionId,id,value)}
  async close(){
    for(const [id,entry] of this.remoteTerminals){try{entry.child.kill("SIGTERM")}catch{}this.remoteTerminals.delete(id)}
    for(const id of this.terminalIds)await this.terminals?.close(id).catch(()=>{});
    this.terminalIds.clear();
    if(this.client&&this.sessionId)await this.client.closeSession(this.sessionId).catch(()=>{});
    await this.client?.stop().catch(()=>{});
  }

  async #clientRequest(method,params){
    if(method==="fs/read_text_file"){
      if(this.remoteIo){
        const text=await this.remoteIo.readText(params.path);
        const start=Math.max(0,(Number(params.line)||1)-1),limit=params.limit==null?null:Math.max(0,Number(params.limit)||0),lines=text.split(/\r?\n/);
        return {content:(limit==null?lines.slice(start):lines.slice(start,start+limit)).join("\n")};
      }
      const path=boundedPath(this.cwd,params.path);
      const text=await readFile(path,"utf8");
      const start=Math.max(0,(Number(params.line)||1)-1);
      const limit=params.limit==null?null:Math.max(0,Number(params.limit)||0);
      const lines=text.split(/\r?\n/);
      return {content:(limit==null?lines.slice(start):lines.slice(start,start+limit)).join("\n")};
    }
    if(method==="fs/write_text_file"){
      const options=[{kind:"allow_once",optionId:"allow",name:"Allow"},{kind:"reject_once",optionId:"reject",name:"Reject"}];
      const selected=permissionChoice(options,this.permissionMode)||decisionChoice(options,await this.onPermission?.({method,params,options}));
      if(selected!=="allow")throw Object.assign(new Error("File write was denied"),{code:-32000});
      if(this.remoteIo){await this.remoteIo.writeText(params.path,String(params.content??""));return {}}
      const path=boundedPath(this.cwd,params.path);
      await writeFile(path,String(params.content??""),"utf8");
      return {};
    }
    if(method==="session/request_permission"){
      const options=params.options||[];const automatic=permissionChoice(options,this.permissionMode);
      const optionId=automatic||decisionChoice(options,await this.onPermission?.({method,params,options}));
      return optionId?{outcome:{outcome:"selected",optionId}}:{outcome:{outcome:"cancelled"}};
    }
    if(method==="session/elicitation"||method==="elicitation/create"){
      const result=await this.onElicitation?.({method,params});
      return result||{action:"cancel"};
    }
    if(method==="terminal/create"){
      if(this.remoteIo){
        const id=`remote-terminal-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        const child=this.remoteIo.spawn({command:String(params.command||""),args:Array.isArray(params.args)?params.args:[],cwd:params.cwd||this.cwd});
        const entry={child,buffer:"",running:true,exitCode:null,signal:null,waiters:[]};this.remoteTerminals.set(id,entry);
        const append=chunk=>{entry.buffer=(entry.buffer+String(chunk)).slice(-2*1024*1024)};child.stdout?.on("data",append);child.stderr?.on("data",append);
        child.once("exit",(code,signal)=>{entry.running=false;entry.exitCode=code;entry.signal=signal;for(const resolve of entry.waiters.splice(0))resolve({exitCode:code,signal})});
        this.terminalIds.add(id);return {terminalId:id};
      }
      if(!this.terminals)throw new Error("Terminal service is unavailable");
      const cwd=params.cwd?boundedPath(this.cwd,params.cwd):this.cwd;
      const env=Object.fromEntries((params.env||[]).map(item=>[String(item.name),String(item.value)]));
      const session=await this.terminals.create({cwd,name:`${this.runtime} agent`,shell:String(params.command||""),args:Array.isArray(params.args)?params.args:[],env});
      this.terminalIds.add(session.id);
      return {terminalId:session.id};
    }
    if(method==="terminal/output"){
      if(this.remoteIo){const session=this.remoteTerminals.get(params.terminalId);if(!session)throw Object.assign(new Error("Terminal not found"),{code:-32002});return {output:session.buffer||"",truncated:false,...(!session.running?{exitStatus:{exitCode:session.exitCode??0,signal:session.signal??null}}:{})}}
      const session=this.terminals?.snapshot(params.terminalId);
      if(!session)throw Object.assign(new Error("Terminal not found"),{code:-32002});
      return {output:session.buffer||"",truncated:false,...(!session.running?{exitStatus:{exitCode:session.exitCode??0,signal:null}}:{})};
    }
    if(method==="terminal/wait_for_exit"){
      if(this.remoteIo){const session=this.remoteTerminals.get(params.terminalId);if(!session)throw Object.assign(new Error("Terminal not found"),{code:-32002});if(!session.running)return {exitCode:session.exitCode??null,signal:session.signal??null};return await new Promise(resolve=>session.waiters.push(resolve))}
      const result=await this.terminals?.waitForExit(params.terminalId,{timeoutMs:30*60_000});
      return {exitCode:result?.exitCode??null,signal:result?.signal??null};
    }
    if(method==="terminal/kill"){
      if(this.remoteIo){const session=this.remoteTerminals.get(params.terminalId);if(session){try{session.child.kill("SIGTERM")}catch{}this.remoteTerminals.delete(params.terminalId)}this.terminalIds.delete(params.terminalId);return {}}
      await this.terminals?.close(params.terminalId);this.terminalIds.delete(params.terminalId);return {};
    }
    if(method==="terminal/release"){
      if(this.remoteIo){const session=this.remoteTerminals.get(params.terminalId);if(session?.running){try{session.child.kill("SIGTERM")}catch{}}this.remoteTerminals.delete(params.terminalId);this.terminalIds.delete(params.terminalId);return {}}
      await this.terminals?.close(params.terminalId);this.terminalIds.delete(params.terminalId);return {};
    }
    throw Object.assign(new Error(`Unsupported ACP client request: ${method}`),{code:-32601});
  }
}
