import { MuseHost, museServeArgs } from "./muse-host.mjs";
import { MUSE_REASONING_EFFORTS } from "./model-reasoning-effort.mjs";

// Muse Code's models as Trebell lists them. Muse is asked for its catalog (model/list) on a short-lived host that can do nothing
// else; only Meta's catalog is taken, and each of its models becomes one row of Trebell's model list, with the Thinking levels the
// model takes. A turn's level is then settled against the row of the thread's model.

// Muse's strings as Trebell reads them: trimmed, and empty for anything that is not a string; levels also in lower case.
const clean=value=>typeof value==="string"?value.trim():"";
const levelWord=value=>clean(value).toLowerCase();
const META="meta";

// A model's name: its label, unless the label is empty or only repeats the id. Muse's own ids (muse-...) then read as words:
// "muse-spark-1.3" is "Muse Spark 1.3". A word is a run of ASCII letters, digits and "_", and only a lower-case first letter changes.
const WORD_RUN=/[A-Za-z0-9_]+/g;
const capitalize=run=>run.charAt(0).toUpperCase()+run.slice(1);
export function museModelName(modelId,displayLabel=""){
  const id=clean(modelId),label=clean(displayLabel);
  if(label&&label!==id)return label;
  if(!id.startsWith("muse-"))return id;
  return id.split("-").join(" ").replace(WORD_RUN,capitalize);
}

// A model whose levels Muse does not give (variants "unknown", or a host too old to send them) takes these, preferring High.
const UNLISTED_LEVELS=Object.freeze(["low","medium","high","xhigh","max"]);
const UNLISTED_PREFERRED="high";

// The levels Trebell offers of those given, in their order, once each: Muse's vocabulary without None, which Meta's provider
// refuses, and without words Trebell does not know.
function offeredLevels(values){
  const offered=new Set();
  for(const value of values){
    const level=levelWord(value);
    if(MUSE_REASONING_EFFORTS.includes(level))offered.add(level);
  }
  return [...offered];
}

// Muse's words for the offered levels it describes, the first description of each level only.
function levelDescriptions(described,offered){
  const notes={};
  if(!Array.isArray(described))return notes;
  for(const item of described){
    const level=levelWord(item?.tier),note=clean(item?.description);
    if(note&&offered.includes(level)&&!Object.hasOwn(notes,level))notes[level]=note;
  }
  return notes;
}

// A catalog entry's Thinking levels: the ones it lists (variants), or the unlisted set when it lists none; its default, which is
// the one it prefers when that is offered, else its first level, else none; and Muse's descriptions of them.
export function museModelEfforts(entry={}){
  const ownList=Array.isArray(entry?.variants);
  const efforts=offeredLevels(ownList?entry.variants:UNLISTED_LEVELS);
  const preferred=ownList?levelWord(entry.defaultReasoningEffort):UNLISTED_PREFERRED;
  return {
    efforts,
    defaultEffort:efforts.includes(preferred)?preferred:(efforts[0]??null),
    descriptions:levelDescriptions(entry?.reasoningEffortVariants,efforts),
  };
}

// The level a turn runs at, for the thread's model row (or null when the list does not have the model): the chosen level when the
// row takes it, else the row's default, else its first level, else none. A row without a level list takes the unlisted set,
// preferring High. Nothing chosen gives none, so Muse keeps its own default.
export function resolveMuseReasoningEffort(row,effort){
  const chosen=levelWord(effort);
  if(!chosen)return null;
  const listed=Array.isArray(row?.reasoningEfforts);
  const levels=listed?row.reasoningEfforts:UNLISTED_LEVELS;
  if(levels.includes(chosen))return chosen;
  const fallback=listed?row.defaultReasoningEffort:UNLISTED_PREFERRED;
  if(levels.includes(fallback))return fallback;
  return levels[0]||null;
}

// A context limit Trebell shows: a whole number of tokens above 0.
function contextTokens(limit){
  const tokens=Number(limit);
  return Number.isInteger(tokens)&&tokens>0?tokens:null;
}

