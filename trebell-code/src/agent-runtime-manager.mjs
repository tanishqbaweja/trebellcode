import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import spawn from "cross-spawn";
import { codexHome, trebellHome } from "./paths.mjs";
import { resolveCodexHomeLayout } from "./codex-home-layout.mjs";
import { readAgentRuntimeUsage } from "./agent-usage-limits.mjs";

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

const RUNTIME_COMPATIBILITY=Object.freeze({
  opencode:Object.freeze({
    recommendedRange:">=1.14.19",
    ranges:Object.freeze([
      Object.freeze({range:"<1.14.19",status:"broken"}),
      Object.freeze({range:">=1.14.19",status:"supported"}),
    ]),
  }),
});

function parsedSemver(value){
  const match=String(value||"").match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?![0-9.-])/i);
  return match?{raw:match[0].trim().replace(/^v/i,""),major:Number(match[1]),minor:Number(match[2]),patch:Number(match[3])}:null;
}
function compareSemver(a,b){
  for(const key of ["major","minor","patch"]){if(a[key]!==b[key])return a[key]<b[key]?-1:1}
  return 0;
}
function satisfiesSimpleRange(version,range){
  const parsed=parsedSemver(version);if(!parsed)return false;
  const clauses=String(range||"").trim().split(/\s+/).filter(Boolean);if(!clauses.length)return false;
  return clauses.every(clause=>{
    const match=clause.match(/^(<=|>=|<|>|=)?v?(\d+)\.(\d+)\.(\d+)$/);if(!match)return false;
    const target={major:Number(match[2]),minor:Number(match[3]),patch:Number(match[4])};const compared=compareSemver(parsed,target);
    return match[1]==="<"?compared<0:match[1]==="<="?compared<=0:match[1]===">"?compared>0:match[1]===">="?compared>=0:compared===0;
  });
}
function stripAnsi(value){return String(value||"").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g,"")}
export function parseCursorAboutResult(result={}){
  const stdout=String(result.stdout||"").trim();
  const combined=stripAnsi(stdout+"\n"+String(result.stderr||""));
  if(stdout.startsWith("{")){
    try{
      const parsed=JSON.parse(stdout);
      const hasEmail=Object.prototype.hasOwnProperty.call(parsed,"userEmail");
      const email=typeof parsed.userEmail==="string"?parsed.userEmail.trim():"";
      const lower=email.toLowerCase();
      if(hasEmail&&parsed.userEmail==null)return {authenticated:false,email:null};
      if(email&&(lower==="not logged in"||lower.includes("login required")||lower.includes("authentication required")))return {authenticated:false,email:null};
      if(email)return {authenticated:true,email};
      return {authenticated:null,email:null};
    }catch{}
  }
  const emailMatch=combined.match(/^\s*User Email\s+(.+?)\s*$/im);
  const email=emailMatch?.[1]?.trim()||"";
  if(!email)return {authenticated:null,email:null};
  const lower=email.toLowerCase();
  if(lower==="not logged in"||lower.includes("login required")||lower.includes("authentication required"))return {authenticated:false,email:null};
  return {authenticated:true,email};
}
export function parseGrokModelsAuth(output){
  const value=stripAnsi(output);
  if(/you are logged in/i.test(value))return true;
  if(/not authenticated|not logged in/i.test(value))return false;
  return null;
}
export function parseOpenCodeAuthList(output){
  const value=stripAnsi(output);
  const credentials=Number(value.match(/(?:^|\s)(\d+)\s+credentials?\b/i)?.[1]??NaN);
  const environment=Number(value.match(/(?:^|\s)(\d+)\s+environment variables?\b/i)?.[1]??NaN);
  const known=Number.isFinite(credentials)||Number.isFinite(environment);
  const connected=(Number.isFinite(credentials)?credentials:0)+(Number.isFinite(environment)?environment:0);
  return {connected,authenticated:known&&connected>0?true:null};
}
export function runtimeCompatibility(kind,version){
  const policy=RUNTIME_COMPATIBILITY[normalizeAgentRuntime(kind)];if(!policy)return null;
  const parsed=parsedSemver(version);
  const normalized=parsed?parsed.raw:null;
  const matched=normalized?policy.ranges.find(item=>satisfiesSimpleRange(normalized,item.range)):null;
  const status=matched?.status||"unknown";
  const message=status==="broken"
    ?`This ${RUNTIMES[normalizeAgentRuntime(kind)]?.name||kind} version is known to be incompatible with Trebell Code. Use ${policy.recommendedRange}.`
    :status==="unsupported"
      ?`This ${RUNTIMES[normalizeAgentRuntime(kind)]?.name||kind} version is outside Trebell Code's supported range. Use ${policy.recommendedRange}.`
      :status==="graceful"?`This runtime has limited compatibility with Trebell Code. Use ${policy.recommendedRange} for full support.`:null;
  return {status,message,recommendedVersion:policy.recommendedVersion||null,recommendedRange:policy.recommendedRange||null,version:normalized};
}

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

