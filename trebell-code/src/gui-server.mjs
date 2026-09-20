import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { cpus, freemem, totalmem, tmpdir, loadavg } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { attachCodexRelay, probeCodexReady, waitForCodexReady } from "./codex-relay.mjs";
import { workspaceDiff, workspaceFile, workspaceTree } from "./workspace.mjs";
import { spawn } from "node:child_process";
import { codexBin, codexHome, packageRoot } from "./paths.mjs";
import { DEFAULT_PORT, ensureCodexConfig } from "./config.mjs";
import { health, isLoggedIn, listModels, logout, runLogin, startBridge } from "./freebuff.mjs";
import { getFreebuffOverview } from "./freebuff-product.mjs";

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

function parseArgs(argv){
  const out={port:Number(process.env.TREBELL_GUI_PORT||3210),appPort:Number(process.env.TREBELL_APP_SERVER_PORT||23456),open:false,mock:process.env.TREBELL_GUI_MOCK==="1"};
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

function startAppServer({appPort,env=process.env,mock=false}){
  if(mock) return { child:null, logs:[], targetUrl:null };
  ensureCodexConfig({port:DEFAULT_PORT,env});
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
  return { child, logs, targetUrl:`ws://127.0.0.1:${appPort}` };
}

function fakeModels(){
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

export async function createGuiServer({port=3210,appPort=23456,mock=false,env=process.env}={}){
  ensureCodexConfig({port:DEFAULT_PORT,env});
  const dist=resolve(packageRoot,"ui","dist");
  let bridge=null;
  let appServer=startAppServer({appPort,env,mock});
  let loginPromise=null;

  async function ensureBridge(){
    if(mock) return null;
    if(await health(DEFAULT_PORT)) return bridge;
    if(!isLoggedIn(env)) return null;
    bridge=await startBridge({port:DEFAULT_PORT,env,quiet:true});
    return bridge;
  }
  if(!mock && isLoggedIn(env)) ensureBridge().catch(()=>{});

  const server=createServer(async(req,res)=>{
    const url=new URL(req.url || "/",`http://127.0.0.1:${port}`);
    if(url.pathname==="/api/bootstrap"){
      const appServerReady=mock || await probeCodexReady(appPort);
      return json(res,200,{
        mock,
        loggedIn:mock || isLoggedIn(env),
        bridgeReady:mock || await health(DEFAULT_PORT),
        appServerReady,
        wsUrl:mock ? null : `ws://127.0.0.1:${port}/api/codex/ws`,
        cwd:process.cwd(),
        version:"0.5.0",
      });
    }
    if(url.pathname==="/api/runtime"){
      return json(res,200,{
        appServerReady:mock || await probeCodexReady(appPort),
        bridgeReady:mock || await health(DEFAULT_PORT),
        appServerExitCode:appServer?.child?.exitCode ?? null,
        logs:(appServer?.logs || []).slice(-80),
      });
    }
    if(url.pathname==="/api/chat/direct" && req.method==="POST"){
      if(!isLoggedIn(env) && !mock) return json(res,401,{error:"Sign in to Freebuff first."});
      let body="";
      for await (const chunk of req) body+=chunk;
      let payload={};
      try{payload=JSON.parse(body||"{}");}catch{return json(res,400,{error:"Invalid JSON"});}
      const prompt=String(payload.prompt||"").trim();
      const model=String(payload.model||"").trim();
      if(!prompt || !model) return json(res,400,{error:"prompt and model are required"});
      if(mock) return json(res,200,{text:`Mock Freebuff reply: ${prompt}`,model});
      try{
        await ensureBridge();
        const response=await fetch(`http://127.0.0.1:${DEFAULT_PORT}/v1/chat/completions`,{
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify({model,messages:[{role:"user",content:prompt}],stream:false}),
          signal:AbortSignal.timeout(300000),
        });
        const raw=await response.text();
        if(!response.ok) return json(res,response.status,{error:raw.slice(0,1200)});
        const parsed=JSON.parse(raw);
        const text=parsed?.choices?.[0]?.message?.content ?? "";
        return json(res,200,{text,model,raw:parsed});
      }catch(error){
        return json(res,502,{error:error instanceof Error?error.message:String(error)});
      }
    }
    if(url.pathname==="/api/workspace/tree"){
      try{return json(res,200,await workspaceTree(url.searchParams.get("path")||process.cwd()));}
      catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}
    }
    if(url.pathname==="/api/workspace/diff"){
      return json(res,200,await workspaceDiff(url.searchParams.get("path")||process.cwd()));
    }
    if(url.pathname==="/api/workspace/file"){
      try{return json(res,200,await workspaceFile(url.searchParams.get("path")||""));}
      catch(error){return json(res,400,{error:error instanceof Error?error.message:String(error)});}
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
      if(mock) return json(res,200,{models:fakeModels()});
      if(!isLoggedIn(env)) return json(res,200,{models:[]});
      try{
        await ensureBridge();
        const models=(await listModels(DEFAULT_PORT)).filter(id=>id.startsWith("freebuff/"));
        return json(res,200,{models});
      }catch(error){
        return json(res,503,{models:[],error:error instanceof Error?error.message:String(error)});
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

  const relay=attachCodexRelay(server,{
    targetUrl:`ws://127.0.0.1:${appPort}`,
    enabled:()=>mock || Boolean(appServer?.child && appServer.child.exitCode===null),
    log:(message)=>appServer?.logs?.push({at:Date.now(),stream:"relay",text:message}),
  });

  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(port,"127.0.0.1",resolve);
  });
  if(!mock) waitForCodexReady(appPort,15000).catch(()=>false);

  return {
    url:`http://127.0.0.1:${port}`,
    server,
    close:async()=>{
      relay.close();
      try{appServer?.child?.kill("SIGTERM");}catch{}
      try{bridge?.child?.kill("SIGTERM");}catch{}
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
