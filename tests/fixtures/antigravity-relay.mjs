// The agent relay with Antigravity as its harness and a stand-in for Antigravity's ACP server (antigravity-acp-agent.mjs) as each
// chat's process, as Trebell's server runs them: the Gemini API key saved here (setKey, as Settings saves one or removes it) goes into
// each chat Antigravity starts on this machine, and a chat in the environment named remote runs the stand-in as a WSL or SSH launch
// does, with that environment's own key (remoteKey) and none of the one saved here. rechecks counts the relay's checks of whether
// Antigravity still runs where it failed. Answers the relay, a connection to it as a Trebell window has one, and the stand-in's
// scenario and log, which names each key it ran on by keyNames (never the key itself) and its process id.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";

const AGENT=fileURLToPath(new URL("./antigravity-acp-agent.mjs",import.meta.url));

export async function antigravityRelay(t,{key=null,remoteKey=null,keyNames={},scenario={}}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-relay-")),env={...process.env,TREBELL_HOME:join(root,"trebell"),TEMP:join(root,"tmp"),TMP:join(root,"tmp")};
  const scenarioPath=join(root,"scenario.json"),logPath=join(root,"agent.jsonl"),project=join(root,"project"),remote="wsl-fixture";
  await mkdir(env.TEMP,{recursive:true});await mkdir(project,{recursive:true});
  const setScenario=value=>writeFile(scenarioPath,JSON.stringify({keyNames,...value}));await setScenario(scenario);
  const agentEnv={...env,TREBELL_AGY_SCENARIO:scenarioPath,TREBELL_AGY_LOG:logPath},saved={key},rechecks=[];
  delete agentEnv.GEMINI_API_KEY;delete agentEnv.GOOGLE_API_KEY;
  // The remote environment's launch, as the relay's runtime manager makes one: the environment's own variables, never the process
  // env Trebell builds here.
  const remoteSpawn=({command,args,stdio})=>spawn(command,args||[],{cwd:project,env:{...agentEnv,...(remoteKey?{GEMINI_API_KEY:remoteKey}:{})},stdio,windowsHide:true});
  const instance={id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true};
  const runtimeManager={
    instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>"antigravity",compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:"Antigravity",available:true,authenticated:null,version:"1.4.3-fixture"}),
    recheck:async()=>{rechecks.push(Date.now());return {id:instance.id,name:"Antigravity",available:true,authenticated:null,version:"1.4.3-fixture"}},
    runtimeCwd:cwd=>cwd,
    processSpawner:(_instance,environmentId)=>environmentId===remote?remoteSpawn:null,
    remoteIo:(cwd,environmentId)=>environmentId===remote?{root:String(cwd||project),readText:async()=>"",writeText:async()=>{},spawn:()=>{throw new Error("no remote terminals here")}}:null,
    childEnv:()=>({...agentEnv,...(saved.key?{GEMINI_API_KEY:saved.key}:{})}),
    executable:()=>process.execPath,acpArgs:()=>[AGENT],env,
  };
  const meta=new Map(),state={settings:()=>({activeEnvironmentId:null}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const threadStore=new AgentThreadStore(env),server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket("ws://127.0.0.1:"+server.address().port+"/api/agent/ws");
  t.after(async()=>{try{ws.terminate()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  let id=0;const seen=[];ws.on("message",raw=>seen.push(JSON.parse(String(raw))));
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id;const check=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId||message.method)return;ws.off("message",check);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",check);ws.send(JSON.stringify({id:requestId,method,params}));
  });
  const log=async()=>{try{return (await readFile(logPath,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))}catch{return []}};
  const prompts=async()=>(await log()).filter(entry=>entry.method==="session/prompt");
  // A chat, here or in the remote environment, and one turn of it as Antigravity answers it: how it ended, and its prompt as the
  // stand-in logged it (which key, which process).
  const thread=async({inRemote=false}={})=>(await rpc("thread/start",{cwd:project,approvalPolicy:"on-request",sandbox:"workspace-write",...(inRemote?{environmentId:remote}:{})})).thread.id;
  async function turn(threadId,text){
    const from=seen.length,before=(await prompts()).length;
    await rpc("turn/start",{threadId,input:[{type:"text",text}]});
    await until(()=>seen.slice(from).some(message=>message.method==="turn/completed"&&message.params?.threadId===threadId),"the turn ended");
    const completed=seen.slice(from).find(message=>message.method==="turn/completed"&&message.params?.threadId===threadId);
    return {status:completed.params.turn?.status,prompt:(await prompts())[before]||null};
  }
  return {root,relay,rpc,seen,log,scenario:setScenario,thread,turn,rechecks,setKey:value=>{saved.key=value}};
}

// Waits, by real time, until condition() holds.
export async function until(condition,what,timeoutMs=30_000){
  for(const deadline=Date.now()+timeoutMs;!await condition();){if(Date.now()>deadline)throw new Error("Timed out waiting until "+what);await new Promise(resolve=>setTimeout(resolve,25))}
}
