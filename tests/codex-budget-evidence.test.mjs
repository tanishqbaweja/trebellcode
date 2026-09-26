import test from "node:test";
import assert from "node:assert/strict";
import { recordCodexBudgetEvidence, recordCodexChildAgentEvidence, recordCodexToolCallEvidence } from "../src/codex-budget-evidence.mjs";

function stateFixture(){
  const records=new Map();
  return {
    threadMeta:id=>records.get(id)||{},
    updateThreadMeta:(id,patch)=>{const next={...(records.get(id)||{}),...patch};for(const [key,value] of Object.entries(next))if(value===undefined)delete next[key];records.set(id,next);return next},
  };
}

test("Codex budget evidence counts tool starts once and ignores non-tool activity",()=>{
  const state=stateFixture();
  assert.equal(recordCodexToolCallEvidence(state,{threadId:"thread-1",turnId:"turn-1",item:{id:"cmd-1",type:"commandExecution"}}),true);
  assert.equal(recordCodexToolCallEvidence(state,{threadId:"thread-1",turnId:"turn-1",item:{id:"cmd-1",type:"commandExecution"}}),false);
  assert.equal(recordCodexBudgetEvidence(state,{method:"item/started",params:{threadId:"thread-1",turnId:"turn-1",item:{id:"assistant-1",type:"agentMessage"}}}),false);
  assert.equal(recordCodexBudgetEvidence(state,{method:"item/started",params:{threadId:"thread-1",turnId:"turn-1",item:{id:"mcp-1",type:"mcpToolCall"}}}),true);
  assert.equal(state.threadMeta("thread-1").codexToolCallCount,2);
  assert.deepEqual(state.threadMeta("thread-1").codexToolCallIds,["turn-1:cmd-1","turn-1:mcp-1"]);
});

test("Codex budget evidence counts each delegated child thread once on the parent",()=>{
  const state=stateFixture(),child={id:"child-1",parentThreadId:"parent-1"};
  assert.equal(recordCodexChildAgentEvidence(state,child),true);
  assert.equal(recordCodexBudgetEvidence(state,{method:"thread/started",params:{thread:child}}),false);
  assert.equal(recordCodexBudgetEvidence(state,{method:"thread/started",params:{thread:{id:"child-2",parentThreadId:"parent-1"}}}),true);
  assert.equal(recordCodexBudgetEvidence(state,{method:"thread/started",params:{thread:{id:"root-thread"}}}),false);
  assert.equal(state.threadMeta("parent-1").codexChildAgentCount,2);
  assert.deepEqual(state.threadMeta("parent-1").codexChildAgentIds,["child-1","child-2"]);
});
