// Model lists for the ACP harnesses, read from the harness itself:
// - Grok Build: initialize._meta.modelState, with no session and no sign-in step.
// - Cursor: cursor/list_available_models after an initialize that announces the parameterized model picker.
// - Antigravity: the model option (or models) of a session, starting from a stand-in list until a session has reported the
//   account's real list.
// - OpenCode over ACP (remote environments): the model option of a session, whose current value is OpenCode's default.
import { AcpClient, defaultAcpClientCapabilities } from "./acp-client.mjs";
import { acpConfigChoices, acpConfigSelect } from "./acp-session-config.mjs";
import { codexReasoningEffortLabel } from "./codex-model-catalog.mjs";
import { REASONING_EFFORTS } from "./model-reasoning-effort.mjs";

function text(value){return String(value??"").trim()}

// What Grok is told about Trebell at initialize: an editor-style client that shows its approval prompts (no client name or
// referrer of another product is ever sent).
export const GROK_INITIALIZE_META=Object.freeze({clientType:"extension"});

// The id Trebell used for "Antigravity's current model" before it listed real models; never sent to Antigravity.
export const ANTIGRAVITY_MODEL_ALIAS="antigravity-default";
// What Antigravity offers before a session has listed the account's own models: Gemini 3.8 Flash, which its model menu offers at
// three thinking levels. Antigravity gives a model at a level the id "<model>-<level>" and the name "<model name> (<Level>)".
// The default is High, the level Trebell's live check of Antigravity 1.2.1 ran on (docs/technical/TESTING.md), listed first, then
// the other levels from more thinking to less.
const ANTIGRAVITY_STAND_IN=Object.freeze({model:"gemini-3.8-flash",name:"Gemini 3.8 Flash",levels:["High","Medium","Low"]});

// Cursor's per-model settings. Cursor describes a model's settings as ACP config options, both in its model list and in a
// session: one of them is the model's effort (its id differs between models), one may be its Fast switch, and the others (a
// context size, a thinking switch) are shown as switches or lists. A Cursor turn sets them after the model.

// Cursor's effort choices come from its server model by model: the CLI hands each one on as {value, name}, the server's enum value
// and its display name or the value again (cursor-agent 2026.09.26, 4507.index.js, getConfigOptionValues), and neither the CLI nor
// Cursor's docs fix a list of levels. So Trebell keeps none for Cursor. A choice is the composer level (REASONING_EFFORTS) it reads
// as: that level's id, or the words the composer shows for it (codexReasoningEffortLabel), compared by letters and digits in any
// case, so "Extra High", "extra_high" and "X-High" are all xhigh. Anything else is no level: the composer could neither show nor
// keep it for Cursor.
function spellingKey(value){
  let key="";
  for(const character of text(value).toLowerCase()){
    if((character>="a"&&character<="z")||(character>="0"&&character<="9"))key+=character;
  }
  return key;
}
const LEVEL_BY_SPELLING=new Map();
for(const level of REASONING_EFFORTS){
  LEVEL_BY_SPELLING.set(spellingKey(level),level);
  LEVEL_BY_SPELLING.set(spellingKey(codexReasoningEffortLabel(level)),level);
}
// The composer level one of Cursor's effort values or names reads as, or null.
export function cursorLevelOf(value){
  const key=spellingKey(value);
  return key!==""&&LEVEL_BY_SPELLING.has(key)?LEVEL_BY_SPELLING.get(key):null;
}

const lowered=value=>text(value).toLowerCase();
const listOf=value=>Array.isArray(value)?value:[];
const hasId=option=>Boolean(option)&&text(option.id)!=="";
const mentionsEffort=words=>words.includes("effort")||words.includes("reasoning");

