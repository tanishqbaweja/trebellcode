import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { waitForJobProcessDrain } from "./terminal-bench-process-drain.mjs";
import { jobsForPairReport } from "./terminal-bench-pair-report.mjs";
import { readJobVerifierSummary } from "./terminal-bench-verifier-summary.mjs";
import { recoverNativeEventEvidence, selectNativeMetric } from "./terminal-bench-native-evidence.mjs";
import { recoverCodexSessionEvidence } from "./terminal-bench-codex-evidence.mjs";
import { acquireTerminalBenchPairLock, sharedTerminalBenchLockPath } from "./terminal-bench-pair-lock.mjs";
import { estimateGpt6LunaStandardCostFromAggregate, GPT6_LUNA_STANDARD_PRICING } from "./terminal-bench-cost.mjs";

if(!process.argv.includes("--live"))throw new Error("Refusing to run paid/live Terminal-Bench without --live.");

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,"..");
function repositoryRootFromGitCommonDir(){
  try{
    const gitCommonDir=String(execFileSync("git",["rev-parse","--git-common-dir"],{cwd:root,encoding:"utf8",windowsHide:true})).trim();
    return gitCommonDir?dirname(resolve(root,gitCommonDir)):root;
  }catch{return root}
}
const repositoryRoot=repositoryRootFromGitCommonDir();
let localEnvLoaded=false;
try{loadEnvFile(join(root,".env"));localEnvLoaded=true}catch(error){if(error?.code!=="ENOENT")throw error}
if(!localEnvLoaded&&repositoryRoot!==root)try{loadEnvFile(join(repositoryRoot,".env"))}catch(error){if(error?.code!=="ENOENT")throw error}
const DATASET=String(process.env.TREBELL_TERMINAL_BENCH_DATASET||"terminal-bench/terminal-bench@4.0.0").trim();
const MODEL=String(process.env.TREBELL_TERMINAL_BENCH_MODEL||"gpt-6-luna").trim();
const EFFORT=String(process.env.TREBELL_TERMINAL_BENCH_REASONING_EFFORT||"max").trim().toLowerCase();
const taskArg=process.argv.find(arg=>arg.startsWith("--task="));
const TASK=String(taskArg?.slice("--task=".length)||process.env.TREBELL_TERMINAL_BENCH_TASK||"terminal-bench/session-window-debug").trim();
const setupTimeoutArg=process.argv.find(arg=>arg.startsWith("--agent-setup-timeout-multiplier="));
const SETUP_TIMEOUT_MULTIPLIER=Number(setupTimeoutArg?.slice("--agent-setup-timeout-multiplier=".length)||process.env.TREBELL_TERMINAL_BENCH_SETUP_TIMEOUT_MULTIPLIER||3);
if(!Number.isFinite(SETUP_TIMEOUT_MULTIPLIER)||SETUP_TIMEOUT_MULTIPLIER<1)throw new Error("Terminal-Bench setup timeout multiplier must be >= 1.");
const agentTimeoutArg=process.argv.find(arg=>arg.startsWith("--agent-timeout-multiplier="));
const AGENT_TIMEOUT_MULTIPLIER=Number(agentTimeoutArg?.slice("--agent-timeout-multiplier=".length)||process.env.TREBELL_TERMINAL_BENCH_AGENT_TIMEOUT_MULTIPLIER||1);
if(!Number.isFinite(AGENT_TIMEOUT_MULTIPLIER)||AGENT_TIMEOUT_MULTIPLIER<=0)throw new Error("Terminal-Bench agent timeout multiplier must be > 0.");
const PARALLEL=process.argv.includes("--parallel")||String(process.env.TREBELL_TERMINAL_BENCH_PARALLEL||"").trim()==="1";
const onlyArg=process.argv.find(arg=>arg.startsWith("--only="));
const inheritedOnly=String(process.env.TREBELL_TERMINAL_BENCH_ONLY||"").trim();
if(!onlyArg&&inheritedOnly)throw new Error("Refusing inherited TREBELL_TERMINAL_BENCH_ONLY for a paid benchmark. Pass --only=<lanes> explicitly so lane selection is recorded in the launch command.");
const only=new Set(String(onlyArg?.slice("--only=".length)||"").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean));
const codexAuthArg=process.argv.find(arg=>arg.startsWith("--codex-auth="));
const CODEX_AUTH_MODE=String(codexAuthArg?.slice("--codex-auth=".length)||process.env.TREBELL_TERMINAL_BENCH_CODEX_AUTH||"both").trim().toLowerCase();
if(!["api","oauth","both"].includes(CODEX_AUTH_MODE))throw new Error("Terminal-Bench Codex auth mode must be api, oauth, or both.");
const CODEX_AUTH_MODES=CODEX_AUTH_MODE==="both"?["api","oauth"]:[CODEX_AUTH_MODE];
const nativeReasoningContextArg=process.argv.find(arg=>arg.startsWith("--native-reasoning-context="));
const NATIVE_REASONING_CONTEXT=String(nativeReasoningContextArg?.slice("--native-reasoning-context=".length)||process.env.TREBELL_OPENAI_REASONING_CONTEXT||"").trim().toLowerCase()||null;
if(NATIVE_REASONING_CONTEXT&&!["auto","current_turn","all_turns"].includes(NATIVE_REASONING_CONTEXT))throw new Error("Native OpenAI reasoning context must be auto, current_turn, or all_turns.");
const codexInstallArg=process.argv.find(arg=>arg.startsWith("--codex-install="));
const CODEX_INSTALL_MODE=String(codexInstallArg?.slice("--codex-install=".length)||process.env.TREBELL_TERMINAL_BENCH_CODEX_INSTALL||"pinned").trim().toLowerCase();
if(!["stock","pinned"].includes(CODEX_INSTALL_MODE))throw new Error("Terminal-Bench Codex install mode must be stock or pinned.");
const CODEX_PINNED_VERSION="0.158.0";
const CODEX_PINNED_TARBALL_SHA256="3fe84106aaf2fbfc13299068510d34b3d0157eeb9af4b37be8cf5416f485a6bb";
const NATIVE_PINNED_NODE_VERSION="22.23.3";
const NATIVE_PINNED_NODE_TARBALL_SHA256="1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af";
const NATIVE_PINNED_NODE_URL=`https://nodejs.org/download/release/v${NATIVE_PINNED_NODE_VERSION}/node-v${NATIVE_PINNED_NODE_VERSION}-linux-x64.tar.gz`;
const validationDir=join(root,".harbor-validation");

