import { createHash } from "node:crypto";

export const NATIVE_PROMPT_PROVENANCE=Symbol.for("trebell.native.prompt.provenance");

function json(value){try{return JSON.stringify(value??null)}catch{return String(value??"")}}
function bytes(value){return Buffer.byteLength(typeof value==="string"?value:json(value),"utf8")}
function estimate(byteCount){return Math.max(0,Math.ceil(Number(byteCount||0)/4))}
function metric(value){
  const serialized=typeof value==="string"?value:json(value),byteCount=bytes(serialized);
  return {bytes:byteCount,estimatedTokens:estimate(byteCount)};
}
function hash(value){return createHash("sha256").update(typeof value==="string"?value:json(value)).digest("hex").slice(0,16)}

export function attachNativePromptProvenance(target,value){
  if(!target||typeof target!=="object")return target;
  try{Object.defineProperty(target,NATIVE_PROMPT_PROVENANCE,{value,enumerable:false,configurable:true})}catch{}
  return target;
}

function provenance(value){return value&&typeof value==="object"?value[NATIVE_PROMPT_PROVENANCE]||null:null}

function currentTurnBreakdown(message){
  const meta=provenance(message);
  if(!meta||typeof meta!=="object")return {
    currentUser:metric(message?[message]:[]),
    workingContext:metric([]),
    applicationContext:metric([]),
    untrustedContext:metric([]),
    contextEnvelope:metric([]),
  };
  const userParts=Array.isArray(meta.userParts)?meta.userParts:[],
    contextText=String(meta.contextText||""),
    application=(Array.isArray(meta.contextEntries)?meta.contextEntries:[]).filter(item=>item?.kind==="application").map(item=>item.value),
    untrusted=(Array.isArray(meta.contextEntries)?meta.contextEntries:[]).filter(item=>item?.kind!=="application").map(item=>item.value),
    entryText=(Array.isArray(meta.contextEntries)?meta.contextEntries:[]).map(item=>String(item?.value||"")).join("");
  const contextBytes=bytes(contextText),entryBytes=bytes(entryText);
  return {
    currentUser:metric(userParts),
    workingContext:metric(contextText),
    applicationContext:metric(application),
    untrustedContext:metric(untrusted),
    contextEnvelope:{bytes:Math.max(0,contextBytes-entryBytes),estimatedTokens:estimate(Math.max(0,contextBytes-entryBytes))},
  };
}

export function nativeRequestMetrics(messages=[],tools=[]){
  const source=Array.isArray(messages)?messages:[],lastUser=[...source].map((item,index)=>({item,index})).reverse().find(entry=>entry.item?.role==="user")?.index??-1;
  const system=source.filter(item=>item?.role==="system");
  const developer=source.filter(item=>item?.role==="developer"&&!item?.trebellCompaction);
  const compacted=source.filter(item=>item?.role==="developer"&&item?.trebellCompaction);
  const toolResults=source.filter(item=>item?.role==="tool");
  const history=source.filter((item,index)=>!["system","developer","tool"].includes(item?.role)&&index!==lastUser);
  const toolSchemas=Array.isArray(tools)?tools:[];
  const messagesMetric=metric(source),toolsMetric=metric(toolSchemas);
  const currentBreakdown=currentTurnBreakdown(lastUser>=0?source[lastUser]:null);
  const prefix={system,developer,tools:toolSchemas};
  return {
    estimation:"utf8_bytes_div_4",
    system:metric(system),
    developer:metric(developer),
    compactedContext:metric(compacted),
    conversationHistory:metric(history),
    ...currentBreakdown,
    toolResults:metric(toolResults),
    toolSchemas:toolsMetric,
    messages:messagesMetric,
    totalLogical:{bytes:messagesMetric.bytes+toolsMetric.bytes,estimatedTokens:estimate(messagesMetric.bytes+toolsMetric.bytes)},
    messageCount:source.length,
    toolFunctionCount:toolSchemas.reduce((sum,entry)=>sum+(Array.isArray(entry?.tools)?entry.tools.length:(entry?.type==="function"?1:0)),0),
    stablePrefixHash:hash(prefix),
    systemHash:hash(system),
    developerHash:hash(developer),
    toolSchemaHash:hash(toolSchemas),
    conversationHistoryHash:hash(history),
  };
}
