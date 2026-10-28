import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";

// Each read of OpenCode's own answer (its providers, models, commands, skills and agents) starts an `opencode serve` and takes seconds,
// so a status check keeps the last one. A complete one was kept with no age limit by every check but Settings' Refresh, and by the
// profile and OpenCode version alone: a Save whose environment changed (a provider key now passed on, an OPENCODE_CONFIG pointing
// elsewhere) kept showing what the old environment gave, and a switch reused a read from hours before. Now the answer is kept per
// environment too, and a switch, the listing a Save or Delete or an install answers with and Settings' sections read a complete one again
// once it is ten seconds old (the minimum interval between such reads); a failed turn's recheck keeps it, as T3 Code does not read
// OpenCode's catalog again when a turn fails. Only the profile's --version answers here (runFn), and the reads are stood in for.
async function openCodeManager(t){
  const home=await mkdtemp(join(tmpdir(),"trebell-opencode-profile-save-"));t.after(()=>rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,binaryPath:join(home,"no-opencode-here"),serverUrl:null,environment:{}};
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[instance]};
  let clock=1_000_000;const reads=[];
  const manager=new AgentRuntimeManager({state:{settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch)},platform:"linux",env:{PATH:"",HOME:home,TREBELL_HOME:join(home,"trebell")},now:()=>clock,
    runFn:async(command,args)=>command===instance.binaryPath&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:"1.18.32\n",stderr:""}:{ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""}});
  const fake={answer:null};
  manager.openCodeCatalogReader=async options=>{reads.push(options);return structuredClone(typeof fake.answer==="function"?fake.answer(options):fake.answer)};
  return {manager,instance,reads,fake,advance:ms=>{clock+=ms}};
}
const catalog=(connected=["anthropic"])=>({
  models:connected.map(id=>`${id}/model`),metadata:connected.map(id=>({id:`${id}/model`,name:id,provider:"opencode",agent:"OpenCode"})),preferred:`${connected[0]}/model`,connectedProviders:connected,
  inventory:{commands:[],skills:[],agents:[{name:"build"}]},source:"live-connected",
});
const opencode=listing=>listing.statuses.find(status=>status.id==="opencode-default");

test("a Save of an OpenCode profile whose environment changed reads OpenCode again with that environment, and Settings shows what it gives",async t=>{
  const {manager,instance,reads,fake}=await openCodeManager(t);
  // The OpenCode config the environment points at connects a second provider.
  fake.answer=options=>catalog(options.env?.OPENCODE_CONFIG==="/work/opencode.json"?["anthropic","openai"]:["anthropic"]);
  assert.equal(opencode(await manager.snapshot()).account.connectedProviders,1);
  assert.equal(reads.length,1);
  manager.upsertInstance({...instance,environment:{OPENCODE_CONFIG:"/work/opencode.json"},approvedEnvironmentKeys:["OPENCODE_CONFIG"]});
  const listed=opencode(await manager.snapshot());
  assert.equal(reads.length,2,"the Save's listing reads OpenCode again");
  assert.equal(reads[1].env.OPENCODE_CONFIG,"/work/opencode.json");
  assert.equal(listed.account.connectedProviders,2,"Settings shows what the new environment gives");
});

test("a switch to OpenCode and the listings after a Save read a complete answer again once it is ten seconds old, and a failed turn's recheck keeps it",async t=>{
  const {manager,reads,fake,advance}=await openCodeManager(t);
  fake.answer=catalog();
  await manager.setActive({runtime:"opencode"});await manager.snapshot();
  assert.equal(reads.length,1,"the switch's read serves the listing right after it");
  advance(5_000);await manager.snapshot();
  assert.equal(reads.length,1,"a listing within ten seconds keeps it");
  advance(5_001);await manager.setActive({runtime:"opencode"});
  assert.equal(reads.length,2,"a switch reads a complete answer ten seconds old again");
  advance(60*60_000);await manager.recheck("opencode");
  assert.equal(reads.length,2,"a failed turn's recheck keeps it");
  await manager.snapshot();
  assert.equal(reads.length,3,"a listing reads an hour-old answer again");
});
