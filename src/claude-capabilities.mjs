import { query as claudeAgentQuery } from "@anthropic-ai/claude-agent-sdk";
import { resolveWindowsCommandShim } from "./windows-command-shim.mjs";

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
// skips IDE discovery: it is a noninteractive health check.
export function claudeCapabilitiesProbeOptions({command,cwd=null,env={},spawnProcess=null,abortController}={}){
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
    strictMcpConfig:true,
    env:environment,
    ...(cwd?{cwd}:{}),
    stderr:()=>{},
    ...(spawnProcess?{spawnClaudeCodeProcess:spawnProcess}:{}),
  };
}

export async function probeClaudeCapabilities({command,cwd=null,env={},spawnProcess=null,includeUsage=true,query=claudeAgentQuery,timeoutMs=CLAUDE_CAPABILITIES_TIMEOUT_MS}={}){
  const abortController=new AbortController();
  const prompt=(async function*(){
    await new Promise(resolve=>{if(abortController.signal.aborted)resolve();else abortController.signal.addEventListener("abort",()=>resolve(),{once:true})});
  })();
  let runtime=null;
  try{
    runtime=query({prompt,options:claudeCapabilitiesProbeOptions({command,cwd,env,spawnProcess,abortController})});
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

// One cache per Claude home, executable, working folder and environment (scope names a remote one): each holds the latest
// probe for five minutes, and concurrent readers share the probe in flight.
export function createClaudeCapabilitiesCache({probe=probeClaudeCapabilities,ttlMs=CLAUDE_CAPABILITIES_TTL_MS,now=()=>Date.now()}={}){
  const entries=new Map();
  const keyOf=({command,cwd,env,spawnProcess,scope})=>[String(command||""),String(env?.CLAUDE_CONFIG_DIR||""),String(cwd||""),spawnProcess?"remote:"+String(scope||""):"local"].join("\0");
  return {
    peek(input={},{maxAgeMs=ttlMs}={}){
      const entry=entries.get(keyOf(input));
      return entry?.value&&now()-entry.at<maxAgeMs?entry.value:null;
    },
    load(input={},{fresh=false}={}){
      const key=keyOf(input),entry=entries.get(key);
      if(entry?.pending)return entry.pending;
      if(!fresh&&entry?.value&&now()-entry.at<ttlMs)return Promise.resolve(entry.value);
      const pending=probe(input).then(value=>{entries.set(key,{value,at:now()});return value},error=>{if(entries.get(key)?.pending===pending)entries.delete(key);throw error});
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