// One of Meta's catalog entries as a row of Trebell's model list.
function modelRow(id,entry){
  const row={id,name:museModelName(id,entry.displayLabel),provider:"muse",agent:"Muse Code"};
  const description=clean(entry.description);
  if(description)row.description=description;
  const contextWindow=contextTokens(entry.contextLimit);
  if(contextWindow)row.contextWindow=contextWindow;
  const levels=museModelEfforts(entry);
  row.reasoningEfforts=levels.efforts;
  row.defaultReasoningEffort=levels.defaultEffort;
  if(Object.keys(levels.descriptions).length)row.reasoningEffortDescriptions=levels.descriptions;
  if(entry.isDefault===true)row.isDefault=true;
  return row;
}

// model/list's answer as Trebell's model list: {models (the ids), metadata (the rows), preferred (the catalog's default row, which
// a new chat and "default" pick, or null)}. The catalog must be Meta's; a row of another provider, and a later row of an id already
// listed, are left out.
export function museModelCatalog(result={}){
  const provider=clean(result?.providerId);
  if(provider!==META)throw new Error(`Muse Code listed ${provider?`the models of ${provider}`:"models without a provider"}, not Meta's.`);
  const rows=new Map();
  for(const entry of Array.isArray(result.models)?result.models:[]){
    const id=clean(entry?.modelId);
    if(id&&clean(entry?.providerId)===META&&!rows.has(id))rows.set(id,modelRow(id,entry));
  }
  const metadata=[...rows.values()];
  return {models:[...rows.keys()],metadata,preferred:metadata.find(row=>row.isDefault)?.id??null};
}

// One read: 8 s for the host to answer initialize, 12 s for the whole read, and 2 s for the host to exit once its input closes
// (it keeps no session log to save) before its process tree is stopped.
const READ_BOUNDS=Object.freeze({startMs:8_000,totalMs:12_000,exitGraceMs:2_000});

// The host and bound of one read, from readMuseModelCatalog's options. The host's arguments are always the read-only probe's
// (`muse serve --disable-shell --disable-write --no-session-log`); every option not named here goes to the host as it is.
function listReadPlan({command,env,cwd=process.cwd(),version="0.0.0",startupTimeoutMs=READ_BOUNDS.startMs,timeoutMs=READ_BOUNDS.totalMs,shutdownTimeoutMs=READ_BOUNDS.exitGraceMs,...hostOptions}={}){
  return {
    version,
    totalMs:timeoutMs,
    host:{...hostOptions,command,env,cwd,startupTimeoutMs,shutdownTimeoutMs,args:museServeArgs("read-only",{sessionLog:false})},
  };
}

// Settles as work does, or fails with failure() once ms have passed. The timer never keeps Trebell running by itself, and work
// failing after the bound is not reported again.
function settleWithin(work,ms,failure){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(failure()),ms);
    timer.unref?.();
    work.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)});
  });
}

// Starts the host with an initialize that asks for no session capabilities, then asks for the catalog, with no session.
async function askForModels(host,version){
  await host.start({version,requestedCapabilities:[]});
  return host.connection.request("model/list",{});
}

// The Muse home the host's initialize named (the account's, by its sign-in), whose usage reports the Usage page reads, or null.
function namedMuseHome(host){
  const home=host.initializeResult?.museHome;
  return typeof home==="string"&&home.trim()?home:null;
}

// Reads Muse Code's model list: museModelCatalog's answer plus museHome. The host is closed before the read settles, whatever
// happened; a failure to close it is not the read's.
export async function readMuseModelCatalog(options={}){
  const plan=listReadPlan(options),host=new MuseHost(plan.host);
  try{
    const answer=await settleWithin(askForModels(host,plan.version),plan.totalMs,()=>new Error(`Muse Code did not list its models within ${Math.round(plan.totalMs/1000)} seconds.`));
    return {...museModelCatalog(answer),museHome:namedMuseHome(host)};
  }finally{
    await host.close().catch(()=>{});
  }
}
