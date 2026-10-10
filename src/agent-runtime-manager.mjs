import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import spawn from "cross-spawn";
import { codexBin, codexHome, trebellHome } from "./paths.mjs";
import { prepareCodexHome, resolveCodexHomeLayout } from "./codex-home-layout.mjs";
import { readAgentRuntimeUsage } from "./agent-usage-limits.mjs";
import { sharedRuntimeCapabilities } from "./runtime-capabilities.mjs";
import { withoutSecretEnvironment } from "./secret-redactor.mjs";
import { buildRuntimeEnvironment, normalizeApprovedEnvironmentKeys, runtimeEnvironmentKeys } from "./runtime-environment.mjs";
import { installAntigravityRuntime, readAntigravityAuthState, readAntigravityInstall } from "./antigravity-runtime-installer.mjs";
import { discoverOpenCodeModelCatalog } from "./opencode-agent-session.mjs";
import { resolveWindowsCommandShim, windowsCommandShimTarget } from "./windows-command-shim.mjs";
import { codexAccountStatus, readCodexAccount } from "./codex-account-probe.mjs";
import { claudeCapabilities, claudeModelCatalog } from "./claude-capabilities.mjs";
import { defaultAcpClientCapabilities } from "./acp-client.mjs";
import { acpProbeSession, acpSessionModelCatalog, antigravityModelCatalog, antigravitySeedCatalog, cursorModelCatalog, GROK_INITIALIZE_META, grokModelCatalog, withAcpProbe } from "./acp-model-catalog.mjs";
import { acpRuntimeTempRoot } from "./acp-runtime-temp.mjs";
import { acpCommandsFromAvailable } from "./acp-agent-session.mjs";

const RUNTIMES=Object.freeze({
  native:{id:"native",name:"Trebell Native",protocol:"native",command:null,multipleInstances:false,managed:true},
  codex:{id:"codex",name:"Codex",protocol:"codex",command:"codex",multipleInstances:true},
  claude:{id:"claude",name:"Claude Code",protocol:"claude",command:"claude",multipleInstances:true},
  cursor:{id:"cursor",name:"Cursor",protocol:"acp",command:"cursor-agent",multipleInstances:true},
  grok:{id:"grok",name:"Grok Build",protocol:"acp",command:"grok",multipleInstances:true},
  opencode:{id:"opencode",name:"OpenCode",protocol:"sdk",command:"opencode",multipleInstances:true},
  antigravity:{id:"antigravity",name:"Antigravity",protocol:"acp",command:null,multipleInstances:false,managed:true},
});

export function runtimeCapabilities(kind){
  return sharedRuntimeCapabilities(normalizeAgentRuntime(kind));
}

const CODEX_ACCOUNT_REUSE_MS=60_000;
// An ACP harness's model list is kept this long once it has models (T3 keeps Cursor's for 30 minutes per version).
const ACP_MODEL_LIST_REUSE_MS=30*60_000;
const INSTALLABLE_PACKAGES=Object.freeze({
  codex:"@openai/codex",
  claude:"@anthropic-ai/claude-code",
  // OpenCode 1.x ships as opencode-ai and 2.x as @opencode/cli (T3 openCodeUpdateFor). Trebell Code's OpenCode harness speaks the
  // 1.x server API, so it installs and updates 1.x only, and never moves an install between the two: 2.x converts OpenCode's shared
  // database in place.
  opencode:"opencode-ai",
});
// A model list reads OpenCode's provider list again once the last read is this old. A status check (every thread start makes one)
// reuses the last read of the same binary and version, and makes one only when there is none.
const OPENCODE_CATALOG_REUSE_MS=10_000;
const OPENCODE_STATUS_TIMEOUT_MS=20_000;
const OPENCODE_2X_MESSAGE="OpenCode 2.x is not supported yet: Trebell Code runs OpenCode 1.x. Use OpenCode 1.x (the opencode-ai npm package), or point this OpenCode profile's binary at a 1.x build.";
const OPENCODE_NPM_REGISTRY_LATEST="https://registry.npmjs.org/opencode-ai/latest";

const RUNTIME_COMPATIBILITY=Object.freeze({
  opencode:Object.freeze({
    recommendedRange:">=1.14.19 <2.0.0",
    ranges:Object.freeze([
      Object.freeze({range:"<1.14.19",status:"broken"}),
      Object.freeze({range:">=2.0.0",status:"unsupported",message:OPENCODE_2X_MESSAGE}),
      Object.freeze({range:">=1.14.19 <2.0.0",status:"supported"}),
    ]),
  }),
});

