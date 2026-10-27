import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
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
import { discoverOpenCode2ModelCatalog, discoverOpenCodeModelCatalog } from "./opencode-agent-session.mjs";
import { resolveWindowsCommandShim, windowsCommandShimTarget } from "./windows-command-shim.mjs";
import { codexAccountStatus, readCodexAccount } from "./codex-account-probe.mjs";
import { remoteCodexHomeSetup } from "./environment-app-server.mjs";
import { claudeCapabilities, claudeModelCatalog } from "./claude-capabilities.mjs";
import { defaultAcpClientCapabilities } from "./acp-client.mjs";
import { acpProbeSession, acpSessionModelCatalog, antigravityModelCatalog, antigravitySeedCatalog, cursorModelCatalog, GROK_INITIALIZE_META, grokModelCatalog, withAcpProbe } from "./acp-model-catalog.mjs";
import { acpRuntimeTempRoot } from "./acp-runtime-temp.mjs";
import { acpCommandsFromAvailable } from "./acp-agent-session.mjs";
import { readMuseModelCatalog } from "./muse-model-catalog.mjs";

const RUNTIMES=Object.freeze({
  native:{id:"native",name:"Trebell Native",protocol:"native",command:null,multipleInstances:false,managed:true},
  codex:{id:"codex",name:"Codex",protocol:"codex",command:"codex",multipleInstances:true},
  claude:{id:"claude",name:"Claude Code",protocol:"claude",command:"claude",multipleInstances:true},
  cursor:{id:"cursor",name:"Cursor",protocol:"acp",command:"cursor-agent",multipleInstances:true},
  grok:{id:"grok",name:"Grok Build",protocol:"acp",command:"grok",multipleInstances:true},
  opencode:{id:"opencode",name:"OpenCode",protocol:"sdk",command:"opencode",multipleInstances:true},
  antigravity:{id:"antigravity",name:"Antigravity",protocol:"acp",command:null,multipleInstances:false,managed:true},
  muse:{id:"muse",name:"Muse Code",protocol:"msp",command:"muse",multipleInstances:true},
});

export function runtimeCapabilities(kind){
  return sharedRuntimeCapabilities(normalizeAgentRuntime(kind));
}

const CODEX_ACCOUNT_REUSE_MS=60_000;
// What a WSL or SSH host runs before a harness's own process or sign-in there: a Codex profile's own home (CODEX_HOME in Settings)
// or shadow home, made and exported as its app-server's is (environment-app-server.mjs), so its sign-in and its account check use
// the home its sessions run in. Nothing for another harness or for a profile with no home of its own.
function remoteRuntimeSetup(instance){return instance?.kind==="codex"?remoteCodexHomeSetup(instance):""}
// A probe's ready answer is reused this long: Settings polls the active harness every 5 s and every thread start probes again, and
// each probe launches the CLI one to three times. Settings' own listing (its open, Refresh and the follow-up of a sign-in), a switch
// and an install ask with fresh. An answer that the harness cannot run is asked again each time, as Codex's account read is, so a
// sign-in made outside Trebell lets the next chat start; a sign-out shows at the latest a minute later.
const PROBE_REUSE_MS=60_000;
// So is an answer that found no sign-in where the harness still runs (authenticated null) and the person signs in with the
// harness's own CLI: OpenCode with no provider connected, a Cursor, Grok or Claude Code sign-in Trebell could not read (Claude
// Code's `auth status` did not answer). Such a sign-in then shows at the next poll. Codex's null means its model provider needs no
// OpenAI sign-in, and Antigravity's that a session checks it.
const SIGN_IN_READ_BY_PROBE=new Set(["claude","cursor","grok","opencode"]);
const keptProbeAnswer=value=>Boolean(value?.available)&&!(value.authenticated==null&&SIGN_IN_READ_BY_PROBE.has(value.kind));
// A harness failure's message, with the advice of a probe answer that the harness cannot run or is not signed in after it ('Run
// `claude auth login` and try again.'): the harness's own words stay. A ready answer, or advice the message already has, adds none.
export function withProbeAdvice(message,status){
  // So does one whose version check did not answer (versionCheckFailed): its words are all a failed chat has of why.
  const said=String(message||"").trim(),advice=status&&(status.available===false||status.authenticated===false||status.versionCheckFailed)?String(status.message||"").trim():"";
  if(!advice||said.includes(advice))return message;
  return said?`${/[.!?…]$/.test(said)?said:said+"."} ${advice}`:advice;
}
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
// Muse Code runs where Trebell runs; a WSL or SSH environment has no Muse Code of Trebell's.
const MUSE_LOCAL_ONLY="Muse Code runs only on this machine in Trebell Code. Switch to the local environment to use it.";
// A model list reads OpenCode's provider list again once the last read is this old. A status check (every thread start makes one)
// reuses the last read of the same binary and version, and makes one only when there is none.
const OPENCODE_CATALOG_REUSE_MS=10_000;
const OPENCODE_STATUS_TIMEOUT_MS=20_000;
const OPENCODE_NPM_REGISTRY_LATEST="https://registry.npmjs.org/opencode-ai/latest";

