// Starts the real Trebell GUI server (src/gui-server.mjs, not mock) with the server tap preloaded, an isolated home and an IPC
// channel, and talks to the tap. Every child is hidden; TEMP/TMP, the user folders and every harness home stay under the run directory.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

// The only variables a measured process takes from the shell that runs it: the system's own. A harness the server starts must
// never see this machine's real harness homes, credentials or the shell's own session (CLAUDE_CONFIG_DIR, CLAUDECODE and the like).
const SYSTEM_ENV_KEYS=["PATH","PATHEXT","SystemRoot","SystemDrive","WINDIR","COMSPEC","PROGRAMDATA","ALLUSERSPROFILE","PUBLIC","ProgramFiles","ProgramFiles(x86)",
  "ProgramW6432","CommonProgramFiles","CommonProgramFiles(x86)","CommonProgramW6432","NUMBER_OF_PROCESSORS","PROCESSOR_ARCHITECTURE","PROCESSOR_IDENTIFIER","OS",
  "LANG","LC_ALL","LC_CTYPE","TERM","COLORTERM","SHELL","USER","USERNAME","LOGNAME","SSL_CERT_FILE","SSL_CERT_DIR","NODE_EXTRA_CA_CERTS","NO_COLOR","FORCE_COLOR"];

export function isolatedEnv({home,runDir,extra={}}){
  const temp=join(runDir,"tmp"),codexHome=join(runDir,"codex-home"),userHome=join(runDir,"user-home");
  const appData=join(userHome,"AppData","Roaming"),localAppData=join(userHome,"AppData","Local");
  for(const dir of [temp,codexHome,appData,localAppData])mkdirSync(dir,{recursive:true});
  // A person's git has a name to commit under, so a checkpoint costs what it costs them and never takes the no-identity path.
  const gitConfig=join(userHome,".gitconfig");if(!existsSync(gitConfig))writeFileSync(gitConfig,"[user]\n\tname = Trebell Perf\n\temail = perf@trebell.invalid\n");
  const system=Object.fromEntries(SYSTEM_ENV_KEYS.filter(name=>process.env[name]!=null).map(name=>[name,process.env[name]]));
  const env={...system,HOME:userHome,USERPROFILE:userHome,APPDATA:appData,LOCALAPPDATA:localAppData,
    XDG_CONFIG_HOME:join(userHome,".config"),XDG_DATA_HOME:join(userHome,".local","share"),XDG_STATE_HOME:join(userHome,".local","state"),XDG_CACHE_HOME:join(userHome,".cache"),
    CLAUDE_CONFIG_DIR:join(userHome,".claude"),TREBELL_HOME:home,TEMP:temp,TMP:temp,TMPDIR:temp,CODEX_HOME:codexHome,npm_config_cache:join(runDir,"npm-cache"),HARBOR_TELEMETRY:"0",
    OPENAI_API_KEY:"sk-perf-fake-key-not-a-secret",TREBELL_OPENAI_RESPONSES_WEBSOCKET:"0",NODE_NO_WARNINGS:"1",...extra};
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
