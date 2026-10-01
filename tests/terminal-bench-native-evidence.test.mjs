import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverNativeEventEvidence, selectNativeMetric, summarizeNativeEventEvidence } from "../scripts/terminal-bench-native-evidence.mjs";

test("Native event evidence recovers failed-lane token metrics without exposing payloads",()=>{
  const marker="SECRET_TASK_PAYLOAD";
  const text=[
    {name:"native.model.completed",data:{usage:{inputTokens:1000,cachedInputTokens:900,outputTokens:50,reasoningOutputTokens:20,cacheWriteInputTokens:5},payload:marker}},
    {name:"native.tool.requested",data:{namespace:"trebell_terminal",name:"run",arguments:marker}},
    {name:"native.model.completed",data:{usage:{inputTokens:1200,cachedInputTokens:1000,outputTokens:70,reasoningOutputTokens:30,cacheWriteInputTokens:7},payload:marker}},
  ].map(JSON.stringify).join("\n");
  const summary=summarizeNativeEventEvidence(text);
  assert.equal(summary.modelTurns,2);assert.equal(summary.toolCalls,1);
  assert.equal(summary.inputTokens,2200);assert.equal(summary.cachedTokens,1900);assert.equal(summary.uncachedInputTokens,300);
  assert.equal(summary.cacheHitPercent,86.36);assert.equal(summary.outputTokens,120);assert.equal(summary.reasoningOutputTokens,50);assert.equal(summary.cacheWriteInputTokens,12);
  assert.equal(summary.maxObservedInputTokens,1200);assert.ok(summary.apiEquivalentCostUsd>0);assert.equal(summary.apiEquivalentCostBreakdown.contextPricingExact,true);
  assert.equal(JSON.stringify(summary).includes(marker),false);
});

test("Native event evidence locates a Harbor trial journal",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-evidence-")),job="job-a",agent=join(root,job,"trial-a","agent");
  try{
    await mkdir(agent,{recursive:true});
    await writeFile(join(agent,"trebell-native-events.jsonl"),JSON.stringify({name:"native.model.completed",data:{usage:{inputTokens:10,cachedInputTokens:8,outputTokens:2}}})+"\n","utf8");
    const recovered=await recoverNativeEventEvidence(root,job);
    assert.equal(recovered.inputTokens,10);assert.equal(recovered.cachedTokens,8);assert.equal(recovered.outputTokens,2);assert.equal(recovered.modelTurns,1);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native event evidence replaces missing or bogus zero counters without overriding positive Harbor metrics",()=>{
  assert.deepEqual(selectNativeMetric(null,null,123),{value:123,recovered:true});
  assert.deepEqual(selectNativeMetric(0,null,123),{value:123,recovered:true});
  assert.deepEqual(selectNativeMetric(0,111,123),{value:111,recovered:false});
  assert.deepEqual(selectNativeMetric(99,111,123),{value:99,recovered:false});
  assert.deepEqual(selectNativeMetric(0,null,0),{value:0,recovered:false});
});
