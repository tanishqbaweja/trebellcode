import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { recordCodexRecoveryItemEvidence, staleCodexRecoveryState } from "../src/codex-recovery-evidence.mjs";

test("Codex recovery tracks only unresolved tool-like items with bounded metadata",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-recovery-evidence-")),env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);state.updateThreadMeta("thread-1",{restartRecovery:{runtime:"codex",bootId:"boot-1",threadId:"thread-1",turnId:"turn-1",status:"active",startedAt:1,uncertainTools:[]}});
    assert.equal(recordCodexRecoveryItemEvidence(state,{method:"item/started",params:{threadId:"thread-1",turnId:"turn-1",item:{id:"assistant-1",type:"agentMessage"}}}),false);
    assert.equal(recordCodexRecoveryItemEvidence(state,{method:"item/started",params:{threadId:"thread-1",turnId:"turn-1",item:{id:"cmd-1",type:"commandExecution",command:"SECRET SHOULD NOT PERSIST"}}}),true);
    let recovery=state.threadMeta("thread-1").restartRecovery;assert.deepEqual(recovery.uncertainTools,[{id:"cmd-1",type:"commandExecution",turnId:"turn-1",status:"inProgress"}]);assert.doesNotMatch(JSON.stringify(recovery),/SECRET SHOULD NOT PERSIST/);
    assert.equal(recordCodexRecoveryItemEvidence(state,{method:"item/completed",params:{threadId:"thread-1",turnId:"turn-1",item:{id:"cmd-1",type:"commandExecution",status:"completed"}}}),true);
    recovery=state.threadMeta("thread-1").restartRecovery;assert.deepEqual(recovery.uncertainTools,[]);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("stale Codex recovery blocks uncertain actions but preserves clean auto-continuation",()=>{
  const base={runtime:"codex",bootId:"old",threadId:"thread-1",turnId:"turn-1",status:"active",startedAt:1};
  const clean=staleCodexRecoveryState({...base,uncertainTools:[]},{continueAfterRestart:true,detectedAt:2});assert.equal(clean.status,"pending");assert.equal(clean.blocked,false);
  const blocked=staleCodexRecoveryState({...base,uncertainTools:[{id:"cmd-1",type:"commandExecution",turnId:"turn-1",status:"inProgress"}]},{continueAfterRestart:true,detectedAt:2});assert.equal(blocked.status,"blocked");assert.equal(blocked.blocked,true);assert.equal(blocked.reason,"uncertain_tool_action");assert.match(blocked.message,/Inspect its real-world state before repeating/i);
  const off=staleCodexRecoveryState(base,{continueAfterRestart:false,detectedAt:2});assert.equal(off.status,"interrupted");
});
