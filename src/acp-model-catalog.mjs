// Model lists for the ACP harnesses, read from the harness itself the way T3 Code reads them:
// - Grok Build: initialize._meta.modelState, with no session and no sign-in step (T3 discoverGrokMetadataViaAcpInitialize).
// - Cursor: cursor/list_available_models after an initialize that announces the parameterized model picker
//   (T3's ACP-era CursorProvider discoverCursorModelsViaListAvailableModels).
// - Antigravity: the model option (or models) of a session (T3 buildAntigravityModelsFromSession), starting from T3's
//   manifest list until a session has reported the account's real list.
// - OpenCode over ACP (remote environments): the model option of a session, whose current value is OpenCode's default.
import { AcpClient, defaultAcpClientCapabilities } from "./acp-client.mjs";
import { acpConfigChoices, acpConfigSelect } from "./acp-session-config.mjs";

function text(value){return String(value??"").trim()}

// What Grok is told about Trebell at initialize: an editor-style client that shows its approval prompts (no client name or
// referrer of another product is ever sent).
export const GROK_INITIALIZE_META=Object.freeze({clientType:"extension"});

// The id Trebell used for "Antigravity's current model" before it listed real models; never sent to Antigravity.
export const ANTIGRAVITY_MODEL_ALIAS="antigravity-default";
// T3's model manifest for Antigravity (apps/server/src/provider/model-manifest.json), default gemini-3.8-flash-high.
export const ANTIGRAVITY_SEED_MODELS=Object.freeze([
  Object.freeze({id:"gemini-3.8-flash-high",name:"Gemini 3.8 Flash (High)"}),
  Object.freeze({id:"gemini-3.8-flash-medium",name:"Gemini 3.8 Flash (Medium)"}),
  Object.freeze({id:"gemini-3.8-flash-low",name:"Gemini 3.8 Flash (Low)"}),
]);

// Cursor names its efforts low, medium, high, max and Extra High (xhigh); anything else (none) is not an effort level
// Trebell offers (T3 normalizeCursorReasoningValue).
export function cursorEffortValue(value){
  const normalized=text(value).toLowerCase();
  if(["low","medium","high","max"].includes(normalized))return normalized;
  if(["xhigh","extra-high","extra high"].includes(normalized))return "xhigh";
  return null;
}

// The option a Cursor model changes its effort with. Its id differs per model (effort, reasoning, reasoning_effort) and a
// "thinking" on/off option can share its thought_level category, so it is found by name (T3 findCursorEffortConfigOption).
export function cursorEffortOption(configOptions){
  const selects=(Array.isArray(configOptions)?configOptions:[]).filter(option=>option&&option.type==="select"&&text(option.id));
  const category=option=>text(option.category).toLowerCase(),id=option=>text(option.id).toLowerCase();
  const candidates=selects.filter(option=>/effort|reasoning/.test(id(option))||/effort|reasoning/.test(text(option.name).toLowerCase()));
  return candidates.find(option=>category(option)==="model_option")
    ||candidates.find(option=>id(option)==="effort")
    ||candidates.find(option=>category(option)==="thought_level")
    ||candidates[0]
    ||null;
}

// Cursor's Fast switch: a model_config option named fast whose values are true and false (T3 isCursorFastConfigOption with
// isBooleanLikeConfigOption). Trebell shows it as the model's Fast speed.
export function cursorFastOption(configOptions){
  return (Array.isArray(configOptions)?configOptions:[]).find(option=>{
    if(!option||!text(option.id)||text(option.category).toLowerCase()!=="model_config")return false;
    const id=text(option.id).toLowerCase(),name=text(option.name).toLowerCase();
    if(id!=="fast"&&name!=="fast"&&!name.includes("fast mode"))return false;
    if(option.type==="boolean")return true;
    const values=new Set(acpConfigChoices(option).map(choice=>choice.value.toLowerCase()));
    return option.type==="select"&&values.has("true")&&values.has("false");
  })||null;
}

