import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

function nonnegativeInteger(value){
  const number=Number(value);
  return Number.isFinite(number)&&number>=0?Math.trunc(number):0;
}

function finiteNumber(value){
  const number=Number(value);
  return Number.isFinite(number)?number:null;
}

export function normalizeVerifierDiagnosticText(value=""){
  const text=String(value||""),scoring=text.match(/\bScoring:\s*([\d,]+)\s*\/\s*([\d,]+)[^\n=]*=\s*([\d.]+)%/i),cases=text.match(/\bCases:\s*([\d,]+)\s*\/\s*([\d,]+)[^\n=]*=\s*([\d.]+)%/i);
  const parse=match=>match?{correct:Number(match[1].replace(/,/g,"")),total:Number(match[2].replace(/,/g,"")),percent:Number(match[3])}:null;
  return {diagnostic:parse(scoring),cases:parse(cases)};
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
  let summary=null;
  try{
    const parsed=JSON.parse(await readFile(join(trialDir,"verifier","ctrf.json"),"utf8"));summary=normalizeCtrfVerifierSummary(parsed);
  }catch{}
  if(!summary)try{
    const parsed=JSON.parse(await readFile(join(trialDir,"verifier","trace_results.json"),"utf8"));summary=normalizeTraceResultsVerifierSummary(parsed);
  }catch{}
  let officialReward=null;
  try{officialReward=finiteNumber(JSON.parse(await readFile(join(trialDir,"verifier","reward.json"),"utf8"))?.reward)}catch{}
  if(officialReward==null)try{const text=String(await readFile(join(trialDir,"verifier","reward.txt"),"utf8")).trim();if(text)officialReward=finiteNumber(text)}catch{}
  let diagnostic=null,cases=null;
  try{({diagnostic,cases}=normalizeVerifierDiagnosticText(await readFile(join(trialDir,"verifier","test-stdout.txt"),"utf8")))}catch{}
  if(!summary&&officialReward==null&&!diagnostic&&!cases)return null;
  const enriched=summary||{tests:0,passed:0,failed:0,pending:0,skipped:0,other:0};
  if(officialReward!=null)enriched.officialReward=officialReward;
  if(diagnostic)enriched.diagnostic=diagnostic;
  if(cases)enriched.cases=cases;
  return enriched;
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
  const rewards=summaries.map(summary=>summary.officialReward).filter(value=>value!=null);
  if(rewards.length){total.rewardTrials=rewards.length;total.officialReward=rewards.reduce((sum,value)=>sum+value,0)/rewards.length}
  const diagnostics=summaries.map(summary=>summary.diagnostic).filter(Boolean);
  if(diagnostics.length){const correct=diagnostics.reduce((sum,item)=>sum+item.correct,0),all=diagnostics.reduce((sum,item)=>sum+item.total,0);total.diagnostic={correct,total:all,percent:all?100*correct/all:0}}
  const caseDiagnostics=summaries.map(summary=>summary.cases).filter(Boolean);
  if(caseDiagnostics.length){const correct=caseDiagnostics.reduce((sum,item)=>sum+item.correct,0),all=caseDiagnostics.reduce((sum,item)=>sum+item.total,0);total.cases={correct,total:all,percent:all?100*correct/all:0}}
  return total;
}

export async function readTrialVerifierSummary(trialDir){
  const summary=await readVerifierSummary(trialDir);
  return summary?{trials:1,...summary}:null;
}