function defaultInstance(kind){return {id:`${kind}-default`,kind,displayName:RUNTIMES[kind].name,enabled:true,binaryPath:null,homePath:null,shadowHomePath:null,serverUrl:null,autoCompactWindow:null,environment:{}}}

export class AgentRuntimeManager{
  constructor({state,env=process.env,environments=null,platform=process.platform,fetchImpl=globalThis.fetch}={}){this.state=state;this.env=env;this.environments=environments;this.platform=platform;this.fetchImpl=fetchImpl}
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
  continuationKey(instanceOrId=this.activeInstance()){
    const instance=typeof instanceOrId==="string"
      ?this.instances().find(item=>item.id===instanceOrId)
      :instanceOrId;
    if(!instance)return null;
    if(instance.kind==="codex"){
      return resolveCodexHomeLayout({
        homePath:String(instance.homePath||"").trim()||codexHome(this.env),
        shadowHomePath:String(instance.shadowHomePath||"").trim()||null,
        defaultHome:codexHome(this.env),
      }).continuationKey;
    }
    if(instance.kind==="claude"){
      const home=String(instance.homePath||this.env.CLAUDE_CONFIG_DIR||join(homedir(),".claude")).trim();
      const normalized=resolve(home);
      return "claude:home:"+(this.platform==="win32"?normalized.toLowerCase():normalized);
    }
    return `${instance.kind}:instance:${instance.id}`;
  }
  compatibleInstanceIds(instanceOrId=this.activeInstance()){
    const instance=typeof instanceOrId==="string"
      ?this.instances().find(item=>item.id===instanceOrId)
      :instanceOrId;
    if(!instance)return [];
    const key=this.continuationKey(instance);
    return this.instances()
      .filter(candidate=>candidate.enabled!==false&&candidate.kind===instance.kind&&this.continuationKey(candidate)===key)
      .map(candidate=>candidate.id);
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
    if(kind==="claude"){
      const raw=input.autoCompactWindow;
      if(raw==null||String(raw).trim()==="")item.autoCompactWindow=null;
      else{
        const value=Number(raw);
        if(!Number.isInteger(value)||value<100_000||value>1_000_000)throw new Error("Claude auto-compact threshold must be an integer between 100000 and 1000000 tokens");
        item.autoCompactWindow=value;
      }
    }else delete item.autoCompactWindow;
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
  authCommand(instanceOrKind,{action="login"}={}){
    const instance=typeof instanceOrKind==="string"
      ?(this.instances().find(item=>item.id===instanceOrKind)||this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind)))
      :instanceOrKind;
    if(action!=="login")throw new Error("Unsupported runtime authentication action");
    if(instance.kind==="opencode"&&instance.serverUrl)throw new Error("This OpenCode profile uses an external server. Authenticate providers on that server instead.");
    const args=instance.kind==="claude"?["auth","login"]
      :instance.kind==="cursor"?["login"]
      :instance.kind==="grok"?["login"]
      :instance.kind==="opencode"?["auth","login"]
      :null;
    if(!args)throw new Error((RUNTIMES[instance.kind]?.name||instance.kind)+" does not expose an interactive Trebell sign-in command.");
    return {runtime:instance.kind,instanceId:instance.id,name:RUNTIMES[instance.kind]?.name||instance.kind,command:this.executable(instance),args};
  }
  async install(kind,{environmentId=undefined}={}){
    const target=this.installable(kind);const normalized=normalizeAgentRuntime(kind);
    if(!target)throw new Error((RUNTIMES[normalized]?.name||String(kind||"Harness"))+" is not installable from Trebell Code");
    const npm=await this.#runCommand("npm",["--version"],{timeoutMs:8000,environmentId});
    if(!npm.ok)throw new Error("npm is required to install this harness in the selected environment. Install Node.js/npm there first.");
    let packageSpec=target.packageName,targetVersion=null,compatibility=null;
    if(RUNTIME_COMPATIBILITY[target.runtime]){
      const viewed=await this.#runCommand("npm",["view",target.packageName,"version","--json"],{timeoutMs:20_000,environmentId});
      if(!viewed.ok)throw new Error((viewed.stderr||viewed.stdout||"Could not determine the compatible runtime version").trim().slice(-1000));
      try{targetVersion=String(JSON.parse(String(viewed.stdout||"").trim()))}catch{targetVersion=String(viewed.stdout||"").trim().replace(/^["']|["']$/g,"")}
      compatibility=runtimeCompatibility(target.runtime,targetVersion);
      if(!targetVersion||!compatibility||["broken","unsupported","unknown"].includes(compatibility.status)){
        throw new Error(compatibility?.message||("Trebell could not verify that "+targetVersion+" is compatible. Update was not installed."));
      }
      packageSpec=target.packageName+"@"+targetVersion;
    }
    const result=await this.#runCommand("npm",["install","-g",packageSpec],{timeoutMs:180000,environmentId});
    if(!result.ok)throw new Error((result.stderr||result.stdout||("Could not install "+target.packageName)).trim().slice(-2000));
    const instances=this.instances();
    const instance=instances.find(item=>item.kind===target.runtime&&item.id===target.runtime+"-default")||instances.find(item=>item.kind===target.runtime)||defaultInstance(target.runtime);
    const status=await this.probe(instance,{environmentId});
    return {ok:true,runtime:target.runtime,packageName:target.packageName,targetVersion,compatibility,status,output:(result.stdout||result.stderr||"").trim().slice(-2000)};
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
    }else if(instance.kind==="cursor"){
      let about=await this.#run(instance,["about","--format","json"],{timeoutMs:8000,environmentId});
      const unsupported=/unknown (?:option|argument)|unexpected argument|unrecognized (?:option|argument)/i.test(String(about.stdout||"")+"\n"+String(about.stderr||""));
      if(unsupported)about=await this.#run(instance,["about"],{timeoutMs:8000,environmentId});
      const parsed=parseCursorAboutResult(about);
      authenticated=parsed.authenticated;account=parsed.email?{email:parsed.email}:null;
      if(authenticated===false)message="Cursor Agent is installed but not authenticated. Run cursor-agent login.";
      else if(authenticated==null)message="Cursor Agent is installed, but Trebell could not verify its authentication status.";
    }else if(instance.kind==="grok"){
      const environment=this.childEnv(instance);
      if(String(environment.XAI_API_KEY||"").trim()){
        authenticated=true;account={authMethod:"api_key"};
      }else{
        const models=await this.#run(instance,["models"],{timeoutMs:10_000,environmentId});
        authenticated=models.ok?parseGrokModelsAuth((models.stdout||"")+"\n"+(models.stderr||"")):null;
        if(authenticated===false)message="Grok CLI is installed but not logged in. Run grok login.";
        else if(authenticated==null)message="Grok CLI is installed, but Trebell could not verify its authentication status.";
      }
    }else if(instance.kind==="opencode"&&!instance.serverUrl){
      const auth=await this.#run(instance,["auth","list"],{timeoutMs:10_000,environmentId});
      if(auth.ok){
        const parsed=parseOpenCodeAuthList((auth.stdout||"")+"\n"+(auth.stderr||""));
        authenticated=parsed.authenticated;account={connectedProviders:parsed.connected};
        message=authenticated===true
          ?("OpenCode has "+parsed.connected+" connected credential source"+(parsed.connected===1?"":"s")+".")
          :"OpenCode is available, but no upstream credentials were detected.";
      }else{
        authenticated=null;message="OpenCode is available, but Trebell could not verify connected provider credentials.";
      }
    }
    const version=(versionResult.stdout||versionResult.stderr).trim().split(/\r?\n/)[0]||null;
    const compatibility=runtimeCompatibility(instance.kind,version);
    return {id:instance.id,kind:instance.kind,name:def.name,available:authenticated!==false,installed:true,authenticated,protocol:def.protocol,managed:Boolean(def.managed),binary:command,version,account,message,...(compatibility?{compatibility}:{})};
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
  async usageLimits(instanceOrKind,{environmentId=undefined}={}){
    const instance=typeof instanceOrKind==="string"?(this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind))):instanceOrKind;
    const profile=this.activeEnvironment(environmentId);
    if(profile&&profile.type!=="local"&&this.environments){
      const names=["HOME","XDG_CONFIG_HOME","XDG_DATA_HOME","AGENT_CLI_CREDENTIAL_STORE","CURSOR_AUTH_TOKEN","CURSOR_API_KEY","CURSOR_API_ENDPOINT","XAI_API_KEY","GROK_AUTH","GROK_HOME","GROK_OIDC_ISSUER","GROK_OIDC_CLIENT_ID","GROK_OAUTH2_ISSUER","GROK_OAUTH2_CLIENT_ID","GROK_OAUTH2_PRINCIPAL_TYPE","GROK_OAUTH2_PRINCIPAL_ID","GROK_AUTH_PROVIDER_COMMAND","GROK_LOCAL_AUTH","GROK_CLI_CHAT_PROXY_BASE_URL","GROK_MODELS_BASE_URL","GROK_CONFIG","GROK_CONFIG_PATH","OPENCODE_AUTH_CONTENT","OPENCODE_API_KEY"];
      const valuesScript=names.map(name=>"printf '"+name+"='; printf '%s' \"$"+"{"+name+"-}\" | base64 | tr -d '\\n'; printf '\\n'").join("; ");
      const [valuesResult,platformResult]=await Promise.all([
        this.environments.executeArgv(profile.id,{command:"sh",args:["-lc",valuesScript],cwd:"",timeoutMs:8000,maxOutput:512*1024}),
        this.environments.executeArgv(profile.id,{command:"uname",args:["-s"],cwd:"",timeoutMs:5000,maxOutput:16*1024}),
      ]);
      if(valuesResult.exitCode!==0)return {checkedAt:new Date().toISOString(),windows:[],unavailable:{reason:"probeFailed",message:(RUNTIMES[instance.kind]?.name||instance.kind)+" could not inspect remote account usage."}};
      const environment={};
      for(const line of String(valuesResult.stdout||"").split(/\r?\n/)){
        const separator=line.indexOf("=");if(separator<1)continue;
        const name=line.slice(0,separator),encoded=line.slice(separator+1);if(!names.includes(name)||!encoded)continue;
        try{environment[name]=Buffer.from(encoded,"base64").toString("utf8")}catch{}
      }
      const remotePlatform=/darwin/i.test(platformResult.stdout||"")?"darwin":"linux";
      const home=environment.HOME||"/";
      const readText=async path=>{
        const result=await this.environments.executeArgv(profile.id,{command:"cat",args:[String(path)],cwd:"",timeoutMs:5000,maxOutput:512*1024});
        return result.exitCode===0?String(result.stdout||""):null;
      };
      return readAgentRuntimeUsage(instance.kind,{environment,platform:remotePlatform,home,readText,joinPath:posix.join,fetchImpl:this.fetchImpl,serverUrl:instance.serverUrl||""});
    }
    const environment=this.childEnv(instance);const home=environment.HOME||environment.USERPROFILE||homedir();
    const readText=async path=>{try{return await readFile(path,"utf8")}catch{return null}};
    return readAgentRuntimeUsage(instance.kind,{environment,platform:this.platform,home,readText,joinPath:join,fetchImpl:this.fetchImpl,serverUrl:instance.serverUrl||""});
  }
  async snapshot(){
    const instances=this.instances();const statuses=await Promise.all(instances.map(instance=>this.probe(instance)));
    const publicInstances=instances.map(instance=>{
      const {environment,...safe}=instance;
      return {...safe,environmentKeys:Object.keys(environment||{})};
    });
    const definitions=this.definitions().map(def=>({...def,installable:Boolean(INSTALLABLE_PACKAGES[def.id]),packageName:INSTALLABLE_PACKAGES[def.id]||null,canAuthenticate:["claude","cursor","grok","opencode"].includes(def.id)}));
    const active=this.activeInstance();return {selectedRuntime:this.activeRuntime(),selectedInstanceId:active.id,compatibleInstanceIds:this.compatibleInstanceIds(active),definitions,instances:publicInstances,statuses};
  }
}
