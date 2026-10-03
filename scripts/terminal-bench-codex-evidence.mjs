import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateGpt6LunaCostFromRecords } from "./terminal-bench-cost.mjs";

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

export function summarizeCodexSessionEvidence(texts=[],{serviceTier="standard"}={}){
  const rows=(Array.isArray(texts)?texts:[texts]).flatMap(tokenUsageRows);
  if(!rows.length)return null;
  const requestUsage=rows.map(row=>row.payload.usage),cost=estimateGpt6LunaCostFromRecords(requestUsage,{serviceTier});
  const requestMetricRows=requestUsage.map((usage,index)=>({
    request:index+1,
    inputTokens:Number(usage?.input_tokens||usage?.inputTokens||0),
    cachedInputTokens:Number(usage?.cached_input_tokens||usage?.cachedInputTokens||0),
    cacheWriteInputTokens:Number(usage?.cache_write_input_tokens||usage?.cacheWriteInputTokens||0),
    outputTokens:Number(usage?.output_tokens||usage?.outputTokens||0),
    reasoningOutputTokens:Number(usage?.reasoning_output_tokens||usage?.reasoningOutputTokens||0),
  }));
  const topRequests=(metric,limit=5)=>requestMetricRows
    .slice()
    .sort((a,b)=>Number(b?.[metric]||0)-Number(a?.[metric]||0)||a.request-b.request)
    .slice(0,limit);
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
    topOutputRequests:topRequests("outputTokens"),
    topReasoningRequests:topRequests("reasoningOutputTokens"),
    apiEquivalentCostUsd:cost.totalUsd,
    apiEquivalentCostBreakdown:cost,
  };
}

export async function recoverCodexSessionEvidence(outputRoot,jobName,{serviceTier="standard"}={}){
  let trials=[];try{trials=await readdir(join(outputRoot,jobName),{withFileTypes:true})}catch{return null}
  const texts=[];
  for(const trial of trials){
    if(!trial.isDirectory())continue;
    const files=await walkJsonl(join(outputRoot,jobName,trial.name,"agent","codex-sessions"));
    for(const file of files)try{texts.push(await readFile(file,"utf8"))}catch{}
  }
  return summarizeCodexSessionEvidence(texts,{serviceTier});
}

async function main(){
  const outputRoot=process.argv[2],jobName=process.argv[3];
  if(!outputRoot||!jobName)throw new Error("Usage: node scripts/terminal-bench-codex-evidence.mjs <output-root> <job-name>");
  const summary=await recoverCodexSessionEvidence(resolve(outputRoot),String(jobName));
  if(!summary)throw new Error("No Codex token-usage evidence found for the requested job.");
  process.stdout.write(JSON.stringify(summary,null,2)+"\n");
}

if(resolve(process.argv[1]||"")===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error?.message||error);process.exitCode=1});
