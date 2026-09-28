import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

const root=resolve(process.cwd(),String(process.argv[2]||""));
if(!process.argv[2])throw new Error("Usage: node scripts/summarize-harbor-native-run.mjs <harbor-job-or-trial-dir>");

async function readable(path){
  try{await readFile(path);return true}catch{return false}
}

async function locateTrial(path){
  if(await readable(resolve(path,"agent","trebell-native-events.jsonl")))return path;
  for(const entry of await readdir(path,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    const candidate=resolve(path,entry.name);
    if(await readable(resolve(candidate,"agent","trebell-native-events.jsonl")))return candidate;
  }
  throw new Error("Could not find a Trebell Native Harbor trial beneath "+path);
}

const trial=await locateTrial(root);
const events=(await readFile(resolve(trial,"agent","trebell-native-events.jsonl"),"utf8"))
  .split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
const models=events.filter(event=>event.name==="native.model.completed");
const requestedTools=events.filter(event=>event.name==="native.tool.requested");
const completedTools=events.filter(event=>event.name==="native.tool.completed");
const edits=completedTools.filter(event=>event.status==="completed"&&event.data?.namespace==="trebell_workspace"&&["write_file","replace_text"].includes(event.data?.name));
const usage={inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0};
for(const event of models)for(const key of Object.keys(usage))usage[key]+=Number(event.data?.usage?.[key]||0);
const toolMix={};
for(const event of requestedTools){
  const key=String(event.data?.namespace||"unknown")+"/"+String(event.data?.name||"unknown");
  toolMix[key]=(toolMix[key]||0)+1;
}
const longestModel=models.reduce((best,event)=>Number(event.data?.durationMs||0)>Number(best?.data?.durationMs||0)?event:best,null);
const longestTool=completedTools.reduce((best,event)=>Number(event.data?.durationMs||0)>Number(best?.data?.durationMs||0)?event:best,null);
const terminal=events.findLast(event=>event.name==="native.turn.completed"||event.name==="native.turn.blocked")||null;
const coolingEvents=events.filter(event=>event.name==="native.tool.history_cooled");
const pressureEvents=events.filter(event=>event.name==="native.progress.implementation_pressure");
const pressureBlocked=events.filter(event=>event.name==="native.progress.implementation_call_blocked");
const providerTelemetry=models.map(event=>event.data?.providerTelemetry).filter(Boolean);
const cacheDiagnostics=providerTelemetry.map(item=>item?.promptCacheDiagnostics).filter(Boolean);
const continuationTelemetry=providerTelemetry.map(item=>item?.responseContinuation).filter(Boolean);
const uncachedInputTokens=Math.max(0,usage.inputTokens-usage.cachedInputTokens);
let metrics=null;
try{metrics=JSON.parse(await readFile(resolve(trial,"agent","trebell-native-metrics.json"),"utf8"))}catch{}

console.log(JSON.stringify({
  trial:basename(trial),
  elapsedEventMs:Number(events.at(-1)?.atMs||0),
  modelTurns:models.length,
  toolCalls:requestedTools.length,
  successfulToolCalls:completedTools.filter(event=>event.status==="completed").length,
  failedToolCalls:completedTools.filter(event=>event.status==="failed").length,
  firstEdit:edits[0]?{atMs:edits[0].atMs,toolCall:edits[0].data?.toolCall,name:edits[0].data?.name}:null,
  editCount:edits.length,
  usage,
  uncachedInputTokens,
  cacheHitPercent:usage.inputTokens?Number((usage.cachedInputTokens/usage.inputTokens*100).toFixed(2)):null,
  cacheDiagnostics:{
    hits:cacheDiagnostics.filter(item=>item?.type==="cache_hit").length,
    misses:cacheDiagnostics.filter(item=>item?.type==="cache_miss").length,
    unavailable:cacheDiagnostics.filter(item=>item?.type==="unavailable").length,
  },
  responseContinuation:{
    used:continuationTelemetry.filter(item=>item?.used===true).length,
    notUsed:continuationTelemetry.filter(item=>item?.used===false).length,
    fallbacks:continuationTelemetry.filter(item=>item?.fallback===true).length,
    savedRequestBytes:continuationTelemetry.reduce((sum,item)=>sum+Number(item?.savedRequestBytes||0),0),
  },
  historyCooling:{
    events:coolingEvents.length,
    savedChars:coolingEvents.reduce((sum,event)=>sum+Number(event.data?.savedChars||0),0),
    toolResultSavedChars:coolingEvents.reduce((sum,event)=>sum+Number(event.data?.toolResultSavedChars||0),0),
    toolCallArgumentSavedChars:coolingEvents.reduce((sum,event)=>sum+Number(event.data?.toolCallArgumentSavedChars||0),0),
  },
  implementationPressure:{
    requests:pressureEvents.length,
    blockedToolCalls:pressureBlocked.length,
  },
  toolMix,
  longestModel:longestModel?{turn:longestModel.data?.modelTurn,durationMs:Math.round(Number(longestModel.data?.durationMs||0)),inputTokens:longestModel.data?.usage?.inputTokens||0,outputTokens:longestModel.data?.usage?.outputTokens||0}:null,
  longestTool:longestTool?{toolCall:longestTool.data?.toolCall,tool:String(longestTool.data?.namespace||"")+"/"+String(longestTool.data?.name||""),durationMs:Math.round(Number(longestTool.data?.durationMs||0)),status:longestTool.status}:null,
  terminal:terminal?{name:terminal.name,status:terminal.status,atMs:terminal.atMs,data:terminal.data}:null,
  metrics,
},null,2));