// How well an option fits as the model's effort select, lower first, or null when it is not one. Its id or name has to say
// effort or reasoning, because a thinking on/off option can share the effort's thought_level category.
function effortRank(option){
  if(!hasId(option)||option.type!=="select")return null;
  const id=lowered(option.id),category=lowered(option.category);
  if(!mentionsEffort(id)&&!mentionsEffort(lowered(option.name)))return null;
  if(category==="model_option")return 0;
  if(id==="effort")return 1;
  return category==="thought_level"?2:3;
}

// The select a Cursor model changes its effort with (effort, reasoning or reasoning_effort, depending on the model): the best
// ranked one, the first of them on a tie.
export function cursorEffortOption(configOptions){
  let chosen=null,chosenRank=Infinity;
  for(const option of listOf(configOptions)){
    const rank=effortRank(option);
    if(rank!==null&&rank<chosenRank){chosen=option;chosenRank=rank}
  }
  return chosen;
}

// An on/off option: a boolean, or a select whose values include both true and false.
function isSwitch(option){
  if(option.type==="boolean")return true;
  if(option.type!=="select")return false;
  const values=acpConfigChoices(option).map(choice=>choice.value.toLowerCase());
  return values.includes("true")&&values.includes("false");
}
function calledFast(option){
  const name=lowered(option.name);
  return lowered(option.id)==="fast"||name==="fast"||name.includes("fast mode");
}

// Cursor's Fast switch, which Trebell offers as the model's Fast speed: a model_config switch called fast.
export function cursorFastOption(configOptions){
  return listOf(configOptions).find(option=>hasId(option)&&lowered(option.category)==="model_config"&&calledFast(option)&&isSwitch(option))??null;
}

// The value that turns a switch on or off: the boolean itself, or the select's own spelling of true or false.
export function cursorSwitchValue(option,on){
  if(!option)return undefined;
  const wanted=Boolean(on);
  if(option.type==="boolean")return wanted;
  return acpConfigChoices(option).find(choice=>choice.value.toLowerCase()===String(wanted))?.value;
}

// One of the model's other settings as the composer shows it, or null when it cannot be shown. The current value is its
// default: a boolean's when it is one, a true/false pair's when it reads true or false, a list's when it is one of its values.
function shownSetting(option){
  const id=text(option.id),label=text(option.name)||id,current=option.currentValue;
  if(option.type==="boolean")return {id,label,type:"boolean",...(typeof current==="boolean"?{defaultValue:String(current)}:{})};
  if(option.type!=="select")return null;
  const choices=acpConfigChoices(option);
  if(!choices.length)return null;
  const currentText=text(current);
  if(choices.length===2&&isSwitch(option)){
    const reading=currentText.toLowerCase();
    return {id,label,type:"boolean",...(reading==="true"||reading==="false"?{defaultValue:reading}:{})};
  }
  const listed=choices.map(choice=>({value:choice.value,label:choice.name}));
  return {id,label,type:"select",choices:listed,...(listed.some(choice=>choice.value===currentText)?{defaultValue:currentText}:{})};
}

// The rest of a Cursor model's settings (context size, thinking switch) as model option descriptors, each id once. The effort
// and the Fast switch have their own pickers, and the model and mode are not model settings.
export function cursorModelOptions(configOptions){
  const options=listOf(configOptions).filter(hasId);
  const effort=cursorEffortOption(options),fast=cursorFastOption(options),shown=[];
  for(const option of options){
    if(option===effort||option===fast||["model","mode"].includes(lowered(option.category)))continue;
    if(shown.some(entry=>entry.id===text(option.id)))continue;
    const setting=shownSetting(option);
    if(setting)shown.push(setting);
  }
  return shown;
}

// The levels an effort option offers, in Trebell's names, each once, in the option's order: a choice's value, else its name.
export function cursorEffortLevels(option){
  const levels=new Set();
  for(const choice of acpConfigChoices(option)){
    const level=cursorLevelOf(choice.value)??cursorLevelOf(choice.name);
    if(level)levels.add(level);
  }
  return [...levels];
}