function parsedSemver(value){
  const match=String(value||"").match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?![0-9.-])/i);
  return match?{raw:match[0].trim().replace(/^v/i,""),major:Number(match[1]),minor:Number(match[2]),patch:Number(match[3])}:null;
}
async function terminateProcessTree(child){
  if(!child)return;
  if(process.platform==="win32"&&child.pid){
    await new Promise(resolve=>{
      let settled=false;const done=()=>{if(settled)return;settled=true;resolve()};
      try{const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.once("exit",done);killer.once("error",done);setTimeout(done,2000).unref?.()}catch{done()}
    });
  }else try{child.kill()}catch{}
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
function runtimeProbeFailure(def,result={}){
  const raw=stripAnsi(String(result.stderr||result.error||"")).trim();
  if(/spawn\s+EINVAL/i.test(raw))return `${def?.name||"Runtime"} launcher could not start on this system. Reinstall or update the CLI, then refresh.`;
  if(/ENOENT|not recognized as an internal or external command|command not found/i.test(raw))return `${def?.name||"Runtime"} executable was not found.`;
  const first=raw.split(/\r?\n/).map(line=>line.trim()).find(Boolean);
  return (first||`${def?.name||"Runtime"} executable was not found`).slice(0,500);
}
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
// T3 Code's OpenCode status message, from the connected providers OpenCode's server lists.
export function openCodeStatusMessage(connected,{external=false}={}){
  const count=Math.max(0,Number(connected)||0);
  if(count>0)return `${count} upstream provider${count===1?"":"s"} connected through ${external?"the configured OpenCode server":"OpenCode"}.`;
  return external?"Connected to the configured OpenCode server, but it did not report any connected upstream providers.":"OpenCode is available, but it did not report any connected upstream providers.";
}
// Where a command runs from, as cross-spawn finds it: the path itself, or the first match on PATH (with PATHEXT on Windows).
export function commandOnPath(command,{env=process.env,platform=process.platform,exists=existsSync}={}){
  const value=String(command||"").trim();if(!value)return null;
  const windows=platform==="win32",paths=windows?win32:posix;
  const extensions=windows?String(env?.PATHEXT||".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean):[];
  const named=base=>windows&&!extensions.some(extension=>base.toLowerCase().endsWith(extension.toLowerCase()))?extensions.map(extension=>base+extension):[base];
  if(/[\\/]/.test(value))return named(value).find(candidate=>exists(candidate))||null;
  for(const folder of String(env?.PATH||"").split(windows?";":":").filter(Boolean))for(const candidate of named(paths.join(folder,value)))if(exists(candidate))return candidate;
  return null;
}
// Who installed the OpenCode at a real path, judged from the path as T3 Code judges an update (openCodeUpdateFor): OpenCode's own
// installer keeps it in ~/.opencode/bin and updates it with `opencode upgrade`; npm keeps a global opencode-ai in
// <prefix>/node_modules/opencode-ai beside its opencode shims on Windows, and in <prefix>/lib/node_modules/opencode-ai elsewhere. Any
// other path (OpenCode 2.x's @opencode/cli, another package manager, a project's node_modules) is not Trebell's to update.
export function openCodeInstallOwner(path,{platform=process.platform,exists=existsSync}={}){
  const raw=String(path||""),lower=raw.replaceAll("\\","/").toLowerCase();
  if(/\/\.opencode\/bin\/opencode(?:\.exe)?$/.test(lower))return {method:"native"};
  const segment=platform==="win32"?"/node_modules/opencode-ai/":"/lib/node_modules/opencode-ai/",index=lower.lastIndexOf(segment);
  if(index<0||lower.slice(0,index).includes("/node_modules/"))return null;
  const prefix=index===0?"/":raw.slice(0,index);
  if(platform==="win32"&&!["opencode.cmd","opencode"].some(name=>exists(win32.join(prefix,name))))return null;
  return {method:"npm",prefix};
}
// npm leaves a command another package installed alone (EEXIST, unless forced), so it cannot update opencode-ai while the opencode
// command in its prefix runs something else, such as OpenCode 2.x's @opencode/cli. Returns that package (or file), or null.
export function openCodeCommandHolder(prefix,{platform=process.platform,read=path=>readFileSync(path,"utf8"),readLink=readlinkSync}={}){
  const windows=platform==="win32",paths=windows?win32:posix,root=String(prefix||"");
  const own=paths.join(root,windows?"node_modules":"lib/node_modules","opencode-ai").toLowerCase()+paths.sep;
  let target=null;
  if(windows)target=windowsCommandShimTarget(win32.join(root,"opencode.cmd"),{platform,allowScripts:true,read,exists:()=>true});
  else{
    const command=posix.join(root,"bin","opencode");
    try{target=posix.resolve(posix.dirname(command),readLink(command))}catch(error){if(error?.code!=="ENOENT")target=command}
  }
  if(!target||target.toLowerCase().startsWith(own))return null;
  const parts=paths.relative(root,target).split(/[\\/]/),index=parts[0]===".."?-1:parts.indexOf("node_modules");
  return (index>=0?parts.slice(index+1,parts[index+1]?.startsWith("@")?index+3:index+2).join("/"):"")||target;
}
export function runtimeCompatibility(kind,version){
  const policy=RUNTIME_COMPATIBILITY[normalizeAgentRuntime(kind)];if(!policy)return null;
  const parsed=parsedSemver(version);
  const normalized=parsed?parsed.raw:null;
  const matched=normalized?policy.ranges.find(item=>satisfiesSimpleRange(normalized,item.range)):null;
  const status=matched?.status||"unknown";
  const message=matched?.message?matched.message:status==="broken"
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
    let stdout="",stderr="",settled=false,timedOut=false;
    let child;
    try{
      child=spawn(command,args,{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    }catch(error){return resolve({ok:false,code:null,error:error.message,stdout:"",stderr:""})}
    const finish=(code,error=null)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({ok:code===0,code,error:error?.message||null,stdout,stderr})};
    child.stdout?.on("data",chunk=>{stdout+=String(chunk);if(stdout.length>512_000)stdout=stdout.slice(-512_000)});
    child.stderr?.on("data",chunk=>{stderr+=String(chunk);if(stderr.length>512_000)stderr=stderr.slice(-512_000)});
    child.once("error",error=>{if(!timedOut)finish(null,error)});child.once("exit",code=>{if(!timedOut)finish(code)});
    const timer=setTimeout(()=>{timedOut=true;void terminateProcessTree(child).finally(()=>finish(null,new Error("probe timed out")))},timeoutMs);
  });
}

function defaultInstance(kind){return {id:`${kind}-default`,kind,displayName:RUNTIMES[kind].name,enabled:true,binaryPath:null,homePath:null,shadowHomePath:null,serverUrl:null,autoCompactWindow:null,environment:{}}}

export function runtimeExecutableCandidates(kind,{env=process.env,platform=process.platform}={}){
  if(platform!=="win32")return [];
  const user=String(env.USERPROFILE||env.HOME||"").trim(),local=String(env.LOCALAPPDATA||"").trim(),appData=String(env.APPDATA||"").trim();
  const values=[];
  if(kind==="grok"){
    if(user)values.push(join(user,".grok","bin","grok.exe"));
    if(local)values.push(join(local,"Microsoft","WinGet","Packages","xAI.GrokBuild_Microsoft.Winget.Source_8wekyb3d8bbwe","grok.exe"));
  }
  if(kind==="cursor"){
    // The official installer puts a cmd -> PowerShell launcher here. Prefer it over PATH, whose first cursor-agent can be an
    // unrelated npm package. Probes and ACP sessions spawn through cross-spawn, which runs a .cmd launcher via cmd.exe.
    if(local)values.push(join(local,"cursor-agent","cursor-agent.cmd"));
    if(user)values.push(join(user,".cursor","bin","cursor-agent.exe"));
    if(local)values.push(join(local,"Programs","cursor","resources","app","bin","cursor-agent.exe"));
  }
  if(kind==="claude"){
    if(user)values.push(join(user,".local","bin","claude.exe"));
    // npm's claude.cmd only forwards to this native binary. The Claude Agent SDK spawns its executable
    // directly, and Node cannot spawn a .cmd shim without a shell (spawn EINVAL), so prefer the binary.
    if(appData)values.push(join(appData,"npm","node_modules","@anthropic-ai","claude-code","bin","claude.exe"));
    if(appData)values.push(join(appData,"npm","claude.cmd"));
  }
  if(appData&&kind==="opencode"){
    // Prefer the native binary behind npm's Windows shim. Some OpenCode npm
    // shims use CALL/SETLOCAL and can stay attached when spawned by a long-lived
    // desktop process, which made a healthy install look missing after Trebell's
    // bounded probe timed out.
    values.push(join(appData,"npm","node_modules","opencode-ai","bin","opencode.exe"));
    values.push(join(appData,"npm","node_modules","@opencode","cli","bin","opencode.exe"));
    values.push(join(appData,"npm","opencode.cmd"));
  }
  return values;
}

export class AgentRuntimeManager{
  constructor({state,env=process.env,environments=null,platform=process.platform,arch=process.arch,fetchImpl=globalThis.fetch,claudeCapabilitiesCache=claudeCapabilities}={}){this.state=state;this.env=env;this.environments=environments;this.platform=platform;this.arch=arch;this.fetchImpl=fetchImpl;this.claudeCapabilitiesCache=claudeCapabilitiesCache}
  definitions(){return Object.values(RUNTIMES).map(item=>({...item,capabilities:runtimeCapabilities(item.id)}))}
  capabilities(instanceOrKind=this.activeInstance()){
    const kind=typeof instanceOrKind==="string"
      ?(RUNTIMES[instanceOrKind]?instanceOrKind:this.instances().find(item=>item.id===instanceOrKind)?.kind)
      :instanceOrKind?.kind;
    return runtimeCapabilities(kind||this.activeRuntime());
  }
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
    if(instance.kind==="native")return "native:in-process";
    if(instance.kind==="codex"){
      return resolveCodexHomeLayout({
        homePath:String(instance.homePath||"").trim()||null,
        shadowHomePath:String(instance.shadowHomePath||"").trim()||null,
        defaultHome:String(this.env.CODEX_HOME||"").trim()||join(homedir(),".codex"),
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
    if(RUNTIMES[kind]?.multipleInstances===false&&id!==`${kind}-default`)throw new Error(`${RUNTIMES[kind].name} is built into Trebell Code and does not support additional runtime profiles`);
    const item={...(index>=0?list[index]:{}),...input,id,kind,displayName:String(input.displayName||RUNTIMES[kind].name),enabled:input.enabled!==false};
    item.environment=withoutSecretEnvironment(item.environment);
    item.approvedEnvironmentKeys=normalizeApprovedEnvironmentKeys(input.approvedEnvironmentKeys??item.approvedEnvironmentKeys);
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
  executable(instance,{environmentId=undefined}={}){
    if(instance?.binaryPath?.trim())return resolveWindowsCommandShim(instance.binaryPath.trim(),{platform:this.platform});
    const def=RUNTIMES[instance?.kind];
    const profile=this.activeEnvironment(environmentId);
    if(profile&&profile.type!=="local")return def?.command||null;
    if(instance?.kind==="codex")return codexBin(this.env,this.platform,this.arch);
    if(instance?.kind==="antigravity")return join(trebellHome(this.env),"agent-runtimes","antigravity","current",this.platform==="win32"?"agy_acp_server.exe":"agy_acp_server.par");
    const discovered=runtimeExecutableCandidates(instance?.kind,{env:this.env,platform:this.platform}).find(candidate=>existsSync(candidate));
    if(discovered)return resolveWindowsCommandShim(discovered,{platform:this.platform});
    return def?.command||null;
  }
  childEnv(instance){
    const env=buildRuntimeEnvironment(instance?.kind,{parent:this.env,approved:instance?.approvedEnvironmentKeys,overrides:instance?.environment,platform:this.platform});
    if(instance?.kind==="codex"){
      const layout=resolveCodexHomeLayout({homePath:instance?.homePath,shadowHomePath:instance?.shadowHomePath,defaultHome:String(this.env.CODEX_HOME||"").trim()||join(homedir(),".codex")});
      if(layout.effectiveHomePath)env.CODEX_HOME=layout.effectiveHomePath;
    }
    if(instance?.kind==="claude"&&instance?.homePath)env.CLAUDE_CONFIG_DIR=instance.homePath;
    return env;
  }
  childEnvironmentKeys(instanceOrKind=this.activeInstance()){
    const instance=typeof instanceOrKind==="string"
      ?(this.instances().find(item=>item.id===instanceOrKind)||this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind)))
      :instanceOrKind;
    return runtimeEnvironmentKeys(instance?.kind,{approved:instance?.approvedEnvironmentKeys});
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
    const environmentNames=this.childEnvironmentKeys(instance);
    // options.environment sets explicit variables for this one process (e.g. a restricted harness config); environmentNames only forwards the remote shell's own values.
    return options=>this.environments.spawnArgv(profile.id,{command:this.executable(instance,{environmentId:profile.id}),args:options.args||[],cwd:options.cwd||profile.cwd||null,stdio:options.stdio||["pipe","pipe","pipe"],environmentNames,...(options.environment&&typeof options.environment==="object"?{environment:options.environment}:{})});
  }
  // Runs the instance's own CLI (arguments after the executable) where the instance runs, local or remote, with its approved variables.
  runCli(instance,args=[],{timeoutMs=15_000,cwd=null,environmentId=undefined}={}){return this.#run(instance,args,{timeoutMs,cwd,environmentId})}
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
        // An agent may write a file into a folder that does not exist yet (ACP fs/write_text_file creates it).
        const script='mkdir -p "$(dirname "$2")" && printf %s "$1" | base64 -d > "$2"';
        const result=await this.environments.executeArgv(profile.id,{command:"sh",args:["-lc",script,"trebell",encoded,candidate],cwd:"",timeoutMs:30_000});
        if(result.exitCode!==0)throw new Error(result.stderr||`Could not write remote file ${candidate}`);
      },
      spawn:({command,args=[],cwd:spawnCwd=null})=>this.environments.spawnArgv(profile.id,{command,args,cwd:pathFor(spawnCwd||root),stdio:["pipe","pipe","pipe"]}),
      profile,
      root,
    };
  }
  async #run(instance,args,{timeoutMs=6000,cwd=null,environmentId=undefined}={}){
    const profile=this.activeEnvironment(environmentId);
    if(profile&&profile.type!=="local"&&this.environments){
      const result=await this.environments.executeArgv(profile.id,{command:this.executable(instance,{environmentId:profile.id}),args,cwd:cwd||profile.cwd||"",timeoutMs,environmentNames:this.childEnvironmentKeys(instance)});
      return {ok:result.exitCode===0,code:result.exitCode,error:result.timedOut?"probe timed out":null,stdout:result.stdout||"",stderr:result.stderr||""};
    }
    return run(this.executable(instance),args,{env:this.childEnv(instance),cwd:cwd||process.cwd(),timeoutMs});
  }
  // One short-lived `codex app-server` per profile answers account/read. Ready answers are reused briefly because the
  // bootstrap payload probes the active profile on every request; concurrent probes share one process.
  #codexAccounts=new Map();
  async #codexAccount(instance,environmentId=undefined){
    const profile=this.activeEnvironment(environmentId),spawner=this.processSpawner(instance,environmentId);
    const command=this.executable(instance,{environmentId}),env=spawner?null:this.childEnv(instance);
    const key=[profile?.id||"local",instance.id,command,env?.CODEX_HOME||""].join("|"),cached=this.#codexAccounts.get(key);
    if(cached?.pending)return await cached.pending;
    if(cached&&Date.now()-cached.at<CODEX_ACCOUNT_REUSE_MS)return cached.value;
    const spawnAppServer=spawner?args=>spawner({args}):args=>spawn(command,args,{env,cwd:process.cwd(),windowsHide:true,stdio:["pipe","pipe","pipe"]});
    // A local probe runs in the home the profile's app-server runs in (gui-server startAppServer): a shadow home is linked to
    // its shared home first, so Codex reads the profile's config there and never fills the shadow home with folders of its own
    // (its skills) where the shared home's links belong.
    const home=spawner?Promise.resolve():prepareCodexHome({homePath:String(instance.homePath||"").trim()||null,shadowHomePath:String(instance.shadowHomePath||"").trim()||null,defaultHome:String(this.env.CODEX_HOME||"").trim()||join(homedir(),".codex")});
    const pending=home.then(()=>readCodexAccount({spawnAppServer,platform:this.platform})).then(result=>({result}),error=>({error:error?.message||String(error)}));
    this.#codexAccounts.set(key,{pending});
    const value=await pending;
    if(value.result&&codexAccountStatus(value.result.account).ready)this.#codexAccounts.set(key,{at:Date.now(),value});else this.#codexAccounts.delete(key);
    return value;
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
    if(runtime==="antigravity")return {runtime,managed:"acp-registry"};
    return packageName?{runtime,packageName}:null;
  }
  authCommand(instanceOrKind,{action="login",environmentId=undefined}={}){
    const instance=typeof instanceOrKind==="string"
      ?(this.instances().find(item=>item.id===instanceOrKind)||this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind)))
      :instanceOrKind;
    if(action!=="login")throw new Error("Unsupported runtime authentication action");
    if(instance.kind==="opencode"&&instance.serverUrl)throw new Error("This OpenCode profile uses an external server. Authenticate providers on that server instead.");
    const args=instance.kind==="claude"?["auth","login"]
      :instance.kind==="codex"?["login"]
      :instance.kind==="cursor"?["login"]
      :instance.kind==="grok"?["login"]
      :instance.kind==="opencode"?["auth","login"]
      :null;
    if(!args)throw new Error((RUNTIMES[instance.kind]?.name||instance.kind)+" does not expose an interactive Trebell sign-in command.");
    return {runtime:instance.kind,instanceId:instance.id,name:RUNTIMES[instance.kind]?.name||instance.kind,command:this.executable(instance,{environmentId}),args};
  }
  async install(kind,{environmentId=undefined}={}){
    const target=this.installable(kind);const normalized=normalizeAgentRuntime(kind);
    if(!target)throw new Error((RUNTIMES[normalized]?.name||String(kind||"Harness"))+" is not installable from Trebell Code");
    if(target.runtime==="antigravity"){
      if(this.activeEnvironment(environmentId))throw new Error("Managed Antigravity ACP installation is currently available only on the local machine");
      const installed=await installAntigravityRuntime({env:this.env,fetchImpl:this.fetchImpl,platform:this.platform,arch:this.arch});
      const instance=this.instances().find(item=>item.kind==="antigravity"&&item.id==="antigravity-default")||defaultInstance("antigravity");
      const status=await this.probe(instance,{environmentId:null});
      return {ok:true,runtime:"antigravity",managed:"acp-registry",targetVersion:installed.version,status};
    }
    if(target.runtime==="opencode")return await this.#installOpenCode(environmentId);
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
  // What installing or updating OpenCode runs, decided without changing anything (T3 openCodeUpdateFor): an OpenCode from its own
  // installer updates with `opencode upgrade <version>`, npm's global opencode-ai through npm into the same prefix, and a machine (or
  // remote environment) without OpenCode gets opencode-ai through npm. The target is the newest opencode-ai release, which must be a
  // supported 1.x. OpenCode 2.x, and an OpenCode Trebell cannot tell who installed, are left alone.
  async openCodeInstallPlan({environmentId=undefined}={}){
    const instances=this.instances();
    const instance=instances.find(item=>item.kind==="opencode"&&item.id==="opencode-default")||instances.find(item=>item.kind==="opencode")||defaultInstance("opencode");
    const checked=await this.#run(instance,["--version"],{timeoutMs:6000,environmentId});
    const installed=checked.ok?runtimeCompatibility("opencode",(checked.stdout||checked.stderr).trim().split(/\r?\n/)[0]||null):null;
    if(installed?.status==="unsupported")throw new Error(`This OpenCode is ${installed.version}. Trebell Code neither updates OpenCode 2.x nor installs 1.x beside it, because OpenCode 2.x converts OpenCode's shared database in place. ${OPENCODE_2X_MESSAGE}`);
    const local=checked.ok&&!this.processSpawner(instance,environmentId)?this.#openCodeInstall(instance):null;
    if(local&&!local.owner)throw new Error(`Trebell Code updates an OpenCode installed by npm (opencode-ai) or by OpenCode's own installer, and could not tell how ${local.binary} was installed. Update it the way you installed it.`);
    const holder=local?.owner.method==="npm"?openCodeCommandHolder(local.owner.prefix,{platform:this.platform}):null;
    if(holder)throw new Error(`npm cannot update opencode-ai in ${local.owner.prefix}: the opencode command there runs ${holder}, and npm does not replace another package's command. Trebell Code changes neither install. To update OpenCode 1.x, uninstall ${holder}, or run npm install -g opencode-ai --force yourself (the opencode command then runs OpenCode 1.x).`);
    const native=local?.owner.method==="native";
    let targetVersion=null;
    if(native){
      let latest=null;
      try{const response=await this.fetchImpl(OPENCODE_NPM_REGISTRY_LATEST,{headers:{accept:"application/json"},signal:AbortSignal.timeout(15_000)});if(response?.ok)latest=await response.json()}catch{}
      targetVersion=typeof latest?.version==="string"?latest.version.trim():null;
      if(!targetVersion)throw new Error("Trebell Code could not read the newest OpenCode release from the npm registry. Nothing was installed.");
    }else{
      const npm=await this.#runCommand("npm",["--version"],{timeoutMs:8000,environmentId});
      if(!npm.ok)throw new Error("npm is required to install this harness in the selected environment. Install Node.js/npm there first.");
      const viewed=await this.#runCommand("npm",["view",INSTALLABLE_PACKAGES.opencode,"version","--json"],{timeoutMs:20_000,environmentId});
      if(!viewed.ok)throw new Error((viewed.stderr||viewed.stdout||"Could not determine the compatible runtime version").trim().slice(-1000));
      try{targetVersion=String(JSON.parse(String(viewed.stdout||"").trim()))}catch{targetVersion=String(viewed.stdout||"").trim().replace(/^["']|["']$/g,"")}
    }
    const compatibility=runtimeCompatibility("opencode",targetVersion);
    if(!targetVersion||!compatibility?.version||["broken","unsupported","unknown"].includes(compatibility.status))throw new Error(compatibility?.message||("Trebell could not verify that OpenCode "+targetVersion+" is compatible. Nothing was installed."));
    // npm 12 skips install scripts unless allowed, and opencode-ai's script puts its binary in place (T3 allows that one package's).
    const step=native
      ?{command:local.binary,args:["upgrade",compatibility.version]}
      :{command:"npm",args:["install","-g",...(local?["--prefix",local.owner.prefix]:[]),"--allow-scripts="+INSTALLABLE_PACKAGES.opencode,INSTALLABLE_PACKAGES.opencode+"@"+compatibility.version]};
    return {instance,method:native?"native":"npm",binary:local?.binary||null,installedVersion:installed?.version||null,targetVersion:compatibility.version,compatibility,...step};
  }
  async #installOpenCode(environmentId){
    const plan=await this.openCodeInstallPlan({environmentId});
    const result={runtime:"opencode",packageName:INSTALLABLE_PACKAGES.opencode,method:plan.method,targetVersion:plan.targetVersion,compatibility:plan.compatibility};
    if(plan.installedVersion===plan.targetVersion)return {ok:true,...result,status:await this.probe(plan.instance,{environmentId}),output:`OpenCode ${plan.targetVersion} is already the newest OpenCode 1.x release.`};
    const ran=await this.#runCommand(plan.command,plan.args,{timeoutMs:180_000,environmentId});
    if(!ran.ok)throw new Error((ran.stderr||ran.stdout||("Could not install OpenCode "+plan.targetVersion)).trim().slice(-2000));
    // The OpenCode this profile runs must now report the version installed.
    const status=await this.probe(plan.instance,{environmentId}),running=parsedSemver(status.version)?.raw||null;
    if(running!==plan.targetVersion)throw new Error(`OpenCode ${plan.targetVersion} was installed, but the OpenCode this profile runs (${status.binary||plan.binary||"opencode"}) ${running?"still reports "+running:"did not start: "+(status.message||"no answer")}.`);
    return {ok:true,...result,status,output:(ran.stdout||ran.stderr||"").trim().slice(-2000)};
  }
  // Where the OpenCode a local profile runs really is, and who installed it there.
  #openCodeInstall(instance){
    const command=this.executable(instance),found=commandOnPath(command,{env:this.childEnv(instance),platform:this.platform});
    let binary=found?resolveWindowsCommandShim(found,{platform:this.platform}):null;
    if(binary)try{binary=realpathSync(binary)}catch{}
    return {binary:binary||command,owner:binary?openCodeInstallOwner(binary,{platform:this.platform}):null};
  }
  #openCodeCatalogs=new Map();
  // OpenCode's own answer for a profile (its connected models and providers, and its commands, skills and agents), from one managed
  // server or the profile's server, kept per binary and version. Readers at the same time share one read; a failed read is not kept.
  async #openCodeCatalog(instance,{version=null,reuseMs=OPENCODE_CATALOG_REUSE_MS}={}){
    const command=this.executable(instance),key=[instance.id,command,instance.serverUrl||"",version||""].join("|"),cached=this.#openCodeCatalogs.get(key);
    if(cached?.pending)return await cached.pending;
    if(cached&&Date.now()-cached.at<reuseMs)return cached.value;
    const pending=discoverOpenCodeModelCatalog({command,cwd:process.cwd(),env:this.childEnv(instance),serverUrl:instance.serverUrl||null});
    this.#openCodeCatalogs.set(key,{pending});
    try{
      const value=await pending;
      this.#openCodeCatalogs.set(key,{at:Date.now(),value});return value;
    }catch(error){
      if(this.#openCodeCatalogs.get(key)?.pending===pending)this.#openCodeCatalogs.delete(key);
      throw error;
    }
  }
  // A status check's provider list: the last one read for this binary and version, or a new read, which may take this long.
  async #openCodeStatusCatalog(instance,version){
    let timer;
    try{
      return await Promise.race([
        this.#openCodeCatalog(instance,{version,reuseMs:Number.POSITIVE_INFINITY}),
        new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`OpenCode did not answer within ${OPENCODE_STATUS_TIMEOUT_MS/1000} seconds.`)),OPENCODE_STATUS_TIMEOUT_MS);timer.unref?.()}),
      ]);
    }finally{clearTimeout(timer)}
  }
  acpArgs(instance,permissionMode="supervised",cwd=process.cwd()){
    if(instance.kind==="cursor"){
      if(permissionMode==="full")return ["--force","acp"];
      if(permissionMode==="auto")return ["--auto-review","acp"];
      return ["acp"];
    }
    if(instance.kind==="grok"){
      if(permissionMode==="full")return ["agent","--always-approve","stdio"];
      if(permissionMode==="auto")return ["--permission-mode","auto","agent","stdio"];
      // `grok agent` has no accept-edits mode (it treats acceptEdits as asking, T3 grokAcpSpawnArgs): it asks, and Trebell
      // answers its edit requests itself in the edits mode.
      return ["--permission-mode","default","agent","stdio"];
    }
    if(instance.kind==="opencode")return [];
    if(instance.kind==="antigravity")return this.platform==="linux"?["--uid="]:[];
    return [];
  }
  async probe(instanceOrKind,{environmentId=undefined}={}){
    const instance=typeof instanceOrKind==="string"?(this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind))):instanceOrKind;
    const def=RUNTIMES[instance.kind];
    if(instance.kind==="native")return {id:instance.id,kind:"native",name:def.name,available:true,installed:true,authenticated:null,protocol:"native",managed:true,version:null,binary:null,message:"Built into Trebell Code"};
    if(instance.kind==="codex"){
      const checked=await this.#run(instance,["--version"],{timeoutMs:6000,environmentId});
      if(!checked.ok){
        const missing=/ENOENT|not found|not recognized/i.test(String(checked.error||checked.stderr||""));
        return {id:instance.id,kind:"codex",name:def.name,available:false,installed:false,authenticated:false,protocol:"codex",version:null,binary:this.executable(instance,{environmentId}),message:missing?"Codex CLI was not found. Install it (npm install -g @openai/codex), then sign in with codex login.":(checked.stderr||checked.error||"Codex CLI is unavailable").trim().slice(0,500)};
      }
      const version=(checked.stdout||checked.stderr).trim().split(/\r?\n/)[0]||null;
      // Readiness is Codex's own account/read answer (T3 accountProbeStatus), so non-OpenAI model providers need no login.
      const probed=await this.#codexAccount(instance,environmentId);
      if(probed.error)return {id:instance.id,kind:"codex",name:def.name,available:false,installed:true,authenticated:null,protocol:"codex",version,binary:this.executable(instance,{environmentId}),message:("Codex app-server account check failed: "+probed.error).slice(0,500)};
      const status=codexAccountStatus(probed.result.account);
      return {id:instance.id,kind:"codex",name:def.name,available:status.ready,installed:true,authenticated:status.authenticated,protocol:"codex",version,binary:this.executable(instance,{environmentId}),message:status.message,account:{type:status.authType,label:status.label}};
    }
    const command=this.executable(instance);
    if(instance.kind==="antigravity"&&!this.activeEnvironment(environmentId)){
      try{await access(command)}catch{
        const desktopCandidates=this.platform==="win32"&&this.env.LOCALAPPDATA?[join(this.env.LOCALAPPDATA,"Programs","antigravity","Antigravity.exe")]:this.platform==="darwin"?["/Applications/Antigravity.app"]:[];
        let companionInstalled=false;for(const candidate of desktopCandidates){try{await access(candidate);companionInstalled=true;break}catch{}}
        return {id:instance.id,kind:instance.kind,name:def.name,available:false,installed:false,authenticated:false,protocol:def.protocol,managed:true,companionInstalled,message:companionInstalled?"Antigravity desktop is installed. Install the ACP runtime to use Antigravity inside Trebell Code.":"Antigravity ACP runtime is not installed"};
      }
      const install=await readAntigravityInstall({env:this.env});
      if(install?.version&&!instance.binaryPath?.trim()){
        const auth=await readAntigravityAuthState({env:this.childEnv(instance)}),oauth=/^oauth-/.test(String(auth.methodId||""));
        const authenticated=auth.configured?(oauth?auth.tokenPresent:null):false;
        const message=authenticated===true?"Managed Antigravity ACP runtime is installed and signed in."
          :authenticated===false?"Antigravity ACP is installed but needs its own sign-in before Trebell can use it."
          :`Antigravity ACP is configured for ${auth.methodId}; authentication will be verified when a session starts.`;
        return {id:instance.id,kind:instance.kind,name:def.name,available:authenticated!==false,installed:true,authenticated,protocol:def.protocol,managed:true,version:String(install.version),binary:command,account:auth.methodId?{authMethod:auth.methodId}:null,message};
      }
    }
    const versionArgs=instance.kind==="antigravity"?["--version"]:["--version"];
    const versionResult=await this.#run(instance,versionArgs,{timeoutMs:6000,environmentId});
    if(!versionResult.ok)return {id:instance.id,kind:instance.kind,name:def.name,available:false,installed:false,authenticated:false,protocol:def.protocol,managed:Boolean(def.managed),binary:command,message:runtimeProbeFailure(def,versionResult)};
    let authenticated=true,account=null,message="Ready";
    if(instance.kind==="claude"){
      const auth=await this.#run(instance,["auth","status"],{timeoutMs:8000,environmentId});
      try{account=JSON.parse(auth.stdout||"{}");authenticated=Boolean(account.loggedIn)}catch{authenticated=auth.ok}
      if(!authenticated)message="Claude Code is not authenticated. Run `claude auth login` and try again.";
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
    }else if(instance.kind==="opencode"&&!this.processSpawner(instance,environmentId)){
      const versionLine=(versionResult.stdout||versionResult.stderr).trim().split(/\r?\n/)[0]||null,compatibility=runtimeCompatibility("opencode",versionLine);
      const unavailable=message=>({id:instance.id,kind:instance.kind,name:def.name,available:false,installed:true,authenticated:null,protocol:def.protocol,managed:false,binary:command,version:versionLine,account:null,message,...(compatibility?{compatibility}:{})});
      // OpenCode 2.x serves another API (T3 Code drives it through a separate adapter), so nothing more runs on it.
      if(compatibility?.status==="unsupported")return unavailable(compatibility.message);
      // T3 Code's status check: the upstream providers OpenCode's own server reports connected (a managed server, or the profile's).
      let catalog;
      try{catalog=await this.#openCodeStatusCatalog(instance,compatibility?.version||null)}
      catch(error){return unavailable(("OpenCode could not list its providers: "+(error?.message||String(error))).slice(0,500))}
      const connected=Array.isArray(catalog?.connectedProviders)?catalog.connectedProviders.length:0;
      authenticated=connected>0?true:null;account={connectedProviders:connected};message=openCodeStatusMessage(connected,{external:Boolean(instance.serverUrl)});
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
    if(instance.kind==="native")return {models:[],metadata:[],source:"provider"};
    if(instance.kind==="codex")return {models:[],metadata:[],source:"codex"};
    const status=await this.probe(instance,{environmentId});if(!status.available)return {models:[],metadata:[],source:"unavailable",error:status.message};
    if(instance.kind==="opencode"){
      // Where the relay runs OpenCode through its SDK (the profile runs on this machine): the model list, and the commands, skills and
      // agents a new chat offers before its first message (T3 Code's provider snapshot).
      if(!this.processSpawner(instance,environmentId)){
        const catalog=await this.#openCodeCatalog(instance,{version:status.compatibility?.version||null});
        return {models:catalog.models,metadata:catalog.metadata,source:catalog.source,preferred:catalog.preferred,connectedProviders:catalog.connectedProviders,inventory:catalog.inventory};
      }
      // A remote OpenCode runs over ACP: its list is a session's model option, whose current value is OpenCode's default.
      return this.#acpModelList(instance,status,environmentId,"OpenCode",()=>this.#openCodeAcpModels(instance,environmentId));
    }
    if(instance.kind==="claude"){
      // The models Claude Code itself lists in its initialize answer, "default" (its own default model) first, as T3 Code reads them.
      let probe;
      try{probe=await this.claudeCapabilities(instance,{environmentId})}
      catch(error){return {models:[],metadata:[],source:"unavailable",error:"Claude Code could not list its models: "+(error?.message||String(error))}}
      const catalog=claudeModelCatalog(probe);
      // The same probe's slash commands and agents fill the composer's menus before a new chat's first message (T3 Code's
      // provider slash commands); a thread's own folder probe replaces them once it starts.
      return {models:catalog.models,metadata:catalog.metadata,preferred:catalog.preferred,source:"live",inventory:{commands:Array.isArray(probe?.commands)?probe.commands:[],agents:Array.isArray(probe?.agents)?probe.agents:[]}};
    }
    // Cursor lists its models with display names and per-model effort to a client with the parameterized model picker
    // (T3's ACP-era Cursor discovery); Grok Build lists them in its initialize answer (T3 discoverGrokMetadataViaAcpInitialize),
    // with its slash commands, which a new chat's menu shows before its thread exists (T3 grokSlashCommandsFromInitialize).
    if(instance.kind==="cursor")return this.#acpModelList(instance,status,environmentId,"Cursor",()=>withAcpProbe({
      ...this.#acpProbeOptions(instance,environmentId),capabilities:{...defaultAcpClientCapabilities(),_meta:{parameterizedModelPicker:true}},
    },async client=>cursorModelCatalog(await client.request("cursor/list_available_models",{},60_000))));
    if(instance.kind==="grok")return this.#acpModelList(instance,status,environmentId,"Grok Build",()=>withAcpProbe({
      ...this.#acpProbeOptions(instance,environmentId),meta:GROK_INITIALIZE_META,
    },(_client,initialized)=>({...grokModelCatalog(initialized),inventory:{commands:acpCommandsFromAvailable(initialized?._meta?.availableCommands,"grok")}})));
    if(instance.kind==="antigravity")return this.#antigravityModels(instance,environmentId);
    return {models:[],metadata:[],source:"unknown"};
  }
  #acpModelLists=new Map();
  // One ACP harness's model list, read where the profile runs and kept per profile, environment and harness version once it
  // has models; a failure is reported (never replaced by a stand-in list) and read again next time.
  async #acpModelList(instance,status,environmentId,label,load){
    const key=[instance.kind,instance.id,this.activeEnvironment(environmentId)?.id||"local",status?.version||""].join("|"),cached=this.#acpModelLists.get(key);
    let catalog;
    try{
      if(cached?.pending)catalog=await cached.pending;
      else if(cached&&Date.now()-cached.at<ACP_MODEL_LIST_REUSE_MS)catalog=cached.value;
      else{
        const pending=load();this.#acpModelLists.set(key,{pending});
        try{catalog=await pending}finally{if(this.#acpModelLists.get(key)?.pending===pending)this.#acpModelLists.delete(key)}
        if(catalog?.models?.length)this.#acpModelLists.set(key,{at:Date.now(),value:catalog});
      }
    }catch(error){return {models:[],metadata:[],source:"unavailable",error:`${label} could not list its models: ${error?.message||String(error)}`}}
    if(!catalog?.models?.length)return {models:[],metadata:[],source:"unavailable",error:`${label} did not list any models.`};
    return {models:catalog.models,metadata:catalog.metadata,preferred:catalog.preferred,source:"live",...(catalog.inventory?{inventory:catalog.inventory}:{})};
  }
  // How a short-lived listing process starts: where the profile runs, in the asking (supervised) launch mode; a local
  // Antigravity unpacks into a Trebell-owned temp folder from its own install folder, as its sessions do.
  #acpProbeOptions(instance,environmentId){
    const spawnProcess=this.processSpawner(instance,environmentId),command=this.executable(instance,{environmentId}),env=this.childEnv(instance);
    const local=!spawnProcess,cwd=local?process.cwd():(this.remoteIo(null,environmentId)?.root||"/");
    return {
      command,args:instance.kind==="opencode"?["acp"]:this.acpArgs(instance,"supervised",cwd),cwd,env,spawnProcess,
      processCwd:instance.kind==="antigravity"&&local&&command?dirname(command):null,
      runTempRoot:instance.kind==="antigravity"&&local?acpRuntimeTempRoot(env,"antigravity"):null,
      timeoutMs:instance.kind==="antigravity"?90_000:60_000,
    };
  }
  // A throwaway OpenCode session's model option; the session is deleted afterwards (over ACP when OpenCode offers it,
  // otherwise with its CLI once the ACP process has stopped, as the Git text session is).
  async #openCodeAcpModels(instance,environmentId){
    let sessionId=null,deleted=false;
    try{
      return await withAcpProbe(this.#acpProbeOptions(instance,environmentId),async(client,initialized)=>{
        const opened=await acpProbeSession(client,initialized,{cwd:client.cwd,timeoutMs:60_000});
        sessionId=opened.sessionId;deleted=opened.deleted;
        return acpSessionModelCatalog(opened.setup,{provider:"opencode",agent:"OpenCode"});
      });
    }finally{
      if(sessionId&&!deleted)await this.runCli(instance,["session","delete",sessionId],{environmentId,timeoutMs:15_000}).catch(()=>{});
    }
  }
  #antigravityModelLists=new Map();#antigravityRefreshes=new Map();#modelListeners=new Set();
  // Hears that a harness's model list changed after it was served, so an open composer can take the new list (T3 publishes
  // provider snapshots as they change). Returns the unsubscribe function.
  onModelsChanged(listener){
    if(typeof listener!=="function")return()=>{};
    this.#modelListeners.add(listener);return()=>{this.#modelListeners.delete(listener)};
  }
  // Antigravity's list comes from its sessions (T3 buildAntigravityModelsFromSession): every session start reports it here.
  rememberAcpSessionModels(instance,setup,{environmentId=undefined}={}){
    if(instance?.kind!=="antigravity")return;
    const catalog=antigravityModelCatalog(setup);if(!catalog.models.length)return;
    const environment=this.activeEnvironment(environmentId)?.id||null,key=[instance.id,environment||"local"].join("|");
    const served=this.#antigravityModelLists.get(key)||antigravitySeedCatalog(),signature=list=>JSON.stringify([list.models,list.preferred||null,list.metadata||[]]);
    this.#antigravityModelLists.set(key,catalog);
    if(signature(served)===signature(catalog))return;
    for(const listener of [...this.#modelListeners]){try{listener({runtime:"antigravity",instanceId:instance.id,environmentId:environment})}catch{}}
  }
  // Until a session has reported the account's list, T3's manifest list stands in and one throwaway local session reads the
  // real list in the background. Each launch unpacks Antigravity's bundle (about 1 GB), so listing never starts it again
  // (T3 AntigravityDriver: status checks never spawn; sessions and refreshes do).
  #antigravityModels(instance,environmentId){
    const key=[instance.id,this.activeEnvironment(environmentId)?.id||"local"].join("|"),known=this.#antigravityModelLists.get(key);
    if(known)return {models:known.models,metadata:known.metadata,preferred:known.preferred,source:"session"};
    if(!this.#antigravityRefreshes.has(key)&&!this.processSpawner(instance,environmentId)){
      const refresh=(async()=>{
        const folder=await mkdtemp(join(tmpdir(),"trebell-antigravity-models-"));
        try{
          const setup=await withAcpProbe(this.#acpProbeOptions(instance,environmentId),async(client,initialized)=>(await acpProbeSession(client,initialized,{cwd:folder,timeoutMs:90_000})).setup);
          this.rememberAcpSessionModels(instance,setup,{environmentId});
        }finally{await rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(()=>{})}
      })().catch(()=>{});
      this.#antigravityRefreshes.set(key,refresh);
    }
    return {...antigravitySeedCatalog(),source:"manifest"};
  }
  // Claude Code's no-prompt capability probe (models, commands, agents, account and plan usage), run where the profile runs and
  // shared for five minutes.
  claudeCapabilities(instance,{environmentId=undefined,cwd=null,includeUsage=true,fresh=false}={}){
    const profile=this.activeEnvironment(environmentId),spawnProcess=this.processSpawner(instance,environmentId);
    return this.claudeCapabilitiesCache.load({command:this.executable(instance,{environmentId}),cwd,env:this.childEnv(instance),spawnProcess,scope:spawnProcess?String(profile?.id||""):"",includeUsage},{fresh});
  }
  async usageLimits(instanceOrKind,{environmentId=undefined}={}){
    const instance=typeof instanceOrKind==="string"?(this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind))):instanceOrKind;
    if(instance.kind==="claude")return readAgentRuntimeUsage("claude",{readCapabilities:()=>this.claudeCapabilities(instance,{environmentId})});
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
      return {...safe,environmentKeys:Object.keys(environment||{}),approvedEnvironmentKeys:normalizeApprovedEnvironmentKeys(instance.approvedEnvironmentKeys)};
    });
    const installCommand=id=>id==="opencode"?"npm install -g "+INSTALLABLE_PACKAGES.opencode+" (OpenCode 1.x), or opencode upgrade for an OpenCode from its own installer":INSTALLABLE_PACKAGES[id]?"npm install -g "+INSTALLABLE_PACKAGES[id]:null;
    const definitions=this.definitions().map(def=>({...def,installable:Boolean(this.installable(def.id)),packageName:INSTALLABLE_PACKAGES[def.id]||null,installCommand:installCommand(def.id),canAuthenticate:["codex","claude","cursor","grok","opencode","antigravity"].includes(def.id)}));
    const active=this.activeInstance();return {selectedRuntime:this.activeRuntime(),selectedInstanceId:active.id,compatibleInstanceIds:this.compatibleInstanceIds(active),capabilities:this.capabilities(active),definitions,instances:publicInstances,statuses};
  }
}