const RUNTIME_COMPATIBILITY=Object.freeze({
  opencode:Object.freeze({
    recommendedRange:">=1.14.19 <3.0.0",
    ranges:Object.freeze([
      Object.freeze({range:"<1.14.19",status:"broken"}),
      Object.freeze({range:">=3.0.0",status:"unsupported"}),
      Object.freeze({range:">=1.14.19 <3.0.0",status:"supported"}),
    ]),
  }),
  // T3 Code's model manifest: Muse Code 1.4.2 and later, compared without its -R<revision> (runtimeCompatibility).
  muse:Object.freeze({
    recommendedRange:">=1.4.2",
    ranges:Object.freeze([
      Object.freeze({range:">=1.4.2",status:"supported"}),
      Object.freeze({range:"<1.4.2",status:"unknown"}),
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
// How long a harness's --version may take (T3's budgets): Claude Code's native CLI can take longer to start on a cold Windows start
// or while Defender scans it, and an OpenCode behind its npm shim several seconds. Codex keeps 6 s: one that runs out of time leaves
// the answer to its account read, which has 20 s of its own (T3's one Codex check), so a longer --version would only add waiting.
const VERSION_CHECK_TIMEOUT_MS=Object.freeze({claude:20_000,opencode:10_000});
const versionCheckTimeoutMs=kind=>VERSION_CHECK_TIMEOUT_MS[kind]||6000;
// Why a --version did not answer: "missing" only when its command is not there (the spawn's own ENOENT, cmd.exe's "is not
// recognized" line, or the 127 a shell or env exits with then), never for an ENOENT or "command not found" that a CLI which ran
// printed itself; "timeout" when it ran out of time; "spawn" when it could not start (spawn EINVAL for a launcher Node cannot run);
// and "exit" when it ran and ended with an error code, or was stopped by a signal (a crash, the OOM killer).
function versionCheckFailure(result={}){
  const error=String(result.error||"");
  if(result.code===127||/\bENOENT\b/.test(error)||/is not recognized as an internal or external command/i.test(String(result.stderr||"")))return "missing";
  if(error==="probe timed out")return "timeout";
  return error?"spawn":"exit";
}
// How a --version that ran ended: its exit code, or the signal that stopped it, with the first line it printed.
function versionCheckEnded(result){
  const said=stripAnsi(String(result.stderr||result.stdout||"")).split(/\r?\n/).map(line=>line.trim()).find(Boolean);
  const ended=Number.isInteger(result.code)?`exited with code ${result.code}`:`was stopped${result.signal?" by "+result.signal:""}`;
  return said?`${ended}: ${said}`:ended+".";
}
// What a harness whose --version timed out, exited with an error or was stopped says: that it is installed, and what its check did.
function versionCheckMessage(def,kind,command,result){
  const name=def?.command||String(command||"").split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat)$/i,"")||kind;
  if(versionCheckFailure(result)==="timeout")return `${def.name} is installed but did not answer \`${name} --version\` within ${versionCheckTimeoutMs(kind)/1000} seconds.`;
  return `${def.name} is installed but \`${name} --version\` ${versionCheckEnded(result)}`.slice(0,500);
}
// An answer whose --version did not answer and that says nothing of a sign-in: asking again only waits for the whole check again, so
// probe keeps it, an OpenCode's too, which cannot start without its version. (A Codex one that found no sign-in is asked again: its
// account read answered it.)
const versionCheckOnly=value=>Boolean(value?.versionCheckFailed)&&value.authenticated==null;
// A Claude Code profile that runs through a router or gateway: an http(s) ANTHROPIC_BASE_URL whose host is not api.anthropic.com.
function claudeCustomEndpoint(env={}){
  let url=null;try{url=new URL(String(env?.ANTHROPIC_BASE_URL||"").trim())}catch{}
  return Boolean(url&&/^https?:$/.test(url.protocol)&&url.hostname&&url.hostname!=="api.anthropic.com");
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
// Muse Code's version as it names its builds, X.Y.Z-R<revision> ("Muse Code 1.4.13 (1.4.13-R6996.1)" is 1.4.13-R6996.1), else a
// plain X.Y.Z (T3 parseMuseVersion); the shared reading stops at the -R.
export function parseMuseVersion(output){
  const value=stripAnsi(output);
  return value.match(/\b\d+\.\d+\.\d+-R\d+(?:\.\d+)?\b/)?.[0]||value.match(/\b\d+\.\d+\.\d+\b/)?.[0]||null;
}
// Meta's own installers for Muse Code (https://dev.meta.ai/docs/muse-code): Trebell does not install it.
export function museInstallCommand(platform=process.platform){
  return platform==="win32"?"irm https://dev.meta.ai/install.ps1 | iex":"curl -fsSL https://dev.meta.ai/install.sh | sh";
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
// A local binary's files (its path, modification time and size) as a version check or a probe answer saw them; null for none.
const binarySignature=paths=>paths?.length?JSON.stringify(paths.map(path=>{try{const info=statSync(path);return [path,info.mtimeMs,info.size]}catch{return [path,null]}})):null;
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
  const parsed=parsedSemver(normalizeAgentRuntime(kind)==="muse"?String(parseMuseVersion(version)||"").replace(/-R\d+(?:\.\d+)?$/,""):version);
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
    // signal: what stopped a process that ended without an exit code (code is null then).
    const finish=(code,error=null,signal=null)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({ok:code===0,code,signal,error:error?.message||null,stdout,stderr})};
    child.stdout?.on("data",chunk=>{stdout+=String(chunk);if(stdout.length>512_000)stdout=stdout.slice(-512_000)});
    child.stderr?.on("data",chunk=>{stderr+=String(chunk);if(stderr.length>512_000)stderr=stderr.slice(-512_000)});
    child.once("error",error=>{if(!timedOut)finish(null,error)});child.once("exit",(code,signal)=>{if(!timedOut)finish(code,null,signal)});
    const timer=setTimeout(()=>{timedOut=true;void terminateProcessTree(child).finally(()=>finish(null,new Error("probe timed out")))},timeoutMs);
  });
}

function defaultInstance(kind){return {id:`${kind}-default`,kind,displayName:RUNTIMES[kind].name,enabled:true,binaryPath:null,homePath:null,shadowHomePath:null,serverUrl:null,autoCompactWindow:null,environment:{}}}

export function runtimeExecutableCandidates(kind,{env=process.env,platform=process.platform}={}){
  // Meta's installers put Muse Code's launcher in MUSE_INSTALL_DIR, else %LOCALAPPDATA%\Programs\muse (install.ps1) or ~/.local/bin
  // (install.sh): the PATH entry they add reaches only programs started after the install.
  if(kind==="muse"){
    const folder=String(env.MUSE_INSTALL_DIR||"").trim()||(platform==="win32"?(String(env.LOCALAPPDATA||"").trim()?join(String(env.LOCALAPPDATA).trim(),"Programs","muse"):""):(String(env.HOME||"").trim()?join(String(env.HOME).trim(),".local","bin"):""));
    return folder?[join(folder,platform==="win32"?"muse.cmd":"muse")]:[];
  }
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
  constructor({state,env=process.env,environments=null,platform=process.platform,arch=process.arch,fetchImpl=globalThis.fetch,claudeCapabilitiesCache=claudeCapabilities,now=Date.now,runFn=run}={}){this.state=state;this.env=env;this.environments=environments;this.platform=platform;this.arch=arch;this.fetchImpl=fetchImpl;this.claudeCapabilitiesCache=claudeCapabilitiesCache;this.now=now;this.runFn=runFn}
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
    // A Muse Code picked while its last list had no models, or could not be read, reads it again: the person may have signed in since.
    if(kind==="muse")this.#museCatalogDue(instance,{keepListed:true});
    const status=await this.probe(instance,{fresh:true});
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
    // Meta's launcher would otherwise update Muse Code in the foreground, or start its updater, each time Trebell runs it (T3 Code
    // sets it too); a profile's own value wins.
    if(instance?.kind==="muse"&&env.MUSE_NO_AUTO_UPDATE==null)env.MUSE_NO_AUTO_UPDATE="1";
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
    const environmentNames=this.childEnvironmentKeys(instance),prelude=remoteRuntimeSetup(instance);
    // options.environment sets explicit variables for this one process (e.g. a restricted harness config); environmentNames only forwards the remote shell's own values.
    return options=>this.environments.spawnArgv(profile.id,{command:this.executable(instance,{environmentId:profile.id}),args:options.args||[],cwd:options.cwd||profile.cwd||null,stdio:options.stdio||["pipe","pipe","pipe"],environmentNames,...(prelude?{prelude}:{}),...(options.environment&&typeof options.environment==="object"?{environment:options.environment}:{})});
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
  // What the harness's own short commands on this machine run with (its version and sign-in checks, its model listing, runCli):
  // its child environment, with Grok's updater off for that one process (T3 grokProbeEnvironment), so a Settings poll neither opens
  // npm's console windows on Windows nor replaces the Grok binary underneath. Sessions, Git text and the sign-in terminal keep
  // childEnv, and a host's commands run with the host's own variables.
  #probeEnv(instance){const env=this.childEnv(instance);return instance?.kind==="grok"?{...env,GROK_DISABLE_AUTOUPDATER:"1"}:env}
  async #run(instance,args,{timeoutMs=6000,cwd=null,environmentId=undefined}={}){
    const profile=this.activeEnvironment(environmentId);
    if(profile&&profile.type!=="local"&&this.environments){
      const result=await this.environments.executeArgv(profile.id,{command:this.executable(instance,{environmentId:profile.id}),args,cwd:cwd||profile.cwd||"",timeoutMs,environmentNames:this.childEnvironmentKeys(instance)});
      return {ok:result.exitCode===0,code:result.exitCode,error:result.timedOut?"probe timed out":null,stdout:result.stdout||"",stderr:result.stderr||""};
    }
    return this.runFn(this.executable(instance),args,{env:this.#probeEnv(instance),cwd:cwd||process.cwd(),timeoutMs});
  }
  // One short-lived `codex app-server` per profile answers account/read. Ready answers are reused briefly because the
  // bootstrap payload probes the active profile on every request; concurrent probes share one process.
  #codexAccounts=new Map();
  async #codexAccount(instance,environmentId=undefined){
    const profile=this.activeEnvironment(environmentId),spawner=this.processSpawner(instance,environmentId);
    const command=this.executable(instance,{environmentId}),env=spawner?null:this.childEnv(instance);
    // The answer is about the home it was read in: the profile's CODEX_HOME here, its home setup on a remote host.
    const key=[profile?.id||"local",instance.id,command,spawner?remoteRuntimeSetup(instance):env?.CODEX_HOME||""].join("|"),cached=this.#codexAccounts.get(key);
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
      // Muse Code's own sign-in: a code approved in the browser with a Meta account (`muse login`).
      :instance.kind==="muse"?["login"]
      :null;
    if(!args)throw new Error((RUNTIMES[instance.kind]?.name||instance.kind)+" does not expose an interactive Trebell sign-in command.");
    // Codex signs in into its profile's home: one under a user this machine does not have is refused before the sign-in writes
    // anywhere (on an SSH or WSL host the home is the host's to expand, and the sign-in terminal runs prelude first to set it up).
    const profile=this.activeEnvironment(environmentId),remote=Boolean(profile&&profile.type!=="local");
    if(instance.kind==="muse"&&remote)throw new Error(MUSE_LOCAL_ONLY);
    if(instance.kind==="codex"&&!remote){
      const layout=resolveCodexHomeLayout({homePath:instance.homePath,shadowHomePath:instance.shadowHomePath,defaultHome:String(this.env.CODEX_HOME||"").trim()||join(homedir(),".codex")});
      if(layout.error)throw new Error(layout.error);
    }
    const prelude=remote?remoteRuntimeSetup(instance):"";
    return {runtime:instance.kind,instanceId:instance.id,name:RUNTIMES[instance.kind]?.name||instance.kind,command:this.executable(instance,{environmentId}),args,...(prelude?{prelude}:{})};
  }
  // One install or update of a harness runs at a time: a second one asked for meanwhile (from Settings opened again, or another
  // window) is refused, as two npm installs of one package at once can leave it half replaced. The refusal names the install that
  // runs (code, installId). Each install has an id (the window that asks gives it), and the harness list names the installs on their
  // way and how the last one of each harness ended (installs()), so a window that did not start one (another tab, or the window
  // reloaded, which forgets the install it started) says Installing… on its row and can wait for its answer (waitForInstall).
  #installing=new Map();#installEnded=new Map();
  async install(kind,{environmentId=undefined,id=null}={}){
    const target=this.installable(kind);const normalized=normalizeAgentRuntime(kind);
    if(!target)throw new Error((RUNTIMES[normalized]?.name||String(kind||"Harness"))+" is not installable from Trebell Code");
    const running=this.#installing.get(target.runtime);
    if(running){
      const error=new Error((RUNTIMES[target.runtime]?.name||target.runtime)+" is already being installed or updated. Wait for it to finish first.");
      error.code="install-running";error.installId=running.id;throw error;
    }
    const entry={id:String(id||"")||randomUUID(),startedAt:Date.now(),done:null};
    entry.done=this.#install(target,environmentId);this.#installing.set(target.runtime,entry);
    try{
      const value=await entry.done;this.#installEnded.set(target.runtime,{id:entry.id,ok:true,error:null,endedAt:Date.now()});return value;
    }catch(error){
      this.#installEnded.set(target.runtime,{id:entry.id,ok:false,error:String(error?.message||error),endedAt:Date.now()});throw error;
    }finally{this.#installing.delete(target.runtime)}
  }
  // The installs on their way ({runtime,id,startedAt}) and how the last one of each harness ended ({runtime,id,ok,error,endedAt}).
  installs(){
    return {running:[...this.#installing].map(([runtime,{id,startedAt}])=>({runtime,id,startedAt})),ended:[...this.#installEnded].map(([runtime,ended])=>({runtime,...ended}))};
  }
  // The answer of the install of this harness on its way, as install() gives it (a failure rejects with its error), or null when none runs.
  waitForInstall(kind){
    const runtime=this.installable(kind)?.runtime;return runtime?this.#installing.get(runtime)?.done||null:null;
  }
  async #install(target,environmentId){
    if(target.runtime==="antigravity"){
      if(this.activeEnvironment(environmentId))throw new Error("Managed Antigravity ACP installation is currently available only on the local machine");
      const installed=await installAntigravityRuntime({env:this.env,fetchImpl:this.fetchImpl,platform:this.platform,arch:this.arch});
      const instance=this.instances().find(item=>item.kind==="antigravity"&&item.id==="antigravity-default")||defaultInstance("antigravity");
      const status=await this.probe(instance,{environmentId:null,fresh:true});
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
    const status=await this.probe(instance,{environmentId,fresh:true});
    return {ok:true,runtime:target.runtime,packageName:target.packageName,targetVersion,compatibility,status,output:(result.stdout||result.stderr||"").trim().slice(-2000)};
  }
  // What installing or updating OpenCode runs, decided without changing anything (T3 openCodeUpdateFor): an OpenCode from its own
  // installer updates with `opencode upgrade <version>`, npm's global opencode-ai through npm into the same prefix, and a machine (or
  // remote environment) without OpenCode gets opencode-ai through npm. The target is the newest opencode-ai release, which must be a
  // supported 1.x. OpenCode 2.x, and an OpenCode Trebell cannot tell who installed, are left alone.
  async openCodeInstallPlan({environmentId=undefined}={}){
    const instances=this.instances();
    const instance=instances.find(item=>item.kind==="opencode"&&item.id==="opencode-default")||instances.find(item=>item.kind==="opencode")||defaultInstance("opencode");
    const checked=await this.#run(instance,["--version"],{timeoutMs:versionCheckTimeoutMs("opencode"),environmentId});
    // A check that did not answer for any reason but a command that is not there says nothing of which OpenCode is there: planned as
    // if none were, the update would put a separate OpenCode 1.x beside a 2.x or an installer's copy, which the next start prefers.
    const failure=checked.ok?null:versionCheckFailure(checked);
    if(failure&&failure!=="missing"){
      const reason=failure==="spawn"?runtimeProbeFailure(RUNTIMES.opencode,checked):failure==="timeout"?`\`opencode --version\` did not answer within ${versionCheckTimeoutMs("opencode")/1000} seconds.`:`\`opencode --version\` ${versionCheckEnded(checked)}`;
      throw new Error(`Trebell Code could not read the version of the OpenCode it would update: ${/[.!?…]$/.test(reason)?reason:reason+"."} Nothing was installed.`);
    }
    const installed=checked.ok?runtimeCompatibility("opencode",(checked.stdout||checked.stderr).trim().split(/\r?\n/)[0]||null):null;
    if(installed?.version?.startsWith("2."))throw new Error(`This OpenCode is ${installed.version}. Trebell Code supports OpenCode 2.x but will not replace it with the separate OpenCode 1.x npm package. Update this 2.x install with opencode upgrade or the package manager that installed it.`);
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
    if(plan.installedVersion===plan.targetVersion)return {ok:true,...result,status:await this.probe(plan.instance,{environmentId,fresh:true}),output:`OpenCode ${plan.targetVersion} is already the newest OpenCode 1.x release.`};
    const ran=await this.#runCommand(plan.command,plan.args,{timeoutMs:180_000,environmentId});
    if(!ran.ok)throw new Error((ran.stderr||ran.stdout||("Could not install OpenCode "+plan.targetVersion)).trim().slice(-2000));
    // The OpenCode this profile runs must now report the version installed.
    const status=await this.probe(plan.instance,{environmentId,fresh:true}),running=parsedSemver(status.version)?.raw||null;
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
    const discover=String(version||"").startsWith("2.")?discoverOpenCode2ModelCatalog:discoverOpenCodeModelCatalog;
    const pending=discover({command,cwd:process.cwd(),env:this.childEnv(instance),serverUrl:instance.serverUrl||null});
    this.#openCodeCatalogs.set(key,{pending});
    try{
      const value=await pending;
      const emptyV2=String(version||"").startsWith("2.")&&!(Array.isArray(value?.models)&&value.models.length);
      if(emptyV2)this.#openCodeCatalogs.delete(key);else this.#openCodeCatalogs.set(key,{at:Date.now(),value});return value;
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
  #probes=new Map();
  // One answer per profile and environment: callers that ask while it runs share it, and later ones reuse a ready answer for
  // PROBE_REUSE_MS. An answer that the harness cannot run is not kept (nor one that found no sign-in, keptProbeAnswer), but one
  // whose version check did not answer is (versionCheckFailed when it may start, versionCheckOnly when it is an OpenCode's, which
  // cannot start without its version): the page load, Settings' poll, every chat start, Git text and the model list wait for the
  // check, so a hung CLI costs its wait once a minute, not on each of them, and Settings' Refresh or a switch asks again at once. So
  // is a Claude Code profile with a custom API endpoint, whose sign-in only a session can check (`claude auth status` has nothing new
  // to say). And a caller that joined another answer that cannot run asks again (or joins a probe started after it asked): a thread
  // start refuses on it, and the person may just have signed in outside Trebell, or its check timed out under load. fresh starts a
  // new one, which the next callers share. Each caller gets its own copy.
  async probe(instanceOrKind,{environmentId=undefined,fresh=false}={}){
    const instance=typeof instanceOrKind==="string"?(this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind))):instanceOrKind;
    if(instance.kind==="native")return this.#probeNow(instance,{environmentId});
    const key=this.#probeKey(instance,environmentId),owner=this.#probeOwner(instance,environmentId),cached=this.#probes.get(key);
    if(!fresh&&cached?.pending){
      const value=await cached.pending;if(value?.available||versionCheckOnly(value))return structuredClone(value);
      const next=this.#probes.get(key);if(next?.pending&&next.pending!==cached.pending)return structuredClone(await next.pending);
    }else if(!fresh&&cached&&this.now()-cached.at<PROBE_REUSE_MS&&binarySignature(cached.binary)===cached.signature)return structuredClone(cached.value);
    // A local binary replaced since (npm i -g, the harness's own updater) makes its version check due, so its answer is not kept
    // past that either. Read before the probe runs, so a binary replaced while it runs makes the next caller ask again.
    const binary=this.#binaryPaths(instance,environmentId),signature=binarySignature(binary);
    const pending=this.#probeNow(instance,{environmentId,fresh});this.#probes.set(key,{pending,owner});
    try{
      const value=await pending;
      if(this.#probes.get(key)?.pending===pending){if(value?.available&&(value.versionCheckFailed||value.account?.type==="customEndpoint"||keptProbeAnswer(value))||versionCheckOnly(value))this.#probes.set(key,{at:this.now(),value,binary,signature,owner});else this.#probes.delete(key)}
      return structuredClone(value);
    }catch(error){
      if(this.#probes.get(key)?.pending===pending)this.#probes.delete(key);
      throw error;
    }
  }
  #probeKey(instance,environmentId=undefined){return JSON.stringify([this.activeEnvironment(environmentId)?.id||"local",instance])}
  // The runtime profile and environment an answer is about, whatever fields the profile had when it was asked (#probeKey holds them).
  #probeOwner(instance,environmentId=undefined){return instance?.id==null?null:JSON.stringify([this.activeEnvironment(environmentId)?.id||"local",instance.kind,String(instance.id)])}
  #rechecks=new Map();
  // A harness that failed where it runs (its session did not start, or a turn ended in its error) is asked again: the ready answer
  // kept for PROBE_REUSE_MS may be one it no longer gives, as after a `claude auth logout` in the person's own terminal, and the next
  // poll and session start must not read it. The kept answer goes at once and one fresh probe takes its place, which the failures
  // of the same profile and environment that arrive while it runs share: a harness that keeps failing is asked at most once per
  // failure. The relay adds the answer's advice to the harness's error (agent-relay harnessFailureMessage). Trebell Native runs in
  // this process and has no CLI to ask.
  recheck(instanceOrKind,{environmentId=undefined}={}){
    const instance=typeof instanceOrKind==="string"?(this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind))):instanceOrKind;
    if(instance.kind==="native")return Promise.resolve(null);
    const key=this.#probeKey(instance,environmentId),running=this.#rechecks.get(key);
    if(running)return running.then(value=>structuredClone(value));
    // A session keeps the profile it started with. Once Settings has saved that profile since (any field), the poll and the next
    // session start read the answer kept under its new fields: that one goes too, so they ask the harness again.
    const owner=this.#probeOwner(instance,environmentId);
    if(owner)for(const [other,entry] of this.#probes)if(other!==key&&entry.owner===owner&&!entry.pending)this.#probes.delete(other);
    // Muse Code's model list is read again with it: a failed turn may be a sign-out.
    if(instance.kind==="muse")this.#museCatalogDue(instance);
    const pending=this.probe(instance,{environmentId,fresh:true}),settled=()=>{if(this.#rechecks.get(key)===pending)this.#rechecks.delete(key)};
    this.#rechecks.set(key,pending);pending.then(settled,settled);
    return pending;
  }
  #versions=new Map();
  // A local binary's --version answer, kept until the file changes (its path, modification time and size). A launcher script can
  // start a newer build without changing itself (Cursor's starts the newest folder in versions beside it), so its folder and that
  // folder are part of the key. Remote profiles and failed checks are not kept.
  #binaryPaths(instance,environmentId=undefined){
    const profile=this.activeEnvironment(environmentId),local=!(profile&&profile.type!=="local"&&this.environments);
    const command=local?this.executable(instance):null,found=command?commandOnPath(command,{env:this.childEnv(instance),platform:this.platform}):null;
    const paths=!found?[]:/\.(?:cmd|bat|ps1)$/i.test(found)?[found,dirname(found),join(dirname(found),"versions")]:[found];
    // Meta's launcher, ~/.local/bin/muse as much as muse.cmd, keeps the Muse Code it runs beside itself (muse-bin-<version>, named in
    // .muse-version) and updates it without changing itself.
    if(found&&instance?.kind==="muse")for(const path of [dirname(found),join(dirname(found),".muse-version")])if(!paths.includes(path))paths.push(path);
    return paths;
  }
  async #versionCheck(instance,{environmentId=undefined,fresh=false}={}){
    const signature=binarySignature(this.#binaryPaths(instance,environmentId));
    const cached=signature?this.#versions.get(instance.id):null;
    if(!fresh&&cached?.signature===signature)return cached.result;
    const result=await this.#run(instance,["--version"],{timeoutMs:versionCheckTimeoutMs(instance.kind),environmentId});
    if(signature&&result.ok)this.#versions.set(instance.id,{signature,result});
    return result;
  }
  async #probeNow(instance,{environmentId=undefined,fresh=false}={}){
    const def=RUNTIMES[instance.kind];
    if(instance.kind==="native")return {id:instance.id,kind:"native",name:def.name,available:true,installed:true,authenticated:null,protocol:"native",managed:true,version:null,binary:null,message:"Built into Trebell Code"};
    if(instance.kind==="codex"){
      const checked=await this.#versionCheck(instance,{environmentId,fresh}),failure=checked.ok?null:versionCheckFailure(checked),host=Boolean(failure&&this.processSpawner(instance,environmentId));
      // Here a --version that ran out of time leaves the answer to Codex's account read, which has 20 s of its own and names the
      // version (T3 asks only that). On a host (SSH, WSL) a failed check is unavailable as before (see below).
      if(failure&&(host||failure!=="timeout")){
        const missing=failure==="missing";
        return {id:instance.id,kind:"codex",name:def.name,available:false,installed:!host&&!missing,authenticated:false,protocol:"codex",version:null,binary:this.executable(instance,{environmentId}),message:missing?"Codex CLI was not found. Install it (npm install -g @openai/codex), then sign in with codex login.":(checked.stderr||checked.error||"Codex CLI is unavailable").trim().slice(0,500)};
      }
      const version=failure?null:(checked.stdout||checked.stderr).trim().split(/\r?\n/)[0]||null;
      // Readiness is Codex's own account/read answer (T3 accountProbeStatus), so non-OpenAI model providers need no login.
      const probed=await this.#codexAccount(instance,environmentId);
      if(probed.error)return {id:instance.id,kind:"codex",name:def.name,available:false,installed:true,authenticated:null,protocol:"codex",version,binary:this.executable(instance,{environmentId}),message:("Codex app-server account check failed: "+probed.error).slice(0,500)};
      const status=codexAccountStatus(probed.result.account);
      return {id:instance.id,kind:"codex",name:def.name,available:status.ready,installed:true,authenticated:status.authenticated,protocol:"codex",version:version??probed.result.version??null,binary:this.executable(instance,{environmentId}),message:status.message,account:{type:status.authType,label:status.label},...(failure?{versionCheckFailed:true}:{})};
    }
    if(instance.kind==="muse")return this.#museStatus(instance,{environmentId,fresh});
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
    const versionResult=await this.#versionCheck(instance,{environmentId,fresh}),failure=versionResult.ok?null:versionCheckFailure(versionResult),host=Boolean(failure&&this.processSpawner(instance,environmentId));
    // Here a --version that ran out of time (a cold start, a scan) or exited with an error says nothing of whether the harness
    // runs: it stays installed and may start (T3 refuses no turn on its check), and its own error says why if it then fails
    // (withProbeAdvice). Its sign-in is not read, and the answer is kept for a minute (probe). On a host (SSH, WSL) a
    // failed check is unavailable as before: ssh's own failures (a host it cannot reach) are no answer of the harness's. OpenCode
    // is not ready without its version: its 1.x and 2.x servers each speak only their own client, which the relay, Git text and its
    // model list choose by that version. Its answer is kept for a minute too (probe).
    if(!host&&(failure==="timeout"||failure==="exit")){
      const versionless=instance.kind==="opencode",said=versionCheckMessage(def,instance.kind,command,versionResult);
      return {id:instance.id,kind:instance.kind,name:def.name,available:!versionless,installed:true,authenticated:null,protocol:def.protocol,managed:Boolean(def.managed),binary:command,version:null,account:null,versionCheckFailed:true,message:versionless?`${/[.!?…]$/.test(said)?said:said+"."} Trebell Code needs its version (1.x or 2.x) to start it.`:said};
    }
    if(failure)return {id:instance.id,kind:instance.kind,name:def.name,available:false,installed:!host&&failure!=="missing",authenticated:false,protocol:def.protocol,managed:Boolean(def.managed),binary:command,message:runtimeProbeFailure(def,versionResult)};
    let authenticated=true,account=null,message="Ready";
    if(instance.kind==="claude"){
      // `claude auth status` prints {"loggedIn":…} (exiting 1 when signed out). A check that printed nothing, or was cut off before it
      // printed that (it timed out under load or over a slow link, did not launch, or was killed), leaves the sign-in unknown, as an
      // unread Cursor or Grok sign-in is: it never tells a signed-in person to sign in, and the answer is not kept.
      const auth=await this.#run(instance,["auth","status"],{timeoutMs:8000,environmentId}),said=String(auth.stdout||"").trim();
      let answer=null;try{answer=JSON.parse(said)}catch{}
      if(answer&&typeof answer==="object"){account=answer;authenticated=Boolean(answer.loggedIn)}
      else if(!said||auth.error||auth.code===null)authenticated=null;
      // A CLI that answers in words: its exit code says.
      else authenticated=auth.ok;
      // A profile here that runs through a router or gateway has no Claude sign-in for `claude auth status` to find: the endpoint
      // holds its credentials, which only a session can check (T3 skips the signed-out verdict for it).
      const endpoint=authenticated===false&&!this.processSpawner(instance,environmentId)&&claudeCustomEndpoint(this.childEnv(instance));
      if(endpoint){authenticated=null;account={...(account||{}),type:"customEndpoint",label:"Custom API endpoint"};message="Claude Code is configured for a custom API endpoint; authentication will be verified when a session starts."}
      else if(authenticated===false)message="Claude Code is not authenticated. Run `claude auth login` and try again.";
      else if(authenticated==null)message="Claude Code is installed, but Trebell could not verify its authentication status.";
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
        const signedIn=async()=>{const models=await this.#run(instance,["models"],{timeoutMs:10_000,environmentId});return models.ok?parseGrokModelsAuth((models.stdout||"")+"\n"+(models.stderr||"")):null};
        // Grok prints the logged-out line for an access token that has just expired, then refreshes it in the same process: a
        // second `grok models` tells that from a sign-out (T3 checkGrokProviderStatus). One that reads nothing keeps the first.
        authenticated=await signedIn();
        if(authenticated===false)authenticated=(await signedIn())??false;
        if(authenticated===false)message="Grok CLI is installed but not logged in. Run grok login.";
        else if(authenticated==null)message="Grok CLI is installed, but Trebell could not verify its authentication status.";
      }
    }else if(instance.kind==="opencode"&&!this.processSpawner(instance,environmentId)){
      const versionLine=(versionResult.stdout||versionResult.stderr).trim().split(/\r?\n/)[0]||null,compatibility=runtimeCompatibility("opencode",versionLine);
      const unavailable=message=>({id:instance.id,kind:instance.kind,name:def.name,available:false,installed:true,authenticated:null,protocol:def.protocol,managed:false,binary:command,version:versionLine,account:null,message,...(compatibility?{compatibility}:{})});
      if(compatibility?.status==="unsupported")return unavailable(compatibility.message);
      // T3 Code's status check: the upstream providers OpenCode's matching 1.x/2.x server adapter reports connected.
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
  // Muse Code's status check (T3 checkMuseProviderStatus): `muse --version`, then the models a short read-only host lists. The Muse
  // Session Protocol says nothing of the sign-in and Muse lists Meta's models only once signed in, so a list with models is ready
  // with the sign-in unknown (a turn checks it), and an empty one is not. A failed version check starts no host.
  async #museStatus(instance,{environmentId=undefined,fresh=false}={}){
    const def=RUNTIMES.muse,binary=this.executable(instance,{environmentId});
    const answer=fields=>({id:instance.id,kind:"muse",name:def.name,protocol:def.protocol,managed:false,binary,authenticated:null,account:null,...fields});
    if(this.processSpawner(instance,environmentId))return answer({available:false,installed:false,version:null,message:MUSE_LOCAL_ONLY});
    const checked=await this.#versionCheck(instance,{environmentId,fresh}),said=(checked.stdout||"")+"\n"+(checked.stderr||"");
    if(!checked.ok){
      if(/ENOENT|not recognized as an internal or external command|command not found/i.test(String(checked.error||checked.stderr||"")))return answer({available:false,installed:false,version:null,message:`Muse Code (muse) was not found. Install it with ${museInstallCommand(this.platform)} (https://dev.meta.ai/docs/muse-code), then sign in with muse login.`});
      // What Muse printed stays out of the answer, which Settings shows (T3 Code's status check leaves it out too).
      return answer({available:false,installed:true,version:parseMuseVersion(said),message:checked.error==="probe timed out"?"Muse Code did not answer `muse --version` in time. Press Refresh to check it again.":`Muse Code is installed, but \`muse --version\` failed${Number.isInteger(checked.code)?` with exit code ${checked.code}`:""}. Check its executable path, or install Muse Code again.`});
    }
    const version=parseMuseVersion(said),compatibility=runtimeCompatibility("muse",version),known={installed:true,version,...(compatibility?{compatibility}:{})};
    let catalog;
    try{catalog=await this.#museCatalog(instance,version)}
    catch(error){const reason=String(error?.message||error).trim().slice(0,400);return answer({...known,available:false,message:`Muse Code could not list its models: ${/[.!?…]$/.test(reason)?reason:reason+"."} Press Refresh to check it again.`})}
    if(!catalog.models.length)return answer({...known,available:false,message:"Muse Code listed no models. Sign in with muse login, then press Refresh."});
    return answer({...known,available:true,message:"Muse Code checks its sign-in when a turn runs. Sign in with muse login if a turn says it is signed out."});
  }
  #museCatalogs=new Map();
  // The models Muse Code lists (readMuseModelCatalog), read once per profile as it is set (its binary, version, environment and
  // approved names): each read starts the 400 MB muse binary, so every status check reuses the last list, an empty one too (Settings'
  // polls, thread starts, model lists, and the listings that answer a harness switch, a profile saved or removed and an install),
  // and a failed read for PROBE_REUSE_MS, after which the next check reads again. Settings' own listing (its open and Refresh), a
  // failed turn's recheck and picking a Muse Code whose list has no models read it again (#museCatalogDue). Reads at once share one.
  async #museCatalog(instance,version){
    const command=this.executable(instance),key=JSON.stringify([command,binarySignature(this.#binaryPaths(instance)),version||null,normalizeApprovedEnvironmentKeys(instance.approvedEnvironmentKeys),instance.environment||{}]);
    const cached=this.#museCatalogs.get(instance.id),current=cached?.key===key&&!cached.due?cached:null;
    if(current?.pending)return await current.pending;
    if(current&&!current.error)return current.value;
    if(current&&this.now()-current.at<PROBE_REUSE_MS)throw current.error;
    const pending=readMuseModelCatalog({command,env:this.childEnv(instance),approvedEnvironmentKeys:instance.approvedEnvironmentKeys,cwd:process.cwd()}),entry={key,pending,value:cached?.value||null};
    this.#museCatalogs.set(instance.id,entry);
    try{
      const value=await pending;
      if(this.#museCatalogs.get(instance.id)===entry)this.#museCatalogs.set(instance.id,{key,value});
      return value;
    }catch(error){
      if(this.#museCatalogs.get(instance.id)===entry)this.#museCatalogs.set(instance.id,{key,error,at:this.now(),value:entry.value});
      throw error;
    }
  }
  // Has the next status check of a Muse Code profile (or of each) read its list again; keepListed keeps a list with models. A read
  // on its way is new enough.
  #museCatalogDue(instance=null,{keepListed=false}={}){
    for(const [id,entry] of this.#museCatalogs)if((!instance||id===instance.id)&&!entry.pending&&!(keepListed&&!entry.error&&entry.value?.models?.length))this.#museCatalogs.set(id,{...entry,due:true});
  }
  // The list a Muse Code session resolves the thread's model and Thinking level against: the last one read for the profile, or null.
  museModelCatalog(instance){return this.#museCatalogs.get(instance?.id)?.value||null}
  async models(instanceOrKind,{environmentId=undefined}={}){
    const instance=typeof instanceOrKind==="string"?(this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind))):instanceOrKind;
    if(instance.kind==="native")return {models:[],metadata:[],source:"provider"};
    if(instance.kind==="codex")return {models:[],metadata:[],source:"codex"};
    const status=await this.probe(instance,{environmentId});if(!status.available)return {models:[],metadata:[],source:"unavailable",error:status.message};
    // Muse Code's are the list its status check read (T3 builds the provider snapshot's models from it); Refresh reads it again.
    if(instance.kind==="muse"){
      try{const catalog=await this.#museCatalog(instance,status.version);return {models:catalog.models,metadata:catalog.metadata,preferred:catalog.preferred,source:"live"}}
      catch(error){return {models:[],metadata:[],source:"unavailable",error:"Muse Code could not list its models: "+(error?.message||String(error))}}
    }
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
    const spawnProcess=this.processSpawner(instance,environmentId),command=this.executable(instance,{environmentId}),env=this.#probeEnv(instance);
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
  // The full listing answers Settings (its open, Refresh, a sign-in's follow-up) and the runtime mutations, so it checks again.
  // refresh (Settings' own listing) also reads Muse Code's model lists again, which the mutations' listings reuse.
  async snapshot({fresh=true,refresh=false}={}){
    if(refresh)this.#museCatalogDue();
    const instances=this.instances();const statuses=await Promise.all(instances.map(instance=>this.probe(instance,{fresh})));
    const publicInstances=instances.map(instance=>{
      const {environment,...safe}=instance;
      return {...safe,environmentKeys:Object.keys(environment||{}),approvedEnvironmentKeys:normalizeApprovedEnvironmentKeys(instance.approvedEnvironmentKeys)};
    });
    const installCommand=id=>id==="muse"?museInstallCommand(this.platform):id==="opencode"?"npm install -g "+INSTALLABLE_PACKAGES.opencode+" (OpenCode 1.x), or opencode upgrade for an OpenCode from its own installer":INSTALLABLE_PACKAGES[id]?"npm install -g "+INSTALLABLE_PACKAGES[id]:null;
    const definitions=this.definitions().map(def=>({...def,installable:Boolean(this.installable(def.id)),packageName:INSTALLABLE_PACKAGES[def.id]||null,installCommand:installCommand(def.id),canAuthenticate:["codex","claude","cursor","grok","opencode","antigravity","muse"].includes(def.id)}));
    const active=this.activeInstance();return {selectedRuntime:this.activeRuntime(),selectedInstanceId:active.id,compatibleInstanceIds:this.compatibleInstanceIds(active),capabilities:this.capabilities(active),definitions,instances:publicInstances,statuses,installs:this.installs()};
  }
}
