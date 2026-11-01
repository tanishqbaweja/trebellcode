import { createHash } from "node:crypto";
import { claudeUsageResponseToLimits } from "./agent-usage-limits.mjs";
import { adminMcpFilePresent } from "./claude-managed-mcp.mjs";
import { resolveWindowsCommandShim } from "./windows-command-shim.mjs";

// The capability read. Claude Code, started through its Agent SDK, answers the SDK's initialize request with its models, slash
// commands, agents and account, and on request reports the plan's usage windows. The read never sends a message, so it costs no
// model request, and it stops Claude Code as soon as it has its answers. The cache further down shares one read per Claude Code,
// Claude home, folder and sign-in.
export const CLAUDE_CAPABILITIES_TTL_MS=5*60_000;
// How long the read may take, Claude Code's start included: Trebell's own 30 s, 2.1.2's 25 s and a fifth more, as long as
// Claude Code's --version gets, so a machine slow to start it still has its models, commands and account read.
export const CLAUDE_CAPABILITIES_TIMEOUT_MS=30_000;
// The usage request has a limit of its own: a plan read that hangs costs the answer its usage, never its models and commands.
const PLAN_USAGE_LIMIT_MS=15_000;

// The SDK is imported by the first read that brings no query of its own, not while the server starts (budget B25).
let agentSdk=null;
const loadAgentSdk=()=>agentSdk??=import("@anthropic-ai/claude-agent-sdk");

// Claude Code's own variables whose value the read decides, whatever the caller's environment says
// (code.claude.com/docs/en/env-vars). A text is set; null takes the variable out.
const DECIDED_VARIABLES=new Map([
  // "Set to false to stop Claude Code from fetching claude.ai MCP servers."
  ["ENABLE_CLAUDEAI_MCP_SERVERS","false"],
  // The automatic IDE connection: "Set to false to prevent this."
  ["CLAUDE_CODE_AUTO_CONNECT_IDE","false"],
  // "Set to 1 to skip auto-installation of IDE extensions."
  ["CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL","1"],
  // With any value at all, "0" too, Claude Code takes its terminal for a supported IDE's. A Trebell started from an IDE's terminal
  // may hand it on, so it goes.
  ["FORCE_CODE_TERMINAL",null],
]);

// The read's environment: a copy of the caller's without its own say on the variables above (names compared in capitals, as
// Windows compares them), then the read's values. The caller's object is left as it was.
function readEnvironment(callerEnv){
  const copy={};
  for(const [name,value] of Object.entries(callerEnv??{}))if(!DECIDED_VARIABLES.has(name.toUpperCase()))copy[name]=value;
  for(const [name,value] of DECIDED_VARIABLES)if(value!==null)copy[name]=value;
  return copy;
}

const dropText=()=>{};
// The SDK options of a read (Options in the SDK's sdk.d.ts), one rule per requirement. A rule answers with the options it needs,
// or with nothing when it does not apply, so an option that does not apply is absent rather than undefined. Each read gets
// objects and lists of its own.
const READ_OPTION_RULES=[
  // Started here: the program behind a Windows launcher, since the SDK itself starts only a native binary or a .js file.
  // Started elsewhere: the caller's spawner starts the command it was given, as given.
  ({command,spawnProcess})=>spawnProcess
    ?{pathToClaudeCodeExecutable:command,spawnClaudeCodeProcess:spawnProcess}
    :{pathToClaudeCodeExecutable:resolveWindowsCommandShim(command,{allowScripts:true})},
  // A folder's read runs in that folder; the machine-wide read names none.
  ({cwd})=>cwd?{cwd}:null,
  ({env})=>({env:readEnvironment(env)}),
  ({abortController})=>({abortController}),
  // Nothing to resume later: no transcript goes under the Claude home's projects folder.
  ()=>({persistSession:false}),
  // The person's, the project's and the project's local settings, for the commands and agents they define.
  ()=>({settingSources:["user","project","local"]}),
  // In the flag settings layer, above the person's and the project's files: their hooks and the status line do not run. Hooks an
  // administrator manages are not the read's to turn off, and still run.
  ()=>({settings:{disableAllHooks:true}}),
  // No tool is approved, and the read brings no MCP server.
  ()=>({allowedTools:[],mcpServers:{}}),
  // No MCP server but those named above, that is none (--strict-mcp-config). Next to an administrator's managed-mcp.json Claude
  // Code stops at startup on that flag, so there it stays off.
  ({adminMcpFile})=>adminMcpFile?null:{strictMcpConfig:true},
  ()=>({stderr:dropText}),
];

export function capabilityReadOptions(input={}){
  return Object.assign({},...READ_OPTION_RULES.map(rule=>rule(input)));
}

// Claude Code's input for a read: no message, ever. It ends when the read is over (over settles), also for an iteration that
// begins after that.
async function* noMessage(over){
  await over;
}

