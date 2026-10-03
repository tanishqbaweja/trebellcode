export const MODEL_SERVICE_TIERS=Object.freeze(["fast"]);
const ALLOWED=new Set(MODEL_SERVICE_TIERS);

export function normalizeModelServiceTier(value){
  const tier=String(value??"").trim().toLowerCase();
  if(tier==="priority")return "fast";
  return ALLOWED.has(tier)?tier:null;
}

export function modelServiceTierKey(runtime,provider,model){
  return [String(runtime||""),String(provider||""),String(model||"")].join(":");
}

export function supportedModelServiceTiers(runtime,provider,model,metadata={}){
  const advertised=Array.isArray(metadata?.serviceTiers)?metadata.serviceTiers:Array.isArray(metadata?.supportedServiceTiers)?metadata.supportedServiceTiers:[];
  const normalized=[];
  for(const value of advertised){const tier=normalizeModelServiceTier(typeof value==="string"?value:(value?.serviceTier??value?.tier??value?.value??value?.id));if(tier&&!normalized.includes(tier))normalized.push(tier)}
  if(normalized.length)return normalized;
  const id=String(model||"").trim().toLowerCase();
  if(runtime==="native"&&provider==="openai"&&/^gpt-6-(?:luna|sol)(?:$|-)/.test(id))return ["fast"];
  return [];
}

export function configuredModelServiceTier(settings,runtime,provider,model){
  return normalizeModelServiceTier(settings?.modelServiceTiers?.[modelServiceTierKey(runtime,provider,model)]);
}
