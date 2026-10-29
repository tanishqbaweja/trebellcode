// A removed runtime profile's open chats stop: each chat's harness process keeps the sign-in or key it started with, so one left
// running after "Remove profile" would go on with the key of a profile no one has, also after that key is removed (a key route
// closes only the chats of the profiles still listed). The next message of such a chat starts the harness's default profile. Here
// the GUI server runs outside mock mode with Grok Build profiles whose harness is the scripted ACP agent, on the xAI key. Fakes only:
// the scripted agent, a fixture key, fresh folders.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const AGENT=fileURLToPath(new URL("./fixtures/scripted-acp-agent.mjs",import.meta.url));
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function until(check,what,timeoutMs=20_000){for(const end=Date.now()+timeoutMs;!await check();){if(Date.now()>end)throw new Error("timed out waiting until "+what);await new Promise(resolve=>setTimeout(resolve,50))}}

test("removing a profile stops its open chats, which kept its key, and another profile's chat goes on",{timeout:120_000},async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-profile-removal-")),sockets=new Set();let gui=null;
  t.after(async()=>{for(const ws of sockets)try{ws.terminate()}catch{}await gui?.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})});
  const person=join(root,"person"),project=join(root,"project");
  for(const folder of [person,project,join(root,"tmp"),join(person,"AppData","Roaming"),join(person,"AppData","Local")])await mkdir(folder,{recursive:true});
  const windows=process.platform==="win32",wrapper=join(root,windows?"grok.cmd":"grok"),noCodex=join(root,windows?"no-codex.cmd":"no-codex");
  await writeFile(wrapper,windows?`@"${process.execPath}" "${AGENT}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`,{mode:0o755});
  await writeFile(noCodex,windows?"@exit /b 1\r\n":"#!/bin/sh\nexit 1\n",{mode:0o755});
  const scenario=join(root,"scenario.json");
  await writeFile(scenario,JSON.stringify({initialize:{protocolVersion:1,agentCapabilities:{},authMethods:[{id:"xai.api_key",name:"xAI API key"}]},sessionNew:{sessionId:"grok-session"},
    prompts:[{steps:[{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"fixture reply"}}}]},{steps:[{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"fixture reply"}}}]}]}));
  const profile=(id,log)=>({id,kind:"grok",displayName:id,enabled:true,binaryPath:wrapper,auth:"api-key",environment:{TREBELL_ACP_SCENARIO:scenario,TREBELL_ACP_LOG:join(root,log)}});
  const system=windows?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,COMSPEC:process.env.COMSPEC,PATHEXT:process.env.PATHEXT,PATH:[dirname(process.execPath),join(process.env.SystemRoot||"C:\\Windows","System32")].join(";")}:{PATH:[dirname(process.execPath),"/usr/bin","/bin"].join(":")};
  const env={...system,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TMPDIR:join(root,"tmp"),USERPROFILE:person,HOME:person,APPDATA:join(person,"AppData","Roaming"),LOCALAPPDATA:join(person,"AppData","Local"),
    TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"codex"),TREBELL_CODEX_BIN:noCodex,TREBELL_HISTORY_DISABLE_CLAUDE:"1"};
  const state=new TrebellStateStore(env);
  // Grok Build is the harness in use, on its other profile; the one removed is not the active one.
  state.updateSettings({onboardingComplete:true,agentRuntime:"grok",agentRuntimeInstanceId:"grok-other",agentRuntimeInstances:[profile("grok-work","work.jsonl"),profile("grok-other","other.jsonl")]});
  state.close();
  new ProviderManager({env}).setKey("xai","xai-fixture-key-removal");
  gui=await createGuiServer({port:await freePort(),mock:false,env});
  const log=async name=>{try{return (await readFile(join(root,name),"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))}catch{return []}};
  const ws=new WebSocket(gui.url.replace(/^http/,"ws")+"/api/agent/ws");sockets.add(ws);
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  const seen=[];ws.on("message",raw=>{try{seen.push(JSON.parse(String(raw)))}catch{}});
  let id=0;
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId||message.method)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
  const chat=async runtimeInstanceId=>{
    const threadId=(await rpc("thread/start",{cwd:project,runtimeInstanceId,approvalPolicy:"on-request",sandbox:"workspace-write"})).thread.id;
    await rpc("turn/start",{threadId,input:[{type:"text",text:"hello"}]});
    await until(()=>seen.some(message=>message.method==="turn/completed"&&message.params?.threadId===threadId),"the turn completed");
    return threadId;
  };
  const work=await chat("grok-work"),other=await chat("grok-other");
  assert.ok((await log("work.jsonl")).some(entry=>entry.method==="session/prompt"),"the chat ran on the profile");
  const removed=await fetch(gui.url+"/api/agent-runtimes?id=grok-work",{method:"DELETE"});
  const body=await removed.json();
  assert.equal(removed.status,200,JSON.stringify(body));assert.equal(body.ok,true);
  assert.equal(body.stoppedChats,1,"the removed profile's chat stopped");
  await until(async()=>(await log("work.jsonl")).some(entry=>entry.method==="session/close")||seen.some(message=>message.method==="thread/closed"&&message.params?.threadId===work),"the removed profile's chat closed");
  assert.ok(seen.some(message=>message.method==="thread/closed"&&message.params?.threadId===work),"its window is told the chat closed");
  assert.equal(seen.some(message=>message.method==="thread/closed"&&message.params?.threadId===other),false,"another profile's chat goes on");
  assert.equal((await log("other.jsonl")).some(entry=>entry.method==="session/close"),false);
});
