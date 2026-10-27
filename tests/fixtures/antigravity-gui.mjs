// The GUI server outside mock mode with the stand-in for Antigravity's ACP server (antigravity-acp-agent.mjs) as the Antigravity
// profile's executable, Antigravity the harness in use, and every other harness missing from the machine as the server sees it: a
// person's home, PATH, temp folder and Trebell home of the test's own. Answers Settings' sign-in route (post), a connection to the
// agent relay the app's chats go through (connect), and the stand-in's scenario and log.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createGuiServer } from "../../src/gui-server.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";

const AGENT=fileURLToPath(new URL("./antigravity-acp-agent.mjs",import.meta.url));
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

export async function antigravityGui(t,scenario={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-gui-")),person=join(root,"person"),trebellHome=join(root,"trebell"),project=join(root,"project"),scenarioPath=join(root,"scenario.json"),logPath=join(root,"log.jsonl");
  // The server and the relay connections close before the folders go (Windows keeps a running process's folder busy).
  const sockets=new Set();let gui=null;
  t.after(async()=>{for(const ws of sockets)try{ws.terminate()}catch{}await gui?.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})});
  for(const folder of [person,project,join(root,"tmp")])await mkdir(folder,{recursive:true});
  const windows=process.platform==="win32",wrapper=join(root,windows?"agy.cmd":"agy"),noCodex=join(root,windows?"no-codex.cmd":"no-codex");
  await writeFile(wrapper,windows?`@"${process.execPath}" "${AGENT}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`,{mode:0o755});
  await writeFile(noCodex,windows?"@exit /b 1\r\n":"#!/bin/sh\nexit 1\n",{mode:0o755});
  const system=windows?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,COMSPEC:process.env.COMSPEC,PATHEXT:process.env.PATHEXT,PATH:[dirname(process.execPath),join(process.env.SystemRoot||"C:\\Windows","System32")].join(";")}:{PATH:[dirname(process.execPath),"/usr/bin","/bin"].join(":")};
  const env={...system,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TMPDIR:join(root,"tmp"),USERPROFILE:person,HOME:person,APPDATA:join(person,"AppData","Roaming"),LOCALAPPDATA:join(person,"AppData","Local"),
    TREBELL_HOME:trebellHome,CODEX_HOME:join(root,"codex"),TREBELL_CODEX_BIN:noCodex,TREBELL_HISTORY_DISABLE_CLAUDE:"1",TREBELL_AGY_SCENARIO:scenarioPath,TREBELL_AGY_LOG:logPath};
  const state=new TrebellStateStore(env);
  state.updateSettings({onboardingComplete:true,agentRuntime:"antigravity",agentRuntimeInstanceId:"antigravity-default",agentRuntimeInstances:[{id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true,binaryPath:wrapper,environment:{},approvedEnvironmentKeys:["TREBELL_AGY_SCENARIO","TREBELL_AGY_LOG"]}]});
  state.close();
  const setScenario=value=>writeFile(scenarioPath,JSON.stringify(value));await setScenario(scenario);
  gui=await createGuiServer({port:await freePort(),mock:false,env});
  const post=async body=>{const response=await fetch(gui.url+"/api/agent-runtime-auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({runtime:"antigravity",instanceId:"antigravity-default",...body})});const text=await response.text();return {status:response.status,text,body:JSON.parse(text)}};
  const log=async()=>{try{return (await readFile(logPath,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))}catch{return []}};
  // A connection to the agent relay, as a Trebell window has one: requests (rpc) and the notifications it is sent (next).
  async function connect(){
    const ws=new WebSocket(gui.url.replace(/^http/,"ws")+"/api/agent/ws");sockets.add(ws);
    await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
    let id=0;const seen=[];ws.on("message",raw=>{try{seen.push(JSON.parse(String(raw)))}catch{}});
    const rpc=(method,params={})=>new Promise((resolve,reject)=>{
      const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId||message.method)return;ws.off("message",onMessage);message.error?reject(Object.assign(new Error(message.error.message),{code:message.error.code})):resolve(message.result)};
      ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
    });
    // The first notification from now on, or already seen since `from` (an index into seen), that matches.
    const next=(predicate,{from=seen.length,timeoutMs=30_000}={})=>new Promise((resolve,reject)=>{
      const found=seen.slice(from).find(message=>message.method&&predicate(message));if(found)return resolve(found);
      const timer=setTimeout(()=>{ws.off("message",onMessage);reject(new Error("timed out waiting for a relay notification"))},timeoutMs);
      const onMessage=raw=>{const message=JSON.parse(String(raw));if(!message.method||!predicate(message))return;clearTimeout(timer);ws.off("message",onMessage);resolve(message)};
      ws.on("message",onMessage);
    });
    return {ws,rpc,next,seen};
  }
  return {root,project,trebellHome,post,log,scenario:setScenario,connect,gui};
}

// Waits, by real time, until condition() holds.
export async function until(condition,what,timeoutMs=30_000){
  for(const deadline=Date.now()+timeoutMs;!await condition();){if(Date.now()>deadline)throw new Error("Timed out waiting until "+what);await new Promise(resolve=>setTimeout(resolve,50))}
}
