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
function previous(messages=[],tools=[]){
  const source=Array.isArray(messages)?messages:[];let lastUser=-1;for(let index=source.length-1;index>=0;index--)if(source[index]?.role==="user"){lastUser=index;break}
  const system=[],developer=[],compacted=[],toolResults=[],history=[];for(let index=0;index<source.length;index++){const item=source[index],role=item?.role;if(role==="system")system.push(item);else if(role==="developer"){if(item?.trebellCompaction)compacted.push(item);else developer.push(item)}else if(role==="tool")toolResults.push(item);else if(index!==lastUser)history.push(item)}
  const toolSchemas=Array.isArray(tools)?tools:[],systemJson=json(system),developerJson=json(developer),compactedJson=json(compacted),historyJson=json(history),toolResultsJson=json(toolResults),toolSchemasJson=json(toolSchemas),messagesJson=json(source),messagesMetric=metric(messagesJson),toolsMetric=metric(toolSchemasJson),currentBreakdown=currentTurnBreakdown(lastUser>=0?source[lastUser]:null),prefix={system,developer,tools:toolSchemas};
  return {estimation:"utf8_bytes_div_4",system:metric(systemJson),developer:metric(developerJson),compactedContext:metric(compactedJson),conversationHistory:metric(historyJson),...currentBreakdown,toolResults:metric(toolResultsJson),toolSchemas:toolsMetric,messages:messagesMetric,totalLogical:{bytes:messagesMetric.bytes+toolsMetric.bytes,estimatedTokens:estimate(messagesMetric.bytes+toolsMetric.bytes)},messageCount:source.length,toolFunctionCount:toolSchemas.reduce((sum,entry)=>sum+(Array.isArray(entry?.tools)?entry.tools.length:(entry?.type==="function"?1:0)),0),stablePrefixHash:hash(prefix),systemHash:hash(systemJson),developerHash:hash(developerJson),toolSchemaHash:hash(toolSchemasJson),conversationHistoryHash:hash(historyJson)};
}

const messages=[{role:"system",content:"stable-system "+"s".repeat(64_000)},{role:"developer",content:"stable-developer "+"d".repeat(48_000)}];
for(let index=0;index<250;index++){messages.push({role:"user",content:`task-${index} `+"u".repeat(120)});messages.push({role:"assistant",content:`answer-${index} `+"a".repeat(180)})}
const last=messages.findLastIndex(message=>message.role==="user");messages[last]=attachNativePromptProvenance(messages[last],{userParts:[messages[last].content],contextText:"context",contextEntries:[]});
const tools=Array.from({length:30},(_,namespace)=>({type:"namespace",name:`namespace_${namespace}`,description:"namespace "+"n".repeat(500),tools:Array.from({length:8},(_,tool)=>({name:`tool_${tool}`,description:"description "+"z".repeat(900),inputSchema:{type:"object",properties:Object.fromEntries(Array.from({length:12},(_,field)=>[`field_${field}`,{type:"string",description:"field "+"f".repeat(180)}]))}}))}));
const before=previous(messages,tools),after=nativeRequestMetrics(messages,tools);assert.deepEqual(after,before);
const prefixBytes=Buffer.byteLength(JSON.stringify({system:messages.filter(item=>item.role==="system"),developer:messages.filter(item=>item.role==="developer"&&!item.trebellCompaction),tools}),"utf8"),iterations=80,rounds=9;
function measure(fn){global.gc?.();const started=performance.now();let checksum=0;for(let index=0;index<iterations;index++)checksum+=fn(messages,tools).stablePrefixHash.charCodeAt(0);return {durationMs:Number((performance.now()-started).toFixed(3)),checksum}}
function median(values){const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(ordered.length/2)]}
for(let index=0;index<5;index++){previous(messages,tools);nativeRequestMetrics(messages,tools)}
const previousRuns=[],candidateRuns=[];for(let round=0;round<rounds;round++){if(round%2===0){previousRuns.push(measure(previous));candidateRuns.push(measure(nativeRequestMetrics))}else{candidateRuns.push(measure(nativeRequestMetrics));previousRuns.push(measure(previous))}}
assert.ok(previousRuns.every(run=>run.checksum===candidateRuns[0].checksum));assert.ok(candidateRuns.every(run=>run.checksum===previousRuns[0].checksum));
const previousMedian=median(previousRuns.map(run=>run.durationMs)),candidateMedian=median(candidateRuns.map(run=>run.durationMs)),savedMs=Number((previousMedian-candidateMedian).toFixed(3)),savedPercent=Number((savedMs/previousMedian*100).toFixed(2));
console.log(JSON.stringify({ok:true,benchmark:"native-stable-prefix-hash-reuse",messages:messages.length,toolFunctions:240,stablePrefixBytes:prefixBytes,iterationsPerRound:iterations,rounds,previous:{medianDurationMs:previousMedian,runsMs:previousRuns.map(run=>run.durationMs)},candidate:{medianDurationMs:candidateMedian,runsMs:candidateRuns.map(run=>run.durationMs)},savings:{medianDurationMs:savedMs,medianPercent:savedPercent,stablePrefixJsonTraversalBytesAvoidedPerCall:prefixBytes},note:"Deterministic local telemetry benchmark. Metric values and hashes are asserted identical; abnormal JSON serialization preserves the prior fallback path."},null,2));
