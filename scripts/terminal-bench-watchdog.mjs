import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverNativeEventEvidence } from "./terminal-bench-native-evidence.mjs";
import { recoverCodexSessionEvidence } from "./terminal-bench-codex-evidence.mjs";

const root=resolve(fileURLToPath(new URL("..",import.meta.url))),validationDir=join(root,".harbor-validation"),jobsDir=join(root,".harbor-jobs");
const watch=process.argv.includes("--watch"),intervalMs=Math.max(2000,Number(process.env.TREBELL_WATCHDOG_INTERVAL_MS||5000));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(path){try{return JSON.parse(await readFile(path,"utf8"))}catch{return null}}
async function newestTrialDir(jobName){
  let entries=[];try{entries=await readdir(join(jobsDir,jobName),{withFileTypes:true})}catch{return null}
  const dirs=entries.filter(entry=>entry.isDirectory());return dirs[0]?join(jobsDir,jobName,dirs[0].name):null;
}
async function fileState(path){try{const info=await stat(path);return {bytes:info.size,lastWriteAt:info.mtime.toISOString(),ageSeconds:Math.max(0,Math.round((Date.now()-info.mtimeMs)/1000))}}catch{return null}}
async function laneState(lane,report){
  const trialDir=await newestTrialDir(lane.jobName),job=report?.jobs?.find(item=>item.label===lane.label)||null;
  const liveEvidence=job?null:lane.harness==="native"?await recoverNativeEventEvidence(jobsDir,lane.jobName):lane.harness==="codex"?await recoverCodexSessionEvidence(jobsDir,lane.jobName):null;
  let activity=null;
  if(trialDir){
    const agentDir=join(trialDir,"agent"),candidates=[join(agentDir,"trebell-native-events.jsonl"),join(agentDir,"codex.txt")];
    for(const path of candidates){const state=await fileState(path);if(state){activity={path,state};break}}
  }
  const effectiveJob=job||liveEvidence?{
    ...(liveEvidence||{}),
    ...(job||{}),
    apiEquivalentCostUsd:job?.apiEquivalentCostUsd??liveEvidence?.apiEquivalentCostUsd??null,
  }:null;
  return {...lane,activity,job:effectiveJob,liveEvidence:Boolean(liveEvidence&&!job)};
}
function money(value){return value==null?"-":`$${Number(value).toFixed(4)}`}
function count(value){return value==null?"-":Number(value).toLocaleString("en-US")}
async function snapshot(){
  const pointer=await json(join(validationDir,"terminal-bench-latest.json"));
  if(!pointer)throw new Error("No saved Terminal-Bench run pointer found yet.");
  const report=await json(pointer.reportPath)||{};
  const lanes=await Promise.all((report.lanes||pointer.lanes||[]).map(lane=>laneState(lane,report)));
  return {capturedAt:new Date().toISOString(),pairId:pointer.pairId,task:pointer.task,model:pointer.model,parallel:pointer.parallel,complete:Boolean(report.complete),reportPath:pointer.reportPath,lanes};
}
async function persist(snap){
  const dir=join(validationDir,"watchdog",snap.pairId);await mkdir(dir,{recursive:true});
  const latest=join(dir,"latest.json");await writeFile(latest,JSON.stringify(snap,null,2)+"\n","utf8");return latest;
}
function render(snap,saved){
  const lines=[];
  lines.push(`Trebell benchmark watchdog  ${snap.capturedAt}`);
  lines.push(`Pair: ${snap.pairId}`);
  lines.push(`Task: ${snap.task}`);
  lines.push(`Mode: ${snap.parallel?"PARALLEL":"SEQUENTIAL"}   Complete: ${snap.complete?"YES":"NO"}`);
  lines.push("");
  lines.push("LANE          STATUS     ACTIVITY   VERIFY  INPUT        OUTPUT       CACHE      API-EQ COST");
  lines.push("------------  ---------  ---------  ------  -----------  -----------  ---------  -----------");
  for(const lane of snap.lanes){
    const checks=lane.job?.verifierChecks,verify=checks?`${checks.passed}/${checks.tests}`:"-";
    const age=lane.activity?.state?.ageSeconds,activity=age==null?"-":age<30?"active":age<180?`${age}s ago`:`${Math.round(age/60)}m ago`;
    const cache=lane.job?.cacheHitPercent==null?"-":`${Number(lane.job.cacheHitPercent).toFixed(1)}%`;
    lines.push(`${lane.label.padEnd(12)}  ${String(lane.status||"?").padEnd(9)}  ${String(activity).padEnd(9)}  ${verify.padEnd(6)}  ${count(lane.job?.inputTokens).padEnd(11)}  ${count(lane.job?.outputTokens).padEnd(11)}  ${cache.padEnd(9)}  ${money(lane.job?.apiEquivalentCostUsd)}`);
    if(lane.runError)lines.push(`  error: ${String(lane.runError).slice(0,180)}`);
  }
  lines.push("");lines.push(`Saved snapshot: ${saved}`);lines.push(`Full report: ${snap.reportPath}`);
  return lines.join("\n");
}
do{
  const snap=await snapshot(),saved=await persist(snap);
  if(watch)process.stdout.write("\x1Bc");
  console.log(render(snap,saved));
  if(!watch||snap.complete)break;
  await sleep(intervalMs);
}while(true);
