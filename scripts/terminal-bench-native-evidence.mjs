import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { estimateGpt6LunaCostFromRecords } from "./terminal-bench-cost.mjs";

function rows(text){
  const out=[];
  for(const line of String(text||"").split(/\r?\n/)){
    if(!line.trim())continue;
    try{out.push(JSON.parse(line))}catch{}
  }
  return out;
}

function accountedUsage(turn={}){return Number(turn?.inputTokens||0)>0||Number(turn?.outputTokens||0)>0||Number(turn?.totalTokens||0)>0}

// OpenAI reports all-zero usage for an output-capped (incomplete) response that continues a
// previous response (verified live 2026-10-08), although those tokens are generated. When the
// request's cap is known, impute output = cap and input/cached = the adjacent accounted request
// over the same context (the retry, else the prior request). Unknown-cap gaps stay a lower bound.
function imputedIncompleteUsage(events){
  const imputed=new Map();let pendingCap=null;
  const accountedModels=events.map((event,index)=>({event,index})).filter(({event})=>event?.name==="native.model.completed"&&accountedUsage(event?.data?.usage));
  events.forEach((event,index)=>{
    if(/_output_cap$/.test(String(event?.name||""))){pendingCap=Number(event?.data?.maxOutputTokens||0)||null;return}
    if(event?.name!=="native.model.completed")return;
    const cap=pendingCap;pendingCap=null;
    if(String(event?.data?.finishReason||"").trim().toLowerCase()!=="incomplete"||accountedUsage(event?.data?.usage)||!cap)return;
    const neighbor=accountedModels.find(item=>item.index>index)||[...accountedModels].reverse().find(item=>item.index<index),usage=neighbor?.event?.data?.usage||{};
    imputed.set(event,{inputTokens:Number(usage.inputTokens||0),cachedInputTokens:Number(usage.cachedInputTokens||0),cacheWriteInputTokens:0,outputTokens:cap});
  });
  return imputed;
}

export function summarizeNativeEventEvidence(text,{serviceTier="standard"}={}){
  const events=rows(text),models=events.filter(event=>event?.name==="native.model.completed"),tools=events.filter(event=>event?.name==="native.tool.requested");
  if(!models.length&&!tools.length)return null;
  const zeroUsageIncomplete=models.filter(event=>String(event?.data?.finishReason||"").trim().toLowerCase()==="incomplete"&&!accountedUsage(event?.data?.usage)).length;
  const imputedByEvent=imputedIncompleteUsage(events),imputedUsageRecords=[...imputedByEvent.values()],unaccountedProviderRequests=Math.max(0,zeroUsageIncomplete-imputedUsageRecords.length);
  const usageAccountingComplete=unaccountedProviderRequests===0;
  const usage={inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0,reasoningOutputTokens:0,cacheWriteInputTokens:0};
  for(const event of models){
    const turn=event?.data?.usage||{};
    for(const key of Object.keys(usage))usage[key]+=Number(turn?.[key]||0);
  }
  const uncachedInputTokens=Math.max(0,usage.inputTokens-usage.cachedInputTokens);
  const requestUsage=models.map(event=>event?.data?.usage||{}),rawCost=estimateGpt6LunaCostFromRecords(models.map(event=>imputedByEvent.get(event)||event?.data?.usage||{}),{serviceTier});
  const imputedUsage=imputedUsageRecords.reduce((total,item)=>{for(const key of Object.keys(total))total[key]+=item[key];return total},{inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0});
  const cost={...rawCost,usageAccountingComplete,unaccountedProviderRequests,totalUsdIsLowerBound:!usageAccountingComplete,imputedIncompleteResponses:imputedUsageRecords.length,...(imputedUsageRecords.length?{imputedUsage}:{})};
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
    usageAccountingComplete,
    unaccountedProviderRequests,
    imputedIncompleteResponses:imputedUsageRecords.length,
    apiEquivalentCostIsLowerBound:!usageAccountingComplete,
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

export async function recoverNativeEventEvidence(outputRoot,jobName,{serviceTier="standard"}={}){
  let entries=[];try{entries=await readdir(join(outputRoot,jobName),{withFileTypes:true})}catch{return null}
  for(const entry of entries){
    if(!entry.isDirectory())continue;
    try{
      const text=await readFile(join(outputRoot,jobName,entry.name,"agent","trebell-native-events.jsonl"),"utf8");
      const summary=summarizeNativeEventEvidence(text,{serviceTier});
      if(summary)return summary;
    }catch{}
  }
  return null;
}