// The value that turns a Cursor switch on or off: the boolean itself, or the select's "true"/"false" value (T3
// findCursorBooleanConfigValue).
export function cursorSwitchValue(option,on){
  if(!option)return undefined;
  if(option.type==="boolean")return Boolean(on);
  return acpConfigChoices(option).find(choice=>choice.value.toLowerCase()===String(Boolean(on)))?.value;
}

// The rest of a Cursor model's settings, such as its context size and thinking switch, as model option descriptors (T3
// buildCursorCapabilitiesFromSdkModel): a true/false choice is a switch, anything else a list, and the current value is the
// default. The effort option and the Fast switch have their own pickers, and the model and mode are not model settings.
export function cursorModelOptions(configOptions){
  const list=(Array.isArray(configOptions)?configOptions:[]).filter(option=>option&&text(option.id));
  const effort=cursorEffortOption(list),fast=cursorFastOption(list),out=[];
  for(const option of list){
    const id=text(option.id),category=text(option.category).toLowerCase();
    if(option===effort||option===fast||category==="model"||category==="mode"||out.some(entry=>entry.id===id))continue;
    const label=text(option.name)||id,current=text(option.currentValue);
    if(option.type==="boolean"){out.push({id,label,type:"boolean",...(typeof option.currentValue==="boolean"?{defaultValue:String(option.currentValue)}:{})});continue}
    if(option.type!=="select")continue;
    const choices=acpConfigChoices(option).map(choice=>({value:choice.value,label:choice.name}));
    if(!choices.length)continue;
    const values=new Set(choices.map(choice=>choice.value.toLowerCase()));
    if(choices.length===2&&values.has("true")&&values.has("false")){out.push({id,label,type:"boolean",...(/^(?:true|false)$/i.test(current)?{defaultValue:current.toLowerCase()}:{})});continue}
    out.push({id,label,type:"select",choices,...(choices.some(choice=>choice.value===current)?{defaultValue:current}:{})});
  }
  return out;
}

// The effort values a Cursor effort option offers, in Trebell's names.
export function cursorEffortChoices(option){
  const out=[];
  for(const choice of acpConfigChoices(option)){
    const value=cursorEffortValue(choice.value)||cursorEffortValue(choice.name);
    if(value&&!out.includes(value))out.push(value);
  }
  return out;
}

const GROK_EFFORT=/^[a-z0-9][a-z0-9._-]{0,31}$/;

// Grok's initialize._meta.modelState: ids, names, context size and per-model reasoning efforts; the current model is the default.
export function grokModelCatalog(initialized){
  const state=initialized?._meta?.modelState;
  const current=text(state?.currentModelId),metadata=[],seen=new Set();
  for(const model of Array.isArray(state?.availableModels)?state.availableModels:[]){
    const id=text(model?.modelId);if(!id||seen.has(id))continue;seen.add(id);
    const meta=model?._meta&&typeof model._meta==="object"?model._meta:{};
    const efforts=[];
    if(meta.supportsReasoningEffort!==false)for(const entry of Array.isArray(meta.reasoningEfforts)?meta.reasoningEfforts:[]){
      const value=text(typeof entry==="string"?entry:(entry?.value??entry?.id)).toLowerCase();
      if(GROK_EFFORT.test(value)&&!efforts.some(item=>item.value===value))efforts.push({value,isDefault:entry?.default===true||entry?.isDefault===true});
    }
    const currentEffort=text(meta.reasoningEffort).toLowerCase(),defaults=efforts.filter(entry=>entry.isDefault);
    const defaultEffort=defaults.find(entry=>entry.value===currentEffort)?.value||defaults[0]?.value||null;
    const contextWindow=Number(meta.totalContextTokens);
    metadata.push({
      id,name:text(model?.name)||id,provider:"grok",agent:"Grok Build",
      ...(text(model?.description)?{description:text(model.description)}:{}),
      ...(Number.isFinite(contextWindow)&&contextWindow>0?{contextWindow:Math.floor(contextWindow)}:{}),
      reasoningEfforts:efforts.map(entry=>entry.value),defaultReasoningEffort:defaultEffort,
      ...(id===current?{isDefault:true}:{}),
    });
  }
  const models=metadata.map(row=>row.id);
  return {models,metadata,preferred:models.includes(current)?current:(models[0]||null)};
}

