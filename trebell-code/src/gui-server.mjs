import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { cpus, freemem, totalmem, tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { codexBin, codexHome, packageRoot } from "./paths.mjs";
import { DEFAULT_PORT, ensureCodexConfig } from "./config.mjs";
import { health, isLoggedIn, listModels, logout, runLogin, startBridge } from "./freebuff.mjs";

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
  if(mock) return null;
  ensureCodexConfig({port:DEFAULT_PORT,env});
  const command=codexBin(env);
  const child=spawn(command,["app-server","--listen",`ws://127.0.0.1:${appPort}`],{
    cwd:process.cwd(),
    env:{...env,CODEX_HOME:codexHome(env)},
    windowsHide:true,
    shell:process.platform==="win32",
    stdio:["ignore","pipe","pipe"],
  });
  child.stdout?.on("data",chunk=>{ if(process.env.TREBELL_GUI_DEBUG==="1") process.stdout.write(chunk); });
  child.stderr?.on("data",chunk=>{ if(process.env.TREBELL_GUI_DEBUG==="1") process.stderr.write(chunk); });
  child.on("exit",(code)=>{ if(code && process.env.TREBELL_GUI_DEBUG==="1") console.error(`Trebell app-server exited with ${code}`); });
  return child;
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
    const [one]=process.platform==="win32" ? [0] : (awaitableLoad());
    return one||0;
  }catch{return 0}
}
function awaitableLoad(){
  // Imported lazily this way to keep the public stats helper deterministic in tests.
  const osLoad=cpus().length ? Number(process.env.TREBELL_TEST_LOAD || 0) : 0;
  if(osLoad) return [osLoad];
  // process.resourceUsage() is process-scoped; loadAverage is preferable for the system card.
  return [0];
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
      return json(res,200,{
        mock,
        loggedIn:mock || isLoggedIn(env),
        bridgeReady:mock || await health(DEFAULT_PORT),
        appServerReady:mock || Boolean(appServer && appServer.exitCode===null),
        wsUrl:mock ? null : `ws://127.0.0.1:${appPort}`,
        cwd:process.cwd(),
        version:"0.2.0",
      });
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
        loginPromise=runLogin([],{port:DEFAULT_PORT,env})
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

  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(port,"127.0.0.1",resolve);
  });

  return {
    url:`http://127.0.0.1:${port}`,
    server,
    close:async()=>{
      try{appServer?.kill("SIGTERM");}catch{}
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
