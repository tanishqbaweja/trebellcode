import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { WebSocket } from "ws";
import { AgentRuntimeManager } from "../../../src/agent-runtime-manager.mjs";
import { attachAgentRelay } from "../../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../../src/agent-thread-store.mjs";

// The relay with the real runtime manager on the stand-in Muse Code (fake-muse.cjs) behind a launcher laid out as Meta's installers
// lay theirs out, as tests/muse-runtime.test.mjs runs it, and a window on its socket that answers the approvals and questions the
// relay asks of it: answer(request) gives the answer, or undefined to hold the request until the test answers it with respond().
const FAKE_MUSE=fileURLToPath(new URL("./fake-muse.cjs",import.meta.url));
const MODEL_LIST=fileURLToPath(new URL("./model-list-1.4.13.json",import.meta.url));
const windows=process.platform==="win32";

async function fakeMuseInstall(root){
  const folder=windows?join(root,"AppData","Local","Programs","muse"):join(root,"home",".local","bin");await mkdir(folder,{recursive:true});
  const launcher=join(folder,windows?"muse.cmd":"muse");
  await writeFile(launcher,windows?`@echo off\r\nsetlocal\r\n"${process.execPath}" "${FAKE_MUSE}" %*\r\nexit /b %ERRORLEVEL%\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${FAKE_MUSE}" "$@"\n`);
  if(!windows)await chmod(launcher,0o755);
  return {launcher,env:windows?{LOCALAPPDATA:join(root,"AppData","Local")}:{HOME:join(root,"home")}};
}
// extra: more settings (the person's MCP servers); usage: the usage records the relay keeps of each turn (recordUsage).
function museState(environment={},extra={},usage=[]){
  const settings={agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,binaryPath:null,environment}],...extra},meta=new Map();
  return {settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},recordUsage:entry=>{usage.push(entry);return entry}};
}
// The status checks' CLI runs for the stand-in only: any other CLI answers as not installed, so nothing installed here is started.
function onlyMuse(launcher){
  return (command,args=[],{env,cwd,timeoutMs=6000}={})=>new Promise(resolve=>{
    if(command!==launcher)return resolve({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
    const child=spawn(command,args,{env,cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout+=chunk});child.stderr.on("data",chunk=>{stderr+=chunk});
    const timer=setTimeout(()=>child.kill(),timeoutMs);
    child.once("error",error=>{clearTimeout(timer);resolve({ok:false,code:null,error:error.message,stdout,stderr})});
    child.once("close",code=>{clearTimeout(timer);resolve({ok:code===0,code,error:null,stdout,stderr})});
  });
}
export async function eventually(check,label,ms=15_000){const end=Date.now()+ms;while(!(await check())){if(Date.now()>end)throw new Error("timed out waiting for "+label);await new Promise(done=>setTimeout(done,25))}}
const entries=async log=>(await readFile(log,"utf8").catch(()=>"")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));

// env: more of the server's own environment (the idle sweep's timings); settings: more settings; relayOptions: more of the relay's
// options (a context engine, which gives each thread Trebell's repository tools).
export async function museRelay(prefix,{environment={},answer=()=>undefined,env:serverEnv={},settings={},relayOptions={}}={}){
  const root=await mkdtemp(join(tmpdir(),prefix)),log=join(root,"muse.log"),install=await fakeMuseInstall(root),usage=[];
  const env={...process.env,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"codex"),CLAUDE_CONFIG_DIR:join(root,"claude"),MUSE_INSTALL_DIR:"",...install.env,...serverEnv};
  const state=museState({MUSE_FAKE_LOG:log,MUSE_FAKE_MODELS:MODEL_LIST,...environment},settings,usage);
  const manager=new AgentRuntimeManager({state,env,runFn:onlyMuse(install.launcher)}),threadStore=new AgentThreadStore(env);
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager:manager,threadStore,terminals:{},state,version:"1.6.0-test",...relayOptions});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket("ws://127.0.0.1:"+server.address().port+"/api/agent/ws");await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  const notifications=[],requests=[];
  const respond=(request,result)=>ws.send(JSON.stringify({id:request.id,result}));
  ws.on("message",raw=>{
    const message=JSON.parse(String(raw));
    if(message.method&&message.id==null)return void notifications.push(message);
    if(message.method&&typeof message.id==="string"){
      requests.push(message);
      Promise.resolve(answer(message)).then(result=>{if(result!==undefined)respond(message,result)});
    }
  });
  let id=0;
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
  const completed=async(threadId,count)=>eventually(()=>notifications.filter(item=>item.method==="turn/completed"&&item.params.threadId===threadId).length>=count,`turn ${count} to complete`);
  const close=async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})};
  return {
    root,log,launcher:install.launcher,env,state,manager,threadStore,rpc,notifications,requests,respond,completed,close,usage,
    hosts:async()=>(await entries(log)).filter(entry=>entry.start&&entry.start[0]==="serve"&&!entry.start.includes("--no-session-log")),
    frames:async method=>(await entries(log)).filter(entry=>entry.frame?.method===method).map(entry=>entry.frame),
    reply:threadId=>threadStore.get(threadId).turns.at(-1).items.filter(item=>item.type==="agentMessage").map(item=>item.text).join(""),
  };
}