// cursor/list_available_models: {models:[{value,name,configOptions}]}; Auto ("default") is Cursor's default.
export function cursorModelCatalog(response){
  const metadata=[],seen=new Set();
  for(const row of Array.isArray(response?.models)?response.models:[]){
    const id=text(row?.value),name=text(row?.name);if(!id||!name||seen.has(id))continue;seen.add(id);
    const option=cursorEffortOption(row?.configOptions),efforts=option?cursorEffortChoices(option):[];
    const current=option?cursorEffortValue(option.currentValue):null;
    const fast=cursorFastOption(row?.configOptions),modelOptions=cursorModelOptions(row?.configOptions);
    metadata.push({id,name,provider:"cursor",agent:"Cursor",reasoningEfforts:efforts,defaultReasoningEffort:efforts.includes(current)?current:null,...(fast?{serviceTiers:["fast"]}:{}),...(modelOptions.length?{modelOptions}:{}),...(id==="default"?{isDefault:true}:{})});
  }
  const models=metadata.map(row=>row.id);
  return {models,metadata,preferred:models.includes("default")?"default":(models[0]||null)};
}

// A session's model option (or models): the offered models with their names, the current one first choice.
export function acpSessionModelCatalog(setup,{provider,agent,alias=null}={}){
  const {choices,current}=acpConfigSelect(setup,"model");
  const metadata=choices.map(choice=>({id:choice.value,name:choice.name||choice.value,provider,agent,...(choice.value===current?{isDefault:true,...(alias?{aliases:[alias]}:{})}:{})}));
  const models=metadata.map(row=>row.id);
  return {models,metadata,preferred:current&&models.includes(current)?current:(models[0]||null)};
}

export function antigravityModelCatalog(setup){
  return acpSessionModelCatalog(setup,{provider:"antigravity",agent:"Antigravity",alias:ANTIGRAVITY_MODEL_ALIAS});
}

export function antigravitySeedCatalog(){
  const metadata=ANTIGRAVITY_SEED_MODELS.map((model,index)=>({id:model.id,name:model.name,provider:"antigravity",agent:"Antigravity",...(index===0?{isDefault:true,aliases:[ANTIGRAVITY_MODEL_ALIAS]}:{})}));
  return {models:metadata.map(row=>row.id),metadata,preferred:metadata[0].id};
}

// Runs one short-lived ACP process for a model list: start, initialize, then `use`, and always stops the process. Requests
// from the agent are refused: nothing runs in a listing session.
export async function withAcpProbe({command,args=[],cwd,processCwd=null,env,spawnProcess=null,runTempRoot=null,version="0.0.0",capabilities=null,meta=null,timeoutMs=60_000},use){
  const client=new AcpClient({command,args,cwd:processCwd||cwd,env,spawnProcess,runTempRoot,timeoutMs,onRequest:method=>{
    if(method==="session/request_permission")return {outcome:{outcome:"cancelled"}};
    throw Object.assign(new Error(`${method} is not available while Trebell lists models`),{code:-32601});
  }});
  try{
    await client.start();
    const initialized=await client.initialize({version,capabilities:capabilities||defaultAcpClientCapabilities(),meta,timeoutMs});
    return await use(client,initialized);
  }finally{await client.stop().catch(()=>{})}
}

// Opens one session to read its setup, then deletes it where the agent can (session/delete) and closes it. Returns the
// setup, the session id and whether the session is already deleted.
export async function acpProbeSession(client,initialized,{cwd,timeoutMs=60_000}={}){
  const setup=await client.request("session/new",{cwd,mcpServers:[]},timeoutMs);
  const sessionId=text(setup?.sessionId)||null;
  let deleted=false;
  if(sessionId&&initialized?.agentCapabilities?.sessionCapabilities?.delete){
    try{await client.request("session/delete",{sessionId},5000);deleted=true}catch{}
  }
  if(sessionId&&!deleted)await client.closeSession(sessionId,{timeoutMs:3000}).catch(()=>{});
  return {setup:setup&&typeof setup==="object"?setup:{},sessionId,deleted};
}