function run(command,args,{env=process.env,shell=false}={}){
  return new Promise((resolveRun,reject)=>{
    const child=spawn(command,args,{cwd:root,env,stdio:"inherit",windowsHide:true,shell});
    child.once("error",reject);
    child.once("exit",(code,signal)=>code===0?resolveRun({code:0}):reject(Object.assign(new Error(`${command} exited with ${signal||code}`),{code,signal})));
  });
}
function capture(command,args,{env=process.env}={}){
  return new Promise((resolveCapture,reject)=>{
    const child=spawn(command,args,{cwd:root,env,stdio:["ignore","pipe","pipe"],windowsHide:true});let stdout="",stderr="";
    child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",chunk=>{stdout+=chunk});child.stderr.on("data",chunk=>{stderr+=chunk});
    child.once("error",reject);
    child.once("exit",(code,signal)=>code===0?resolveCapture(stdout):reject(Object.assign(new Error(`${command} exited with ${signal||code}: ${stderr.trim().slice(0,500)}`),{code,signal})));
  });
}
async function sourceGitProvenance(){
  try{
    const sourceGitHead=String(await capture("git",["rev-parse","HEAD"])).trim()||null;
    const trackedStatus=String(await capture("git",["status","--porcelain=v1","--untracked-files=no"]));
    const sourceTrackedDirty=Boolean(trackedStatus.trim());
    const sourceTrackedDiffSha256=sourceTrackedDirty?createHash("sha256").update(await capture("git",["diff","--binary","HEAD","--"])).digest("hex"):null;
    return {sourceGitHead,sourceTrackedDirty,sourceTrackedDiffSha256};
  }catch{return {sourceGitHead:null,sourceTrackedDirty:null,sourceTrackedDiffSha256:null}}
}
const LANE_DRAIN_TIMEOUT_MS=Math.max(5_000,Math.trunc(Number(process.env.TREBELL_TERMINAL_BENCH_LANE_DRAIN_MS)||300_000));