// What work settles to, or a failure saying message once ms have passed first. The timer never holds the process open, and it
// is cleared as soon as either settles.
function withinLimit(work,ms,message){
  let timer;
  const late=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(message)),ms);
    timer?.unref?.();
  });
  return Promise.race([work,late]).finally(()=>clearTimeout(timer));
}

// The SDK's usage request without the scan of local transcripts that fills its behaviors section (skipBehaviors): the read wants
// only the plan's rate limits. One that throws before it returns a promise, or an SDK without it, gives a rejected promise.
async function askPlanUsage(session){
  return session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true});
}
// A failure in words: its message, or the failure itself as text when it has none.
const failureWords=failure=>String(failure?.message||failure);

// The usage part of the answer. Nothing that goes wrong here fails the read: the failure comes back as text in usageError,
// beside the models and commands, and the usage answer as Claude Code gave it.
function planUsagePart(session,wanted){
  if(!wanted)return {usage:null,usageError:null};
  return withinLimit(askPlanUsage(session),PLAN_USAGE_LIMIT_MS,"Claude Code did not report usage in time.").then(
    usage=>({usage,usageError:null}),
    failure=>({usage:null,usageError:failureWords(failure)}),
  );
}

const ANSWER_LISTS=["models","commands","agents"];
const isObject=value=>value!==null&&typeof value==="object";

// The read's answer: the initialize answer's lists (an empty one where a list is missing), its account object or null, whether
// that account reads as signed out (what the Usage card says in place of a plan without limits, readClaudeUsageLimits), the usage
// part and when it was read.
function capabilityAnswer(hello,env,usagePart){
  const answer={};
  for(const name of ANSWER_LISTS)answer[name]=Array.isArray(hello?.[name])?hello[name]:[];
  answer.account=isObject(hello?.account)?hello.account:null;
  answer.signedOut=claudeAnsweredSignedOut(answer.account,env);
  return Object.assign(answer,usagePart,{checkedAt:new Date().toISOString()});
}

// One read. query stands in for the SDK's (tests and specs) and managedMcpExists for the look for the administrator's file
// (tests). Only a Claude Code started on this machine reads this machine's managed-mcp.json: one started elsewhere is not looked
// at and keeps strict MCP mode. Whatever happens, the read ends its input, aborts and closes what it started (a close that
// throws is ignored). Input keys that are not the read's (the cache's scope) are ignored.
export async function readClaudeCodeCapabilities({command,cwd=null,env={},spawnProcess=null,withPlanUsage=true,query=null,timeoutMs=CLAUDE_CAPABILITIES_TIMEOUT_MS,managedMcpExists=undefined}={}){
  const start=typeof query==="function"?query:(await loadAgentSdk()).query;
  const adminMcpFile=spawnProcess?false:await adminMcpFilePresent({exists:managedMcpExists});
  const controller=new AbortController();
  let endInput;
  const over=new Promise(resolve=>{endInput=resolve});
  let session=null;
  try{
    session=start({prompt:noMessage(over),options:capabilityReadOptions({command,cwd,env,spawnProcess,abortController:controller,adminMcpFile})});
    const hello=await withinLimit(session.initializationResult(),timeoutMs,"Claude Code did not report its capabilities in time.");
    return capabilityAnswer(hello,env,await planUsagePart(session,withPlanUsage));
  }finally{
    endInput();
    controller.abort();
    try{session?.close?.()}catch{}
  }
}


// Ways an account answer shows a sign-in other than Claude Code's own login: another API backend (Bedrock, Vertex, a gateway, whose
// sign-in these fields cannot show), an API key, an email, a plan.
const OTHER_SIGN_IN=[
  account=>account.apiProvider!==undefined&&account.apiProvider!=="firstParty",
  account=>Boolean(account.apiKeySource)&&account.apiKeySource!=="none",
  account=>Boolean(account.email),
  account=>Boolean(account.subscriptionType),
];
// ANTHROPIC_BASE_URL naming an http(s) host other than Anthropic's own API: a sign-in there does not show in the account either.
function customEndpointIn(env){
  let url;
  try{url=new URL(String(env?.ANTHROPIC_BASE_URL||"").trim())}catch{return false}
  return (url.protocol==="https:"||url.protocol==="http:")&&url.hostname!=="api.anthropic.com";
}
// Claude Code answers signed out with tokenSource "none" and none of the signs above, unless the read went to an endpoint of its own.
function claudeAnsweredSignedOut(account,env){
  if(!isObject(account)||account.tokenSource!=="none")return false;
  return !OTHER_SIGN_IN.some(shows=>shows(account))&&!customEndpointIn(env);
}
// How a probe's Claude Code signs in, as its launch's environment says: on the ANTHROPIC_API_KEY it has (a fingerprint of it, never
// the key), or on the person's own login when it has none (a profile on Sign in never has one, AgentRuntimeManager.childEnv).
function signInOf(env){
  const key=String(env?.ANTHROPIC_API_KEY||"");
  return key?"api-key:"+createHash("sha256").update(key).digest("hex").slice(0,16):"sign-in";
}
// A probe is reused only when it read what it was asked for from a signed-in account: one whose usage
// read failed (what the Usage card says it could not read) and one Claude answered signed out are asked again next time.
function keptClaudeProbe(value,env){
  if(value?.usageError||(value?.usage&&claudeUsageResponseToLimits(value.usage).unavailable?.reason==="probeFailed"))return false;
  return !claudeAnsweredSignedOut(value?.account,env);
}

