// A harness set to its API key starts only with its key, and only its own profile is touched when its key or method changes:
// - a status read while it had its key and kept for a minute no longer reads as ready once the key is gone (here or in another window),
//   and the relay and Git text ask again at every start (AgentRuntimeManager.keyRefusal), so the harness never starts on its own login;
// - Grok's Git text signs in with its key method first, as its chats do;
// - a key saved or removed, or a method changed, closes the chats of the profiles on it, never another profile's of the harness;
// - OpenCode on its keys reads no stored sign-in of its own, and a profile at a server URL of its own cannot be set to a key;
// - the OpenCode catalog and an ACP harness's model list kept for a profile are read again after a switch or a new key.
// Fakes only: scripted stand-ins for the harnesses, fixture keys, fresh folders.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { generateTextWithHarness } from "../src/harness-text-generation.mjs";
import { onCleanup, scriptedAcp } from "./fixtures/scripted-acp.mjs";

// What Settings says of an OpenCode profile at a server URL of its own set to a key (harness-auth.mjs OPENCODE_SERVER_KEY_MESSAGE).
const OPENCODE_SERVER_KEY_MESSAGE="OpenCode at a server URL runs on that server's own sign-in: Trebell Code cannot hand it a key. Clear the profile's server URL to run OpenCode on an API key, or set it to Sign in.";

function freshHome(t,prefix){const home=mkdtempSync(join(tmpdir(),prefix));onCleanup(t,()=>rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100}));return home}
function manager(t,{profiles,runFn,now=Date.now}={}){
  const home=freshHome(t,"trebell-key-gate-"),env={PATH:"",HOME:home,USERPROFILE:home,TREBELL_HOME:join(home,"trebell"),CODEX_HOME:join(home,"codex-shared")};
  const providers=new ProviderManager({env});
  let settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:profiles};
  const state={settings:()=>settings,updateSettings:patch=>{settings={...settings,...patch};return settings}};
  const runtimes=new AgentRuntimeManager({state,env,platform:"linux",providers,runFn,now,claudeCapabilitiesCache:{peek:()=>null,get:async()=>null,drop:()=>{}}});
  return {home,env,providers,runtimes,settings:()=>settings};
}
// `claude --version` and `claude auth status` as Claude Code answers them: with ANTHROPIC_API_KEY in its launch it reports the key,
// else the person's own login (a Claude Code signed in with claude auth login as well).
function claudeCli(calls){
  return async(_command,args,{env:childEnv}={})=>{
    calls.push({args,key:childEnv?.ANTHROPIC_API_KEY||null});
    if(args[0]==="--version")return {ok:true,code:0,stdout:"2.1.300 (Claude Code)\n",stderr:""};
    if(args[0]==="auth"&&args[1]==="status")return {ok:true,code:0,stdout:JSON.stringify(childEnv?.ANTHROPIC_API_KEY?{loggedIn:true,authMethod:"api_key",apiKeySource:"ANTHROPIC_API_KEY"}:{loggedIn:true,authMethod:"claude.ai",subscriptionType:"max"}),stderr:""};
    return {ok:false,code:1,stdout:"",stderr:"unexpected"};
  };
}
const CLAUDE_ON_KEY={id:"claude-default",kind:"claude",displayName:"Claude Code",enabled:true,environment:{},auth:"api-key"};

