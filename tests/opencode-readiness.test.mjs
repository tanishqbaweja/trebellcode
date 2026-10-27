import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runtimeManager from "../src/agent-runtime-manager.mjs";

// The status check and model list of a local OpenCode profile, with OpenCode's own answer read through openCodeCatalogReader (each read
// starts an `opencode serve`) and its --version answered by runFn; only the profile's own binary answers, so nothing else runs.
async function openCodeManager(t,{version="1.18.32",serverUrl=null}={}){
  const home=await mkdtemp(join(tmpdir(),"trebell-opencode-readiness-"));t.after(()=>rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,binaryPath:join(home,"no-opencode-here"),serverUrl,environment:{}};
  const settings={agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",agentRuntimeInstances:[instance]};
  let clock=1_000_000;const reads=[];
  const manager=new runtimeManager.AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"",HOME:home,TREBELL_HOME:join(home,"trebell")},now:()=>clock,
    runFn:async(command,args)=>command===instance.binaryPath&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:version+"\n",stderr:""}:{ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""}});
  const fake={answer:null};
  manager.openCodeCatalogReader=async options=>{reads.push(options);if(fake.answer instanceof Error)throw fake.answer;return structuredClone(fake.answer)};
  return {manager,instance,reads,fake,advance:ms=>{clock+=ms}};
}
const catalog=({connected=["anthropic"],models:ids=["anthropic/claude-x"],pending=null}={})=>({
  models:ids,metadata:ids.map(id=>({id,name:id,provider:"opencode",agent:"OpenCode"})),preferred:ids[0]||null,connectedProviders:connected,
  inventory:{commands:[{name:"init"}],skills:[],agents:[{name:"build"}]},...(pending?{pending}:{}),source:"live-connected",
});

test("OpenCode with a connected provider that lists no models is not ready and says so, and its answer is read again at once by a fresh check and after five minutes by the window's",async t=>{
  const {manager,reads,fake,advance}=await openCodeManager(t);
  fake.answer=catalog({models:[]});
  const first=await manager.probe("opencode");
  assert.deepEqual([first.available,first.authenticated,first.account,first.message],[true,null,{connectedProviders:1},"1 upstream provider is connected through OpenCode, but it lists no models yet. Press Refresh to check again."]);
  assert.equal(reads.length,1);
  // The window's checks reuse it for a while; each read starts an `opencode serve`.
  await manager.probe("opencode");advance(60_000);await manager.probe("opencode");
  assert.equal(reads.length,1);
  // A model list reads it again once it is ten seconds old, as it reads every answer.
  await manager.models("opencode");assert.equal(reads.length,2);
  advance(5*60_000+1);await manager.probe("opencode");assert.equal(reads.length,3);
  await manager.probe("opencode",{fresh:true});assert.equal(reads.length,4);
  // OpenCode lists the provider's models now: Settings' Refresh (a fresh check, as its listing makes) shows it ready.
  fake.answer=catalog();
  const ready=await manager.probe("opencode",{fresh:true});
  assert.deepEqual([ready.available,ready.authenticated,ready.message],[true,true,"1 upstream provider connected through OpenCode."]);
  assert.equal(reads.length,5);
});

test("a provider connected after OpenCode's last read shows on Settings' Refresh, while the window's checks keep reusing a ready answer",async t=>{
  const {manager,reads,fake,advance}=await openCodeManager(t);
  fake.answer=catalog({connected:[],models:["anthropic/claude-x","openai/gpt"]});
  // Settings' listing checks with fresh (snapshot).
  const before=await manager.probe("opencode",{fresh:true});
  assert.deepEqual([before.authenticated,before.message],[null,"OpenCode is available, but it did not report any connected upstream providers."]);
  // The person signs in to a provider with OpenCode's own `opencode auth login`, then presses Refresh.
  fake.answer=catalog();
  const after=await manager.probe("opencode",{fresh:true});
  assert.deepEqual([after.authenticated,after.message],[true,"1 upstream provider connected through OpenCode."]);
  assert.equal(reads.length,2);
  advance(10*60_000);await manager.probe("opencode");await manager.probe("opencode");
  assert.equal(reads.length,2,"a ready answer is not read again by the window's checks");
  await manager.probe("opencode",{fresh:true});assert.equal(reads.length,3);
});

test("an OpenCode answer with a list that timed out, or an OpenCode 2 model list still changing, is not kept: the window's checks read it again",async t=>{
  for(const [version,pending] of [["1.18.32",["commands"]],["2.0.24",["models"]]]){
    const {manager,reads,fake,advance}=await openCodeManager(t,{version});
    fake.answer=catalog({pending});
    // It is ready (providers with models), and the model list a moment later is the same read.
    const status=await manager.probe("opencode");assert.equal(status.authenticated,true);
    const listed=await manager.models("opencode");assert.deepEqual(listed.models,["anthropic/claude-x"]);
    assert.deepEqual([reads.length,reads[0].version],[1,version]);
    advance(6*60_000);await manager.probe("opencode");
    assert.equal(reads.length,2,`${version}: a pending answer is read again`);
    fake.answer=catalog();
    await manager.probe("opencode",{fresh:true});advance(6*60_000);await manager.probe("opencode");await manager.probe("opencode");
    assert.equal(reads.length,3,`${version}: a complete answer is kept`);
    // A model list shows what the read listed so far.
    assert.deepEqual((await manager.models("opencode")).inventory.commands,[{name:"init"}]);
  }
});

test("a profile's own OpenCode server that refuses the password is not signed in, and an error that only names a port such as 4010 is not a refusal",async t=>{
  const {manager,fake}=await openCodeManager(t,{version:"2.0.24",serverUrl:"http://127.0.0.1:4010"});
  fake.answer=new Error("Unauthorized");
  const refused=await manager.probe("opencode");
  assert.deepEqual([refused.available,refused.authenticated,refused.message],[false,false,"The configured OpenCode server rejected the password. Check this profile's server URL and the OPENCODE_SERVER_PASSWORD in its environment."]);
  fake.answer=new Error("connect ECONNREFUSED http://127.0.0.1:4010");
  const unreachable=await manager.probe("opencode");
  assert.deepEqual([unreachable.available,unreachable.authenticated,unreachable.message],[false,null,"OpenCode could not list its providers: connect ECONNREFUSED http://127.0.0.1:4010"]);
  for(const text of ["Unauthorized","Forbidden","UnexpectedStatus: 403","HTTP 401","HTTP/1.1 403 Forbidden","provider list failed with status code: 401"])assert.equal(runtimeManager.openCodeServerRefused(new Error(text)),true,text);
  for(const text of ["fetch failed http://127.0.0.1:4010","port 4010 is in use","401","GET /api/info/4031 failed"])assert.equal(runtimeManager.openCodeServerRefused(new Error(text)),false,text);
});
