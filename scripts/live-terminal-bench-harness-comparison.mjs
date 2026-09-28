import { access, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

if(!process.argv.includes("--live"))throw new Error("Refusing to run paid/live Terminal-Bench without --live.");

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,"..");
try{loadEnvFile(join(root,".env"))}catch(error){if(error?.code!=="ENOENT")throw error}
const DATASET=String(process.env.TREBELL_TERMINAL_BENCH_DATASET||"terminal-bench/terminal-bench@4.0.0").trim();
const MODEL=String(process.env.TREBELL_TERMINAL_BENCH_MODEL||"gpt-6-luna").trim();
const EFFORT=String(process.env.TREBELL_TERMINAL_BENCH_REASONING_EFFORT||"max").trim().toLowerCase();
const taskArg=process.argv.find(arg=>arg.startsWith("--task="));
const TASK=String(taskArg?.slice("--task=".length)||process.env.TREBELL_TERMINAL_BENCH_TASK||"terminal-bench/session-window-debug").trim();
const setupTimeoutArg=process.argv.find(arg=>arg.startsWith("--agent-setup-timeout-multiplier="));
const SETUP_TIMEOUT_MULTIPLIER=Number(setupTimeoutArg?.slice("--agent-setup-timeout-multiplier=".length)||process.env.TREBELL_TERMINAL_BENCH_SETUP_TIMEOUT_MULTIPLIER||3);
if(!Number.isFinite(SETUP_TIMEOUT_MULTIPLIER)||SETUP_TIMEOUT_MULTIPLIER<1)throw new Error("Terminal-Bench setup timeout multiplier must be >= 1.");
const onlyArg=process.argv.find(arg=>arg.startsWith("--only="));
const only=new Set(String(onlyArg?.slice("--only=".length)||process.env.TREBELL_TERMINAL_BENCH_ONLY||"").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean));
const codexAuthArg=process.argv.find(arg=>arg.startsWith("--codex-auth="));
const CODEX_AUTH_MODE=String(codexAuthArg?.slice("--codex-auth=".length)||process.env.TREBELL_TERMINAL_BENCH_CODEX_AUTH||"both").trim().toLowerCase();
if(!["api","oauth","both"].includes(CODEX_AUTH_MODE))throw new Error("Terminal-Bench Codex auth mode must be api, oauth, or both.");
const CODEX_AUTH_MODES=CODEX_AUTH_MODE==="both"?["api","oauth"]:[CODEX_AUTH_MODE];
const codexInstallArg=process.argv.find(arg=>arg.startsWith("--codex-install="));
const CODEX_INSTALL_MODE=String(codexInstallArg?.slice("--codex-install=".length)||process.env.TREBELL_TERMINAL_BENCH_CODEX_INSTALL||"pinned").trim().toLowerCase();
if(!["stock","pinned"].includes(CODEX_INSTALL_MODE))throw new Error("Terminal-Bench Codex install mode must be stock or pinned.");
const CODEX_PINNED_VERSION="0.158.0";
const CODEX_PINNED_TARBALL_SHA256="3fe84106aaf2fbfc13299068510d34b3d0157eeb9af4b37be8cf5416f485a6bb";
const validationDir=join(root,".harbor-validation"),lockPath=join(validationDir,"terminal-bench-pair.lock");