test("a status kept from while a profile had its key is not ready once the key is gone, and a key saved or removed drops what was kept",async t=>{
  const calls=[],{providers,runtimes}=manager(t,{profiles:[CLAUDE_ON_KEY],runFn:claudeCli(calls)});
  providers.setKey("anthropic","sk-ant-fixture-1");
  const first=await runtimes.probe(CLAUDE_ON_KEY);
  assert.equal(first.available,true);assert.equal(first.message,"Runs on the Anthropic API key.");
  // Settings' Model provider card removes the key (here, or in another window): the store has none, nor the environment.
  providers.setKey("anthropic","");
  const kept=await runtimes.probe(CLAUDE_ON_KEY);
  assert.equal(kept.available,false,"the kept answer no longer reads as ready");assert.equal(kept.keyMissing,true);
  assert.match(kept.message,/Claude Code is set to run on the Anthropic API key, and Trebell Code has none\./);
  assert.match(runtimes.keyRefusal(CLAUDE_ON_KEY).message,/and Trebell Code has none/);
  assert.equal(Object.hasOwn(runtimes.childEnv(CLAUDE_ON_KEY),"ANTHROPIC_API_KEY"),false);
  // A key saved again: the kept answer serves, ready, until the route drops it; then the harness is asked again.
  providers.setKey("anthropic","sk-ant-fixture-2");
  const statusCalls=()=>calls.filter(call=>call.args[0]==="auth").length,before=statusCalls();
  assert.equal((await runtimes.probe(CLAUDE_ON_KEY)).available,true);assert.equal(statusCalls(),before,"kept");
  assert.equal(runtimes.keyRefusal(CLAUDE_ON_KEY),null);
  runtimes.forgetProbes(["claude-default"]);
  assert.equal((await runtimes.probe(CLAUDE_ON_KEY)).available,true);
  assert.equal(statusCalls(),before+1,"asked again once its key changed");
  assert.equal(calls.at(-1).key,"sk-ant-fixture-2");
  // Another profile's kept answer stays.
  runtimes.forgetProbes(["claude-other"]);await runtimes.probe(CLAUDE_ON_KEY);assert.equal(statusCalls(),before+1);
});

