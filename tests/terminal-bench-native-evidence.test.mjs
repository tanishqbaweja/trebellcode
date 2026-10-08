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
  assert.equal(summary.usageAccountingComplete,true);assert.equal(summary.unaccountedProviderRequests,0);assert.equal(summary.apiEquivalentCostIsLowerBound,false);
  assert.equal(JSON.stringify(summary).includes(marker),false);
});

test("Native event evidence marks incomplete zero-usage provider turns as unaccounted cost",()=>{
  const text=[
    {name:"native.model.completed",data:{finishReason:"completed",usage:{inputTokens:1000,cachedInputTokens:900,outputTokens:50}}},
    {name:"native.model.completed",data:{finishReason:"incomplete",usage:{inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0}}},
  ].map(JSON.stringify).join("\n");
  const summary=summarizeNativeEventEvidence(text);
  assert.equal(summary.usageAccountingComplete,false);
  assert.equal(summary.unaccountedProviderRequests,1);
  assert.equal(summary.apiEquivalentCostIsLowerBound,true);
  assert.equal(summary.apiEquivalentCostBreakdown.totalUsdIsLowerBound,true);
});

test("Native event evidence imputes capped zero-usage continuation responses from the cap and the retry",()=>{
  const capped=[
    {name:"native.model.completed",data:{finishReason:"tool_calls",usage:{inputTokens:50000,cachedInputTokens:49000,cacheWriteInputTokens:800,outputTokens:900}}},
    {name:"native.model.action_output_cap",data:{maxOutputTokens:32768}},
    {name:"native.model.requested",data:{}},
    {name:"native.model.completed",data:{finishReason:"incomplete",usage:{inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0}}},
    {name:"native.model.action_output_cap_relaxed",data:{maxOutputTokens:32768,finishReason:"max_output_tokens"}},
    {name:"native.model.requested",data:{}},
    {name:"native.model.completed",data:{finishReason:"tool_calls",usage:{inputTokens:57775,cachedInputTokens:56910,cacheWriteInputTokens:0,outputTokens:22908}}},
    {name:"native.completion.gate_output_cap",data:{maxOutputTokens:12288}},
    {name:"native.model.completed",data:{finishReason:"incomplete",usage:{inputTokens:0,outputTokens:0,totalTokens:0}}},
  ];
  const summary=summarizeNativeEventEvidence(capped.map(JSON.stringify).join("\n"),{serviceTier:"fast"});
  assert.equal(summary.unaccountedProviderRequests,0);assert.equal(summary.usageAccountingComplete,true);assert.equal(summary.apiEquivalentCostIsLowerBound,false);
  assert.equal(summary.imputedIncompleteResponses,2);assert.equal(summary.apiEquivalentCostBreakdown.requestCount,4,"imputed responses replace, never duplicate, their zero-usage records");
  assert.equal(summary.outputTokens,23808,"provider-reported token totals stay unchanged");
  assert.deepEqual(summary.apiEquivalentCostBreakdown.imputedUsage,{inputTokens:57775+57775,cachedInputTokens:56910+56910,cacheWriteInputTokens:0,outputTokens:32768+12288});
  const uncapped=summarizeNativeEventEvidence(capped.filter(event=>!/_output_cap$/.test(event.name)).map(JSON.stringify).join("\n"),{serviceTier:"fast"});
  assert.equal(uncapped.unaccountedProviderRequests,2);assert.equal(uncapped.apiEquivalentCostIsLowerBound,true);assert.equal(uncapped.imputedIncompleteResponses,0);
  const expectedExtra=((57775-56910)*0.2+56910*0.02+32768*1.0)/1e6+((57775-56910)*0.2+56910*0.02+12288*1.0)/1e6;
  assert.ok(Math.abs((summary.apiEquivalentCostUsd-uncapped.apiEquivalentCostUsd)-expectedExtra)<1e-9,`${summary.apiEquivalentCostUsd-uncapped.apiEquivalentCostUsd} vs ${expectedExtra}`);
});

test("Native event evidence prices the configured service tier instead of assuming Standard",()=>{
  const text=[
    {name:"native.model.completed",data:{finishReason:"completed",usage:{inputTokens:1000,cachedInputTokens:900,cacheWriteInputTokens:50,outputTokens:100}}},
  ].map(JSON.stringify).join("\n");
  const standard=summarizeNativeEventEvidence(text,{serviceTier:"standard"});
  const fast=summarizeNativeEventEvidence(text,{serviceTier:"fast"});
  assert.equal(fast.apiEquivalentCostBreakdown.pricing.serviceTier,"fast");
  assert.equal(standard.apiEquivalentCostBreakdown.pricing.serviceTier,"standard");
  assert.ok(fast.apiEquivalentCostUsd>standard.apiEquivalentCostUsd);
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
