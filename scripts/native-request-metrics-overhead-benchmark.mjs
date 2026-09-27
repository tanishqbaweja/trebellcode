import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { attachNativePromptProvenance, NATIVE_PROMPT_PROVENANCE, nativeRequestMetrics } from "../src/native-request-metrics.mjs";

function json(value){try{return JSON.stringify(value??null)}catch{return String(value??"")}}
function bytes(value){return Buffer.byteLength(typeof value==="string"?value:json(value),"utf8")}
function estimate(byteCount){return Math.max(0,Math.ceil(Number(byteCount||0)/4))}
function metric(value){const serialized=typeof value==="string"?value:json(value),byteCount=bytes(serialized);return {bytes:byteCount,estimatedTokens:estimate(byteCount)}}
function hash(value){return createHash("sha256").update(typeof value==="string"?value:json(value)).digest("hex").slice(0,16)}
function provenance(value){return value&&typeof value==="object"?value[NATIVE_PROMPT_PROVENANCE]||null:null}
function currentTurnBreakdown(message){
  const meta=provenance(message);
  if(!meta||typeof meta!=="object")return {currentUser:metric(message?[message]:[]),workingContext:metric([]),applicationContext:metric([]),untrustedContext:metric([]),contextEnvelope:metric([])};
  const userParts=Array.isArray(meta.userParts)?meta.userParts:[],contextText=String(meta.contextText||""),application=(Array.isArray(meta.contextEntries)?meta.contextEntries:[]).filter(item=>item?.kind==="application").map(item=>item.value),untrusted=(Array.isArray(meta.contextEntries)?meta.contextEntries:[]).filter(item=>item?.kind!=="application").map(item=>item.value),entryText=(Array.isArray(meta.contextEntries)?meta.contextEntries:[]).map(item=>String(item?.value||"")).join(""),contextBytes=bytes(contextText),entryBytes=bytes(entryText);
  return {currentUser:metric(userParts),workingContext:metric(contextText),applicationContext:metric(application),untrustedContext:metric(untrusted),contextEnvelope:{bytes:Math.max(0,contextBytes-entryBytes),estimatedTokens:estimate(Math.max(0,contextBytes-entryBytes))}};
}
function baseline(messages=[],tools=[]){
  const source=Array.isArray(messages)?messages:[],lastUser=[...source].map((item,index)=>({item,index})).reverse().find(entry=>entry.item?.role==="user")?.index??-1,system=source.filter(item=>item?.role==="system"),developer=source.filter(item=>item?.role==="developer"&&!item?.trebellCompaction),compacted=source.filter(item=>item?.role==="developer"&&item?.trebellCompaction),toolResults=source.filter(item=>item?.role==="tool"),history=source.filter((item,index)=>!["system","developer","tool"].includes(item?.role)&&index!==lastUser),toolSchemas=Array.isArray(tools)?tools:[],messagesMetric=metric(source),toolsMetric=metric(toolSchemas),currentBreakdown=currentTurnBreakdown(lastUser>=0?source[lastUser]:null),prefix={system,developer,tools:toolSchemas};
  return {estimation:"utf8_bytes_div_4",system:metric(system),developer:metric(developer),compactedContext:metric(compacted),conversationHistory:metric(history),...currentBreakdown,toolResults:metric(toolResults),toolSchemas:toolsMetric,messages:messagesMetric,totalLogical:{bytes:messagesMetric.bytes+toolsMetric.bytes,estimatedTokens:estimate(messagesMetric.bytes+toolsMetric.bytes)},messageCount:source.length,toolFunctionCount:toolSchemas.reduce((sum,entry)=>sum+(Array.isArray(entry?.tools)?entry.tools.length:(entry?.type==="function"?1:0)),0),stablePrefixHash:hash(prefix),systemHash:hash(system),developerHash:hash(developer),toolSchemaHash:hash(toolSchemas),conversationHistoryHash:hash(history)};
}

const messages=[];
messages.push({role:"system",content:"system "+"s".repeat(4000)},{role:"developer",content:"developer "+"d".repeat(3000)});
for(let index=0;index<1200;index++){
  messages.push({role:"user",content:`request-${index} `+"u".repeat(280)});
  messages.push({role:"assistant",content:`answer-${index} `+"a".repeat(420)});
  if(index%3===0)messages.push({role:"tool",toolCallId:`tool-${index}`,content:`result-${index} `+"r".repeat(900)});
  if(index%100===0)messages.push({role:"developer",trebellCompaction:true,content:`compact-${index} `+"c".repeat(700)});
}
const last=messages.findLastIndex(message=>message.role==="user");messages[last]=attachNativePromptProvenance(messages[last],{userParts:[messages[last].content],contextText:"context "+"x".repeat(1800),contextEntries:[{source:"goal",kind:"application",value:"g".repeat(600)},{source:"repo",kind:"untrusted",value:"e".repeat(900)}]});
const tools=Array.from({length:12},(_,index)=>({type:"namespace",name:`ns_${index}`,tools:Array.from({length:5},(_,tool)=>({name:`tool_${tool}`,description:"description "+"z".repeat(220),inputSchema:{type:"object",properties:{path:{type:"string"},limit:{type:"integer"}}}}))}));
assert.deepEqual(nativeRequestMetrics(messages,tools),baseline(messages,tools));
const iterations=50,rounds=7;
function measure(fn){global.gc?.();const started=performance.now();let checksum=0;for(let index=0;index<iterations;index++)checksum+=fn(messages,tools).totalLogical.bytes;return {durationMs:Number((performance.now()-started).toFixed(3)),checksum}}
function median(values){const ordered=[...values].sort((a,b)=>a-b),middle=Math.floor(ordered.length/2);return ordered.length%2?ordered[middle]:(ordered[middle-1]+ordered[middle])/2}
for(let index=0;index<5;index++){baseline(messages,tools);nativeRequestMetrics(messages,tools)}
const baselineRuns=[],candidateRuns=[];
for(let round=0;round<rounds;round++){
  if(round%2===0){baselineRuns.push(measure(baseline));candidateRuns.push(measure(nativeRequestMetrics))}
  else{candidateRuns.push(measure(nativeRequestMetrics));baselineRuns.push(measure(baseline))}
}
assert.ok(baselineRuns.every(run=>run.checksum===candidateRuns[0].checksum));assert.ok(candidateRuns.every(run=>run.checksum===baselineRuns[0].checksum));
const baselineMedian=Number(median(baselineRuns.map(run=>run.durationMs)).toFixed(3)),candidateMedian=Number(median(candidateRuns.map(run=>run.durationMs)).toFixed(3)),savedMs=Number((baselineMedian-candidateMedian).toFixed(3)),savedPercent=baselineMedian?Number((savedMs/baselineMedian*100).toFixed(2)):0;
console.log(JSON.stringify({ok:true,benchmark:"native-request-metrics-local-overhead",messages:messages.length,toolFunctions:60,iterationsPerRound:iterations,rounds,baseline:{medianDurationMs:baselineMedian,runsMs:baselineRuns.map(run=>run.durationMs)},candidate:{medianDurationMs:candidateMedian,runsMs:candidateRuns.map(run=>run.durationMs)},savings:{medianDurationMs:savedMs,medianPercent:savedPercent},note:"Deterministic local telemetry-computation benchmark only. Provider payloads and metric values are asserted identical; timing reports median of alternating forced-GC rounds."},null,2));