// The relay with Grok Build profiles whose chats run the scripted ACP agent, each profile with a log of its own. statuses: what each
// profile's kept status says (ready, as one read while it had its key); refusals: what keyRefusal says now.
async function grokRelay(t,{profiles,refusals={}}){
  const fx=await scriptedAcp(t,{initialize:{protocolVersion:1,agentCapabilities:{},authMethods:[{id:"cached_token",name:"Grok login"},{id:"xai.api_key",name:"xAI API key"}]},sessionNew:{sessionId:"grok-session"}});
  const logs=Object.fromEntries(profiles.map(profile=>[profile.id,join(fx.root,profile.id+".jsonl")]));
  const runtimeManager={
    instances:()=>profiles.map(profile=>({...profile})),activeInstance:()=>({...profiles[0]}),activeRuntime:()=>"grok",compatibleInstanceIds:instance=>[instance?.id||profiles[0].id],
    probe:async instance=>({id:instance.id,name:"Grok Build",available:true,authenticated:true,version:"fixture"}),
    keyRefusal:instance=>refusals[instance.id]?{message:refusals[instance.id],keyMissing:true}:null,
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,executable:()=>process.execPath,acpArgs:()=>[...fx.args],
    childEnv:instance=>({...fx.env,TREBELL_ACP_LOG:logs[instance.id],...(instance.auth==="api-key"?{XAI_API_KEY:"xai-fixture-key"}:{})}),
    authMethod:instance=>instance.auth==="api-key"?"api-key":"sign-in",
    env:{...process.env,TREBELL_HOME:join(fx.root,"home")},
  };
  const meta=new Map(),state={settings:()=>({activeEnvironmentId:null}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(fx.root,"home")});
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket("ws://127.0.0.1:"+server.address().port+"/api/agent/ws");await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  onCleanup(t,async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));threadStore.close?.()});
  const seen=[];ws.on("message",raw=>seen.push(JSON.parse(String(raw))));
  let id=0;
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id;const onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId||message.method)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
  const read=async profileId=>{try{return (await readFile(logs[profileId],"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))}catch{return []}};
  const start=runtimeInstanceId=>rpc("thread/start",{cwd:fx.root,runtimeInstanceId,approvalPolicy:"on-request",sandbox:"workspace-write"});
  return {fx,relay,rpc,seen,log:read,start};
}

test("a chat of a profile on its API key whose key went refuses to start, whatever status was kept, and its harness never runs",async t=>{
  const refusal="Grok Build is set to run on the xAI API key, and Trebell Code has none. Add it under Grok Build in Settings → Agents & models, or set Grok Build to Sign in.";
  const {start,log}=await grokRelay(t,{profiles:[{id:"grok-default",kind:"grok",displayName:"Grok Build",enabled:true,auth:"api-key"}],refusals:{"grok-default":refusal}});
  await assert.rejects(start("grok-default"),error=>error.message===refusal);
  assert.deepEqual(await log("grok-default"),[],"Grok never started: no session ran on a login of its own");
});

test("a key saved or removed, or a method changed, closes the chats of the profiles on it, never another profile's of the harness",async t=>{
  const profiles=[{id:"grok-default",kind:"grok",displayName:"Grok Build",enabled:true},{id:"grok-key",kind:"grok",displayName:"Grok on key",enabled:true,auth:"api-key"}];
  const {relay,start,seen,log}=await grokRelay(t,{profiles});
  const signIn=(await start("grok-default")).thread.id,onKey=(await start("grok-key")).thread.id;
  assert.deepEqual((await log("grok-key")).filter(entry=>entry.id!=null).map(entry=>entry.method==="authenticate"?"authenticate "+entry.params.methodId:entry.method).slice(0,3),["initialize","authenticate xai.api_key","session/new"]);
  // The xAI key saved again (the route closes the chats of the profiles on it, by their ids).
  const closedThreads=()=>seen.filter(message=>message.method==="thread/closed").map(message=>message.params.threadId);
  const settle=async count=>{for(const end=Date.now()+5000;closedThreads().length<count&&Date.now()<end;)await new Promise(resolve=>setTimeout(resolve,20));await new Promise(resolve=>setTimeout(resolve,100))};
  assert.equal(await relay.closeRuntimeSessions(null,{instanceIds:["grok-key"]}),1,"only the chat on the key closed");
  await settle(1);
  assert.deepEqual(closedThreads(),[onKey]);assert.equal(closedThreads().includes(signIn),false,"the chat on Sign in stays open");
  assert.ok((await log("grok-key")).some(entry=>entry.method==="session/close"));
  assert.equal((await log("grok-default")).some(entry=>entry.method==="session/close"),false);
  // A method changed on the profile on Sign in closes its chat alone; no ids close nothing.
  assert.equal(await relay.closeRuntimeSessions("grok",{everywhere:true,instanceIds:[]}),0);
  assert.equal(await relay.closeRuntimeSessions("grok",{everywhere:true,instanceIds:["grok-default"]}),1);
  await settle(2);
  assert.deepEqual(closedThreads(),[onKey,signIn]);
});

// Git text through a runtime manager that stands in for the server's: its status says ready (kept from before), and keyRefusal what
// it says now.
function gitTextManager(fx,instance,{refusal=null,env}){
  return {
    definitions:()=>[{id:"grok",name:"Grok Build",protocol:"acp"}],activeInstance:()=>instance,
    probe:async()=>({id:instance.id,kind:"grok",name:"Grok Build",available:true,authenticated:true,version:"fixture",authMethod:instance.auth||"sign-in"}),
    recheck:async()=>null,keyRefusal:()=>refusal?{message:refusal,keyMissing:true}:null,
    executable:()=>process.execPath,acpArgs:()=>[...fx.args],childEnv:()=>({...env}),authMethod:()=>instance.auth==="api-key"?"api-key":"sign-in",
    processSpawner:()=>null,remoteIo:()=>null,runtimeCwd:cwd=>cwd,
  };
}
const GROK_TEXT={initialize:{protocolVersion:1,agentCapabilities:{},authMethods:[{id:"cached_token",name:"Grok login"},{id:"xai.api_key",name:"xAI API key"}]},sessionNew:{sessionId:"grok-session"},
  prompts:[{steps:[{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Fix the key check"}}}]}]};
const asked=entries=>entries.filter(entry=>entry.method&&entry.id!=null).map(entry=>entry.method==="authenticate"?`authenticate ${entry.params.methodId}`:entry.method);

test("Git text of Grok on its API key signs in with its key method before its session, as its chats do, and on Sign in it does not",async t=>{
  const onKey=await scriptedAcp(t,GROK_TEXT),instance={id:"grok-default",kind:"grok",displayName:"Grok Build",enabled:true,auth:"api-key"};
  const result=await generateTextWithHarness({runtimeManager:gitTextManager(onKey,instance,{env:{...onKey.env,XAI_API_KEY:"xai-fixture-key"}}),instance,prompt:"Write a commit message for: fix",cwd:onKey.root,version:"0.0.0",timeoutMs:30_000});
  assert.equal(result.text,"Fix the key check");
  assert.deepEqual(asked(await onKey.log()).slice(0,3),["initialize","authenticate xai.api_key","session/new"]);
  const signIn=await scriptedAcp(t,GROK_TEXT),own={...instance,auth:undefined};
  await generateTextWithHarness({runtimeManager:gitTextManager(signIn,own,{env:{...signIn.env}}),instance:own,prompt:"Write a commit message for: fix",cwd:signIn.root,version:"0.0.0",timeoutMs:30_000});
  assert.equal(asked(await signIn.log()).some(method=>method.startsWith("authenticate")),false,"its own login, no key method");
});

test("Git text of a profile on its API key whose key went is refused before its harness starts, whatever status was kept",async t=>{
  const fx=await scriptedAcp(t,GROK_TEXT),instance={id:"grok-default",kind:"grok",displayName:"Grok Build",enabled:true,auth:"api-key"};
  const refusal="Grok Build is set to run on the xAI API key, and Trebell Code has none.";
  await assert.rejects(generateTextWithHarness({runtimeManager:gitTextManager(fx,instance,{refusal,env:{...fx.env}}),instance,prompt:"Write a commit message for: fix",cwd:fx.root,version:"0.0.0",timeoutMs:30_000}),
    error=>error.code==="HARNESS_UNAVAILABLE"&&error.message===refusal);
  assert.deepEqual(await fx.log(),[],"Grok never started");
});

test("OpenCode on its API keys reads no stored sign-in of its own, and a profile at a server URL of its own cannot be set to a key",t=>{
  const opencode={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,environment:{}};
  const external={id:"opencode-server",kind:"opencode",displayName:"OpenCode server",enabled:true,environment:{},serverUrl:"http://127.0.0.1:4096"};
  const {providers,runtimes,settings}=manager(t,{profiles:[opencode,external]});
  providers.setKey("anthropic","sk-ant-fixture");
  const onKey=runtimes.childEnv({...opencode,auth:"api-key"});
  assert.equal(onKey.ANTHROPIC_API_KEY,"sk-ant-fixture");assert.equal(onKey.OPENCODE_AUTH_CONTENT,"{}","its own logins read as none");
  assert.equal(Object.hasOwn(runtimes.childEnv(opencode),"OPENCODE_AUTH_CONTENT"),false,"on Sign in its own logins serve");
  assert.equal(Object.hasOwn(runtimes.childEnv({...opencode,auth:"api-key"},{key:false}),"OPENCODE_AUTH_CONTENT"),false,"an install takes nothing of it");
  assert.throws(()=>runtimes.setAuthMethod("opencode-server","api-key"),error=>error.message===OPENCODE_SERVER_KEY_MESSAGE);
  assert.throws(()=>runtimes.upsertInstance({...external,auth:"api-key"}),error=>error.message===OPENCODE_SERVER_KEY_MESSAGE);
  assert.throws(()=>runtimes.upsertInstance({...opencode,auth:"api-key",serverUrl:"http://127.0.0.1:4096"}),error=>error.message===OPENCODE_SERVER_KEY_MESSAGE);
  assert.equal(settings().agentRuntimeInstances.some(item=>item.auth==="api-key"),false,"nothing saved");
  // One saved that way before is refused where it would start.
  assert.deepEqual(runtimes.keyRefusal({...external,auth:"api-key"}),{message:OPENCODE_SERVER_KEY_MESSAGE,keyMissing:false});
  assert.equal(runtimes.setAuthMethod("opencode-default","api-key").instance.auth,"api-key");
});

test("OpenCode's catalog kept for a profile is read again after a switch to its keys, with them and no stored sign-in",async t=>{
  const opencode={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,environment:{},serverUrl:null};
  const home=freshHome(t,"trebell-key-gate-oc-");opencode.binaryPath=join(home,"no-opencode-here");
  const {providers,runtimes}=manager(t,{profiles:[opencode],runFn:async(command,args)=>command===opencode.binaryPath&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:"1.18.32\n",stderr:""}:{ok:false,code:null,error:"spawn ENOENT",stdout:"",stderr:""}});
  const reads=[];
  runtimes.openCodeCatalogReader=async options=>{reads.push(options);const connected=options.env?.ANTHROPIC_API_KEY?["anthropic"]:["openai"];
    return {models:connected.map(id=>`${id}/model`),metadata:connected.map(id=>({id:`${id}/model`,name:id,provider:"opencode",agent:"OpenCode"})),preferred:`${connected[0]}/model`,connectedProviders:connected,inventory:{commands:[],skills:[],agents:[{name:"build"}]},source:"live-connected"}};
  assert.deepEqual((await runtimes.models(opencode)).models,["openai/model"],"its own login's provider");
  providers.setKey("anthropic","sk-ant-fixture");
  const {instance:onKey}=runtimes.setAuthMethod("opencode-default","api-key");
  assert.deepEqual((await runtimes.models(onKey)).models,["anthropic/model"],"the key's provider, not the list read on Sign in");
  assert.equal(reads.length,2);assert.equal(reads[1].env.ANTHROPIC_API_KEY,"sk-ant-fixture");assert.equal(reads[1].env.OPENCODE_AUTH_CONTENT,"{}");
  // Another key saved: read again with it.
  providers.setKey("anthropic","sk-ant-fixture-2");
  await runtimes.models(onKey);
  assert.equal(reads.length,3);assert.equal(reads[2].env.ANTHROPIC_API_KEY,"sk-ant-fixture-2");
});

test("Grok's model list kept for a profile on its key is read again once another key is saved",async t=>{
  const fx=await scriptedAcp(t,{initialize:{protocolVersion:1,agentCapabilities:{},authMethods:[{id:"xai.api_key",name:"xAI API key"}],_meta:{modelState:{currentModelId:"grok-fixture",availableModels:[{modelId:"grok-fixture",name:"Grok fixture"}]}}}});
  const wrapper=join(fx.root,process.platform==="win32"?"grok.cmd":"grok");
  writeFileSync(wrapper,process.platform==="win32"?`@"${process.execPath}" "${fx.args[0]}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${fx.args[0]}" "$@"\n`,{mode:0o755});
  const grok={id:"grok-default",kind:"grok",displayName:"Grok Build",enabled:true,auth:"api-key",binaryPath:wrapper,environment:{TREBELL_ACP_SCENARIO:fx.env.TREBELL_ACP_SCENARIO,TREBELL_ACP_LOG:fx.env.TREBELL_ACP_LOG}};
  const {providers,runtimes}=manager(t,{profiles:[grok],runFn:async(_command,args)=>args[0]==="--version"?{ok:true,code:0,error:null,stdout:"grok 0.1.0-fixture\n",stderr:""}:{ok:false,code:1,error:null,stdout:"",stderr:"unexpected"}});
  runtimes.platform=process.platform;
  providers.setKey("xai","xai-fixture-1");
  const initializes=async()=>(await fx.log()).filter(entry=>entry.method==="initialize").length;
  assert.deepEqual((await runtimes.models(grok)).models,["grok-fixture"]);
  await runtimes.models(grok);
  assert.equal(await initializes(),1,"kept while the key is the same");
  providers.setKey("xai","xai-fixture-2");
  assert.deepEqual((await runtimes.models(grok)).models,["grok-fixture"]);
  assert.equal(await initializes(),2,"read again on the key saved now");
});
