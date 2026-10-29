import { access, mkdtemp, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import spawn from "cross-spawn";
import { codexBin, codexHome, trebellHome } from "./paths.mjs";
import { prepareCodexHome, resolveCodexHomeLayout } from "./codex-home-layout.mjs";
import { readAgentRuntimeUsage } from "./agent-usage-limits.mjs";
import { sharedRuntimeCapabilities } from "./runtime-capabilities.mjs";
import { redactSecretText, withoutSecretEnvironment } from "./secret-redactor.mjs";
import { buildRuntimeEnvironment, isHarnessCredentialName, normalizeApprovedEnvironmentKeys, runtimeEnvironmentKeys } from "./runtime-environment.mjs";
import { HARNESS_API_KEY, HARNESS_KEY_VARIABLES, HARNESS_SIGN_IN, harnessApiKeyProfileRefusal, harnessAuthMethod, harnessKeyEnvironment, harnessKeyMissingMessage, harnessRemoteKeyMessage, harnessTakesApiKey, normalizeHarnessAuthMethod } from "./harness-auth.mjs";
import { MODEL_PROVIDERS, ProviderManager } from "./provider-manager.mjs";
import { installAntigravityRuntime, readAntigravityInstall } from "./antigravity-runtime-installer.mjs";
import { afterAntigravitySignIn, ANTIGRAVITY_API_KEY_METHOD, ANTIGRAVITY_KEY_READY, ANTIGRAVITY_SIGN_IN_NEEDED, ANTIGRAVITY_SIGNED_IN, antigravityEnvironment, antigravityHome, antigravityIpv6Failure, antigravitySignInState } from "./antigravity-auth.mjs";
import { discoverOpenCode2ModelCatalog, discoverOpenCodeModelCatalog } from "./opencode-agent-session.mjs";
import { resolveWindowsCommandShim, windowsCommandShimTarget } from "./windows-command-shim.mjs";
import { harnessInstallOwner, manualUpdateRefusal, manualUpdateText, newestListed, npmInstallArgs, npmRecordedVersion, registryRelease, shownCommand } from "./harness-install-plan.mjs";
import { codexAccountStatus, readCodexAccount } from "./codex-account-probe.mjs";
import { remoteCodexHomeSetup } from "./environment-app-server.mjs";
import { claudeCapabilities, claudeModelCatalog } from "./claude-capabilities.mjs";
import { CLAUDE_CAPABILITIES_TTL_MS } from "./claude-capabilities.mjs";
import { defaultAcpClientCapabilities } from "./acp-client.mjs";
import { acpProbeSession, acpSessionModelCatalog, antigravityModelCatalog, antigravitySeedCatalog, cursorModelCatalog, GROK_INITIALIZE_META, grokModelCatalog, withAcpProbe } from "./acp-model-catalog.mjs";
import { acpRuntimeTempRoot } from "./acp-runtime-temp.mjs";
import { acpCommandsFromAvailable } from "./acp-agent-session.mjs";
import { readMuseModelCatalog } from "./muse-model-catalog.mjs";
import { museUsageLimits } from "./muse-subscription-usage.mjs";
import { latestMuseSubscriptionUsage } from "./muse-agent-session.mjs";
import { compareMuseVersions, isMuseLauncher, latestMuseRelease, MUSE_CHANNELS, museChannel, museChannelUrl, museUpdateEnvironment, museUpdateRefusal, museUpdateText } from "./muse-maintenance.mjs";

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
  // OpenCode 1.x ships as opencode-ai and 2.x as @opencode/cli (T3 openCodeUpdateFor). A new OpenCode is 1.x, and an update keeps
  // an install in its own line (npmPackageFor): Trebell never moves one between the two, as 2.x converts OpenCode's shared database
  // in place.
  opencode:"opencode-ai",
});
// The harnesses Trebell updates through whatever installed the binary a profile runs, or says how to (T3's provider maintenance).
const UPDATABLE=new Set(["codex","claude","opencode","grok"]);
// Those whose npm package needs no version, so one in npm's prefix whose install never finished can be installed there again
// (OpenCode's line names its package), with what each one's own launcher says then: Claude Code's placeholder claude.exe when its
// install script did not run, and Codex's codex.js and Grok Build's bootstrap when npm did not download its platform package.
const UNFINISHED_INSTALL=Object.freeze({
  claude:/\bclaude native binary not installed\b/i,
  codex:/\bMissing optional dependency @openai\/codex-/i,
  grok:/@xai-official\/grok: (?:no platform binary installed|missing binary at)\b/i,
});
// A --version that shows its install never finished: it could not start the binary (a placeholder Windows cannot run), or ended with
// its package's words for that. Any other error is the harness's own (a config file it cannot read), which no install mends.
const unfinishedInstall=(kind,result)=>{
  const failure=result&&!result.ok?versionCheckFailure(result):null,words=UNFINISHED_INSTALL[kind];
  return Boolean(words)&&(failure==="spawn"||(failure==="exit"&&words.test(stripAnsi(`${result.stderr||""}\n${result.stdout||""}`))));
};
// The npm package of the release line a harness's version is in: OpenCode 2.x is @opencode/cli, and Grok Build @xai-official/grok,
// whose latest is what `grok update` installs (T3 Grok driver).
const npmPackageFor=(kind,version)=>kind==="opencode"&&parsedSemver(version)?.major===2?"@opencode/cli":kind==="grok"?"@xai-official/grok":INSTALLABLE_PACKAGES[kind]||null;
// Two releases of a harness in order: Muse Code's by its own versions (X.Y.Z-R<revision>), every other's by X.Y.Z.
const releaseOrder=(kind,a,b)=>kind==="muse"?compareMuseVersions(a,b):compareSemver(parsedSemver(a),parsedSemver(b));
// Muse Code runs where Trebell runs; a WSL or SSH environment has no Muse Code of Trebell's.
const MUSE_LOCAL_ONLY="Muse Code runs only on this machine in Trebell Code. Switch to the local environment to use it.";
// A model list reads OpenCode's provider list again once the last read is this old. A status check (every thread start and the
// window's poll make one) reuses the last read of the same binary, version and environment that was complete (openCodeCatalogComplete),
// and one that was not for OPENCODE_INCOMPLETE_REUSE_MS: each read starts an `opencode serve`. (T3 Code checks such an OpenCode again on
// its five-minute health interval.) Settings' Refresh (its Refresh buttons and a sign-in's follow-up) reads again. Any other fresh check
// (Settings' open, a switch, the listing a profile's Save or Delete or an install answers with) reads again a read that is
// OPENCODE_CATALOG_REUSE_MS old, so a switch's read also serves the listing right after it, and going between Settings' sections starts
// at most one `opencode serve` in that time. A failed turn's recheck keeps a complete read, as T3 Code does not read OpenCode's catalog
// again when a turn fails.
const OPENCODE_CATALOG_REUSE_MS=10_000;
const OPENCODE_INCOMPLETE_REUSE_MS=5*60_000;
const OPENCODE_STATUS_TIMEOUT_MS=20_000;
// How long after it began Settings' harness list waits for a newest-release read still on its way (T3 publishes the list first and
// the release after it): a registry or an npm that does not answer never holds the list back for longer.
const RELEASE_WAIT_MS=1500;

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
// T3 Code's OpenCode status message, from the connected providers OpenCode's server lists and the models it lists for them.
export function openCodeStatusMessage(connected,{external=false,models=null}={}){
  const count=Math.max(0,Number(connected)||0),where=external?"the configured OpenCode server":"OpenCode";
  if(count>0&&models===0)return `${count} upstream provider${count===1?" is":"s are"} connected through ${where}, but it lists no models yet. Press Refresh to check again.`;
  if(count>0)return `${count} upstream provider${count===1?"":"s"} connected through ${where}.`;
  return external?"Connected to the configured OpenCode server, but it did not report any connected upstream providers.":"OpenCode is available, but it did not report any connected upstream providers.";
}
// OpenCode is ready once upstream providers are connected and it lists models for them (T3 Code). Its answer is complete, and kept, when
// nothing in it is pending either: a command, skill or agent list that timed out or failed, or an OpenCode 2 model list still changing.
const openCodeCatalogReady=catalog=>Boolean(catalog?.connectedProviders?.length&&catalog?.models?.length);
const openCodeCatalogComplete=catalog=>openCodeCatalogReady(catalog)&&!catalog?.pending?.length;
// A profile's own OpenCode server that refused the password: an HTTP 401 or 403 (OpenCode 1.x answers an empty one, whose status the
// error keeps), OpenCode 2's UnauthorizedError or ForbiddenError, or a 401 or 403 said as a status, or Unauthorized or Forbidden, in its
// text. The digits alone are not one, as a port or a path can hold them (http://127.0.0.1:4010); T3 Code reads them as strictly.
const OPENCODE_REFUSED_STATUS=new Set([401,403]),OPENCODE_REFUSED_TAG=new Set(["UnauthorizedError","ForbiddenError"]);
export function openCodeServerRefused(error){
  if(OPENCODE_REFUSED_STATUS.has(Number(error?.status))||OPENCODE_REFUSED_STATUS.has(Number(error?.cause?.status))||OPENCODE_REFUSED_TAG.has(String(error?._tag||error?.name||"")))return true;
  const text=String(error?.message||error||"");
  return /\b(?:unauthorized|forbidden)\b/i.test(text)||/\b(?:unexpected)?status(?:\s+code)?(?:\s*[:=]\s*|\s+)(?:401|403)\b/i.test(text)||/\bhttp(?:\/\d(?:\.\d)?)?\s+(?:401|403)\b/i.test(text);
}
// What a refusal by a profile's own server says. Trebell sends an OpenCode 2 server the profile's OPENCODE_SERVER_PASSWORD (or
// OPENCODE_PASSWORD), and an OpenCode 1.x server only when Trebell starts it, so for a 1.x server of the profile's own the password
// in its environment cannot help. The advice leaves that server's password alone, all that guards a server that runs tools and shell
// commands for whoever reaches its port: Trebell can start OpenCode itself instead.
function openCodeServerRefusal(version){
  return String(version||"").startsWith("2.")
    ?"The configured OpenCode server rejected the password. Check this profile's server URL and the OPENCODE_SERVER_PASSWORD in its environment."
    :"The configured OpenCode server asks for a password, which Trebell Code sends only to an OpenCode 1.x server it starts itself. Check this profile's server URL, or leave it empty so Trebell Code starts OpenCode itself.";
}
// OpenCode's own answer for a profile, from its 1.x or 2.x server: its version chooses the client, as it does for the relay and Git text.
function readOpenCodeCatalog({version=null,...options}={}){return (String(version||"").startsWith("2.")?discoverOpenCode2ModelCatalog:discoverOpenCodeModelCatalog)(options)}
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
// Who installed the OpenCode 1.x at a real path, judged from the path as T3 Code judges an update (openCodeUpdateFor, through
// harnessInstallOwner): OpenCode's own installer keeps it in ~/.opencode/bin and updates it with `opencode upgrade`; npm keeps a
// global opencode-ai in <prefix>/node_modules/opencode-ai beside its opencode shims on Windows, and in
// <prefix>/lib/node_modules/opencode-ai elsewhere. Any other path (2.x's @opencode/cli, another package manager, a project's
// node_modules) is not opencode-ai's.
export function openCodeInstallOwner(path,{platform=process.platform,exists=existsSync}={}){
  const owner=harnessInstallOwner("opencode",{paths:{real:String(path||"")},packageName:INSTALLABLE_PACKAGES.opencode,command:"opencode",platform,exists,read:()=>""});
  return owner.method==="native"?{method:"native"}:owner.method==="npm"?{method:"npm",prefix:owner.prefix}:null;
}
// npm leaves a command another package installed alone (EEXIST, unless forced), so it cannot update opencode-ai while the opencode
// command in its prefix runs something else, such as OpenCode 2.x's @opencode/cli (nor packageName @opencode/cli while it runs
// opencode-ai). Returns that package (or file), or null.
export function openCodeCommandHolder(prefix,{platform=process.platform,packageName="opencode-ai",read=path=>readFileSync(path,"utf8"),readLink=readlinkSync}={}){
  const windows=platform==="win32",paths=windows?win32:posix,root=String(prefix||"");
  const own=paths.join(root,windows?"node_modules":"lib/node_modules",...packageName.split("/")).toLowerCase()+paths.sep;
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
// Why npm cannot update OpenCode's packageName in prefix while the opencode command there is holder's, with the forced install that
// would, its install script allowed (npm 12 runs none unless allowed, and OpenCode's puts its binary in place) and kept to the line
// (npm installs the newest <line>.x, never a 3.x that has become the package's latest).
function openCodeHolderRefusal(prefix,holder,packageName,line,platform=process.platform){
  return `npm cannot update ${packageName} in ${prefix}: the opencode command there runs ${holder}, and npm does not replace another package's command. Trebell Code changes neither install. To update OpenCode ${line}.x, uninstall ${holder}, or run \`${shownCommand("npm",[...npmInstallArgs(packageName,String(line),prefix),"--force"],platform)}\` yourself (the opencode command then runs OpenCode ${line}.x).`;
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

// The home of Trebell's own a Codex profile on an API key signs in to (AgentRuntimeManager.codexHomeConfig), one per profile.
export function codexApiKeyHome(env,instance){return join(trebellHome(env),"codex-api-key-homes",String(instance?.id||"codex-default").replace(/[^A-Za-z0-9._-]/g,"_"))}
// What npm runs with for an install or update (and the harness package's own install script with it): Trebell's environment
// without any variable that holds a provider's key or a sign-in (runtime-environment.mjs isHarnessCredentialName), so no API key in
// it reaches a harness's install script; npm keeps its own settings, the proxy and the toolchain.
// npm's own registry sign-in stays (an .npmrc that names ${NPM_TOKEN} fails without it): its npm_config_* settings, NPM_TOKEN and
// NODE_AUTH_TOKEN, none a model provider's key or a harness's sign-in.
const NPM_REGISTRY_NAME=/^(?:npm_config_|NPM_TOKEN$|NODE_AUTH_TOKEN$)/i;
export function installEnvironment(parent=process.env){
  const env={};for(const [name,value] of Object.entries(parent||{}))if(value!=null&&(!isHarnessCredentialName(name)||NPM_REGISTRY_NAME.test(name)))env[name]=value;
  return env;
}
// A short command whose stdin gets input (a key a CLI reads there), then ends: its exit, as run() answers it.
async function runWithInput(command,args=[],{env=process.env,cwd=process.cwd(),input="",timeoutMs=30_000}={}){
  return await new Promise(resolve=>{
    let stdout="",stderr="",settled=false,child;
    const finish=(code,error=null)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({ok:code===0,code,error:error?.message||null,stdout,stderr})};
    try{child=spawn(command,args,{cwd,env,windowsHide:true,stdio:["pipe","pipe","pipe"]})}catch(error){return resolve({ok:false,code:null,error:error.message,stdout:"",stderr:""})}
    child.stdout?.on("data",chunk=>{stdout=(stdout+chunk).slice(-64_000)});child.stderr?.on("data",chunk=>{stderr=(stderr+chunk).slice(-64_000)});
    child.once("error",error=>finish(null,error));child.once("exit",code=>finish(code));
    const timer=setTimeout(()=>{void terminateProcessTree(child).finally(()=>finish(null,new Error("command timed out")))},timeoutMs);
    child.stdin?.on("error",()=>{});child.stdin?.end(input);
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
  // providers: the ProviderManager whose keys a harness on API key runs on (the server's own, so a key saved in Settings counts at
  // once); without one the manager reads the same store and environment through a ProviderManager of its own when a key is asked for.
  constructor({state,env=process.env,environments=null,platform=process.platform,arch=process.arch,fetchImpl=globalThis.fetch,claudeCapabilitiesCache=claudeCapabilities,now=Date.now,runFn=run,providers=null}={}){this.state=state;this.env=env;this.environments=environments;this.platform=platform;this.arch=arch;this.fetchImpl=fetchImpl;this.claudeCapabilitiesCache=claudeCapabilitiesCache;this.now=now;this.runFn=runFn;this.#providers=providers}
  #providers=null;
  // A provider's key for a harness on API key (ProviderManager.keyFor): the key saved in Settings, else Native's environment variable.
  providerKey(providerId){
    if(!this.#providers)this.#providers=new ProviderManager({env:this.env,fetchFn:this.fetchImpl});
    return this.#providers.keyFor(providerId);
  }
  // How a profile signs in (harness-auth.mjs): "api-key" only where the person set it, else "sign-in".
  authMethod(instance){return harnessAuthMethod(instance)}
  // The keys a profile on API key starts with, its vendor's only; none on Sign in.
  harnessKeys(instance){return harnessAuthMethod(instance)===HARNESS_API_KEY?harnessKeyEnvironment(instance.kind,id=>this.providerKey(id)):{env:{},providers:[],missing:[],ready:false}}
  // Why a profile set to an API key cannot start now, or null: {message, keyMissing}. It runs in a WSL or SSH environment
  // (remoteKeyRefusal), it is an OpenCode at a server URL of its own (harnessApiKeyProfileRefusal), or Trebell has no key of its
  // vendor. Every start asks it (the relay's sessions, Git text), whatever a status kept from before says, so a harness whose key was
  // removed since never starts on a login of its own instead.
  keyRefusal(instance,environmentId=undefined){
    if(!harnessTakesApiKey(instance?.kind)||harnessAuthMethod(instance)!==HARNESS_API_KEY)return null;
    const refused=this.remoteKeyRefusal(instance,environmentId)||harnessApiKeyProfileRefusal(instance);if(refused)return {message:refused,keyMissing:false};
    if(this.harnessKeys(instance).ready)return null;
    return {message:harnessKeyMissingMessage(RUNTIMES[instance.kind].name,Object.keys(HARNESS_KEY_VARIABLES[instance.kind]).map(id=>MODEL_PROVIDERS[id]?.name||id)),keyMissing:true};
  }
  // What a reading kept for a profile depends on in how it signs in: its method, and on an API key a fingerprint of the keys it runs on
  // (never a key), so a switch, or a key saved or removed, reads the harness again (its OpenCode catalog, its ACP model list).
  #signInMark(instance){
    if(harnessAuthMethod(instance)!==HARNESS_API_KEY)return HARNESS_SIGN_IN;
    const env=this.harnessKeys(instance).env;
    return HARNESS_API_KEY+":"+createHash("sha256").update(JSON.stringify(Object.keys(env).sort().map(name=>[name,env[name]]))).digest("hex").slice(0,16);
  }
  // What Settings shows of a profile's method: the providers whose key it runs on, each with whether Trebell has one (never the key).
  authSummary(instance){
    const kind=instance?.kind;if(!harnessTakesApiKey(kind))return null;
    const method=harnessAuthMethod(instance),keys=Object.entries(HARNESS_KEY_VARIABLES[kind]).map(([provider,variable])=>{
      let found=null;try{found=this.providerKey(provider)}catch{}
      return {provider,name:MODEL_PROVIDERS[provider]?.name||provider,variable,saved:Boolean(found),source:found?.source||null,from:found?.variable||null};
    });
    return {method,keys};
  }
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
    // What the harness list adds to a profile it shows is no setting of it.
    delete item.signIn;delete item.environmentKeys;
    item.environment=withoutSecretEnvironment(item.environment);
    // A harness signs in with its own login, or runs on its vendor's key when its profile is set to an API key: an approved name
    // never hands it a provider's key or a sign-in token (Trebell Native keeps its approvals, such as its MCP servers' bearer names).
    const approved=normalizeApprovedEnvironmentKeys(input.approvedEnvironmentKeys??item.approvedEnvironmentKeys),refused=kind==="native"?[]:approved.filter(name=>isHarnessCredentialName(name));
    if(refused.length)throw new Error(`${refused.join(", ")} ${refused.length===1?"holds":"hold"} an API key or sign-in, which a profile never passes to ${RUNTIMES[kind].name}. ${harnessTakesApiKey(kind)?`To run ${RUNTIMES[kind].name} on an API key, set it to API key under ${RUNTIMES[kind].name} in Agents & models, which uses the key saved for its provider.`:`${RUNTIMES[kind].name} signs in with its own login.`} Keys for Trebell Native go in its Model provider card.`);
    item.approvedEnvironmentKeys=approved;
    // How it signs in: the profile's choice, kept as saved when a save does not name it (Sign in when it never chose).
    const method=normalizeHarnessAuthMethod(kind,Object.hasOwn(input,"auth")?input.auth:item.auth);
    if(method)item.auth=method;else delete item.auth;
    // An OpenCode at a server URL of its own has no launch of Trebell's to hand a key to.
    const keyRefused=item.auth===HARNESS_API_KEY?harnessApiKeyProfileRefusal(item):null;if(keyRefused)throw new Error(keyRefused);
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
    // instance: the profile as it was, whose Codex home of Trebell's own for an API key the server signs out (codexApiKeyLogout).
    this.state.updateSettings(patch);return {ok:true,resetTo,kind:target.kind,instance:target};
  }
  // Sets how one profile signs in (Settings' choice), changing nothing else of it: its own sign-in, or its vendor's API key.
  // Answers the profile and whether the method changed.
  setAuthMethod(instanceId,method){
    const target=this.instances().find(item=>item.id===String(instanceId||""));
    if(!target)throw new Error("Runtime profile was not found");
    const next=normalizeHarnessAuthMethod(target.kind,method)||"sign-in",changed=harnessAuthMethod(target)!==next;
    const keyRefused=next===HARNESS_API_KEY?harnessApiKeyProfileRefusal(target):null;if(keyRefused)throw new Error(keyRefused);
    const settings=this.state.settings(),list=Array.isArray(settings.agentRuntimeInstances)?[...settings.agentRuntimeInstances]:[];
    const index=list.findIndex(item=>item.id===target.id),item={...(index>=0?list[index]:target),auth:next};
    if(index>=0)list[index]=item;else list.push(item);
    this.state.updateSettings({agentRuntimeInstances:list});
    // The Codex account read kept for the profile is about the home it read: the next status reads it again.
    this.#codexAccounts.clear();
    return {instance:item,changed};
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
    // An OpenCode only PATH names (nvm-windows, another npm prefix) runs the opencode.exe behind npm's launcher itself, as T3 does,
    // when the launcher is exactly npm's for a native binary: started through cmd.exe, the opencode.exe escapes the kill-on-close
    // job of the process that started it, so its servers outlived a Trebell that was killed or crashed.
    if(instance?.kind==="opencode"&&this.platform==="win32"){
      const found=commandOnPath(def.command,{env:this.childEnv(instance),platform:this.platform}),target=found&&windowsCommandShimTarget(found,{platform:this.platform,exact:true});
      if(target)return target;
    }
    return def?.command||null;
  }
  // The homes a Codex profile runs in on this machine (codex-home-layout.mjs). One on an API key runs in a home of Trebell's own over
  // its shared home (an auth overlay, as a shadow home is): Codex signs in there with the key (codexApiKeyLogin), and the sign-in the
  // person made with codex login in the profile's own home stays as it is for when the profile is set back to Sign in.
  codexHomeConfig(instance){
    const config={homePath:String(instance?.homePath||"").trim()||null,shadowHomePath:String(instance?.shadowHomePath||"").trim()||null,defaultHome:String(this.env.CODEX_HOME||"").trim()||join(homedir(),".codex")};
    return harnessAuthMethod(instance)===HARNESS_API_KEY?{...config,shadowHomePath:codexApiKeyHome(this.env,instance)}:config;
  }
  #codexKeyLogins=new Map();
  // Signs a local Codex profile on an API key in to its own home with the OpenAI key, as Codex's CLI takes one (`codex login
  // --with-api-key`, the key on its stdin, never in its arguments or a file Trebell writes): again only when the key or the home
  // changed. With no key, a sign-in an earlier key left there goes (`codex logout`), so Codex never runs on a key Trebell no longer has,
  // and Codex does not start at all (its app-server, a turn's or the model list's, fails with the status's words): no turn runs on a
  // half sign-in.
  async codexApiKeyLogin(instance,{command=this.executable(instance)}={}){
    if(instance?.kind!=="codex"||harnessAuthMethod(instance)!==HARNESS_API_KEY)return {ran:false};
    const env=this.childEnv(instance),home=env.CODEX_HOME,key=this.harnessKeys(instance).env.OPENAI_API_KEY||null;
    await prepareCodexHome(this.codexHomeConfig(instance));
    const mark=key?createHash("sha256").update(home+"\0"+key).digest("hex"):"none:"+home;
    let ran=false;
    if(this.#codexKeyLogins.get(home)!==mark){
      const result=await runWithInput(command,key?["login","--with-api-key"]:["logout"],{env,input:key?key+"\n":"",timeoutMs:30_000});
      if(key&&!result.ok)throw new Error(("Codex could not sign in with the OpenAI API key: "+redactSecretText(String(result.stderr||result.stdout||result.error||"no answer"),{environment:{OPENAI_API_KEY:key}}).trim()).slice(0,500));
      this.#codexKeyLogins.set(home,mark);this.#codexAccounts.clear();ran=true;
    }
    if(!key)throw Object.assign(new Error(harnessKeyMissingMessage(RUNTIMES.codex.name,[MODEL_PROVIDERS.openai.name])),{code:"HARNESS_KEY_MISSING"});
    return {ran};
  }
  // Signs a Codex profile's home of Trebell's own for an API key out (`codex logout`), so no copy of a key stays there once the
  // profile is set back to Sign in or removed, or the OpenAI key is removed from Trebell; the next start on an API key signs in again.
  // Only a home that is there, best effort, never thrown: a Codex that could not run (its binary gone) would leave its sign-in file
  // there, so that copy of the key goes all the same, unread (the home is Trebell's own, and only Trebell's `codex login
  // --with-api-key` writes it). home: another home of Trebell's own for a key, a removed profile's (codexApiKeyLogoutAll).
  async codexApiKeyLogout(instance,{command=this.executable(instance),home=codexApiKeyHome(this.env,instance)}={}){
    if(instance?.kind!=="codex")return {ran:false};
    if(!existsSync(home))return {ran:false};
    const env={...this.childEnv({...instance,auth:"sign-in"},{key:false}),CODEX_HOME:home};
    const result=await runWithInput(command,["logout"],{env,input:"",timeoutMs:30_000}).catch(error=>({ok:false,error:error?.message||String(error)}));
    await rm(join(home,"auth.json"),{force:true}).catch(()=>{});
    this.#codexKeyLogins.delete(home);this.#codexAccounts.clear();
    return {ran:true,ok:Boolean(result?.ok)};
  }
  // The OpenAI key removed from Trebell: every Codex home of Trebell's own for a key signs out, a listed profile's with its own Codex and
  // one a removed profile left with the default Codex, so no copy of the key stays in any of them.
  async codexApiKeyLogoutAll(){
    const root=join(trebellHome(this.env),"codex-api-key-homes");let names=[];
    try{names=readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name)}catch{}
    const listed=new Map(this.instances().filter(item=>item.kind==="codex").map(item=>[resolve(codexApiKeyHome(this.env,item)),item]));
    let ran=0;
    for(const name of names){const home=join(root,name),instance=listed.get(resolve(home))||{...defaultInstance("codex"),id:name};if((await this.codexApiKeyLogout(instance,{home})).ran)ran++}
    return {ran};
  }
  // Why a profile set to an API key cannot run in a WSL or SSH environment (environmentId), or null: Trebell sends no saved key to a
  // host (it would show in the host's process list), and a key the host's shell holds never stands in for it, so there the harness
  // is refused until the person sets it to Sign in, which runs it on its own login there.
  remoteKeyRefusal(instance,environmentId=undefined){
    if(harnessAuthMethod(instance)!==HARNESS_API_KEY||!this.processSpawner(instance,environmentId))return null;
    return harnessRemoteKeyMessage(RUNTIMES[instance.kind]?.name||instance.kind,instance.kind);
  }
  // The environment a harness's processes run with: the baseline, its own non-secret names and the profile's approved names and
  // variables (runtime-environment.mjs), with no credential of any kind (a last guard, whatever a profile saved before), plus, only
  // for a profile set to an API key, its own vendor's key in the variable its CLI reads. key false leaves that key out too (an
  // update or install, which needs none).
  childEnv(instance,{key=true}={}){
    const kind=instance?.kind,env=buildRuntimeEnvironment(kind,{parent:this.env,approved:instance?.approvedEnvironmentKeys,overrides:instance?.environment,platform:this.platform});
    if(kind!=="native")for(const name of Object.keys(env))if(isHarnessCredentialName(name)&&name.toUpperCase()!=="OPENCODE_SERVER_PASSWORD")delete env[name];
    const keys=key&&kind!=="native"?this.harnessKeys(instance).env:{};
    if(kind==="codex"){
      const layout=resolveCodexHomeLayout(this.codexHomeConfig(instance));
      if(layout.effectiveHomePath)env.CODEX_HOME=layout.effectiveHomePath;
    }
    if(kind==="claude"&&instance?.homePath)env.CLAUDE_CONFIG_DIR=instance.homePath;
    // Meta's launcher would otherwise update Muse Code in the foreground, or start its updater, each time Trebell runs it (T3 Code
    // sets it too); a profile's own value wins.
    if(kind==="muse"&&env.MUSE_NO_AUTO_UPDATE==null)env.MUSE_NO_AUTO_UPDATE="1";
    // Antigravity runs in Trebell's home for it, with no Google credential of anyone else's, and the Gemini key only on an API key.
    if(kind==="antigravity")return antigravityEnvironment(env,{home:antigravityHome(this.env),apiKey:keys.GEMINI_API_KEY||null});
    // OpenCode on its API keys starts with an empty set of stored sign-ins (OPENCODE_AUTH_CONTENT, which it reads in place of the
    // logins `opencode auth login` keeps in its data home), so only the keys the person chose serve it. Trebell never reads that file.
    if(kind==="opencode"&&key&&harnessAuthMethod(instance)===HARNESS_API_KEY)return {...env,...keys,OPENCODE_AUTH_CONTENT:"{}"};
    return {...env,...keys};
  }
  // The names a harness on a WSL or SSH host gets from the host's own shell: its non-secret names and approved names, never a key or
  // sign-in token, whichever way its profile signs in (a profile on an API key runs on this machine only, remoteKeyRefusal).
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
    // A profile on an API key is signed in to its own home with the key first (codexApiKeyLogin).
    const home=spawner?Promise.resolve():prepareCodexHome(this.codexHomeConfig(instance)).then(()=>this.codexApiKeyLogin(instance,{command}));
    const pending=home.then(()=>readCodexAccount({spawnAppServer,platform:this.platform})).then(result=>({result}),error=>({error:error?.message||String(error)}));
    this.#codexAccounts.set(key,{pending});
    const value=await pending;
    if(value.result&&codexAccountStatus(value.result.account).ready)this.#codexAccounts.set(key,{at:Date.now(),value});else this.#codexAccounts.delete(key);
    return value;
  }
  // An install's own commands (npm, a harness's updater) where the profile runs: here with env (Trebell's own by default), through
  // the manager's runner as its CLI checks go.
  async #runCommand(command,args,{timeoutMs=120000,cwd=null,environmentId=undefined,env=null}={}){
    const profile=this.activeEnvironment(environmentId);
    if(profile&&profile.type!=="local"&&this.environments){
      const result=await this.environments.executeArgv(profile.id,{command,args,cwd:cwd||profile.cwd||"",timeoutMs,maxOutput:4*1024*1024});
      return {ok:result.exitCode===0,code:result.exitCode,error:result.timedOut?"command timed out":null,stdout:result.stdout||"",stderr:result.stderr||""};
    }
    return this.runFn(command,args,{env:env||installEnvironment(this.env),cwd:cwd||process.cwd(),timeoutMs});
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
  // What install() takes: a harness Trebell installs, and Grok Build and Muse Code, which it only updates (with `grok update`, and
  // through Meta's launcher).
  #installTarget(kind){const runtime=normalizeAgentRuntime(kind);return this.installable(runtime)||(runtime==="grok"||runtime==="muse"?{runtime,updateOnly:true}:null)}
  // instanceId: the profile whose binary an update is for (the row's), else the harness's default profile.
  async install(kind,{environmentId=undefined,id=null,instanceId=null}={}){
    const target=this.#installTarget(kind);const normalized=normalizeAgentRuntime(kind);
    if(!target)throw new Error((RUNTIMES[normalized]?.name||String(kind||"Harness"))+" is not installable from Trebell Code");
    const running=this.#installing.get(target.runtime);
    if(running){
      const error=new Error((RUNTIMES[target.runtime]?.name||target.runtime)+" is already being installed or updated. Wait for it to finish first.");
      error.code="install-running";error.installId=running.id;throw error;
    }
    const entry={id:String(id||"")||randomUUID(),startedAt:Date.now(),done:null};
    entry.done=this.#install(target,environmentId,instanceId);this.#installing.set(target.runtime,entry);
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
    const runtime=this.#installTarget(kind)?.runtime;return runtime?this.#installing.get(runtime)?.done||null:null;
  }
  async #install(target,environmentId,instanceId=null){
    if(target.runtime==="antigravity"){
      if(this.activeEnvironment(environmentId))throw new Error("Managed Antigravity ACP installation is currently available only on the local machine");
      const instance=this.instances().find(item=>item.kind==="antigravity"&&item.id==="antigravity-default")||defaultInstance("antigravity");
      // The new runtime's start check launches it with the profile's own environment, as its sessions are (its home and key aside).
      const installed=await installAntigravityRuntime({env:this.env,fetchImpl:this.fetchImpl,platform:this.platform,arch:this.arch,launchEnv:this.childEnv(instance,{key:false})});
      const status=await this.probe(instance,{environmentId:null,fresh:true});
      return {ok:true,runtime:"antigravity",managed:"acp-registry",targetVersion:installed.version,status};
    }
    const plan=await this.installPlan(target.runtime,{environmentId,instanceId}),def=RUNTIMES[target.runtime];
    const result={runtime:target.runtime,packageName:plan.packageName,method:plan.method,targetVersion:plan.targetVersion,...(plan.compatibility?{compatibility:plan.compatibility}:{})};
    if(plan.installedVersion&&plan.targetVersion&&releaseOrder(target.runtime,plan.installedVersion,plan.targetVersion)>=0)return {ok:true,...result,status:await this.probe(plan.instance,{environmentId,fresh:true}),output:`${def.name} ${plan.installedVersion} is already the newest ${target.runtime==="opencode"?`OpenCode ${parsedSemver(plan.installedVersion).major}.x`:def.name} release.`};
    // An updater can download a few hundred MB (Claude Code's native binary): T3 gives one 5 minutes. Meta's launcher downloads the
    // whole muse-bin before it answers, bounding each request of its own, so it gets half an hour.
    const minutes=target.runtime==="muse"?30:5,ran=await this.#runCommand(plan.command,plan.args,{timeoutMs:minutes*60_000,environmentId,env:plan.env||null});
    if(!ran.ok){
      // An updater stopped when its time ran out is said as such (Meta's launcher then leaves its staging file in its folder).
      if(ran.error==="probe timed out"||ran.error==="command timed out")throw new Error(`The ${plan.installedVersion?"update":"install"} did not finish within ${minutes} minutes, so Trebell Code stopped it.${target.runtime==="muse"&&plan.binary?` Meta's launcher may have left a partial download (a .muse-update file) in ${dirname(plan.binary)}, which can be deleted.`:""}`);
      throw new Error((ran.stderr||ran.stdout||ran.error||(`Could not ${plan.installedVersion?"update":"install"} ${def.name}`)).trim().slice(-2000));
    }
    // The binary this profile runs must start and report what was installed, a pinned version or, after the harness's own updater,
    // another version than before (T3 25f8fcb18): an update that left it where it was is said, not shown as ready.
    const status=await this.probe(plan.instance,{environmentId,fresh:true}),running=target.runtime==="muse"?parseMuseVersion(status.version):parsedSemver(status.version)?.raw||null;
    const where=status.binary||plan.binary||def.command,named=plan.targetVersion&&plan.pinned?`${def.name} ${plan.targetVersion}`:def.name;
    if(!status.installed||!running){const said=String(status.message||"no answer").trim();throw new Error(`${named} was installed, but the ${def.name} this profile runs (${where}) did not start: ${/[.!?…]$/.test(said)?said:said+"."}`)}
    if(plan.pinned&&plan.targetVersion&&running!==plan.targetVersion)throw new Error(`${named} was installed, but the ${def.name} this profile runs (${where}) still reports ${running}.`);
    if(!plan.pinned&&plan.installedVersion&&running===plan.installedVersion)throw new Error(`\`${[String(plan.command).split(/[\\/]/).pop(),...plan.args].join(" ")}\` finished, but the ${def.name} this profile runs (${where}) still reports ${running}.`);
    return {ok:true,...result,status,output:(ran.stdout||ran.stderr||"").trim().slice(-2000)};
  }
  // The profile an install or update is for: the one asked for, else the harness's default profile.
  #installInstance(kind,instanceId=null){
    const instances=this.instances();
    return instances.find(item=>item.kind===kind&&instanceId&&item.id===instanceId)||instances.find(item=>item.kind===kind&&item.id===kind+"-default")||instances.find(item=>item.kind===kind)||defaultInstance(kind);
  }
  async #npmReady(environmentId){
    const npm=await this.#runCommand("npm",["--version"],{timeoutMs:8000,environmentId});
    if(!npm.ok)throw new Error("npm is required to install this harness in the selected environment. Install Node.js/npm there first.");
  }
  // The newest release npm installs where it runs (`npm view`), in range when one is given.
  async #npmRelease(packageName,{environmentId,range=null}){
    const viewed=await this.#runCommand("npm",["view",range?`${packageName}@${range}`:packageName,"version","--json"],{timeoutMs:20_000,environmentId});
    if(!viewed.ok)throw new Error((viewed.stderr||viewed.stdout||"Could not determine the compatible runtime version").trim().slice(-1000));
    return newestListed(viewed.stdout);
  }
  // What installing or updating a harness runs, decided without changing anything (T3 Code's maintenance resolver). One that is not
  // there gets its npm package (OpenCode the newest supported 1.x). One that is updates through what installed the binary the profile
  // runs (harnessInstallOwner): npm into its own prefix, or its own updater, to the newest release of its own line (an OpenCode 1.x
  // stays 1.x and a 2.x 2.x, the newest below 3.0.0). An install no updater is proven for, a version Trebell cannot read, a host's
  // OpenCode 2.x and a host's Grok Build are refused, saying how to update them. An SSH or WSL host's harness is npm's there.
  async installPlan(kind,{environmentId=undefined,instanceId=null}={}){
    const runtime=normalizeAgentRuntime(kind),def=RUNTIMES[runtime],instance=this.#installInstance(runtime,instanceId),remote=Boolean(this.processSpawner(instance,environmentId));
    if(runtime==="muse"&&remote)throw new Error(MUSE_LOCAL_ONLY);
    const checked=await this.#run(instance,["--version"],{timeoutMs:versionCheckTimeoutMs(runtime),environmentId});
    // A check that did not answer for any reason but a command that is not there says nothing of which install is there: planned as
    // if none were, the update would put a separate copy beside it (an OpenCode 1.x beside a 2.x), which the next start prefers.
    const failure=checked.ok?null:versionCheckFailure(checked),said=(checked.stdout||checked.stderr||"").trim().split(/\r?\n/)[0]||"",installed=checked.ok?(runtime==="muse"?parseMuseVersion(said):parsedSemver(said)?.raw||null):null;
    // One in the npm prefix that holds it whose install never finished (F1's placeholder: unfinishedInstall) is installed there again,
    // at the version npm recorded there (never another release) and its install script allowed; any other failed check says nothing
    // of the install.
    const broken=!remote&&unfinishedInstall(runtime,checked)?this.#installOwner(instance,null):null;
    const recorded=broken?.method==="npm"?npmRecordedVersion(broken.prefix,npmPackageFor(runtime,null),{platform:this.platform}):null;
    if(recorded){
      const packageName=npmPackageFor(runtime,null),args=npmInstallArgs(packageName,recorded,broken.prefix);await this.#npmReady(environmentId);
      return {instance,method:"npm",binary:broken.real,installedVersion:null,targetVersion:recorded,packageName,pinned:true,command:"npm",args,shown:shownCommand("npm",args,this.platform)};
    }
    if((failure&&failure!=="missing")||(checked.ok&&!installed)){
      const reason=failure==="spawn"?runtimeProbeFailure(def,checked):failure==="timeout"?`\`${def.command} --version\` did not answer within ${versionCheckTimeoutMs(runtime)/1000} seconds.`:failure?`\`${def.command} --version\` ${versionCheckEnded(checked)}`:`\`${def.command} --version\` printed no version: ${said.slice(0,200)}`;
      throw new Error(`Trebell Code could not read the version of the ${def.name} it would update: ${/[.!?…]$/.test(reason)?reason:reason+"."} Nothing was installed.`);
    }
    if(!installed){
      const packageName=INSTALLABLE_PACKAGES[runtime];
      if(!packageName)throw new Error(`${def.name} is not installed, and Trebell Code only updates it: install it, then refresh.`);
      await this.#npmReady(environmentId);
      let targetVersion=null,compatibility=null;
      if(runtime==="opencode"){
        targetVersion=await this.#npmRelease(packageName,{environmentId});compatibility=runtimeCompatibility("opencode",targetVersion);
        if(!targetVersion||!compatibility?.version||["broken","unsupported","unknown"].includes(compatibility.status))throw new Error(compatibility?.message||("Trebell could not verify that OpenCode "+targetVersion+" is compatible. Nothing was installed."));
      }
      const args=npmInstallArgs(packageName,targetVersion);
      return {instance,method:"npm",binary:null,installedVersion:null,targetVersion,packageName,...(compatibility?{compatibility}:{}),pinned:Boolean(targetVersion),command:"npm",args,shown:shownCommand("npm",args,remote?"linux":this.platform)};
    }
    if(runtime==="muse")return this.#museUpdatePlan(instance,installed);
    const packageName=npmPackageFor(runtime,installed),line=parsedSemver(installed).major;
    if(remote&&runtime==="opencode"&&line===2)throw new Error(`This OpenCode is ${installed}. Trebell Code supports OpenCode 2.x but will not replace it with the separate OpenCode 1.x npm package. Update this 2.x install with opencode upgrade or the package manager that installed it.`);
    if(remote&&runtime==="grok")throw new Error("Trebell Code updates Grok Build only on this machine: update the one in the selected environment the way you installed it. Nothing was installed.");
    const owner=remote?{method:"npm",prefix:null,binary:null,real:null}:this.#installOwner(instance,installed);
    if(owner.method==="manual")throw new Error(manualUpdateRefusal({name:def.name,binary:owner.real||def.command,by:owner.by,command:owner.command}));
    const holder=owner.method==="npm"&&owner.prefix&&runtime==="opencode"?openCodeCommandHolder(owner.prefix,{platform:this.platform,packageName}):null;
    if(holder)throw new Error(openCodeHolderRefusal(owner.prefix,holder,packageName,line,this.platform));
    let targetVersion;
    if(owner.method==="npm"){await this.#npmReady(environmentId);targetVersion=await this.#npmRelease(packageName,{environmentId,range:packageName==="@opencode/cli"?">=2.0.0 <3.0.0":null})}
    else{
      const release=this.#registryRead(runtime,packageName,line);targetVersion=await this.#latestRelease(release.key,{fresh:true,read:release.read});
      if(!targetVersion)throw new Error(`Trebell Code could not read the newest ${def.name} release from the npm registry. Nothing was installed.`);
    }
    let compatibility=null;
    if(runtime==="opencode"){
      compatibility=runtimeCompatibility("opencode",targetVersion);
      if(!targetVersion||!compatibility?.version||["broken","unsupported","unknown"].includes(compatibility.status))throw new Error(compatibility?.message||("Trebell could not verify that OpenCode "+targetVersion+" is compatible. Nothing was installed."));
      if(parsedSemver(targetVersion).major!==line)throw new Error(`The newest OpenCode release, ${targetVersion}, is not an OpenCode ${line}.x like the one this profile runs (${installed}), and Trebell Code updates an OpenCode only within its own line (2.x converts OpenCode's shared database in place). Nothing was installed.`);
    }
    // The harness's own updater runs as the profile runs it, Codex's with CODEX_HOME at the shared home whose standalone tree it keeps.
    const step=owner.method==="npm"?{command:"npm",args:npmInstallArgs(packageName,targetVersion,owner.prefix),pinned:true}
      :{command:owner.binary,args:runtime==="opencode"?["upgrade",targetVersion]:owner.args,env:{...this.childEnv(instance,{key:false}),...(owner.env||{})},pinned:runtime==="opencode"};
    return {instance,method:owner.method,binary:owner.real,installedVersion:installed,targetVersion,packageName,...(compatibility?{compatibility}:{}),...step,shown:shownCommand(step.command,step.args,remote?"linux":this.platform)};
  }
  // Muse Code's update (T3 museMaintenance), from installed, the version the profile's Muse Code answered: Meta's launcher, run with its
  // update on, synchronous and due, installs the newest release of its channel (read again now) before it answers --version, and the
  // version must then have moved. A Muse Code that Meta's launcher does not run is the person's to update.
  async #museUpdatePlan(instance,installed){
    const launcher=this.#museLauncher(instance),env=this.childEnv(instance,{key:false}),channel=museChannel(env);
    if(!launcher.updates)throw new Error(museUpdateRefusal(launcher.real||RUNTIMES.muse.command));
    if(!MUSE_CHANNELS.includes(channel))throw new Error(`This Muse Code runs on the channel ${channel} (MUSE_CHANNEL), which Meta does not publish: Meta's launcher runs only on muse-stable or muse-canary. Nothing was installed.`);
    const targetVersion=await this.#latestRelease(museChannelUrl(channel),{fresh:true,read:()=>latestMuseRelease(this.fetchImpl,channel)});
    if(!targetVersion)throw new Error(`Trebell Code could not read the newest Muse Code release from ${museChannelUrl(channel)}. Nothing was installed.`);
    return {instance,method:"launcher",binary:launcher.real,installedVersion:installed,targetVersion,packageName:null,pinned:false,command:launcher.binary,args:["--version"],env:museUpdateEnvironment(env),shown:museUpdateText(launcher.binary,env,this.platform)};
  }
  // The Muse Code a local profile runs (the file it names, else the one Trebell starts, else muse on PATH), its real path, and whether
  // it is Meta's launcher, which updates it (isMuseLauncher).
  #museLauncher(instance){
    const found=commandOnPath(String(instance?.binaryPath||"").trim()||this.executable(instance)||RUNTIMES.muse.command,{env:this.childEnv(instance),platform:this.platform});
    if(!found)return {binary:null,real:null,updates:false};
    let real=found;try{real=(this.platform==="win32"?realpathSync.native:realpathSync)(found)}catch{}
    return {binary:found,real,updates:isMuseLauncher(real,{platform:this.platform})};
  }
  // What Settings says of a newer Muse Code release (T3 enrichMuseSnapshot), as #updateAdvisory says it of the others: the newest
  // release of the profile's channel beside the version it runs, an update that Meta's launcher runs, or how to update one it does not.
  async #museUpdateAdvisory(instance,status,{waitMs=null}={}){
    if(!status?.installed||this.processSpawner(instance))return null;
    const current=parseMuseVersion(status.version),env=this.childEnv(instance),channel=museChannel(env);
    const latest=current?await this.#latestRelease(museChannelUrl(channel),{wait:waitMs!=null,waitMs,read:()=>latestMuseRelease(this.fetchImpl,channel)}):null;
    const newer=Boolean(latest&&compareMuseVersions(current,latest)<0),launcher=this.#museLauncher(instance);
    const advisory={current,latest,newer,canUpdate:false,command:null,binary:launcher.real,message:null};
    if(!current)return advisory;
    if(!launcher.updates)return {...advisory,message:newer?manualUpdateText({name:RUNTIMES.muse.name,latest,binary:launcher.real||RUNTIMES.muse.command}):null};
    return {...advisory,canUpdate:true,command:museUpdateText(launcher.binary,env,this.platform)};
  }
  // OpenCode's own plan, as installPlan gives it for the OpenCode default profile.
  openCodeInstallPlan({environmentId=undefined}={}){return this.installPlan("opencode",{environmentId})}
  // Who installed the binary a local profile runs (harnessInstallOwner), with what it runs as (binary) and its real path (real), or
  // no one when no such file is there.
  #installOwner(instance,version){
    const env=this.childEnv(instance),configured=String(instance?.binaryPath||"").trim();
    // The file the profile names, else the one Trebell starts (a known install folder, Codex's lookup), else the command on PATH.
    const found=commandOnPath(configured||this.executable(instance)||RUNTIMES[instance.kind]?.command,{env,platform:this.platform});
    if(!found)return {method:"manual",by:null,command:null,binary:null,real:null};
    // Windows' own reading of the real path also gives the file's name as it is spelled (PATH's lookup spells it as PATHEXT does).
    const binary=resolveWindowsCommandShim(found,{platform:this.platform});let real=binary;try{real=(this.platform==="win32"?realpathSync.native:realpathSync)(binary)}catch{}
    const user=String(this.env.USERPROFILE||this.env.HOME||"").trim()||homedir();
    const codexHome=instance.kind==="codex"?resolveCodexHomeLayout({homePath:instance.homePath,shadowHomePath:instance.shadowHomePath,defaultHome:String(this.env.CODEX_HOME||"").trim()||join(homedir(),".codex")}).sharedHomePath:null;
    const grokHome=instance.kind==="grok"?String(env.GROK_HOME||"").trim()||join(user,".grok"):null;
    return {...harnessInstallOwner(instance.kind,{paths:{found,binary,real},packageName:npmPackageFor(instance.kind,version),command:RUNTIMES[instance.kind].command,platform:this.platform,env:this.env,codexHome,grokHome}),binary,real};
  }
  #releases=new Map();
  // The newest release kept under key: npm's registry's for a package (T3 fetchNpmLatestVersion), or the one read gives (npm's own
  // answer, Muse Code's channel, kept by its URL), kept an hour once read and a minute when it could not be read (T3
  // ProviderLatestVersions); reads at once share one. wait:false answers from what is kept and reads nothing; waitMs waits for a read
  // on its way only that long after it began, then answers what was kept before while the read goes on for the next answer.
  async #latestRelease(key,{wait=true,fresh=false,waitMs=null,read=()=>registryRelease(this.fetchImpl,key)}={}){
    const kept=this.#releases.get(key);
    const waited=entry=>{
      if(waitMs==null)return entry.pending;
      let timer=null;const left=Math.max(0,entry.started+waitMs-Date.now());
      return Promise.race([entry.pending,new Promise(resolve=>{timer=setTimeout(()=>resolve(entry.version),left)})]).finally(()=>clearTimeout(timer));
    };
    if(!fresh&&kept?.pending)return wait?await waited(kept):kept.version;
    if(!fresh&&kept&&this.now()<kept.until)return kept.version;
    if(!wait)return kept?.version??null;
    const entry={version:kept?.version??null,started:Date.now()};
    entry.pending=Promise.resolve().then(read).catch(()=>null).then(version=>{if(this.#releases.get(key)===entry)this.#releases.set(key,{version,until:this.now()+(version?3_600_000:60_000)});return version});
    this.#releases.set(key,entry);
    return await waited(entry);
  }
  // How a profile's newest release is read and the key it is kept under: npm's own answer for an install npm updates on this machine
  // (`npm view`, through the person's npm registry and proxy, as its update reads it; OpenCode 2.x's below 3.0.0), and npm's registry
  // for a harness's own updater (T3) and for a host's harness. owner: the profile's (#installOwner), when it is known.
  #releaseRead(instance,version,owner=null){
    const packageName=npmPackageFor(instance.kind,version);if(!packageName)return null;
    if(this.processSpawner(instance)||(owner||this.#installOwner(instance,version)).method!=="npm")return this.#registryRead(instance.kind,packageName,parsedSemver(version)?.major);
    const range=packageName==="@opencode/cli"?">=2.0.0 <3.0.0":null;
    return {key:`npm view ${range?packageName+"@"+range:packageName}`,read:()=>this.#npmRelease(packageName,{range})};
  }
  // npm's registry's read of a package's newest release, and its key: an OpenCode 2.x's within its line (registryRelease), as
  // @opencode/cli's latest can be a 3.x; any other's is npm's latest (opencode-ai's is a 1.x), which an update keeps only in line, so
  // an OpenCode 0.x reads no list of every opencode-ai release for a 0.x Trebell rates broken.
  #registryRead(kind,packageName,line){
    const lined=kind==="opencode"&&line===2;
    return {key:lined?`${packageName} ${line}.x`:packageName,read:()=>registryRelease(this.fetchImpl,packageName,lined?{line}:{})};
  }
  // Settings' listing starts the read of a profile's newest release before its status check when an earlier check in this run read
  // the version the profile runs here (which also names an OpenCode's package, by its line); any other starts after its check.
  #startReleaseRead(instance){
    try{
      if(this.processSpawner(instance))return;
      const checked=this.#versions.get(instance.id)?.result,said=[checked?.stdout,checked?.stderr].filter(Boolean).join("\n"),started={waitMs:0};
      if(instance.kind==="muse"){
        if(!parseMuseVersion(said))return;
        const channel=museChannel(this.childEnv(instance));return void this.#latestRelease(museChannelUrl(channel),{...started,read:()=>latestMuseRelease(this.fetchImpl,channel)});
      }
      const version=UPDATABLE.has(instance.kind)?parsedSemver(said)?.raw:null,release=version?this.#releaseRead(instance,version):null;
      if(release)void this.#latestRelease(release.key,{...started,read:release.read});
    }catch{}
  }
  // What Settings says of a newer release of the harness a profile runs (T3's version advisory): {current, latest (null when it could
  // not be read), newer, canUpdate (Trebell runs the update: command, what it runs), binary (the file the profile runs), message (how
  // the person updates one Trebell does not), command}. Only a harness Trebell updates has one, when it is there; an OpenCode on a
  // server of its own has the one of this machine's opencode, whose version its row shows and its Update installs. waitMs (Settings'
  // own listing): the newest release is read when its last answer is gone, and waited for that long after its read began.
  async #updateAdvisory(instance,status,{waitMs=null}={}){
    if(instance?.kind==="muse")return this.#museUpdateAdvisory(instance,status,{waitMs});
    if(!UPDATABLE.has(instance?.kind)||!status?.installed)return null;
    // A version its --version check did not give (Codex's from its account read) is no version an update could start from: the
    // update's own check would not answer either.
    const def=RUNTIMES[instance.kind],remote=Boolean(this.processSpawner(instance)),current=status.versionCheckFailed?null:parsedSemver(status.version)?.raw||null;
    if(remote&&instance.kind==="grok")return null;
    const packageName=npmPackageFor(instance.kind,current),line=parsedSemver(current)?.major;
    const owner=remote?{method:"npm",prefix:null,binary:null,real:null}:this.#installOwner(instance,current);
    // One in npm's prefix whose install never finished has its reinstall there, at the version npm recorded (installPlan), as its
    // update: Update installs that release again, which no release read is needed for.
    const recorded=!current&&!remote&&this.#unfinishedInstalls.get(instance.id)===true&&owner.method==="npm"?npmRecordedVersion(owner.prefix,packageName,{platform:this.platform}):null;
    if(recorded)return {current:null,latest:recorded,newer:true,canUpdate:true,command:shownCommand("npm",npmInstallArgs(packageName,recorded,owner.prefix),this.platform),binary:owner.real,message:null};
    const release=current?this.#releaseRead(instance,current,owner):null,found=release?await this.#latestRelease(release.key,{wait:waitMs!=null,waitMs,read:release.read}):null;
    // An OpenCode's newest release counts within its own line.
    const latest=found&&(instance.kind!=="opencode"||parsedSemver(found)?.major===line)?found:null,newer=Boolean(latest&&current&&compareSemver(parsedSemver(current),parsedSemver(latest))<0);
    const advisory={current,latest,newer,canUpdate:false,command:null,binary:owner.real,message:null};
    if(!current)return advisory;
    if(remote&&instance.kind==="opencode"&&line===2)return {...advisory,message:newer?`OpenCode ${latest} is available. Update this 2.x install with \`opencode upgrade\` or the package manager that installed it.`:null};
    if(owner.method==="manual")return {...advisory,command:owner.command,message:newer?manualUpdateText({name:def.name,latest,binary:owner.real||def.command,by:owner.by,command:owner.command}):null};
    const holder=owner.method==="npm"&&owner.prefix&&instance.kind==="opencode"?openCodeCommandHolder(owner.prefix,{platform:this.platform,packageName}):null;
    if(holder)return {...advisory,message:newer?`OpenCode ${latest} is available. ${openCodeHolderRefusal(owner.prefix,holder,packageName,line,this.platform)}`:null};
    const args=owner.method==="npm"?npmInstallArgs(packageName,latest,owner.prefix):instance.kind==="opencode"?["upgrade",...(latest?[latest]:[])]:owner.args;
    const command=shownCommand(owner.method==="npm"?"npm":owner.binary,args,remote?"linux":this.platform)+(owner.env?.CODEX_HOME?` (with CODEX_HOME set to ${owner.env.CODEX_HOME})`:"");
    return {...advisory,canUpdate:true,command};
  }
  #openCodeCatalogs=new Map();
  // How a profile's catalog is read (readOpenCodeCatalog); tests stand in for OpenCode here.
  openCodeCatalogReader=readOpenCodeCatalog;
  // OpenCode's own answer for a profile (its connected models and providers, and its commands, skills and agents), from one managed
  // server or the profile's server, kept per binary and version and the profile's environment as it is set (a Save that changes it reads
  // OpenCode again): a complete one for reuseMs, one that is not for incompleteMs. Readers at the same time share one read; a failed
  // read is not kept. read.entry is the read waited on: starting once the read starts its server, and up once that server is up.
  async #openCodeCatalog(instance,{version=null,reuseMs=OPENCODE_CATALOG_REUSE_MS,incompleteMs=reuseMs,read=null}={}){
    const command=this.executable(instance),key=[instance.id,command,instance.serverUrl||"",version||"",this.#signInMark(instance),JSON.stringify([normalizeApprovedEnvironmentKeys(instance.approvedEnvironmentKeys),instance.environment||{}])].join("|"),cached=this.#openCodeCatalogs.get(key);
    if(cached?.pending){if(read)read.entry=cached;return await cached.pending}
    if(cached&&this.now()-cached.at<(cached.complete?reuseMs:incompleteMs))return cached.value;
    let isUp=()=>{};const entry={pending:null,starting:false,up:new Promise(resolve=>{isUp=resolve})};if(read)read.entry=entry;
    const pending=entry.pending=Promise.resolve().then(()=>this.openCodeCatalogReader({version,command,cwd:process.cwd(),env:this.childEnv(instance),serverUrl:instance.serverUrl||null,
      onServerStart:start=>{entry.starting=true;Promise.resolve(start).then(isUp,()=>{})}}));
    this.#openCodeCatalogs.set(key,entry);
    try{
      const value=await pending;
      if(this.#openCodeCatalogs.get(key)?.pending===pending)this.#openCodeCatalogs.set(key,{at:this.now(),value,complete:openCodeCatalogComplete(value)});
      return value;
    }catch(error){
      if(this.#openCodeCatalogs.get(key)?.pending===pending)this.#openCodeCatalogs.delete(key);
      throw error;
    }
  }
  // A status check's provider list: the last complete one read for this binary and version, one that is not if it was read within
  // OPENCODE_INCOMPLETE_REUSE_MS, one read within OPENCODE_CATALOG_REUSE_MS for a fresh check (a complete one of any age for a failed
  // turn's recheck, keepCatalog), or a new read (always for Settings' Refresh, refresh), which may take this long, and as long once its
  // server is up. OpenCode's server can take up to 30 seconds to start (its first run converts the shared database), and a start that
  // runs out of time fails the read itself.
  async #openCodeStatusCatalog(instance,version,{fresh=false,refresh=false,keepCatalog=false}={}){
    const timers=[],read={};let done=false;
    const after=then=>{const timer=setTimeout(then,OPENCODE_STATUS_TIMEOUT_MS);timer.unref?.();timers.push(timer)};
    try{
      return await Promise.race([
        this.#openCodeCatalog(instance,{version,read,...(refresh?{reuseMs:0}:fresh&&!keepCatalog?{reuseMs:OPENCODE_CATALOG_REUSE_MS}:{reuseMs:Number.POSITIVE_INFINITY,incompleteMs:fresh?OPENCODE_CATALOG_REUSE_MS:OPENCODE_INCOMPLETE_REUSE_MS})}),
        new Promise((_resolve,reject)=>{
          // It ends once both have passed: the wait since it began, and the wait since the read's server came up, if it starts one.
          const fail=()=>reject(new Error(`OpenCode did not answer within ${OPENCODE_STATUS_TIMEOUT_MS/1000} seconds.`));
          let waited=false,waitedUp=false;
          after(()=>{waited=true;if(!read.entry?.starting||waitedUp)fail()});
          read.entry?.up?.then(()=>{if(!done)after(()=>{waitedUp=true;if(waited)fail()})});
        }),
      ]);
    }finally{done=true;for(const timer of timers)clearTimeout(timer)}
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
  async probe(instanceOrKind,{environmentId=undefined,fresh=false,refresh=false,keepCatalog=false}={}){
    const instance=typeof instanceOrKind==="string"?(this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind))):instanceOrKind;
    if(instance.kind==="native")return this.#probeNow(instance,{environmentId});
    const key=this.#probeKey(instance,environmentId),owner=this.#probeOwner(instance,environmentId),cached=this.#probes.get(key);
    // A profile on an API key whose key has gone since an answer was read is not available, whatever that answer said (#keyGate).
    if(!fresh&&cached?.pending){
      const value=await cached.pending;if(value?.available||versionCheckOnly(value))return this.#keyGate(instance,structuredClone(value),environmentId);
      const next=this.#probes.get(key);if(next?.pending&&next.pending!==cached.pending)return this.#keyGate(instance,structuredClone(await next.pending),environmentId);
    }else if(!fresh&&cached&&this.now()-cached.at<PROBE_REUSE_MS&&binarySignature(cached.binary)===cached.signature)return this.#keyGate(instance,structuredClone(cached.value),environmentId);
    // A local binary replaced since (npm i -g, the harness's own updater) makes its version check due, so its answer is not kept
    // past that either. Read before the probe runs, so a binary replaced while it runs makes the next caller ask again.
    const binary=this.#binaryPaths(instance,environmentId),signature=binarySignature(binary);
    const pending=this.#probeNow(instance,{environmentId,fresh,refresh,keepCatalog});this.#probes.set(key,{pending,owner});
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
    const pending=this.probe(instance,{environmentId,fresh:true,keepCatalog:true}),settled=()=>{if(this.#rechecks.get(key)===pending)this.#rechecks.delete(key)};
    // A Claude Code found signed out forgets its kept capability probe, whose account and plan usage the Usage card would show for up
    // to five minutes more: the next Refresh asks Claude Code again.
    if(instance.kind==="claude")pending.then(value=>{if(value?.authenticated===false)this.dropClaudeCapabilities(instance,{environmentId})},()=>{});
    this.#rechecks.set(key,pending);pending.then(settled,settled);
    return pending;
  }
  #versions=new Map();
  // Whether each profile's last --version showed its install never finished (unfinishedInstall), which the update reading of one
  // whose version could not be read goes by.
  #unfinishedInstalls=new Map();
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
    this.#unfinishedInstalls.set(instance.id,unfinishedInstall(instance.kind,result));
    return result;
  }
  // A status check, with how the profile signs in (authMethod) and, for one set to an API key that cannot run, why: Trebell has no key
  // for it, or it is in a WSL or SSH environment, where a harness signs in with its own login (remoteKeyRefusal). No turn starts on a
  // half sign-in.
  async #probeNow(instance,options={}){
    const value=await this.#probeHarness(instance,options);
    if(!value||!harnessTakesApiKey(instance?.kind))return value;
    return this.#keyGate(instance,{...value,authMethod:harnessAuthMethod(instance)},options.environmentId);
  }
  // An installed harness's status on an API key that cannot start now (keyRefusal) is unavailable and says why: one read now, and one
  // read while it had its key and kept for PROBE_REUSE_MS (a key removed since, here or in another window).
  #keyGate(instance,value,environmentId=undefined){
    if(!value?.installed||harnessAuthMethod(instance)!==HARNESS_API_KEY)return value;
    const refusal=this.keyRefusal(instance,environmentId);if(!refusal)return value;
    return {...value,available:false,authenticated:false,account:null,...(refusal.keyMissing?{keyMissing:true}:{}),message:refusal.message};
  }
  // Settings saved or removed a key these profiles run on: their kept statuses go (and the Codex account reads), so the next status
  // asks each harness again on the key it has now.
  forgetProbes(instanceIds=[]){
    const ids=new Set([...instanceIds].map(String));if(!ids.size)return;
    for(const [key,entry] of [...this.#probes]){
      if(entry.pending||!entry.owner)continue;
      let owner=null;try{owner=JSON.parse(entry.owner)}catch{}
      if(Array.isArray(owner)&&ids.has(String(owner[2])))this.#probes.delete(key);
    }
    this.#codexAccounts.clear();
  }
  async #probeHarness(instance,{environmentId=undefined,fresh=false,refresh=false,keepCatalog=false}={}){
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
      // Antigravity on an API key is ready once Trebell has a Google Gemini key (#probeNow says when it has none); whether Google
      // takes it, a session finds out (authenticated null). On Sign in it is ready once its own sign-in is in its home: the method its
      // settings.json names, and its token file there (never read). No status check starts it: each launch unpacks about 1 GB.
      if(install?.version&&!instance.binaryPath?.trim()){
        const base={id:instance.id,kind:instance.kind,name:def.name,installed:true,protocol:def.protocol,managed:true,version:String(install.version),binary:command};
        // What the move of the old key form's key did that the person would not see (legacy-harness-key-migration.mjs) is said here,
        // on its row, until the Gemini key or Antigravity's method next changes.
        const moveNote=String(this.state?.settings?.()?.antigravityKeyNote||"").trim();
        if(this.authMethod(instance)===HARNESS_API_KEY)return {...base,available:true,authenticated:null,account:{authMethod:ANTIGRAVITY_API_KEY_METHOD,label:"Google Gemini API key"},message:moveNote?ANTIGRAVITY_KEY_READY+" "+moveNote:ANTIGRAVITY_KEY_READY};
        const own=await antigravitySignInState({env:this.env});
        return {...base,available:own.signedIn,authenticated:own.signedIn?null:false,account:own.signedIn?{authMethod:own.method,label:"Antigravity sign-in"}:null,message:own.signedIn?ANTIGRAVITY_SIGNED_IN:ANTIGRAVITY_SIGN_IN_NEEDED};
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
      // On its API key `claude auth status` reads the ANTHROPIC_API_KEY its launch has (apiKeySource), as the row then says.
      else if(this.authMethod(instance)===HARNESS_API_KEY)message="Runs on the Anthropic API key.";
    }else if(instance.kind==="cursor"){
      let about=await this.#run(instance,["about","--format","json"],{timeoutMs:8000,environmentId});
      const unsupported=/unknown (?:option|argument)|unexpected argument|unrecognized (?:option|argument)/i.test(String(about.stdout||"")+"\n"+String(about.stderr||""));
      if(unsupported)about=await this.#run(instance,["about"],{timeoutMs:8000,environmentId});
      const parsed=parseCursorAboutResult(about);
      authenticated=parsed.authenticated;account=parsed.email?{email:parsed.email}:null;
      if(authenticated===false)message="Cursor Agent is installed but not authenticated. Run cursor-agent login.";
      else if(authenticated==null)message="Cursor Agent is installed, but Trebell could not verify its authentication status.";
    }else if(instance.kind==="grok"){
      // On an API key it runs on the xAI key (#probeNow says when Trebell has none); on Sign in only its own login counts,
      // read with `grok models`.
      if(this.authMethod(instance)===HARNESS_API_KEY){
        authenticated=true;account={authMethod:"api_key",label:"xAI API key"};message="Runs on the xAI API key.";
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
      const unavailable=(message,fields={})=>({id:instance.id,kind:instance.kind,name:def.name,available:false,installed:true,authenticated:null,protocol:def.protocol,managed:false,binary:command,version:versionLine,account:null,message,...(compatibility?{compatibility}:{}),...fields});
      if(compatibility?.status==="unsupported")return unavailable(compatibility.message);
      // T3 Code's status check: the upstream providers OpenCode's matching 1.x/2.x server adapter reports connected, ready once it lists
      // models for them.
      let catalog;
      try{catalog=await this.#openCodeStatusCatalog(instance,compatibility?.version||null,{fresh,refresh,keepCatalog})}
      catch(error){
        if(instance.serverUrl&&openCodeServerRefused(error))return unavailable(openCodeServerRefusal(compatibility?.version),{authenticated:false});
        return unavailable(("OpenCode could not list its providers: "+(error?.message||String(error))).slice(0,500));
      }
      const connected=Array.isArray(catalog?.connectedProviders)?catalog.connectedProviders.length:0,models=Array.isArray(catalog?.models)?catalog.models.length:0;
      authenticated=openCodeCatalogReady(catalog)?true:null;account={connectedProviders:connected};message=openCodeStatusMessage(connected,{external:Boolean(instance.serverUrl),models});
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
    const onKey=this.authMethod(instance)===HARNESS_API_KEY;
    if(!catalog.models.length)return answer({...known,available:false,message:onKey?"Muse Code listed no models for the Meta Model API key. Check the key, then press Refresh.":"Muse Code listed no models. Sign in with muse login, then press Refresh."});
    return answer({...known,available:true,message:onKey?"Muse Code runs on the Meta Model API key.":"Muse Code checks its sign-in when a turn runs. Sign in with muse login if a turn says it is signed out."});
  }
  #museCatalogs=new Map();
  // The models Muse Code lists (readMuseModelCatalog), read once per profile as it is set (its binary, version, environment and
  // approved names): each read starts the 400 MB muse binary, so every status check reuses the last list, an empty one too (Settings'
  // polls, thread starts, model lists, and the listings that answer a harness switch, a profile saved or removed and an install),
  // and a failed read for PROBE_REUSE_MS, after which the next check reads again. Settings' own listing (its open and Refresh), a
  // failed turn's recheck and picking a Muse Code whose list has no models read it again (#museCatalogDue). Reads at once share one.
  async #museCatalog(instance,version){
    const command=this.executable(instance),key=JSON.stringify([command,binarySignature(this.#binaryPaths(instance)),version||null,normalizeApprovedEnvironmentKeys(instance.approvedEnvironmentKeys),instance.environment||{},this.authMethod(instance)]);
    const cached=this.#museCatalogs.get(instance.id),current=cached?.key===key&&!cached.due?cached:null;
    if(current?.pending)return await current.pending;
    if(current&&!current.error)return current.value;
    if(current&&this.now()-current.at<PROBE_REUSE_MS)throw current.error;
    const pending=readMuseModelCatalog({command,env:this.childEnv(instance),authMethod:this.authMethod(instance),cwd:process.cwd()}),entry={key,pending,value:cached?.value||null};
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
      // A probe of the last five minutes lists them, also one whose plan usage read failed: the Usage card reads that again.
      let probe;
      try{probe=await this.claudeCapabilities(instance,{environmentId,maxAgeMs:CLAUDE_CAPABILITIES_TTL_MS})}
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
    const key=[instance.kind,instance.id,this.activeEnvironment(environmentId)?.id||"local",status?.version||"",this.#signInMark(instance)].join("|"),cached=this.#acpModelLists.get(key);
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
  // Its session signs in with the key method on an API key when Antigravity asks (never by itself on Sign in); a refresh that ended because the machine gives Antigravity
  // no IPv6 sockets says so with the stand-in list (#antigravityModelFailures), as nothing of Antigravity's can run there.
  #antigravityModelFailures=new Map();
  #antigravityModels(instance,environmentId){
    const key=[instance.id,this.activeEnvironment(environmentId)?.id||"local"].join("|"),known=this.#antigravityModelLists.get(key);
    if(known)return {models:known.models,metadata:known.metadata,preferred:known.preferred,source:"session"};
    if(!this.#antigravityRefreshes.has(key)&&!this.processSpawner(instance,environmentId)){
      const refresh=(async()=>{
        // Only an Antigravity that can sign in starts: on an API key with a Gemini key, on Sign in once its own sign-in is in its home.
        if(this.authMethod(instance)===HARNESS_API_KEY?!this.harnessKeys(instance).ready:!(await antigravitySignInState({env:this.env})).signedIn){this.#antigravityRefreshes.delete(key);return}
        const folder=await mkdtemp(join(tmpdir(),"trebell-antigravity-models-")),options=this.#acpProbeOptions(instance,environmentId);
        try{
          const setup=await withAcpProbe(options,async(client,initialized)=>(await afterAntigravitySignIn(client,options.env,()=>acpProbeSession(client,initialized,{cwd:folder,timeoutMs:90_000}))).setup);
          this.rememberAcpSessionModels(instance,setup,{environmentId});
        }finally{await rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(()=>{})}
      })().catch(error=>{
        const ipv6=antigravityIpv6Failure(error);if(!ipv6)return;
        // The open windows read the list again, as for a list a session reported, and their composer says why.
        this.#antigravityModelFailures.set(key,ipv6.message);
        for(const listener of [...this.#modelListeners]){try{listener({runtime:"antigravity",instanceId:instance.id,environmentId:this.activeEnvironment(environmentId)?.id||null})}catch{}}
      });
      this.#antigravityRefreshes.set(key,refresh);
    }
    const failure=this.#antigravityModelFailures.get(key);
    return {...antigravitySeedCatalog(),source:"manifest",...(failure?{error:failure}:{})};
  }
  // Claude Code's no-prompt capability probe (models, commands, agents, account and plan usage), run where the profile runs and
  // shared for five minutes.
  claudeCapabilities(instance,{environmentId=undefined,cwd=null,includeUsage=true,fresh=false,maxAgeMs=undefined}={}){
    const profile=this.activeEnvironment(environmentId),spawnProcess=this.processSpawner(instance,environmentId);
    return this.claudeCapabilitiesCache.load({command:this.executable(instance,{environmentId}),cwd,env:this.childEnv(instance),spawnProcess,scope:spawnProcess?String(profile?.id||""):"",includeUsage},{fresh,maxAgeMs});
  }
  // The probes kept for this profile where it runs (every folder's) go, so the next read asks Claude Code again.
  dropClaudeCapabilities(instance,{environmentId=undefined}={}){
    const profile=this.activeEnvironment(environmentId),spawnProcess=this.processSpawner(instance,environmentId);
    this.claudeCapabilitiesCache.drop?.({command:this.executable(instance,{environmentId}),env:this.childEnv(instance),spawnProcess,scope:spawnProcess?String(profile?.id||""):""});
  }
  // The last usage/changed report Muse Code's sessions keep for a Muse home (muse-agent-session.mjs latestMuseSubscriptionUsage: the
  // account's, by the home its host names; the newest of any for a home not known), or null when none came.
  museUsageReport=({museHome=null}={})=>latestMuseSubscriptionUsage({museHome});
  async usageLimits(instanceOrKind,{environmentId=undefined}={}){
    const instance=typeof instanceOrKind==="string"?(this.instances().find(item=>item.kind===normalizeAgentRuntime(instanceOrKind))||defaultInstance(normalizeAgentRuntime(instanceOrKind))):instanceOrKind;
    if(instance.kind==="claude")return readAgentRuntimeUsage("claude",{readCapabilities:()=>this.claudeCapabilities(instance,{environmentId})});
    // Muse Code's are the windows of the last report its sessions keep for the profile's Muse home (the one its status check's host
    // named), as no read asks Muse: MSP's usage/read answers only the host's last report too. A Muse Code runs only on this machine.
    if(instance.kind==="muse")return this.processSpawner(instance,environmentId)?{checkedAt:new Date(this.now()).toISOString(),windows:[],unavailable:{reason:"unsupported",message:MUSE_LOCAL_ONLY}}:museUsageLimits(this.museUsageReport({museHome:this.#museCatalogs.get(instance.id)?.value?.museHome??null}),{now:this.now()});
    // Cursor's, Grok Build's and OpenCode Go's usage would take the sign-in each keeps for itself (its stored login or a token in
    // the environment), which Trebell never reads: their meters say so, until a harness reports its usage over its own protocol.
    return readAgentRuntimeUsage(instance.kind,{name:RUNTIMES[instance.kind]?.name||instance.kind});
  }
  // The full listing answers Settings (its open, Refresh, a sign-in's follow-up) and the runtime mutations, so it checks again.
  // refresh (Settings' own listing) also reads Muse Code's model lists and OpenCode's catalogs again, which the mutations' listings reuse;
  // keepOpenCode (Settings' open, not its Refresh) keeps a complete OpenCode catalog, as those listings do.
  async snapshot({fresh=true,refresh=false,keepOpenCode=false}={}){
    if(refresh)this.#museCatalogDue();
    // Each status of a harness Trebell updates says whether a newer release is out and how it is updated (update). Settings' own
    // listing reads each newest release whose last answer is gone, beside the status checks where it can, else as soon as its check
    // ends, and waits for one once every check has ended, only RELEASE_WAIT_MS after its read began: one that answers while a slower
    // check runs is in this listing, one that answers later the next listing's. The other listings use the last answers.
    const instances=this.instances(),waitMs=refresh?RELEASE_WAIT_MS:null;if(refresh)for(const instance of instances)this.#startReleaseRead(instance);
    const checked=await Promise.all(instances.map(async instance=>{
      const status=await this.probe(instance,{fresh,refresh:refresh&&!keepOpenCode});
      if(refresh)void this.#updateAdvisory(instance,status,{waitMs:0}).catch(()=>null);
      return status;
    }));
    const statuses=await Promise.all(instances.map(async(instance,index)=>{
      const status=checked[index],update=await this.#updateAdvisory(instance,status,{waitMs}).catch(()=>null);
      return update?{...status,update}:status;
    }));
    const publicInstances=instances.map(instance=>{
      const {environment,...safe}=instance;
      // signIn: how the profile signs in, and for each provider whose key it can run on whether Trebell has one (never the key).
      return {...safe,environmentKeys:Object.keys(environment||{}),approvedEnvironmentKeys:normalizeApprovedEnvironmentKeys(instance.approvedEnvironmentKeys),...(harnessTakesApiKey(instance.kind)?{signIn:this.authSummary(instance)}:{})};
    });
    // What a new install runs; an update says its own command in its status's update.
    const installCommand=id=>id==="muse"?museInstallCommand(this.platform):INSTALLABLE_PACKAGES[id]?shownCommand("npm",npmInstallArgs(INSTALLABLE_PACKAGES[id]),this.platform)+(id==="opencode"?" (OpenCode 1.x)":""):null;
    const definitions=this.definitions().map(def=>({...def,installable:Boolean(this.installable(def.id)),packageName:INSTALLABLE_PACKAGES[def.id]||null,installCommand:installCommand(def.id),canAuthenticate:["codex","claude","cursor","grok","opencode","antigravity","muse"].includes(def.id),apiKey:harnessTakesApiKey(def.id)}));
    const active=this.activeInstance();return {selectedRuntime:this.activeRuntime(),selectedInstanceId:active.id,compatibleInstanceIds:this.compatibleInstanceIds(active),capabilities:this.capabilities(active),definitions,instances:publicInstances,statuses,installs:this.installs()};
  }
}
