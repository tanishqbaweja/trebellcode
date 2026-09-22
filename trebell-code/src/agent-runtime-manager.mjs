import { access } from "node:fs/promises";
import { join, posix } from "node:path";
import spawn from "cross-spawn";
import { trebellHome } from "./paths.mjs";
import { resolveCodexHomeLayout } from "./codex-home-layout.mjs";

const RUNTIMES=Object.freeze({
  codex:{id:"codex",name:"Codex",protocol:"codex",command:null,multipleInstances:true},
  claude:{id:"claude",name:"Claude Code",protocol:"claude",command:"claude",multipleInstances:true},
  cursor:{id:"cursor",name:"Cursor",protocol:"acp",command:"cursor-agent",multipleInstances:true},
  grok:{id:"grok",name:"Grok Build",protocol:"acp",command:"grok",multipleInstances:true},
  opencode:{id:"opencode",name:"OpenCode",protocol:"sdk",command:"opencode",multipleInstances:true},
  antigravity:{id:"antigravity",name:"Antigravity",protocol:"acp",command:null,multipleInstances:true,managed:true},
});

const INSTALLABLE_PACKAGES=Object.freeze({
  claude:"@anthropic-ai/claude-code",
  opencode:"@opencode/cli",
});

export function normalizeAgentRuntime(value){
  const id=String(value||"codex").trim().toLowerCase();
  return RUNTIMES[id]?id:"codex";
}

