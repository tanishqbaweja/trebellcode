import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream, statfsSync } from "node:fs";
import { cpus, freemem, totalmem, tmpdir, loadavg, homedir } from "node:os";
import { basename, extname, isAbsolute, join, normalize, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { attachCodexRelay, probeCodexReady, waitForCodexReady } from "./codex-relay.mjs";
import {
  environmentWorkspaceDiff,
  environmentWorkspaceFile,
  environmentWorkspacePath,
  environmentWorkspaceSearch,
  environmentWorkspaceTree,
  environmentWorkspaceWriteFile,
} from "./workspace.mjs";
import { spawn } from "node:child_process";
import { codexBin, codexHome, packageRoot, trebellHome } from "./paths.mjs";
import { DEFAULT_PORT, codexProviderOverrides, ensureCodexConfig } from "./config.mjs";
import { health, isLoggedIn, listModels, listModelMetadata, logout, runLogin, startBridge } from "./freebuff.mjs";
import { getFreebuffOverview } from "./freebuff-product.mjs";
import { TrebellStateStore } from "./trebell-state.mjs";
import { CheckpointService } from "./checkpoint-service.mjs";
import { TerminalManager } from "./terminal-manager.mjs";
import { EnvironmentManager } from "./environment-manager.mjs";
import { startRemoteAppServer } from "./environment-app-server.mjs";
import { createRemoteControlServer } from "./remote-control.mjs";
import { RemoteAuthStore } from "./remote-auth-store.mjs";
import { RemoteAccessSecretStore } from "./remote-access-secret-store.mjs";
import { DeviceService } from "./device-service.mjs";
import { ProviderManager, normalizeProviderId } from "./provider-manager.mjs";
import { startProviderBridge } from "./provider-bridge.mjs";
import { AgentRuntimeManager, normalizeAgentRuntime } from "./agent-runtime-manager.mjs";
import { AgentThreadStore } from "./agent-thread-store.mjs";
import { importClaudeHistory, publicHistoryCandidate, scanLocalAgentHistory } from "./agent-history-import.mjs";
import { agentPermissionModeFromStart, attachAgentRelay } from "./agent-relay.mjs";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { listLicenses, licenseDetail } from "./license-service.mjs";
import { WorktreeCleanupService } from "./worktree-cleanup.mjs";
import { StorageCleanupService } from "./storage-cleanup-service.mjs";
import { sweepAutoPullProjects } from "./auto-pull-service.mjs";
import { CloneJobService } from "./clone-job-service.mjs";
import { prepareCodexHome } from "./codex-home-layout.mjs";
import { boundDiagnosticText } from "./diagnostic-bounds.mjs";
import { redactSecretText } from "./secret-redactor.mjs";
import { ContextEngine, createRemoteContextIo } from "./context-engine.mjs";
import { RepositoryKnowledgeService } from "./repository-knowledge-service.mjs";
import { REPOSITORY_TOOL_DEFINITIONS, invokeRepositoryTool, repositoryDynamicToolNamespace, repositoryToolHandlers } from "./repository-tool-catalog.mjs";
import { EventJournal } from "./event-journal.mjs";
import { enrichGoal, goalAdditionalContext, goalBudgetGate, normalizeGoal } from "./goal-state.mjs";
import { recordCodexBudgetEvidence, recordCodexChildAgentEvidence } from "./codex-budget-evidence.mjs";
import { continuityAdditionalContext, continuitySnapshot, normalizeContinuityNotes } from "./continuity-state.mjs";
import { verificationRepairContext, verificationRepairPrompt, verificationRepairState } from "./verification-repair.mjs";
import { delegationContextValue, delegationGoalPatch, delegationPolicies } from "./delegation-state.mjs";
import { executeDelegation } from "./delegation-executor.mjs";
import { resolveCodexApprovalByPolicy } from "./codex-policy-adapter.mjs";
import { resolveRecipeExecution } from "./recipes.mjs";

const TREBELL_VERSION = await readFile(join(packageRoot,"package.json"),"utf8")
  .then(text=>String(JSON.parse(text).version||"0.0.0"))
  .catch(()=>"0.0.0");
import {
  gitInfo, cloneRepository, initializeRepository, createBranch, switchBranch, commitAll, fetchRepo, pullRepo, pushRepo,
  safeAutoPull, createWorktree, removeWorktree,
} from "./git-service.mjs";
import {
  sourceControlDiagnostics, listPullRequests, createPullRequest, pullRequestDetail,
  editPullRequest, editPullRequestComment, approvePullRequestWorkflows, revertPullRequest,
  commentOnPullRequest, reviewPullRequest, mergePullRequest, updatePullRequestBranch,
  rebasePullRequestStack,
  checkoutPullRequest, requestPullRequestReviewer, publishRepository, getPullRequestFilesViewed, setPullRequestFilesViewed,
  sourceControlGitAction, sourceControlGitInfo, sourceControlPullRequestTemplate, sourceControlRecentCommitSubjects, sourceControlRepositoryIdentity, sourceControlReviewRangeContext, withSourceControlExecutor,
} from "./source-control-service.mjs";
import { prViewedKey, updateViewedRecord, viewedStates } from "./pr-viewed-state.mjs";
import { buildPullRequestLink, linkedPullRequestTerminalStatus, normalizePullRequestIdentity, parsePullRequestUrl, pullRequestForBranch, pullRequestIdentityKey } from "./pr-link-utils.mjs";

const MIME = {
  ".html":"text/html; charset=utf-8",
  ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".svg":"image/svg+xml",
  ".png":"image/png",
  ".jpg":"image/jpeg",
  ".jpeg":"image/jpeg",
  ".gif":"image/gif",
  ".webp":"image/webp",
  ".bmp":"image/bmp",
  ".pdf":"application/pdf",
  ".mp3":"audio/mpeg",
  ".wav":"audio/wav",
  ".m4a":"audio/mp4",
  ".ogg":"audio/ogg",
  ".flac":"audio/flac",
  ".mp4":"video/mp4",
  ".webm":"video/webm",
  ".mov":"video/quicktime",
  ".md":"text/markdown; charset=utf-8",
  ".csv":"text/csv; charset=utf-8",
  ".tsv":"text/tab-separated-values; charset=utf-8",
  ".ico":"image/x-icon",
};

function loopbackHttpUrl(input){
  const value=input instanceof URL?input:new URL(typeof input==="string"?input:String(input?.url||""));
  const host=String(value.hostname||"").toLowerCase();
  return ["http:","https:"].includes(value.protocol)&&["127.0.0.1","localhost","::1","[::1]","0.0.0.0"].includes(host);
}
export function offlineE2eFetch(fetchImpl=globalThis.fetch){
  return async(input,options)=>{
    let allowed=false,display="unknown";
    try{
      const value=input instanceof URL?input:new URL(typeof input==="string"?input:String(input?.url||""));
      display=value.origin;allowed=loopbackHttpUrl(value);
    }catch{}
    if(!allowed)throw new Error("Offline browser E2E blocked external network request: "+display);
    return fetchImpl(input,options);
  };
}

const json = (res,status,body) => {
  const data=Buffer.from(JSON.stringify(body));
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","content-length":String(data.length),"cache-control":"no-store"});
  res.end(data);
};

async function readJsonBody(req,maxBytes=2*1024*1024){
  let body="";
  for await (const chunk of req){
    body+=chunk;
    if(Buffer.byteLength(body,"utf8")>maxBytes) throw new Error("request_too_large");
  }
  if(!body) return {};
  try{return JSON.parse(body)}catch{throw new Error("invalid_json")}
}

export function requestAbortController(req,res){
  const controller=new AbortController();
  const abort=()=>{
    if(controller.signal.aborted)return;
    const error=new Error("Client disconnected before the request completed.");error.name="AbortError";controller.abort(error);
  };
  const onRequestAborted=()=>abort(),onResponseClosed=()=>{if(!res?.writableEnded)abort()};
  req?.once?.("aborted",onRequestAborted);res?.once?.("close",onResponseClosed);
  return {
    controller,signal:controller.signal,
    dispose(){req?.off?.("aborted",onRequestAborted);res?.off?.("close",onResponseClosed)},
  };
}

function parseArgs(argv){
  const out={port:Number(process.env.PORT||process.env.TREBELL_GUI_PORT||3210),appPort:Number(process.env.TREBELL_APP_SERVER_PORT||23456),host:process.env.TREBELL_GUI_HOST||"127.0.0.1",open:false,mock:process.env.TREBELL_GUI_MOCK==="1"};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==="--port") out.port=Number(argv[++i]);
    else if(argv[i]==="--app-port") out.appPort=Number(argv[++i]);
    else if(argv[i]==="--open") out.open=true;
    else if(argv[i]==="--mock") out.mock=true;
  }
  return out;
}

function openBrowser(url){
  const command=process.platform==="win32"
    ? ["cmd",["/c","start","",url]]
    : process.platform==="darwin"
      ? ["open",[url]]
      : ["xdg-open",[url]];
  const child=spawn(command[0],command[1],{detached:true,stdio:"ignore"});
  child.unref();
}

async function waitForChildExit(child,timeoutMs=3000){
  if(!child || child.exitCode!==null) return;
  await Promise.race([
    new Promise(resolve=>{
      const done=()=>resolve();
      child.once("exit",done);
      child.once("close",done);
    }),
    new Promise(resolve=>setTimeout(resolve,timeoutMs)),
  ]);
}

async function freeTcpPort(){
  const server=createTcpServer();
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const address=server.address();const port=typeof address==="object"&&address?address.port:0;
  await new Promise(resolve=>server.close(resolve));
  if(!port)throw new Error("Could not reserve a Codex app-server port");
  return port;
}

async function stopChildProcess(child){
  if(!child || child.exitCode!==null) return;
  const pid=child.pid;
  try{
    if(process.platform==="win32" && pid){
      await new Promise(resolve=>{
        const killer=spawn("taskkill",["/PID",String(pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
        killer.once("exit",resolve);
        killer.once("error",resolve);
        setTimeout(resolve,3000);
      });
      await waitForChildExit(child,3000);
    }else{
      child.kill("SIGTERM");
      await waitForChildExit(child,1500);
      if(child.exitCode===null){
        child.kill("SIGKILL");
        await waitForChildExit(child,1500);
      }
    }
  }catch{}
  try{child.stdout?.destroy();}catch{}
  try{child.stderr?.destroy();}catch{}
}

async function startAppServer({appPort,env=process.env,mock=false,provider="freebuff",providerPort=null,environments=null,environmentId=null,runtimeInstance=null}){
  if(mock) return { child:null, logs:[], targetUrl:null, readyUrl:null, environment:null, appPort, runtimeInstanceId:runtimeInstance?.id||"codex-default" };
  if(environmentId&&environments){
    const profile=environments.get(environmentId);
    if(profile&&profile.type!=="local"){
      try{
        const remote=await startRemoteAppServer({
          environments,
          environmentId,
          appPort,
          provider,
          localProviderPort:providerPort,
          runtimeInstance,
          debug:env.TREBELL_GUI_DEBUG==="1",
        });
        return {...remote,appPort,runtimeInstanceId:runtimeInstance?.id||"codex-default"};
      }catch(error){
        const text=redactSecretText((error?.stack||error?.message||String(error))+"\n",{environment:{...env,...(runtimeInstance?.environment||{})}});
        return {
          child:null,
          logs:[{at:Date.now(),stream:"environment",text:boundDiagnosticText(text)}],
          targetUrl:`ws://127.0.0.1:${appPort}`,
          readyUrl:null,
          environment:{id:profile.id,name:profile.name,type:profile.type},
          appPort,
          runtimeInstanceId:runtimeInstance?.id||"codex-default",
          error:redactSecretText(error instanceof Error?error.message:String(error),{environment:{...env,...(runtimeInstance?.environment||{})}}),
        };
      }
    }
  }
  const inferencePort=Number.isInteger(providerPort)?providerPort:DEFAULT_PORT;
  ensureCodexConfig({port:inferencePort,env,provider});
  const command=runtimeInstance?.binaryPath?.trim()||codexBin(env);
  const homeLayout=await prepareCodexHome({homePath:runtimeInstance?.homePath?.trim()||codexHome(env),shadowHomePath:runtimeInstance?.shadowHomePath?.trim()||null,defaultHome:codexHome(env)});
  const runtimeHome=homeLayout.effectiveHomePath||homeLayout.sharedHomePath;
  await mkdir(runtimeHome,{recursive:true});
  const runtimeEnv={...env,...(runtimeInstance?.environment||{}),CODEX_HOME:runtimeHome};
  const args=[...codexProviderOverrides({port:inferencePort,provider}),"app-server","--listen",`ws://127.0.0.1:${appPort}`];
  const logs=[];
  const pushLog=(chunk,stream)=>{
    const line=boundDiagnosticText(redactSecretText(chunk,{environment:runtimeEnv}));
    logs.push({at:Date.now(),stream,text:line});
    if(logs.length>250) logs.splice(0,logs.length-250);
    if(env.TREBELL_GUI_DEBUG==="1") (stream==="stderr"?process.stderr:process.stdout).write(line);
  };
  const child=spawn(command,args,{
    cwd:process.cwd(),
    env:runtimeEnv,
    windowsHide:true,
    shell:process.platform==="win32" && !command.toLowerCase().endsWith(".exe"),
    stdio:["ignore","pipe","pipe"],
  });
  child.stdout?.on("data",chunk=>pushLog(chunk,"stdout"));
  child.stderr?.on("data",chunk=>pushLog(chunk,"stderr"));
  child.on("error",error=>pushLog(error.stack||error.message,"stderr"));
  child.on("exit",(code,signal)=>pushLog(`app-server exited code=${code} signal=${signal}\n`,"stderr"));
  return { child, logs, targetUrl:`ws://127.0.0.1:${appPort}`, readyUrl:`http://127.0.0.1:${appPort}/readyz`, environment:null, appPort, runtimeInstanceId:runtimeInstance?.id||"codex-default",runtimeHome,sharedRuntimeHome:homeLayout.sharedHomePath,continuationKey:homeLayout.continuationKey };
}

async function appServerReady(instance,appPort){
  if(instance?.readyUrl){
    try{
      const response=await fetch(instance.readyUrl,{signal:AbortSignal.timeout(1200)});
      return response.ok;
    }catch{return false}
  }
  return instance?.child ? await probeCodexReady(instance?.appPort||appPort) : false;
}

async function waitForAppServer(instance,appPort,timeoutMs=15000){
  if(!instance?.readyUrl) return instance?.child ? await waitForCodexReady(instance?.appPort||appPort,timeoutMs).catch(()=>false) : false;
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    if(await appServerReady(instance,appPort))return true;
    await new Promise(resolve=>setTimeout(resolve,180));
  }
  return false;
}

async function stopAppServer(instance){
  await stopChildProcess(instance?.child);
  try{await instance?.close?.()}catch{}
}

function fakeModels(provider="freebuff"){
  if(provider==="agentrouter") return ["gpt-5.6-sol","gpt-6-astra","claude-opus-4-8","claude-opus-5","deepseek-v4-flash"];
  if(provider==="justworker") return ["claude-opus-4-8"];
  if(provider==="hcnsec") return ["glm-5.3"];
  if(provider==="vyceai") return ["claude-sonnet-4-6","gpt-astra","deepseek-v4.1","auto"];
  return ["freebuff/deepseek/deepseek-v4-flash","freebuff/test/coding-large","freebuff/test/coding-fast"];
}

function statsSnapshot(){
  const load=cpus().length ? Math.min(100,Math.round((requireLoad()/cpus().length)*100)) : 0;
  const usedMem=Math.max(0,totalmem()-freemem());
  let disk="â€”";
  try{
    const fs=statfsSync(tmpdir());
    const used=(fs.blocks-fs.bfree)*fs.bsize;
    disk=`${Math.round(used/1024/1024)} MB`;
  }catch{}
  return {
    cpu:`${load}%`,
    memory:`${Math.round(usedMem/1024/1024)} MB`,
    disk,
    network:"Local",
  };
}
function requireLoad(){
  try{
    if(process.env.TREBELL_TEST_LOAD) return Number(process.env.TREBELL_TEST_LOAD) || 0;
    return process.platform==="win32" ? 0 : (loadavg()[0] || 0);
  }catch{return 0}
}

const COMMON_PREVIEW_PORTS=[3000,3001,4173,4200,4321,5000,5173,5174,8000,8080,8081,8787,8888];

async function discoverPreviewServers(){
  const checks=COMMON_PREVIEW_PORTS.map(async port=>{
    const url=`http://127.0.0.1:${port}/`;
    try{
      const response=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(650)});
      const contentType=String(response.headers.get("content-type")||"").toLowerCase();
      return {
        host:"localhost",
        port,
        url:`http://localhost:${port}`,
        status:response.status,
        contentType:contentType.split(";")[0]||null,
        web:contentType.includes("text/html")||contentType.includes("application/xhtml+xml")||response.status<500,
      };
    }catch{return null}
  });
  return (await Promise.all(checks)).filter(Boolean).filter(item=>item.web).sort((a,b)=>a.port-b.port);
}

function parseJsonc(text){
  const source=String(text||"");
  let clean="",inString=false,escaped=false,lineComment=false,blockComment=false;
  for(let i=0;i<source.length;i++){
    const ch=source[i],next=source[i+1];
    if(lineComment){if(ch==="\n"){lineComment=false;clean+=ch}continue}
    if(blockComment){if(ch==="*"&&next==="/"){blockComment=false;i++}continue}
    if(inString){
      clean+=ch;
      if(escaped)escaped=false;
      else if(ch==="\\")escaped=true;
      else if(ch==='"')inString=false;
      continue;
    }
    if(ch==='"'){inString=true;clean+=ch;continue}
    if(ch==="/"&&next==="/"){lineComment=true;i++;continue}
    if(ch==="/"&&next==="*"){blockComment=true;i++;continue}
    clean+=ch;
  }
  clean=clean.replace(/,\s*([}\]])/g,"$1");
  return JSON.parse(clean);
}

async function readOptionalJson(path,{jsonc=false}={}){
  try{
    const raw=await readFile(path,"utf8");
    return jsonc?parseJsonc(raw):JSON.parse(raw);
  }catch{return null}
}

function commandShellSpec(command,env=process.env){
  if(process.platform==="win32"){
    const shell=env.COMSPEC||"cmd.exe";
    return {shell,args:["/d","/s","/c",String(command||"")]};
  }
  const shell=env.SHELL||"/bin/bash";
  return {shell,args:["-lc",String(command||"")]};
}

async function projectActionSuggestions(projectPath){
  const root=resolve(projectPath);
  const [t3,pkg,pnpmLock,yarnLock,bunLock,bunLockb]=await Promise.all([
    readOptionalJson(join(root,"t3.json"),{jsonc:true}),
    readOptionalJson(join(root,"package.json")),
    stat(join(root,"pnpm-lock.yaml")).then(()=>true).catch(()=>false),
    stat(join(root,"yarn.lock")).then(()=>true).catch(()=>false),
    stat(join(root,"bun.lock")).then(()=>true).catch(()=>false),
    stat(join(root,"bun.lockb")).then(()=>true).catch(()=>false),
  ]);
  const fileScripts=Array.isArray(t3?.scripts)?t3.scripts.slice(0,50).map((script,index)=>({
    id:`t3-${index}-${String(script?.name||"action").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,32)}`,
    source:"t3.json",
    name:String(script?.name||`Action ${index+1}`).trim().slice(0,80),
    command:String(script?.command||"").trim().slice(0,8000),
    previewUrl:script?.previewUrl?String(script.previewUrl).trim().slice(0,1000):null,
    autoOpenPreview:Boolean(script?.autoOpenPreview),
    runOnWorktreeCreate:Boolean(script?.runOnWorktreeCreate),
    waitForSetup:script?.runOnWorktreeCreate===true&&script?.async===false,
  })).filter(script=>script.command):[];
  const packageManager=pnpmLock?"pnpm":(yarnLock?"yarn":((bunLock||bunLockb)?"bun":"npm"));
  const packageScripts=Object.entries(pkg?.scripts||{}).slice(0,80).map(([name,command])=>({
    id:`package-${name}`,
    source:"package.json",
    name,
    command:packageManager==="yarn"?`yarn ${name}`:`${packageManager} run ${name}`,
    declaredCommand:String(command||""),
    previewUrl:null,
    autoOpenPreview:false,
    runOnWorktreeCreate:false,
    waitForSetup:false,
  }));
  return {
    t3:{present:Boolean(t3),defaultThreadEnvMode:t3?.defaultThreadEnvMode==="worktree"?"worktree":t3?.defaultThreadEnvMode==="local"?"current":null,worktreeSubmodules:["recursive","top-level","none"].includes(t3?.worktreeSubmodules)?t3.worktreeSubmodules:null},
    packageManager,
    scripts:[...fileScripts,...packageScripts],
  };
}

