import assert from "node:assert/strict";
import test from "node:test";
import { estimateGpt6LunaStandardCostFromAggregate, estimateGpt6LunaStandardCostFromRecords } from "../scripts/terminal-bench-cost.mjs";

test("gpt-6-luna cost calculation splits cached, cache-write, uncached, and output tokens",()=>{
  const result=estimateGpt6LunaStandardCostFromRecords([{inputTokens:100_000,cachedInputTokens:80_000,cacheWriteInputTokens:10_000,outputTokens:20_000}]);
  assert.equal(result.usage.uncachedInputTokens,10_000);
  assert.equal(result.uncachedInputUsd,0.001);
  assert.equal(result.cachedInputUsd,0.0008);
  assert.equal(result.cacheWriteInputUsd,0.00125);
  assert.equal(result.outputUsd,0.01);
  assert.ok(Math.abs(result.totalUsd-0.01305)<1e-12);
});

test("gpt-6-luna cost calculation applies long-context rates request by request",()=>{
  const result=estimateGpt6LunaStandardCostFromRecords([
    {inputTokens:100_000,cachedInputTokens:90_000,cacheWriteInputTokens:5_000,outputTokens:10_000},
    {inputTokens:300_000,cachedInputTokens:250_000,cacheWriteInputTokens:25_000,outputTokens:20_000},
  ]);
  assert.equal(result.longContextRequestCount,1);
  assert.equal(result.contextPricingExact,true);
  assert.ok(result.totalUsd>0);
});

test("aggregate cost marks short-context pricing as an assumption when request lengths are unknown",()=>{
  const result=estimateGpt6LunaStandardCostFromAggregate({inputTokens:1000,cachedInputTokens:900,outputTokens:100});
  assert.equal(result.contextPricingExact,false);
  assert.match(result.contextPricingAssumption,/short-context rates assumed/i);
});
