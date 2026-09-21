import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { cpus, freemem, totalmem, tmpdir, loadavg } from "node:os";
import { basename, extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { attachCodexRelay, probeCodexReady, waitForCodexReady } from "./codex-relay.mjs";
import { workspaceDiff, workspaceFile, workspaceSearch, workspaceTree, workspaceWriteFile } from "./workspace.mjs";
import { spawn } from "node:child_process";
import { codexBin, codexHome, packageRoot, trebellHome } from "./paths.mjs";
import { DEFAULT_PORT, ensureCodexConfig } from "./config.mjs";
import { health, isLoggedIn, listModels, listModelMetadata, logout, runLogin, startBridge } from "./freebuff.mjs";
import { getFreebuffOverview } from "./freebuff-product.mjs";
import { TrebellStateStore } from "./trebell-state.mjs";
import { CheckpointService } from "./checkpoint-service.mjs";
import { TerminalManager } from "./terminal-manager.mjs";
import { EnvironmentManager } from "./environment-manager.mjs";
import { startRemoteAppServer } from "./environment-app-server.mjs";
import { createRemoteControlServer } from "./remote-control.mjs";
import { ProviderManager, normalizeProviderId } from "./provider-manager.mjs";
import { startProviderBridge } from "./provider-bridge.mjs";

const TREBELL_VERSION = await readFile(join(packageRoot,"package.json"),"utf8")
  .then(text=>String(JSON.parse(text).version||"0.0.0"))
  .catch(()=>"0.0.0");
import {
  gitInfo, cloneRepository, createBranch, switchBranch, commitAll, fetchRepo, pullRepo, pushRepo,
  safeAutoPull, createWorktree, removeWorktree,
} from "./git-service.mjs";
import {
  sourceControlDiagnostics, listPullRequests, createPullRequest, pullRequestDetail,
  commentOnPullRequest, reviewPullRequest, mergePullRequest, updatePullRequestBranch,
} from "./source-control-service.mjs";

const MIME = {
  ".html":"text/html; charset=utf-8",
  ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".svg":"image/svg+xml",
  ".png":"image/png",
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

async function startAppServer({appPort,env=process.env,mock=false,provider="freebuff",environments=null,environmentId=null}){
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
  ensureCodexConfig({port:DEFAULT_PORT,env,provider});
  const command=codexBin(env);
  const logs=[];
  const pushLog=(chunk,stream)=>{
    const line=String(chunk);
    logs.push({at:Date.now(),stream,text:line});
    if(logs.length>250) logs.splice(0,logs.length-250);
    if(env.TREBELL_GUI_DEBUG==="1") (stream==="stderr"?process.stderr:process.stdout).write(chunk);
  };
  const child=spawn(command,["app-server","--listen",`ws://127.0.0.1:${appPort}`],{
    cwd:process.cwd(),
    env:{...env,CODEX_HOME:codexHome(env)},
    windowsHide:true,
    shell:process.platform==="win32" && !command.toLowerCase().endsWith(".exe"),
    stdio:["ignore","pipe","pipe"],
  });
  child.stdout?.on("data",chunk=>pushLog(chunk,"stdout"));
  child.stderr?.on("data",chunk=>pushLog(chunk,"stderr"));
  child.on("error",error=>pushLog(error.stack||error.message,"stderr"));
  child.on("exit",(code,signal)=>pushLog(`app-server exited code=${code} signal=${signal}\n`,"stderr"));
  return { child, logs, targetUrl:`ws://127.0.0.1:${appPort}`, readyUrl:`http://127.0.0.1:${appPort}/readyz`, environment:null };
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
  let disk="—";
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

export async function createGuiServer({port=3210,appPort=23456,host="127.0.0.1",mock=false,env=process.env}={}){
  const dist=resolve(packageRoot,"ui","dist");
  const state=new TrebellStateStore(env);
  const providers=new ProviderManager({env});
  let selectedProvider=normalizeProviderId(state.settings().modelProvider);
  if(state.settings().modelProvider!==selectedProvider) state.updateSettings({modelProvider:selectedProvider});
  const providerBridgeLogs=[];
  const providerBridge=mock?null:await startProviderBridge({
    providerManager:providers,
    provider:selectedProvider,
    log:(message)=>{
      providerBridgeLogs.push({at:Date.now(),stream:"provider-bridge",text:String(message)});
      if(providerBridgeLogs.length>100) providerBridgeLogs.splice(0,providerBridgeLogs.length-100);
    },
  });
  ensureCodexConfig({port:DEFAULT_PORT,env,provider:selectedProvider});
  let bridge=null;
  let loginPromise=null;
  const checkpoints=new CheckpointService({state,env});
  const terminals=mock ? null : new TerminalManager({env});
  const environments=new EnvironmentManager({state,env});
  let appServer=await startAppServer({
    appPort,
    env,
    mock,
    provider:selectedProvider,
    environments,
    environmentId:state.settings().activeEnvironmentId||null,
  });
  let remoteControl=null;

  function providerReady(providerId=selectedProvider){
    return providerId==="freebuff" ? (mock || isLoggedIn(env)) : (mock || providers.hasKey(providerId));
  }

  async function restartAppServer(providerId=selectedProvider){
    const next=normalizeProviderId(providerId);
    await stopAppServer(appServer);
    selectedProvider=next;
    providerBridge?.setProvider(selectedProvider);
    ensureCodexConfig({port:DEFAULT_PORT,env,provider:selectedProvider});
    appServer=await startAppServer({
      appPort,
      env,
      mock,
      provider:selectedProvider,
      environments,
      environmentId:state.settings().activeEnvironmentId||null,
    });
    if(!mock) await waitForAppServer(appServer,appPort,15000).catch(()=>false);
    return selectedProvider;
  }

  async function selectedModels(){
    if(mock) return {models:fakeModels(selectedProvider),metadata:{provider:selectedProvider,models:fakeModels(selectedProvider).map(id=>({id,provider:selectedProvider}))}};
    if(selectedProvider==="freebuff"){
      if(!isLoggedIn(env)) return {models:[],metadata:{provider:"freebuff",models:[]}};
      await ensureBridge();
      const [models,metadata]=await Promise.all([
        listModels(DEFAULT_PORT),
        listModelMetadata(DEFAULT_PORT).catch(()=>({registry:null,models:[]})),
      ]);
      return {models:models.filter(id=>id.startsWith("freebuff/")),metadata:{...metadata,provider:"freebuff"}};
    }
    const result=await providers.models(selectedProvider);
    return {models:result.models||[],metadata:{provider:selectedProvider,source:result.source,models:result.metadata||[]},error:result.error||null};
  }

  function newRemoteToken(){ return randomBytes(24).toString("base64url"); }
  function remoteInfo(){
    const settings=state.settings();
    return {
      enabled:Boolean(settings.remoteAccessEnabled),
      running:Boolean(remoteControl),
      port:Number(settings.remoteAccessPort||3211),
      token:settings.remoteAccessToken||"",
      urls:remoteControl?.urls||[],
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
      enabled:()=>mock || Boolean(appServer?.child && appServer.child.exitCode===null),
      environments,
      getStatus:async()=>{
        const catalog=await selectedModels().catch(()=>({models:[]}));
        return {
          cwd:process.cwd(),
          loggedIn:mock||isLoggedIn(env),
          provider:selectedProvider,
          providerReady:providerReady(),
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
  if(!mock && isLoggedIn(env)) ensureBridge().catch(()=>{});

  const server=createServer(async(req,res)=>{
    const url=new URL(req.url || "/",`http://127.0.0.1:${port}`);

    if(url.pathname==="/api/state" && req.method==="GET") return json(res,200,state.snapshot());
    if(url.pathname==="/api/settings"){
      if(req.method==="GET") return json(res,200,state.settings());
      if(req.method==="POST"){
        try{
          const patch=await readJsonBody(req);
          if("modelProvider" in patch) patch.modelProvider=normalizeProviderId(patch.modelProvider);
          const previous=selectedProvider;
          const next=state.updateSettings(patch);
          if("modelProvider" in patch && patch.modelProvider!==previous) await restartAppServer(patch.modelProvider);
          if("remoteAccessEnabled" in patch||"remoteAccessPort" in patch||"remoteAccessToken" in patch) await syncRemoteControl();
          return json(res,200,next);
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
    if(url.pathname==="/api/environment/execute"&&req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        return json(res,200,await environments.execute(body.id,body));
      }catch(error){return json(res,400,{error:error.message});}
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
    if(url.pathname==="/api/projects"){
      if(req.method==="GET") return json(res,200,{projects:state.projects()});
      if(req.method==="POST"){
        try{
          const body=await readJsonBody(req);
          if(!body.path) return json(res,400,{error:"path is required"});
          const project=state.touchProject(resolve(body.path),body);
          return json(res,200,{project});
        }catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="DELETE"){
        const id=url.searchParams.get("id"); if(id) state.removeProject(id);
        return json(res,200,{ok:true});
      }
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
      try{return json(res,200,await gitInfo(url.searchParams.get("path")||process.cwd()));}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/git/action" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const cwd=body.cwd||process.cwd();
        let result;
        switch(body.action){
          case "clone": result=await cloneRepository(body.url,body.destination); state.touchProject(result.root||body.destination); break;
          case "branch-create": result=await createBranch(cwd,body.name,{checkout:body.checkout!==false,startPoint:body.startPoint||null}); break;
          case "branch-switch": result=await switchBranch(cwd,body.name); break;
          case "commit": result=await commitAll(cwd,body.message||"Trebell Code changes"); break;
          case "fetch": result=await fetchRepo(cwd); break;
          case "pull": result=await pullRepo(cwd); break;
          case "push": result=await pushRepo(cwd,{setUpstream:Boolean(body.setUpstream)}); break;
          case "auto-pull": result=await safeAutoPull(cwd); break;
          case "worktree-create": result=await createWorktree(cwd,{branch:body.branch,path:body.path,baseBranch:body.baseBranch||null}); state.touchProject(result.worktree); break;
          case "worktree-remove": result=await removeWorktree(cwd,body.path,{force:Boolean(body.force)}); break;
          default:return json(res,400,{error:"unknown git action"});
        }
        return json(res,200,{ok:true,result});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/source-control/diagnostics"){
      try{return json(res,200,await sourceControlDiagnostics(url.searchParams.get("path")||process.cwd(),url.searchParams.get("provider")||null));}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/source-control/prs"){
      return json(res,200,await listPullRequests(url.searchParams.get("path")||process.cwd(),{provider:url.searchParams.get("provider")||null}));
    }
    if(url.pathname==="/api/source-control/pr" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        return json(res,200,{ok:true,...await createPullRequest(body.cwd||process.cwd(),body)});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/source-control/pr-detail"){
      return json(res,200,await pullRequestDetail(url.searchParams.get("path")||process.cwd(),url.searchParams.get("number"),{provider:url.searchParams.get("provider")||null}));
    }
    if(url.pathname==="/api/source-control/pr-action" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const cwd=body.cwd||process.cwd();
        if(body.action==="comment") return json(res,200,await commentOnPullRequest(cwd,body.number,body.body||"",{provider:body.provider||null}));
        if(body.action==="review") return json(res,200,await reviewPullRequest(cwd,body.number,{provider:body.provider||null,event:body.event,body:body.body||""}));
        if(body.action==="merge") return json(res,200,await mergePullRequest(cwd,body.number,{provider:body.provider||null,method:body.method,auto:Boolean(body.auto)}));
        if(body.action==="update-branch") return json(res,200,await updatePullRequestBranch(cwd,body.number,{provider:body.provider||null,rebase:body.rebase!==false}));
        return json(res,400,{error:"unknown PR action"});
      }catch(error){return json(res,400,{ok:false,error:error.message});}
    }
    if(url.pathname==="/api/git/commit-message" && req.method==="POST"){
      try{
        const body=await readJsonBody(req);
        const diff=await workspaceDiff(body.cwd||process.cwd());
        const prompt=`Write one concise Git commit subject (imperative, <=72 chars) for this change. Return only the subject.\n\nStatus:\n${diff.status}\n\nDiff:\n${diff.diff.slice(0,60000)}`;
        const answer=selectedProvider==="freebuff"
          ? await queryFreebuff(prompt,body.model)
          : await providers.directChat(selectedProvider,{prompt,model:body.model});
        return json(res,200,{message:answer.text.trim().split(/\r?\n/)[0].replace(/^["']|["']$/g,"")});
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
      if(req.method==="GET") return json(res,200,{sessions:terminals.list()});
      if(req.method==="POST"){
        try{return json(res,200,{session:await terminals.create(await readJsonBody(req))});}
        catch(error){return json(res,400,{error:error.message});}
      }
      if(req.method==="DELETE"){
        const id=url.searchParams.get("id"); if(id) await terminals.close(id);
        return json(res,200,{ok:true});
      }
    }

    if(url.pathname==="/api/bootstrap"){
      const appReady=mock || await appServerReady(appServer,appPort);
      return json(res,200,{
        mock,
        loggedIn:mock || isLoggedIn(env),
        provider:selectedProvider,
        providerReady:providerReady(),
        bridgeReady:selectedProvider==="freebuff" ? (mock || await health(DEFAULT_PORT)) : false,
        appServerReady:appReady,
        wsUrl:mock ? null : (env.TREBELL_GUI_PUBLIC==="1"
          ? `${String(req.headers["x-forwarded-proto"]||"https").split(",")[0].trim()==="https"?"wss":"ws"}://${String(req.headers["x-forwarded-host"]||req.headers.host||"").split(",")[0].trim()}/api/codex/ws`
          : `ws://127.0.0.1:${port}/api/codex/ws`),
        cwd:process.cwd(),
        platform:process.platform,
        version:TREBELL_VERSION,
        activeEnvironment:appServer?.environment||null,
        appServerError:appServer?.error||null,
      });
    }
    if(url.pathname==="/api/runtime"){
      return json(res,200,{
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
      try{return json(res,200,await workspaceTree(url.searchParams.get("path")||process.cwd()));}
      catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}
    }
    if(url.pathname==="/api/workspace/diff"){
      return json(res,200,await workspaceDiff(url.searchParams.get("path")||process.cwd()));
    }
    if(url.pathname==="/api/workspace/file"){
      if(req.method==="PUT"){
        try{
          const body=await readJsonBody(req,4*1024*1024);
          return json(res,200,await workspaceWriteFile(body.path,body.content));
        }catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}
      }
      try{return json(res,200,await workspaceFile(url.searchParams.get("path")||""));}
      catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}
    }
    if(url.pathname==="/api/workspace/search"){
      try{return json(res,200,await workspaceSearch(url.searchParams.get("path")||process.cwd(),url.searchParams.get("q")||""));}
      catch(error){return json(res,400,{error:error.message});}
    }
    if(url.pathname==="/api/attachments/text" && req.method==="POST"){
      try{
        const body=await readJsonBody(req,4*1024*1024);
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
        const body=await readJsonBody(req,24*1024*1024);
        const data=Buffer.from(String(body.dataBase64||""),"base64");
        if(data.length>15*1024*1024) return json(res,413,{error:"Attachment is larger than 15 MB"});
        const dir=join(trebellHome(env),"attachments");
        await mkdir(dir,{recursive:true});
        const safe=String(body.name||"attachment.bin").replace(/[^a-zA-Z0-9._-]/g,"_").slice(-80);
        const path=join(dir,`${Date.now()}-${randomUUID().slice(0,8)}-${safe}`);
        await writeFile(path,data);
        return json(res,200,{path,name:basename(path),size:data.length,mime:body.mime||"application/octet-stream"});
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
        return json(res,200,{provider:selectedProvider,ready:providerReady(),models:catalog.models||[],metadata:catalog.metadata||null,error:catalog.error||null});
      }catch(error){
        return json(res,503,{provider:selectedProvider,ready:providerReady(),models:[],error:error instanceof Error?error.message:String(error)});
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
  });

  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(port,host,resolve);
  });
  if(!mock) waitForAppServer(appServer,appPort,15000).catch(()=>false);
  if(state.settings().remoteAccessEnabled) await syncRemoteControl().catch(error=>{
    appServer?.logs?.push({at:Date.now(),stream:"remote",text:"remote access failed: "+error.message+"\n"});
  });

  return {
    url:`http://${host==="0.0.0.0"?"127.0.0.1":host}:${port}`,
    server,
    close:async()=>{
      relay.close();
      terminalWs?.close();
      await Promise.allSettled([
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
