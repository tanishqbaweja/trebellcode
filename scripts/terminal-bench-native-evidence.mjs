import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { estimateGpt6LunaStandardCostFromRecords } from "./terminal-bench-cost.mjs";

function rows(text){
  const out=[];
  for(const line of String(text||"").split(/\r?\n/)){
    if(!line.trim())continue;
    try{out.push(JSON.parse(line))}catch{}
  }
  return out;
}

export function summarizeNativeEventEvidence(text){
  const events=rows(text),models=events.filter(event=>event?.name==="native.model.completed"),tools=events.filter(event=>event?.name==="native.tool.requested");
  if(!models.length&&!tools.length)return null;
  const usage={inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0,reasoningOutputTokens:0,cacheWriteInputTokens:0};
  for(const event of models){
    const turn=event?.data?.usage||{};
    for(const key of Object.keys(usage))usage[key]+=Number(turn?.[key]||0);
  }
  const uncachedInputTokens=Math.max(0,usage.inputTokens-usage.cachedInputTokens);
  const requestUsage=models.map(event=>event?.data?.usage||{}),cost=estimateGpt6LunaStandardCostFromRecords(requestUsage);
  return {
    modelTurns:models.length,
    toolCalls:tools.length,
    inputTokens:usage.inputTokens,
    cachedTokens:usage.cachedInputTokens,
    uncachedInputTokens,
    cacheHitPercent:usage.inputTokens?Number((usage.cachedInputTokens/usage.inputTokens*100).toFixed(2)):null,
    outputTokens:usage.outputTokens,
    reasoningOutputTokens:usage.reasoningOutputTokens,
    cacheWriteInputTokens:usage.cacheWriteInputTokens,
    maxObservedInputTokens:requestUsage.reduce((max,turn)=>Math.max(max,Number(turn?.inputTokens||turn?.input_tokens||0)),0),
    apiEquivalentCostUsd:cost.totalUsd,
    apiEquivalentCostBreakdown:cost,
  };
}

export function selectNativeMetric(resultValue,trialValue,recoveredValue){
  for(const value of [resultValue,trialValue]){
    if(value!=null&&Number.isFinite(Number(value))&&Number(value)>0)return {value,recovered:false};
  }
  if(recoveredValue!=null&&Number.isFinite(Number(recoveredValue))&&Number(recoveredValue)>0)return {value:recoveredValue,recovered:true};
  for(const value of [resultValue,trialValue]){
    if(value!=null)return {value,recovered:false};
  }
  return {value:recoveredValue??null,recovered:recoveredValue!=null};
}

export async function recoverNativeEventEvidence(outputRoot,jobName){
  let entries=[];try{entries=await readdir(join(outputRoot,jobName),{withFileTypes:true})}catch{return null}
  for(const entry of entries){
    if(!entry.isDirectory())continue;
    try{
      const text=await readFile(join(outputRoot,jobName,entry.name,"agent","trebell-native-events.jsonl"),"utf8");
      const summary=summarizeNativeEventEvidence(text);
      if(summary)return summary;
    }catch{}
  }
  return null;
}
