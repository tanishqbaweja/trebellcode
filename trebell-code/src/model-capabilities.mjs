import { modelContextWindowFromMetadata } from "./model-context-window.mjs";

function firstValue(source,paths=[]){
  for(const path of paths){
    let current=source;
    for(const key of path){if(current==null||typeof current!=="object"||!Object.prototype.hasOwnProperty.call(current,key)){current=undefined;break}current=current[key]}
    if(current!==undefined&&current!==null)return current;
  }
  return undefined;
}
function integer(value){const number=Number(value);return Number.isFinite(number)&&number>0?Math.floor(number):null}
function explicitBoolean(source,paths=[]){const value=firstValue(source,paths);return typeof value==="boolean"?value:null}
function stringValue(value){const text=String(value??"").trim();return text||null}
function arrayValue(value){return Array.isArray(value)?value.map(item=>String(item||"").trim().toLowerCase()).filter(Boolean):null}
function capabilityFromModalities(source){
  const modalities=arrayValue(firstValue(source,[["input_modalities"],["inputModalities"],["modalities","input"],["capabilities","input_modalities"],["capabilities","inputModalities"]]));
  return modalities?modalities.some(item=>item==="image"||item==="vision"):null;
}
function pricing(source){
  const raw=firstValue(source,[["pricing"],["price"],["cost"]]);if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const out={};
  for(const [key,value] of Object.entries(raw)){
    if(typeof value==="number"&&Number.isFinite(value))out[key]=value;
    else if(typeof value==="string"&&value.trim()&&Number.isFinite(Number(value)))out[key]=Number(value);
    else if(key.toLowerCase().includes("currency")&&typeof value==="string"&&value.trim())out[key]=value.trim();
  }
  return Object.keys(out).length?out:null;
}

export function normalizeModelCapabilities(metadata={}){
  const source=metadata&&typeof metadata==="object"&&!Array.isArray(metadata)?metadata:{};
  const contextWindow=modelContextWindowFromMetadata(source);
  const maxOutputTokens=integer(firstValue(source,[["maxOutputTokens"],["max_output_tokens"],["maxCompletionTokens"],["max_completion_tokens"],["outputTokenLimit"],["output_token_limit"],["limits","maxOutputTokens"],["limits","max_output_tokens"]]));
  const vision=explicitBoolean(source,[["vision"],["supportsVision"],["supports_vision"],["capabilities","vision"],["capabilities","supportsVision"],["capabilities","supports_vision"]])??capabilityFromModalities(source);
  const toolCalling=explicitBoolean(source,[["toolCalling"],["tool_calling"],["supportsTools"],["supports_tools"],["capabilities","toolCalling"],["capabilities","tool_calling"],["capabilities","tools"]]);
  const computerUse=explicitBoolean(source,[["computerUse"],["computer_use"],["supportsComputerUse"],["supports_computer_use"],["capabilities","computerUse"],["capabilities","computer_use"]]);
  const reasoningControls=explicitBoolean(source,[["reasoningControls"],["reasoning_controls"],["supportsReasoningControls"],["supports_reasoning_controls"],["capabilities","reasoningControls"],["capabilities","reasoning_controls"]]);
  const asyncTools=explicitBoolean(source,[["asyncTools"],["async_tools"],["supportsAsyncTools"],["supports_async_tools"],["capabilities","asyncTools"],["capabilities","async_tools"]]);
  const streaming=explicitBoolean(source,[["streaming"],["supportsStreaming"],["supports_streaming"],["capabilities","streaming"]]);
  const caching=explicitBoolean(source,[["caching"],["promptCaching"],["prompt_caching"],["supportsCaching"],["supports_caching"],["capabilities","caching"],["capabilities","promptCaching"],["capabilities","prompt_caching"]]);
  const availability=stringValue(firstValue(source,[["availability"],["status"],["state"]]));
  return {contextWindow,maxOutputTokens,vision,toolCalling,computerUse,reasoningControls,asyncTools,streaming,caching,availability,pricing:pricing(source)};
}

export function withNormalizedModelCapabilities(metadata={}){
  const source=metadata&&typeof metadata==="object"&&!Array.isArray(metadata)?metadata:{};
  return {...source,capabilities:normalizeModelCapabilities(source)};
}
