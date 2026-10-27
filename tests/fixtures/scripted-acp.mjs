// Test helpers around the scripted ACP agent (scripted-acp-agent.mjs): a scenario in a folder of its own, an AcpAgentSession that
// runs it as the harness, and the agent relay with that harness behind it, answered over its WebSocket as the app answers.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { AcpAgentSession } from "../../src/acp-agent-session.mjs";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";

const AGENT=fileURLToPath(new URL("./scripted-acp-agent.mjs",import.meta.url));

// A select config option as ACP agents list them; a value may be [value,name].
export const select=(id,category,currentValue,values)=>({id,name:id,category,type:"select",currentValue,options:values.map(value=>Array.isArray(value)?{value:value[0],name:value[1]}:{value,name:value})});

// Cleanups run newest first, so a harness stops before its folder goes (Windows keeps a running process's folder busy).
const cleanups=new WeakMap();
export function onCleanup(t,step){
  let stack=cleanups.get(t);
  if(!stack){
    stack=[];cleanups.set(t,stack);
    t.after(async()=>{let failure=null;for(const next of stack.reverse()){try{await next()}catch(error){failure??=error}}if(failure)throw failure});
  }
  stack.push(step);
}

export async function scriptedAcp(t,config){
  const root=await mkdtemp(join(tmpdir(),"trebell-scripted-acp-")),scenarioPath=join(root,"scenario.json"),logPath=join(root,"log.jsonl");
  await writeFile(scenarioPath,JSON.stringify(config),"utf8");
  onCleanup(t,()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  return {
    root,args:[AGENT],env:{...process.env,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TREBELL_ACP_SCENARIO:scenarioPath,TREBELL_ACP_LOG:logPath},
    async log(){try{return (await readFile(logPath,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))}catch{return []}},
  };
}
// The agent's answer to its own request.
export const replyTo=(log,method)=>log.find(entry=>entry.reply===method)?.message;

export function acpSession(t,fx,options){
  const updates=[],session=new AcpAgentSession({command:process.execPath,args:fx.args,cwd:fx.root,env:fx.env,onUpdate:params=>updates.push(params.update),...options});
  onCleanup(t,()=>session.close().catch(()=>{}));
  return {session,updates};
}

function scenarioRuntimeManager(kind,fx){
  const instance={id:`${kind}-default`,kind,displayName:kind,enabled:true};
  return {
    instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>kind,compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:kind,available:true,authenticated:true,version:"fixture"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...fx.env}),executable:()=>process.execPath,acpArgs:()=>[...fx.args],
    env:{...process.env,TREBELL_HOME:join(fx.root,"home")},
  };
}
function memoryState(){
  const meta=new Map();
  return {settings:()=>({activeEnvironmentId:null}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
}
// rpc asks the relay as the app does; next waits for the first message from the relay that matches. relayOptions go to the relay as
// they are (its log, its journal).
export async function acpRelay(t,kind,fx,relayOptions={}){
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(fx.root,"home")});
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager:scenarioRuntimeManager(kind,fx),threadStore,terminals:{},state:memoryState(),version:"test",...relayOptions});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket("ws://127.0.0.1:"+server.address().port+"/api/agent/ws");await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  onCleanup(t,async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()))});
  let id=0;
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id;const onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
  const next=(predicate,ms=15_000)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.off("message",onMessage);reject(new Error("timed out waiting for a relay message"))},ms);
    const onMessage=raw=>{const message=JSON.parse(String(raw));if(!predicate(message))return;clearTimeout(timer);ws.off("message",onMessage);resolve(message)};
    ws.on("message",onMessage);
  });
  return {ws,rpc,next,threadStore};
}
