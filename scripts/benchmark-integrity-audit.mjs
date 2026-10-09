import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Integrity audit of saved benchmark agent logs (Codex rollouts and Trebell Native events).
// It flags hosted web use (web.run, web_search_call, ChatGPT connector search), network-capable
// commands, git history beyond HEAD, reads of verifier/solution paths and requests for user input,
// and pairs each Codex call with its output so a reviewer can see whether a fetch returned content.
// Hosted web use makes a lane invalid by policy; every other flag needs review before the result counts.

const LOCAL_CODEX_TOOLS=new Set(["exec_command","exec","write_stdin","apply_patch","view_image","clock__curr_time","sleep","wait","update_plan","request_user_input","request_user_input_async","shell","local_shell"]);
const HOSTED_WEB_TOOL=/web|search|browse|browser|fetch|http|url|internet|mcp__/i;
const USER_INPUT_TOOL=/^request_user_input(?:_async)?$/;
const NETWORK_RULES=[
  ["cli-fetch",/\b(?:curl|wget|aria2c|lynx|w3m|httpie)\b/i],
  ["git-network",/\bgit\b[^\n;|&]{0,120}?\b(?:clone|fetch|pull|ls-remote|remote\s+add|submodule\s+update)\b/i],
  ["python-http",/\b(?:urllib\.request|urllib2|urlopen|requests\.(?:get|post|head|put|Session|request)|http\.client|httpx|aiohttp|pycurl|ftplib|socket\.create_connection|urlretrieve)\b/i],
  ["node-http",/(?:\bfetch\s*\(\s*['"`]https?:|\bhttps?\.(?:get|request)\s*\(|\baxios\b|\bundici\b)/i],
  ["package-install",/\b(?:pip3?|uv\s+pip|python3?\s+-m\s+pip)\s+(?:install|download)\b|\b(?:conda|mamba|micromamba)\s+install\b|\b(?:npm|pnpm|yarn)\s+(?:install|i|add|view|info|pack)\b|\bnpx\s|\b(?:apt|apt-get|apk|yum|dnf)\s+(?:install|update|add)\b|\bcargo\s+(?:install|add|fetch)\b|\bgo\s+(?:get|install|mod\s+download)\b|\bgem\s+install\b|\bcomposer\s+require\b/i],
];
const GIT_HISTORY=/\bgit\b[^\n;|&]{0,80}?\b(?:log|rev-list|show|shortlog|branch|for-each-ref|describe|tag|cat-file|ls-tree|diff)\b[^\n;|&]{0,160}?(?:--all\b|--remotes\b|--branches\b|--tags\b|\borigin\/|\brefs\/|\bFETCH_HEAD\b|@\{u\})|\bgit\s+reflog\b|\bgit\s+fsck\b/i;
const VERIFIER_PATH=/(?:^|[\s'"(=])\/(?:tests|solution|oracle)(?:\/|\b)|\btest_outputs\.py\b|\bsolution\.sh\b|\/logs\/verifier\b/i;
const URL_PATTERN=/https?:\/\/[^\s"'`\\)<>\]]+/gi;
const LOCAL_HOST=/^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1|example\.(?:com|org|net)|host\.docker\.internal)$/i;
const NETWORK_FAILURE=/could not resolve host|name or service not known|temporary failure in name resolution|network is unreachable|connection refused|failed to establish a new connection|urlopen error|max retries exceeded|nodename nor servname|getaddrinfo|no route to host|connectionerror/i;
const SNIPPET_CHARS=600,OUTPUT_CHARS=400,MAX_FINDINGS=60;

function unescapeJs(text){return String(text||"").replace(/\\n/g,"\n").replace(/\\t/g,"\t").replace(/\\"/g,'"').replace(/\\'/g,"'").replace(/\\\\/g,"\\")}
export function externalHosts(text){
  const hosts=new Set();
  for(const match of String(text||"").matchAll(URL_PATTERN)){try{const host=new URL(match[0]).hostname.toLowerCase();if(host&&!LOCAL_HOST.test(host))hosts.add(host)}catch{}}
  return [...hosts];
}
export function classifyCommandText(text){
  const value=String(text||""),kinds=NETWORK_RULES.filter(([,pattern])=>pattern.test(value)).map(([kind])=>kind);
  if(GIT_HISTORY.test(value))kinds.push("git-history");
  if(VERIFIER_PATH.test(value))kinds.push("verifier-path");
  return kinds;
}
function outputText(output){
  if(output==null)return "";
  if(typeof output==="string")return output;
  if(Array.isArray(output))return output.map(part=>typeof part==="string"?part:part?.text??"").join("\n");
  if(typeof output==="object")return String(output.output??output.text??JSON.stringify(output));
  return String(output);
}
function parseLines(text){
  const rows=[];let line=0;
  for(const raw of String(text||"").split(/\r?\n/)){line++;if(!raw.trim())continue;try{rows.push({line,row:JSON.parse(raw)})}catch{}}
  return rows;
}

export function auditCodexRolloutText(text,{file=null}={}){
  const findings=[],byCall=new Map();
  const add=(finding,callId)=>{findings.push(finding);if(callId){if(!byCall.has(callId))byCall.set(callId,[]);byCall.get(callId).push(finding)}};
  for(const {line,row} of parseLines(text)){
    if(row?.type!=="response_item")continue;
    const payload=row.payload||{};
    if(payload.type==="web_search_call"){add({kind:"hosted-web",tool:"web_search_call",file,line,snippet:JSON.stringify(payload.action||payload).slice(0,SNIPPET_CHARS)});continue}
    if(payload.type==="custom_tool_call"||payload.type==="function_call"){
      const raw=payload.type==="custom_tool_call"?String(payload.input||""):String(payload.arguments||"");
      const names=payload.type==="custom_tool_call"?[...raw.matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/g)].map(match=>match[1]):[String(payload.name||"")];
      if(payload.type==="custom_tool_call"&&payload.name&&payload.name!=="exec")names.push(String(payload.name));
      const plain=unescapeJs(raw),callId=payload.call_id||null;
      for(const name of new Set(names)){
        if(USER_INPUT_TOOL.test(name))add({kind:"user-input",tool:name,file,line,callId,snippet:plain.slice(0,SNIPPET_CHARS)},callId);
        else if(LOCAL_CODEX_TOOLS.has(name))continue;
        else if(HOSTED_WEB_TOOL.test(name))add({kind:"hosted-web",tool:name,file,line,callId,snippet:plain.slice(0,SNIPPET_CHARS)},callId);
        else add({kind:"unknown-tool",tool:name,file,line,callId,snippet:plain.slice(0,SNIPPET_CHARS)},callId);
      }
      const kinds=classifyCommandText(plain);
      if(kinds.length)add({kind:"command",kinds,hosts:externalHosts(plain),file,line,callId,snippet:plain.slice(0,SNIPPET_CHARS)},callId);
      continue;
    }
    if(payload.type==="custom_tool_call_output"||payload.type==="function_call_output"){
      const related=byCall.get(payload.call_id);if(!related)continue;
      const output=outputText(payload.output);
      for(const finding of related)if(finding.output==null)Object.assign(finding,{output:output.slice(0,OUTPUT_CHARS),outputChars:output.length,outputHosts:externalHosts(output).slice(0,12),networkFailureSeen:NETWORK_FAILURE.test(output)});
    }
  }
  return findings;
}

export function auditNativeEventsText(text,{file=null}={}){
  const findings=[],byCall=new Map();
  for(const {line,row} of parseLines(text)){
    const data=row?.data||{};
    if(row?.name==="native.tool.requested"){
      const tool=`${data.namespace}.${data.name}`,audit=data.terminalAudit;
      if(!/^trebell_(?:repo|workspace|output|terminal|process)\./.test(tool))findings.push({kind:"unknown-tool",tool,file,line,callId:data.callId||null,snippet:JSON.stringify(data).slice(0,SNIPPET_CHARS)});
      if(tool==="trebell_process.start"&&!audit)findings.push({kind:"unlogged-command",tool,file,line,callId:data.callId||null,snippet:"process command is not recorded in the event log"});
      if(!audit)continue;
      const command=String(audit.gateCommand||audit.redactedCommand||""),kinds=classifyCommandText(command);
      if(audit.networkLike===true&&!kinds.length)kinds.push("network-like");
      if(!kinds.length)continue;
      const finding={kind:"command",kinds,hosts:[...new Set([...(Array.isArray(audit.hosts)?audit.hosts:[]),...externalHosts(command)])].filter(host=>!LOCAL_HOST.test(host)),file,line,callId:data.callId||null,snippet:command.slice(0,SNIPPET_CHARS)};
      findings.push(finding);if(data.callId)byCall.set(data.callId,finding);
    }else if(row?.name==="native.tool.completed"&&byCall.has(data.callId)){
      Object.assign(byCall.get(data.callId),{success:data.success===true,error:data.error?String(data.error).slice(0,OUTPUT_CHARS):null});
    }
  }
  return findings;
}

export function summarizeIntegrityFindings(findings=[]){
  const list=Array.isArray(findings)?findings:[],commands=list.filter(finding=>finding.kind==="command");
  const summary={
    hostedWebCalls:list.filter(finding=>finding.kind==="hosted-web").length,
    hostedWebTools:[...new Set(list.filter(finding=>finding.kind==="hosted-web").map(finding=>finding.tool))],
    networkCommands:commands.filter(finding=>finding.kinds.some(kind=>kind!=="git-history"&&kind!=="verifier-path")).length,
    externalHosts:[...new Set(list.flatMap(finding=>[...(finding.hosts||[]),...(finding.outputHosts||[])]))].slice(0,40),
    gitHistoryCommands:commands.filter(finding=>finding.kinds.includes("git-history")).length,
    verifierPathReads:commands.filter(finding=>finding.kinds.includes("verifier-path")).length,
    userInputRequests:list.filter(finding=>finding.kind==="user-input").length,
    unknownTools:[...new Set(list.filter(finding=>finding.kind==="unknown-tool").map(finding=>finding.tool))],
    unloggedCommands:list.filter(finding=>finding.kind==="unlogged-command").length,
  };
  summary.status=summary.hostedWebCalls>0?"invalid":summary.networkCommands||summary.gitHistoryCommands||summary.verifierPathReads||summary.unknownTools.length?"review":"clean";
  return summary;
}

async function walkFiles(root){
  const out=[];let entries=[];try{entries=await readdir(root,{withFileTypes:true})}catch{return out}
  for(const entry of entries){
    const path=join(root,entry.name);
    if(entry.isDirectory())out.push(...await walkFiles(path));
    else if(entry.isFile())out.push(path);
  }
  return out;
}

export async function auditTrialDirectory(trialDir){
  const findings=[];let logs=0;
  for(const path of await walkFiles(join(trialDir,"agent"))){
    const normalized=path.split("\\").join("/");
    const codex=/\/codex-sessions\/.*\.jsonl$/.test(normalized),native=/\/trebell-native-events\.jsonl$/.test(normalized);
    if(!codex&&!native)continue;
    let text="";try{text=await readFile(path,"utf8")}catch{continue}
    logs++;findings.push(...(codex?auditCodexRolloutText(text,{file:normalized}):auditNativeEventsText(text,{file:normalized})));
  }
  return {trialDir:trialDir.split("\\").join("/"),logs,summary:summarizeIntegrityFindings(findings),findings:findings.slice(0,MAX_FINDINGS),findingsOmitted:Math.max(0,findings.length-MAX_FINDINGS)};
}

export async function auditJobIntegrity(outputRoot,jobName){
  let entries=[];try{entries=await readdir(join(outputRoot,jobName),{withFileTypes:true})}catch{return null}
  const trials=[];
  for(const entry of entries)if(entry.isDirectory())trials.push(await auditTrialDirectory(join(outputRoot,jobName,entry.name)));
  const audited=trials.filter(trial=>trial.logs>0);
  if(!audited.length)return {jobName,logs:0,summary:{...summarizeIntegrityFindings([]),status:"no-logs"},trials:[]};
  return {jobName,logs:audited.reduce((sum,trial)=>sum+trial.logs,0),summary:summarizeIntegrityFindings(audited.flatMap(trial=>trial.findings)),trials:audited};
}

export function compactIntegrity(audit){
  if(!audit)return null;
  return {status:audit.summary.status,logs:audit.logs,...audit.summary,evidence:audit.trials.flatMap(trial=>trial.findings).filter(finding=>finding.kind!=="unlogged-command").slice(0,8).map(finding=>({kind:finding.kind,kinds:finding.kinds,tool:finding.tool,hosts:finding.hosts,file:finding.file,line:finding.line,snippet:String(finding.snippet||"").slice(0,240),networkFailureSeen:finding.networkFailureSeen}))};
}

async function main(){
  const outputRoot=process.argv[2],jobNames=process.argv.slice(3);
  if(!outputRoot)throw new Error("Usage: node scripts/benchmark-integrity-audit.mjs <jobs-root> [job-name ...]");
  const root=resolve(outputRoot),names=jobNames.length?jobNames:(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name);
  const results=[];
  for(const name of names){const audit=await auditJobIntegrity(root,name);if(audit)results.push({jobName:name,...compactIntegrity(audit)})}
  process.stdout.write(JSON.stringify(results,null,2)+"\n");
  if(results.some(result=>result.status==="invalid"))process.exitCode=2;
}

if(resolve(process.argv[1]||"")===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error?.message||error);process.exitCode=1});
