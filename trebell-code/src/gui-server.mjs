import { createServer } from "node:http";
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
import { DeviceService } from "./device-service.mjs";
import { ProviderManager, normalizeProviderId } from "./provider-manager.mjs";
import { startProviderBridge } from "./provider-bridge.mjs";
import { AgentRuntimeManager, normalizeAgentRuntime } from "./agent-runtime-manager.mjs";
import { AgentThreadStore } from "./agent-thread-store.mjs";
import { attachAgentRelay } from "./agent-relay.mjs";
import { listLicenses, licenseDetail } from "./license-service.mjs";
import { WorktreeCleanupService } from "./worktree-cleanup.mjs";
import { sweepAutoPullProjects } from "./auto-pull-service.mjs";
import { CloneJobService } from "./clone-job-service.mjs";
import { prepareCodexHome } from "./codex-home-layout.mjs";

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
  sourceControlGitAction, sourceControlGitInfo, sourceControlRecentCommitSubjects, sourceControlRepositoryIdentity, withSourceControlExecutor,
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
  if(mock) return { child:null, logs:[], targetUrl:null, readyUrl:null, environment:null };
  if(environmentId&&environments){
    const profile=environments.get(environmentId);
    if(profile&&profile.type!=="local"){
      try{
        return await startRemoteAppServer({
          environments,
          environmentId,
          appPort,
          provider,
          localProviderPort:providerPort,
          debug:env.TREBELL_GUI_DEBUG==="1",
        });
      }catch(error){
        return {
          child:null,
          logs:[{at:Date.now(),stream:"environment",text:(error?.stack||error?.message||String(error))+"\n"}],
          targetUrl:`ws://127.0.0.1:${appPort}`,
          readyUrl:null,
          environment:{id:profile.id,name:profile.name,type:profile.type},
          error:error instanceof Error?error.message:String(error),
        };
      }
    }
  }
  const inferencePort=Number.isInteger(providerPort)?providerPort:DEFAULT_PORT;
  ensureCodexConfig({port:inferencePort,env,provider});
  const command=runtimeInstance?.binaryPath?.trim()||codexBin(env);
  const homeLayout=await prepareCodexHome({homePath:runtimeInstance?.homePath?.trim()||codexHome(env),shadowHomePath:runtimeInstance?.shadowHomePath?.trim()||null,defaultHome:codexHome(env)});
  const runtimeHome=homeLayout.effectiveHomePath||homeLayout.sharedHomePath;
  const runtimeEnv={...env,...(runtimeInstance?.environment||{}),CODEX_HOME:runtimeHome};
  const args=[...codexProviderOverrides({port:inferencePort,provider}),"app-server","--listen",`ws://127.0.0.1:${appPort}`];
  const logs=[];
  const pushLog=(chunk,stream)=>{
    const line=String(chunk);
    logs.push({at:Date.now(),stream,text:line});
    if(logs.length>250) logs.splice(0,logs.length-250);
    if(env.TREBELL_GUI_DEBUG==="1") (stream==="stderr"?process.stderr:process.stdout).write(chunk);
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
  return { child, logs, targetUrl:`ws://127.0.0.1:${appPort}`, readyUrl:`http://127.0.0.1:${appPort}/readyz`, environment:null, runtimeInstanceId:runtimeInstance?.id||"codex-default",runtimeHome,sharedRuntimeHome:homeLayout.sharedHomePath,continuationKey:homeLayout.continuationKey };
}

async function appServerReady(instance,appPort){
  if(instance?.readyUrl){
    try{
      const response=await fetch(instance.readyUrl,{signal:AbortSignal.timeout(1200)});
      return response.ok;
    }catch{return false}
  }
  return instance?.child ? await probeCodexReady(appPort) : false;
}

