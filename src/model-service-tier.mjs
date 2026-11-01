import { NATIVE_SERVICE_TIER_DEFAULT } from "./native-configuration.mjs";
export const MODEL_SERVICE_TIERS=Object.freeze(["fast"]);
const ALLOWED=new Set(MODEL_SERVICE_TIERS);

export function normalizeModelServiceTier(value){
  const tier=String(value??"").trim().toLowerCase();
  if(tier==="priority")return "fast";
  return ALLOWED.has(tier)?tier:null;
}

// Codex lists its service tiers per model ({id:"priority",name:"Fast"}); Trebell keeps Codex's ids, and
// "default" is Codex's standard tier.
const CODEX_TIER=/^[a-z][a-z0-9_-]{0,31}$/;
export const CODEX_STANDARD_SERVICE_TIER="default";
export function normalizeRuntimeModelServiceTier(runtime,value){
  if(runtime!=="codex")return normalizeModelServiceTier(value);
  const tier=String(value??"").trim().toLowerCase();
  return CODEX_TIER.test(tier)?tier:null;
}

// Speed options of one Codex model, from its model/list row. A newer Codex describes each tier in `serviceTiers`
// ({id, name, description}, or just the id); an older one lists bare ids in `additionalSpeedTiers`, and only its "fast"
// has a display name. Every option is {id, label, description}. Standard ("default") never appears here: the Speed picker
// offers it on its own.
const codexTierId=value=>normalizeRuntimeModelServiceTier("codex",value);
const OLDER_CATALOG_TIER_NAMES=new Map([["fast","Fast"]]);

function describedTier(entry){
  switch(typeof entry){
    case "string":{
      const id=codexTierId(entry);
      return id?{id,label:id,description:""}:null;
    }
    case "object":{
      const id=entry&&codexTierId(entry.id);
      if(!id)return null;
      return {id,label:entry.name?String(entry.name):id,description:entry.description?String(entry.description):""};
    }
    default:return null;
  }
}

function olderCatalogTier(entry){
  const id=codexTierId(entry);
  if(!id)return null;
  return {id,label:OLDER_CATALOG_TIER_NAMES.get(entry)??String(entry),description:""};
}

// A non-empty serviceTiers is the whole answer; additionalSpeedTiers counts only without it.
function tiersInRow(row){
  const described=row?.serviceTiers,older=row?.additionalSpeedTiers;
  if(Array.isArray(described)&&described.length>0)return described.map(describedTier);
  return Array.isArray(older)?older.map(olderCatalogTier):[];
}

export function codexServiceTierOptions(row={}){
  const offered=new Set();
  return tiersInRow(row).filter(tier=>{
    const fresh=Boolean(tier)&&tier.id!==CODEX_STANDARD_SERVICE_TIER&&!offered.has(tier.id);
    if(fresh)offered.add(tier.id);
    return fresh;
  });
}

// The tier a Codex turn sends: the explicit pick (matched by id or by name, so an older saved "fast" still selects
// Codex's "priority"; "default" is Standard), else the custom model's tier. Without a pick nothing is sent and Codex keeps
// the thread's own tier: serviceTier goes only for a chosen tier. Models without tiers send only a custom tier.
export function codexServiceTierForTurn({configured=null,custom=null,metadata={}}={}){
  const options=codexServiceTierOptions(metadata);
  const pick=value=>{
    const wanted=normalizeRuntimeModelServiceTier("codex",value);if(!wanted)return null;
    if(wanted===CODEX_STANDARD_SERVICE_TIER)return CODEX_STANDARD_SERVICE_TIER;
    return options.find(option=>option.id===wanted||option.label.toLowerCase()===wanted)?.id||null;
  };
  if(!options.length)return normalizeRuntimeModelServiceTier("codex",custom);
  return pick(configured)||pick(custom)||null;
}

// The current value of the Service Tier select: the catalog's default tier when it lists it, else Standard.
export function codexDefaultServiceTier(metadata={}){
  const wanted=normalizeRuntimeModelServiceTier("codex",metadata?.defaultServiceTier);
  return wanted&&codexServiceTierOptions(metadata).some(option=>option.id===wanted)?wanted:CODEX_STANDARD_SERVICE_TIER;
}

// Which of a model's tiers the person's Codex config runs new threads at (config/read's service_tier), or null when the model
// lists none it names. Standard is every model's. Codex's config calls its fast tier "fast" while a newer catalog lists that
// tier as "priority", so "fast" names either, and the one listed first answers.
// The catalog gives the answer as the model's default tier: the Speed picker shows it while nothing is picked, and no turn sends it.
function tierIdsForConfigValue(value){
  return value==="fast"?["fast","priority"]:[value];
}

export function codexConfiguredServiceTier(row={},configTier=null){
  const value=codexTierId(configTier);
  if(!value)return null;
  if(value===CODEX_STANDARD_SERVICE_TIER)return value;
  const names=tierIdsForConfigValue(value);
  for(const tier of codexServiceTierOptions(row)){
    if(names.includes(tier.id))return tier.id;
  }
  return null;
}

// The Speed picker shows the tier the turn sends, else the tier Codex runs without one.
export function codexServiceTierPickerValue(configured,metadata={},custom=null){
  return codexServiceTierForTurn({configured,custom,metadata})||codexDefaultServiceTier(metadata);
}

export function modelServiceTierLabel(runtime,tier,metadata={}){
  const value=String(tier||"");if(!value)return "";
  if(runtime==="codex"){
    if(value===CODEX_STANDARD_SERVICE_TIER)return "Standard";
    const option=codexServiceTierOptions(metadata).find(item=>item.id===value);if(option)return option.label;
  }
  return value[0].toUpperCase()+value.slice(1);
}

export function modelServiceTierKey(runtime,provider,model){
  return [String(runtime||""),String(provider||""),String(model||"")].join(":");
}

export function supportedModelServiceTiers(runtime,provider,model,metadata={}){
  if(runtime==="codex")return codexServiceTierOptions(metadata).map(option=>option.id);
  const advertised=Array.isArray(metadata?.serviceTiers)?metadata.serviceTiers:Array.isArray(metadata?.supportedServiceTiers)?metadata.supportedServiceTiers:[];
  const normalized=[];
  for(const value of advertised){const tier=normalizeModelServiceTier(typeof value==="string"?value:(value?.serviceTier??value?.tier??value?.value??value?.id));if(tier&&!normalized.includes(tier))normalized.push(tier)}
  if(normalized.length)return normalized;
  const id=String(model||"").trim().toLowerCase();
  // Point releases of Luna and Sol (gpt-6.1-sol) take the priority tier as their base models do.
  if(runtime==="native"&&provider==="openai"&&/^gpt-6(?:\.\d+)?-(?:luna|sol)(?:$|-)/.test(id))return ["fast"];
  return [];
}

// Native's tier when the person picked none is the shared default (native-configuration.mjs): none, so Standard.
export function configuredModelServiceTier(settings,runtime,provider,model){
  return normalizeRuntimeModelServiceTier(runtime,settings?.modelServiceTiers?.[modelServiceTierKey(runtime,provider,model)])||(runtime==="native"?NATIVE_SERVICE_TIER_DEFAULT:null);
}
