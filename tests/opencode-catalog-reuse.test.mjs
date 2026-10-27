import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runtimeManager from "../src/agent-runtime-manager.mjs";

// Every read of OpenCode's own answer (its providers, models, commands, skills and agents) starts an `opencode serve` and takes
// seconds (2.7 s for 1.18.32, 1.3 s for 2.0.24, measured live). Settings' own listing (its open, Refresh and a sign-in's follow-up)
// reads it again. Any other fresh check keeps a complete answer, and reads one that is not complete again at most every ten seconds: a
// failed turn's recheck (T3 Code does not read OpenCode's catalog again when a turn fails), a switch and the listing right after it, a
// profile's Save or Delete and an install. Only the profile's --version answers here (runFn), and the reads are stood in for.
async function openCodeManager(t){
  const home=await mkdtemp(join(tmpdir(),"trebell-opencode-reuse-"));t.after(()=>rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,binaryPath:join(home,"no-opencode-here"),serverUrl:null,environment:{}};
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[instance]};
  let clock=1_000_000,versions=0;const reads=[];
  const manager=new runtimeManager.AgentRuntimeManager({state:{settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch)},platform:"linux",env:{PATH:"",HOME:home,TREBELL_HOME:join(home,"trebell")},now:()=>clock,
    runFn:async(command,args)=>{if(command===instance.binaryPath&&args[0]==="--version"){versions++;return {ok:true,code:0,error:null,stdout:"1.18.32\n",stderr:""}}return {ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""}}});
  const fake={answer:null};
  manager.openCodeCatalogReader=async options=>{reads.push(options);return structuredClone(fake.answer)};
  return {manager,reads,fake,versions:()=>versions,advance:ms=>{clock+=ms}};
}
const catalog=({connected=["anthropic"],models:ids=["anthropic/claude-x"]}={})=>({
  models:ids,metadata:ids.map(id=>({id,name:id,provider:"opencode",agent:"OpenCode"})),preferred:ids[0]||null,connectedProviders:connected,
  inventory:{commands:[],skills:[],agents:[{name:"build"}]},source:"live-connected",
});

test("a failed turn's recheck of OpenCode asks its version again but keeps a complete catalog, so the failure shows without a new opencode serve",async t=>{
  const {manager,reads,fake,versions,advance}=await openCodeManager(t);
  fake.answer=catalog();
  assert.equal((await manager.probe("opencode")).authenticated,true);assert.equal(reads.length,1);
  advance(10*60_000);
  const before=versions(),status=await manager.recheck("opencode");
  assert.equal(status.authenticated,true);
  assert.equal(reads.length,1,"no catalog read, which would start an opencode serve");
  assert.equal(versions(),before+1,"the version check runs again");
});

test("a switch to OpenCode reads its catalog once for the switch and the listing after it, a profile's Save keeps it, and Settings' listing reads it again",async t=>{
  const {manager,reads,fake,advance}=await openCodeManager(t);
  fake.answer=catalog();
  await manager.setActive({runtime:"opencode"});
  await manager.snapshot();
  assert.equal(reads.length,1,"the switch's read serves the listing right after it");
  advance(10*60_000);
  await manager.setActive({runtime:"opencode"});await manager.snapshot();
  assert.equal(reads.length,1,"a switch and a Save's listing keep a complete catalog");
  await manager.snapshot({refresh:true});
  assert.equal(reads.length,2,"Settings' own listing reads OpenCode again");
});

test("an OpenCode answer that is not complete is read again by those checks at most every ten seconds, and always by Settings' listing",async t=>{
  const {manager,reads,fake,advance}=await openCodeManager(t);
  // A provider connected that lists no models yet: not ready, so not complete.
  fake.answer=catalog({models:[]});
  await manager.setActive({runtime:"opencode"});await manager.snapshot();
  assert.equal(reads.length,1);
  advance(10_001);await manager.snapshot();
  assert.equal(reads.length,2);
  await manager.snapshot({refresh:true});
  assert.equal(reads.length,3);
});
