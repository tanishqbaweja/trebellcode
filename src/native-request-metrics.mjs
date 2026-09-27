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
function jsonArrayText(parts=[]){return `[${parts.map(part=>part.text).join(",")}]`}
function jsonArrayMetric(parts=[]){let byteCount=2+Math.max(0,parts.length-1);for(const part of parts)byteCount+=part.bytes;return {bytes:byteCount,estimatedTokens:estimate(byteCount)}}
function jsonArrayHash(parts=[]){const state=createHash("sha256");state.update("[");for(let index=0;index<parts.length;index++){if(index)state.update(",");state.update(parts[index].text)}state.update("]");return state.digest("hex").slice(0,16)}
function cachedJsonArrayHash(parts=[],cache=null){
  if(!cache||typeof cache!=="object")return jsonArrayHash(parts);
  const prior=Array.isArray(cache.parts)?cache.parts:null,priorLength=Number.isInteger(cache.length)?cache.length:(prior?.length||0);let state=null,start=0;
  if(prior===parts&&priorLength<=parts.length&&cache.state&&typeof cache.state.copy==="function"){
    if(priorLength===parts.length&&typeof cache.hash==="string")return cache.hash;
    try{state=cache.state.copy();start=priorLength}catch{}
  }else if(prior&&prior.length<=parts.length&&cache.state&&typeof cache.state.copy==="function"){
    let prefixMatches=true;for(let index=0;index<prior.length;index++)if(prior[index]!==parts[index]){prefixMatches=false;break}
    if(prefixMatches){
      if(prior.length===parts.length&&typeof cache.hash==="string")return cache.hash;
      try{state=cache.state.copy();start=prior.length}catch{}
    }
  }
  if(!state){state=createHash("sha256");state.update("[");start=0}
  for(let index=start;index<parts.length;index++){if(index)state.update(",");state.update(parts[index].text)}
  const finalState=state.copy();finalState.update("]");const value=finalState.digest("hex").slice(0,16);
  cache.parts=parts;cache.length=parts.length;cache.state=state;cache.hash=value;return value;
}

function classifiedMessages(source,lastUser,messageSerializationCache=null,classificationCache=null){
  const reusable=classificationCache&&typeof classificationCache==="object"&&classificationCache.source===source&&classificationCache.lastUser===lastUser&&Number.isInteger(classificationCache.length)&&classificationCache.length<=source.length;
  let state=reusable?classificationCache:null;
  if(!state){
    state={source,lastUser,length:0,system:[],developer:[],compacted:[],toolResults:[],history:[],allJson:[],systemJson:[],developerJson:[],compactedJson:[],toolResultsJson:[],historyJson:[],jsonSafe:true};
    if(classificationCache&&typeof classificationCache==="object"){Object.assign(classificationCache,state);state=classificationCache}
  }
  for(let index=state.length;index<source.length;index++){
    const item=source[index],role=item?.role;let bucket=null,bucketJson=null;
    if(role==="system"){state.system.push(item);bucket=state.system;bucketJson=state.systemJson}
    else if(role==="developer"){if(item?.trebellCompaction){state.compacted.push(item);bucket=state.compacted;bucketJson=state.compactedJson}else{state.developer.push(item);bucket=state.developer;bucketJson=state.developerJson}}
    else if(role==="tool"){state.toolResults.push(item);bucket=state.toolResults;bucketJson=state.toolResultsJson}
    else if(index!==lastUser){state.history.push(item);bucket=state.history;bucketJson=state.historyJson}
    if(!state.jsonSafe)continue;
    if(item&&typeof item==="object"&&typeof item.toJSON==="function"){state.jsonSafe=false;continue}
    try{
      let fragment=item&&typeof item==="object"&&messageSerializationCache&&typeof messageSerializationCache.get==="function"?messageSerializationCache.get(item):null;
      if(!fragment){
        const itemJson=JSON.stringify(item);if(typeof itemJson!=="string"){state.jsonSafe=false;continue}
        fragment={text:itemJson,bytes:Buffer.byteLength(itemJson,"utf8")};
        if(item&&typeof item==="object"&&messageSerializationCache&&typeof messageSerializationCache.set==="function")messageSerializationCache.set(item,fragment);
      }
      state.allJson.push(fragment);if(bucket&&bucketJson)bucketJson.push(fragment);
    }catch{state.jsonSafe=false}
  }
  state.length=source.length;
  return {system:state.system,developer:state.developer,compacted:state.compacted,toolResults:state.toolResults,history:state.history,fragments:state.jsonSafe?{messages:state.allJson,system:state.systemJson,developer:state.developerJson,compacted:state.compactedJson,toolResults:state.toolResultsJson,history:state.historyJson}:null};
}

