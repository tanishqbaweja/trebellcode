import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverNativeEventEvidence } from "./terminal-bench-native-evidence.mjs";
import { recoverCodexSessionEvidence } from "./terminal-bench-codex-evidence.mjs";
import { readJobVerifierSummary } from "./terminal-bench-verifier-summary.mjs";

const root=resolve(fileURLToPath(new URL("..",import.meta.url))),validationDir=join(root,".harbor-validation"),jobsDir=join(root,".harbor-jobs");
const watch=process.argv.includes("--watch"),intervalMs=Math.max(2000,Number(process.env.TREBELL_WATCHDOG_INTERVAL_MS||5000));
const explicitTarget=process.argv.find(arg=>arg.startsWith("--target="))?.slice("--target=".length)||null;
if(explicitTarget&&!['auto','pair','native-rerun'].includes(explicitTarget))throw new Error(`Invalid watchdog --target=${explicitTarget}; expected auto, pair, or native-rerun.`);
const targetMode=explicitTarget||"auto";
const explicitPair=process.argv.find(arg=>arg.startsWith("--pair="))?.slice("--pair=".length).trim()||null;
if(explicitPair&&!/^[a-z0-9]+-(?:pair|native-rerun)-[a-z0-9-]+$/i.test(explicitPair))throw new Error(`Invalid watchdog --pair=${explicitPair}; expected a saved <bench>-pair-* or <bench>-native-rerun-* report id.`);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(path){try{return JSON.parse(String(await readFile(path,"utf8")).replace(/^\uFEFF/,""))}catch{return null}}
async function newestTrialDir(jobName){
  let entries=[];try{entries=await readdir(join(jobsDir,jobName),{withFileTypes:true})}catch{return null}
  const dirs=entries.filter(entry=>entry.isDirectory());
  const ranked=await Promise.all(dirs.map(async entry=>{const path=join(jobsDir,jobName,entry.name);try{const info=await stat(path);return {path,createdMs:Number(info.birthtimeMs||info.ctimeMs||info.mtimeMs||0)}}catch{return {path,createdMs:0}}}));
  ranked.sort((a,b)=>b.createdMs-a.createdMs||b.path.localeCompare(a.path));return ranked[0]?.path||null;
}
async function fileState(path){try{const info=await stat(path);return {bytes:info.size,lastWriteAt:info.mtime.toISOString(),ageSeconds:Math.max(0,Math.round((Date.now()-info.mtimeMs)/1000))}}catch{return null}}
function runStampMs(value){
  const stamp=String(value||"").match(/(\d{8}T\d{6}Z)(?:$|[^0-9])/i)?.[1];if(!stamp)return 0;
  const iso=`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(9,11)}:${stamp.slice(11,13)}:${stamp.slice(13,15)}Z`,ms=Date.parse(iso);return Number.isFinite(ms)?ms:0;
}
function reportTimeMs(pointer,report={}){const parsed=Date.parse(String(report?.updatedAt||""));return Number.isFinite(parsed)?parsed:runStampMs(pointer?.pairId)}
function sameRunConfiguration(pairPointer,pairReport,rerunPointer,rerunReport){
  const left={task:pairReport?.task??pairPointer?.task,model:pairReport?.model??pairPointer?.model,reasoningEffort:pairReport?.reasoningEffort??pairPointer?.reasoningEffort,serviceTier:pairReport?.serviceTier??pairPointer?.serviceTier,hostedWebSearch:pairReport?.hostedWebSearch??pairPointer?.hostedWebSearch};
  const right={task:rerunReport?.task??rerunPointer?.task,model:rerunReport?.model??rerunPointer?.model,reasoningEffort:rerunReport?.reasoningEffort??rerunPointer?.reasoningEffort,serviceTier:rerunReport?.serviceTier??rerunPointer?.serviceTier,hostedWebSearch:rerunReport?.hostedWebSearch??rerunPointer?.hostedWebSearch};
  return Object.keys(left).every(key=>left[key]!=null&&right[key]!=null&&left[key]===right[key]);
}
async function laneState(lane,report,recovered=null){
  const sourceLabel=lane.sourceLabel||lane.label,trialDir=await newestTrialDir(lane.jobName),job=report?.jobs?.find(item=>item.label===sourceLabel)||null;
  const liveEvidence=job?null:lane.harness==="native"?await recoverNativeEventEvidence(jobsDir,lane.jobName,{serviceTier:report?.serviceTier||"standard"}):lane.harness==="codex"?await recoverCodexSessionEvidence(jobsDir,lane.jobName,{serviceTier:report?.serviceTier||"standard"}):null;
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
  const recoveredLane=recovered?.lanes?.[sourceLabel]||null;
  if(effectiveJob&&recoveredLane?.checks){
    effectiveJob.recoveredVerifierChecks=recoveredLane.checks;
    effectiveJob.verifierRecovered=true;
  }
  if(effectiveJob){
    const checks=await readJobVerifierSummary(jobsDir,lane.jobName);
    if(checks)effectiveJob.verifierChecks={...(effectiveJob.verifierChecks||{}),...checks};
  }
  return {...lane,activity,job:effectiveJob,liveEvidence:Boolean(liveEvidence&&!job)};
}
function money(value,{lowerBound=false}={}){return value==null?"-":`${lowerBound?"≥":""}$${Number(value).toFixed(4)}`}
function count(value){return value==null?"-":Number(value).toLocaleString("en-US")}
async function snapshot(){
  const pairPointer=explicitPair?null:await json(join(validationDir,"terminal-bench-latest.json")),rerunPointer=explicitPair?null:await json(join(validationDir,"terminal-bench-native-rerun-latest.json"));
  const pairReport=pairPointer?.reportPath?await json(pairPointer.reportPath)||{}:{},rerunReport=rerunPointer?.reportPath?await json(rerunPointer.reportPath)||{}:{};
  const pairTime=reportTimeMs(pairPointer,pairReport),rerunTime=reportTimeMs(rerunPointer,rerunReport);
  const explicitReportPath=explicitPair?join(validationDir,explicitPair+".json"):null,explicitReport=explicitReportPath?await json(explicitReportPath):null;
  if(explicitPair&&!explicitReport)throw new Error(`No saved Terminal-Bench report found for --pair=${explicitPair}.`);
  const selectRerun=explicitPair?/^[a-z0-9]+-native-rerun-/i.test(explicitPair):targetMode==="native-rerun"||(targetMode==="auto"&&Boolean(rerunPointer)&&(!pairPointer||rerunTime>pairTime));
  if(!explicitPair&&targetMode==="pair"&&!pairPointer)throw new Error("No saved Terminal-Bench pair pointer found yet.");
  if(!explicitPair&&selectRerun&&!rerunPointer)throw new Error("No saved standalone Native rerun pointer found yet.");
  const pointer=explicitReport?{pairId:explicitPair,reportPath:explicitReportPath,task:explicitReport.task,lanes:explicitReport.lanes}:selectRerun?rerunPointer:pairPointer;
  if(!pointer)throw new Error("No saved Terminal-Bench run pointer found yet.");
  const report=explicitReport||(selectRerun?rerunReport:pairReport);
  const recovered=await json(String(pointer.reportPath||"").replace(/\.json$/,".recovered-verifier.json"));
  let lanes=await Promise.all((report.lanes||pointer.lanes||[]).map(lane=>laneState(selectRerun?{...lane,label:"native-rerun",sourceLabel:"native"}:lane,report,recovered)));
  let nativeRerun=null;
  const overlayRerun=!selectRerun&&rerunPointer?.reportPath&&sameRunConfiguration(pairPointer,pairReport,rerunPointer,rerunReport)&&rerunTime>=pairTime;
  if(overlayRerun){
    const rerunRecovered=await json(String(rerunPointer.reportPath||"").replace(/\.json$/,".recovered-verifier.json"));
    const sourceLane=(rerunReport.lanes||rerunPointer.lanes||[]).find(lane=>lane.label==="native");
    if(sourceLane){
      nativeRerun=await laneState({...sourceLane,label:"native-rerun",sourceLabel:"native"},rerunReport,rerunRecovered);
      nativeRerun.sourcePairId=rerunPointer.pairId;
      nativeRerun.sourceReportPath=rerunPointer.reportPath;
    }
  }
  return {
    capturedAt:new Date().toISOString(),
    targetMode:selectRerun?"native-rerun":"pair",
    pairId:pointer.pairId,
    task:pointer.task,
    model:report.model??pointer.model??null,
    reasoningEffort:report.reasoningEffort??pointer.reasoningEffort??null,
    serviceTier:report.serviceTier??pointer.serviceTier??null,
    hostedWebSearch:report.hostedWebSearch??pointer.hostedWebSearch??null,
    sameHostedWebSearchPolicy:report.sameHostedWebSearchPolicy??null,
    sameServiceTier:report.sameServiceTier??null,
    sourceGitHead:report.sourceGitHead??pointer.sourceGitHead??null,
    sourceTrackedDirty:report.sourceTrackedDirty??pointer.sourceTrackedDirty??null,
    parallel:report.parallel??pointer.parallel,
    complete:Boolean(report.complete),
    infrastructureInterrupted:Boolean(report.infrastructureInterrupted),
    infrastructureComparable:report.infrastructureComparable??null,
    reportPath:pointer.reportPath,
    nativeRerunReportPath:selectRerun?pointer.reportPath:nativeRerun?.sourceReportPath||null,
    lanes:nativeRerun?[lanes[0],nativeRerun,...lanes.slice(1)]:lanes,
  };
}
async function persist(snap){
  const dir=join(validationDir,"watchdog",snap.pairId);await mkdir(dir,{recursive:true});
  const latest=join(dir,"latest.json"),history=join(dir,"history.jsonl"),stamp=snap.capturedAt.replace(/[:.]/g,"-"),archived=join(dir,`snapshot-${stamp}.json`);
  const pretty=JSON.stringify(snap,null,2)+"\n";
  await Promise.all([
    writeFile(latest,pretty,"utf8"),
    writeFile(archived,pretty,"utf8"),
    appendFile(history,JSON.stringify(snap)+"\n","utf8"),
  ]);
  return latest;
}
function render(snap,saved){
  const lines=[];
  lines.push(`Trebell benchmark watchdog  ${snap.capturedAt}`);
  lines.push(`Pair: ${snap.pairId}`);
  lines.push(`Target: ${snap.targetMode==="native-rerun"?"STANDALONE NATIVE RERUN":"PAIR"}`);
  lines.push(`Task: ${snap.task}`);
  lines.push(`Model: ${snap.model||"-"}   Reasoning: ${snap.reasoningEffort||"-"}   Tier: ${snap.serviceTier||"-"}   Hosted web search: ${snap.hostedWebSearch||"-"}`);
  if(snap.sourceGitHead||snap.sourceTrackedDirty!=null)lines.push(`Source: ${snap.sourceGitHead||"-"}   Tracked dirty: ${snap.sourceTrackedDirty==null?"-":snap.sourceTrackedDirty?"YES":"NO"}`);
  lines.push(`Mode: ${snap.parallel?"PARALLEL":"SEQUENTIAL"}   Complete: ${snap.complete?"YES":"NO"}`);
  if(snap.sameServiceTier===false)lines.push("Fairness warning: service tier differs across lanes");
  if(snap.sameHostedWebSearchPolicy===false)lines.push("Fairness warning: hosted web-search policy differs across lanes");
  if(snap.infrastructureInterrupted)lines.push("Infrastructure: INTERRUPTED — partial evidence only; do not treat as a clean harness comparison");
  lines.push("");
  lines.push("LANE          STATUS     ACTIVITY   REWARD   DIAG       PYTEST  INPUT        OUTPUT       CACHE      API-EQ COST");
  lines.push("------------  ---------  ---------  -------  ---------  ------  -----------  -----------  ---------  -----------");
  for(const lane of snap.lanes){
    const infrastructureReason=lane.job?.infrastructureFailureReason||(lane.job?.exceptionType==="AgentAuthenticationError"?"agent_authentication_failure":null);
    const checks=infrastructureReason?null:lane.job?.verifierChecks||lane.job?.recoveredVerifierChecks,reward=infrastructureReason?"INFRA":checks?.officialReward==null?"-":Number(checks.officialReward).toFixed(3),diag=checks?.diagnostic?`${checks.diagnostic.correct}/${checks.diagnostic.total}`:"-",pytest=checks?.tests?`${checks.passed}/${checks.tests}${lane.job?.verifierRecovered?"*":""}`:"-";
    const age=lane.activity?.state?.ageSeconds,activity=age==null?"-":age<30?"active":age<180?`${age}s ago`:`${Math.round(age/60)}m ago`;
    const cache=lane.job?.cacheHitPercent==null?"-":`${Number(lane.job.cacheHitPercent).toFixed(1)}%`;
    lines.push(`${lane.label.padEnd(12)}  ${String(lane.status||"?").padEnd(9)}  ${String(activity).padEnd(9)}  ${reward.padEnd(7)}  ${diag.padEnd(9)}  ${pytest.padEnd(6)}  ${count(lane.job?.inputTokens).padEnd(11)}  ${count(lane.job?.outputTokens).padEnd(11)}  ${cache.padEnd(9)}  ${money(lane.job?.apiEquivalentCostUsd,{lowerBound:lane.job?.apiEquivalentCostIsLowerBound===true})}`);
    if(lane.runError)lines.push(`  error: ${String(lane.runError).slice(0,180)}`);
    if(infrastructureReason)lines.push(`  infrastructure: ${infrastructureReason} — not a quality result; rerun only this lane`);
  }
  if(snap.lanes.some(lane=>lane.job?.apiEquivalentCostIsLowerBound===true))lines.push("Cost note: ≥ indicates a lower bound because one or more provider responses omitted token usage.");
  if(snap.lanes.some(lane=>lane.job?.verifierChecks?.tests))lines.push("Verifier note: REWARD is Harbor's official task reward; DIAG is a task scorer diagnostic when exposed; PYTEST only says the verifier test harness executed/passed.");
  lines.push("");lines.push(`Saved snapshot: ${saved}`);lines.push(`Full report: ${snap.reportPath}`);
  if(snap.nativeRerunReportPath)lines.push(`Native rerun report: ${snap.nativeRerunReportPath}`);
  return lines.join("\n");
}
do{
  const snap=await snapshot(),saved=await persist(snap);
  if(watch)process.stdout.write("\x1Bc");
  console.log(render(snap,saved));
  if(!watch||snap.complete)break;
  await sleep(intervalMs);
}while(true);