async function run(command,args=[],{env=process.env,cwd=process.cwd(),timeoutMs=5000}={}){
  return await new Promise(resolve=>{
    let stdout="",stderr="",settled=false;
    let child;
    try{
      child=spawn(command,args,{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    }catch(error){return resolve({ok:false,code:null,error:error.message,stdout:"",stderr:""})}
    const finish=(code,error=null)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({ok:code===0,code,error:error?.message||null,stdout,stderr})};
    child.stdout?.on("data",chunk=>{stdout+=String(chunk);if(stdout.length>512_000)stdout=stdout.slice(-512_000)});
    child.stderr?.on("data",chunk=>{stderr+=String(chunk);if(stderr.length>512_000)stderr=stderr.slice(-512_000)});
    child.once("error",error=>finish(null,error));child.once("exit",code=>finish(code));
    const timer=setTimeout(()=>{try{child.kill()}catch{}finish(null,new Error("probe timed out"))},timeoutMs);
  });
}

function defaultInstance(kind){return {id:`${kind}-default`,kind,displayName:RUNTIMES[kind].name,enabled:true,binaryPath:null,homePath:null,shadowHomePath:null,serverUrl:null,environment:{}}}

export class AgentRuntimeManager{
  constructor({state,env=process.env,environments=null}={}){this.state=state;this.env=env;this.environments=environments}
  definitions(){return Object.values(RUNTIMES).map(item=>({...item}))}
  instances(){
    const configured=Array.isArray(this.state?.settings()?.agentRuntimeInstances)?this.state.settings().agentRuntimeInstances:[];
    const byKind=new Map(configured.map(item=>[String(item.id),{...item,kind:normalizeAgentRuntime(item.kind)}]));
    for(const kind of Object.keys(RUNTIMES)){
      const id=`${kind}-default`;if(!byKind.has(id))byKind.set(id,defaultInstance(kind));
    }
    return [...byKind.values()];
  }
  activeRuntime(){return normalizeAgentRuntime(this.state?.settings()?.agentRuntime||"codex")}
  activeInstance(){
    const settings=this.state?.settings()||{};const runtime=this.activeRuntime();const requested=String(settings.agentRuntimeInstanceId||`${runtime}-default`);
    return this.instances().find(item=>item.id===requested&&item.kind===runtime)||this.instances().find(item=>item.kind===runtime)||defaultInstance(runtime);
  }
  async setActive({runtime,instanceId=null}={}){
    const kind=normalizeAgentRuntime(runtime);const instance=this.instances().find(item=>item.id===(instanceId||`${kind}-default`)&&item.kind===kind)||this.instances().find(item=>item.kind===kind);
    if(!instance)throw new Error(`No ${RUNTIMES[kind].name} runtime instance is configured`);
    const status=await this.probe(instance);
    if(kind!=="codex"&&!status.available)throw new Error(status.message||`${RUNTIMES[kind].name} is unavailable`);
    this.state.updateSettings({agentRuntime:kind,agentRuntimeInstanceId:instance.id});
    return {runtime:kind,instance,status};
  }
  upsertInstance(input={}){
    const kind=normalizeAgentRuntime(input.kind);const settings=this.state.settings();const list=Array.isArray(settings.agentRuntimeInstances)?[...settings.agentRuntimeInstances]:[];
    const id=String(input.id||`${kind}-${Date.now()}`);const index=list.findIndex(item=>item.id===id);
    const item={...(index>=0?list[index]:{}),...input,id,kind,displayName:String(input.displayName||RUNTIMES[kind].name),enabled:input.enabled!==false};
    if(index>=0)list[index]=item;else list.push(item);this.state.updateSettings({agentRuntimeInstances:list});return item;
  }
  removeInstance(id){
    const settings=this.state.settings();const target=this.instances().find(item=>item.id===id);
    if(!target)return {ok:false};
    if(id===`${target.kind}-default`)throw new Error("The built-in default runtime profile cannot be removed");
    const list=(settings.agentRuntimeInstances||[]).filter(item=>item.id!==id);
    const patch={agentRuntimeInstances:list};
    let resetTo=null;
    if(settings.agentRuntimeInstanceId===id){resetTo=`${target.kind}-default`;patch.agentRuntimeInstanceId=resetTo}
    this.state.updateSettings(patch);return {ok:true,resetTo,kind:target.kind};
  }
  executable(instance){
    if(instance?.binaryPath?.trim())return instance.binaryPath.trim();
    const def=RUNTIMES[instance?.kind];
    if(instance?.kind==="antigravity")return join(trebellHome(this.env),"agent-runtimes","antigravity","current","agy_acp_server.exe");
    return def?.command||null;
  }
  childEnv(instance){
    const env={...this.env,...(instance?.environment||{})};
    if(instance?.kind==="codex"){
      const layout=resolveCodexHomeLayout({homePath:instance?.homePath,shadowHomePath:instance?.shadowHomePath});
      if(layout.effectiveHomePath)env.CODEX_HOME=layout.effectiveHomePath;
    }
    if(instance?.kind==="claude"&&instance?.homePath)env.CLAUDE_CONFIG_DIR=instance.homePath;
    return env;
  }
  activeEnvironment(environmentId=undefined){
    const id=environmentId===undefined?(this.state?.settings()?.activeEnvironmentId||null):environmentId;
    return id&&this.environments?this.environments.get(id):null;
  }
  runtimeCwd(requested=process.cwd(),environmentId=undefined){
    const profile=this.activeEnvironment(environmentId);return profile&&profile.type!=="local"?(profile.cwd||requested):requested;
  }
  processSpawner(instance,environmentId=undefined){
    const profile=this.activeEnvironment(environmentId);if(!profile||profile.type==="local"||!this.environments)return null;
    return options=>this.environments.spawnArgv(profile.id,{command:this.executable(instance),args:options.args||[],cwd:options.cwd||profile.cwd||null,stdio:options.stdio||["pipe","pipe","pipe"]});
  }
  remoteIo(cwd,environmentId=undefined){
    const profile=this.activeEnvironment(environmentId);if(!profile||profile.type==="local"||!this.environments)return null;
    const root=posix.resolve(String(cwd||profile.cwd||"/"));
    const pathFor=value=>{
      const raw=String(value||"");const candidate=posix.resolve(raw.startsWith("/")?raw:posix.join(root,raw));const rel=posix.relative(root,candidate);
      if(rel.startsWith("..")||posix.isAbsolute(rel))throw Object.assign(new Error(`Path is outside the active remote workspace: ${value}`),{code:-32602});
      return candidate;
    };
    return {
      readText:async path=>{
        const candidate=pathFor(path);const result=await this.environments.executeArgv(profile.id,{command:"base64",args:[candidate],cwd:"",timeoutMs:30_000});
        if(result.exitCode!==0)throw new Error(result.stderr||`Could not read remote file ${candidate}`);
        return Buffer.from(String(result.stdout||"").replace(/\s+/g,""),"base64").toString("utf8");
      },
      writeText:async(path,content)=>{
        const candidate=pathFor(path);const encoded=Buffer.from(String(content??""),"utf8").toString("base64");
        const script='printf %s "$1" | base64 -d > "$2"';
        const result=await this.environments.executeArgv(profile.id,{command:"sh",args:["-lc",script,"trebell",encoded,candidate],cwd:"",timeoutMs:30_000});
        if(result.exitCode!==0)throw new Error(result.stderr||`Could not write remote file ${candidate}`);
      },
      spawn:({command,args=[],cwd:spawnCwd=null})=>this.environments.spawnArgv(profile.id,{command,args,cwd:spawnCwd||root,stdio:["pipe","pipe","pipe"]}),
      profile,
      root,
    };
  }
  async #run(instance,args,{timeoutMs=6000,cwd=null,environmentId=undefined}={}){
    const profile=this.activeEnvironment(environmentId);
    if(profile&&profile.type!=="local"&&this.environments){
      const result=await this.environments.executeArgv(profile.id,{command:this.executable(instance),args,cwd:cwd||profile.cwd||"",timeoutMs});
      return {ok:result.exitCode===0,code:result.exitCode,error:result.timedOut?"probe timed out":null,stdout:result.stdout||"",stderr:result.stderr||""};
    }
    return run(this.executable(instance),args,{env:this.childEnv(instance),cwd:cwd||process.cwd(),timeoutMs});
  }
  async #runCommand(command,args,{timeoutMs=120000,cwd=null,environmentId=undefined}={}){
    const profile=this.activeEnvironment(environmentId);
    if(profile&&profile.type!=="local"&&this.environments){
      const result=await this.environments.executeArgv(profile.id,{command,args,cwd:cwd||profile.cwd||"",timeoutMs,maxOutput:4*1024*1024});
      return {ok:result.exitCode===0,code:result.exitCode,error:result.timedOut?"command timed out":null,stdout:result.stdout||"",stderr:result.stderr||""};
    }
    return run(command,args,{env:this.env,cwd:cwd||process.cwd(),timeoutMs});
  }
  installable(kind){
    const runtime=normalizeAgentRuntime(kind);const packageName=INSTALLABLE_PACKAGES[runtime]||null;
    return packageName?{runtime,packageName}:null;
  }
  async install(kind,{environmentId=undefined}={}){
    const target=this.installable(kind);const normalized=normalizeAgentRuntime(kind);
    if(!target)throw new Error((RUNTIMES[normalized]?.name||String(kind||"Harness"))+" is not installable from Trebell Code");
    const npm=await this.#runCommand("npm",["--version"],{timeoutMs:8000,environmentId});
    if(!npm.ok)throw new Error("npm is required to install this harness in the selected environment. Install Node.js/npm there first.");
    const result=await this.#runCommand("npm",["install","-g",target.packageName],{timeoutMs:180000,environmentId});
    if(!result.ok)throw new Error((result.stderr||result.stdout||("Could not install "+target.packageName)).trim().slice(-2000));
    const instances=this.instances();
    const instance=instances.find(item=>item.kind===target.runtime&&item.id===target.runtime+"-default")||instances.find(item=>item.kind===target.runtime)||defaultInstance(target.runtime);
    const status=await this.probe(instance,{environmentId});
    return {ok:true,runtime:target.runtime,packageName:target.packageName,status,output:(result.stdout||result.stderr||"").trim().slice(-2000)};
  }
  acpArgs(instance,permissionMode="supervised",cwd=process.cwd()){
    if(instance.kind==="cursor"){
      if(permissionMode==="full")return ["--force","acp"];
      if(permissionMode==="auto"||permissionMode==="edits")return ["--auto-review","acp"];
      return ["acp"];
    }
    if(instance.kind==="grok"){
      if(permissionMode==="full")return ["agent","--always-approve","stdio"];
      if(permissionMode==="auto")return ["--permission-mode","auto","agent","stdio"];
      if(permissionMode==="edits")return ["--permission-mode","acceptEdits","agent","stdio"];
      return ["--permission-mode","default","agent","stdio"];
    }
    if(instance.kind==="opencode")return [];
    if(instance.kind==="antigravity")return [];
    return [];
  }
  async probe(instanceOrKind,{environmentId=undefined}={}){
    const instance=typeof instanceOrKind==="string"?(this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind))):instanceOrKind;
    const def=RUNTIMES[instance.kind];
    if(instance.kind==="codex"){
      if(!instance.binaryPath?.trim())return {id:instance.id,kind:"codex",name:def.name,available:true,installed:true,authenticated:true,protocol:"codex",version:null,binary:null,message:"Bundled Codex app-server"};
      const checked=await this.#run(instance,["--version"],{timeoutMs:6000,environmentId});
      return {id:instance.id,kind:"codex",name:def.name,available:checked.ok,installed:checked.ok,authenticated:true,protocol:"codex",version:checked.ok?(checked.stdout||checked.stderr).trim().split(/\r?\n/)[0]||null:null,binary:this.executable(instance),message:checked.ok?"Ready":(checked.stderr||checked.error||"Custom Codex binary is unavailable").trim().slice(0,500)};
    }
    const command=this.executable(instance);
    if(instance.kind==="antigravity"&&!this.activeEnvironment(environmentId)){
      try{await access(command)}catch{return {id:instance.id,kind:instance.kind,name:def.name,available:false,installed:false,authenticated:false,protocol:def.protocol,managed:true,message:"Antigravity runtime is not installed"}}
    }
    const versionArgs=instance.kind==="antigravity"?["--version"]:["--version"];
    const versionResult=await this.#run(instance,versionArgs,{timeoutMs:6000,environmentId});
    if(!versionResult.ok)return {id:instance.id,kind:instance.kind,name:def.name,available:false,installed:false,authenticated:false,protocol:def.protocol,managed:Boolean(def.managed),binary:command,message:(versionResult.stderr||versionResult.error||`${def.name} executable was not found`).trim().slice(0,500)};
    let authenticated=true,account=null,message="Ready";
    if(instance.kind==="claude"){
      const auth=await this.#run(instance,["auth","status"],{timeoutMs:8000,environmentId});
      try{account=JSON.parse(auth.stdout||"{}");authenticated=Boolean(account.loggedIn)}catch{authenticated=auth.ok}
      if(!authenticated)message="Claude Code is installed but not authenticated";
    }
    return {id:instance.id,kind:instance.kind,name:def.name,available:authenticated,installed:true,authenticated,protocol:def.protocol,managed:Boolean(def.managed),binary:command,version:(versionResult.stdout||versionResult.stderr).trim().split(/\r?\n/)[0]||null,account,message};
  }
  async models(instanceOrKind,{environmentId=undefined}={}){
    const instance=typeof instanceOrKind==="string"?(this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind))):instanceOrKind;
    if(instance.kind==="codex")return {models:[],metadata:[],source:"codex"};
    const status=await this.probe(instance,{environmentId});if(!status.available)return {models:[],metadata:[],source:"unavailable",error:status.message};
    if(instance.kind==="opencode"){
      const result=await this.#run(instance,["models"],{timeoutMs:30_000,environmentId});
      const models=(result.stdout||"").split(/\r?\n/).map(line=>line.trim()).filter(line=>/^[^\s]+\/[^\s]+$/.test(line));
      return {models:[...new Set(models)],metadata:[...new Set(models)].map(id=>({id,provider:"opencode",agent:"OpenCode"})),source:"live"};
    }
    if(instance.kind==="claude"){
      const models=["sonnet","opus","haiku"];
      return {models,metadata:models.map(id=>({id,provider:"claude",agent:"Claude Code"})),source:"aliases"};
    }
    if(instance.kind==="cursor")return {models:["cursor-default"],metadata:[{id:"cursor-default",provider:"cursor",agent:"Cursor",dynamic:true}],source:"session"};
    if(instance.kind==="grok")return {models:["grok-build"],metadata:[{id:"grok-build",provider:"grok",agent:"Grok Build",dynamic:true}],source:"session"};
    if(instance.kind==="antigravity")return {models:["antigravity-default"],metadata:[{id:"antigravity-default",provider:"antigravity",agent:"Antigravity",dynamic:true}],source:"session"};
    return {models:[],metadata:[],source:"unknown"};
  }
  async snapshot(){
    const instances=this.instances();const statuses=await Promise.all(instances.map(instance=>this.probe(instance)));
    const publicInstances=instances.map(instance=>{
      const {environment,...safe}=instance;
      return {...safe,environmentKeys:Object.keys(environment||{})};
    });
    const definitions=this.definitions().map(def=>({...def,installable:Boolean(INSTALLABLE_PACKAGES[def.id]),packageName:INSTALLABLE_PACKAGES[def.id]||null}));
    const active=this.activeInstance();return {selectedRuntime:this.activeRuntime(),selectedInstanceId:active.id,definitions,instances:publicInstances,statuses};
  }
}