function run(command,args,{env=process.env}={}){
  return new Promise((resolveRun,reject)=>{
    const child=spawn(command,args,{cwd:root,env,stdio:"inherit",windowsHide:true});
    child.once("error",reject);
    child.once("exit",(code,signal)=>code===0?resolveRun({code:0}):reject(Object.assign(new Error(`${command} exited with ${signal||code}`),{code,signal})));
  });
}

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
  const npmCli=String(process.env.npm_execpath||"").trim(),args=["pack",`@openai/codex@${CODEX_PINNED_VERSION}-linux-x64`,"--pack-destination",dirname(path)];
  if(npmCli)await run(process.execPath,[npmCli,...args]);
  else await run(process.platform==="win32"?"npm.cmd":"npm",args);
  await access(path);
}
function elapsedMs(range){const start=Date.parse(String(range?.started_at||"")),end=Date.parse(String(range?.finished_at||""));return Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,end-start):null}
function processAlive(pid){try{process.kill(Number(pid),0);return true}catch(error){return error?.code==="EPERM"}}
function lockIdentity(value){
  if(value?.lockId)return `id:${value.lockId}`;
  if(value&&typeof value==="object")return `legacy:${value.pid||""}:${value.startedAt||""}:${value.task||""}`;
  return "missing";
}
async function readPairLock(){try{return JSON.parse(await readFile(lockPath,"utf8"))}catch{return null}}
async function acquirePairLock(){
  await mkdir(validationDir,{recursive:true});
  const lockId=randomUUID(),lockRecord={lockId,pid:process.pid,task:TASK,model:MODEL,effort:EFFORT,startedAt:new Date().toISOString()};
  for(let attempt=0;attempt<6;attempt++){
    try{
      const handle=await open(lockPath,"wx");
      await handle.writeFile(JSON.stringify(lockRecord)+"\n");
      await handle.close();
      return async()=>{
        try{
          const current=await readPairLock();
          if(current?.lockId===lockId)await rm(lockPath,{force:true});
        }catch{}
      };
    }catch(error){
      if(error?.code!=="EEXIST")throw error;
      const existing=await readPairLock();
      if(existing?.pid&&processAlive(existing.pid))throw new Error(`Another Terminal-Bench paired run is active (pid ${existing.pid}, task ${existing.task||"unknown"}). Refusing to contaminate benchmark timing.`);
      // A stale-lock cleanup must not delete a lock another contender created
      // after our first read. Re-read and compare the owner identity immediately
      // before unlinking; if it changed, loop and evaluate the new owner instead.
      const current=await readPairLock();
      if(lockIdentity(current)!==lockIdentity(existing))continue;
      try{await rm(lockPath)}catch(removeError){if(removeError?.code!=="ENOENT")throw removeError}
    }
  }
  throw new Error("Could not acquire the Terminal-Bench paired-run lock.");
}
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