// One cache per Claude home, executable, working folder and environment (scope names a remote one): each holds the latest
// probe, reused for five minutes when it is kept (keptClaudeProbe), and concurrent readers share the probe in flight. A probe
// that is not kept counts as expired at once, so the Usage card fills in at the next refresh after a passing failure or a
// sign-in. maxAgeMs is how old an answer the caller accepts; by default, the entry's own window. The model list, which a failed
// usage read leaves as it was, takes five minutes (the probe's models and commands do not expire with its usage), and a probe that
// fails puts back the answer it was to replace.
// It is kept per sign-in too (signInOf): a profile moved between its own login and an API key, or onto another key, is asked again,
// never served the account, models and plan usage of the other.
export function createClaudeCapabilitiesCache({probe=readClaudeCodeCapabilities,ttlMs=CLAUDE_CAPABILITIES_TTL_MS,now=()=>Date.now()}={}){
  const entries=new Map();
  const keyOf=({command,cwd,env,spawnProcess,scope})=>[String(command||""),String(env?.CLAUDE_CONFIG_DIR||""),String(cwd||""),spawnProcess?"remote:"+String(scope||""):"local",signInOf(env)].join("\0");
  const current=(entry,maxAgeMs)=>Boolean(entry?.value)&&now()-entry.at<(maxAgeMs??entry.ttl);
  return {
    peek(input={},{maxAgeMs}={}){
      const entry=entries.get(keyOf(input));
      return current(entry,maxAgeMs)?entry.value:null;
    },
    load(input={},{fresh=false,maxAgeMs}={}){
      const key=keyOf(input),entry=entries.get(key);
      // A caller with its own window takes an answer within it at once, even while a probe for another caller runs.
      if(!fresh&&maxAgeMs!=null&&current(entry,maxAgeMs))return Promise.resolve(entry.value);
      if(entry?.pending)return entry.pending;
      if(!fresh&&current(entry))return Promise.resolve(entry.value);
      const previous=entry?.value?{value:entry.value,at:entry.at,ttl:entry.ttl}:null;
      // A probe that was running when its answers were dropped (drop) is not kept, nor does its failure put back what it was to replace.
      const pending=probe(input).then(value=>{const dropped=entries.get(key)?.dropped===pending;entries.set(key,{value,at:now(),ttl:keptClaudeProbe(value,input.env)&&!dropped?ttlMs:0});return value},error=>{const held=entries.get(key);if(held?.pending===pending){if(previous&&held.dropped!==pending)entries.set(key,previous);else entries.delete(key)}throw error});
      entries.set(key,{...(entry||{}),pending});
      return pending;
    },
    // Forgets the answers kept for this executable and Claude home where it runs, every folder's and sign-in's: a sign-out its probe did not see
    // (`claude auth status` finds it signed out, or a turn failed to authenticate) shows at the next read instead of up to five minutes
    // later. A probe still running stays for the readers that wait on it, but its answer is not kept.
    drop(input={}){
      const [command,home,,where]=keyOf({...input,cwd:""}).split("\0");
      for(const [key,entry] of entries){
        const parts=key.split("\0");if(parts[0]!==command||parts[1]!==home||parts[3]!==where)continue;
        if(entry.pending)entries.set(key,{pending:entry.pending,dropped:entry.pending});else entries.delete(key);
      }
    },
    clear(){entries.clear()},
  };
}

export const claudeCapabilities=createClaudeCapabilitiesCache();

const CLAUDE_EFFORTS=new Set(["low","medium","high","xhigh","max"]);
// Model rows as the Claude Code initialize answer lists them; "default" is Claude Code's own default model.
export function claudeModelCatalog(probe){
  const rows=(Array.isArray(probe?.models)?probe.models:[]).filter(row=>row&&typeof row.value==="string"&&row.value.trim());
  const metadata=rows.map(row=>{
    const efforts=(Array.isArray(row.supportedEffortLevels)?row.supportedEffortLevels:[]).filter(value=>CLAUDE_EFFORTS.has(value));
    return {
      id:row.value,name:String(row.displayName||row.value),provider:"claude",agent:"Claude Code",
      ...(row.description?{description:String(row.description)}:{}),
      ...(row.resolvedModel?{resolvedModel:String(row.resolvedModel)}:{}),
      supportedReasoningEfforts:efforts,
      supportsFastMode:row.supportsFastMode===true,
      ...(row.supportsFastMode===true?{supportedServiceTiers:["fast"]}:{}),
    };
  });
  const models=metadata.map(row=>row.id);
  return {models,metadata,preferred:models.includes("default")?"default":(models[0]||null)};
}
