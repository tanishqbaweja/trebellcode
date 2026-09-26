import { sharedRuntimeCapabilities } from "../../src/runtime-capabilities.mjs";

export function estimateUsageCost(record={},settings={}){
  if(record.cost?.currency==="USD"&&Number.isFinite(Number(record.cost.amount)))return {amount:Number(record.cost.amount),estimated:false};
  const providerScoped=Boolean(sharedRuntimeCapabilities(record.runtime).managedInference);
  const price=(settings.customModels||[]).find(item=>item.id===record.model&&item.runtime===record.runtime&&(!providerScoped||item.provider===record.provider));if(!price)return null;
  const usage=record.usage||{},rate=key=>price[key]==null?0:Number(price[key])||0;
  const amount=(Number(usage.inputTokens||0)*rate("inputPrice")+Number(usage.outputTokens||0)*rate("outputPrice")+Number(usage.cachedInputTokens||0)*rate("cacheReadPrice")+Number(usage.cacheWriteInputTokens||0)*rate("cacheWritePrice"))/1_000_000;
  return {amount,estimated:true};
}