const releaseLock=await acquirePairLock(),runStamp=stamp(),pairId=`tb4-pair-${safeSlug(MODEL)}-${EFFORT}-${safeSlug(TASK)}-${runStamp}`,reportPath=join(validationDir,pairId+".json");let codexApiAuthPath=null;
try{
  await run(process.execPath,[join(root,"scripts","build-harbor-native-agent.mjs")]);
  const nativeBundlePath=join(root,"benchmarks","harbor","dist","trebell-native-agent.mjs"),nativeAdapterPath=join(root,"benchmarks","harbor","trebell_native_agent.py");
  const nativeBundleSha256=await sha256File(nativeBundlePath),nativeAdapterSha256=await sha256File(nativeAdapterPath);
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
  const sharedEnv={...process.env,PYTHONPATH:pythonPath,...(codexPinnedTarballPath?{TREBELL_CODEX_PINNED_TARBALL:codexPinnedTarballPath}: {})},outputRoot=join(root,".harbor-jobs"),jobs=[];
  const codexLaneSelected=authMode=>!only.size||only.has("codex")||only.has(`codex-${authMode}`);
  const willRunCodexApi=CODEX_AUTH_MODES.includes("api")&&codexLaneSelected("api"),willRunCodexOauth=CODEX_AUTH_MODES.includes("oauth")&&codexLaneSelected("oauth");
  if(willRunCodexOauth)await access(join(homedir(),".codex","auth.json"));
  if(willRunCodexApi){
    const apiKey=String(sharedEnv.OPENAI_API_KEY||"").trim();
    if(!apiKey)throw new Error("OPENAI_API_KEY is required for the Codex API benchmark lane.");
    codexApiAuthPath=join(validationDir,`.codex-api-auth-${process.pid}-${runStamp}.json`);
    await writeFile(codexApiAuthPath,JSON.stringify({OPENAI_API_KEY:apiKey})+"\n",{encoding:"utf8",mode:0o600});
  }
  const lanes=[
    {label:"native",harness:"native",authMode:"api"},
    ...CODEX_AUTH_MODES.map(authMode=>({label:`codex-${authMode}`,harness:"codex",authMode})),
  ];
  const reportSnapshot=({complete=false,activeHarness=null,activeJobName=null}={})=>({
    pairId,dataset:DATASET,task:TASK,model:MODEL,reasoningEffort:EFFORT,setupTimeoutMultiplier:SETUP_TIMEOUT_MULTIPLIER,
    sameModel:true,sameReasoningEffort:true,sequential:true,codexAuthMode:CODEX_AUTH_MODE,codexInstallMode:CODEX_INSTALL_MODE,
    ...(codexPinnedTarballPath?{codexPinnedVersion:CODEX_PINNED_VERSION,codexPinnedTarballSha256,codexPinnedAdapterSha256}:{}),
    comparisonLanes:lanes.map(lane=>lane.label),nativeBundleSha256,nativeAdapterSha256,
    complete,activeHarness,activeJobName,updatedAt:new Date().toISOString(),jobs,
  });
  const persistReport=async state=>writeFile(reportPath,JSON.stringify(reportSnapshot(state),null,2)+"\n","utf8");
  for(const lane of lanes){
    const {label,harness,authMode}=lane;
    if(only.size&&!only.has(label)&&!only.has(harness))continue;
    const agent=harness==="native"?"benchmarks.harbor.trebell_native_agent:TrebellNativeAgent":CODEX_INSTALL_MODE==="pinned"?"benchmarks.harbor.pinned_codex_agent:PinnedCodexAgent":"codex";
    const jobName=`tb4-${label}-${safeSlug(MODEL)}-${EFFORT}-${safeSlug(TASK)}-${runStamp}`;
    const args=["run","-d",DATASET,"-i",TASK,"-a",agent,"-m",`openai/${MODEL}`,"--ak",`reasoning_effort=${EFFORT}`,"-n","1","-o",outputRoot,"--job-name",jobName,"-y"];
    if(SETUP_TIMEOUT_MULTIPLIER>1)args.push("--agent-setup-timeout-multiplier",String(SETUP_TIMEOUT_MULTIPLIER));
    const harnessEnv={...sharedEnv};
    if(harness==="codex"){
      delete harnessEnv.CODEX_AUTH_JSON_PATH;
      delete harnessEnv.CODEX_FORCE_AUTH_JSON;
      delete harnessEnv.OPENAI_API_KEY;
      if(authMode==="oauth")harnessEnv.CODEX_FORCE_AUTH_JSON="1";
      else harnessEnv.CODEX_AUTH_JSON_PATH=codexApiAuthPath;
    }
    await persistReport({complete:false,activeHarness:label,activeJobName:jobName});
    let runError=null;
    try{await run(harbor,args,{env:harnessEnv})}catch(error){runError=error?.message||String(error)}
    let result=null;
    try{result=JSON.parse(await readFile(join(outputRoot,jobName,"result.json"),"utf8"))}catch{}
    const recordedTrial=await trialResult(outputRoot,jobName),trial=recordedTrial||await recoverTrialEvidence(outputRoot,jobName);
    const inputTokens=result?.stats?.n_input_tokens??trial?.agent_result?.n_input_tokens??null;
    const cachedTokens=result?.stats?.n_cache_tokens??trial?.agent_result?.n_cache_tokens??null;
    const uncachedInputTokens=inputTokens==null||cachedTokens==null?null:Math.max(0,Number(inputTokens)-Number(cachedTokens));
    const cacheHitPercent=inputTokens==null||Number(inputTokens)<=0||cachedTokens==null?null:Number(((Number(cachedTokens)/Number(inputTokens))*100).toFixed(2));
    const trebellNative=trial?.agent_result?.metadata?.trebell_native||null;
    jobs.push({
      harness,label,agent,jobName,runError,authMode,
      completed:Number(result?.stats?.n_completed_trials||0),errors:Number(result?.stats?.n_errored_trials||0),
      inputTokens,cachedTokens,uncachedInputTokens,cacheHitPercent,
      outputTokens:result?.stats?.n_output_tokens??trial?.agent_result?.n_output_tokens??null,
      costUsd:result?.stats?.cost_usd??trial?.agent_result?.cost_usd??null,
      reward:trial?.verifier_result?.rewards?.reward??null,taskChecksum:trial?.task_checksum??null,
      agentVersion:trial?.agent_info?.version??null,
      setupMs:elapsedMs(trial?.agent_setup),agentExecutionMs:elapsedMs(trial?.agent_execution),verifierMs:elapsedMs(trial?.verifier),
      ...(trebellNative?{modelTurns:trebellNative.model_turns??null,toolCalls:trebellNative.tool_calls??null,providerRequests:trebellNative.provider_requests??null,reasoningOutputTokens:trebellNative.reasoning_output_tokens??null,cacheWriteInputTokens:trebellNative.cache_write_input_tokens??null,budgets:trebellNative.budgets??null}:{}),
      exceptionType:trial?.exception_info?.exception_type??null,exceptionMessage:trial?.exception_info?.exception_message??null,
      recoveredFromTrialFiles:trial?.recovered_from_trial_files===true,
      evals:result?.stats?.evals||{},
    });
    await persistReport({complete:false,activeHarness:null,activeJobName:null});
  }
  const report=reportSnapshot({complete:true,activeHarness:null,activeJobName:null});await writeFile(reportPath,JSON.stringify(report,null,2)+"\n","utf8");
  console.log("TREBELL_TERMINAL_BENCH_REPORT "+JSON.stringify({...report,reportPath},null,2));
  if(jobs.some(job=>job.runError||job.errors>0||job.completed<1))process.exitCode=1;
}finally{if(codexApiAuthPath)await rm(codexApiAuthPath,{force:true}).catch(()=>{});await releaseLock()}
