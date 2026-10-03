import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { waitForJobProcessDrain } from "./terminal-bench-process-drain.mjs";
import { jobsForPairReport } from "./terminal-bench-pair-report.mjs";
import { readJobVerifierSummary, readTrialVerifierSummary } from "./terminal-bench-verifier-summary.mjs";
import { recoverNativeEventEvidence, selectNativeMetric } from "./terminal-bench-native-evidence.mjs";
import { recoverCodexSessionEvidence } from "./terminal-bench-codex-evidence.mjs";
import { acquireTerminalBenchPairLock, sharedTerminalBenchLockPath, sharedTerminalBenchNativeRerunLockPath } from "./terminal-bench-pair-lock.mjs";
import { estimateGpt6LunaCostFromAggregate, gpt6LunaPricingForServiceTier } from "./terminal-bench-cost.mjs";
import { cleanupDockerProject, composeProjectForTrial, findNativeTrialDir, recoverDroppedNativeTrial } from "./terminal-bench-native-salvage.mjs";
import { cleanupSealedExitedHarborEnvironments, isDockerExecTransportFailure, isDockerImagePullFailure, isPreAgentDockerImagePullFailure, isPreAgentDockerSubnetExhaustion } from "./terminal-bench-docker-recovery.mjs";
import { prewarmTerminalBenchTaskCache, terminalBenchTaskQualifiedName } from "./terminal-bench-task-cache.mjs";

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
const serviceTierArg=process.argv.find(arg=>arg.startsWith("--service-tier="));
const SERVICE_TIER=String(serviceTierArg?.slice("--service-tier=".length)||process.env.TREBELL_TERMINAL_BENCH_SERVICE_TIER||"fast").trim().toLowerCase();
if(!["default","fast"].includes(SERVICE_TIER))throw new Error("Terminal-Bench service tier must be default or fast.");
const taskArg=process.argv.find(arg=>arg.startsWith("--task="));
const TASK=String(taskArg?.slice("--task=".length)||process.env.TREBELL_TERMINAL_BENCH_TASK||"terminal-bench/session-window-debug").trim();
const HARBOR_TASK=terminalBenchTaskQualifiedName(DATASET,TASK);
if(!HARBOR_TASK)throw new Error(`Cannot derive Harbor task identity from dataset=${DATASET} task=${TASK}`);
const setupTimeoutArg=process.argv.find(arg=>arg.startsWith("--agent-setup-timeout-multiplier="));
const SETUP_TIMEOUT_MULTIPLIER=Number(setupTimeoutArg?.slice("--agent-setup-timeout-multiplier=".length)||process.env.TREBELL_TERMINAL_BENCH_SETUP_TIMEOUT_MULTIPLIER||3);
if(!Number.isFinite(SETUP_TIMEOUT_MULTIPLIER)||SETUP_TIMEOUT_MULTIPLIER<1)throw new Error("Terminal-Bench setup timeout multiplier must be >= 1.");
const agentTimeoutArg=process.argv.find(arg=>arg.startsWith("--agent-timeout-multiplier="));
const AGENT_TIMEOUT_MULTIPLIER=Number(agentTimeoutArg?.slice("--agent-timeout-multiplier=".length)||process.env.TREBELL_TERMINAL_BENCH_AGENT_TIMEOUT_MULTIPLIER||1);
if(!Number.isFinite(AGENT_TIMEOUT_MULTIPLIER)||AGENT_TIMEOUT_MULTIPLIER<=0)throw new Error("Terminal-Bench agent timeout multiplier must be > 0.");
const sequentialRequested=process.argv.includes("--sequential")||String(process.env.TREBELL_TERMINAL_BENCH_SEQUENTIAL||"").trim()==="1";
const parallelRequested=process.argv.includes("--parallel")||String(process.env.TREBELL_TERMINAL_BENCH_PARALLEL||"").trim()==="1";
if(sequentialRequested&&parallelRequested)throw new Error("Terminal-Bench comparison cannot be both --parallel and --sequential.");
const PARALLEL=!sequentialRequested;
const STANDALONE_NATIVE_RERUN=process.argv.includes("--standalone-native-rerun");
const onlyArg=process.argv.find(arg=>arg.startsWith("--only="));
const inheritedOnly=String(process.env.TREBELL_TERMINAL_BENCH_ONLY||"").trim();
if(!onlyArg&&inheritedOnly)throw new Error("Refusing inherited TREBELL_TERMINAL_BENCH_ONLY for a paid benchmark. Pass --only=<lanes> explicitly so lane selection is recorded in the launch command.");
const only=new Set(String(onlyArg?.slice("--only=".length)||"").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean));
if(STANDALONE_NATIVE_RERUN&&!(only.size===1&&only.has("native")))throw new Error("--standalone-native-rerun requires explicit --only=native.");
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
const NATIVE_CONTEXT_WINDOW=Math.max(1,Math.trunc(Number(process.env.TREBELL_HARBOR_CONTEXT_WINDOW)||272_000));
const NATIVE_COMPACT_THRESHOLD=Math.max(1,Math.trunc(Number(process.env.TREBELL_HARBOR_COMPACT_THRESHOLD)||245_000));
const NATIVE_SALVAGE_WAIT_MS=Math.max(5_000,Math.trunc(Number(process.env.TREBELL_TERMINAL_BENCH_NATIVE_SALVAGE_WAIT_MS)||180_000));
if(NATIVE_COMPACT_THRESHOLD>=NATIVE_CONTEXT_WINDOW)throw new Error("Native Harbor compact threshold must be below its operating context window.");
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

