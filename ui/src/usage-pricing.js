import { sharedRuntimeCapabilities } from "../../src/runtime-capabilities.mjs";

// Claude Code and OpenCode record a turn's input without its cache reads and writes; the other harnesses count them in it (Codex,
// Trebell Native and Muse Code; Cursor, Grok Build and Antigravity report no cached part). usageTokens reads a record in one meaning:
// input is all the input tokens, cacheRead and cacheWrite the parts read from and written to the cache, fresh the rest.
const INPUT_WITHOUT_CACHE=new Set(["claude","opencode"]);
export function usageTokens(usage,runtime){
  const count=key=>Math.max(0,Number(usage?.[key])||0),cacheRead=count("cachedInputTokens"),cacheWrite=count("cacheWriteInputTokens"),recorded=count("inputTokens");
  const input=INPUT_WITHOUT_CACHE.has(runtime)?recorded+cacheRead+cacheWrite:Math.max(recorded,cacheRead+cacheWrite);
  return {input,fresh:input-cacheRead-cacheWrite,cacheRead,cacheWrite,output:count("outputTokens")};
}

// The prices saved in Settings for a harness's model; for Trebell Native, whose provider is chosen in Trebell, the ones saved for
// the provider it ran on.
export function savedPrice(settings,runtime,model,provider){
  const scoped=sharedRuntimeCapabilities(runtime).managedInference;
  return (settings?.customModels||[]).find(item=>item.id===model&&item.runtime===runtime&&(!scoped||item.provider===provider))||null;
}

// What usage cost at saved prices in USD, or null without an input or output price: fresh input at the input price, cache reads and
// writes at their own prices or else the input price, output at the output price (USD per million tokens).
export function priceUsage(usage,runtime,price){
  const rate=key=>price?.[key]==null?null:Number(price[key]),valid=value=>Number.isFinite(value)&&value>=0,input=rate("inputPrice"),output=rate("outputPrice");
  if(!valid(input)&&!valid(output))return null;
  const tokens=usageTokens(usage,runtime),perInput=valid(input)?input:0,cache=key=>valid(rate(key))?rate(key):perInput;
  return (tokens.fresh*perInput+tokens.cacheRead*cache("cacheReadPrice")+tokens.cacheWrite*cache("cacheWritePrice")+tokens.output*(valid(output)?output:0))/1_000_000;
}

export function estimateUsageCost(record={},settings={}){
  if(record.cost?.currency==="USD"&&Number.isFinite(Number(record.cost.amount)))return {amount:Number(record.cost.amount),estimated:false};
  const amount=priceUsage(record.usage,record.runtime,savedPrice(settings,record.runtime,record.model,record.provider));
  return amount==null?null:{amount,estimated:true};
}