export function attachNativePromptProvenance(target,value){
  if(!target||typeof target!=="object")return target;
  try{Object.defineProperty(target,NATIVE_PROMPT_PROVENANCE,{value,enumerable:false,configurable:true})}catch{}
  return target;
}

function provenance(value){return value&&typeof value==="object"?value[NATIVE_PROMPT_PROVENANCE]||null:null}

function currentTurnBreakdown(message,cache=null){
  const meta=provenance(message);
  if(!meta||typeof meta!=="object")return {
    currentUser:metric(message?[message]:[]),
    workingContext:metric([]),
    applicationContext:metric([]),
    untrustedContext:metric([]),
    contextEnvelope:metric([]),
  };
  const userParts=Array.isArray(meta.userParts)?meta.userParts:[],contextEntries=Array.isArray(meta.contextEntries)?meta.contextEntries:[],contextText=String(meta.contextText||"");
  const cached=message&&typeof message==="object"&&cache&&typeof cache.get==="function"?cache.get(message):null;
  if(cached&&cached.meta===meta&&cached.userParts===userParts&&cached.contextEntries===contextEntries&&cached.contextText===contextText)return cached.value;
  const application=contextEntries.filter(item=>item?.kind==="application").map(item=>item.value),
    untrusted=contextEntries.filter(item=>item?.kind!=="application").map(item=>item.value),
    entryText=contextEntries.map(item=>String(item?.value||"")).join("");
  const contextBytes=bytes(contextText),entryBytes=bytes(entryText);
  const value={
    currentUser:metric(userParts),
    workingContext:metric(contextText),
    applicationContext:metric(application),
    untrustedContext:metric(untrusted),
    contextEnvelope:{bytes:Math.max(0,contextBytes-entryBytes),estimatedTokens:estimate(Math.max(0,contextBytes-entryBytes))},
  };
  if(message&&typeof message==="object"&&cache&&typeof cache.set==="function")cache.set(message,{meta,userParts,contextEntries,contextText,value});
  return value;
}