// What a Cursor turn changes after its model, one setting at a time and each found in the option list as it is then:
// {option, value, label} (the label names the setting when the option has no name), or null when there is nothing to set.
// The effort, set to the choice whose value or name reads as the level.
export function cursorEffortChange(configOptions,level){
  const option=cursorEffortOption(configOptions);
  const choice=option?acpConfigChoices(option).find(entry=>(cursorLevelOf(entry.value)??cursorLevelOf(entry.name))===level):null;
  return choice?{option,value:choice.value,label:"effort"}:null;
}
// The Fast switch, on or off.
export function cursorFastChange(configOptions,on){
  const option=cursorFastOption(configOptions),value=cursorSwitchValue(option,on);
  return value===undefined?null:{option,value,label:"Fast"};
}
// A setting picked in the composer, by its id: a boolean takes true or false, a select the choice with that value (exactly,
// else in any case). The effort and the Fast switch are never set this way.
export function cursorPickedChange(configOptions,id,picked){
  const options=listOf(configOptions),option=options.find(entry=>text(entry?.id)===id);
  if(!option||option===cursorEffortOption(options)||option===cursorFastOption(options))return null;
  const wanted=String(picked),lower=wanted.toLowerCase();
  let value;
  if(option.type==="boolean")value=lower==="true"?true:lower==="false"?false:undefined;
  else{
    const choices=acpConfigChoices(option);
    value=(choices.find(choice=>choice.value===wanted)??choices.find(choice=>choice.value.toLowerCase()===lower))?.value;
  }
  return value===undefined?null:{option,value,label:id};
}

// Grok Build's model list comes in its initialize answer, as _meta.modelState: currentModelId (the model it is on) and
// availableModels, each with a modelId, name and description and a _meta that may give totalContextTokens, the level the model
// is on (reasoningEffort), the levels it offers (reasoningEfforts) and supportsReasoningEffort. The model it is on is the
// preferred one, and each model starts at a level it marks as its default (grokStartingLevel).
export function grokModelCatalog(initialized){
  const state=initialized?._meta?.modelState;
  const onModel=text(state?.currentModelId),metadata=[];
  for(const [id,model] of grokModelsById(state?.availableModels))metadata.push(grokModelEntry(id,model,id===onModel));
  const models=metadata.map(entry=>entry.id);
  return {models,metadata,preferred:models.includes(onModel)?onModel:(models.length?models[0]:null)};
}

// The listed models keyed by id, in Grok Build's order: a model without an id is skipped, and a repeated id keeps the first.
function grokModelsById(listed){
  const byId=new Map();
  if(Array.isArray(listed))listed.forEach(model=>{
    const id=text(model?.modelId);
    if(id===""||byId.has(id))return;
    byId.set(id,model);
  });
  return byId;
}

// One model's row for the model picker: its names, context size, the levels its Thinking picker offers and the one it starts at.
function grokModelEntry(id,model,isCurrent){
  const about=model._meta!==null&&typeof model._meta==="object"?model._meta:{};
  const levels=grokLevelsOffered(about),description=text(model.description),contextWindow=grokContextSize(about.totalContextTokens);
  const entry={id,name:text(model.name)||id,provider:"grok",agent:"Grok Build"};
  if(description)entry.description=description;
  if(contextWindow!==null)entry.contextWindow=contextWindow;
  entry.reasoningEfforts=[...levels.keys()];
  entry.defaultReasoningEffort=grokStartingLevel(levels,text(about.reasoningEffort).toLowerCase());
  if(isCurrent)entry.isDefault=true;
  return entry;
}

// A context size in whole tokens: a positive number (or numeric text), rounded down; null for anything else.
function grokContextSize(value){
  const size=Number(value);
  if(size>0&&size<Infinity)return Math.floor(size);
  return null;
}

