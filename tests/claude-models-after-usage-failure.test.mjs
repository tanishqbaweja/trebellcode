// Claude Code's model list, slash commands and agents come from the same machine-wide probe as its plan usage. A probe whose usage read
// failed or came without data is read again at the Usage card's next Refresh, but its models and commands do not expire with its usage:
// the model list (which the composer waits on) takes that probe for five minutes, as before, and a re-probe that fails does not drop
// what the earlier one listed. T3 Code lists Claude's models from its catalog, so its probe's short reuse costs it no model list.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { CLAUDE_CAPABILITIES_TTL_MS, createClaudeCapabilitiesCache, probeClaudeCapabilities } from "../src/claude-capabilities.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

const SIGNED_IN={email:"person@example.test",subscriptionType:"max",tokenSource:"claude.ai"};
const PLAN={session:{},rate_limits_available:true,rate_limits:{five_hour:{utilization:12,resets_at:"2026-10-27T05:00:00Z"}}};
// Claude Code as the SDK's query() starts it for the capability probe, scripted: answer(index) gives each probe's usage answer, the
// error its usage request fails with, or the error its initialize fails with. Nothing is spawned.
function scriptedClaude(answer){
  const probes=[];
  const query=()=>{
    const reply=answer(probes.length);probes.push(reply);
    return {
      initializationResult:async()=>{if(reply.initError)throw new Error(reply.initError);return {models:[{value:"default",displayName:"Default"},{value:"haiku",displayName:"Haiku"}],commands:[{name:"review"}],agents:[{name:"Plan"}],account:SIGNED_IN}},
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async()=>{if(reply.usageError)throw new Error(reply.usageError);return reply.usage},
      close(){},
    };
  };
  return {query,probes};
}
async function claudeManager(t,answers){
  const home=await mkdtemp(join(tmpdir(),"trebell-claude-models-usage-"));t.after(()=>rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  let clock=1_000_000;
  const claude=scriptedClaude(index=>answers[Math.min(index,answers.length-1)]);
  const cache=createClaudeCapabilitiesCache({now:()=>clock,probe:input=>probeClaudeCapabilities({...input,query:claude.query,managedMcpExists:()=>false})});
  const env={...process.env,TREBELL_HOME:home},manager=new AgentRuntimeManager({state:new TrebellStateStore(env),env,claudeCapabilitiesCache:cache});
  manager.probe=async()=>({available:true,installed:true,authenticated:true});
  return {manager,cache,claude,advance:ms=>{clock+=ms}};
}

test("after Claude Code's usage read failed, the model list takes that probe for five minutes and starts none, while the Usage card reads again",async t=>{
  const {manager,claude,advance}=await claudeManager(t,[{usageError:"Claude Code did not report usage in time."},{usage:PLAN}]);
  const first=await manager.models("claude");
  assert.deepEqual(first.models,["default","haiku"]);assert.equal(claude.probes.length,1);
  advance(60_000);
  const again=await manager.models("claude");
  assert.equal(claude.probes.length,1,"the model list starts no probe of its own");
  assert.deepEqual([again.models,again.inventory],[["default","haiku"],{commands:[{name:"review"}],agents:[{name:"Plan"}]}],"its models, commands and agents");
  const usage=await manager.usageLimits("claude");
  assert.equal(claude.probes.length,2,"the Usage card asks Claude Code again");
  assert.deepEqual(usage.windows.map(window=>[window.id,window.usedPercent]),[["five_hour",12]]);
  advance(CLAUDE_CAPABILITIES_TTL_MS+1);
  await manager.models("claude");
  assert.equal(claude.probes.length,3,"past five minutes the model list asks again");
});

test("a re-probe that fails keeps the models and commands the earlier probe listed",async t=>{
  // Under load Claude Code's initialize keeps timing out after the first probe, whose usage came without data.
  const slow={initError:"Claude Code did not report its capabilities in time."};
  const {manager,cache,claude,advance}=await claudeManager(t,[{usage:{session:{},rate_limits_available:true,rate_limits:null}},slow,slow,{usage:PLAN}]);
  assert.deepEqual((await manager.models("claude")).models,["default","haiku"]);
  advance(1000);
  assert.deepEqual((await manager.usageLimits("claude")).unavailable,{reason:"probeFailed",message:"Claude Code could not read usage limits."});
  assert.equal(claude.probes.length,2,"the Usage card's read failed outright");
  advance(1000);
  const listed=await manager.models("claude");
  assert.deepEqual([listed.source,listed.models],["live",["default","haiku"]],"not 'Claude Code could not list its models'");
  assert.equal(claude.probes.length,2);
  // A session's first machine inventory, which accepts an older answer, still has it.
  const machine={command:manager.executable(manager.instances().find(item=>item.kind==="claude")),cwd:null,env:manager.childEnv(manager.instances().find(item=>item.kind==="claude")),spawnProcess:null,scope:""};
  assert.deepEqual(cache.peek(machine,{maxAgeMs:Infinity})?.models?.map(model=>model.value),["default","haiku"]);
  // The Usage card's next Refreshes read again, until Claude Code answers with the plan's windows.
  advance(1000);
  assert.equal((await manager.usageLimits("claude")).unavailable?.reason,"probeFailed");
  advance(1000);
  assert.deepEqual((await manager.usageLimits("claude")).windows.map(window=>window.id),["five_hour"]);
  assert.equal(claude.probes.length,4);
});
