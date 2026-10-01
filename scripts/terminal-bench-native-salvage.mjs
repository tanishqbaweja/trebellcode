import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const TERMINAL_EVENT_NAMES=new Set(["native.turn.completed","native.turn.blocked"]);

function jsonRows(text){
  const rows=[];
  for(const line of String(text||"").split(/\r?\n/)){
    if(!line.trim())continue;
    try{rows.push(JSON.parse(line))}catch{}
  }
  return rows;
}

export function nativeTerminalEvent(text){
  return jsonRows(text).findLast(event=>TERMINAL_EVENT_NAMES.has(String(event?.name||"")))||null;
}

export async function findNativeTrialDir(outputRoot,jobName,{readdirFn=readdir}={}){
  const jobDir=join(outputRoot,jobName);
  let entries=[];try{entries=await readdirFn(jobDir,{withFileTypes:true})}catch{return null}
  const dirs=entries.filter(entry=>entry?.isDirectory?.()).map(entry=>entry.name);
  return dirs.length===1?join(jobDir,dirs[0]):null;
}

export async function waitForNativeTerminalEvent(trialDir,{timeoutMs=180_000,pollMs=1_000,readFileFn=readFile,sleepFn=ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms)),nowFn=Date.now}={}){
  if(!trialDir)return null;
  const eventsPath=join(trialDir,"agent","trebell-native-events.jsonl"),started=nowFn();
  while(nowFn()-started<=timeoutMs){
    try{const event=nativeTerminalEvent(await readFileFn(eventsPath,"utf8"));if(event)return event}catch{}
    if(nowFn()-started>=timeoutMs)break;
    await sleepFn(Math.min(pollMs,Math.max(0,timeoutMs-(nowFn()-started))));
  }
  return null;
}

export function composeProjectForTrial(trialDir){
  const trialName=basename(String(trialDir||"").replace(/[\\/]+$/,"")).trim();
  return trialName?`${trialName.toLowerCase()}__env`:null;
}

export function cachedTaskPathFromLock(lock,{home}={}){
  const name=String(lock?.task?.name||"").trim(),digest=String(lock?.task?.digest||"").replace(/^sha256:/,"").trim();
  const parts=name.split("/").map(part=>part.trim()).filter(Boolean);
  if(parts.length<2||!digest||!home)return null;
  return join(home,".cache","harbor","tasks","packages",parts[0],...parts.slice(1),digest);
}

export function nativeArtifactManifest(){
  return [
    {source:"/logs/artifacts",destination:"artifacts/logs/artifacts",type:"directory",status:"empty",service:null,exclude:[]},
    {source:"/app/output/model.safetensors",destination:"artifacts/app/output/model.safetensors",type:"file",status:"ok",service:null,exclude:[]},
  ];
}

