// Starts the real Trebell GUI server (src/gui-server.mjs, not mock) with the server tap preloaded, an isolated home and an IPC
// channel, and talks to the tap. Every child is hidden; TEMP/TMP and the Codex home stay under the run directory.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

export function isolatedEnv({home,runDir,extra={}}){
  const temp=join(runDir,"tmp"),codexHome=join(runDir,"codex-home");mkdirSync(temp,{recursive:true});mkdirSync(codexHome,{recursive:true});
  const env={...process.env,TREBELL_HOME:home,TEMP:temp,TMP:temp,TMPDIR:temp,CODEX_HOME:codexHome,npm_config_cache:join(runDir,"npm-cache"),HARBOR_TELEMETRY:"0",
    OPENAI_API_KEY:"sk-perf-fake-key-not-a-secret",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:"",AGENTROUTER_API_KEY:"",
    TREBELL_OPENAI_RESPONSES_WEBSOCKET:"0",TREBELL_GUI_MOCK:"",TREBELL_E2E_OFFLINE:"",NODE_NO_WARNINGS:"1",...extra};
  return env;
}

export async function startServer({repoRoot,home,runDir,uiDist,port,appPort,extraEnv={},nodeArgs=[]}){
  const tap=pathToFileURL(join(repoRoot,"scripts","perf","lib","server-tap.mjs")).href;
  const env=isolatedEnv({home,runDir,extra:{TREBELL_UI_DIST:uiDist,PERF_TAP_OUT:runDir,...extraEnv}});
  const started=performance.now(),startedAt=Date.now();
  const child=spawn(process.execPath,["--expose-gc",...nodeArgs,"--import",tap,join(repoRoot,"src","gui-server.mjs"),"--port",String(port),"--app-port",String(appPort)],{cwd:repoRoot,env,windowsHide:true,stdio:["ignore","pipe","pipe","ipc"]});
  const logs=[];const keep=chunk=>{logs.push(String(chunk));if(logs.length>400)logs.shift()};
  child.stdout.on("data",keep);child.stderr.on("data",keep);
  const pending=new Map();let nextId=1;
  child.on("message",message=>{if(message?.perfTap==="reply"&&pending.has(message.id)){pending.get(message.id)(message.data);pending.delete(message.id)}});
  const ask=(perfTap,extra={},timeoutMs=120_000)=>new Promise((resolve,reject)=>{const id=nextId++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error("tap timeout: "+perfTap))},timeoutMs);pending.set(id,data=>{clearTimeout(timer);resolve(data)});child.send({perfTap,id,...extra})});
  const url="http://127.0.0.1:"+port;
  let listeningMs=null;
  for(;;){
    if(child.exitCode!==null)throw new Error("server exited during start: "+logs.join("").slice(-2000));
    try{const response=await fetch(url+"/api/health");if(response.ok){listeningMs=performance.now()-started;break}}catch{}
    if(performance.now()-started>60_000)throw new Error("server did not listen within 60 s: "+logs.join("").slice(-2000));
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  return {
    child,pid:child.pid,url,port,appPort,listeningMs,startedAt,logs,
    snapshot:(reset=false)=>ask("snapshot",{reset}),
    script:replies=>ask("script",{replies}),
    profileStart:()=>ask("profile-start"),
    profileStop:file=>ask("profile-stop",{file},300_000),
    gc:()=>ask("gc"),
    heapSnapshot:file=>ask("heap-snapshot",{file},300_000),
    async stop(){
      if(child.exitCode!==null)return;
      const exited=new Promise(resolve=>child.once("exit",resolve));
      // The server's own shutdown stops its Codex app-servers; taskkill /T takes whatever is left of the tree.
      try{await ask("shutdown",{},5000)}catch{}
      const timeout=new Promise(resolve=>setTimeout(resolve,10_000));await Promise.race([exited,timeout]);
      if(child.exitCode===null&&process.platform==="win32"){await new Promise(resolve=>{const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});killer.once("exit",resolve);killer.once("error",resolve)});await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,4000))])}
    },
  };
}
