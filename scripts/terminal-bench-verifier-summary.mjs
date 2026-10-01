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

export async function readJobVerifierSummary(outputRoot,jobName){
  let entries=[];try{entries=await readdir(join(outputRoot,jobName),{withFileTypes:true})}catch{return null}
  const summaries=[];
  for(const entry of entries){
    if(!entry.isDirectory())continue;
    try{
      const parsed=JSON.parse(await readFile(join(outputRoot,jobName,entry.name,"verifier","ctrf.json"),"utf8")),summary=normalizeCtrfVerifierSummary(parsed);
      if(summary)summaries.push(summary);
    }catch{}
  }
  if(!summaries.length)return null;
  const total={trials:summaries.length,tests:0,passed:0,failed:0,pending:0,skipped:0,other:0};
  for(const summary of summaries)for(const key of ["tests","passed","failed","pending","skipped","other"])total[key]+=summary[key];
  return total;
}

export async function readTrialVerifierSummary(trialDir){
  try{
    const parsed=JSON.parse(await readFile(join(trialDir,"verifier","ctrf.json"),"utf8")),summary=normalizeCtrfVerifierSummary(parsed);
    return summary?{trials:1,...summary}:null;
  }catch{return null}
}
