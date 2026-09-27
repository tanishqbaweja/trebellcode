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
  const source=Array.isArray(messages)?messages:[];let lastUser=-1;
  for(let index=source.length-1;index>=0;index--)if(source[index]?.role==="user"){lastUser=index;break}
  const system=[],developer=[],compacted=[],toolResults=[],history=[];
  for(let index=0;index<source.length;index++){
    const item=source[index],role=item?.role;
    if(role==="system")system.push(item);
    else if(role==="developer"){if(item?.trebellCompaction)compacted.push(item);else developer.push(item)}
    else if(role==="tool")toolResults.push(item);
    else if(index!==lastUser)history.push(item);
  }
  const toolSchemas=Array.isArray(tools)?tools:[];
  const systemJson=json(system),developerJson=json(developer),compactedJson=json(compacted),historyJson=json(history),toolResultsJson=json(toolResults),toolSchemasJson=json(toolSchemas),messagesJson=json(source);
  const messagesMetric=metric(messagesJson),toolsMetric=metric(toolSchemasJson);
  const currentBreakdown=currentTurnBreakdown(lastUser>=0?source[lastUser]:null);
  const prefix={system,developer,tools:toolSchemas};
  return {
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
    stablePrefixHash:hash(prefix),
    systemHash:hash(systemJson),
    developerHash:hash(developerJson),
    toolSchemaHash:hash(toolSchemasJson),
    conversationHistoryHash:hash(historyJson),
  };
}