export function nativeRequestMetrics(messages=[],tools=[],{toolSchemaCache=null,messageSerializationCache=null,historyHashCache=null,messageClassificationCache=null,currentTurnBreakdownCache=null}={}){
  const source=Array.isArray(messages)?messages:[];let lastUser=-1;
  for(let index=source.length-1;index>=0;index--)if(source[index]?.role==="user"){lastUser=index;break}
  const classified=classifiedMessages(source,lastUser,messageSerializationCache,messageClassificationCache),{system,developer,compacted,toolResults,history}=classified;
  const toolSchemas=Array.isArray(tools)?tools:[];
  let cachedToolSchemas=toolSchemaCache&&typeof toolSchemaCache.get==="function"?toolSchemaCache.get(toolSchemas):null;
  if(!cachedToolSchemas){
    const value=serialized(toolSchemas),text=value.text,digestValue=value.jsonSafe?digest(text):null;
    cachedToolSchemas={serialized:value,text,metric:metric(text),digest:digestValue,functionCount:toolSchemas.reduce((sum,entry)=>sum+(Array.isArray(entry?.tools)?entry.tools.length:(entry?.type==="function"?1:0)),0),stablePrefix:null};
    if(value.jsonSafe&&toolSchemaCache&&typeof toolSchemaCache.set==="function")toolSchemaCache.set(toolSchemas,cachedToolSchemas);
  }
  const fragments=classified.fragments,systemJson=fragments?jsonArrayText(fragments.system):json(system),developerJson=fragments?jsonArrayText(fragments.developer):json(developer),systemSerialized=fragments?{text:systemJson,jsonSafe:true}:serialized(system),developerSerialized=fragments?{text:developerJson,jsonSafe:true}:serialized(developer),toolSchemasSerialized=cachedToolSchemas.serialized,toolSchemasJson=toolSchemasSerialized.text;
  const messagesMetric=fragments?jsonArrayMetric(fragments.messages):metric(source),compactedMetric=fragments?jsonArrayMetric(fragments.compacted):metric(compacted),historyMetric=fragments?jsonArrayMetric(fragments.history):metric(history),toolResultsMetric=fragments?jsonArrayMetric(fragments.toolResults):metric(toolResults),historyHash=fragments?cachedJsonArrayHash(fragments.history,historyHashCache):hash(history),toolsMetric=cachedToolSchemas.metric,toolSchemaDigest=cachedToolSchemas.digest;
  const currentBreakdown=currentTurnBreakdown(lastUser>=0?source[lastUser]:null,currentTurnBreakdownCache);
  const prefix={system,developer,tools:toolSchemas};
  const stablePrefixJsonSafe=systemSerialized.jsonSafe&&developerSerialized.jsonSafe&&toolSchemasSerialized.jsonSafe;
  const priorStablePrefix=cachedToolSchemas.stablePrefix,stablePrefixCacheHit=stablePrefixJsonSafe&&priorStablePrefix?.systemJson===systemJson&&priorStablePrefix?.developerJson===developerJson;
  const systemMetric=stablePrefixCacheHit?priorStablePrefix.systemMetric:metric(systemJson),developerMetric=stablePrefixCacheHit?priorStablePrefix.developerMetric:metric(developerJson),systemHash=stablePrefixCacheHit?priorStablePrefix.systemHash:hash(systemJson),developerHash=stablePrefixCacheHit?priorStablePrefix.developerHash:hash(developerJson),stablePrefixHash=stablePrefixCacheHit?priorStablePrefix.stablePrefixHash:(stablePrefixJsonSafe?hashParts('{"system":',systemJson,',"developer":',developerJson,',"tools":',toolSchemasJson,"}"):hash(prefix));
  if(stablePrefixJsonSafe&&!stablePrefixCacheHit)cachedToolSchemas.stablePrefix={systemJson,developerJson,systemMetric,developerMetric,systemHash,developerHash,stablePrefixHash};
  const result={
    estimation:"utf8_bytes_div_4",
    system:systemMetric,
    developer:developerMetric,
    compactedContext:compactedMetric,
    conversationHistory:historyMetric,
    ...currentBreakdown,
    toolResults:toolResultsMetric,
    toolSchemas:toolsMetric,
    messages:messagesMetric,
    totalLogical:{bytes:messagesMetric.bytes+toolsMetric.bytes,estimatedTokens:estimate(messagesMetric.bytes+toolsMetric.bytes)},
    messageCount:source.length,
    toolFunctionCount:cachedToolSchemas.functionCount,
    stablePrefixHash,
    systemHash,
    developerHash,
    toolSchemaHash:toolSchemaDigest?toolSchemaDigest.slice(0,16):hash(toolSchemasJson),
    conversationHistoryHash:historyHash,
  };
  if(toolSchemaDigest)try{Object.defineProperty(result,NATIVE_TOOL_SCHEMA_FINGERPRINT,{value:toolSchemaDigest,enumerable:false,configurable:false})}catch{}
  return result;
}