export async function ensureRegradableNativeResult(trialDir,{readFileFn=readFile,writeFileFn=writeFile}={}){
  const resultPath=join(trialDir,"result.json");
  try{return {created:false,result:JSON.parse(await readFileFn(resultPath,"utf8")),resultPath}}catch{}
  let config,lock,metrics;
  try{
    [config,lock,metrics]=await Promise.all([
      readFileFn(join(trialDir,"config.json"),"utf8").then(JSON.parse),
      readFileFn(join(trialDir,"lock.json"),"utf8").then(JSON.parse),
      readFileFn(join(trialDir,"agent","trebell-native-metrics.json"),"utf8").then(JSON.parse),
    ]);
  }catch(error){return {created:false,result:null,resultPath,reason:`unsealed trial metadata is incomplete: ${error?.message||error}`}}
  if(metrics?.error!=null)return {created:false,result:null,resultPath,reason:"Native metrics contain an agent error; refusing to synthesize a clean source trial"};
  const taskName=String(lock?.task?.name||config?.task?.name||"").trim(),taskRef=String(lock?.task?.digest||config?.task?.ref||"").trim();
  const taskParts=taskName.split("/").map(part=>part.trim()).filter(Boolean);
  if(taskParts.length<2||!taskRef)return {created:false,result:null,resultPath,reason:"task identity is incomplete in the unsealed trial"};
  const usage=metrics?.usage||{},model=String(metrics?.model||config?.agent?.model_name||"unknown").replace(/^openai\//,""),version=String(metrics?.version||"trebell-native-harbor/1");
  const nativeMetadata={
    model_turns:Number(metrics?.modelTurns||0),
    tool_calls:Number(metrics?.toolCalls||0),
    provider_requests:Number(metrics?.providerRequests||0),
    reasoning_effort:metrics?.reasoningEffort??null,
    reasoning_context:metrics?.reasoningContext??null,
    effective_reasoning_contexts:metrics?.effectiveReasoningContexts||[],
    reasoning_output_tokens:Number(usage?.reasoningOutputTokens||0),
    cache_write_input_tokens:Number(usage?.cacheWriteInputTokens||0),
    cache_carryover:metrics?.cacheCarryover||{},
    strategy:metrics?.strategy||{},
    budgets:metrics?.budgets||{},
    context_policy:metrics?.contextPolicy||{},
    recovered_unsealed_source:true,
  };
  const inputTokens=Number(usage?.inputTokens||0),cachedTokens=Number(usage?.cachedInputTokens||0),outputTokens=Number(usage?.outputTokens||0);
  const result={
    id:randomUUID(),
    task_name:taskName,
    trial_name:basename(trialDir),
    trial_uri:pathToFileURL(trialDir).href,
    task_id:{org:taskParts[0],name:taskParts.slice(1).join("/"),ref:taskRef},
    source:lock?.task?.source??config?.task?.source??null,
    task_checksum:`recovered-unsealed:${taskRef.replace(/^sha256:/,"")}`,
    config,
    agent_info:{name:"trebell-native",version,model_info:{name:model,provider:"openai"}},
    agent_result:{
      n_input_tokens:inputTokens,
      n_cache_tokens:cachedTokens,
      n_output_tokens:outputTokens,
      cost_usd:null,
      model_usage:{[`openai/${model}`]:{n_input_tokens:inputTokens,n_cache_tokens:cachedTokens,n_output_tokens:outputTokens,cost_usd:null}},
      rollout_details:null,
      metadata:{trebell_native:nativeMetadata},
    },
    verifier_result:null,
    verifier_environment_mode:"separate",
    exception_info:null,
    started_at:null,finished_at:null,environment_setup:null,agent_setup:null,agent_execution:null,verifier:null,step_results:null,
  };
  await writeFileFn(resultPath,JSON.stringify(result,null,2)+"\n","utf8");
  return {created:true,result,resultPath};
}

function splitLines(value){return String(value||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean)}

export async function dockerResourceIdsForProject(project,{captureFn}={}){
  if(!project||typeof captureFn!=="function")return {containers:[],networks:[],volumes:[]};
  const label=`com.docker.compose.project=${project}`;
  const [containers,networks,volumes]=await Promise.all([
    captureFn("docker",["ps","-a","--filter",`label=${label}`,"--filter","label=org.harborframework.terminal-bench.role=environment","--format","{{.ID}}"]).catch(()=>""),
    captureFn("docker",["network","ls","--filter",`label=${label}`,"--format","{{.ID}}"]).catch(()=>""),
    captureFn("docker",["volume","ls","--filter",`label=${label}`,"--format","{{.Name}}"]).catch(()=>""),
  ]);
  return {containers:splitLines(containers),networks:splitLines(networks),volumes:splitLines(volumes)};
}
export async function cleanupDockerProject(project,{captureFn,runFn}={}){
  const resources=await dockerResourceIdsForProject(project,{captureFn});
  if(typeof runFn!=="function")return {...resources,cleaned:false};
  for(const id of resources.containers)await runFn("docker",["rm","-f",id]).catch(()=>{});
  for(const id of resources.networks)await runFn("docker",["network","rm",id]).catch(()=>{});
  for(const id of resources.volumes)await runFn("docker",["volume","rm",id]).catch(()=>{});
  return {...resources,cleaned:true};
}

export async function salvageNativeArtifact(trialDir,{captureFn,runFn,mkdirFn=mkdir,writeFileFn=writeFile}={}){
  const project=composeProjectForTrial(trialDir),resources=await dockerResourceIdsForProject(project,{captureFn}),containerId=resources.containers[0]||null;
  if(!containerId)return {ok:false,trialDir,project,reason:"retained Native task container was not found",resources};
  const artifactDir=join(trialDir,"artifacts","app","output"),artifactPath=join(artifactDir,"model.safetensors");
  await mkdirFn(artifactDir,{recursive:true});
  try{await runFn("docker",["cp",`${containerId}:/app/output/model.safetensors`,artifactPath])}
  catch(error){return {ok:false,trialDir,project,containerId,artifactPath,reason:String(error?.message||error||"artifact copy failed"),resources}}
  await writeFileFn(join(trialDir,"artifacts","manifest.json"),JSON.stringify(nativeArtifactManifest(),null,2)+"\n","utf8");
  return {ok:true,trialDir,project,containerId,artifactPath,resources};
}

export async function regradeSalvagedNativeTrial({trialDir,harbor,validationDir,home,runFn,readFileFn=readFile,mkdirFn=mkdir}={}){
  if(!trialDir||!harbor||!validationDir)return {ok:false,reason:"regrade inputs are incomplete"};
  let lock=null;
  try{lock=JSON.parse(await readFileFn(join(trialDir,"lock.json"),"utf8"))}catch(error){return {ok:false,reason:`trial lock unavailable: ${error?.message||error}`}}
  const taskPath=cachedTaskPathFromLock(lock,{home});
  if(!taskPath)return {ok:false,reason:"cached task path could not be derived from the trial lock"};
  const sourceTrialName=basename(trialDir),regradeRoot=join(validationDir,"regrades",sourceTrialName),regradeName=`${sourceTrialName}-regrade`;
  await mkdirFn(regradeRoot,{recursive:true});
  try{await runFn(harbor,["trial","regrade",trialDir,"-p",taskPath,"-o",regradeRoot,"--trial-name",regradeName])}
  catch(error){return {ok:false,reason:String(error?.message||error||"Harbor regrade failed"),taskPath,regradeRoot}}
  const regradeTrialDir=join(regradeRoot,regradeName);
  let result=null;try{result=JSON.parse(await readFileFn(join(regradeTrialDir,"result.json"),"utf8"))}catch{}
  if(!result)return {ok:false,reason:"Harbor regrade exited cleanly but did not produce result.json",taskPath,regradeRoot,regradeTrialDir,result:null};
  if(!result.verifier_result)return {ok:false,reason:"Harbor regrade did not produce a verifier result",taskPath,regradeRoot,regradeTrialDir,result};
  return {ok:true,taskPath,regradeRoot,regradeTrialDir,result};
}

export async function recoverDroppedNativeTrial({outputRoot,jobName,harbor,validationDir,home,waitTimeoutMs=180_000,captureFn,runFn,readFileFn=readFile,readdirFn=readdir}={}){
  const trialDir=await findNativeTrialDir(outputRoot,jobName,{readdirFn});
  if(!trialDir)return {ok:false,reason:"Native trial directory was not found"};
  const project=composeProjectForTrial(trialDir),resources=await dockerResourceIdsForProject(project,{captureFn});
  if(!resources.containers.length)return {ok:false,trialDir,project,reason:"retained Native task container was not found",resources};
  const terminalEvent=await waitForNativeTerminalEvent(trialDir,{timeoutMs:waitTimeoutMs,readFileFn});
  if(!terminalEvent)return {ok:false,trialDir,reason:"Native terminal event did not arrive before salvage timeout"};
  const salvage=await salvageNativeArtifact(trialDir,{captureFn,runFn});
  if(!salvage.ok)return {ok:false,trialDir,terminalEvent,salvage,reason:salvage.reason};
  const sourceResult=await ensureRegradableNativeResult(trialDir,{readFileFn});
  if(!sourceResult.result)return {ok:false,trialDir,terminalEvent,salvage,sourceResult,reason:sourceResult.reason||"regradable Native source result could not be recovered"};
  const regrade=await regradeSalvagedNativeTrial({trialDir,harbor,validationDir,home,runFn,readFileFn});
  if(!regrade.ok)return {ok:false,trialDir,terminalEvent,salvage,regrade,reason:regrade.reason};
  return {ok:true,trialDir,terminalEvent,salvage,sourceResult,regrade};
}