async function waitForAppServer(instance,appPort,timeoutMs=15000){
  if(!instance?.readyUrl) return instance?.child ? await waitForCodexReady(appPort,timeoutMs).catch(()=>false) : false;
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
  const bootId=randomUUID();
  const dist=resolve(packageRoot,"ui","dist");
  const state=new TrebellStateStore(env);
  const remoteAuth=new RemoteAuthStore(env);
  const devices=new DeviceService({env});
  const providers=new ProviderManager({env});
  const environments=new EnvironmentManager({state,env});
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
    const profile=project.environmentId?environments.get(project.environmentId):null;
    const cloneJob=project.cloneJob?{
      id:project.cloneJob.id,url:project.cloneJob.url,status:project.cloneJob.status,progress:project.cloneJob.progress,
      phase:project.cloneJob.phase,error:project.cloneJob.error||null,startedAt:project.cloneJob.startedAt,completedAt:project.cloneJob.completedAt||null,
    }:null;
    return {...project,cloneJob,environment:project.environmentId?{
      id:project.environmentId,
      name:profile?.name||"Unavailable environment",
      type:profile?.type||"unknown",
    }:{id:null,name:"Local machine",type:"local"},effectiveSettings:state.projectSettings(project.path,project.environmentId).effective};
  }
  const agentRuntimes=new AgentRuntimeManager({state,env,environments});
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
  const providerBridgeLogs=[];
  const providerBridge=mock?null:await startProviderBridge({
    port:0,
    providerManager:providers,
    provider:selectedProvider,
    log:(message)=>{
      providerBridgeLogs.push({at:Date.now(),stream:"provider-bridge",text:String(message)});
      if(providerBridgeLogs.length>100) providerBridgeLogs.splice(0,providerBridgeLogs.length-100);
    },
  });
  const selectedInferencePort=()=>selectedProvider==="freebuff"?DEFAULT_PORT:(providerBridge?.port??null);
  ensureCodexConfig({port:selectedInferencePort(),env,provider:selectedProvider});
  let bridge=null;
  let loginPromise=null;
  const checkpoints=new CheckpointService({state,env});
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
    if(!profile||profile.type==="local")return null;
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
  const worktreeCleanup=new WorktreeCleanupService({state,getUsage:worktreeUsage,log:message=>{cleanupLogs.push({at:Date.now(),stream:"cleanup",text:String(message)+"\n"});if(cleanupLogs.length>100)cleanupLogs.splice(0,cleanupLogs.length-100)}});
  const cloneJobs=new CloneJobService({state,environments,env,log:message=>appServer?.logs?.push({at:Date.now(),stream:"clone",text:String(message)+"\n"})});
  await cloneJobs.recoverInterrupted();
  let appServer=await startAppServer({
    appPort,
    env,
    mock,
    provider:selectedProvider,
    providerPort:selectedInferencePort(),
    environments,
    environmentId:state.settings().activeEnvironmentId||null,
    runtimeInstance:agentRuntimes.activeRuntime()==="codex"?agentRuntimes.activeInstance():null,
  });
  let remoteControl=null;

  function providerReady(providerId=selectedProvider){
    return providerId==="freebuff" ? (mock || isLoggedIn(env)) : (mock || providers.hasKey(providerId));
  }
  function markCodexTurnActive(threadId,turnId){
    if(!threadId||!turnId)return;
    state.updateThreadMeta(threadId,{active:true,restartRecovery:{runtime:"codex",bootId,threadId,turnId,status:"active",startedAt:Date.now()}});
  }
  function clearCodexRecovery(threadId,status="completed",message=null){
    if(!threadId)return;
    const current=state.threadMeta(threadId)?.restartRecovery;
    state.updateThreadMeta(threadId,{active:false,restartRecovery:current?{...current,bootId,status,finishedAt:Date.now(),...(message?{message}:{})}:undefined});
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
    await stopAppServer(appServer);
    selectedProvider=next;
    providerBridge?.setProvider(selectedProvider);
    ensureCodexConfig({port:selectedInferencePort(),env,provider:selectedProvider});
    appServer=await startAppServer({
      appPort,
      env,
      mock,
      provider:selectedProvider,
      providerPort:selectedInferencePort(),
      environments,
      environmentId:state.settings().activeEnvironmentId||null,
      runtimeInstance:agentRuntimes.activeRuntime()==="codex"?agentRuntimes.activeInstance():null,
    });
    if(!mock) await waitForAppServer(appServer,appPort,15000).catch(()=>false);
    return selectedProvider;
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
    let token=settings.remoteAccessToken;
    if(!token){
      token=newRemoteToken();
      state.updateSettings({remoteAccessToken:token});
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
    const response=await fetch(`http://127.0.0.1:${DEFAULT_PORT}/v1/chat/completions`,{
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
  function sourceControlStyleInstruction(style){
    if(style==="descriptive")return "Use a clear, specific engineering style. Prefer a descriptive subject over a vague one. Explain why the change matters in the review body.";
    if(style==="repository")return "Match this repository's existing writing conventions. Follow patterns from recent commit subjects and repository instructions when they are present.";
    return "Be concise and direct. Avoid filler, marketing language, and redundant detail.";
  }
  async function sourceControlWritingContext(cwd,environmentId,{includeInstructions=false}={}){
    const subjects=await inSourceControlEnvironment(environmentId,()=>sourceControlRecentCommitSubjects(cwd,{limit:10})).catch(()=>[]);
    const instructions=[];
    if(includeInstructions){
      for(const relativePath of ["AGENTS.md","CLAUDE.md","CONTRIBUTING.md",".github/pull_request_template.md"]){
        try{
          const filePath=remoteEnvironmentProfile(environmentId)?relativePath:join(cwd,relativePath);
          const file=await environmentWorkspaceFile(filePath,12_000,{root:cwd,environments,environmentId});
          const content=String(file.content||"").trim();if(content)instructions.push({path:relativePath,content});
        }catch{}
      }
    }
    return {subjects,instructions};
  }
  async function sourceControlTextRequest({cwd,environmentId,kind,model=null}){
    const scoped=state.projectSettings(cwd,environmentId).effective;
    const style=scoped.sourceControlTextStyle||"concise";const selectedModel=scoped.sourceControlTextModel||model||null;
    const diff=await environmentWorkspaceDiff(cwd,{environments,environmentId});
    const context=await sourceControlWritingContext(cwd,environmentId,{includeInstructions:style==="repository"});
    const recent=context.subjects.length?"Recent commit subjects:\n"+context.subjects.map(subject=>"- "+subject).join("\n")+"\n\n":"";
    const instructions=context.instructions.length?"Repository instructions:\n"+context.instructions.map(item=>"### "+item.path+"\n"+item.content.slice(0,6000)).join("\n\n")+"\n\n":"";
    const styleInstruction=sourceControlStyleInstruction(style);
    const prompt=kind==="review"
      ?[
        "Generate a pull request title and description for the current change.",
        styleInstruction,
        "Return strict JSON only with this shape: {\"title\":\"...\",\"body\":\"...\"}.",
        "Keep the title under 100 characters. The body should summarize the change and validation without inventing tests or results.",
        recent,instructions,"Status:\n"+String(diff.status||"").slice(0,12000),"Diff:\n"+String(diff.diff||"").slice(0,60000),
      ].filter(Boolean).join("\n\n")
      :[
        "Write one Git commit subject for the current change.",
        styleInstruction,
        "Use imperative mood when it fits the repository convention. Keep it under 100 characters. Return only the subject with no quotes or markdown.",
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
          if("modelProvider" in patch) patch.modelProvider=normalizeProviderId(patch.modelProvider);
          if("agentRuntime" in patch) patch.agentRuntime=normalizeAgentRuntime(patch.agentRuntime);
          const previous=selectedProvider;
          const previousAgentRuntime=selectedAgentRuntime;
          const next=state.updateSettings(patch);
          if("modelProvider" in patch && patch.modelProvider!==previous) await restartAppServer(patch.modelProvider);
          if("agentRuntime" in patch && patch.agentRuntime!==previousAgentRuntime){
            selectedAgentRuntime=patch.agentRuntime;
            if(selectedAgentRuntime==="codex")await restartAppServer(selectedProvider);
          }
          if("remoteAccessEnabled" in patch||"remoteAccessPort" in patch||"remoteAccessToken" in patch) await syncRemoteControl();
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
    if(url.pathname==="/api/environment/activate"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const id=body.id?String(body.id):null;
        if(id&&!environments.get(id)) throw new Error("Environment profile was not found");
        state.updateSettings({activeEnvironmentId:id});
        await agentRelay?.reset?.();
        await restartAppServer(selectedProvider);
        return json(res,200,{
          activeEnvironmentId:id,
          activeEnvironment:id?environments.get(id):null,
          appServerReady:mock||await appServerReady(appServer,appPort),
          error:appServer?.error||null,
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
    if(url.pathname==="/api/usage"){
      if(req.method==="GET"){
        const requested=url.searchParams.getAll("environmentId");
        const environmentIds=requested.length?requested.map(value=>!value||value==="local"?null:value):undefined;
        return json(res,200,state.usage({days:Number(url.searchParams.get("days")||30),limit:Number(url.searchParams.get("limit")||1000),environmentIds}));
      }
      if(req.method==="DELETE")return json(res,200,{ok:true,cleared:state.clearUsage()});
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
          if(body.regenerateToken||(!state.settings().remoteAccessToken&&body.enabled)) patch.remoteAccessToken=newRemoteToken();
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
          const result=await inSourceControlEnvironment(environmentId,()=>sourceControlGitAction(cwd,{
            action:body.action,
            name:body.action==="worktree-create"?body.branch:body.name,
            message:body.message,
            setUpstream:Boolean(body.setUpstream),
            startPoint:body.baseBranch||body.startPoint||null,
            path:body.path||null,
            force:Boolean(body.force),
          }));
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
          case "clone": result=await cloneRepository(body.url,body.destination); state.touchProject(result.root||body.destination,{environmentId:null}); break;
          case "init": result=await initializeRepository(cwd); state.touchProject(result.root||cwd,{environmentId:null}); break;
          case "branch-create": result=await createBranch(cwd,body.name,{checkout:body.checkout!==false,startPoint:body.startPoint||null}); break;
          case "branch-switch": result=await switchBranch(cwd,body.name); break;
          case "commit": result=await commitAll(cwd,body.message||"Trebell Code changes"); break;
          case "fetch": result=await fetchRepo(cwd); break;
          case "pull": result=await pullRepo(cwd); break;
          case "push": result=await pushRepo(cwd,{setUpstream:Boolean(body.setUpstream)}); break;
          case "auto-pull": result=await safeAutoPull(cwd); break;
          case "worktree-create": {
            const sourceProject=state.project(resolve(cwd),null);
            const projectConfig=await projectActionSuggestions(cwd).catch(()=>({t3:{}}));
            const scoped=sourceProject?state.projectSettings(sourceProject.path,null):{defaults:state.environmentDefaults(null),overrides:{}};
            const submodules=scoped.overrides.worktreeSubmodules||projectConfig?.t3?.worktreeSubmodules||scoped.defaults.worktreeSubmodules||"recursive";
            result=await createWorktree(cwd,{branch:body.branch,path:body.path,baseBranch:body.baseBranch||null,submodules});
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
          case "worktree-remove": result=await removeWorktree(cwd,body.path,{force:Boolean(body.force)}); break;
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
        return json(res,200,{ok:true,...await inSourceControlEnvironment(environmentId,()=>createPullRequest(cwd,body))});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/source-control/publish" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const environmentId=Object.prototype.hasOwnProperty.call(body,"environmentId")?requestedEnvironmentId(body.environmentId,{fallback:false}):requestedEnvironmentId(null);
        const cwd=environmentPath(body.cwd||remoteEnvironmentProfile(environmentId)?.cwd||process.cwd(),environmentId);
        return json(res,200,await inSourceControlEnvironment(environmentId,()=>publishRepository(cwd,body)));
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
        if(body.action==="edit") return json(res,200,await inSourceControlEnvironment(environmentId,()=>editPullRequest(cwd,body.number,{provider:body.provider||null,title:body.title,body:body.body||""})));
        if(body.action==="edit-comment") return json(res,200,await inSourceControlEnvironment(environmentId,()=>editPullRequestComment(cwd,body.number,body.commentId,body.body||"",{provider:body.provider||null})));
        if(body.action==="approve-workflows") return json(res,200,await inSourceControlEnvironment(environmentId,()=>approvePullRequestWorkflows(cwd,body.number,{provider:body.provider||null})));
        if(body.action==="revert") return json(res,200,await inSourceControlEnvironment(environmentId,()=>revertPullRequest(cwd,body.number,{provider:body.provider||null})));
        if(body.action==="rebase-stack") return json(res,200,await inSourceControlEnvironment(environmentId,()=>rebasePullRequestStack(cwd,body.number,{provider:body.provider||null})));
        if(body.action==="comment") return json(res,200,await inSourceControlEnvironment(environmentId,()=>commentOnPullRequest(cwd,body.number,body.body||"",{provider:body.provider||null})));
        if(body.action==="review") return json(res,200,await inSourceControlEnvironment(environmentId,()=>reviewPullRequest(cwd,body.number,{provider:body.provider||null,event:body.event,body:body.body||""})));
        if(body.action==="merge") return json(res,200,await inSourceControlEnvironment(environmentId,()=>mergePullRequest(cwd,body.number,{provider:body.provider||null,method:body.method,auto:Boolean(body.auto)})));
        if(body.action==="update-branch") return json(res,200,await inSourceControlEnvironment(environmentId,()=>updatePullRequestBranch(cwd,body.number,{provider:body.provider||null,rebase:body.rebase!==false})));
        if(body.action==="checkout") return json(res,200,await inSourceControlEnvironment(environmentId,()=>checkoutPullRequest(cwd,body.number,{provider:body.provider||null})));
        if(body.action==="request-reviewer") return json(res,200,await inSourceControlEnvironment(environmentId,()=>requestPullRequestReviewer(cwd,body.number,body.reviewer,{provider:body.provider||null})));
        return json(res,400,{error:"unknown PR action"});
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
          return json(res,200,await checkpoints.create(body));
        }catch(error){return json(res,400,{error:error.message});}
      }
    }
    if(url.pathname==="/api/checkpoints/link" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        return json(res,200,{checkpoint:checkpoints.link(body.id,body.patch||{})});
      }catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/checkpoints/restore" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        return json(res,200,await checkpoints.restore(body.id));
      }catch(error){return json(res,400,{error:error.message});}
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
      const agentSnapshot=await agentRuntimes.snapshot().catch(()=>({selectedRuntime:selectedAgentRuntime,selectedInstanceId:`${selectedAgentRuntime}-default`,statuses:[]}));
      const activeAgentStatus=agentSnapshot.statuses?.find(item=>item.id===agentSnapshot.selectedInstanceId)||null;
      return json(res,200,{
        mock,
        loggedIn:mock || isLoggedIn(env),
        agentRuntime:selectedAgentRuntime,
        agentRuntimeInstanceId:agentSnapshot.selectedInstanceId,
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
        const overview=await getFreebuffOverview({model,timezone,bridgePort:DEFAULT_PORT,env});
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
        const overview=await getFreebuffOverview({model,timezone,heartbeat:true,bridgePort:DEFAULT_PORT,env});
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
        const response=await fetch("https://api.github.com/repos/tanishqbaweja/trebellcode/releases/latest",{headers:{"User-Agent":"Trebell-Code/"+TREBELL_VERSION},signal:AbortSignal.timeout(8000)});
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

  const terminalWs=terminals?.attachWebSocket(server);
  const relay=attachCodexRelay(server,{
    targetUrl:()=>appServer?.targetUrl||`ws://127.0.0.1:${appPort}`,
    enabled:()=>mock || Boolean(appServer?.child && appServer.child.exitCode===null),
    log:(message)=>appServer?.logs?.push({at:Date.now(),stream:"relay",text:message}),
    onClientMessage:message=>{
      if((message?.method==="thread/resume"||message?.method==="turn/start")&&message.params?.threadId&&message.params?.cwd){
        state.updateThreadMeta(message.params.threadId,{cwd:message.params.cwd,runtime:"codex",deletedAt:null});
      }
      if(message?.method==="turn/start"){
        const threadId=message.params?.threadId,model=message.params?.model;if(threadId&&model)codexThreadModels.set(threadId,model);
      }
    },
    onServerMessage:message=>{
      const params=message?.params||{};
      if(message?.method==="thread/started"&&params.thread?.id){
        if(params.thread.model)codexThreadModels.set(params.thread.id,params.thread.model);
        state.updateThreadMeta(params.thread.id,{cwd:params.thread.cwd||null,runtime:"codex",environmentId:state.settings().activeEnvironmentId||null,deletedAt:null,active:false});
      }
      if(message?.method==="thread/deleted"&&params.threadId){
        codexThreadModels.delete(params.threadId);const meta=state.threadMeta(params.threadId);state.updateThreadMeta(params.threadId,{deletedAt:Date.now(),active:false});
        if(meta?.cwd)worktreeCleanup.sweep({reason:"thread-delete",path:meta.cwd}).catch(error=>cleanupLogs.push({at:Date.now(),stream:"cleanup",text:error.message+"\n"}));
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
    version:TREBELL_VERSION,
    log:(message)=>appServer?.logs?.push({at:Date.now(),stream:"agent-relay",text:String(message)+"\n"}),
    onThreadDeleted:thread=>thread?.cwd?worktreeCleanup.sweep({reason:"thread-delete",path:thread.cwd}):null,
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
      await syncBranchPullRequests().catch(error=>appServer?.logs?.push({at:Date.now(),stream:"branch-pr-sync",text:error.message+"\n"}));
      for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
        const links=(meta.attachments||[]).filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload||{});
        if(!links.length)continue;
        const states=links.map(link=>String(link.snapshot?.state||link.state||"").toUpperCase());
        if(states.length&&states.every(value=>value==="MERGED"))continue;
        const openOrUnknown=states.some(value=>!value||value==="OPEN");
        const cadence=openOrUnknown?60_000:10*60_000;
        if(now-Number(meta.lastPullRequestSyncAt||0)<cadence)continue;
        await syncThreadPullRequestLinks(threadId).catch(error=>appServer?.logs?.push({at:Date.now(),stream:"pr-sync",text:error.message+"\n"}));
      }
    }finally{pullRequestSyncRunning=false}
  };
  const sweepAutoPull=async()=>{
    if(autoPullRunning)return;autoPullRunning=true;
    try{
      await sweepAutoPullProjects({
        state,
        pullProject:project=>inSourceControlEnvironment(project.environmentId||null,()=>sourceControlGitAction(project.path,{action:"auto-pull"})),
        log:message=>appServer?.logs?.push({at:Date.now(),stream:"auto-pull",text:String(message)+"\n"}),
      });
    }finally{autoPullRunning=false}
  };
  if(!mock){
    worktreeCleanup.sweep().catch(error=>cleanupLogs.push({at:Date.now(),stream:"cleanup",text:error.message+"\n"}));
    cleanupTimer=setInterval(()=>worktreeCleanup.sweep().catch(error=>cleanupLogs.push({at:Date.now(),stream:"cleanup",text:error.message+"\n"})),60*60_000);cleanupTimer.unref?.();
    setTimeout(()=>sweepPullRequestLinks().catch(()=>{}),5000).unref?.();
    pullRequestSyncTimer=setInterval(()=>sweepPullRequestLinks().catch(()=>{}),60_000);pullRequestSyncTimer.unref?.();
    setTimeout(()=>sweepAutoPull().catch(()=>{}),7000).unref?.();
    autoPullTimer=setInterval(()=>sweepAutoPull().catch(()=>{}),5*60_000);autoPullTimer.unref?.();
  }
  if(state.settings().remoteAccessEnabled) await syncRemoteControl().catch(error=>{
    appServer?.logs?.push({at:Date.now(),stream:"remote",text:"remote access failed: "+error.message+"\n"});
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
        stopAppServer(appServer),
        stopChildProcess(bridge?.child),
        providerBridge?.close(),
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
