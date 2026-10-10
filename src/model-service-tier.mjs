export const MODEL_SERVICE_TIERS=Object.freeze(["fast"]);
const ALLOWED=new Set(MODEL_SERVICE_TIERS);

export function normalizeModelServiceTier(value){
  const tier=String(value??"").trim().toLowerCase();
  if(tier==="priority")return "fast";
  return ALLOWED.has(tier)?tier:null;
}

// Codex lists its service tiers per model ({id:"priority",name:"Fast"}); Trebell keeps Codex's ids, like T3 Code, and
// "default" is Codex's standard tier.
const CODEX_TIER=/^[a-z][a-z0-9_-]{0,31}$/;
export const CODEX_STANDARD_SERVICE_TIER="default";
export function normalizeRuntimeModelServiceTier(runtime,value){
  if(runtime!=="codex")return normalizeModelServiceTier(value);
  const tier=String(value??"").trim().toLowerCase();
  return CODEX_TIER.test(tier)?tier:null;
}

// T3 mapCodexModelCapabilities: catalog serviceTiers, or the older additionalSpeedTiers list.
export function codexServiceTierOptions(metadata={}){
  const listed=Array.isArray(metadata?.serviceTiers)&&metadata.serviceTiers.length
    ?metadata.serviceTiers
    :(Array.isArray(metadata?.additionalSpeedTiers)?metadata.additionalSpeedTiers:[]).map(id=>({id,name:id==="fast"?"Fast":id,description:""}));
  const out=[];
  for(const item of listed){
    const id=normalizeRuntimeModelServiceTier("codex",typeof item==="string"?item:item?.id);
    if(!id||id===CODEX_STANDARD_SERVICE_TIER||out.some(option=>option.id===id))continue;
    out.push({id,label:String((typeof item==="object"&&item?.name)||id),description:String((typeof item==="object"&&item?.description)||"")});
  }
  return out;
}

// The tier a Codex turn sends: the explicit pick (matched by id or by name, so an older saved "fast" still selects
// Codex's "priority"; "default" is Standard), else the custom model's tier. Without a pick nothing is sent and Codex keeps
// the thread's own tier, as T3 sends serviceTier only for a chosen tier. Models without tiers send only a custom tier.
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

// T3's currentValue for the Service Tier select: the catalog's default tier when it lists it, else Standard.
export function codexDefaultServiceTier(metadata={}){
  const wanted=normalizeRuntimeModelServiceTier("codex",metadata?.defaultServiceTier);
  return wanted&&codexServiceTierOptions(metadata).some(option=>option.id===wanted)?wanted:CODEX_STANDARD_SERVICE_TIER;
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
  if(runtime==="native"&&provider==="openai"&&/^gpt-6-(?:luna|sol)(?:$|-)/.test(id))return ["fast"];
  return [];
}

export function configuredModelServiceTier(settings,runtime,provider,model){
  return normalizeRuntimeModelServiceTier(runtime,settings?.modelServiceTiers?.[modelServiceTierKey(runtime,provider,model)]);
}