// The levels a model offers, in its order, as a map from the level's name to whether its entry marks it as the default. A model
// that reports no reasoning control (supportsReasoningEffort false) offers none. A name offered twice keeps its first entry,
// mark included.
function grokLevelsOffered(about){
  const levels=new Map();
  if(about.supportsReasoningEffort===false||!Array.isArray(about.reasoningEfforts))return levels;
  const named=Array.from(about.reasoningEfforts,offer=>[grokLevelName(offer),offer]);
  for(const [name,offer] of named)if(name!==null&&!levels.has(name))levels.set(name,grokMarksDefault(offer));
  return levels;
}

// The level an offered entry names, lowercased: the string itself, or the object's value (its id when value is null or missing).
// Null for an entry that names no usable level.
function grokLevelName(offer){
  let named;
  if(typeof offer==="string")named=offer;
  else if(offer!==null&&typeof offer==="object")named=offer.value!=null?offer.value:offer.id;
  const name=text(named).toLowerCase();
  return isGrokLevelName(name)?name:null;
}

// A usable level name has 1 to 32 characters, all lowercase letters, digits, dots, underscores or hyphens, and does not start
// with a dot, underscore or hyphen.
const GROK_LEVEL_CHARACTERS=new Set("abcdefghijklmnopqrstuvwxyz0123456789._-");
function isGrokLevelName(name){
  const fits=name.length>=1&&name.length<=32&&!".-_".includes(name[0]);
  return fits&&[...name].every(character=>GROK_LEVEL_CHARACTERS.has(character));
}

// Only an object entry with default (or isDefault) set to true marks its level as the default.
function grokMarksDefault(offer){
  return offer!==null&&typeof offer==="object"&&(offer.default===true||offer.isDefault===true);
}

// The level a model starts at: the level it is on when the model also marks that level as a default, else the first level it
// marks as a default, else none. The level it is on never becomes the default by itself.
function grokStartingLevel(levels,onLevel){
  if(levels.get(onLevel)===true)return onLevel;
  for(const [name,marked] of levels)if(marked)return name;
  return null;
}

// cursor/list_available_models answers {models:[{value, name, configOptions}]}: Cursor's own list, each model with its effort
// levels, Fast speed and other settings. A row needs a value and a name; the first row of a value counts. Auto ("default") is
// Cursor's default.
export function cursorModelCatalog(response){
  const listed=new Map();
  for(const row of listOf(response?.models)){
    const id=text(row?.value),name=text(row?.name);
    if(id&&name&&!listed.has(id))listed.set(id,cursorModelEntry(id,name,row?.configOptions));
  }
  const models=[...listed.keys()];
  return {models,metadata:[...listed.values()],preferred:listed.has("default")?"default":models[0]??null};
}

function cursorModelEntry(id,name,configOptions){
  const effort=cursorEffortOption(configOptions),levels=effort?cursorEffortLevels(effort):[];
  const level=effort?cursorLevelOf(effort.currentValue):null,settings=cursorModelOptions(configOptions);
  return {
    id,name,provider:"cursor",agent:"Cursor",
    reasoningEfforts:levels,defaultReasoningEffort:levels.includes(level)?level:null,
    ...(cursorFastOption(configOptions)?{serviceTiers:["fast"]}:{}),
    ...(settings.length?{modelOptions:settings}:{}),
    ...(id==="default"?{isDefault:true}:{}),
  };
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

// Antigravity's stand-in list, written as the model state an Antigravity session reports (ACP's models: currentModelId and
// availableModels) and read as one, so it has the very shape of a list a session reports: the same list from a session later
// changes nothing.
export function antigravitySeedCatalog(){
  const {model,name,levels}=ANTIGRAVITY_STAND_IN;
  const availableModels=levels.map(level=>({modelId:`${model}-${level.toLowerCase()}`,name:`${name} (${level})`}));
  return antigravityModelCatalog({models:{currentModelId:availableModels[0].modelId,availableModels}});
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
