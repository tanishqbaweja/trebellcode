import { createHash } from "node:crypto";

export const NATIVE_PROMPT_PROVENANCE=Symbol.for("trebell.native.prompt.provenance");
export const NATIVE_TOOL_SCHEMA_FINGERPRINT=Symbol.for("trebell.native.tool-schema.fingerprint");

function serialized(value){try{return {text:JSON.stringify(value??null),jsonSafe:true}}catch{return {text:String(value??""),jsonSafe:false}}}
function json(value){return serialized(value).text}
function bytes(value){return Buffer.byteLength(typeof value==="string"?value:json(value),"utf8")}
function estimate(byteCount){return Math.max(0,Math.ceil(Number(byteCount||0)/4))}
function metric(value){
  const serialized=typeof value==="string"?value:json(value),byteCount=bytes(serialized);
  return {bytes:byteCount,estimatedTokens:estimate(byteCount)};
}
function digest(value){return createHash("sha256").update(typeof value==="string"?value:json(value)).digest("hex")}
function hash(value){return digest(value).slice(0,16)}
function hashParts(...parts){const state=createHash("sha256");for(const part of parts)state.update(String(part));return state.digest("hex").slice(0,16)}

function classifiedMessages(source,lastUser){
  const system=[],developer=[],compacted=[],toolResults=[],history=[],allJson=[],systemJson=[],developerJson=[],compactedJson=[],toolResultsJson=[],historyJson=[];let jsonSafe=true;
  for(let index=0;index<source.length;index++){
    const item=source[index],role=item?.role;let bucket=null,bucketJson=null;
    if(role==="system"){system.push(item);bucket=system;bucketJson=systemJson}
    else if(role==="developer"){if(item?.trebellCompaction){compacted.push(item);bucket=compacted;bucketJson=compactedJson}else{developer.push(item);bucket=developer;bucketJson=developerJson}}
    else if(role==="tool"){toolResults.push(item);bucket=toolResults;bucketJson=toolResultsJson}
    else if(index!==lastUser){history.push(item);bucket=history;bucketJson=historyJson}
    if(!jsonSafe)continue;
    if(item&&typeof item==="object"&&typeof item.toJSON==="function"){jsonSafe=false;continue}
    try{
      const itemJson=JSON.stringify(item);if(typeof itemJson!=="string"){jsonSafe=false;continue}
      allJson.push(itemJson);if(bucket&&bucketJson)bucketJson.push(itemJson);
    }catch{jsonSafe=false}
  }
  const asArrayJson=parts=>`[${parts.join(",")}]`;
  return {system,developer,compacted,toolResults,history,serialized:jsonSafe?{messages:asArrayJson(allJson),system:asArrayJson(systemJson),developer:asArrayJson(developerJson),compacted:asArrayJson(compactedJson),toolResults:asArrayJson(toolResultsJson),history:asArrayJson(historyJson)}:null};
}

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

export function nativeRequestMetrics(messages=[],tools=[],{toolSchemaCache=null}={}){
  const source=Array.isArray(messages)?messages:[];let lastUser=-1;
  for(let index=source.length-1;index>=0;index--)if(source[index]?.role==="user"){lastUser=index;break}
  const classified=classifiedMessages(source,lastUser),{system,developer,compacted,toolResults,history}=classified;
  const toolSchemas=Array.isArray(tools)?tools:[];
  let cachedToolSchemas=toolSchemaCache&&typeof toolSchemaCache.get==="function"?toolSchemaCache.get(toolSchemas):null;
  if(!cachedToolSchemas){
    const value=serialized(toolSchemas),text=value.text,digestValue=value.jsonSafe?digest(text):null;
    cachedToolSchemas={serialized:value,text,metric:metric(text),digest:digestValue};
    if(value.jsonSafe&&toolSchemaCache&&typeof toolSchemaCache.set==="function")toolSchemaCache.set(toolSchemas,cachedToolSchemas);
  }
  const systemSerialized=serialized(system),developerSerialized=serialized(developer),toolSchemasSerialized=cachedToolSchemas.serialized,
    systemJson=classified.serialized?.system??systemSerialized.text,developerJson=classified.serialized?.developer??developerSerialized.text,compactedJson=classified.serialized?.compacted??json(compacted),historyJson=classified.serialized?.history??json(history),toolResultsJson=classified.serialized?.toolResults??json(toolResults),toolSchemasJson=toolSchemasSerialized.text,messagesJson=classified.serialized?.messages??json(source);
  const messagesMetric=metric(messagesJson),toolsMetric=cachedToolSchemas.metric,toolSchemaDigest=cachedToolSchemas.digest;
  const currentBreakdown=currentTurnBreakdown(lastUser>=0?source[lastUser]:null);
  const prefix={system,developer,tools:toolSchemas};
  const stablePrefixJsonSafe=systemSerialized.jsonSafe&&developerSerialized.jsonSafe&&toolSchemasSerialized.jsonSafe;
  const result={
    estimation:"utf8_bytes_div_4",
    system:metric(systemJson),
    developer:metric(developerJson),
    compactedContext:metric(compactedJson),
    conversationHistory:metric(historyJson),
    ...currentBreakdown,
    toolResults:metric(toolResultsJson),
    toolSchemas:toolsMetric,
    messages:messagesMetric,
    totalLogical:{bytes:messagesMetric.bytes+toolsMetric.bytes,estimatedTokens:estimate(messagesMetric.bytes+toolsMetric.bytes)},
    messageCount:source.length,
    toolFunctionCount:toolSchemas.reduce((sum,entry)=>sum+(Array.isArray(entry?.tools)?entry.tools.length:(entry?.type==="function"?1:0)),0),
    stablePrefixHash:stablePrefixJsonSafe?hashParts('{"system":',systemJson,',"developer":',developerJson,',"tools":',toolSchemasJson,"}"):hash(prefix),
    systemHash:hash(systemJson),
    developerHash:hash(developerJson),
    toolSchemaHash:toolSchemaDigest?toolSchemaDigest.slice(0,16):hash(toolSchemasJson),
    conversationHistoryHash:hash(historyJson),
  };
  if(toolSchemaDigest)try{Object.defineProperty(result,NATIVE_TOOL_SCHEMA_FINGERPRINT,{value:toolSchemaDigest,enumerable:false,configurable:false})}catch{}
  return result;
}