export async function createGuiServer({port=3210,appPort=23456,host="127.0.0.1",mock=false,env=process.env}={}){
  const offlineE2E=env.TREBELL_E2E_OFFLINE==="1"||process.env.TREBELL_E2E_OFFLINE==="1";
  if(offlineE2E&&!mock)throw new Error("Offline browser E2E forbids starting a real Trebell provider or Codex app-server.");
  const fetchImpl=offlineE2E?offlineE2eFetch(globalThis.fetch):globalThis.fetch;
  const bootId=randomUUID();
  const dist=String(env.TREBELL_UI_DIST||"").trim()?resolve(String(env.TREBELL_UI_DIST).trim()):resolve(packageRoot,"ui","dist");
  const remoteAccessSecrets=new RemoteAccessSecretStore(env);remoteAccessSecrets.migrateLegacyUiState();
  const state=new TrebellStateStore(env);
  const eventJournal=new EventJournal(env);
  const remoteAuth=new RemoteAuthStore(env);
  const devices=new DeviceService({env});
  const providers=new ProviderManager({env,fetchFn:fetchImpl});
  const environments=new EnvironmentManager({state,env});
  const storedActiveEnvironmentId=state.settings().activeEnvironmentId||null;
  if(storedActiveEnvironmentId&&!environments.get(storedActiveEnvironmentId))state.updateSettings({activeEnvironmentId:null});
  function requestedEnvironmentId(value,{fallback=true}={}){
    if(value===undefined||value===null)return fallback?(state.settings().activeEnvironmentId||null):null;
    const text=String(value).trim();return text||null;
  }
  function environmentPath(value,environmentId){
    const text=String(value||"").trim();if(!text)throw new Error("path is required");
    const profile=environmentId?environments.get(environmentId):null;
    if(environmentId&&!profile)throw new Error("Environment profile was not found");
    if(!profile||profile.type==="local")return resolve(text);
    if(text.startsWith("/"))return posix.normalize(text);
    return posix.normalize(posix.join(profile.cwd||"/",text));
  }
  function projectWithEnvironment(project){
    if(!project)return project;
    const profile=project.environmentId?environments.get(project.environmentId,{includeDisabled:true}):null;
    const cloneJob=project.cloneJob?{
      id:project.cloneJob.id,url:project.cloneJob.url,status:project.cloneJob.status,progress:project.cloneJob.progress,
      phase:project.cloneJob.phase,error:project.cloneJob.error||null,startedAt:project.cloneJob.startedAt,completedAt:project.cloneJob.completedAt||null,
    }:null;
    return {...project,cloneJob,environment:project.environmentId?{
      id:project.environmentId,
      name:profile?.name||"Unavailable environment",
      type:profile?.type||"unknown",
      enabled:profile?.enabled!==false,
    }:{id:null,name:"Local machine",type:"local"},effectiveSettings:state.projectSettings(project.path,project.environmentId).effective};
  }
  const agentRuntimes=new AgentRuntimeManager({state,env,environments,fetchImpl});
  const codexThreadModels=new Map();
  const agentThreads=new AgentThreadStore(env);
  agentThreads.reconcileRestart({continueAfterRestart:Boolean(state.settings().continueThreadsAfterRestart)});
  for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
    const recovery=meta?.restartRecovery;
    if(recovery?.runtime!=="codex"||recovery?.status!=="active"||!recovery.turnId||recovery.bootId===bootId)continue;
    state.updateThreadMeta(threadId,{restartRecovery:Boolean(state.settings().continueThreadsAfterRestart)
      ?{...recovery,status:"pending",detectedAt:Date.now()}
      :{...recovery,status:"interrupted",detectedAt:Date.now(),message:"Codex work was interrupted by a Trebell restart. Send a new message to continue."}});
  }
  let selectedAgentRuntime=normalizeAgentRuntime(state.settings().agentRuntime);
  if(state.settings().agentRuntime!==selectedAgentRuntime) state.updateSettings({agentRuntime:selectedAgentRuntime,agentRuntimeInstanceId:`${selectedAgentRuntime}-default`});
  let selectedProvider=normalizeProviderId(state.settings().modelProvider);
  if(state.settings().modelProvider!==selectedProvider) state.updateSettings({modelProvider:selectedProvider});
  const safeLogText=value=>boundDiagnosticText(redactSecretText(value,{environment:env}));
  const providerBridgeLogs=[];
  const providerBridge=mock?null:await startProviderBridge({
    port:0,
    providerManager:providers,
    provider:selectedProvider,
    log:(message)=>{
      providerBridgeLogs.push({at:Date.now(),stream:"provider-bridge",text:safeLogText(message)});
      if(providerBridgeLogs.length>100) providerBridgeLogs.splice(0,providerBridgeLogs.length-100);
    },
  });
  const selectedInferencePort=()=>selectedProvider==="freebuff"?DEFAULT_PORT:(providerBridge?.port??null);
  ensureCodexConfig({port:selectedInferencePort(),env,provider:selectedProvider});
  let bridge=null;
  let loginPromise=null;
  const checkpoints=new CheckpointService({state,env});
  function recordCheckpointTrace(name,status,checkpoint=null,extra={}){
    const threadId=checkpoint?.threadId||extra.threadId||null,meta=threadId?state.threadMeta(threadId):{};
    eventJournal.record({
      runtime:meta?.runtime||null,provider:meta?.runtimeInstanceId||null,environmentId:meta?.environmentId??state.settings().activeEnvironmentId??null,
      threadId,turnId:checkpoint?.turnId||extra.turnId||null,category:"checkpoint",name,status,
      data:{checkpointId:checkpoint?.id||extra.checkpointId||null,root:checkpoint?.root||null,commit:checkpoint?.commit||null,label:checkpoint?.label||null,reason:extra.reason||null,message:extra.message||null},
    });
  }
  const EXTERNAL_SOURCE_CONTROL_ACTIONS=new Set(["push","git.push","publish","pr.create","pr.edit","pr.edit-comment","pr.approve-workflows","pr.revert","pr.rebase-stack","pr.comment","pr.review","pr.merge","pr.update-branch","pr.request-reviewer"]);
  async function tracedSourceControlMutation(action,{cwd=null,environmentId=null,provider=null,number=null,threadId=null}={},run){
    const startedAt=Date.now(),externalSideEffect=EXTERNAL_SOURCE_CONTROL_ACTIONS.has(String(action||""));
    try{
      const result=await run();
      const resolvedNumber=number??result?.number??result?.item?.number??null;
      eventJournal.record({environmentId:environmentId||null,threadId:threadId||null,category:"source-control",name:"source_control."+String(action||"mutation"),status:"completed",data:{action,cwd,provider:provider||result?.provider||result?.item?.provider||null,number:resolvedNumber==null?null:Number(resolvedNumber),externalSideEffect,durationMs:Date.now()-startedAt}});
      return result;
    }catch(error){
      eventJournal.record({environmentId:environmentId||null,threadId:threadId||null,category:"source-control",name:"source_control."+String(action||"mutation"),status:"failed",data:{action,cwd,provider:provider||null,number:number==null?null:Number(number),externalSideEffect,durationMs:Date.now()-startedAt,message:error?.message||String(error)}});
      throw error;
    }
  }
  const contextEngine=new ContextEngine();
  const repositoryKnowledge=new RepositoryKnowledgeService({
    state,
    ioFactory:async({projectPath,environmentId})=>{
      const profile=environmentId?environments.get(environmentId):null;
      return profile&&profile.type!=="local"?createRemoteContextIo({environments,environmentId,root:projectPath}):null;
    },
  });
  const terminals=mock ? null : new TerminalManager({env});
  function terminalOptions({environmentId=null,cwd=null,name=null,cols=120,rows=32,terminalEnv=null}={}){
    const spec=environments.terminalSpec(environmentId,{cwd});
    const profile=environmentId?environments.get(environmentId):null;
    const displayCwd=String(cwd||profile?.cwd||process.cwd());
    return {
      cwd:spec.cwd,
      displayCwd,
      cols,
      rows,
      name:name||"Terminal",
      env:terminalEnv||null,
      shell:spec.shell,
      args:spec.args,
      environmentId:spec.environmentId,
      environmentName:spec.environmentName,
      environmentType:spec.environmentType,
    };
  }
  async function createTerminalSession(body={}){
    const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")
      ?requestedEnvironmentId(body.environmentId,{fallback:false})
      :requestedEnvironmentId(null);
    return terminals.create(terminalOptions({
      environmentId,
      cwd:body.cwd||null,
      name:body.name||null,
      cols:body.cols,
      rows:body.rows,
      terminalEnv:body.env||null,
    }));
  }
  function sourceControlExecutor(environmentId){
    const profile=environmentId?environments.get(environmentId):null;
    const localRequest=async(url,options={})=>{
      const response=await fetchImpl(url,options);const text=await response.text();
      return {ok:response.ok,status:response.status,text};
    };
    if(!profile||profile.type==="local")return {request:localRequest};
    const normalized=result=>({
      ok:Number(result?.exitCode??1)===0&&!result?.timedOut,
      code:Number(result?.exitCode??1),
      exitCode:Number(result?.exitCode??1),
      stdout:result?.stdout||"",
      stderr:result?.stderr||"",
      timedOut:Boolean(result?.timedOut),
    });
    return {
      run:async(command,args,{cwd,timeout,maxBuffer}={})=>normalized(await environments.executeArgv(environmentId,{command,args,cwd,timeoutMs:timeout,maxOutput:maxBuffer})),
      runStdin:async(command,args,input,{cwd,timeout,maxBuffer}={})=>normalized(await environments.executeArgvInput(environmentId,{command,args,input,cwd,timeoutMs:timeout,maxOutput:maxBuffer})),
      withTempJsonFile:async(content,callback)=>{
        const allocated=await environments.executeArgv(environmentId,{command:"mktemp",args:["/tmp/trebell-azdo-XXXXXX.json"],cwd:"",timeoutMs:8000,maxOutput:64*1024});
        if(allocated.exitCode!==0)throw new Error(allocated.stderr||"Could not allocate remote Azure DevOps request file");
        const path=String(allocated.stdout||"").trim();if(!path)throw new Error("Remote Azure DevOps request file path was empty");
        const created=await environments.executeArgvInput(environmentId,{command:"tee",args:[path],input:String(content??""),cwd:"",timeoutMs:12000,maxOutput:64*1024});
        if(created.exitCode!==0){await environments.executeArgv(environmentId,{command:"rm",args:["-f",path],cwd:"",timeoutMs:8000,maxOutput:64*1024}).catch(()=>{});throw new Error(created.stderr||"Could not create remote Azure DevOps request file")}
        try{return await callback(path)}
        finally{await environments.executeArgv(environmentId,{command:"rm",args:["-f",path],cwd:"",timeoutMs:8000,maxOutput:64*1024}).catch(()=>{})}
      },
      readFile:async(path)=>{
        const result=await environments.executeArgv(environmentId,{command:"cat",args:[String(path)],cwd:"",timeoutMs:12000,maxOutput:4*1024*1024});
        if(result.exitCode!==0)throw new Error(result.stderr||"Could not read remote file");
        return result.stdout;
      },
      env:async(names)=>{
        const values={};
        for(const name of names||[]){
          const result=await environments.executeArgv(environmentId,{command:"printenv",args:[String(name)],cwd:"",timeoutMs:8000,maxOutput:64*1024});
          if(result.exitCode===0)values[name]=String(result.stdout||"").trimEnd();
        }
        return values;
      },
      request:async(url,options={})=>{
        if(offlineE2E&&!loopbackHttpUrl(url))throw new Error("Offline browser E2E blocked external network request: "+String(url));
        const method=String(options.method||"GET").toUpperCase();
        const config=["silent","show-error","max-time = 30","request = "+JSON.stringify(method)];
        if(options.redirect!=="manual")config.push("location");
        for(const [name,value] of Object.entries(options.headers||{}))config.push("header = "+JSON.stringify(String(name)+": "+String(value)));
        config.push("write-out = "+JSON.stringify("\nTREBELL_HTTP_STATUS:%{http_code}"));
        const args=["--config","-"];
        if(options.body!==undefined)args.push("--data-raw",String(options.body));
        args.push(String(url));
        const result=await environments.executeArgvInput(environmentId,{command:"curl",args,input:config.join("\n")+"\n",cwd:"",timeoutMs:35000,maxOutput:10*1024*1024});
        if(result.exitCode!==0)throw new Error(result.stderr||"Remote HTTP request failed");
        const match=String(result.stdout||"").match(/\nTREBELL_HTTP_STATUS:(\d{3})$/);
        const status=Number(match?.[1]||0);
        const text=match?result.stdout.slice(0,match.index):result.stdout;
        return {ok:status>=200&&status<300,status,text};
      },
      readFjKeys:async()=>{
        const command=[
          "for f in",
          "\"$HOME/.local/share/forgejo-cli/keys.json\"",
          "\"$HOME/Library/Application Support/forgejo-cli.forgejo-cli/keys.json\"",
          "\"$HOME/Library/Application Support/Cyborus.forgejo-cli/keys.json\";",
          "do if [ -f \"$f\" ]; then cat \"$f\"; exit 0; fi; done; exit 1",
        ].join(" ");
        const result=await environments.execute(environmentId,{command,cwd:"",timeoutMs:12000,maxOutput:2*1024*1024});
        if(result.exitCode!==0)return {hosts:{},aliases:{}};
        try{return JSON.parse(result.stdout)}catch{return {hosts:{},aliases:{}}}
      },
    };
  }
  function inSourceControlEnvironment(environmentId,callback){
    return withSourceControlExecutor(sourceControlExecutor(environmentId),callback);
  }
  function threadPullRequestAttachments(threadId){
    return (state.threadMeta(threadId)?.attachments||[]).filter(item=>item?.attachmentType==="pull_request");
  }
  function threadPullRequestLinks(threadId){
    return threadPullRequestAttachments(threadId).map(item=>({...item.payload,__identityKey:item.identityKey})).filter(Boolean);
  }
  async function resolvePullRequestIdentity(identity,{preferredPath=null,preferredEnvironmentId=null}={}){
    const wanted=normalizePullRequestIdentity(identity);if(!wanted)throw new Error("Pull request identity is incomplete");
    const projects=state.projects().sort((a,b)=>{
      const aPreferred=a.path===preferredPath&&(a.environmentId||null)===(preferredEnvironmentId||null);
      const bPreferred=b.path===preferredPath&&(b.environmentId||null)===(preferredEnvironmentId||null);
      return Number(bPreferred)-Number(aPreferred);
    });
    for(const project of projects){
      try{
        const repo=await inSourceControlEnvironment(project.environmentId||null,()=>sourceControlRepositoryIdentity(project.path,{provider:wanted.provider||null}));
        if(String(repo.host||"").toLowerCase()!==wanted.host||String(repo.repository||"").toLowerCase()!==wanted.repository.toLowerCase())continue;
        const detail=await inSourceControlEnvironment(project.environmentId||null,()=>pullRequestDetail(project.path,wanted.number,{provider:repo.provider}));
        if(detail?.ok&&detail.item)return {project:projectWithEnvironment(project),detail};
      }catch{}
    }
    throw new Error("Add a Trebell project for "+wanted.host+"/"+wanted.repository+" to resolve this pull request.");
  }
  function storePullRequestLink(threadId,link){
    const key=pullRequestIdentityKey(link);if(!key)throw new Error("Pull request identity is incomplete");
    const meta=state.threadMeta(threadId);const attachments=(meta.attachments||[]).filter(item=>!(item?.attachmentType==="pull_request"&&(item.identityKey===key||pullRequestIdentityKey(item.payload||{})===key)));
    attachments.push({attachmentType:"pull_request",identityKey:key,payload:link});
    const dismissed=(meta.dismissedPullRequestKeys||[]).filter(item=>item!==key);
    const legacy=attachments.filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload);
    state.updateThreadMeta(threadId,{attachments,dismissedPullRequestKeys:dismissed,linkedPullRequests:legacy,autoSettlePending:null,autoSettleAppliedSignature:null});
    return {key,links:threadPullRequestLinks(threadId)};
  }
  function removePullRequestLink(threadId,identity){
    const key=pullRequestIdentityKey(identity);if(!key)throw new Error("Pull request identity is incomplete");
    const meta=state.threadMeta(threadId);const attachments=(meta.attachments||[]).filter(item=>!(item?.attachmentType==="pull_request"&&(item.identityKey===key||pullRequestIdentityKey(item.payload||{})===key)));
    const dismissed=[...new Set([...(meta.dismissedPullRequestKeys||[]),key])];
    const legacy=attachments.filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload);
    state.updateThreadMeta(threadId,{attachments,dismissedPullRequestKeys:dismissed,linkedPullRequests:legacy,autoSettlePending:null});
    return {key,links:threadPullRequestLinks(threadId)};
  }
  function reversePullRequestLinks(identity){
    const key=pullRequestIdentityKey(identity);if(!key)return[];
    const externalThreads=new Map(agentThreads.list().map(thread=>[thread.id,thread]));
    const results=[];
    for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
      if(!(meta.attachments||[]).some(item=>item?.attachmentType==="pull_request"&&(item.identityKey===key||pullRequestIdentityKey(item.payload||{})===key)))continue;
      const thread=externalThreads.get(threadId);
      results.push({threadId,title:thread?.name||thread?.preview||meta.title||null,cwd:thread?.cwd||meta.cwd||null,archived:Boolean(thread?.archived||meta.archived)});
    }
    return results;
  }
  async function syncThreadPullRequestLinks(threadId){
    const meta=state.threadMeta(threadId);const attachments=meta.attachments||[];
    const pullAttachments=attachments.filter(item=>item?.attachmentType==="pull_request");
    if(!pullAttachments.length)return {threadId,links:[]};
    const dismissed=new Set(meta.dismissedPullRequestKeys||[]);const synced=new Map();
    for(const attachment of pullAttachments){
      const original=attachment.payload||{};const identity=normalizePullRequestIdentity(original.identity||original);
      if(!identity){synced.set(attachment.identityKey,attachment);continue}
      try{
        const resolved=await resolvePullRequestIdentity(identity);
        const detail=resolved.detail.item;const updated=buildPullRequestLink({...detail,linkedAt:original.linkedAt},{source:original.source||"manual"});
        const updatedKey=pullRequestIdentityKey(updated);synced.set(updatedKey,{attachmentType:"pull_request",identityKey:updatedKey,payload:updated});
        const layers=Array.isArray(detail.stack?.layers)?detail.stack.layers:[];
        for(const layer of layers){
          const layerIdentity={...identity,number:Number(layer.number)};const layerKey=pullRequestIdentityKey(layerIdentity);
          if(!layerKey||dismissed.has(layerKey)||synced.has(layerKey))continue;
          const existing=pullAttachments.find(item=>item.identityKey===layerKey);
          try{
            const layerDetail=Number(layer.number)===Number(detail.number)?detail:await inSourceControlEnvironment(resolved.project.environmentId||null,()=>pullRequestDetail(resolved.project.path,layer.number,{provider:identity.provider}));
            if(!layerDetail?.ok||!layerDetail.item)continue;
            const layerLink=buildPullRequestLink({...layerDetail.item,linkedAt:existing?.payload?.linkedAt},{source:existing?.payload?.source||"stack"});
            synced.set(layerKey,{attachmentType:"pull_request",identityKey:layerKey,payload:layerLink});
          }catch{}
        }
      }catch{synced.set(attachment.identityKey,attachment)}
    }
    const nonPr=attachments.filter(item=>item?.attachmentType!=="pull_request");const next=[...nonPr,...synced.values()];
    const legacy=[...synced.values()].map(item=>item.payload);
    const lifecycle=linkedPullRequestTerminalStatus(legacy);const settings=state.settings();
    const patch={attachments:next,linkedPullRequests:legacy,lastPullRequestSyncAt:Date.now()};
    if(!lifecycle.terminal){
      patch.autoSettlePending=null;
      if(meta.autoSettleAppliedSignature)patch.autoSettleAppliedSignature=null;
    }else if(settings.autoSettleMergedThreads&&meta.autoSettleAppliedSignature!==lifecycle.signature){
      patch.autoSettlePending={signature:lifecycle.signature,requestedAt:Date.now(),reason:"pull_requests_terminal"};
    }
    state.updateThreadMeta(threadId,patch);
    return {threadId,links:threadPullRequestLinks(threadId),lifecycle,pendingSettlement:patch.autoSettlePending||null};
  }
  async function syncBranchPullRequests({force=false}={}){
    const now=Date.now();const all=state.listThreadMeta();const candidates=[];
    for(const [threadId,meta] of Object.entries(all)){
      if(!meta?.cwd||!meta?.branch||meta.deletedAt||meta.archived||meta.sectionName==="Settled")continue;
      if(!force&&now-Number(meta.lastBranchPullRequestSyncAt||0)<60_000)continue;
      candidates.push({threadId,meta,environmentId:meta.environmentId||null,cwd:String(meta.cwd)});
    }
    if(!candidates.length)return {checked:0,repositories:0};
    const locations=new Map();
    for(const candidate of candidates){
      const key=(candidate.environmentId||"local")+"|"+candidate.cwd;
      if(!locations.has(key))locations.set(key,{environmentId:candidate.environmentId,cwd:candidate.cwd,threads:[]});
      locations.get(key).threads.push(candidate);
    }
    const repositories=new Map();
    for(const location of locations.values()){
      try{
        const repo=await inSourceControlEnvironment(location.environmentId,()=>sourceControlRepositoryIdentity(location.cwd));
        const key=[location.environmentId||"local",repo.provider,repo.host,String(repo.repository||"").toLowerCase()].join("|");
        if(!repositories.has(key))repositories.set(key,{environmentId:location.environmentId,cwd:location.cwd,provider:repo.provider,repo,threads:[]});
        repositories.get(key).threads.push(...location.threads);
      }catch(error){
        for(const candidate of location.threads)state.updateThreadMeta(candidate.threadId,{branchPullRequestSyncError:error.message||String(error),lastBranchPullRequestAttemptAt:now});
      }
    }
    for(const group of repositories.values()){
      try{
        const result=await inSourceControlEnvironment(group.environmentId,()=>listPullRequests(group.cwd,{provider:group.provider}));
        if(!result?.ok)throw new Error(result?.error||"Could not list pull requests");
        for(const candidate of group.threads){
          const detected=pullRequestForBranch(candidate.meta.branch,result.items||[]);
          state.updateThreadMeta(candidate.threadId,{
            branchPullRequest:detected,lastBranchPullRequestSyncAt:now,lastBranchPullRequestAttemptAt:now,branchPullRequestSyncError:null,
          });
        }
      }catch(error){
        for(const candidate of group.threads)state.updateThreadMeta(candidate.threadId,{branchPullRequestSyncError:error.message||String(error),lastBranchPullRequestAttemptAt:now});
      }
    }
    return {checked:candidates.length,repositories:repositories.size};
  }
  function remoteEnvironmentProfile(environmentId){
    const profile=environmentId?environments.get(environmentId):null;
    return profile&&profile.type!=="local"?profile:null;
  }
  async function ensureGeneralWorkspace(environmentId=null){
    const profile=remoteEnvironmentProfile(environmentId);
    if(!profile){
      const path=join(trebellHome(env),"general");
      await mkdir(path,{recursive:true});
      return {path,environmentId:null,environmentName:"Local machine",remote:false};
    }
    const result=await environments.execute(environmentId,{
      command:'root="$HOME/.trebell-code/general"; mkdir -p "$root" && printf "%s" "$root"',
      cwd:"",timeoutMs:12000,maxOutput:64*1024,
    });
    if(result.exitCode!==0)throw new Error(result.stderr||"Could not prepare the general-chat workspace");
    const path=String(result.stdout||"").trim();
    if(!path)throw new Error("The selected environment did not report its general-chat workspace");
    return {path,environmentId:profile.id,environmentName:profile.name,remote:true};
  }
  function pathInside(rootPath,filePath,{remote=false}={}){
    if(remote){
      const base=posix.normalize(String(rootPath||"/"));const target=posix.normalize(String(filePath||""));
      const rel=posix.relative(base,target);return rel===""||(!rel.startsWith("..")&&!posix.isAbsolute(rel));
    }
    const base=resolve(rootPath||process.cwd());const target=resolve(filePath||"");
    const rel=relative(base,target);return rel===""||(!rel.startsWith("..")&&!isAbsolute(rel));
  }
  function expandLocalHomePath(value){
    const raw=String(value||"").trim();if(!raw)return null;
    if(raw==="~")return homedir();
    if(raw.startsWith("~/")||raw.startsWith("~\\"))return join(homedir(),raw.slice(2));
    return resolve(raw);
  }
  async function localVisualizationRoots(workspaceRoot){
    const roots=[resolve(workspaceRoot||process.cwd()),join(codexHome(env),"visualizations")];
    const active=agentRuntimes.activeInstance();
    if(active?.kind==="codex"){
      for(const candidate of [active.homePath,active.shadowHomePath]){
        const expanded=expandLocalHomePath(candidate);if(expanded)roots.push(join(expanded,"visualizations"));
      }
    }
    return [...new Set(roots.map(root=>resolve(root)))];
  }
  async function remoteVisualizationRoots(environmentId,workspaceRoot){
    const roots=[posix.normalize(String(workspaceRoot||"/"))];
    const homeResult=await environments.executeArgv(environmentId,{command:"printenv",args:["HOME"],cwd:"",timeoutMs:8000,maxOutput:64*1024}).catch(()=>null);
    const home=String(homeResult?.stdout||"").trim();
    if(home)roots.push(posix.join(home,".codex","visualizations"));
    return [...new Set(roots.map(root=>posix.normalize(root)))];
  }
  async function findLocalVisualization(roots,fileName,threadId=null){
    const wanted=basename(String(fileName||""));if(!wanted)return null;
    let visited=0;const maxVisited=4000;
    async function walk(dir,depth){
      if(depth>8||visited>=maxVisited)return null;
      let entries;try{entries=await readdir(dir,{withFileTypes:true})}catch{return null}
      for(const entry of entries){
        if(++visited>maxVisited)return null;
        const full=join(dir,entry.name);
        if(entry.isFile()&&entry.name===wanted&&(!threadId||full.includes(String(threadId))))return full;
        if(entry.isDirectory()){const found=await walk(full,depth+1);if(found)return found}
      }
      return null;
    }
    for(const root of roots.slice(1)){const found=await walk(root,0);if(found)return found}
    return null;
  }
  async function resolveVisualizationPath({workspaceRoot,path,file,threadId,environmentId}={}){
    const remote=remoteEnvironmentProfile(environmentId);
    const requested=String(path||file||"").trim();if(!requested)throw new Error("Visualization path is required");
    if(!/\.html?$/i.test(requested))throw new Error("Only HTML visualizations can be rendered");
    if(remote){
      const roots=await remoteVisualizationRoots(environmentId,workspaceRoot||remote.cwd||"/");
      let target=requested.startsWith("/")?posix.normalize(requested):posix.normalize(posix.join(roots[0],requested));
      if(!requested.includes("/")&&file){
        for(const root of roots.slice(1)){
          const args=[root,"-type","f","-name",basename(requested)];
          if(threadId)args.push("-path","*/"+String(threadId)+"/*");
          args.push("-print","-quit");
          const result=await environments.executeArgv(environmentId,{command:"find",args,cwd:"",timeoutMs:12000,maxOutput:128*1024}).catch(()=>null);
          const found=String(result?.stdout||"").split(/\r?\n/).find(Boolean);if(found){target=posix.normalize(found);break}
        }
      }
      if(!roots.some(root=>pathInside(root,target,{remote:true})))throw new Error("Visualization is outside the active workspace and Codex visualization directory");
      return {remote:true,path:target,roots};
    }
    const roots=await localVisualizationRoots(workspaceRoot);
    let target=isAbsolute(requested)?resolve(requested):resolve(roots[0],requested);
    if(!requested.includes("/")&&!requested.includes("\\")&&file){
      const found=await findLocalVisualization(roots,requested,threadId);if(found)target=found;
    }
    if(!roots.some(root=>pathInside(root,target)))throw new Error("Visualization is outside the active workspace and Codex visualization directory");
    return {remote:false,path:target,roots};
  }
  async function readVisualization({workspaceRoot,path,file,threadId,environmentId}={}){
    const located=await resolveVisualizationPath({workspaceRoot,path,file,threadId,environmentId});
    const info=located.remote?await environments.attachmentInfo(environmentId,located.path):await stat(located.path).then(item=>({size:item.size,isFile:item.isFile()}));
    if(info.isFile===false)throw new Error("Visualization path is not a file");
    if(!Number.isFinite(Number(info.size))||Number(info.size)>2*1024*1024)throw new Error("Visualization is too large to render (maximum 2 MB)");
    if(!located.remote)return {path:located.path,content:await readFile(located.path,"utf8")};
    const child=environments.streamFile(environmentId,located.path);let stdout="",stderr="";
    await new Promise((resolveRead,reject)=>{
      child.stdout.on("data",chunk=>{stdout+=String(chunk);if(Buffer.byteLength(stdout,"utf8")>2*1024*1024){try{child.kill()}catch{}reject(new Error("Visualization exceeded the 2 MB render limit"))}});
      child.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-64*1024)});
      child.once("error",reject);child.once("close",code=>code===0?resolveRead():reject(new Error(stderr.trim()||"Could not read visualization")));
    });
    return {path:located.path,content:stdout};
  }
  function worktreeUsage(){
    const activePaths=[],referencedPaths=[];
    for(const thread of agentThreads.list()){
      if(thread.cwd)referencedPaths.push(thread.cwd);
      if(thread.cwd&&(thread.status?.type==="active"||thread.recovery?.pending))activePaths.push(thread.cwd);
    }
    for(const meta of Object.values(state.listThreadMeta())){
      if(meta?.cwd&&!meta.deletedAt)referencedPaths.push(meta.cwd);
      if(meta?.cwd&&!meta.deletedAt&&meta.active)activePaths.push(meta.cwd);
    }
    for(const session of terminals?.list?.()||[])if(session?.cwd&&session.running)activePaths.push(session.cwd);
    return {activePaths,referencedPaths};
  }
  const cleanupLogs=[];
  const worktreeCleanup=new WorktreeCleanupService({state,getUsage:worktreeUsage,log:message=>{cleanupLogs.push({at:Date.now(),stream:"cleanup",text:safeLogText(String(message)+"\n")});if(cleanupLogs.length>100)cleanupLogs.splice(0,cleanupLogs.length-100)}});
  const storageCleanup=new StorageCleanupService({state,env,terminals,worktreeCleanup,log:message=>{cleanupLogs.push({at:Date.now(),stream:"storage-cleanup",text:safeLogText(String(message)+"\n")});if(cleanupLogs.length>100)cleanupLogs.splice(0,cleanupLogs.length-100)}});
  const cloneJobs=new CloneJobService({state,environments,env,log:message=>appServer?.logs?.push({at:Date.now(),stream:"clone",text:safeLogText(String(message)+"\n")})});
  await cloneJobs.recoverInterrupted();
  const codexAppServers=new Map(),codexAppServerStarts=new Map(),codexThreadServerKeys=new Map(),codexThreadReleases=new Map();
  const codexPoolKey=(ownerKey,instanceId,environmentId=state.settings().activeEnvironmentId||null)=>String(ownerKey||"catalog")+":"+(environmentId||"local")+":"+String(instanceId||"codex-default");
  function codexInstance(instanceId=null){
    const instances=agentRuntimes.instances();
    if(instanceId){const exact=instances.find(item=>item.kind==="codex"&&item.id===instanceId);if(exact)return exact}
    const active=agentRuntimes.activeInstance();if(active?.kind==="codex")return active;
    return instances.find(item=>item.kind==="codex")||null;
  }
  async function ensureCodexAppServer(instanceId=null,{environmentId=state.settings().activeEnvironmentId||null,preferredPort=null,ownerKey="catalog"}={}){
    const instance=codexInstance(instanceId);if(!instance)throw new Error("Codex runtime profile was not found");
    const key=codexPoolKey(ownerKey,instance.id,environmentId);const current=codexAppServers.get(key);
    if(current&&(mock||(!current.error&&current.child?.exitCode===null)))return current;
    if(codexAppServerStarts.has(key))return codexAppServerStarts.get(key);
    const starting=(async()=>{
      if(current){await stopAppServer(current);codexAppServers.delete(key)}
      const targetPort=preferredPort||await freeTcpPort();
      const started=await startAppServer({appPort:targetPort,env,mock,provider:selectedProvider,providerPort:selectedInferencePort(),environments,environmentId,runtimeInstance:instance});
      started.poolKey=key;started.ownerKey=ownerKey;started.runtimeInstanceId=instance.id;started.environmentId=environmentId||null;started.continuationKey=agentRuntimes.continuationKey(instance);
      codexAppServers.set(key,started);
      if(!mock){const ready=await waitForAppServer(started,targetPort,15000).catch(()=>false);if(!ready&&!started.error)started.error=`Codex app-server profile '${instance.displayName||instance.id}' did not become ready`}
      return started;
    })();
    codexAppServerStarts.set(key,starting);
    try{return await starting}finally{codexAppServerStarts.delete(key)}
  }
  async function stopCodexAppServers(){
    if(codexThreadReleases.size)await Promise.allSettled([...codexThreadReleases.values()]);
    const servers=[...codexAppServers.values()];codexAppServers.clear();
    codexThreadServerKeys.clear();codexThreadReleases.clear();
    await Promise.all(servers.map(server=>stopAppServer(server)));
  }
  async function releaseCodexThreadServer(threadId){
    const id=String(threadId||"").trim();if(!id)return;
    if(codexThreadReleases.has(id))return codexThreadReleases.get(id);
    const releasing=(async()=>{
      const key=codexThreadServerKeys.get(id);codexThreadServerKeys.delete(id);if(!key)return;
      const server=codexAppServers.get(key);codexAppServers.delete(key);codexAppServerStarts.delete(key);
      if(server)await stopAppServer(server);
    })();
    codexThreadReleases.set(id,releasing);
    try{return await releasing}finally{if(codexThreadReleases.get(id)===releasing)codexThreadReleases.delete(id)}
  }
  let appServer=await ensureCodexAppServer(agentRuntimes.activeRuntime()==="codex"?agentRuntimes.activeInstance().id:null,{preferredPort:appPort,ownerKey:"catalog"});
  let remoteControl=null;

  function providerReady(providerId=selectedProvider){
    return providerId==="freebuff" ? (mock || isLoggedIn(env)) : (mock || providers.hasKey(providerId));
  }
  function codexGoalTurns(meta={}){
    const completed=Array.isArray(meta.codexTurnTimings)?meta.codexTurnTimings:[],recovery=meta.restartRecovery;
    if(recovery?.runtime!=="codex"||recovery?.status!=="active"||!recovery.turnId||!Number(recovery.startedAt))return completed;
    return [...completed,{id:String(recovery.turnId),startedAt:Math.floor(Number(recovery.startedAt)/1000),durationMs:null,status:"inProgress"}];
  }
  function durableCodexGoal(threadId){
    const meta=state.threadMeta(threadId),raw=meta?.goal;if(!raw)return null;
    const createdAt=Number(raw.createdAt)||Date.now(),goal=normalizeGoal({threadId,previous:{...raw,createdAt},patch:{},now:Number(raw.updatedAt)||Date.now()});
    const baselines=meta?.goalBudgetBaselines||null;
    const toolCallsUsed=baselines?Math.max(0,Number(meta?.codexToolCallCount||0)-Number(baselines.toolCalls||0)):0;
    const childAgentsUsed=baselines?Math.max(0,Number(meta?.codexChildAgentCount||0)-Number(baselines.childAgents||0)):0;
    return enrichGoal(goal,{
      usage:state.threadUsage(threadId,{since:goal.createdAt}),turns:codexGoalTurns(meta),
      toolCallsUsed,toolCallTelemetryComplete:Boolean(baselines?.toolCallTelemetryComplete),
      childAgentsUsed,childAgentTelemetryComplete:Boolean(baselines?.childAgentTelemetryComplete),
    });
  }
  function durableCodexContinuity(threadId){
    const meta=state.threadMeta(threadId);
    return continuitySnapshot({
      threadId,thread:{id:threadId,cwd:meta?.cwd||null,runtime:"codex",runtimeInstanceId:meta?.runtimeInstanceId||null,turns:codexGoalTurns(meta)},meta,goal:durableCodexGoal(threadId),
      verificationRecords:state.verificationRecords({threadId,limit:10}),
      checkpoints:state.checkpoints(threadId),
      traces:eventJournal.list({threadId,limit:80}),
    });
  }
  function codexVerificationState(threadId,recordId=null){
    const records=state.verificationRecords({threadId,limit:50});
    if(!records.length)return {record:null,nextAction:null};
    return verificationRepairState(records,recordId);
  }
  async function repairCodexVerification(threadId,params,requestUpstream){
    const meta=state.threadMeta(threadId);if(meta.active)throw new Error("Stop the running turn before starting verification repair.");
    assertCodexGoalBudget(threadId);
    const {record,nextAction}=codexVerificationState(threadId,params.recordId||null);
    if(!record)throw new Error("No persisted verification record is available for this thread.");
    if(nextAction.action!=="repair")throw new Error("Latest verification does not require repair (next action: "+nextAction.action+").");
    const repairContext=verificationRepairContext({record,nextAction});
    const withGoal=goalAdditionalContext({},durableCodexGoal(threadId));
    const withContinuity=continuityAdditionalContext(withGoal,durableCodexContinuity(threadId));
    const additionalContext={...(withContinuity||{}),"trebell.verification_repair":{kind:"application",value:repairContext}};
    const model=codexThreadModels.get(threadId)||null;
    const turnParams={
      threadId,cwd:meta?.cwd||undefined,approvalPolicy:params.approvalPolicy,sandboxPolicy:params.sandboxPolicy,
      input:[{type:"text",text:verificationRepairPrompt(),textElements:[]}],additionalContext,...(model?{model}:{}),
    };
    for(const key of Object.keys(turnParams))if(turnParams[key]===undefined)delete turnParams[key];
    const started=await requestUpstream("turn/start",turnParams,{routeMessage:{method:"thread/read",params:{threadId}},timeoutMs:120_000});
    eventJournal.record({runtime:"codex",provider:selectedProvider,environmentId:meta?.environmentId??null,threadId,turnId:started?.turn?.id||null,category:"verification",name:"verification.repair_started",status:"running",data:{recordId:record.id,nextAction:nextAction.action,failedSteps:nextAction.failedSteps||[]}});
    return {record,nextAction,turn:started?.turn||null};
  }
  function assertCodexGoalBudget(threadId){
    const goal=durableCodexGoal(threadId),gate=goalBudgetGate(goal,{includeChildAgents:false});if(gate.allowed)return goal;
    const meta=state.threadMeta(threadId);
    eventJournal.record({runtime:"codex",provider:selectedProvider,environmentId:meta?.environmentId??state.settings().activeEnvironmentId??null,threadId,category:"budget",name:"goal.budget_blocked",status:"blocked",data:{goalStatus:goal?.status||null,tokenBudget:goal?.tokenBudget??null,tokensUsed:goal?.tokensUsed??0,timeBudgetMinutes:goal?.timeBudgetMinutes??null,timeUsedSeconds:goal?.timeUsedSeconds??0,turnBudget:goal?.turnBudget??null,turnsUsed:goal?.turnsUsed??0,toolCallBudget:goal?.toolCallBudget??null,toolCallsUsed:goal?.toolCallsUsed??0,toolCallTelemetryComplete:goal?.toolCallTelemetryComplete??true,childAgentBudget:goal?.childAgentBudget??null,childAgentsUsed:goal?.childAgentsUsed??null,childAgentTelemetryComplete:goal?.childAgentTelemetryComplete??false,costBudgetUsd:goal?.costBudgetUsd??null,costUsedUsd:goal?.costUsedUsd??null,costTelemetryComplete:goal?.costTelemetryComplete??true,tokenExhausted:gate.tokenExhausted,timeExhausted:gate.timeExhausted,turnExhausted:gate.turnExhausted,toolCallExhausted:gate.toolCallExhausted,childAgentExhausted:gate.childAgentExhausted,costExhausted:gate.costExhausted}});
    throw Object.assign(new Error(gate.reason),{code:-32001});
  }
  const pendingDelegations=new Map();
  function reserveCodexDelegation(threadId){
    const goal=durableCodexGoal(threadId),pending=Math.max(0,Number(pendingDelegations.get(threadId))||0);
    if(goal?.childAgentBudget!=null&&goal.childAgentTelemetryComplete&&Number(goal.childAgentsUsed||0)+pending>=Number(goal.childAgentBudget)){
      throw Object.assign(new Error(`Goal budget exhausted: child-agent budget exhausted (${Number(goal.childAgentsUsed||0)+pending}/${goal.childAgentBudget}). Increase the exhausted budget before delegating more work.`),{code:-32001});
    }
    assertCodexGoalBudget(threadId);
    pendingDelegations.set(threadId,pending+1);
    return ()=>{const next=Math.max(0,(Number(pendingDelegations.get(threadId))||1)-1);if(next)pendingDelegations.set(threadId,next);else pendingDelegations.delete(threadId)};
  }
  async function prepareCodexDelegationWorkspace(parentThreadId,spec,parentThread=null){
    const meta=state.threadMeta(parentThreadId),sourceCwd=String(meta?.cwd||parentThread?.cwd||"").trim();
    if(!sourceCwd)throw new Error("Delegation requires a parent workspace");
    if(spec.isolation==="inherit")return {cwd:sourceCwd,branch:meta?.branch||null,isolation:"inherit",worktree:false};
    const environmentId=meta?.environmentId??parentThread?.providerMeta?.environmentId??null;
    if(environmentId)throw new Error("Isolated delegation worktrees are currently supported only for local workspaces. Use isolation='inherit' for remote environments.");
    const info=await gitInfo(sourceCwd);if(!info.isGit)throw new Error("Worktree delegation requires a Git workspace");if(!info.branch)throw new Error("Worktree delegation requires a checked-out base branch");
    const label=spec.label||spec.model||spec.task.split(/\s+/).slice(0,4).join("-");
    const slug=String(label||"agent").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,28)||"agent";
    const stamp=Date.now().toString(36)+randomBytes(2).toString("hex");
    const branch=`trebell/delegate-${slug}-${stamp}`,path=info.root+`-trebell-delegate-${slug}-${stamp}`;
    const sourceProject=state.project(resolve(sourceCwd),null),scoped=sourceProject?state.projectSettings(sourceProject.path,null):{defaults:state.environmentDefaults(null),overrides:{}};
    const submodules=scoped.overrides.worktreeSubmodules||scoped.defaults.worktreeSubmodules||"recursive";
    let created=null;
    try{
      created=await createWorktree(sourceCwd,{branch,path,baseBranch:info.branch,submodules});
      const inherited=sourceProject?{
        defaultModel:sourceProject.defaultModel??null,permissionMode:sourceProject.permissionMode??null,workspaceMode:sourceProject.workspaceMode??null,
        worktreeSubmodules:sourceProject.worktreeSubmodules??null,worktreeCleanup:sourceProject.worktreeCleanup??null,settingsOverrides:sourceProject.settingsOverrides||{},
        icon:sourceProject.icon??null,scripts:sourceProject.scripts||[],preferredScriptId:sourceProject.preferredScriptId??null,
      }:{};
      state.touchProject(created.worktree,{...inherited,environmentId:null,managedWorktree:{root:created.info.root,branch,baseBranch:info.branch,submodules,createdAt:Date.now(),cleanedAt:null,cleanupReason:null}});
      const setup=(sourceProject?.scripts||[]).find(script=>script.runOnWorktreeCreate);
      let setupSession=null;
      if(setup&&!mock&&terminals){
        const shell=commandShellSpec(setup.command,env);
        setupSession=await terminals.create({cwd:created.worktree,name:`${setup.name||"Setup"} · delegated setup`,cols:120,rows:32,shell:shell.shell,args:shell.args});
        if(setup.waitForSetup){
          const settled=await terminals.waitForExit(setupSession.id,{timeoutMs:30*60_000});
          if(settled.timeout)throw new Error("Delegated worktree setup is still running after 30 minutes");
          if(settled.exitCode!==0)throw new Error(`Delegated worktree setup failed with exit code ${settled.exitCode??"unknown"}`);
        }
      }
      return {cwd:created.worktree,branch,isolation:"worktree",worktree:true,baseBranch:info.branch,setupSessionId:setupSession?.id||null};
    }catch(error){
      if(created?.worktree)await removeWorktree(sourceCwd,created.worktree,{force:true}).catch(()=>{});
      throw error;
    }
  }
  async function delegateCodexThread(params,requestUpstream){
    const parentThreadId=String(params.threadId||params.parentThreadId||"").trim();if(!parentThreadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
    const parentMeta=state.threadMeta(parentThreadId);
    return executeDelegation({
      parentThreadId,request:params,
      reserve:()=>reserveCodexDelegation(parentThreadId),
      prepareWorkspace:({spec})=>prepareCodexDelegationWorkspace(parentThreadId,spec),
      startThread:async({spec,workspace})=>{
        const model=spec.model||codexThreadModels.get(parentThreadId)||null,policy=delegationPolicies(spec.permissions,workspace.cwd);
        const startParams={cwd:workspace.cwd,modelProvider:selectedProvider,approvalPolicy:policy.approvalPolicy,sandbox:policy.sandbox,ephemeral:false,threadSource:"trebell-delegate",...(model?{model}:{})};
        const started=await requestUpstream("thread/start",startParams,{routeMessage:{method:"thread/read",params:{threadId:parentThreadId}},timeoutMs:120_000});
        return started?.thread||null;
      },
      configureChild:async({spec,workspace,childThread,delegationId})=>{
        const childId=String(childThread.id),model=spec.model||codexThreadModels.get(parentThreadId)||childThread.model||null,goal=normalizeGoal({threadId:childId,patch:delegationGoalPatch(spec)});
        state.updateThreadMeta(childId,{
          cwd:workspace.cwd,branch:workspace.branch||null,runtime:"codex",runtimeInstanceId:parentMeta?.runtimeInstanceId||null,environmentId:parentMeta?.environmentId??null,
          permissionProfile:agentPermissionModeFromStart({permissionProfile:spec.permissions}),
          parentThreadId,delegation:{id:delegationId,parentThreadId,task:spec.task,permission:spec.permissions,requestedPermission:spec.permission,isolation:spec.isolation==="inherit"?"shared":"worktree",requestedIsolation:spec.requestedIsolation,ownership:spec.ownership,model,createdAt:Date.now(),status:"running"},
          goal,goalBudgetBaselines:{toolCalls:0,childAgents:0,toolCallTelemetryComplete:true,childAgentTelemetryComplete:true},
        });
        const parentServerKey=codexThreadServerKeys.get(parentThreadId);if(parentServerKey)codexThreadServerKeys.set(childId,parentServerKey);
        recordCodexChildAgentEvidence(state,{id:childId,parentThreadId});codexThreadModels.set(childId,model||null);
      },
      startTurn:async({spec,workspace,childThread})=>{
        const model=spec.model||codexThreadModels.get(parentThreadId)||childThread.model||null,policy=delegationPolicies(spec.permissions,workspace.cwd);
        const delegationContext=delegationContextValue({parentThreadId,spec});
        const turnParams={threadId:String(childThread.id),cwd:workspace.cwd,approvalPolicy:policy.approvalPolicy,sandboxPolicy:policy.sandboxPolicy,input:[{type:"text",text:spec.task,textElements:[]}],additionalContext:{"trebell.delegation":{kind:"application",value:delegationContext}},...(model?{model}:{})};
        const turnStarted=await requestUpstream("turn/start",turnParams,{routeMessage:{method:"thread/read",params:{threadId:String(childThread.id)}},timeoutMs:120_000});
        state.updateThreadMeta(String(childThread.id),{delegation:{...state.threadMeta(String(childThread.id)).delegation,turnId:turnStarted?.turn?.id||null}});
        return turnStarted?.turn||null;
      },
      cleanupWorkspace:async({workspace})=>{if(workspace?.worktree)await removeWorktree(parentMeta?.cwd||workspace.cwd,workspace.cwd,{force:true}).catch(()=>{})},
      markFailed:async({childThread,error})=>{
        const childId=String(childThread.id),meta=state.threadMeta(childId);
        state.updateThreadMeta(childId,{delegation:{...(meta.delegation||{}),status:"failed",error:error.message||String(error),failedAt:Date.now()}});
      },
      onStarted:async result=>{
        const childId=String(result.thread.id),publicThread={...result.thread,parentThreadId,agentRole:"delegate"};
        eventJournal.record({runtime:"codex",provider:selectedProvider,environmentId:parentMeta?.environmentId??null,threadId:parentThreadId,turnId:result.turn?.id||null,category:"delegation",name:"delegation.started",status:"running",data:{delegationId:result.delegationId,childThreadId:childId,isolation:result.isolation,permissions:result.permission,branch:result.workspace?.branch||null}});
        relay.broadcast("thread/delegated",{threadId:parentThreadId,delegationId:result.delegationId,childThreadId:childId,thread:publicThread,turn:result.turn||null,workspace:result.workspace});
        result.thread=publicThread;
      },
    });
  }
  function codexPermissionProfilePatch(params={}){
    const hasPolicy=Object.prototype.hasOwnProperty.call(params,"permissionProfile")||Object.prototype.hasOwnProperty.call(params,"approvalPolicy")||Object.prototype.hasOwnProperty.call(params,"sandbox")||Object.prototype.hasOwnProperty.call(params,"sandboxPolicy");
    return hasPolicy?{permissionProfile:agentPermissionModeFromStart(params)}:{};
  }
  function withCodexRepositoryTools(message){
    if(message?.method!=="thread/start")return message;
    const params=message.params||{},existing=Array.isArray(params.dynamicTools)?params.dynamicTools:[];
    const repositoryNamespace=repositoryDynamicToolNamespace()[0];
    const dynamicTools=[...existing.filter(item=>String(item?.name||"")!=="trebell_repo"),repositoryNamespace];
    return {...message,params:{...params,dynamicTools}};
  }
  async function resolveCodexRepositoryTool(message){
    const params=message?.params||{};
    if(message?.method!=="item/tool/call"||params.namespace!=="trebell_repo")return null;
    const threadId=String(params.threadId||"").trim();
    if(!threadId)return {handled:true,result:{contentItems:[{type:"inputText",text:"A Trebell thread is required before querying repository intelligence."}],success:false}};
    const meta=state.threadMeta(threadId),root=meta?.cwd||null;
    if(!root)return {handled:true,result:{contentItems:[{type:"inputText",text:"The active thread has no pinned workspace for repository intelligence."}],success:false}};
    const definition=REPOSITORY_TOOL_DEFINITIONS.find(item=>item.name===params.tool);
    if(!definition)return {handled:true,result:{contentItems:[{type:"inputText",text:"Unknown Trebell repository tool: "+String(params.tool||"")}],success:false}};
    const environmentId=Object.prototype.hasOwnProperty.call(meta||{},"environmentId")?meta.environmentId:null,profile=environmentId?environments.get(environmentId):null;
    const io=profile&&profile.type!=="local"?createRemoteContextIo({environments,environmentId,root}):null;
    const handlers=repositoryToolHandlers({contextEngine,root,io,knowledgeService:repositoryKnowledge,environmentId});
    const traceBase={runtime:"codex",provider:selectedProvider,environmentId,threadId:threadId||null,turnId:params.turnId||null,category:"tool"};
    try{
      const args=definition.inputSchema.parse(params.arguments||{});
      const result=await invokeRepositoryTool(handlers,definition,args);
      eventJournal.record({...traceBase,name:"repository_tool.completed",status:"completed",data:{tool:definition.name}});
      return {handled:true,result:{contentItems:[{type:"inputText",text:JSON.stringify(result)}],success:true}};
    }catch(error){
      eventJournal.record({...traceBase,name:"repository_tool.completed",status:"failed",data:{tool:definition.name,message:error?.message||String(error)}});
      return {handled:true,result:{contentItems:[{type:"inputText",text:error?.message||String(error)}],success:false}};
    }
  }
  function resolveCodexServerApproval(message){
    const params=message?.params||{},threadId=params.threadId?String(params.threadId):null,meta=threadId?state.threadMeta(threadId):{};
    const resolved=resolveCodexApprovalByPolicy(message,{
      profile:meta?.permissionProfile||"supervised",workspace:meta?.cwd||null,
      rules:Array.isArray(state.settings().policyRules)?state.settings().policyRules:[],
      provenance:params?._meta?.provenance||params.provenance||"unknown",
    });
    if(!resolved?.policy)return null;
    const action=resolved.policy.action,base={runtime:"codex",provider:selectedProvider,environmentId:meta?.environmentId??state.settings().activeEnvironmentId??null,threadId,turnId:params.turnId||null,category:"policy"};
    const data={
      method:message.method,decision:resolved.policy.decision,reason:resolved.policy.reason,profile:resolved.policy.profile,
      action:action.action,kind:action.kind,riskLevel:action.riskLevel,reversibility:action.reversibility,idempotent:action.idempotent,
      externalSideEffect:action.externalSideEffect,pathInsideWorkspace:action.pathInsideWorkspace,networkHost:action.networkHost||null,provenance:action.provenance,
    };
    eventJournal.record({...base,name:"permission.requested",status:"pending",data:{method:message.method,action:action.action,kind:action.kind}});
    eventJournal.record({...base,name:"policy.decision",status:resolved.policy.decision.toLowerCase(),data});
    if(!resolved.handled)return null;
    eventJournal.record({...base,name:"permission.resolved",status:resolved.policy.decision==="ALLOW"?"accept":"decline",data:{method:message.method,policyDecision:resolved.policy.decision}});
    return {handled:true,result:resolved.result};
  }
  async function resolveCodexServerRequest(message){
    return await resolveCodexRepositoryTool(message)||resolveCodexServerApproval(message);
  }
  async function withCodexGoalContext(message){
    if(message?.method!=="turn/start")return message;
    const params=message.params||{},threadId=params.threadId?String(params.threadId):"";if(!threadId)return message;
    const goalContext=goalAdditionalContext(params.additionalContext,durableCodexGoal(threadId));
    let additionalContext=continuityAdditionalContext(goalContext,durableCodexContinuity(threadId));
    const meta=state.threadMeta(threadId),projectPath=meta?.cwd||params.cwd||null;
    if(projectPath){
      const query=(Array.isArray(params.input)?params.input:[]).filter(item=>item?.type==="text").map(item=>String(item.text||"")).join("\n").slice(0,4000);
      try{
        const knowledge=await repositoryKnowledge.context({projectPath,environmentId:meta?.environmentId??null,query,limit:12,refresh:true});
        if(knowledge.context)additionalContext={...additionalContext,"trebell.repository_knowledge":{kind:"application",value:knowledge.context}};
      }catch(error){
        appServer?.logs?.push({at:Date.now(),stream:"repository-knowledge",text:safeLogText((error?.message||String(error))+"\n")});
      }
    }
    if(additionalContext===params.additionalContext)return message;
    return {...message,params:{...params,additionalContext}};
  }
  async function transformCodexClientMessage(message){
    return withCodexGoalContext(withCodexRepositoryTools(message));
  }
  function markCodexTurnActive(threadId,turnId){
    if(!threadId||!turnId)return;
    state.updateThreadMeta(threadId,{active:true,restartRecovery:{runtime:"codex",bootId,threadId,turnId,status:"active",startedAt:Date.now()}});
  }
  function clearCodexRecovery(threadId,status="completed",message=null){
    if(!threadId)return;
    const meta=state.threadMeta(threadId),current=meta?.restartRecovery,finishedAt=Date.now();let codexTurnTimings=Array.isArray(meta?.codexTurnTimings)?meta.codexTurnTimings:[];
    if(current?.runtime==="codex"&&current.turnId&&Number(current.startedAt)){
      const timing={id:String(current.turnId),startedAt:Math.floor(Number(current.startedAt)/1000),durationMs:Math.max(0,finishedAt-Number(current.startedAt)),status};
      codexTurnTimings=[...codexTurnTimings.filter(item=>String(item?.id||item?.turnId||"")!==timing.id),timing].slice(-500);
    }
    state.updateThreadMeta(threadId,{active:false,codexTurnTimings,restartRecovery:current?{...current,bootId,status,finishedAt,...(message?{message}:{})}:undefined});
  }
  function codexRecoverySnapshot(){
    const enabled=Boolean(state.settings().continueThreadsAfterRestart);
    const items=[];
    for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
      const recovery=meta?.restartRecovery;
      if(recovery?.runtime==="codex"&&recovery?.status==="pending"&&recovery.bootId!==bootId&&recovery.turnId)items.push({threadId,turnId:recovery.turnId,startedAt:recovery.startedAt||null});
    }
    return {enabled,bootId,items};
  }

  async function restartAppServer(providerId=selectedProvider){
    const next=normalizeProviderId(providerId);
    await stopCodexAppServers();
    selectedProvider=next;
    providerBridge?.setProvider(selectedProvider);
    ensureCodexConfig({port:selectedInferencePort(),env,provider:selectedProvider});
    appServer=await ensureCodexAppServer(agentRuntimes.activeRuntime()==="codex"?agentRuntimes.activeInstance().id:null,{preferredPort:appPort,ownerKey:"catalog"});
    return selectedProvider;
  }

  function importedHistorySourceIds(){
    const ids=new Set();
    for(const meta of Object.values(state.listThreadMeta())){
      if(meta?.deletedAt)continue;
      const sourceId=String(meta?.historyImport?.sourceId||"").trim();if(sourceId)ids.add(sourceId);
    }
    for(const thread of agentThreads.list()){
      const sourceId=String(thread?.providerMeta?.historyImport?.sourceId||"").trim();if(sourceId)ids.add(sourceId);
    }
    return ids;
  }
  async function localAgentHistory(){
    const candidates=await scanLocalAgentHistory({
      env,
      excludeHomes:[appServer?.runtimeHome,appServer?.sharedRuntimeHome].filter(Boolean),
      includeClaude:env.TREBELL_HISTORY_DISABLE_CLAUDE!=="1",
    });
    const imported=importedHistorySourceIds();
    return {candidates,publicCandidates:candidates.map(candidate=>publicHistoryCandidate(candidate,{alreadyImported:imported.has(candidate.id)}))};
  }
  async function importAgentHistory(sourceIds=[]){
    const ids=[...new Set((sourceIds||[]).map(value=>String(value||"").trim()).filter(Boolean))].slice(0,50);
    if(!ids.length)throw new Error("Choose at least one history session to import");
    const {candidates}=await localAgentHistory();const byId=new Map(candidates.map(candidate=>[candidate.id,candidate]));
    const importedSources=importedHistorySourceIds();const results=[];let codexClient=null;
    try{
      for(const id of ids){
        const candidate=byId.get(id);
        if(!candidate){results.push({id,status:"error",error:"History session is no longer available"});continue}
        if(importedSources.has(id)){results.push({id,source:candidate.source,status:"skipped",reason:"already_imported"});continue}
        try{
          if(candidate.source==="claude"){
            const result=await importClaudeHistory(agentThreads,candidate);
            const thread=result.thread;
            state.updateThreadMeta(thread.id,{cwd:candidate.cwd,environmentId:null,historyImport:{source:"claude",sourceId:id,providerSessionId:candidate.providerSessionId,importedAt:Date.now()}});
            state.touchProject(candidate.cwd,{environmentId:null});
            importedSources.add(id);
            results.push({id,source:"claude",status:result.status,threadId:thread.id});
            continue;
          }
          if(candidate.source==="codex"){
            if(selectedAgentRuntime!=="codex")throw new Error("Switch the active coding harness to Codex before importing Codex history");
            if(state.settings().activeEnvironmentId)throw new Error("Codex history import is local-only. Switch the active environment to Local machine first");
            if(!appServer?.targetUrl||appServer?.environment)throw new Error("Local Codex app-server is not available");
            if(!await waitForAppServer(appServer,appPort,15_000))throw new Error("Local Codex app-server is not ready");
            if(!codexClient){codexClient=new CodexAppServerClient(appServer.targetUrl,{clientVersion:TREBELL_VERSION});await codexClient.connect()}
            const forked=await codexClient.forkFromRollout({threadId:candidate.providerSessionId,path:candidate.sourcePath,cwd:candidate.cwd,modelProvider:selectedProvider});
            const threadId=String(forked?.thread?.id||"").trim();if(!threadId)throw new Error("Codex did not return the imported thread");
            if(candidate.title)await codexClient.request("thread/name/set",{threadId,name:candidate.title}).catch(()=>{});
            state.updateThreadMeta(threadId,{cwd:candidate.cwd,environmentId:null,historyImport:{source:"codex",sourceId:id,sourceThreadId:candidate.providerSessionId,importedAt:Date.now()}});
            state.touchProject(candidate.cwd,{environmentId:null});
            importedSources.add(id);
            results.push({id,source:"codex",status:"imported",threadId});
            continue;
          }
          results.push({id,source:candidate.source,status:"error",error:"Unsupported history source"});
        }catch(error){results.push({id,source:candidate.source,status:"error",error:error instanceof Error?error.message:String(error)})}
      }
    }finally{codexClient?.close()}
    return results;
  }

  async function selectedModels(){
    const mergeCustom=catalog=>{
      if(!["codex","claude","opencode"].includes(selectedAgentRuntime))return catalog;
      const custom=(state.settings().customModels||[]).filter(item=>item&&item.id&&item.runtime===selectedAgentRuntime&&(selectedAgentRuntime!=="codex"||item.provider===selectedProvider));
      if(!custom.length)return catalog;
      const baseModels=Array.isArray(catalog.models)?catalog.models:[];const models=[...baseModels];for(const item of custom)if(!models.includes(item.id))models.push(item.id);
      const metadataModels=[...(catalog.metadata?.models||[])];for(const item of custom){const index=metadataModels.findIndex(model=>model.id===item.id);const meta={id:item.id,name:item.name||item.id,provider:selectedAgentRuntime==="codex"?selectedProvider:selectedAgentRuntime,agent:selectedAgentRuntime,custom:true,effort:item.effort||null,serviceTier:item.serviceTier||null};if(index>=0)metadataModels[index]={...metadataModels[index],...meta};else metadataModels.push(meta)}
      return {...catalog,models,metadata:{...(catalog.metadata||{}),models:metadataModels}};
    };
    if(selectedAgentRuntime!=="codex"){
      const result=await agentRuntimes.models(agentRuntimes.activeInstance());
      return mergeCustom({models:result.models||[],metadata:{provider:selectedAgentRuntime,agentRuntime:selectedAgentRuntime,source:result.source,models:result.metadata||[]},error:result.error||null});
    }
    if(mock) return mergeCustom({models:fakeModels(selectedProvider),metadata:{provider:selectedProvider,models:fakeModels(selectedProvider).map(id=>({id,provider:selectedProvider}))}});
    if(selectedProvider==="freebuff"){
      if(!isLoggedIn(env)) return mergeCustom({models:[],metadata:{provider:"freebuff",models:[]}});
      await ensureBridge();
      const [models,metadata]=await Promise.all([
        listModels(DEFAULT_PORT),
        listModelMetadata(DEFAULT_PORT).catch(()=>({registry:null,models:[]})),
      ]);
      return mergeCustom({models:models.filter(id=>id.startsWith("freebuff/")),metadata:{...metadata,provider:"freebuff"}});
    }
    const result=await providers.models(selectedProvider);
    return mergeCustom({models:result.models||[],metadata:{provider:selectedProvider,source:result.source,models:result.metadata||[]},error:result.error||null});
  }

  function newRemoteToken(){ return randomBytes(24).toString("base64url"); }
  function remoteInfo(){
    const settings=state.settings();
    return {
      enabled:Boolean(settings.remoteAccessEnabled),
      running:Boolean(remoteControl),
      port:Number(settings.remoteAccessPort||3211),
      urls:remoteControl?.urls||[],
      devices:remoteAuth.listDevices(),
    };
  }
  async function syncRemoteControl(){
    const settings=state.settings();
    if(!settings.remoteAccessEnabled){
      if(remoteControl){await remoteControl.close().catch(()=>{});remoteControl=null}
      return remoteInfo();
    }
    let token=remoteAccessSecrets.getToken();
    if(!token){
      token=newRemoteToken();
      remoteAccessSecrets.setToken(token);
    }
    if(remoteControl){await remoteControl.close().catch(()=>{});remoteControl=null}
    const remotePort=Math.max(1024,Math.min(65535,Number(settings.remoteAccessPort)||3211));
    remoteControl=await createRemoteControlServer({
      port:remotePort,
      token,
      version:TREBELL_VERSION,
      appPort,
      targetUrl:()=>selectedAgentRuntime==="codex"
        ? `ws://127.0.0.1:${port}/api/codex/ws`
        : `ws://127.0.0.1:${port}/api/agent/ws`,
      enabled:()=>selectedAgentRuntime==="codex" ? (mock || Boolean(appServer?.child && appServer.child.exitCode===null)) : true,
      environments,
      authStore:remoteAuth,
      getStatus:async()=>{
        const catalog=await selectedModels().catch(()=>({models:[]}));
        const agentStatus=selectedAgentRuntime==="codex"?null:await agentRuntimes.probe(agentRuntimes.activeInstance()).catch(()=>null);
        return {
          cwd:process.cwd(),
          loggedIn:mock||isLoggedIn(env),
          agentRuntime:selectedAgentRuntime,
          agentRuntimeStatus:agentStatus,
          provider:selectedProvider,
          providerReady:selectedAgentRuntime==="codex"?providerReady():Boolean(agentStatus?.available),
          appServerReady:mock||await appServerReady(appServer,appPort),
          model:catalog.models?.[0]||null,
          projects:state.projects(),
        };
      },
    });
    return remoteInfo();
  }

  async function ensureBridge(){
    if(mock) return null;
    if(await health(DEFAULT_PORT)) return bridge;
    if(!isLoggedIn(env)) return null;
    bridge=await startBridge({port:DEFAULT_PORT,env,quiet:true});
    return bridge;
  }

  async function queryFreebuff(prompt,model){
    if(mock) return {text:`Mock Freebuff reply: ${prompt}`,model};
    if(!isLoggedIn(env)) throw new Error("Sign in to Freebuff first.");
    await ensureBridge();
    const response=await fetchImpl(`http://127.0.0.1:${DEFAULT_PORT}/v1/chat/completions`,{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({model,messages:[{role:"user",content:prompt}],stream:false}),
      signal:AbortSignal.timeout(300000),
    });
    const raw=await response.text();
    if(!response.ok) throw new Error(raw.slice(0,1200)||`Freebuff HTTP ${response.status}`);
    const parsed=JSON.parse(raw);
    return {text:parsed?.choices?.[0]?.message?.content ?? "",model,raw:parsed};
  }
  function sourceControlStyleInstruction(style,kind,customInstructions=""){
    if(style==="conventional")return kind==="review"
      ?"Keep the pull request title concise and specific. Do not force Conventional Commit syntax into the pull request title."
      :"Use Conventional Commits for the commit subject. Prefer the narrowest accurate type and include a scope only when it is obvious from the diff.";
    if(style==="custom")return customInstructions?"Follow these source-control writing instructions exactly:\n"+customInstructions:"Use a clear, specific engineering style and avoid filler.";
    return kind==="review"
      ?"Follow the repository's established pull request title and body style when examples are available."
      :"Follow the repository's established commit message style when examples are available.";
  }
  async function sourceControlWritingContext(cwd,environmentId,{includeRepositoryInstructions=false,includeReviewTemplate=false}={}){
    const subjects=includeRepositoryInstructions?await inSourceControlEnvironment(environmentId,()=>sourceControlRecentCommitSubjects(cwd,{limit:10})).catch(()=>[]):[];
    const instructions=[];const paths=[];
    if(includeRepositoryInstructions)paths.push("AGENTS.md","CLAUDE.md","CONTRIBUTING.md");
    for(const relativePath of [...new Set(paths)]){
      try{
        const filePath=remoteEnvironmentProfile(environmentId)?relativePath:join(cwd,relativePath);
        const file=await environmentWorkspaceFile(filePath,12_000,{root:cwd,environments,environmentId});
        const content=String(file.content||"").trim();if(content)instructions.push({path:relativePath,content});
      }catch{}
    }
    const reviewTemplate=includeReviewTemplate
      ?await inSourceControlEnvironment(environmentId,()=>sourceControlPullRequestTemplate(cwd)).catch(()=>null)
      :null;
    return {subjects,instructions,reviewTemplate};
  }
  async function sourceControlTextRequest({cwd,environmentId,kind,model=null}){
    const scoped=state.projectSettings(cwd,environmentId).effective;
    const style=scoped.sourceControlTextStyle||"repository";const selectedModel=scoped.sourceControlTextModel||model||null;
    const customInstructions=String(scoped.sourceControlCustomInstructions||"").trim();const followTemplates=scoped.sourceControlFollowTemplates!==false;
    const diff=kind==="review"
      ?await inSourceControlEnvironment(environmentId,()=>sourceControlReviewRangeContext(cwd))
      :await environmentWorkspaceDiff(cwd,{environments,environmentId});
    const context=await sourceControlWritingContext(cwd,environmentId,{includeRepositoryInstructions:style==="repository",includeReviewTemplate:kind==="review"&&followTemplates});
    const recent=context.subjects.length?"Recent commit subjects:\n"+context.subjects.map(subject=>"- "+subject).join("\n")+"\n\n":"";
    const instructions=context.instructions.length?"Repository guidance:\n"+context.instructions.map(item=>"### "+item.path+"\n"+item.content.slice(0,6000)).join("\n\n")+"\n\n":"";
    const template=context.reviewTemplate?"Repository pull request template:\n"+String(context.reviewTemplate).slice(0,8000)+"\n\n":"";
    const styleInstruction=sourceControlStyleInstruction(style,kind,customInstructions);
    const prompt=kind==="review"
      ?[
        "Generate a pull request title and description for the current change.",
        styleInstruction,
        "Return strict JSON only with this shape: {\"title\":\"...\",\"body\":\"...\"}.",
        "Keep the title under 100 characters. The body should summarize the change and validation without inventing tests or results.",
        recent,instructions,template,
        diff.baseRef?"Base: "+diff.baseRef:null,
        diff.commitSummary?"Branch commits:\n"+String(diff.commitSummary).slice(0,12000):null,
        diff.diffSummary?"Branch diff summary:\n"+String(diff.diffSummary).slice(0,12000):null,
        "Diff:\n"+String(diff.diff||"").slice(0,60000),
      ].filter(Boolean).join("\n\n")
      :[
        "Write one Git commit subject for the current change.",
        styleInstruction,
        "Keep the subject under 100 characters. Return only the subject with no quotes or markdown.",
        recent,instructions,"Status:\n"+String(diff.status||"").slice(0,12000),"Diff:\n"+String(diff.diff||"").slice(0,60000),
      ].filter(Boolean).join("\n\n");
    if(mock)return kind==="review"
      ?{text:JSON.stringify({title:"Mock generated review",body:"Mock generated description."}),style,model:selectedModel,prompt}
      :{text:"Mock generated commit",style,model:selectedModel,prompt};
    const answer=selectedProvider==="freebuff"
      ?await queryFreebuff(prompt,selectedModel)
      :await providers.directChat(selectedProvider,{prompt,model:selectedModel});
    return {text:String(answer.text||"").trim(),style,model:selectedModel,prompt};
  }
  if(!mock && isLoggedIn(env)) ensureBridge().catch(()=>{});

  const server=createServer(async(req,res)=>{
    const url=new URL(req.url || "/",`http://127.0.0.1:${port}`);

    if(url.pathname==="/api/state" && req.method==="GET") return json(res,200,state.snapshot());
    if(url.pathname==="/api/recovery"){
      if(req.method==="GET")return json(res,200,codexRecoverySnapshot());
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);const threadId=String(body.threadId||"");if(!threadId)throw new Error("threadId is required");
          const action=String(body.action||"clear");
          clearCodexRecovery(threadId,action==="failed"?"error":action==="interrupted"?"interrupted":"completed",body.message?String(body.message):null);
          return json(res,200,codexRecoverySnapshot());
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/settings"){
      if(req.method==="GET") return json(res,200,state.settings());
      if(req.method==="POST"){
        try{
          const patch=await readJsonBody(req);
          const remoteAccessTokenProvided=Object.prototype.hasOwnProperty.call(patch,"remoteAccessToken");
          if(remoteAccessTokenProvided){remoteAccessSecrets.setToken(patch.remoteAccessToken);delete patch.remoteAccessToken}
          if("modelProvider" in patch) patch.modelProvider=normalizeProviderId(patch.modelProvider);
          if("agentRuntime" in patch) patch.agentRuntime=normalizeAgentRuntime(patch.agentRuntime);
          const previous=selectedProvider;
          const previousAgentRuntime=agentRuntimes.activeRuntime();
          const previousAgentInstanceId=agentRuntimes.activeInstance().id;
          let runtimeSelection=null;
          if("agentRuntime" in patch||"agentRuntimeInstanceId" in patch){
            const requestedRuntime="agentRuntime" in patch?patch.agentRuntime:previousAgentRuntime;
            const requestedInstanceId=Object.prototype.hasOwnProperty.call(patch,"agentRuntimeInstanceId")
              ?(patch.agentRuntimeInstanceId||null)
              :(requestedRuntime===previousAgentRuntime?previousAgentInstanceId:null);
            runtimeSelection=await agentRuntimes.setActive({runtime:requestedRuntime,instanceId:requestedInstanceId});
            selectedAgentRuntime=runtimeSelection.runtime;
            delete patch.agentRuntime;delete patch.agentRuntimeInstanceId;
          }
          const next=state.updateSettings(patch);
          if("modelProvider" in patch && patch.modelProvider!==previous) await restartAppServer(patch.modelProvider);
          if(runtimeSelection?.runtime==="codex"&&previous===selectedProvider&&(previousAgentRuntime!=="codex"||previousAgentInstanceId!==runtimeSelection.instance.id))await restartAppServer(selectedProvider);
          if("remoteAccessEnabled" in patch||"remoteAccessPort" in patch||remoteAccessTokenProvided) await syncRemoteControl();
          return json(res,200,next);
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/general-workspace"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")
          ?requestedEnvironmentId(body.environmentId,{fallback:false})
          :requestedEnvironmentId(null);
        return json(res,200,await ensureGeneralWorkspace(environmentId));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/agent-runtimes"){
      if(req.method==="GET"){
        try{return json(res,200,await agentRuntimes.snapshot());}
        catch(error){return json(res,500,{error:error.message});}
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);
          if(body.action==="select"){
            const previousRuntime=agentRuntimes.activeRuntime();
            const previousInstanceId=agentRuntimes.activeInstance().id;
            const selected=await agentRuntimes.setActive({runtime:body.runtime,instanceId:body.instanceId||null});
            selectedAgentRuntime=selected.runtime;
            if(selected.runtime==="codex"&&(previousRuntime!=="codex"||previousInstanceId!==selected.instance.id))await restartAppServer(selectedProvider);
            return json(res,200,{...await agentRuntimes.snapshot(),selected});
          }
          if(body.action==="upsert"){
            const instance=agentRuntimes.upsertInstance(body.instance||{});
            if(instance.kind==="codex"&&agentRuntimes.activeInstance().id===instance.id)await restartAppServer(selectedProvider);
            return json(res,200,{instance,...await agentRuntimes.snapshot()});
          }
          if(body.action==="probe"){
            const instance=agentRuntimes.instances().find(item=>item.id===String(body.instanceId||""))||body.runtime;
            return json(res,200,{status:await agentRuntimes.probe(instance)});
          }
          if(body.action==="install"){
            const installed=await agentRuntimes.install(body.runtime,{environmentId:Object.prototype.hasOwnProperty.call(body,"environmentId")?body.environmentId:undefined});
            return json(res,200,{installed,...await agentRuntimes.snapshot()});
          }
          return json(res,400,{error:"unknown agent runtime action"});
        }catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="DELETE"){
        const id=url.searchParams.get("id");if(!id)return json(res,400,{error:"id is required"});
        try{
          const removed=agentRuntimes.removeInstance(id);
          if(removed.resetTo&&removed.kind==="codex")await restartAppServer(selectedProvider);
          return json(res,200,{...removed,...await agentRuntimes.snapshot()});
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/agent-runtime-auth"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        if(String(body.action||"login")!=="login")throw new Error("Unsupported runtime authentication action");
        const instance=agentRuntimes.instances().find(item=>item.id===String(body.instanceId||""))
          ||agentRuntimes.instances().find(item=>item.kind===String(body.runtime||""))
          ||agentRuntimes.activeInstance();
        const auth=agentRuntimes.authCommand(instance,{action:"login"});
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")
          ?requestedEnvironmentId(body.environmentId,{fallback:false})
          :requestedEnvironmentId(null);
        const cwd=agentRuntimes.runtimeCwd(body.cwd||process.cwd(),environmentId);
        if(mock){
          return json(res,200,{ok:true,auth,session:{id:"mock-runtime-auth",name:auth.name+" sign in",cwd,environmentId:environmentId||null,environmentName:"Mock environment",environmentType:environmentId?"remote":"local",running:true}});
        }
        const spec=environments.terminalArgvSpec(environmentId,{command:auth.command,args:auth.args,cwd});
        const session=await terminals.create({
          cwd:spec.cwd,
          displayCwd:cwd,
          cols:120,
          rows:32,
          name:auth.name+" sign in",
          env:environmentId?null:agentRuntimes.childEnv(instance),
          shell:spec.shell,
          args:spec.args,
          environmentId:spec.environmentId,
          environmentName:spec.environmentName,
          environmentType:spec.environmentType,
        });
        return json(res,200,{ok:true,auth,session});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/agent-runtime-usage"&&req.method==="GET"){
      try{
        const rawEnvironment=url.searchParams.get("environmentId");
        const environmentId=rawEnvironment==="local"?null:rawEnvironment?requestedEnvironmentId(rawEnvironment,{fallback:false}):requestedEnvironmentId(null);
        const instance=agentRuntimes.activeInstance();
        const usage=await agentRuntimes.usageLimits(instance,{environmentId});
        return json(res,200,{runtime:instance.kind,instanceId:instance.id,environmentId:environmentId||null,...usage});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/providers"){
      if(req.method==="GET"){
        return json(res,200,{selected:selectedProvider,providers:providers.definitions(),status:providers.status(selectedProvider),ready:providerReady()});
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);
          const provider=normalizeProviderId(body.provider||selectedProvider);
          let previousKey=null;
          if("apiKey" in body && provider!=="freebuff"){
            previousKey=providers.key(provider);
            providers.setKey(provider,body.apiKey);
            if(String(body.apiKey||"").trim() && (provider==="agentrouter"||provider==="vyceai")){
              try{
                await providers.models(provider);
              }catch(error){
                providers.setKey(provider,previousKey);
                throw new Error(`${providers.get(provider).name} API key validation failed: ${error instanceof Error?error.message:String(error)}`);
              }
            }
          }
          const changed=provider!==selectedProvider;
          if(changed) state.updateSettings({modelProvider:provider});
          if(changed || ("apiKey" in body && provider===selectedProvider)) await restartAppServer(provider);
          const catalog=await selectedModels().catch(error=>({models:[],error:error.message}));
          return json(res,200,{
            selected:selectedProvider,
            providers:providers.definitions(),
            status:providers.status(selectedProvider),
            ready:providerReady(),
            models:catalog.models||[],
            metadata:catalog.metadata||null,
            error:catalog.error||null,
          });
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/environments"){
      if(req.method==="GET"){
        try{const discovered=await environments.discover();return json(res,200,{...discovered,activeEnvironmentId:state.settings().activeEnvironmentId||null,activeEnvironment:environments.get(state.settings().activeEnvironmentId)||null});}
        catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="POST"){
        try{return json(res,200,{profile:environments.upsert(await readJsonBody(req))});}
        catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="DELETE"){
        const id=url.searchParams.get("id");
        const wasActive=Boolean(id&&state.settings().activeEnvironmentId===id);
        const ok=id?environments.remove(id):false;
        if(wasActive){
          state.updateSettings({activeEnvironmentId:null});
          await restartAppServer(selectedProvider);
        }
        return json(res,200,{ok,activeEnvironmentId:state.settings().activeEnvironmentId||null});
      }
    }
    if(url.pathname==="/api/environment/enabled"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);const id=String(body.id||"").trim();if(!id)throw new Error("id is required");
        const profile=environments.get(id,{includeDisabled:true});if(!profile)throw new Error("Environment profile was not found");
        const enabled=body.enabled!==false;const updated=environments.setEnabled(id,enabled);
        let activeEnvironmentId=state.settings().activeEnvironmentId||null;
        if(!enabled&&activeEnvironmentId===id){
          activeEnvironmentId=null;state.updateSettings({activeEnvironmentId:null});
          await agentRelay?.reset?.();
          await restartAppServer(selectedProvider);
        }
        return json(res,200,{ok:true,profile:updated,activeEnvironmentId,appServerReady:mock||await appServerReady(appServer,appPort)});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/environment/activate"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const id=body.id?String(body.id):null;
        if(id){
          const profile=environments.get(id,{includeDisabled:true});
          if(!profile)throw new Error("Environment profile was not found");
          if(profile.enabled===false)throw new Error("Environment is switched off. Turn it on before using it for agents.");
        }
        state.updateSettings({activeEnvironmentId:id});
        await agentRelay?.reset?.();
        await restartAppServer(selectedProvider);
        const appReady=mock||await appServerReady(appServer,appPort);
        const activeAgentInstance=agentRuntimes.activeInstance();
        const activeAgentStatus=selectedAgentRuntime==="codex"
          ?null
          :await agentRuntimes.probe(activeAgentInstance,{environmentId:id}).catch(error=>({
            id:activeAgentInstance?.id||null,
            kind:selectedAgentRuntime,
            name:selectedAgentRuntime,
            available:false,
            message:error instanceof Error?error.message:String(error),
          }));
        const agentRuntimeReady=selectedAgentRuntime==="codex"?appReady:(mock||Boolean(activeAgentStatus?.available));
        const runtimeError=selectedAgentRuntime==="codex"
          ?(appServer?.error||null)
          :(agentRuntimeReady?null:(activeAgentStatus?.message||"Active agent runtime is unavailable"));
        return json(res,200,{
          activeEnvironmentId:id,
          activeEnvironment:id?environments.get(id):null,
          agentRuntime:selectedAgentRuntime,
          agentRuntimeInstanceId:activeAgentInstance?.id||`${selectedAgentRuntime}-default`,
          agentRuntimeReady,
          agentRuntimeStatus:activeAgentStatus,
          appServerReady:appReady,
          error:runtimeError,
        });
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/environment/probe"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        return json(res,200,await environments.probe(body.id));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/environment/themes"&&req.method==="GET"){
      try{
        const requested=url.searchParams.get("id");
        const id=requested==null?(state.settings().activeEnvironmentId||null):(requested||null);
        return json(res,200,await environments.themeCatalog(id));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/environment/execute"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        return json(res,200,await environments.execute(body.id,body));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/devices"&&req.method==="GET"){
      try{return json(res,200,await devices.list())}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/device/tool-updates"&&req.method==="GET"){
      try{return json(res,200,await devices.updates())}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/device/tool-update"&&req.method==="POST"){
      try{const body=await readJsonBody(req);return json(res,200,await devices.updateTool(body.tool))}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/usage"){
      if(req.method==="GET"){
        const requested=url.searchParams.getAll("environmentId");
        const environmentIds=requested.length?requested.map(value=>!value||value==="local"?null:value):undefined;
        return json(res,200,state.usage({days:Number(url.searchParams.get("days")||30),limit:Number(url.searchParams.get("limit")||1000),environmentIds}));
      }
      if(req.method==="DELETE")return json(res,200,{ok:true,cleared:state.clearUsage()});
    }
    if(url.pathname==="/api/traces"&&req.method==="GET"){
      return json(res,200,{items:eventJournal.list({
        threadId:url.searchParams.get("threadId")||null,
        turnId:url.searchParams.get("turnId")||null,
        runtime:url.searchParams.get("runtime")||null,
        category:url.searchParams.get("category")||null,
        limit:Number(url.searchParams.get("limit")||200),
        before:url.searchParams.get("before")||null,
        after:url.searchParams.get("after")||null,
      }),journal:eventJournal.status()});
    }
    if(url.pathname==="/api/device/screenshot"&&req.method==="GET"){
      try{return json(res,200,await devices.screenshot(url.searchParams.get("id")))}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/device/action"&&req.method==="POST"){
      try{const body=await readJsonBody(req);return json(res,200,await devices.action(body.id,body.action,body.args||{}))}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/device/start"&&req.method==="POST"){
      try{const body=await readJsonBody(req);return json(res,200,await devices.startAndroid(body.avd))}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/remote-access"){
      if(req.method==="GET") return json(res,200,remoteInfo());
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);
          const patch={};
          if("enabled" in body) patch.remoteAccessEnabled=Boolean(body.enabled);
          if("port" in body){
            const remotePort=Number(body.port);
            if(!Number.isInteger(remotePort)||remotePort<1024||remotePort>65535) throw new Error("Remote access port must be between 1024 and 65535");
            patch.remoteAccessPort=remotePort;
          }
          if(body.regenerateToken||(!remoteAccessSecrets.getToken()&&body.enabled)) remoteAccessSecrets.setToken(newRemoteToken());
          if(Object.keys(patch).length) state.updateSettings(patch);
          return json(res,200,await syncRemoteControl());
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/remote-access/pair"&&req.method==="POST"){
      try{
        if(!state.settings().remoteAccessEnabled)return json(res,400,{error:"Enable remote access before creating a pairing link"});
        if(!remoteControl)await syncRemoteControl();
        return json(res,200,remoteControl.createPairing());
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/remote-access/device"&&req.method==="DELETE"){
      const id=url.searchParams.get("id");if(!id)return json(res,400,{error:"id is required"});
      return json(res,200,{ok:remoteAuth.revokeDevice(id),devices:remoteAuth.listDevices()});
    }
    if(url.pathname==="/api/projects"){
      if(req.method==="GET") return json(res,200,{projects:state.projects().map(projectWithEnvironment)});
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);
          if(!body.path) return json(res,400,{error:"path is required"});
          const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")
            ?requestedEnvironmentId(body.environmentId,{fallback:false})
            :requestedEnvironmentId(null);
          const project=state.touchProject(environmentPath(body.path,environmentId),{...body,environmentId});
          if(body.activate)state.updateSettings({activeProjectId:project.id});
          return json(res,200,{project:projectWithEnvironment(project)});
        }catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="DELETE"){
        const id=url.searchParams.get("id"); if(id) state.removeProject(id);
        return json(res,200,{ok:true});
      }
    }
    if(url.pathname==="/api/project-recipe/resolve"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const projectPath=environmentPath(body.path||"",environmentId);if(!projectPath)throw new Error("Project path is required");
        const project=state.project(projectPath,environmentId);if(!project)return json(res,404,{error:"Project was not found"});
        const key=String(body.recipe||"").trim().toLowerCase();
        const recipe=(project.recipes||[]).find(item=>String(item.id||"").toLowerCase()===key||String(item.name||"").toLowerCase()===key);
        if(!recipe)return json(res,404,{error:"Project recipe was not found"});
        const runtime=normalizeAgentRuntime(body.runtime||selectedAgentRuntime);
        const execution=resolveRecipeExecution(recipe,{
          projectPath,input:body.input||"",currentPermission:body.currentPermission||"supervised",runtime,
          toolPolicyEnforced:false,environmentIsolated:false,
        });
        return json(res,200,{execution});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/clone-jobs"){
      if(req.method==="GET"){
        const id=String(url.searchParams.get("id")||"").trim();
        if(!id)return json(res,200,{jobs:cloneJobs.list()});
        const job=cloneJobs.get(id);if(!job)return json(res,404,{error:"Clone job was not found"});
        const project=state.project(job.destination,job.environmentId||null);
        return json(res,200,{job,project:projectWithEnvironment(project)});
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);const action=String(body.action||"start");
          let job;
          if(action==="start"){
            const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
            if(!body.destination)throw new Error("Clone destination is required");
            const destination=environmentPath(body.destination,environmentId);
            job=await cloneJobs.start({url:body.url,destination,environmentId,name:body.name||null});
          }else if(action==="cancel")job=await cloneJobs.cancel(body.id);
          else if(action==="retry")job=await cloneJobs.retry(body.id);
          else throw new Error("Unknown clone action");
          const project=job?.destination?state.project(job.destination,job.environmentId||null):null;
          return json(res,200,{ok:true,job,project:projectWithEnvironment(project)});
        }catch(error){return json(res,400,{ok:false,error:error.message});}
      }
    }
    if(url.pathname==="/api/history-import"){
      if(req.method==="GET"){
        try{
          const {publicCandidates}=await localAgentHistory();
          return json(res,200,{
            sessions:publicCandidates,
            codexImportAvailable:selectedAgentRuntime==="codex"&&!state.settings().activeEnvironmentId&&Boolean(appServer?.targetUrl&&!appServer?.environment),
          });
        }catch(error){return json(res,400,{error:error.message})}
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);const results=await importAgentHistory(body.sessionIds||[]);
          return json(res,200,{ok:results.every(item=>item.status!=="error"),results,projects:state.projects().map(projectWithEnvironment)});
        }catch(error){return json(res,400,{error:error.message})}
      }
    }
    if(url.pathname==="/api/scoped-settings"){
      if(req.method==="GET"){
        try{
          const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
          const projectId=String(url.searchParams.get("projectId")||"").trim();
          if(projectId){
            const project=state.projects().find(item=>item.id===projectId);if(!project)throw new Error("Project was not found");
            const resolved=state.projectSettings(project.path,project.environmentId);
            return json(res,200,{scope:"project",environmentId:project.environmentId||null,project:projectWithEnvironment(project),...resolved});
          }
          const defaults=state.environmentDefaults(environmentId);
          return json(res,200,{scope:"environment",environmentId,defaults,overrides:{},effective:defaults});
        }catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);const projectId=String(body.projectId||"").trim();const patch=body.patch&&typeof body.patch==="object"?body.patch:{};const resetKeys=Array.isArray(body.resetKeys)?body.resetKeys:[];
          if(projectId){
            const project=state.projects().find(item=>item.id===projectId);if(!project)throw new Error("Project was not found");
            const result=state.updateProjectSettings(project.path,project.environmentId,patch,resetKeys);
            return json(res,200,{scope:"project",environmentId:project.environmentId||null,project:projectWithEnvironment(result.project),defaults:result.defaults,overrides:result.overrides,effective:result.effective});
          }
          const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
          state.updateEnvironmentDefaults(environmentId,patch,resetKeys);const defaults=state.environmentDefaults(environmentId);
          return json(res,200,{scope:"environment",environmentId,defaults,overrides:{},effective:defaults});
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/worktree/cleanup"&&req.method==="POST"){
      try{const body=await readJsonBody(req);return json(res,200,await worktreeCleanup.sweep({reason:body.reason||null,path:body.path||null}))}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/storage-cleanup"){
      if(req.method==="GET"){
        try{return json(res,200,await storageCleanup.snapshot())}
        catch(error){return json(res,500,{error:error.message});}
      }
      if(req.method==="POST"){
        try{return json(res,200,await storageCleanup.sweep({reason:"manual"}))}
        catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/worktree/ensure"&&req.method==="POST"){
      try{const body=await readJsonBody(req);if(!body.path)throw new Error("path is required");return json(res,200,await worktreeCleanup.ensure(body.path))}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/project-actions/suggestions"&&req.method==="GET"){
      try{return json(res,200,await projectActionSuggestions(url.searchParams.get("path")||process.cwd()));}
      catch(error){return json(res,400,{scripts:[],error:error.message});}
    }
    if(url.pathname==="/api/project-script/run"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const projectPath=environmentPath(body.path||process.cwd(),environmentId);
        const project=state.project(projectPath,environmentId);
        if(!project) return json(res,404,{error:"Project was not found"});
        const script=(project.scripts||[]).find(item=>item.id===String(body.scriptId||""));
        if(!script) return json(res,404,{error:"Project action was not found"});
        if(mock){
          const profile=environmentId?environments.get(environmentId):null;
          return json(res,200,{ok:true,script,session:{id:"mock-project-action",name:script.name,cwd:projectPath,environmentId,environmentName:profile?.name||"Local machine",environmentType:profile?.type||"local",running:true},previewUrl:script.previewUrl||null});
        }
        const session=await createTerminalSession({cwd:projectPath,environmentId,name:script.name||"Project action",cols:120,rows:32});
        await terminals.write(session.id,String(script.command||"")+"\r");
        return json(res,200,{ok:true,script,session:terminals.snapshot(session.id),previewUrl:script.previewUrl||null});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/preview/servers"&&req.method==="GET"){
      try{return json(res,200,{servers:await discoverPreviewServers()});}
      catch(error){return json(res,200,{servers:[],error:error.message});}
    }
    if(url.pathname==="/api/thread-meta"){
      const id=url.searchParams.get("threadId");
      if(req.method==="GET") return json(res,200,id?state.threadMeta(id):state.listThreadMeta());
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);
          if(!body.threadId) return json(res,400,{error:"threadId is required"});
          return json(res,200,state.updateThreadMeta(body.threadId,body.patch||{}));
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/stashes"){
      if(req.method==="GET") return json(res,200,{stashes:state.listStashes()});
      if(req.method==="POST"){
        try{return json(res,200,{stash:state.addStash(await readJsonBody(req))});}
        catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="DELETE"){
        const id=url.searchParams.get("id"); if(id) state.removeStash(id);
        return json(res,200,{ok:true});
      }
    }
    if(url.pathname==="/api/git/info"){
      try{
        const environmentId=url.searchParams.has("environmentId")
          ?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false})
          :requestedEnvironmentId(null);
        const profile=remoteEnvironmentProfile(environmentId);
        const cwd=environmentPath(url.searchParams.get("path")||profile?.cwd||process.cwd(),environmentId);
        const info=profile
          ?await inSourceControlEnvironment(environmentId,()=>sourceControlGitInfo(cwd))
          :await gitInfo(cwd);
        return json(res,200,{...info,environmentId:environmentId||null,environmentType:profile?.type||"local"});
      }
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/git/action" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")
          ?requestedEnvironmentId(body.environmentId,{fallback:false})
          :requestedEnvironmentId(null);
        const remoteProfile=remoteEnvironmentProfile(environmentId);
        const cwd=environmentPath(body.cwd||remoteProfile?.cwd||process.cwd(),environmentId);
        if(remoteProfile){
          if(body.action==="clone")return json(res,400,{error:"Clone into a remote environment from its Terminal or create the project after cloning."});
          const result=await tracedSourceControlMutation("git."+body.action,{cwd,environmentId},()=>inSourceControlEnvironment(environmentId,()=>sourceControlGitAction(cwd,{
            action:body.action,
            name:body.action==="worktree-create"?body.branch:body.name,
            message:body.message,
            setUpstream:Boolean(body.setUpstream),
            startPoint:body.baseBranch||body.startPoint||null,
            path:body.path||null,
            force:Boolean(body.force),
          })));
          if(body.action==="init")state.touchProject(cwd,{environmentId});
          if(body.action==="worktree-create"&&body.path){
            const sourceProject=state.project(cwd,environmentId);
            const inherited=sourceProject?{
              defaultModel:sourceProject.defaultModel??null,
              permissionMode:sourceProject.permissionMode??null,
              workspaceMode:sourceProject.workspaceMode??null,
              worktreeSubmodules:sourceProject.worktreeSubmodules??null,
              worktreeCleanup:sourceProject.worktreeCleanup??null,
              settingsOverrides:sourceProject.settingsOverrides||{},
              icon:sourceProject.icon??null,
              scripts:sourceProject.scripts||[],
              preferredScriptId:sourceProject.preferredScriptId??null,
            }:{};
            state.touchProject(environmentPath(body.path,environmentId),{...inherited,environmentId});
          }
          return json(res,200,{ok:true,result});
        }
        let result;
        switch(body.action){
          case "clone": result=await tracedSourceControlMutation("git.clone",{cwd:body.destination},()=>cloneRepository(body.url,body.destination)); state.touchProject(result.root||body.destination,{environmentId:null}); break;
          case "init": result=await tracedSourceControlMutation("git.init",{cwd},()=>initializeRepository(cwd)); state.touchProject(result.root||cwd,{environmentId:null}); break;
          case "branch-create": result=await tracedSourceControlMutation("git.branch-create",{cwd},()=>createBranch(cwd,body.name,{checkout:body.checkout!==false,startPoint:body.startPoint||null})); break;
          case "branch-switch": result=await tracedSourceControlMutation("git.branch-switch",{cwd},()=>switchBranch(cwd,body.name)); break;
          case "commit": result=await tracedSourceControlMutation("git.commit",{cwd},()=>commitAll(cwd,body.message||"Trebell Code changes")); break;
          case "fetch": result=await tracedSourceControlMutation("git.fetch",{cwd},()=>fetchRepo(cwd)); break;
          case "pull": result=await tracedSourceControlMutation("git.pull",{cwd},()=>pullRepo(cwd)); break;
          case "push": result=await tracedSourceControlMutation("push",{cwd},()=>pushRepo(cwd,{setUpstream:Boolean(body.setUpstream)})); break;
          case "auto-pull": result=await tracedSourceControlMutation("git.auto-pull",{cwd},()=>safeAutoPull(cwd)); break;
          case "worktree-create": {
            const sourceProject=state.project(resolve(cwd),null);
            const projectConfig=await projectActionSuggestions(cwd).catch(()=>({t3:{}}));
            const scoped=sourceProject?state.projectSettings(sourceProject.path,null):{defaults:state.environmentDefaults(null),overrides:{}};
            const submodules=scoped.overrides.worktreeSubmodules||projectConfig?.t3?.worktreeSubmodules||scoped.defaults.worktreeSubmodules||"recursive";
            result=await tracedSourceControlMutation("git.worktree-create",{cwd},()=>createWorktree(cwd,{branch:body.branch,path:body.path,baseBranch:body.baseBranch||null,submodules}));
            const inherited=sourceProject?{
              defaultModel:sourceProject.defaultModel??null,
              permissionMode:sourceProject.permissionMode??null,
              workspaceMode:sourceProject.workspaceMode??null,
              worktreeSubmodules:sourceProject.worktreeSubmodules??null,
              worktreeCleanup:sourceProject.worktreeCleanup??null,
              settingsOverrides:sourceProject.settingsOverrides||{},
              icon:sourceProject.icon??null,
              scripts:sourceProject.scripts||[],
              preferredScriptId:sourceProject.preferredScriptId??null,
            }:{};
            state.touchProject(result.worktree,{...inherited,environmentId:null,managedWorktree:{root:result.info.root,branch:String(body.branch||""),baseBranch:String(body.baseBranch||result.info.branch||""),submodules,createdAt:Date.now(),cleanedAt:null,cleanupReason:null}});
            const setup=(sourceProject?.scripts||[]).find(script=>script.runOnWorktreeCreate);
            if(setup&&!mock&&terminals){
              const spec=commandShellSpec(setup.command,env);
              const session=await terminals.create({cwd:result.worktree,name:`${setup.name||"Setup"} Â· setup`,cols:120,rows:32,shell:spec.shell,args:spec.args});
              result={...result,setup:{scriptId:setup.id,scriptName:setup.name,command:setup.command,waitForSetup:Boolean(setup.waitForSetup),session:terminals.snapshot(session.id)}};
            }
            break;
          }
          case "worktree-remove": result=await tracedSourceControlMutation("git.worktree-remove",{cwd},()=>removeWorktree(cwd,body.path,{force:Boolean(body.force)})); break;
          default:return json(res,400,{error:"unknown git action"});
        }
        return json(res,200,{ok:true,result});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/source-control/diagnostics"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(url.searchParams.get("path")||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        return json(res,200,await inSourceControlEnvironment(environmentId,()=>sourceControlDiagnostics(cwd,url.searchParams.get("provider")||null)));
      }
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/source-control/prs"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(url.searchParams.get("path")||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        return json(res,200,await inSourceControlEnvironment(environmentId,()=>listPullRequests(cwd,{provider:url.searchParams.get("provider")||null})));
      }catch(error){return json(res,400,{ok:false,items:[],error:error.message});}
    }
    if(url.pathname==="/api/source-control/pr" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        const result=await tracedSourceControlMutation("pr.create",{cwd,environmentId,provider:body.provider||null},()=>inSourceControlEnvironment(environmentId,()=>createPullRequest(cwd,body)));
        return json(res,200,{ok:true,...result});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/source-control/publish" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        return json(res,200,await tracedSourceControlMutation("publish",{cwd,environmentId,provider:body.provider||null},()=>inSourceControlEnvironment(environmentId,()=>publishRepository(cwd,body))));
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/source-control/pr-detail"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(url.searchParams.get("path")||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        return json(res,200,await inSourceControlEnvironment(environmentId,()=>pullRequestDetail(cwd,url.searchParams.get("number"),{provider:url.searchParams.get("provider")||null})));
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/source-control/settlements"&&req.method==="GET"){
      const enabled=Boolean(state.settings().autoSettleMergedThreads);const items=[];
      if(enabled)for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
        const links=(meta.attachments||[]).filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload||{});
        const lifecycle=linkedPullRequestTerminalStatus(links.length?links:(meta.linkedPullRequests||[]));
        if(!lifecycle.terminal||meta.autoSettleAppliedSignature===lifecycle.signature)continue;
        const pending=meta?.autoSettlePending;
        items.push({threadId,signature:lifecycle.signature,requestedAt:Number(pending?.requestedAt)||null,reason:pending?.reason||"pull_requests_terminal"});
      }
      return json(res,200,{enabled,items});
    }
    if(url.pathname==="/api/source-control/branch-reviews"&&req.method==="GET"){
      const items=[];
      for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
        if(!meta?.branch||meta.deletedAt)continue;
        items.push({
          threadId,branch:meta.branch,review:meta.branchPullRequest||null,
          lastSyncedAt:Number(meta.lastBranchPullRequestSyncAt)||null,error:meta.branchPullRequestSyncError||null,
        });
      }
      return json(res,200,{items});
    }
    if(url.pathname==="/api/source-control/thread-link"){
      if(req.method==="GET"){
        try{
          const threadId=String(url.searchParams.get("threadId")||"").trim();
          if(threadId)return json(res,200,{threadId,links:threadPullRequestLinks(threadId)});
          const identity=normalizePullRequestIdentity({
            provider:url.searchParams.get("provider"),host:url.searchParams.get("host"),repository:url.searchParams.get("repository"),number:url.searchParams.get("number"),url:url.searchParams.get("url"),
          });
          if(!identity)throw new Error("threadId or pull request identity is required");
          return json(res,200,{identity,threads:reversePullRequestLinks(identity)});
        }catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);const action=String(body.action||"link");const threadId=String(body.threadId||"").trim();
          if(action==="resolve"){
            const identity=normalizePullRequestIdentity(body.identity||body.pr||{url:body.url})||parsePullRequestUrl(body.url);
            const resolved=await resolvePullRequestIdentity(identity,{preferredPath:body.cwd||null,preferredEnvironmentId:body.environmentId||null});
            return json(res,200,{identity:resolved.detail.item.identity,project:resolved.project,pr:resolved.detail.item});
          }
          if(!threadId)throw new Error("threadId is required");
          if(action==="sync")return json(res,200,{ok:true,...await syncThreadPullRequestLinks(threadId)});
          if(action==="unlink"){
            const identity=normalizePullRequestIdentity(body.identity||body.pr||{url:body.url});return json(res,200,{ok:true,...removePullRequestLink(threadId,identity)});
          }
          if(action!=="link")throw new Error("Unknown pull request link action");
          let pr=body.pr&&typeof body.pr==="object"?body.pr:null;let identity=normalizePullRequestIdentity(pr?.identity||pr||{url:body.url});
          if(!identity&&body.cwd&&body.number){
            const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
            const cwd=environmentPath(body.cwd,environmentId);const detail=await inSourceControlEnvironment(environmentId,()=>pullRequestDetail(cwd,body.number,{provider:body.provider||null}));
            if(!detail?.ok||!detail.item)throw new Error(detail?.error||"Pull request not found");pr=detail.item;identity=pr.identity;
          }
          if(!identity)throw new Error("Pull request identity is incomplete");
          if(!pr?.identity||!pr?.title||(!pr?.stack&&body.refresh!==false)){
            const resolved=await resolvePullRequestIdentity(identity,{preferredPath:body.cwd||null,preferredEnvironmentId:body.environmentId||null}).catch(()=>null);
            if(resolved?.detail?.item)pr={...pr,...resolved.detail.item};
          }
          const link=buildPullRequestLink({...pr,identity,url:pr?.url||body.url},{source:body.source||"manual"});
          return json(res,200,{ok:true,link,...storePullRequestLink(threadId,link)});
        }catch(error){return json(res,400,{ok:false,error:error.message});}
      }
    }
    if(url.pathname==="/api/source-control/pr-viewed"&&req.method==="GET"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(url.searchParams.get("path")||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId),number=url.searchParams.get("number"),provider=url.searchParams.get("provider")||null;
        const detail=await inSourceControlEnvironment(environmentId,()=>pullRequestDetail(cwd,number,{provider}));if(!detail?.ok||!detail.item)return json(res,400,{error:detail?.error||"Pull request not found"});
        if(detail.provider==="github")return json(res,200,await inSourceControlEnvironment(environmentId,()=>getPullRequestFilesViewed(cwd,number,{provider:detail.provider})));
        const project=state.project(cwd,environmentId);const key=prViewedKey(detail.provider,number);const record=project?.pullRequestViewedFiles?.[key]||{};
        return json(res,200,{ok:true,provider:detail.provider,store:"environment",files:viewedStates(detail.item.files||[],record,detail.item.headSha),headSha:detail.item.headSha||null});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/source-control/pr-viewed"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId),number=body.number,provider=body.provider||null,updates=Array.isArray(body.files)?body.files:[];
        const detail=await inSourceControlEnvironment(environmentId,()=>pullRequestDetail(cwd,number,{provider}));if(!detail?.ok||!detail.item)throw new Error(detail?.error||"Pull request not found");
        if(detail.provider==="github")return json(res,200,await inSourceControlEnvironment(environmentId,()=>setPullRequestFilesViewed(cwd,number,updates,{provider:detail.provider})));
        const project=state.project(cwd,environmentId)||state.touchProject(cwd,{environmentId});const records={...(project.pullRequestViewedFiles||{})};const key=prViewedKey(detail.provider,number);records[key]=updateViewedRecord(detail.item.files||[],records[key]||{},detail.item.headSha,updates);state.touchProject(cwd,{environmentId,pullRequestViewedFiles:records});
        return json(res,200,{ok:true,provider:detail.provider,store:"environment",files:viewedStates(detail.item.files||[],records[key],detail.item.headSha),headSha:detail.item.headSha||null});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/source-control/pr-action" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        const action=String(body.action||""),provider=body.provider||null;
        const result=await tracedSourceControlMutation("pr."+action,{cwd,environmentId,provider,number:body.number,threadId:body.threadId||null},()=>{
          if(action==="edit")return inSourceControlEnvironment(environmentId,()=>editPullRequest(cwd,body.number,{provider,title:body.title,body:body.body||""}));
          if(action==="edit-comment")return inSourceControlEnvironment(environmentId,()=>editPullRequestComment(cwd,body.number,body.commentId,body.body||"",{provider}));
          if(action==="approve-workflows")return inSourceControlEnvironment(environmentId,()=>approvePullRequestWorkflows(cwd,body.number,{provider}));
          if(action==="revert")return inSourceControlEnvironment(environmentId,()=>revertPullRequest(cwd,body.number,{provider}));
          if(action==="rebase-stack")return inSourceControlEnvironment(environmentId,()=>rebasePullRequestStack(cwd,body.number,{provider}));
          if(action==="comment")return inSourceControlEnvironment(environmentId,()=>commentOnPullRequest(cwd,body.number,body.body||"",{provider}));
          if(action==="review")return inSourceControlEnvironment(environmentId,()=>reviewPullRequest(cwd,body.number,{provider,event:body.event,body:body.body||""}));
          if(action==="merge")return inSourceControlEnvironment(environmentId,()=>mergePullRequest(cwd,body.number,{provider,method:body.method,auto:Boolean(body.auto)}));
          if(action==="update-branch")return inSourceControlEnvironment(environmentId,()=>updatePullRequestBranch(cwd,body.number,{provider,rebase:body.rebase!==false}));
          if(action==="checkout")return inSourceControlEnvironment(environmentId,()=>checkoutPullRequest(cwd,body.number,{provider}));
          if(action==="request-reviewer")return inSourceControlEnvironment(environmentId,()=>requestPullRequestReviewer(cwd,body.number,body.reviewer,{provider}));
          throw new Error("unknown PR action");
        });
        return json(res,200,result);
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/git/commit-message" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        const generated=await sourceControlTextRequest({cwd,environmentId,kind:"commit",model:body.model||null});
        return json(res,200,{message:generated.text.split(/\r?\n/)[0].replace(/^[\"']|[\"']$/g,""),style:generated.style,model:generated.model});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/git/review-text" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        const generated=await sourceControlTextRequest({cwd,environmentId,kind:"review",model:body.model||null});
        const raw=generated.text.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"").trim();
        let parsed=null;try{parsed=JSON.parse(raw)}catch{
          const start=raw.indexOf("{"),end=raw.lastIndexOf("}");if(start>=0&&end>start)try{parsed=JSON.parse(raw.slice(start,end+1))}catch{}
        }
        const lines=raw.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
        const title=String(parsed?.title||lines[0]||"").replace(/^[#*\-\s]+/,"").slice(0,100).trim();
        const reviewBody=String(parsed?.body||(!parsed?lines.slice(1).join("\n"):"")).trim();
        if(!title)throw new Error("The model did not return a pull request title");
        return json(res,200,{title,body:reviewBody,style:generated.style,model:generated.model});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/checkpoints"){
      if(req.method==="GET") return json(res,200,{checkpoints:checkpoints.list(url.searchParams.get("threadId")||null)});
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);
          const checkpoint=await checkpoints.create(body);
          recordCheckpointTrace(checkpoint?.supported===false?"checkpoint.skipped":"checkpoint.created",checkpoint?.supported===false?"unsupported":"completed",checkpoint,{threadId:body.threadId||null,reason:checkpoint?.reason||null});
          return json(res,200,checkpoint);
        }catch(error){
          recordCheckpointTrace("checkpoint.create_failed","error",null,{message:error.message});
          return json(res,400,{error:error.message});
        }
      }
    }
    if(url.pathname==="/api/checkpoints/link" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const checkpoint=checkpoints.link(body.id,body.patch||{});recordCheckpointTrace("checkpoint.linked","completed",checkpoint,{checkpointId:body.id,turnId:body.patch?.turnId||null});
        return json(res,200,{checkpoint});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/checkpoints/restore" && req.method==="POST"){
      let body=null;
      try{
        body=await readJsonBody(req);
        const result=await checkpoints.restore(body.id,{threadId:body.threadId||null});recordCheckpointTrace("checkpoint.restored","completed",result.checkpoint,{checkpointId:body.id,threadId:body.threadId||null});
        return json(res,200,result);
      }catch(error){
        recordCheckpointTrace("checkpoint.restore_failed","error",null,{checkpointId:body?.id||null,threadId:body?.threadId||null,message:error.message});
        return json(res,400,{error:error.message});
      }
    }
    if(url.pathname==="/api/terminal/sessions"){
      if(mock){
        if(req.method==="GET") return json(res,200,{sessions:[]});
        if(req.method==="POST") return json(res,200,{session:{id:"mock-terminal",name:"Terminal",cwd:process.cwd(),buffer:"",running:true}});
        if(req.method==="DELETE") return json(res,200,{ok:true});
      }
      if(req.method==="GET"){
        const filter=url.searchParams.has("environmentId")
          ?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false})
          :undefined;
        return json(res,200,{sessions:terminals.list(filter)});
      }
      if(req.method==="POST"){
        try{return json(res,200,{session:await createTerminalSession(await readJsonBody(req))});}
        catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="DELETE"){
        const id=url.searchParams.get("id"); if(id) await terminals.close(id);
        return json(res,200,{ok:true});
      }
    }

    if(url.pathname==="/api/bootstrap"){
      const appReady=mock || await appServerReady(appServer,appPort);
      const activeAgentInstance=agentRuntimes.activeInstance();
      const activeAgentStatus=await agentRuntimes.probe(activeAgentInstance).catch(()=>null);
      return json(res,200,{
        mock,
        loggedIn:mock || isLoggedIn(env),
        agentRuntime:selectedAgentRuntime,
        agentRuntimeInstanceId:activeAgentInstance?.id||`${selectedAgentRuntime}-default`,
        runtimeCapabilities:agentRuntimes.capabilities(activeAgentInstance),
        agentRuntimeReady:selectedAgentRuntime==="codex"?appReady:Boolean(activeAgentStatus?.available),
        agentRuntimeStatus:activeAgentStatus,
        provider:selectedProvider,
        providerReady:providerReady(),
        bridgeReady:selectedProvider==="freebuff" ? (mock || await health(DEFAULT_PORT)) : false,
        appServerReady:appReady,
        wsUrl:mock ? null : (env.TREBELL_GUI_PUBLIC==="1"
          ? `${String(req.headers["x-forwarded-proto"]||"https").split(",")[0].trim()==="https"?"wss":"ws"}://${String(req.headers["x-forwarded-host"]||req.headers.host||"").split(",")[0].trim()}${selectedAgentRuntime==="codex"?"/api/codex/ws":"/api/agent/ws"}`
          : `ws://127.0.0.1:${port}${selectedAgentRuntime==="codex"?"/api/codex/ws":"/api/agent/ws"}`),
        cwd:process.cwd(),
        platform:process.platform,
        version:TREBELL_VERSION,
        activeEnvironment:appServer?.environment||null,
        appServerError:appServer?.error||null,
      });
    }
    if(url.pathname==="/api/runtime"){
      const agentSnapshot=await agentRuntimes.snapshot().catch(()=>({selectedRuntime:selectedAgentRuntime,selectedInstanceId:null,statuses:[]}));
      return json(res,200,{
        agentRuntime:selectedAgentRuntime,
        agentRuntimeInstanceId:agentSnapshot.selectedInstanceId,
        agentRuntimeStatus:agentSnapshot.statuses?.find(item=>item.id===agentSnapshot.selectedInstanceId)||null,
        provider:selectedProvider,
        providerReady:providerReady(),
        appServerReady:mock || await appServerReady(appServer,appPort),
        bridgeReady:selectedProvider==="freebuff" ? (mock || await health(DEFAULT_PORT)) : false,
        appServerExitCode:appServer?.child?.exitCode ?? null,
        activeEnvironment:appServer?.environment||null,
        appServerError:appServer?.error||null,
        logs:[...(providerBridgeLogs||[]),...(appServer?.logs||[])].sort((a,b)=>a.at-b.at).slice(-80),
      });
    }
    if(url.pathname==="/api/chat/direct" && req.method==="POST"){
      try{
        const payload=await readJsonBody(req);
        const prompt=String(payload.prompt||"").trim();
        const model=String(payload.model||"").trim();
        if(!prompt||!model) return json(res,400,{error:"prompt and model are required"});
        if(selectedProvider==="freebuff") return json(res,200,await queryFreebuff(prompt,model));
        return json(res,200,await providers.directChat(selectedProvider,{prompt,model}));
      }catch(error){return json(res,502,{error:error instanceof Error?error.message:String(error)});}
    }
    if(url.pathname==="/api/workspace/tree"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        return json(res,200,await environmentWorkspaceTree(url.searchParams.get("path")||process.cwd(),{environments,environmentId}));
      }
      catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}
    }
    if(url.pathname==="/api/workspace/diff"){
      const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
      return json(res,200,await environmentWorkspaceDiff(url.searchParams.get("path")||process.cwd(),{environments,environmentId}));
    }
    if(url.pathname==="/api/visualization"&&req.method==="GET"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const result=await readVisualization({
          workspaceRoot:url.searchParams.get("root")||process.cwd(),path:url.searchParams.get("path")||null,file:url.searchParams.get("file")||null,
          threadId:url.searchParams.get("threadId")||null,environmentId,
        });
        res.writeHead(200,{
          "content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff",
          "content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          "content-disposition":"inline; filename=\""+basename(result.path).replace(/\"/g,"")+"\"",
        });
        return res.end(result.content);
      }catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}
    }
    if(url.pathname==="/api/workspace/raw"&&(req.method==="GET"||req.method==="HEAD")){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const located=environmentWorkspacePath(url.searchParams.get("root")||process.cwd(),url.searchParams.get("path")||"",{environments,environmentId});
        const root=located.root,requested=located.path;
        let info;
        if(located.remote)info=await environments.attachmentInfo(environmentId,requested);
        else{
          if(requested!==root&&!requested.startsWith(root+sep))return json(res,403,{error:"File is outside the active workspace"});
          const localInfo=await stat(requested);
          if(!localInfo.isFile())return json(res,404,{error:"Not a file"});
          info={size:localInfo.size};
        }
        const type=MIME[extname(requested).toLowerCase()]||"application/octet-stream";
        const range=String(req.headers.range||"").match(/^bytes=(\d*)-(\d*)$/);
        const common={"content-type":type,"accept-ranges":"bytes","cache-control":"no-store","content-disposition":`inline; filename="${basename(requested).replace(/"/g,"")}"`};
        if(info.size===0){
          res.writeHead(200,{...common,"content-length":"0"});
          return res.end();
        }
        if(range){
          let start=range[1]?Number(range[1]):0;
          let end=range[2]?Number(range[2]):info.size-1;
          if(!range[1]&&range[2]){const suffix=Number(range[2]);start=Math.max(0,info.size-suffix);end=info.size-1}
          start=Math.max(0,Math.min(start,info.size-1));end=Math.max(start,Math.min(end,info.size-1));
          res.writeHead(206,{...common,"content-range":`bytes ${start}-${end}/${info.size}`,"content-length":String(end-start+1)});
          if(req.method==="HEAD")return res.end();
          if(located.remote){
            const child=environments.streamFile(environmentId,requested,{start,length:end-start+1});
            child.once("error",()=>res.destroy());
            req.once("close",()=>{if(child.exitCode===null)child.kill()});
            return child.stdout.pipe(res);
          }
          return createReadStream(requested,{start,end}).pipe(res);
        }
        res.writeHead(200,{...common,"content-length":String(info.size)});
        if(req.method==="HEAD")return res.end();
        if(located.remote){
          const child=environments.streamFile(environmentId,requested);
          child.once("error",()=>res.destroy());
          req.once("close",()=>{if(child.exitCode===null)child.kill()});
          return child.stdout.pipe(res);
        }
        return createReadStream(requested).pipe(res);
      }catch(error){return json(res,404,{error:error instanceof Error?error.message:String(error)});}
    }
    if(url.pathname==="/api/workspace/file"){
      if(req.method==="PUT"){
        try{
          const body=await readJsonBody(req,4*1024*1024);
          const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
          return json(res,200,await environmentWorkspaceWriteFile(body.path,body.content,{root:body.root||null,environments,environmentId}));
        }catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}
      }
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        return json(res,200,await environmentWorkspaceFile(url.searchParams.get("path")||"",512_000,{root:url.searchParams.get("root")||null,environments,environmentId}));
      }
      catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}
    }
    if(url.pathname==="/api/workspace/search"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        return json(res,200,await environmentWorkspaceSearch(url.searchParams.get("path")||process.cwd(),url.searchParams.get("q")||"",{environments,environmentId}));
      }
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/files"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.searchFiles({root,query:url.searchParams.get("q")||"",limit:Number(url.searchParams.get("limit")||80),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/map"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.repositoryMap({root,query:url.searchParams.get("q")||"",limit:Number(url.searchParams.get("limit")||60),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/commands"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.projectCommands({root,limit:Number(url.searchParams.get("limit")||120),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/verification"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId),files=url.searchParams.getAll("file").filter(Boolean),riskHints=url.searchParams.getAll("risk").filter(Boolean);
        return json(res,200,await contextEngine.verificationPlan({root,paths:files.length?files:null,riskHints,capabilities:{diagnostics:!['0','false','no'].includes(String(url.searchParams.get("diagnostics")||"").toLowerCase()),semanticDiagnostics:['1','true','yes'].includes(String(url.searchParams.get("semantic")||"").toLowerCase())},io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/verification/assess"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req,2*1024*1024);
        return json(res,200,contextEngine.assessVerification({plan:body.plan,evidence:Array.isArray(body.evidence)?body.evidence:[]}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/verification/next"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req,2*1024*1024);
        return json(res,200,contextEngine.nextVerificationAction({plan:body.plan,evidence:Array.isArray(body.evidence)?body.evidence:[]}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/verification/plan-turn"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req,2*1024*1024),threadId=String(body.threadId||"").trim(),turnId=String(body.turnId||"").trim();
        if(!threadId||!turnId)return json(res,400,{error:"threadId and turnId are required"});
        const checkpoint=checkpoints.list(threadId).filter(item=>String(item.turnId||"")===turnId).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0]||null;
        if(!checkpoint)return json(res,200,{supported:false,reason:"checkpoint_unavailable",threadId,turnId,changedPaths:[],record:null,nextAction:null});
        const changed=await checkpoints.changedPaths(checkpoint.id,{threadId});
        if(!changed.paths.length){
          eventJournal.record({environmentId:state.threadMeta(threadId)?.environmentId??null,threadId,turnId,category:"verification",name:"verification.skipped",status:"completed",data:{checkpointId:checkpoint.id,reason:"no_workspace_changes"}});
          return json(res,200,{supported:true,checkpointId:checkpoint.id,threadId,turnId,changedPaths:[],record:null,nextAction:{action:"complete",reason:"No workspace file changes were detected since the pre-turn checkpoint."}});
        }
        const meta=state.threadMeta(threadId),riskHints=Array.isArray(body.riskHints)?body.riskHints.map(String).filter(Boolean).slice(0,20):[];
        const plan=await contextEngine.verificationPlan({root:changed.root,paths:changed.paths,riskHints,capabilities:{diagnostics:body.diagnostics!==false,semanticDiagnostics:Boolean(body.semanticDiagnostics)}});
        const evidence=[],assessment=contextEngine.assessVerification({plan,evidence});
        const record=state.recordVerification({environmentId:meta?.environmentId??null,projectPath:changed.root,threadId,turnId,plan,evidence,assessment});
        const nextAction=contextEngine.nextVerificationAction({plan:record.plan,evidence:record.evidence});
        eventJournal.record({environmentId:meta?.environmentId??null,threadId,turnId,category:"verification",name:"verification.planned",status:assessment.status,data:{recordId:record.id,checkpointId:checkpoint.id,projectPath:changed.root,risk:assessment.risk,changedPathCount:changed.paths.length,changedPaths:changed.paths.slice(0,100),nextAction:nextAction.action,nextStepId:nextAction.nextStep?.id||null}});
        return json(res,200,{supported:true,checkpointId:checkpoint.id,threadId,turnId,changedPaths:changed.paths,record,nextAction});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/verification-records/repair-context"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req,512*1024),threadId=String(body.threadId||"").trim();if(!threadId)throw new Error("threadId is required");
        const prepared=codexVerificationState(threadId,body.recordId||null);if(!prepared.record)throw new Error("No persisted verification record is available for this thread.");
        if(prepared.nextAction.action!=="repair")throw new Error("Latest verification does not require repair (next action: "+prepared.nextAction.action+").");
        return json(res,200,{record:prepared.record,nextAction:prepared.nextAction,prompt:verificationRepairPrompt(),context:verificationRepairContext(prepared)});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/verification-records"){
      if(req.method==="GET"){
        const options={limit:Number(url.searchParams.get("limit")||100)};
        if(url.searchParams.has("threadId"))options.threadId=url.searchParams.get("threadId");
        if(url.searchParams.has("projectPath"))options.projectPath=url.searchParams.get("projectPath");
        if(url.searchParams.has("environmentId")){const raw=url.searchParams.get("environmentId");options.environmentId=!raw||raw==="local"?null:raw}
        return json(res,200,{records:state.verificationRecords(options)});
      }
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req,2*1024*1024),evidence=Array.isArray(body.evidence)?body.evidence:[],assessment=contextEngine.assessVerification({plan:body.plan,evidence});
          const environmentId=!body.environmentId||body.environmentId==="local"?null:String(body.environmentId);
          const record=state.recordVerification({id:body.id,environmentId,projectPath:body.projectPath||body.path||null,threadId:body.threadId||null,turnId:body.turnId||null,plan:body.plan,evidence,assessment});
          const nextAction=contextEngine.nextVerificationAction({plan:record.plan,evidence:record.evidence});
          eventJournal.record({environmentId,threadId:record.threadId||null,turnId:record.turnId||null,category:"verification",name:"verification.completed",status:assessment.status,data:{recordId:record.id,projectPath:record.projectPath||null,risk:assessment.risk,verified:Boolean(assessment.verified),summary:assessment.summary,nextAction:nextAction.action,nextStepId:nextAction.nextStep?.id||null}});
          return json(res,200,{record,nextAction});
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/context/symbols"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.searchSymbols({root,query:url.searchParams.get("q")||"",limit:Number(url.searchParams.get("limit")||40),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/relations"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.fileRelations({root,path:url.searchParams.get("file")||"",io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/tests"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.relatedTests({root,path:url.searchParams.has("file")?url.searchParams.get("file"):null,name:url.searchParams.has("name")?url.searchParams.get("name"):null,limit:Number(url.searchParams.get("limit")||80),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/calls"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.callHierarchy({root,name:url.searchParams.get("name")||"",path:url.searchParams.has("file")?url.searchParams.get("file"):null,limit:Number(url.searchParams.get("limit")||120),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/diagnostics"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.diagnostics({root,path:url.searchParams.get("file")||"",limit:Number(url.searchParams.get("limit")||100),semantic:["1","true","yes"].includes(String(url.searchParams.get("semantic")||"").toLowerCase()),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/language-symbol"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.languageSymbol({root,path:url.searchParams.get("file")||"",line:Number(url.searchParams.get("line")||1),column:Number(url.searchParams.get("column")||1),operation:url.searchParams.get("operation")||"definition",limit:Number(url.searchParams.get("limit")||100),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/code-actions"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId),codes=String(url.searchParams.get("codes")||"").split(",").map(value=>Number(String(value).replace(/^TS/i,""))).filter(Number.isFinite);
        return json(res,200,await contextEngine.codeActions({root,path:url.searchParams.get("file")||"",line:Number(url.searchParams.get("line")||1),column:Number(url.searchParams.get("column")||1),limit:Number(url.searchParams.get("limit")||20),codes,io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/organize-imports"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.organizeImports({root,path:url.searchParams.get("file")||"",limit:Number(url.searchParams.get("limit")||200),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/rename-preview"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.renamePreview({root,path:url.searchParams.get("file")||"",line:Number(url.searchParams.get("line")||1),column:Number(url.searchParams.get("column")||1),newName:url.searchParams.get("newName")||"",limit:Number(url.searchParams.get("limit")||200),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/references"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.symbolReferences({root,name:url.searchParams.get("name")||"",path:url.searchParams.has("file")?url.searchParams.get("file"):null,limit:Number(url.searchParams.get("limit")||120),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/search"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.searchCode({root,query:url.searchParams.get("q")||"",regex:["1","true"].includes(url.searchParams.get("regex")),caseSensitive:["1","true"].includes(url.searchParams.get("caseSensitive")),limit:Number(url.searchParams.get("limit")||80),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/source"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.readSourceRange({root,path:url.searchParams.get("file")||"",startLine:Number(url.searchParams.get("startLine")||1),endLine:url.searchParams.has("endLine")?Number(url.searchParams.get("endLine")):null,maxLines:Number(url.searchParams.get("maxLines")||200),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/git"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.gitContext({root,io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/history"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.gitHistory({root,path:url.searchParams.get("file")||"",limit:Number(url.searchParams.get("limit")||20),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/blame"){
      try{
        const environmentId=url.searchParams.has("environmentId")?requestedEnvironmentId(url.searchParams.get("environmentId"),{fallback:false}):requestedEnvironmentId(null);
        const root=environmentPath(url.searchParams.get("path")||process.cwd(),environmentId),remote=remoteEnvironmentProfile(environmentId);
        return json(res,200,await contextEngine.gitBlame({root,path:url.searchParams.get("file")||"",startLine:Number(url.searchParams.get("startLine")||1),endLine:url.searchParams.has("endLine")?Number(url.searchParams.get("endLine")):null,maxLines:Number(url.searchParams.get("maxLines")||120),io:remote?createRemoteContextIo({environments,environmentId,root}):null}));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/context/packet"&&req.method==="POST"){
      const cancellation=requestAbortController(req,res);
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")
          ?requestedEnvironmentId(body.environmentId,{fallback:false})
          :requestedEnvironmentId(null);
        const root=environmentPath(body.path||process.cwd(),environmentId);
        const remote=remoteEnvironmentProfile(environmentId);
        const packet=await contextEngine.buildPacket({
          root,
          task:body.task||"",
          focusPaths:Array.isArray(body.focusPaths)?body.focusPaths:[],
          maxTokens:body.maxTokens,
          maxFiles:body.maxFiles,
          tokensUsed:body.tokensUsed,
          contextWindow:body.contextWindow,
          io:remote?createRemoteContextIo({environments,environmentId,root}):null,
          signal:cancellation.signal,
        });
        return json(res,200,packet);
      }catch(error){
        if(cancellation.signal.aborted||error?.name==="AbortError")return;
        return json(res,400,{error:error.message});
      }finally{cancellation.dispose()}
    }
    if(url.pathname==="/api/attachments/text" && req.method==="POST"){
      try{
        const body=await readJsonBody(req,70*1024*1024);
        const dir=join(trebellHome(env),"attachments");
        await mkdir(dir,{recursive:true});
        const safe=String(body.name||"pasted-context.txt").replace(/[^a-zA-Z0-9._-]/g,"_").slice(-80);
        const path=join(dir,`${Date.now()}-${randomUUID().slice(0,8)}-${safe}`);
        await writeFile(path,String(body.text||""),"utf8");
        return json(res,200,{path,name:basename(path),size:Buffer.byteLength(String(body.text||""),"utf8"),mime:"text/plain"});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/attachments/blob" && req.method==="POST"){
      try{
        const body=await readJsonBody(req,72*1024*1024);
        const data=Buffer.from(String(body.dataBase64||""),"base64");
        const mime=String(body.mime||"application/octet-stream").toLowerCase();
        const maxBytes=mime.startsWith("image/")?10*1024*1024:50*1024*1024;
        if(data.length>maxBytes) return json(res,413,{error:`${mime.startsWith("image/")?"Image":"Attachment"} is larger than ${Math.round(maxBytes/1024/1024)} MB`});
        const dir=join(trebellHome(env),"attachments");
        await mkdir(dir,{recursive:true});
        const safe=String(body.name||"attachment.bin").replace(/[^a-zA-Z0-9._-]/g,"_").slice(-80);
        const path=join(dir,`${Date.now()}-${randomUUID().slice(0,8)}-${safe}`);
        await writeFile(path,data);
        return json(res,200,{path,name:basename(path),size:data.length,mime});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/attachments/import"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req,512*1024);
        const paths=Array.isArray(body.paths)?body.paths.slice(0,100):[];
        if(!paths.length)return json(res,200,{files:[]});
        const files=[];
        for(const path of paths)files.push(await environments.prepareAttachment(body.environmentId||null,path));
        return json(res,200,{files});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/attachments/validate"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req,512*1024);const paths=Array.isArray(body.paths)?body.paths:[];
        return json(res,200,await environments.validateAttachments(body.environmentId||null,paths));
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/freebuff/overview"){
      const model=url.searchParams.get("model") || "";
      const timezone=url.searchParams.get("timezone") || "UTC";
      if(mock) return json(res,200,{
        loggedIn:true,
        user:{name:"Tanishq",email:"tanishq@example.com"},
        instanceId:"mock-instance",
        proxySession:{status:"active",model:model.replace(/^freebuff\//,"") || "deepseek/deepseek-v4-flash",instanceId:"mock-instance"},
        session:{
          status:"active",
          admittedAt:new Date(Date.now()-11*60_000).toISOString(),
          freebucks:{balance:86},
          prices:{"deepseek/deepseek-v4-flash":10,"z-ai/glm-5.3-flash":5,"google/gemini-3.8-flash":50},
          rateLimitsByModel:{"deepseek/deepseek-v4-flash":{remaining:73,limit:100}},
          offPeakOffers:{active:true},
        },
        streak:{streak:6,todayUsed:true,lastUsageDate:new Date().toISOString().slice(0,10),timeZone:timezone,freebucksDailyBonus:10},
        errors:{session:null,streak:null},
        derived:{
          balance:86,
          selectedModel:model || "freebuff/deepseek/deepseek-v4-flash",
          activeModel:model || "freebuff/deepseek/deepseek-v4-flash",
          selectedPrice:{model:(model || "freebuff/deepseek/deepseek-v4-flash").replace(/^freebuff\//,""),current:10,peak:15,offPeak:10,offPeakActive:true,source:"server"},
          priceByModel:{
            "freebuff/deepseek/deepseek-v4-flash":{current:10,peak:15,offPeak:10,offPeakActive:true,source:"server"},
            "freebuff/z-ai/glm-5.3-flash":{current:5,offPeakActive:false,source:"server"},
            "freebuff/google/gemini-3.8-flash":{current:50,offPeakActive:false,source:"server"}
          },
          rateLimit:{remaining:73,limit:100},
          sessionStatus:"active",
          admittedAt:new Date(Date.now()-11*60_000).toISOString(),
          expiresAt:null,
          firstTabDiscount:null,
          offPeakOffers:{active:true},
          resetTime:null,
          timezone,
        }
      });
      if(!isLoggedIn(env)) return json(res,200,{loggedIn:false,user:null,session:null,streak:null,derived:null});
      try{
        await ensureBridge();
        const overview=await getFreebuffOverview({model,timezone,bridgePort:DEFAULT_PORT,env,fetchImpl});
        return json(res,200,overview);
      }catch(error){
        return json(res,503,{loggedIn:true,error:error instanceof Error?error.message:String(error)});
      }
    }
    if(url.pathname==="/api/freebuff/heartbeat" && req.method==="POST"){
      const model=url.searchParams.get("model") || "";
      const timezone=url.searchParams.get("timezone") || "UTC";
      if(mock) return json(res,200,{ok:true});
      if(!isLoggedIn(env)) return json(res,401,{ok:false,error:"not_logged_in"});
      try{
        const overview=await getFreebuffOverview({model,timezone,heartbeat:true,bridgePort:DEFAULT_PORT,env,fetchImpl});
        return json(res,200,{ok:true,overview});
      }catch(error){
        return json(res,503,{ok:false,error:error instanceof Error?error.message:String(error)});
      }
    }
    if(url.pathname==="/api/models"){
      try{
        const catalog=await selectedModels();
        return json(res,200,{provider:selectedProvider,agentRuntime:selectedAgentRuntime,ready:selectedAgentRuntime==="codex"?providerReady():true,models:catalog.models||[],metadata:catalog.metadata||null,error:catalog.error||null});
      }catch(error){
        return json(res,503,{provider:selectedProvider,agentRuntime:selectedAgentRuntime,ready:selectedAgentRuntime==="codex"?providerReady():false,models:[],error:error instanceof Error?error.message:String(error)});
      }
    }
    if(url.pathname==="/api/login/start" && req.method==="POST"){
      if(mock) return json(res,202,{started:true});
      if(!loginPromise){
        let opened=false;
        loginPromise=runLogin([],{
          port:DEFAULT_PORT,
          env,
          onOutput:(chunk)=>{
            if(opened) return;
            const match=String(chunk).match(/https:\/\/[^\s]+/);
            if(match){
              opened=true;
              try{ openBrowser(match[0]); }catch{}
            }
          },
        })
          .then(async code=>{ if(code===0) await ensureBridge(); return code; })
          .finally(()=>{loginPromise=null;});
      }
      return json(res,202,{started:true});
    }
    if(url.pathname==="/api/logout" && req.method==="POST"){
      logout(env);
      try{bridge?.child?.kill("SIGTERM");}catch{}
      bridge=null;
      return json(res,200,{ok:true});
    }
    if(url.pathname==="/api/update/check"){
      try{
        const response=await fetchImpl("https://api.github.com/repos/tanishqbaweja/trebellcode/releases/latest",{headers:{"User-Agent":"Trebell-Code/"+TREBELL_VERSION},signal:AbortSignal.timeout(8000)});
        const item=await response.json();
        return json(res,response.ok?200:502,{current:TREBELL_VERSION,latest:item.tag_name||null,url:item.html_url||null,name:item.name||null});
      }catch(error){return json(res,502,{current:TREBELL_VERSION,error:error.message});}
    }
    if(url.pathname==="/api/licenses"&&req.method==="GET"){
      try{return json(res,200,await listLicenses({query:url.searchParams.get("q")||""}))}
      catch(error){return json(res,500,{error:error.message});}
    }
    if(url.pathname==="/api/licenses/detail"&&req.method==="GET"){
      try{return json(res,200,await licenseDetail(url.searchParams.get("id")||""))}
      catch(error){return json(res,404,{error:error.message});}
    }
    if(url.pathname==="/api/diagnostics"){
      const cwd=url.searchParams.get("path")||process.cwd();
      return json(res,200,{
        version:TREBELL_VERSION,
        runtime:{provider:selectedProvider,providerReady:providerReady(),appServerReady:mock||await appServerReady(appServer,appPort),bridgeReady:selectedProvider==="freebuff"?(mock||await health(DEFAULT_PORT)):false,appServerExitCode:appServer?.child?.exitCode??null},
        state:{projects:state.projects(),settings:state.settings(),threadMeta:state.listThreadMeta()},
        git:await gitInfo(cwd).catch(error=>({error:error.message})),
        terminalSessions:mock?[]:terminals.list(),
        logs:[...(providerBridgeLogs||[]),...(appServer?.logs||[])].sort((a,b)=>a.at-b.at).slice(-100),
      });
    }
    if(url.pathname==="/api/stats") return json(res,200,statsSnapshot());
    if(url.pathname==="/api/health") return json(res,200,{ok:true});

    let path=url.pathname==="/" ? "/index.html" : url.pathname;
    path=normalize(path).replace(/^([.][.][/\\])+/, "");
    let file=resolve(dist,`.${path}`);
    if(!file.startsWith(dist)) return json(res,403,{error:"forbidden"});
    try{
      const info=await stat(file);
      if(info.isDirectory()) file=join(file,"index.html");
      const body=await readFile(file);
      res.writeHead(200,{"content-type":MIME[extname(file)]||"application/octet-stream"});
      return res.end(body);
    }catch{
      try{
        const body=await readFile(join(dist,"index.html"));
        res.writeHead(200,{"content-type":"text/html; charset=utf-8"});
        return res.end(body);
      }catch{
        return json(res,503,{error:"Trebell UI is not built. Run npm run ui:build first."});
      }
    }
  });

  async function codexThreadProfiles(threadId){
    const id=String(threadId||"").trim();if(!id)throw Object.assign(new Error("threadId is required"),{code:-32602});
    const meta=state.threadMeta(id);const environmentId=meta.environmentId??state.settings().activeEnvironmentId??null;
    const current=codexInstance(meta.runtimeInstanceId)||codexInstance();if(!current)return {supported:false,label:"Codex profile",currentInstanceId:null,items:[],reason:"No Codex runtime profile is configured."};
    const compatibleIds=new Set(agentRuntimes.compatibleInstanceIds(current));
    const compatible=agentRuntimes.instances().filter(instance=>instance.kind==="codex"&&compatibleIds.has(instance.id));
    const items=await Promise.all(compatible.map(async instance=>{
      const status=await agentRuntimes.probe(instance,{environmentId}).catch(error=>({available:false,message:error.message||String(error)}));
      return {id:instance.id,displayName:instance.displayName||instance.id,current:instance.id===current.id,available:Boolean(status?.available),authenticated:status?.authenticated??null,version:status?.version||null,message:status?.message||null};
    }));
    return {supported:true,label:"Codex profile",currentInstanceId:current.id,items};
  }
  async function setCodexThreadProfile(threadId,instanceId){
    const id=String(threadId||"").trim(),targetId=String(instanceId||"").trim();if(!id||!targetId)throw Object.assign(new Error("threadId and instanceId are required"),{code:-32602});
    const meta=state.threadMeta(id);if(meta.active)throw new Error("Stop the running turn before switching Codex profiles.");
    const environmentId=meta.environmentId??state.settings().activeEnvironmentId??null;
    const current=codexInstance(meta.runtimeInstanceId)||codexInstance();const target=codexInstance(targetId);
    if(!target||!current)throw new Error("Codex runtime profile was not found");
    if(!agentRuntimes.compatibleInstanceIds(current).includes(target.id))throw new Error("This Codex profile uses a different CODEX_HOME, so it cannot continue this thread.");
    const status=await agentRuntimes.probe(target,{environmentId});if(!status.available)throw new Error(status.message||"The selected Codex profile is unavailable");
    if(target.id===current.id)return {threadId:id,runtimeInstanceId:target.id};
    await releaseCodexThreadServer(id);
    try{
      const targetServer=await ensureCodexAppServer(target.id,{environmentId,ownerKey:`thread:${id}`});if(targetServer.error)throw new Error(targetServer.error);
      codexThreadServerKeys.set(id,targetServer.poolKey);
    }catch(error){
      const restored=await ensureCodexAppServer(current.id,{environmentId,ownerKey:`thread:${id}`}).catch(()=>null);if(restored&&!restored.error)codexThreadServerKeys.set(id,restored.poolKey);
      throw error;
    }
    state.updateThreadMeta(id,{runtime:"codex",runtimeInstanceId:target.id,environmentId,active:false});
    return {threadId:id,runtimeInstanceId:target.id};
  }
  async function codexRelayTarget(message){
    const threadId=String(message?.params?.threadId||message?.params?._trebellThreadId||"").trim();
    if(threadId&&codexThreadReleases.has(threadId))await codexThreadReleases.get(threadId);
    const meta=threadId?state.threadMeta(threadId):{};const environmentId=threadId?(meta.environmentId??state.settings().activeEnvironmentId??null):(state.settings().activeEnvironmentId||null);
    let instance=threadId&&meta.runtimeInstanceId?codexInstance(meta.runtimeInstanceId):null;if(!instance)instance=codexInstance();
    if(!instance)throw new Error("Codex runtime profile was not found");
    const remote=environmentId?environments.get(environmentId):null;
    let server;
    if(message?.method==="thread/start"){
      server=await ensureCodexAppServer(instance.id,{environmentId,ownerKey:`start:${String(message.id??randomUUID())}`});
    }else if(threadId){
      const existingKey=codexThreadServerKeys.get(threadId);const existing=existingKey?codexAppServers.get(existingKey):null;
      if(existing&&(mock||(!existing.error&&existing.child?.exitCode===null)))server=existing;
      else{
        server=await ensureCodexAppServer(instance.id,{environmentId,ownerKey:`thread:${threadId}`});
        codexThreadServerKeys.set(threadId,server.poolKey);
      }
    }else server=appServer;
    if(server?.error)throw new Error(server.error);
    if(threadId&&!meta.runtimeInstanceId&&["thread/resume","thread/read","turn/start","turn/interrupt","turn/steer","thread/compact/start","thread/revert","review/start"].includes(message?.method))state.updateThreadMeta(threadId,{runtime:"codex",runtimeInstanceId:instance.id,environmentId});
    return {key:server.poolKey,url:server.targetUrl};
  }

  const terminalWs=terminals?.attachWebSocket(server);
  const relay=attachCodexRelay(server,{
    targetUrl:()=>appServer?.targetUrl||`ws://127.0.0.1:${appPort}`,
    resolveTarget:message=>codexRelayTarget(message),
    transformClientMessage:message=>transformCodexClientMessage(message),
    handleServerRequest:async message=>resolveCodexServerRequest(message),
    handleRequest:async (message,{requestUpstream})=>{
      const params=message.params||{},threadId=params.threadId?String(params.threadId):"";
      if(message.method==="thread/goal/get")return {handled:true,result:{goal:threadId?durableCodexGoal(threadId):null}};
      if(message.method==="thread/goal/set"){
        if(!threadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
        const meta=state.threadMeta(threadId),previous=meta?.goal||null,goal=normalizeGoal({threadId,previous,patch:params});
        let goalBudgetBaselines=meta?.goalBudgetBaselines||null;
        if(!goalBudgetBaselines){
          goalBudgetBaselines={
            toolCalls:Math.max(0,Number(meta?.codexToolCallCount)||0),childAgents:Math.max(0,Number(meta?.codexChildAgentCount)||0),
            toolCallTelemetryComplete:!previous,childAgentTelemetryComplete:!previous,
          };
        }
        state.updateThreadMeta(threadId,{goal,goalBudgetBaselines});
        const enriched=durableCodexGoal(threadId);relay.broadcast("thread/goal/updated",{threadId,goal:enriched});
        return {handled:true,result:{goal:enriched}};
      }
      if(message.method==="thread/goal/clear"){
        if(!threadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
        state.updateThreadMeta(threadId,{goal:null,goalBudgetBaselines:undefined});relay.broadcast("thread/goal/updated",{threadId,goal:null});return {handled:true,result:{ok:true}};
      }
      if(message.method==="thread/continuity/get")return {handled:true,result:{continuity:threadId?durableCodexContinuity(threadId):null}};
      if(message.method==="thread/continuity/set"){
        if(!threadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
        const meta=state.threadMeta(threadId),continuityNotes=normalizeContinuityNotes(meta?.continuityNotes||null,params);
        state.updateThreadMeta(threadId,{continuityNotes});const continuity=durableCodexContinuity(threadId);
        relay.broadcast("thread/continuity/updated",{threadId,continuity});return {handled:true,result:{continuity}};
      }
      if(message.method==="thread/continuity/clear"){
        if(!threadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
        state.updateThreadMeta(threadId,{continuityNotes:undefined});const continuity=durableCodexContinuity(threadId);
        relay.broadcast("thread/continuity/updated",{threadId,continuity});return {handled:true,result:{ok:true,continuity}};
      }
      if(message.method==="thread/verification/get")return {handled:true,result:threadId?codexVerificationState(threadId,params.recordId||null):{record:null,nextAction:null}};
      if(message.method==="thread/verification/repair"){
        if(!threadId)throw Object.assign(new Error("threadId is required"),{code:-32602});
        return {handled:true,result:await repairCodexVerification(threadId,params,requestUpstream)};
      }
      if(message.method==="thread/delegate")return {handled:true,result:await delegateCodexThread(params,requestUpstream)};
      if(((message.method==="turn/start"&&params.turnTrigger!=="trebell-restart-continuation")||message.method==="thread/queue/start")&&threadId)assertCodexGoalBudget(threadId);
      if(message.method==="thread/runtimeInstances/list")return {handled:true,result:await codexThreadProfiles(message.params?.threadId)};
      if(message.method==="thread/runtimeInstance/set")return {handled:true,result:await setCodexThreadProfile(message.params?.threadId,message.params?.instanceId)};
      return null;
    },
    enabled:()=>mock || Boolean(appServer?.child && appServer.child.exitCode===null),
      log:(message)=>appServer?.logs?.push({at:Date.now(),stream:"relay",text:safeLogText(message)}),
    onClientMessage:message=>{
      const traceParams=message?.params||{};const traceThreadId=traceParams.threadId||null;const traceMeta=traceThreadId?state.threadMeta(traceThreadId):null;
      eventJournal.recordProtocol({runtime:"codex",provider:selectedProvider,environmentId:traceMeta?.environmentId??state.settings().activeEnvironmentId??null,direction:"client",method:message?.method||"",params:traceParams});
      if((message?.method==="thread/resume"||message?.method==="turn/start")&&message.params?.threadId&&message.params?.cwd){
        state.updateThreadMeta(message.params.threadId,{cwd:message.params.cwd,runtime:"codex",deletedAt:null});
      }
      if(message?.method==="turn/start"){
        const threadId=message.params?.threadId,model=message.params?.model;
        if(threadId){
          const permissionPatch=codexPermissionProfilePatch(message.params||{});
          if(Object.keys(permissionPatch).length)state.updateThreadMeta(threadId,permissionPatch);
          if(model)codexThreadModels.set(threadId,model);
        }
      }
    },
    onServerMessage:(message,route)=>{
      const params=message?.params||{};
      recordCodexBudgetEvidence(state,message);
      const traceThreadId=params.threadId||params.thread?.id||null;const traceMeta=traceThreadId?state.threadMeta(traceThreadId):null;
      eventJournal.recordProtocol({runtime:"codex",provider:selectedProvider,environmentId:traceMeta?.environmentId??state.settings().activeEnvironmentId??null,direction:"runtime",method:message?.method||route?.requestMethod||"",params});
      const startedThread=message?.method==="thread/started"?params.thread:(route?.requestMethod==="thread/start"?message?.result?.thread:null);
      if(startedThread?.id){
        recordCodexChildAgentEvidence(state,startedThread);
        if(startedThread.model)codexThreadModels.set(startedThread.id,startedThread.model);
        const routedServer=route?.targetKey?codexAppServers.get(route.targetKey):null;
        if(routedServer)codexThreadServerKeys.set(startedThread.id,routedServer.poolKey);
        state.updateThreadMeta(startedThread.id,{cwd:startedThread.cwd||null,runtime:"codex",runtimeInstanceId:routedServer?.runtimeInstanceId||agentRuntimes.activeInstance().id,environmentId:routedServer?.environmentId??state.settings().activeEnvironmentId??null,deletedAt:null,active:false,...codexPermissionProfilePatch(route?.requestParams||{})});
      }
      if(message?.method==="thread/deleted"&&params.threadId){
        codexThreadModels.delete(params.threadId);const meta=state.threadMeta(params.threadId);state.updateThreadMeta(params.threadId,{deletedAt:Date.now(),active:false});
        setTimeout(()=>releaseCodexThreadServer(params.threadId).catch(()=>{}),0);
      if(meta?.cwd)worktreeCleanup.sweep({reason:"thread-delete",path:meta.cwd}).catch(error=>cleanupLogs.push({at:Date.now(),stream:"cleanup",text:safeLogText(error.message+"\n")}));
      }
      if(message?.method==="thread/archived"&&params.threadId)setTimeout(()=>releaseCodexThreadServer(params.threadId).catch(()=>{}),0);
      if(route?.requestMethod==="thread/unsubscribe"&&!message?.error&&route.requestParams?.threadId){
        const threadId=String(route.requestParams.threadId);const meta=state.threadMeta(threadId);
        if(!meta.active)setTimeout(()=>releaseCodexThreadServer(threadId).catch(()=>{}),0);
      }
      if(message?.method==="turn/started")markCodexTurnActive(params.threadId,params.turn?.id||params.turnId);
      if(message?.method==="turn/completed")clearCodexRecovery(params.threadId,"completed");
      if(message?.method==="thread/tokenUsage/updated"&&params.threadId&&params.turnId){
        const meta=state.threadMeta(params.threadId);
        state.recordUsage({runtime:"codex",provider:selectedProvider,model:codexThreadModels.get(params.threadId)||null,environmentId:meta?.environmentId??state.settings().activeEnvironmentId??null,threadId:params.threadId,turnId:params.turnId,usage:params.tokenUsage?.last||params.tokenUsage?.total||{},cost:params.tokenUsage?.cost||null,at:Date.now()});
      }
    },
  });
  const agentRelay=mock?null:attachAgentRelay(server,{
    runtimeManager:agentRuntimes,
    threadStore:agentThreads,
    terminals,
    state,
    environments,
    contextEngine,
    repositoryKnowledge,
    version:TREBELL_VERSION,
      log:(message)=>appServer?.logs?.push({at:Date.now(),stream:"agent-relay",text:safeLogText(String(message)+"\n")}),
    onThreadDeleted:thread=>thread?.cwd?worktreeCleanup.sweep({reason:"thread-delete",path:thread.cwd}):null,
    journal:eventJournal,
    prepareDelegationWorkspace:({parentThreadId,parentThread,spec})=>prepareCodexDelegationWorkspace(parentThreadId,spec,parentThread),
    cleanupDelegationWorkspace:async({workspace,parentThread})=>{if(workspace?.worktree)await removeWorktree(parentThread?.cwd||workspace.cwd,workspace.cwd,{force:true}).catch(()=>{})},
  });

  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(port,host,resolve);
  });
  if(!mock) waitForAppServer(appServer,appPort,15000).catch(()=>false);
  let cleanupTimer=null;
  let pullRequestSyncTimer=null,pullRequestSyncRunning=false;
  let autoPullTimer=null,autoPullRunning=false;
  const sweepPullRequestLinks=async()=>{
    if(pullRequestSyncRunning)return;pullRequestSyncRunning=true;
    try{
      const now=Date.now();
    await syncBranchPullRequests().catch(error=>appServer?.logs?.push({at:Date.now(),stream:"branch-pr-sync",text:safeLogText(error.message+"\n")}));
      for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
        const links=(meta.attachments||[]).filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload||{});
        if(!links.length)continue;
        const states=links.map(link=>String(link.snapshot?.state||link.state||"").toUpperCase());
        if(states.length&&states.every(value=>value==="MERGED"))continue;
        const openOrUnknown=states.some(value=>!value||value==="OPEN");
        const cadence=openOrUnknown?60_000:10*60_000;
        if(now-Number(meta.lastPullRequestSyncAt||0)<cadence)continue;
    await syncThreadPullRequestLinks(threadId).catch(error=>appServer?.logs?.push({at:Date.now(),stream:"pr-sync",text:safeLogText(error.message+"\n")}));
      }
    }finally{pullRequestSyncRunning=false}
  };
  const sweepAutoPull=async()=>{
    if(autoPullRunning)return;autoPullRunning=true;
    try{
      await sweepAutoPullProjects({
        state,
        pullProject:project=>inSourceControlEnvironment(project.environmentId||null,()=>sourceControlGitAction(project.path,{action:"auto-pull"})),
    log:message=>appServer?.logs?.push({at:Date.now(),stream:"auto-pull",text:safeLogText(String(message)+"\n")}),
      });
    }finally{autoPullRunning=false}
  };
  if(!mock){
  storageCleanup.sweep().catch(error=>cleanupLogs.push({at:Date.now(),stream:"storage-cleanup",text:safeLogText(error.message+"\n")}));
  cleanupTimer=setInterval(()=>storageCleanup.sweep().catch(error=>cleanupLogs.push({at:Date.now(),stream:"storage-cleanup",text:safeLogText(error.message+"\n")})),60*60_000);cleanupTimer.unref?.();
    setTimeout(()=>sweepPullRequestLinks().catch(()=>{}),5000).unref?.();
    pullRequestSyncTimer=setInterval(()=>sweepPullRequestLinks().catch(()=>{}),60_000);pullRequestSyncTimer.unref?.();
    setTimeout(()=>sweepAutoPull().catch(()=>{}),7000).unref?.();
    autoPullTimer=setInterval(()=>sweepAutoPull().catch(()=>{}),5*60_000);autoPullTimer.unref?.();
  }
  if(state.settings().remoteAccessEnabled) await syncRemoteControl().catch(error=>{
      appServer?.logs?.push({at:Date.now(),stream:"remote",text:safeLogText("remote access failed: "+error.message+"\n")});
  });

  return {
    url:`http://${host==="0.0.0.0"?"127.0.0.1":host}:${port}`,
    server,
    close:async()=>{
      if(cleanupTimer)clearInterval(cleanupTimer);
      if(pullRequestSyncTimer)clearInterval(pullRequestSyncTimer);
      if(autoPullTimer)clearInterval(autoPullTimer);
      relay.close();
      await agentRelay?.close?.();
      terminalWs?.close();
      await Promise.allSettled([
        cloneJobs.shutdown(),
        terminals?.shutdown(),
        remoteControl?.close(),
        stopCodexAppServers(),
        stopChildProcess(bridge?.child),
        providerBridge?.close(),
        eventJournal.close(),
      ]);
      remoteControl=null;
      await new Promise(resolve=>server.close(resolve));
    },
  };
}

export async function mainGui(argv=process.argv.slice(2)){
  const opts=parseArgs(argv);
  const gui=await createGuiServer(opts);
  console.log(`Trebell Code GUI running at ${gui.url}`);
  if(opts.open) openBrowser(gui.url);
  const shutdown=async()=>{await gui.close();process.exit(0);};
  process.once("SIGINT",shutdown);
  process.once("SIGTERM",shutdown);
  await new Promise(()=>{});
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  mainGui().catch(error=>{console.error(error);process.exitCode=1;});
}
