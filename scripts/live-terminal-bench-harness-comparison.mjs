import { access, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if(!process.argv.includes("--live"))throw new Error("Refusing to run paid/live Terminal-Bench without --live.");

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,"..");
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
function elapsedMs(range){const start=Date.parse(String(range?.started_at||"")),end=Date.parse(String(range?.finished_at||""));return Number.isFinite(start)&&Number.isFinite(end)?Math.max(0,end-start):null}
function processAlive(pid){try{process.kill(Number(pid),0);return true}catch(error){return error?.code==="EPERM"}}
async function acquirePairLock(){
  await mkdir(validationDir,{recursive:true});
  for(let attempt=0;attempt<2;attempt++){
    try{
      const handle=await open(lockPath,"wx");
      await handle.writeFile(JSON.stringify({pid:process.pid,task:TASK,model:MODEL,effort:EFFORT,startedAt:new Date().toISOString()})+"\n");
      await handle.close();
      return async()=>{try{await rm(lockPath,{force:true})}catch{}};
    }catch(error){
      if(error?.code!=="EEXIST")throw error;
      let existing=null;try{existing=JSON.parse(await readFile(lockPath,"utf8"))}catch{}
      if(existing?.pid&&processAlive(existing.pid))throw new Error(`Another Terminal-Bench paired run is active (pid ${existing.pid}, task ${existing.task||"unknown"}). Refusing to contaminate benchmark timing.`);
      await rm(lockPath,{force:true});
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

const releaseLock=await acquirePairLock(),runStamp=stamp(),pairId=`tb4-pair-${safeSlug(MODEL)}-${EFFORT}-${safeSlug(TASK)}-${runStamp}`,reportPath=join(validationDir,pairId+".json");
try{
  await run(process.execPath,[join(root,"scripts","build-harbor-native-agent.mjs")]);
  const nativeBundlePath=join(root,"benchmarks","harbor","dist","trebell-native-agent.mjs"),nativeAdapterPath=join(root,"benchmarks","harbor","trebell_native_agent.py");
  const nativeBundleSha256=await sha256File(nativeBundlePath),nativeAdapterSha256=await sha256File(nativeAdapterPath);
  const harbor=await harborBin(),pythonPath=[root,process.env.PYTHONPATH].filter(Boolean).join(delimiter);
  const sharedEnv={...process.env,PYTHONPATH:pythonPath},outputRoot=join(root,".harbor-jobs"),jobs=[];
  const reportSnapshot=({complete=false,activeHarness=null,activeJobName=null}={})=>({
    pairId,dataset:DATASET,task:TASK,model:MODEL,reasoningEffort:EFFORT,setupTimeoutMultiplier:SETUP_TIMEOUT_MULTIPLIER,
    sameModel:true,sameReasoningEffort:true,sequential:true,nativeBundleSha256,nativeAdapterSha256,
    complete,activeHarness,activeJobName,updatedAt:new Date().toISOString(),jobs,
  });
  const persistReport=async state=>writeFile(reportPath,JSON.stringify(reportSnapshot(state),null,2)+"\n","utf8");
  for(const harness of ["native","codex"]){
    if(only.size&&!only.has(harness))continue;
    const agent=harness==="native"?"benchmarks.harbor.trebell_native_agent:TrebellNativeAgent":"codex";
    const jobName=`tb4-${harness}-${safeSlug(MODEL)}-${EFFORT}-${safeSlug(TASK)}-${runStamp}`;
    const args=["run","-d",DATASET,"-i",TASK,"-a",agent,"-m",`openai/${MODEL}`,"--ak",`reasoning_effort=${EFFORT}`,"-n","1","-o",outputRoot,"--job-name",jobName,"-y"];
    if(SETUP_TIMEOUT_MULTIPLIER>1)args.push("--agent-setup-timeout-multiplier",String(SETUP_TIMEOUT_MULTIPLIER));
    await persistReport({complete:false,activeHarness:harness,activeJobName:jobName});
    let runError=null;
    try{await run(harbor,args,{env:sharedEnv})}catch(error){runError=error?.message||String(error)}
    let result=null;
    try{result=JSON.parse(await readFile(join(outputRoot,jobName,"result.json"),"utf8"))}catch{}
    const trial=await trialResult(outputRoot,jobName);
    const inputTokens=result?.stats?.n_input_tokens??trial?.agent_result?.n_input_tokens??null;
    const cachedTokens=result?.stats?.n_cache_tokens??trial?.agent_result?.n_cache_tokens??null;
    const uncachedInputTokens=inputTokens==null||cachedTokens==null?null:Math.max(0,Number(inputTokens)-Number(cachedTokens));
    const cacheHitPercent=inputTokens==null||Number(inputTokens)<=0||cachedTokens==null?null:Number(((Number(cachedTokens)/Number(inputTokens))*100).toFixed(2));
    const trebellNative=trial?.agent_result?.metadata?.trebell_native||null;
    jobs.push({
      harness,agent,jobName,runError,
      completed:Number(result?.stats?.n_completed_trials||0),errors:Number(result?.stats?.n_errored_trials||0),
      inputTokens,cachedTokens,uncachedInputTokens,cacheHitPercent,
      outputTokens:result?.stats?.n_output_tokens??trial?.agent_result?.n_output_tokens??null,
      costUsd:result?.stats?.cost_usd??trial?.agent_result?.cost_usd??null,
      reward:trial?.verifier_result?.rewards?.reward??null,taskChecksum:trial?.task_checksum??null,
      agentVersion:trial?.agent_info?.version??null,
      setupMs:elapsedMs(trial?.agent_setup),agentExecutionMs:elapsedMs(trial?.agent_execution),verifierMs:elapsedMs(trial?.verifier),
      ...(trebellNative?{modelTurns:trebellNative.model_turns??null,toolCalls:trebellNative.tool_calls??null,providerRequests:trebellNative.provider_requests??null,reasoningOutputTokens:trebellNative.reasoning_output_tokens??null,cacheWriteInputTokens:trebellNative.cache_write_input_tokens??null,budgets:trebellNative.budgets??null}:{}),
      exceptionType:trial?.exception_info?.exception_type??null,exceptionMessage:trial?.exception_info?.exception_message??null,
      evals:result?.stats?.evals||{},
    });
    await persistReport({complete:false,activeHarness:null,activeJobName:null});
  }
  const report=reportSnapshot({complete:true,activeHarness:null,activeJobName:null});await writeFile(reportPath,JSON.stringify(report,null,2)+"\n","utf8");
  console.log("TREBELL_TERMINAL_BENCH_REPORT "+JSON.stringify({...report,reportPath},null,2));
  if(jobs.some(job=>job.runError||job.errors>0||job.completed<1))process.exitCode=1;
}finally{await releaseLock()}