async function trialProcessDrainNeedles(outputRoot,jobName){
  let entries=[];try{entries=await readdir(join(outputRoot,jobName),{withFileTypes:true})}catch{return []}
  return entries.filter(entry=>entry.isDirectory()).map(entry=>entry.name);
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

const gitCommonDir=String(await capture("git",["rev-parse","--git-common-dir"])).trim(),lockPath=STANDALONE_NATIVE_RERUN?sharedTerminalBenchNativeRerunLockPath(root,gitCommonDir):sharedTerminalBenchLockPath(root,gitCommonDir);
const releaseLock=await acquireTerminalBenchPairLock({lockPath,task:TASK,model:MODEL,effort:EFFORT}),runStamp=stamp(),pairId=`${STANDALONE_NATIVE_RERUN?"tb4-native-rerun":"tb4-pair"}-${safeSlug(MODEL)}-${EFFORT}-${SERVICE_TIER}-${safeSlug(TASK)}-${runStamp}`,reportPath=join(validationDir,pairId+".json"),sourceProvenance=await sourceGitProvenance();let codexApiAuthPath=null;
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
  if(SERVICE_TIER==="fast"&&CODEX_INSTALL_MODE!=="pinned")throw new Error("Fast comparison requires the pinned Codex adapter so service_tier=fast is applied identically to Codex API and OAuth lanes.");
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
    TREBELL_HARBOR_CONTEXT_WINDOW:String(NATIVE_CONTEXT_WINDOW),
    TREBELL_HARBOR_COMPACT_THRESHOLD:String(NATIVE_COMPACT_THRESHOLD),
    ...(process.platform==="win32"?{PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8"}:{}),
    ...(nativePinnedNodeTarballPath?{TREBELL_NODE_PINNED_TARBALL:nativePinnedNodeTarballPath}: {}),
    ...(codexPinnedTarballPath?{TREBELL_CODEX_PINNED_TARBALL:codexPinnedTarballPath}: {}),
  },outputRoot=join(root,".harbor-jobs"),jobs=[];
  let taskCachePrewarm=null;
  if(PARALLEL&&selectedLanes.length>1){
    taskCachePrewarm={startedAt:new Date().toISOString(),...(await prewarmTerminalBenchTaskCache({harbor,dataset:DATASET,task:TASK,env:sharedEnv,runFn:run})),finishedAt:new Date().toISOString()};
  }
  const willRunCodexApi=selectedLanes.some(lane=>lane.label==="codex-api"),willRunCodexOauth=selectedLanes.some(lane=>lane.label==="codex-oauth");
  let codexOauthAuthPath=null;
  if(willRunCodexOauth){
    const explicit=String(process.env.TREBELL_CODEX_OAUTH_AUTH_JSON||"").trim();
    const configuredHome=String(process.env.CODEX_HOME||"").trim();
    const candidates=[
      explicit?resolve(explicit):null,
      join(root,".trebell-codex-oauth","auth.json"),
      configuredHome?join(resolve(configuredHome),"auth.json"):null,
    ].filter(Boolean);
    for(const candidate of candidates){try{await access(candidate);codexOauthAuthPath=candidate;break}catch{}}
    if(!codexOauthAuthPath)throw new Error("Trebell-pinned Codex OAuth credentials are unavailable. Copy the intended account auth.json to .trebell-codex-oauth/auth.json, set CODEX_HOME to a Trebell-owned profile, or set TREBELL_CODEX_OAUTH_AUTH_JSON.");
  }
  if(willRunCodexApi){
    const apiKey=String(sharedEnv.OPENAI_API_KEY||"").trim();
    if(!apiKey)throw new Error("OPENAI_API_KEY is required for the Codex API benchmark lane.");
    codexApiAuthPath=join(validationDir,`.codex-api-auth-${process.pid}-${runStamp}.json`);
    await writeFile(codexApiAuthPath,JSON.stringify({OPENAI_API_KEY:apiKey})+"\n",{encoding:"utf8",mode:0o600});
  }
  const laneStates=selectedLanes.map(lane=>({
    label:lane.label,harness:lane.harness,authMode:lane.authMode,
    serviceTier:SERVICE_TIER,
    jobName:`tb4-${lane.label}-${safeSlug(MODEL)}-${EFFORT}-${safeSlug(TASK)}-${runStamp}`,
    status:"pending",startedAt:null,finishedAt:null,runError:null,attempts:[],retryReason:null,retryCleanup:null,infrastructureFailureReason:null,
  }));
  const reportSnapshot=({complete=false}={})=>({
    pairId,dataset:DATASET,task:TASK,model:MODEL,reasoningEffort:EFFORT,serviceTier:SERVICE_TIER,setupTimeoutMultiplier:SETUP_TIMEOUT_MULTIPLIER,agentTimeoutMultiplier:AGENT_TIMEOUT_MULTIPLIER,taskCachePrewarm,
    usesBaseAgentTimeout:AGENT_TIMEOUT_MULTIPLIER===1,
    timeoutComparability:AGENT_TIMEOUT_MULTIPLIER===1?"benchmark-base":"extended-agent-timeout",
    sameModel:true,sameReasoningEffort:true,sameServiceTier:true,sequential:!PARALLEL,parallel:PARALLEL,codexAuthMode:CODEX_AUTH_MODE,codexInstallMode:CODEX_INSTALL_MODE,nativeReasoningContext:NATIVE_REASONING_CONTEXT,
    nativeEnvironmentRetention:STANDALONE_NATIVE_RERUN?"retain-until-sealed-or-regraded":"harbor-default",
    nativeContextPolicy:{operatingContextWindow:NATIVE_CONTEXT_WINDOW,serverCompactionThreshold:NATIVE_COMPACT_THRESHOLD,retroactiveOpenAiReadCooling:false},
    ...sourceProvenance,
    ...(nativePinnedNodeTarballPath?{nativePinnedNodeVersion:NATIVE_PINNED_NODE_VERSION,nativePinnedNodeTarballSha256}:{}),
    ...(codexPinnedTarballPath?{codexPinnedVersion:CODEX_PINNED_VERSION,codexPinnedTarballSha256,codexPinnedAdapterSha256}:{}),
    comparisonLanes:selectedLanes.map(lane=>lane.label),configuredComparisonLanes:lanes.map(lane=>lane.label),nativeBundleSha256,nativeAdapterSha256,
    pricingSnapshot:MODEL==="gpt-6-luna"?gpt6LunaPricingForServiceTier(SERVICE_TIER):null,
    complete,
    infrastructureInterrupted:jobs.filter(Boolean).some(job=>Boolean(job.infrastructureFailureReason)),
    infrastructureComparable:complete?!jobs.filter(Boolean).some(job=>Boolean(job.infrastructureFailureReason)):null,
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
  const latestPointerPath=join(validationDir,STANDALONE_NATIVE_RERUN?"terminal-bench-native-rerun-latest.json":"terminal-bench-latest.json");
  const persistLatestPointer=()=>writeFile(latestPointerPath,JSON.stringify({pairId,reportPath,task:TASK,model:MODEL,reasoningEffort:EFFORT,serviceTier:SERVICE_TIER,parallel:PARALLEL,lanes:laneStates.map(lane=>({label:lane.label,jobName:lane.jobName}))},null,2)+"\n","utf8");
  await persistLatestPointer();
  await persistReport({complete:false});
  const runLane=async(lane,laneIndex)=>{
    const {label,harness,authMode}=lane;
    const agent=harness==="native"?"benchmarks.harbor.trebell_native_agent:TrebellNativeAgent":CODEX_INSTALL_MODE==="pinned"?"benchmarks.harbor.pinned_codex_agent:PinnedCodexAgent":"codex";
    const laneState=laneStates[laneIndex];let jobName=laneState.jobName;
    const argsForJob=currentJobName=>["run","-d",DATASET,"-i",HARBOR_TASK,"-a",agent,"-m",`openai/${MODEL}`,"--ak",`reasoning_effort=${EFFORT}`,...(SERVICE_TIER==="fast"?["--ak","service_tier=fast"]:[]),"-n","1","-o",outputRoot,"--job-name",currentJobName,"-y"];
    let args=argsForJob(jobName);
    const retainNativeEnvironment=STANDALONE_NATIVE_RERUN&&harness==="native";
    if(retainNativeEnvironment)args.push("--no-delete");
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
      if(authMode==="oauth")harnessEnv.CODEX_AUTH_JSON_PATH=codexOauthAuthPath;
      else harnessEnv.CODEX_AUTH_JSON_PATH=codexApiAuthPath;
    }
    laneState.status="running";laneState.startedAt=new Date().toISOString();await persistReport({complete:false});
    let runError=null,runnerError=null,regradeRecovery=null;
    try{await run(harbor,args,{env:harnessEnv})}catch(error){runnerError=error?.message||String(error);runError=runnerError}
    const failedTrial=await trialResult(outputRoot,jobName),preTrialRunnerFailure=Boolean(runnerError)&&!failedTrial;
    const subnetExhaustion=isPreAgentDockerSubnetExhaustion(failedTrial),imagePullFailure=isPreAgentDockerImagePullFailure(failedTrial),dockerExecTransportFailure=isDockerExecTransportFailure(failedTrial);
    laneState.attempts.push({jobName,status:runnerError||subnetExhaustion||imagePullFailure||dockerExecTransportFailure?"failed":"finished",runnerError,trialInfrastructureFailure:preTrialRunnerFailure?"pre_trial_runner_failure":subnetExhaustion?"docker_subnet_exhaustion":imagePullFailure?"docker_image_pull_failure":dockerExecTransportFailure?"docker_exec_transport_failure":null});
    if(dockerExecTransportFailure)laneState.infrastructureFailureReason="docker_exec_transport_failure";
    if(subnetExhaustion||imagePullFailure||preTrialRunnerFailure){
        let cleanup;
        try{
          cleanup=await cleanupSealedExitedHarborEnvironments(outputRoot,{
            captureFn:(command,argv)=>capture(command,argv,{env:harnessEnv}),
            runFn:(command,argv)=>run(command,argv,{env:harnessEnv}),
          });
        }catch(error){
          cleanup={eligibleProjects:null,removedContainers:0,removedNetworks:0,projects:[],error:String(error?.message||error)};
        }
        const retryJobName=jobName+"-retry1";
        laneState.retryReason=preTrialRunnerFailure?"pre_trial_runner_failure":subnetExhaustion?"docker_subnet_exhaustion":"docker_image_pull_failure";laneState.retryCleanup=cleanup;laneState.jobName=retryJobName;jobName=retryJobName;
        args=argsForJob(jobName);
        if(retainNativeEnvironment)args.push("--no-delete");
        if(SETUP_TIMEOUT_MULTIPLIER>1)args.push("--agent-setup-timeout-multiplier",String(SETUP_TIMEOUT_MULTIPLIER));
        if(AGENT_TIMEOUT_MULTIPLIER!==1)args.push("--agent-timeout-multiplier",String(AGENT_TIMEOUT_MULTIPLIER));
        runnerError=null;runError=null;await persistLatestPointer();await persistReport({complete:false});
        try{await run(harbor,args,{env:harnessEnv})}catch(error){runnerError=error?.message||String(error);runError=runnerError}
        const retryTrial=await trialResult(outputRoot,jobName),retryPreTrialRunnerFailure=Boolean(runnerError)&&!retryTrial,retrySubnetExhaustion=isPreAgentDockerSubnetExhaustion(retryTrial),retryImagePullFailure=isPreAgentDockerImagePullFailure(retryTrial),retryDockerExecTransportFailure=isDockerExecTransportFailure(retryTrial);
        laneState.attempts.push({jobName,status:runnerError||retrySubnetExhaustion||retryImagePullFailure||retryDockerExecTransportFailure?"failed":"finished",runnerError,trialInfrastructureFailure:retryPreTrialRunnerFailure?"pre_trial_runner_failure":retrySubnetExhaustion?"docker_subnet_exhaustion":retryImagePullFailure?"docker_image_pull_failure":retryDockerExecTransportFailure?"docker_exec_transport_failure":null});
        if(retryPreTrialRunnerFailure)laneState.infrastructureFailureReason="pre_trial_runner_failure";
        else if(retrySubnetExhaustion)laneState.infrastructureFailureReason="docker_subnet_exhaustion";
        else if(retryImagePullFailure)laneState.infrastructureFailureReason="docker_image_pull_failure";
        else if(retryDockerExecTransportFailure)laneState.infrastructureFailureReason="docker_exec_transport_failure";
    }
    let drainError=null;
    try{
      const additionalNeedles=await trialProcessDrainNeedles(outputRoot,jobName);
      await waitForJobProcessDrain(jobName,{timeoutMs:LANE_DRAIN_TIMEOUT_MS,cwd:root,additionalNeedles});
    }catch(error){drainError=error?.message||String(error);runError=[runError,drainError].filter(Boolean).join("; ")}
    if(retainNativeEnvironment&&runnerError){
      let alreadyGraded=null;try{alreadyGraded=await trialResult(outputRoot,jobName)}catch{}
      if(!alreadyGraded?.verifier_result){
        regradeRecovery=await recoverDroppedNativeTrial({
          outputRoot,jobName,harbor,validationDir,home:homedir(),waitTimeoutMs:NATIVE_SALVAGE_WAIT_MS,
          captureFn:(command,args)=>capture(command,args,{env:harnessEnv}),
          runFn:(command,args)=>run(command,args,{env:harnessEnv}),
        });
        if(regradeRecovery.ok)runError=null;
        else runError=[runError,`Native salvage/regrade failed: ${regradeRecovery.reason||"unknown recovery failure"}`].filter(Boolean).join("; ");
      }
    }
    try{
      let result=null;
      try{result=JSON.parse(await readFile(join(outputRoot,jobName,"result.json"),"utf8"))}catch{}
      const recordedTrial=await trialResult(outputRoot,jobName),trial=regradeRecovery?.ok&&regradeRecovery.regrade?.result?regradeRecovery.regrade.result:recordedTrial||await recoverTrialEvidence(outputRoot,jobName);
      const infrastructureFailureReason=isDockerExecTransportFailure(trial)?"docker_exec_transport_failure":isPreAgentDockerSubnetExhaustion(trial)?"docker_subnet_exhaustion":isDockerImagePullFailure(trial)?"docker_image_pull_failure":laneState.infrastructureFailureReason;
      laneState.infrastructureFailureReason=infrastructureFailureReason||null;
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
      const apiEquivalentCostBreakdown=MODEL==="gpt-6-luna"&&recoveredEvidence?.apiEquivalentCostBreakdown&&SERVICE_TIER!=="fast"
        ?recoveredEvidence.apiEquivalentCostBreakdown
        :MODEL==="gpt-6-luna"&&inputTokens!=null&&cachedTokens!=null
          ?estimateGpt6LunaCostFromAggregate({inputTokens,cachedInputTokens:cachedTokens,cacheWriteInputTokens:trebellNative?.cache_write_input_tokens??recoveredEvidence?.cacheWriteInputTokens??0,outputTokens:outputMetric.value??0},{maxObservedInputTokens:recoveredEvidence?.maxObservedInputTokens??null,serviceTier:SERVICE_TIER})
          :null;
      jobs[laneIndex]={
        harness,label,agent,jobName,runError,runnerError,drainError,authMode,serviceTier:SERVICE_TIER,
        infrastructureFailureReason:infrastructureFailureReason||null,
        completed:regradeRecovery?.ok?1:Number(result?.stats?.n_completed_trials||0),errors:regradeRecovery?.ok?0:Number(result?.stats?.n_errored_trials||0),
        inputTokens,cachedTokens,uncachedInputTokens,cacheHitPercent,
        outputTokens:outputMetric.value,
        costUsd:result?.stats?.cost_usd??trial?.agent_result?.cost_usd??null,
        apiEquivalentCostUsd:apiEquivalentCostBreakdown?.totalUsd??null,
        apiEquivalentCostBreakdown,
        reward:trial?.verifier_result?.rewards?.reward??null,taskChecksum:trial?.task_checksum??null,
        agentVersion:trial?.agent_info?.version??null,
        setupMs:elapsedMs(trial?.agent_setup),agentExecutionMs:elapsedMs(trial?.agent_execution),verifierMs:elapsedMs(trial?.verifier),
        ...(trebellNative?{modelTurns:trebellNative.model_turns??recoveredNative?.modelTurns??null,toolCalls:trebellNative.tool_calls??recoveredNative?.toolCalls??null,providerRequests:trebellNative.provider_requests??null,effectiveServiceTiers:trebellNative.effective_service_tiers??[],reasoningContext:trebellNative.reasoning_context??null,effectiveReasoningContexts:trebellNative.effective_reasoning_contexts??[],reasoningOutputTokens:trebellNative.reasoning_output_tokens??recoveredNative?.reasoningOutputTokens??null,cacheWriteInputTokens:trebellNative.cache_write_input_tokens??recoveredNative?.cacheWriteInputTokens??null,cacheCarryover:trebellNative.cache_carryover??null,strategy:trebellNative.strategy??null,budgets:trebellNative.budgets??null,contextPolicy:trebellNative.context_policy??null}:recoveredNative?{modelTurns:recoveredNative.modelTurns,toolCalls:recoveredNative.toolCalls,reasoningOutputTokens:recoveredNative.reasoningOutputTokens,cacheWriteInputTokens:recoveredNative.cacheWriteInputTokens}:{}),
        exceptionType:trial?.exception_info?.exception_type??null,exceptionMessage:trial?.exception_info?.exception_message??null,
        recoveredFromTrialFiles:trial?.recovered_from_trial_files===true,
        recoveredFromNativeEvents,
        recoveredFromCodexSessions:Boolean(recoveredCodex),
        recoveredByRegrade:regradeRecovery?.ok===true,
        regradeTrialDir:regradeRecovery?.ok?regradeRecovery.regrade?.regradeTrialDir||null:null,
        evals:result?.stats?.evals||{},
      };
    }catch(error){
      const recoveryError=`lane evidence recovery failed: ${error?.message||String(error)}`;runError=[runError,recoveryError].filter(Boolean).join("; ");
      jobs[laneIndex]={harness,label,agent,jobName,runError,authMode,completed:0,errors:1,inputTokens:null,cachedTokens:null,uncachedInputTokens:null,cacheHitPercent:null,outputTokens:null,costUsd:null,apiEquivalentCostUsd:null,apiEquivalentCostBreakdown:null,reward:null,taskChecksum:null,agentVersion:null,setupMs:null,agentExecutionMs:null,verifierMs:null,exceptionType:"LaneEvidenceRecoveryError",exceptionMessage:recoveryError,recoveredFromTrialFiles:false,recoveredFromNativeEvents:false,recoveredFromCodexSessions:false,evals:{}};
    }
    if(retainNativeEnvironment&&!runError&&Number(jobs[laneIndex]?.completed||0)>=1){
      const trialDir=regradeRecovery?.trialDir||await findNativeTrialDir(outputRoot,jobName);
      const project=composeProjectForTrial(trialDir);
      if(project)await cleanupDockerProject(project,{captureFn:(command,args)=>capture(command,args,{env:harnessEnv}),runFn:(command,args)=>run(command,args,{env:harnessEnv})});
    }
    const laneFailed=Boolean(runError)||Number(jobs[laneIndex]?.errors||0)>0||Number(jobs[laneIndex]?.completed||0)<1;
    laneState.status=jobs[laneIndex]?.infrastructureFailureReason?"infrastructure-failed":laneFailed?"failed":"finished";laneState.finishedAt=new Date().toISOString();laneState.runError=runError;
    await persistReport({complete:false});
  };
  if(PARALLEL)await Promise.all(selectedLanes.map((lane,index)=>runLane(lane,index)));
  else for(let index=0;index<selectedLanes.length;index++)await runLane(selectedLanes[index],index);
  // Keep verifier internals sealed while comparison lanes are still running.
  // Only after every lane has finished do we read generic CTRF pass/fail totals
  // and attach them to the final report for correctness-first comparison.
  for(const job of jobs.filter(Boolean)){
    try{job.verifierChecks=job.regradeTrialDir?await readTrialVerifierSummary(job.regradeTrialDir):await readJobVerifierSummary(outputRoot,job.jobName)}
    catch(error){const verifierError=`verifier summary recovery failed: ${error?.message||String(error)}`;job.runError=[job.runError,verifierError].filter(Boolean).join("; ");job.verifierChecks=null}
  }
  const report=reportSnapshot({complete:true});await writeFile(reportPath,JSON.stringify(report,null,2)+"\n","utf8");
  console.log("TREBELL_TERMINAL_BENCH_REPORT "+JSON.stringify({...report,reportPath},null,2));
  if(jobs.filter(Boolean).some(job=>job.runError||job.errors>0||job.completed<1)||jobs.filter(Boolean).length!==selectedLanes.length)process.exitCode=1;
}finally{if(codexApiAuthPath)await rm(codexApiAuthPath,{force:true}).catch(()=>{});await releaseLock()}
