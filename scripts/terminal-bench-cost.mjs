export const GPT6_LUNA_STANDARD_PRICING=Object.freeze({
  model:"gpt-6-luna",
  serviceTier:"standard",
  currency:"USD",
  perTokens:1_000_000,
  longContextThresholdInputTokens:272_000,
  shortContext:Object.freeze({input:0.10,cachedInput:0.01,cacheWriteInput:0.125,output:0.50}),
  longContext:Object.freeze({input:0.20,cachedInput:0.02,cacheWriteInput:0.25,output:0.75}),
  source:"https://developers.openai.com/api/docs/models/gpt-6-luna",
  verifiedAt:"2026-10-01",
});

function number(value){const parsed=Number(value);return Number.isFinite(parsed)&&parsed>=0?parsed:0}

export function normalizeOpenAIUsage(record={}){
  const usage=record?.usage||record||{};
  const inputTokens=number(usage.inputTokens??usage.input_tokens);
  const cachedInputTokens=number(usage.cachedInputTokens??usage.cached_input_tokens);
  const cacheWriteInputTokens=number(usage.cacheWriteInputTokens??usage.cache_write_input_tokens);
  const outputTokens=number(usage.outputTokens??usage.output_tokens);
  const uncachedInputTokens=Math.max(0,inputTokens-cachedInputTokens-cacheWriteInputTokens);
  return {inputTokens,cachedInputTokens,cacheWriteInputTokens,uncachedInputTokens,outputTokens};
}

function costForUsage(usage,rates){
  const per=GPT6_LUNA_STANDARD_PRICING.perTokens;
  return {
    uncachedInputUsd:usage.uncachedInputTokens*Number(rates.input)/per,
    cachedInputUsd:usage.cachedInputTokens*Number(rates.cachedInput)/per,
    cacheWriteInputUsd:usage.cacheWriteInputTokens*Number(rates.cacheWriteInput)/per,
    outputUsd:usage.outputTokens*Number(rates.output)/per,
  };
}

function totalBreakdown(parts){
  const out={uncachedInputUsd:0,cachedInputUsd:0,cacheWriteInputUsd:0,outputUsd:0};
  for(const part of parts)for(const key of Object.keys(out))out[key]+=Number(part?.[key]||0);
  const totalUsd=Object.values(out).reduce((sum,value)=>sum+value,0);
  return {...out,totalUsd};
}

export function estimateGpt6LunaStandardCostFromRecords(records=[]){
  const normalized=(Array.isArray(records)?records:[]).map(normalizeOpenAIUsage);
  const parts=normalized.map(usage=>costForUsage(
    usage,
    usage.inputTokens>GPT6_LUNA_STANDARD_PRICING.longContextThresholdInputTokens?GPT6_LUNA_STANDARD_PRICING.longContext:GPT6_LUNA_STANDARD_PRICING.shortContext,
  ));
  const usageTotals=normalized.reduce((acc,usage)=>{
    for(const key of Object.keys(acc))acc[key]+=Number(usage[key]||0);
    return acc;
  },{inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,uncachedInputTokens:0,outputTokens:0});
  return {
    model:GPT6_LUNA_STANDARD_PRICING.model,
    pricing:GPT6_LUNA_STANDARD_PRICING,
    usage:usageTotals,
    requestCount:normalized.length,
    longContextRequestCount:normalized.filter(usage=>usage.inputTokens>GPT6_LUNA_STANDARD_PRICING.longContextThresholdInputTokens).length,
    contextPricingExact:true,
    ...totalBreakdown(parts),
  };
}

export function estimateGpt6LunaStandardCostFromAggregate(record={}, {maxObservedInputTokens=null}={}){
  const usage=normalizeOpenAIUsage(record);
  const knownShortContext=maxObservedInputTokens!=null&&Number(maxObservedInputTokens)<=GPT6_LUNA_STANDARD_PRICING.longContextThresholdInputTokens;
  const knownLongContext=maxObservedInputTokens!=null&&Number(maxObservedInputTokens)>GPT6_LUNA_STANDARD_PRICING.longContextThresholdInputTokens;
  const rates=knownLongContext?GPT6_LUNA_STANDARD_PRICING.longContext:GPT6_LUNA_STANDARD_PRICING.shortContext;
  return {
    model:GPT6_LUNA_STANDARD_PRICING.model,
    pricing:GPT6_LUNA_STANDARD_PRICING,
    usage,
    requestCount:null,
    longContextRequestCount:knownLongContext?null:knownShortContext?0:null,
    contextPricingExact:knownShortContext,
    contextPricingAssumption:knownShortContext?null:knownLongContext?"aggregate priced at long-context rates; per-request split unavailable":"short-context rates assumed because per-request context lengths are unavailable",
    ...totalBreakdown([costForUsage(usage,rates)]),
  };
}