async function harborBin(){
  const configured=String(process.env.HARBOR_BIN||"").trim();
  const candidates=[
    configured,
    join(homedir(),".local","bin",process.platform==="win32"?"harbor.exe":"harbor"),
  ].filter(Boolean);
  for(const candidate of candidates)try{await access(candidate);return candidate}catch{}
  return process.platform==="win32"?"harbor.exe":"harbor";
}

function safeSlug(value){return String(value||"").replace(/^terminal-bench\//,"").replace(/[^a-z0-9]+/gi,"-").replace(/^-|-$/g,"").toLowerCase().slice(0,80)||"task"}
function stamp(){return new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z")}
async function sha256File(path){return createHash("sha256").update(await readFile(path)).digest("hex")}
async function ensurePinnedCodexTarball(path,{explicit=false}={}){
  try{await access(path);return}catch(error){if(explicit)throw error}
  await mkdir(dirname(path),{recursive:true});
  const configuredNpmCli=String(process.env.npm_execpath||"").trim(),bundledNpmCli=join(dirname(process.execPath),"node_modules","npm","bin","npm-cli.js");
  let npmCli=null;
  for(const candidate of [configuredNpmCli,bundledNpmCli].filter(Boolean))try{await access(candidate);npmCli=candidate;break}catch{}
  const args=["pack",`@openai/codex@${CODEX_PINNED_VERSION}-linux-x64`,"--pack-destination",dirname(path)];
  if(npmCli)await run(process.execPath,[npmCli,...args]);
  else await run(process.platform==="win32"?"npm.cmd":"npm",args,{shell:process.platform==="win32"});
  await access(path);
}
async function ensurePinnedNodeTarball(path,{explicit=false}={}){
  try{await access(path);return}catch(error){if(explicit)throw error}
  await mkdir(dirname(path),{recursive:true});
  const response=await fetch(NATIVE_PINNED_NODE_URL,{redirect:"follow"});
  if(!response.ok)throw new Error(`Failed to download pinned Node runtime: HTTP ${response.status}`);
  await writeFile(path,Buffer.from(await response.arrayBuffer()));
  await access(path);
}
function elapsedMs(range){const start=Date.parse(String(range?.started_at||"")),end=Date.parse(String(range?.finished_at||""));return Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,end-start):null}
async function trialResult(outputRoot,jobName){
  let entries=[];try{entries=await readdir(join(outputRoot,jobName),{withFileTypes:true})}catch{return null}
  for(const entry of entries){
    if(!entry.isDirectory())continue;
    try{return JSON.parse(await readFile(join(outputRoot,jobName,entry.name,"result.json"),"utf8"))}catch{}
  }
  return null;
}

function recoveredExceptionInfo(text){
  const lines=String(text||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  for(let index=lines.length-1;index>=0;index--){
    const match=lines[index].match(/(?:^|\.)([A-Za-z][A-Za-z0-9_]*Error):\s*(.*)$/);
    if(match)return {exception_type:match[1],exception_message:String(match[2]||lines[index]).slice(0,1200)};
  }
  return lines.length?{exception_type:"RecoveredTrialError",exception_message:lines.at(-1).slice(0,1200)}:null;
}

async function recoverTrialEvidence(outputRoot,jobName){
  let entries=[];try{entries=await readdir(join(outputRoot,jobName),{withFileTypes:true})}catch{return null}
  for(const entry of entries){
    if(!entry.isDirectory())continue;
    const trialDir=join(outputRoot,jobName,entry.name);let config=null,lock=null,exceptionInfo=null,reward=null;
    try{config=JSON.parse(await readFile(join(trialDir,"config.json"),"utf8"))}catch{}
    try{lock=JSON.parse(await readFile(join(trialDir,"lock.json"),"utf8"))}catch{}
    try{exceptionInfo=recoveredExceptionInfo(await readFile(join(trialDir,"exception.txt"),"utf8"))}catch{}
    try{const parsed=Number(String(await readFile(join(trialDir,"verifier","reward.txt"),"utf8")).trim());if(Number.isFinite(parsed))reward=parsed}catch{}
    if(!config&&!lock&&!exceptionInfo&&reward==null)continue;
    return {
      task_name:config?.task?.name||lock?.task?.name||null,
      config:config||null,
      agent_info:null,
      agent_result:null,
      verifier_result:reward==null?null:{rewards:{reward}},
      exception_info:exceptionInfo,
      recovered_from_trial_files:true,
    };
  }
  return null;
}

const gitCommonDir=String(await capture("git",["rev-parse","--git-common-dir"])).trim(),lockPath=sharedTerminalBenchLockPath(root,gitCommonDir);
const releaseLock=await acquireTerminalBenchPairLock({lockPath,task:TASK,model:MODEL,effort:EFFORT}),runStamp=stamp(),pairId=`tb4-pair-${safeSlug(MODEL)}-${EFFORT}-${safeSlug(TASK)}-${runStamp}`,reportPath=join(validationDir,pairId+".json"),sourceProvenance=await sourceGitProvenance();let codexApiAuthPath=null;
try{
  await run(process.execPath,[join(root,"scripts","build-harbor-native-agent.mjs")]);
  const nativeBundlePath=join(root,"benchmarks","harbor","dist","trebell-native-agent.mjs"),nativeAdapterPath=join(root,"benchmarks","harbor","trebell_native_agent.py");
  const nativeBundleSha256=await sha256File(nativeBundlePath),nativeAdapterSha256=await sha256File(nativeAdapterPath);
  const lanes=[
    {label:"native",harness:"native",authMode:"api"},
    ...CODEX_AUTH_MODES.map(authMode=>({label:`codex-${authMode}`,harness:"codex",authMode})),
  ];
  const selectedLanes=lanes.filter(lane=>!only.size||only.has(lane.label)||only.has(lane.harness));
  if(!selectedLanes.length)throw new Error(`Terminal-Bench --only filter selected no lanes: ${[...only].join(",")||"none"}`);
  const nativeLaneSelected=selectedLanes.some(lane=>lane.harness==="native");
  let nativePinnedNodeTarballPath=null,nativePinnedNodeTarballSha256=null;
  if(nativeLaneSelected){
    const configuredNodeTarball=String(process.env.TREBELL_NODE_PINNED_TARBALL||"").trim();
    nativePinnedNodeTarballPath=resolve(configuredNodeTarball||join(validationDir,"node-stage",`node-v${NATIVE_PINNED_NODE_VERSION}-linux-x64.tar.gz`));
    await ensurePinnedNodeTarball(nativePinnedNodeTarballPath,{explicit:Boolean(configuredNodeTarball)});
    nativePinnedNodeTarballSha256=await sha256File(nativePinnedNodeTarballPath);
    if(nativePinnedNodeTarballSha256!==NATIVE_PINNED_NODE_TARBALL_SHA256)throw new Error(`Pinned Node tarball SHA-256 mismatch: expected ${NATIVE_PINNED_NODE_TARBALL_SHA256}, got ${nativePinnedNodeTarballSha256}`);
  }
  const codexPinnedAdapterPath=join(root,"benchmarks","harbor","pinned_codex_agent.py"),codexPinnedAdapterSha256=await sha256File(codexPinnedAdapterPath);
  let codexPinnedTarballPath=null,codexPinnedTarballSha256=null;
  if(CODEX_INSTALL_MODE==="pinned"){
    const configuredTarball=String(process.env.TREBELL_CODEX_PINNED_TARBALL||"").trim();
    codexPinnedTarballPath=resolve(configuredTarball||join(validationDir,"codex-stage",`openai-codex-${CODEX_PINNED_VERSION}-linux-x64.tgz`));
    await ensurePinnedCodexTarball(codexPinnedTarballPath,{explicit:Boolean(configuredTarball)});
    codexPinnedTarballSha256=await sha256File(codexPinnedTarballPath);
    if(codexPinnedTarballSha256!==CODEX_PINNED_TARBALL_SHA256)throw new Error(`Pinned Codex tarball SHA-256 mismatch: expected ${CODEX_PINNED_TARBALL_SHA256}, got ${codexPinnedTarballSha256}`);
  }
  const harbor=await harborBin(),pythonPath=[root,process.env.PYTHONPATH].filter(Boolean).join(delimiter);
  const sharedEnv={
    ...process.env,
    PYTHONPATH:pythonPath,
    ...(process.platform==="win32"?{PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8"}:{}),
    ...(nativePinnedNodeTarballPath?{TREBELL_NODE_PINNED_TARBALL:nativePinnedNodeTarballPath}: {}),
    ...(codexPinnedTarballPath?{TREBELL_CODEX_PINNED_TARBALL:codexPinnedTarballPath}: {}),
  },outputRoot=join(root,".harbor-jobs"),jobs=[];
  const willRunCodexApi=selectedLanes.some(lane=>lane.label==="codex-api"),willRunCodexOauth=selectedLanes.some(lane=>lane.label==="codex-oauth");
  if(willRunCodexOauth)await access(join(homedir(),".codex","auth.json"));
  if(willRunCodexApi){
    const apiKey=String(sharedEnv.OPENAI_API_KEY||"").trim();
    if(!apiKey)throw new Error("OPENAI_API_KEY is required for the Codex API benchmark lane.");
    codexApiAuthPath=join(validationDir,`.codex-api-auth-${process.pid}-${runStamp}.json`);
    await writeFile(codexApiAuthPath,JSON.stringify({OPENAI_API_KEY:apiKey})+"\n",{encoding:"utf8",mode:0o600});
  }
  const laneStates=selectedLanes.map(lane=>({
    label:lane.label,harness:lane.harness,authMode:lane.authMode,
    jobName:`tb4-${lane.label}-${safeSlug(MODEL)}-${EFFORT}-${safeSlug(TASK)}-${runStamp}`,
    status:"pending",startedAt:null,finishedAt:null,runError:null,
  }));
  const reportSnapshot=({complete=false}={})=>({
    pairId,dataset:DATASET,task:TASK,model:MODEL,reasoningEffort:EFFORT,setupTimeoutMultiplier:SETUP_TIMEOUT_MULTIPLIER,agentTimeoutMultiplier:AGENT_TIMEOUT_MULTIPLIER,
    sameModel:true,sameReasoningEffort:true,sequential:!PARALLEL,parallel:PARALLEL,codexAuthMode:CODEX_AUTH_MODE,codexInstallMode:CODEX_INSTALL_MODE,nativeReasoningContext:NATIVE_REASONING_CONTEXT,
    ...sourceProvenance,
    ...(nativePinnedNodeTarballPath?{nativePinnedNodeVersion:NATIVE_PINNED_NODE_VERSION,nativePinnedNodeTarballSha256}:{}),
    ...(codexPinnedTarballPath?{codexPinnedVersion:CODEX_PINNED_VERSION,codexPinnedTarballSha256,codexPinnedAdapterSha256}:{}),
    comparisonLanes:selectedLanes.map(lane=>lane.label),configuredComparisonLanes:lanes.map(lane=>lane.label),nativeBundleSha256,nativeAdapterSha256,
    pricingSnapshot:MODEL==="gpt-6-luna"?GPT6_LUNA_STANDARD_PRICING:null,
    complete,
    activeHarness:laneStates.filter(lane=>lane.status==="running").length===1?laneStates.find(lane=>lane.status==="running")?.label||null:null,
    activeJobName:laneStates.filter(lane=>lane.status==="running").length===1?laneStates.find(lane=>lane.status==="running")?.jobName||null:null,
    activeLanes:laneStates.filter(lane=>lane.status==="running").map(lane=>lane.label),
    lanes:laneStates.map(lane=>({...lane})),
    updatedAt:new Date().toISOString(),jobs:jobsForPairReport(jobs.filter(Boolean),{complete}),
  });
  let reportWrite=Promise.resolve();
  const persistReport=(state={})=>{
    const snapshot=reportSnapshot(state),tmpPath=reportPath+`.tmp-${process.pid}`;
    reportWrite=reportWrite.then(async()=>{await writeFile(tmpPath,JSON.stringify(snapshot,null,2)+"\n","utf8");await rename(tmpPath,reportPath)});
    return reportWrite;
  };
  const latestPointerPath=join(validationDir,"terminal-bench-latest.json");
  await writeFile(latestPointerPath,JSON.stringify({pairId,reportPath,task:TASK,model:MODEL,reasoningEffort:EFFORT,parallel:PARALLEL,lanes:laneStates.map(lane=>({label:lane.label,jobName:lane.jobName}))},null,2)+"\n","utf8");
  await persistReport({complete:false});
  const runLane=async(lane,laneIndex)=>{
    const {label,harness,authMode}=lane;
    const agent=harness==="native"?"benchmarks.harbor.trebell_native_agent:TrebellNativeAgent":CODEX_INSTALL_MODE==="pinned"?"benchmarks.harbor.pinned_codex_agent:PinnedCodexAgent":"codex";
    const laneState=laneStates[laneIndex],jobName=laneState.jobName;
    const args=["run","-d",DATASET,"-i",TASK,"-a",agent,"-m",`openai/${MODEL}`,"--ak",`reasoning_effort=${EFFORT}`,"-n","1","-o",outputRoot,"--job-name",jobName,"-y"];
    if(SETUP_TIMEOUT_MULTIPLIER>1)args.push("--agent-setup-timeout-multiplier",String(SETUP_TIMEOUT_MULTIPLIER));
    if(AGENT_TIMEOUT_MULTIPLIER!==1)args.push("--agent-timeout-multiplier",String(AGENT_TIMEOUT_MULTIPLIER));
    const harnessEnv={...sharedEnv};
    if(harness==="native"){
      if(NATIVE_REASONING_CONTEXT)harnessEnv.TREBELL_OPENAI_REASONING_CONTEXT=NATIVE_REASONING_CONTEXT;
      else delete harnessEnv.TREBELL_OPENAI_REASONING_CONTEXT;
    }
    if(harness==="codex"){
      delete harnessEnv.CODEX_AUTH_JSON_PATH;
      delete harnessEnv.CODEX_FORCE_AUTH_JSON;
      delete harnessEnv.OPENAI_API_KEY;
      if(authMode==="oauth")harnessEnv.CODEX_FORCE_AUTH_JSON="1";
      else harnessEnv.CODEX_AUTH_JSON_PATH=codexApiAuthPath;
    }
    laneState.status="running";laneState.startedAt=new Date().toISOString();await persistReport({complete:false});
    let runError=null;
    try{await run(harbor,args,{env:harnessEnv})}catch(error){runError=error?.message||String(error)}
    let drainError=null;
    try{await waitForJobProcessDrain(jobName,{timeoutMs:LANE_DRAIN_TIMEOUT_MS,cwd:root})}catch(error){drainError=error?.message||String(error);runError=[runError,drainError].filter(Boolean).join("; ")}
    let result=null;
    try{result=JSON.parse(await readFile(join(outputRoot,jobName,"result.json"),"utf8"))}catch{}
    const recordedTrial=await trialResult(outputRoot,jobName),trial=recordedTrial||await recoverTrialEvidence(outputRoot,jobName);
    const recoveredNative=harness==="native"?await recoverNativeEventEvidence(outputRoot,jobName):null;
    const recoveredCodex=harness==="codex"?await recoverCodexSessionEvidence(outputRoot,jobName):null;
    const recoveredEvidence=recoveredNative||recoveredCodex;
    const inputMetric=selectNativeMetric(result?.stats?.n_input_tokens,trial?.agent_result?.n_input_tokens,recoveredEvidence?.inputTokens);
    const cachedMetric=selectNativeMetric(result?.stats?.n_cache_tokens,trial?.agent_result?.n_cache_tokens,recoveredEvidence?.cachedTokens);
    const outputMetric=selectNativeMetric(result?.stats?.n_output_tokens,trial?.agent_result?.n_output_tokens,recoveredEvidence?.outputTokens);
    const inputTokens=inputMetric.value,cachedTokens=cachedMetric.value;
    const uncachedInputTokens=inputTokens==null||cachedTokens==null?null:Math.max(0,Number(inputTokens)-Number(cachedTokens));
    const cacheHitPercent=inputTokens==null||Number(inputTokens)<=0||cachedTokens==null?null:Number(((Number(cachedTokens)/Number(inputTokens))*100).toFixed(2));
    const trebellNative=trial?.agent_result?.metadata?.trebell_native||null;
    const recoveredFromNativeEvents=Boolean(recoveredNative&&(inputMetric.recovered||cachedMetric.recovered||outputMetric.recovered||!trebellNative));
    const apiEquivalentCostBreakdown=MODEL==="gpt-6-luna"&&recoveredEvidence?.apiEquivalentCostBreakdown
      ?recoveredEvidence.apiEquivalentCostBreakdown
      :MODEL==="gpt-6-luna"&&inputTokens!=null&&cachedTokens!=null
        ?estimateGpt6LunaStandardCostFromAggregate({inputTokens,cachedInputTokens:cachedTokens,cacheWriteInputTokens:trebellNative?.cache_write_input_tokens??recoveredEvidence?.cacheWriteInputTokens??0,outputTokens:outputMetric.value??0},{maxObservedInputTokens:recoveredEvidence?.maxObservedInputTokens??null})
        :null;
    jobs[laneIndex]={
      harness,label,agent,jobName,runError,authMode,
      completed:Number(result?.stats?.n_completed_trials||0),errors:Number(result?.stats?.n_errored_trials||0),
      inputTokens,cachedTokens,uncachedInputTokens,cacheHitPercent,
      outputTokens:outputMetric.value,
      costUsd:result?.stats?.cost_usd??trial?.agent_result?.cost_usd??null,
      apiEquivalentCostUsd:apiEquivalentCostBreakdown?.totalUsd??null,
      apiEquivalentCostBreakdown,
      reward:trial?.verifier_result?.rewards?.reward??null,taskChecksum:trial?.task_checksum??null,
      agentVersion:trial?.agent_info?.version??null,
      setupMs:elapsedMs(trial?.agent_setup),agentExecutionMs:elapsedMs(trial?.agent_execution),verifierMs:elapsedMs(trial?.verifier),
      ...(trebellNative?{modelTurns:trebellNative.model_turns??recoveredNative?.modelTurns??null,toolCalls:trebellNative.tool_calls??recoveredNative?.toolCalls??null,providerRequests:trebellNative.provider_requests??null,reasoningContext:trebellNative.reasoning_context??null,effectiveReasoningContexts:trebellNative.effective_reasoning_contexts??[],reasoningOutputTokens:trebellNative.reasoning_output_tokens??recoveredNative?.reasoningOutputTokens??null,cacheWriteInputTokens:trebellNative.cache_write_input_tokens??recoveredNative?.cacheWriteInputTokens??null,cacheCarryover:trebellNative.cache_carryover??null,strategy:trebellNative.strategy??null,budgets:trebellNative.budgets??null}:recoveredNative?{modelTurns:recoveredNative.modelTurns,toolCalls:recoveredNative.toolCalls,reasoningOutputTokens:recoveredNative.reasoningOutputTokens,cacheWriteInputTokens:recoveredNative.cacheWriteInputTokens}:{}),
      exceptionType:trial?.exception_info?.exception_type??null,exceptionMessage:trial?.exception_info?.exception_message??null,
      recoveredFromTrialFiles:trial?.recovered_from_trial_files===true,
      recoveredFromNativeEvents,
      recoveredFromCodexSessions:Boolean(recoveredCodex),
      ...(harness==="codex"&&recoveredCodex?{modelTurns:recoveredCodex.modelTurns,reasoningOutputTokens:recoveredCodex.reasoningOutputTokens,cacheWriteInputTokens:recoveredCodex.cacheWriteInputTokens}:{}),
      evals:result?.stats?.evals||{},
    };
    laneState.status=runError?"failed":"finished";laneState.finishedAt=new Date().toISOString();laneState.runError=runError;
    await persistReport({complete:false});
  };
  if(PARALLEL)await Promise.all(selectedLanes.map((lane,index)=>runLane(lane,index)));
  else for(let index=0;index<selectedLanes.length;index++)await runLane(selectedLanes[index],index);
  // Keep verifier internals sealed while comparison lanes are still running.
  // Only after every lane has finished do we read generic CTRF pass/fail totals
  // and attach them to the final report for correctness-first comparison.
  for(const job of jobs.filter(Boolean))job.verifierChecks=await readJobVerifierSummary(outputRoot,job.jobName);
  const report=reportSnapshot({complete:true});await writeFile(reportPath,JSON.stringify(report,null,2)+"\n","utf8");
  console.log("TREBELL_TERMINAL_BENCH_REPORT "+JSON.stringify({...report,reportPath},null,2));
  if(jobs.filter(Boolean).some(job=>job.runError||job.errors>0||job.completed<1)||jobs.filter(Boolean).length!==selectedLanes.length)process.exitCode=1;
}finally{if(codexApiAuthPath)await rm(codexApiAuthPath,{force:true}).catch(()=>{});await releaseLock()}
