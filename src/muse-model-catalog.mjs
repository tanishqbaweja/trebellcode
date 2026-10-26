import { MuseHost, museServeArgs } from "./muse-host.mjs";
import { MUSE_REASONING_EFFORTS } from "./model-reasoning-effort.mjs";

// Muse Code's model list, read from Muse itself as T3 Code reads it (provider-muse modelCatalog.ts discoverMuseModels and
// museModelCapabilities): model/list on a short read-only `muse serve` that Trebell starts (muse-host.mjs) answers Meta's catalog,
// whose rows are kept once each, named by their label, with the Thinking levels each one lists.

export const MUSE_CATALOG_STARTUP_TIMEOUT_MS=8_000;
export const MUSE_CATALOG_TIMEOUT_MS=12_000;
// The read-only host has no session to save (--no-session-log), so it gets a short grace before its process tree is stopped.
const MUSE_CATALOG_SHUTDOWN_TIMEOUT_MS=2_000;
// A row whose levels Muse does not say (variants "unknown", or a host too old to send them) offers these, High by default.
const FALLBACK_EFFORTS=Object.freeze(["low","medium","high","xhigh","max"]);
const FALLBACK_EFFORT="high";

function text(value){return typeof value==="string"?value.trim():""}

// A row's name: its label, or a bare muse-* id title-cased ("muse-spark-1.3" reads "Muse Spark 1.3", T3 eb1db5ff8).
export function museModelName(modelId,displayLabel=""){
  const id=text(modelId),label=text(displayLabel)||id;
  return label===id&&id.startsWith("muse-")?id.replaceAll("-"," ").replace(/\b[a-z]/g,letter=>letter.toUpperCase()):label;
}

// The Thinking levels a row lists, in its order, its default and Muse's words for each. Meta's provider refuses "none", so it is
// never offered; a row that lists no levels has none.
export function museModelEfforts(entry={}){
  const reported=Array.isArray(entry?.variants);
  const efforts=[];
  for(const value of reported?entry.variants:FALLBACK_EFFORTS){const tier=text(value).toLowerCase();if(MUSE_REASONING_EFFORTS.includes(tier)&&!efforts.includes(tier))efforts.push(tier)}
  const preferred=reported?text(entry.defaultReasoningEffort).toLowerCase():FALLBACK_EFFORT,descriptions={};
  for(const variant of Array.isArray(entry?.reasoningEffortVariants)?entry.reasoningEffortVariants:[]){
    const tier=text(variant?.tier).toLowerCase(),description=text(variant?.description);
    if(efforts.includes(tier)&&description&&!descriptions[tier])descriptions[tier]=description;
  }
  return {efforts,defaultEffort:efforts.includes(preferred)?preferred:efforts[0]||null,descriptions};
}

// The level a turn runs at (T3 resolveMuseReasoningEffort): the one chosen when the model lists it, else the model's default, and
// none for a model that lists no levels. A model the list does not have takes the levels of a row without them. With no choice, Muse
// keeps its own default.
export function resolveMuseReasoningEffort(row,effort){
  const chosen=text(effort).toLowerCase();if(!chosen)return null;
  const listed=Array.isArray(row?.reasoningEfforts),efforts=listed?row.reasoningEfforts:FALLBACK_EFFORTS,fallback=listed?row.defaultReasoningEffort:FALLBACK_EFFORT;
  return efforts.includes(chosen)?chosen:efforts.includes(fallback)?fallback:efforts[0]||null;
}

// model/list's answer as Trebell's model list: Meta's rows once each, with their names and levels; another provider's catalog is
// refused. preferred is the catalog's own default row, which a new chat picks (T3 MUSE_DEFAULT_MODEL resolves to it).
export function museModelCatalog(result={}){
  const providerId=text(result?.providerId);
  if(providerId!=="meta")throw new Error(`Muse Code listed ${providerId?`the models of ${providerId}`:"models without a provider"}, not Meta's.`);
  const metadata=[],seen=new Set();
  for(const entry of Array.isArray(result?.models)?result.models:[]){
    const id=text(entry?.modelId);if(!id||text(entry?.providerId)!=="meta"||seen.has(id))continue;seen.add(id);
    const {efforts,defaultEffort,descriptions}=museModelEfforts(entry),contextWindow=Number(entry?.contextLimit);
    metadata.push({
      id,name:museModelName(id,entry?.displayLabel),provider:"muse",agent:"Muse Code",
      ...(text(entry?.description)?{description:text(entry.description)}:{}),
      ...(Number.isInteger(contextWindow)&&contextWindow>0?{contextWindow}:{}),
      reasoningEfforts:efforts,defaultReasoningEffort:defaultEffort,...(Object.keys(descriptions).length?{reasoningEffortDescriptions:descriptions}:{}),
      ...(entry?.isDefault===true?{isDefault:true}:{}),
    });
  }
  return {models:metadata.map(row=>row.id),metadata,preferred:metadata.find(row=>row.isDefault)?.id||null};
}

// One short read-only host for the list (T3 discoverMuseModels): `muse serve --disable-shell --disable-write --no-session-log`, an
// initialize that asks for no session capabilities, model/list, then close; 8 s to start and 12 s in all. The host is always closed.
export async function readMuseModelCatalog({command,env,cwd=process.cwd(),version="0.0.0",startupTimeoutMs=MUSE_CATALOG_STARTUP_TIMEOUT_MS,timeoutMs=MUSE_CATALOG_TIMEOUT_MS,shutdownTimeoutMs=MUSE_CATALOG_SHUTDOWN_TIMEOUT_MS,...hostOptions}={}){
  const host=new MuseHost({...hostOptions,command,args:museServeArgs("read-only",{sessionLog:false}),cwd,env,startupTimeoutMs,shutdownTimeoutMs});
  let timer;
  const expired=new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`Muse Code did not list its models within ${Math.round(timeoutMs/1000)} seconds.`)),timeoutMs);timer.unref?.()});
  const listed=(async()=>{await host.start({version,requestedCapabilities:[]});return host.connection.request("model/list",{})})();
  listed.catch(()=>{});
  try{return museModelCatalog(await Promise.race([listed,expired]))}
  finally{clearTimeout(timer);await host.close().catch(()=>{})}
}
