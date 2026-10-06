import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

function nonnegativeInteger(value){
  const number=Number(value);
  return Number.isFinite(number)&&number>=0?Math.trunc(number):0;
}

export function normalizeCtrfVerifierSummary(value={}){
  const summary=value?.results?.summary;
  if(!summary||typeof summary!=="object")return null;
  return {
    tests:nonnegativeInteger(summary.tests),
    passed:nonnegativeInteger(summary.passed),
    failed:nonnegativeInteger(summary.failed),
    pending:nonnegativeInteger(summary.pending),
    skipped:nonnegativeInteger(summary.skipped),
    other:nonnegativeInteger(summary.other),
  };
}

export function normalizeTraceResultsVerifierSummary(value={}){
  const tests=nonnegativeInteger(value?.total_cases),passed=nonnegativeInteger(value?.passed_cases);
  if(tests<=0||passed>tests)return null;
  return {tests,passed,failed:tests-passed,pending:0,skipped:0,other:0};
}

async function readVerifierSummary(trialDir){
  try{
    const parsed=JSON.parse(await readFile(join(trialDir,"verifier","ctrf.json"),"utf8")),summary=normalizeCtrfVerifierSummary(parsed);
    if(summary)return summary;
  }catch{}
  try{
    const parsed=JSON.parse(await readFile(join(trialDir,"verifier","trace_results.json"),"utf8")),summary=normalizeTraceResultsVerifierSummary(parsed);
    if(summary)return summary;
  }catch{}
  return null;
}

export async function readJobVerifierSummary(outputRoot,jobName){
  let entries=[];try{entries=await readdir(join(outputRoot,jobName),{withFileTypes:true})}catch{return null}
  const summaries=[];
  for(const entry of entries){
    if(!entry.isDirectory())continue;
    const summary=await readVerifierSummary(join(outputRoot,jobName,entry.name));
    if(summary)summaries.push(summary);
  }
  if(!summaries.length)return null;
  const total={trials:summaries.length,tests:0,passed:0,failed:0,pending:0,skipped:0,other:0};
  for(const summary of summaries)for(const key of ["tests","passed","failed","pending","skipped","other"])total[key]+=summary[key];
  return total;
}

export async function readTrialVerifierSummary(trialDir){
  const summary=await readVerifierSummary(trialDir);
  return summary?{trials:1,...summary}:null;
}
