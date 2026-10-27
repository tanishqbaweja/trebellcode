import { claudeUsageResponseToLimits } from "./agent-usage-limits.mjs";
import { hasClaudeManagedMcpConfig } from "./claude-managed-mcp.mjs";
import { resolveWindowsCommandShim } from "./windows-command-shim.mjs";

// The Claude Agent SDK loads with the first probe that needs it, not with the server (budget B25).
let claudeAgentSdk=null;
const loadClaudeAgentSdk=()=>claudeAgentSdk??=import("@anthropic-ai/claude-agent-sdk");

// Claude Code reports its models, slash commands, agents, account and plan usage through the SDK initialize handshake.
// The probe (as T3 Code's ClaudeProvider does it) offers a prompt that never yields, so no message reaches the model API:
// the CLI finishes its local initialization, the answer is read, and the process is stopped.
export const CLAUDE_CAPABILITIES_TTL_MS=5*60_000;
export const CLAUDE_CAPABILITIES_TIMEOUT_MS=25_000;
const CLAUDE_USAGE_TIMEOUT_MS=15_000;

function withTimeout(promise,ms,message){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);timer.unref?.()})]).finally(()=>clearTimeout(timer));
}

// The probe keeps the filesystem setting sources (workspace commands and agents) but runs no hooks, starts no MCP server and
// skips IDE discovery: it is a noninteractive health check. Next to an administrator's managed-mcp.json (managedMcpConfig), which
// already allows only the managed servers, Claude Code exits at startup on --strict-mcp-config, so that flag goes, and only that.
export function claudeCapabilitiesProbeOptions({command,cwd=null,env={},spawnProcess=null,abortController,managedMcpConfig=false}={}){
  const environment={...env,ENABLE_CLAUDEAI_MCP_SERVERS:"false",CLAUDE_CODE_AUTO_CONNECT_IDE:"0",CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL:"1"};
  delete environment.FORCE_CODE_TERMINAL;
  return {
    persistSession:false,
    // A Windows .cmd shim cannot be spawned directly; the SDK runs a native binary or a .js entry itself.
    pathToClaudeCodeExecutable:spawnProcess?command:resolveWindowsCommandShim(command,{allowScripts:true}),
    abortController,
    settingSources:["user","project","local"],
    settings:{disableAllHooks:true},
    allowedTools:[],
    mcpServers:{},
    ...(managedMcpConfig?{}:{strictMcpConfig:true}),
    env:environment,
    ...(cwd?{cwd}:{}),
    stderr:()=>{},
    ...(spawnProcess?{spawnClaudeCodeProcess:spawnProcess}:{}),
  };
}

// managedMcpExists: the managed-mcp.json check's exists(path), for tests. A Claude Code started elsewhere (spawnProcess) reads its own
// machine's managed file, which this check cannot see, so it keeps the flag.
export async function probeClaudeCapabilities({command,cwd=null,env={},spawnProcess=null,includeUsage=true,query=null,timeoutMs=CLAUDE_CAPABILITIES_TIMEOUT_MS,managedMcpExists=undefined}={}){
  const startQuery=query||(await loadClaudeAgentSdk()).query;
  const managedMcpConfig=!spawnProcess&&await hasClaudeManagedMcpConfig({exists:managedMcpExists});
  const abortController=new AbortController();
  const prompt=(async function*(){
    await new Promise(resolve=>{if(abortController.signal.aborted)resolve();else abortController.signal.addEventListener("abort",()=>resolve(),{once:true})});
  })();
  let runtime=null;
  try{
    runtime=startQuery({prompt,options:claudeCapabilitiesProbeOptions({command,cwd,env,spawnProcess,abortController,managedMcpConfig})});
    const init=await withTimeout(runtime.initializationResult(),timeoutMs,"Claude Code did not report its capabilities in time.");
    // Usage has its own deadline so a slow optional read cannot discard the initialization answer. skipBehaviors skips the
    // local transcript scan: only the plan rate limits are read.
    let usage=null,usageError=null;
    if(includeUsage){
      try{usage=await withTimeout(runtime.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true}),CLAUDE_USAGE_TIMEOUT_MS,"Claude Code did not report usage in time.")}
      catch(error){usageError=String(error?.message||error)}
    }
    return {
      models:Array.isArray(init?.models)?init.models:[],
      commands:Array.isArray(init?.commands)?init.commands:[],
      agents:Array.isArray(init?.agents)?init.agents:[],
      account:init?.account&&typeof init.account==="object"?init.account:null,
      usage,usageError,
      checkedAt:new Date().toISOString(),
    };
  }finally{
    abortController.abort();
    try{runtime?.close?.()}catch{}
  }
}

// Claude Code answers signed out with tokenSource "none" and no API key, email or plan (T3 Code's claudeAuthStatus). Another API
// backend (Bedrock, Vertex, a gateway) or a custom ANTHROPIC_BASE_URL signs in where these fields cannot show it.
function claudeProbeSignedOut(account,env={}){
  if(!account||typeof account!=="object"||account.tokenSource!=="none")return false;
  if(account.apiProvider!==undefined&&account.apiProvider!=="firstParty")return false;
  if((account.apiKeySource&&account.apiKeySource!=="none")||account.email||account.subscriptionType)return false;
  let endpoint=null;try{endpoint=new URL(String(env?.ANTHROPIC_BASE_URL||"").trim())}catch{}
  return !(endpoint&&/^https?:$/.test(endpoint.protocol)&&endpoint.hostname&&endpoint.hostname!=="api.anthropic.com");
}
// A probe is reused only when it read what it was asked for from a signed-in account (T3 Code's ClaudeDriver): one whose usage
// read failed (what the Usage card says it could not read) and one Claude answered signed out are asked again next time.
function keptClaudeProbe(value,env){
  if(value?.usageError||(value?.usage&&claudeUsageResponseToLimits(value.usage).unavailable?.reason==="probeFailed"))return false;
  return !claudeProbeSignedOut(value?.account,env);
}

// One cache per Claude home, executable, working folder and environment (scope names a remote one): each holds the latest
// probe, reused for five minutes when it is kept (keptClaudeProbe), and concurrent readers share the probe in flight. A probe
// that is not kept counts as expired at once, so the Usage card fills in at the next refresh after a passing failure or a
// sign-in. maxAgeMs is how old an answer the caller accepts; by default, the entry's own window. The model list, which a failed
// usage read leaves as it was, takes five minutes (the probe's models and commands do not expire with its usage), and a probe that
// fails puts back the answer it was to replace.
export function createClaudeCapabilitiesCache({probe=probeClaudeCapabilities,ttlMs=CLAUDE_CAPABILITIES_TTL_MS,now=()=>Date.now()}={}){
  const entries=new Map();
  const keyOf=({command,cwd,env,spawnProcess,scope})=>[String(command||""),String(env?.CLAUDE_CONFIG_DIR||""),String(cwd||""),spawnProcess?"remote:"+String(scope||""):"local"].join("\0");
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
      const pending=probe(input).then(value=>{entries.set(key,{value,at:now(),ttl:keptClaudeProbe(value,input.env)?ttlMs:0});return value},error=>{if(entries.get(key)?.pending===pending){if(previous)entries.set(key,previous);else entries.delete(key)}throw error});
      entries.set(key,{...(entry||{}),pending});
      return pending;
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
