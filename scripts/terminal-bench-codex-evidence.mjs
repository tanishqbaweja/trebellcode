import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { estimateGpt6LunaStandardCostFromRecords } from "./terminal-bench-cost.mjs";

async function walkJsonl(root){
  const out=[];let entries=[];try{entries=await readdir(root,{withFileTypes:true})}catch{return out}
  for(const entry of entries){
    const path=join(root,entry.name);
    if(entry.isDirectory())out.push(...await walkJsonl(path));
    else if(entry.isFile()&&entry.name.endsWith(".jsonl"))out.push(path);
  }
  return out;
}

function tokenUsageRows(text){
  const out=[];
  for(const line of String(text||"").split(/\r?\n/)){
    if(!line.includes('"token_usage_record"'))continue;
    try{const row=JSON.parse(line);if(row?.type==="token_usage_record"&&row?.payload?.usage)out.push(row)}catch{}
  }
  return out;
}

export function summarizeCodexSessionEvidence(texts=[]){
  const rows=(Array.isArray(texts)?texts:[texts]).flatMap(tokenUsageRows);
  if(!rows.length)return null;
  const requestUsage=rows.map(row=>row.payload.usage),cost=estimateGpt6LunaStandardCostFromRecords(requestUsage);
  const reasoningOutputTokens=requestUsage.reduce((sum,usage)=>sum+Number(usage?.reasoning_output_tokens||usage?.reasoningOutputTokens||0),0);
  const usage=cost.usage;
  return {
    modelTurns:rows.length,
    inputTokens:usage.inputTokens,
    cachedTokens:usage.cachedInputTokens,
    uncachedInputTokens:Math.max(0,usage.inputTokens-usage.cachedInputTokens),
    cacheHitPercent:usage.inputTokens?Number((usage.cachedInputTokens/usage.inputTokens*100).toFixed(2)):null,
    outputTokens:usage.outputTokens,
    reasoningOutputTokens,
    cacheWriteInputTokens:usage.cacheWriteInputTokens,
    maxObservedInputTokens:requestUsage.reduce((max,turn)=>Math.max(max,Number(turn?.input_tokens||turn?.inputTokens||0)),0),
    apiEquivalentCostUsd:cost.totalUsd,
    apiEquivalentCostBreakdown:cost,
  };
}

export async function recoverCodexSessionEvidence(outputRoot,jobName){
  let trials=[];try{trials=await readdir(join(outputRoot,jobName),{withFileTypes:true})}catch{return null}
  const texts=[];
  for(const trial of trials){
    if(!trial.isDirectory())continue;
    const files=await walkJsonl(join(outputRoot,jobName,trial.name,"agent","codex-sessions"));
    for(const file of files)try{texts.push(await readFile(file,"utf8"))}catch{}
  }
  return summarizeCodexSessionEvidence(texts);
}
