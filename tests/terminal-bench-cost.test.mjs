import assert from "node:assert/strict";
import test from "node:test";
import { estimateGpt6LunaCostFromAggregate, estimateGpt6LunaCostFromRecords, estimateGpt6LunaStandardCostFromAggregate, estimateGpt6LunaStandardCostFromRecords, GPT6_LUNA_FAST_PRICING } from "../scripts/terminal-bench-cost.mjs";

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

test("gpt-6-luna Fast pricing doubles the same model's Standard token rates",()=>{
  const standard=estimateGpt6LunaStandardCostFromRecords([{inputTokens:100_000,cachedInputTokens:80_000,cacheWriteInputTokens:10_000,outputTokens:20_000}]);
  const fast=estimateGpt6LunaCostFromRecords([{inputTokens:100_000,cachedInputTokens:80_000,cacheWriteInputTokens:10_000,outputTokens:20_000}],{serviceTier:"fast"});
  assert.equal(fast.pricing.serviceTier,"fast");assert.equal(GPT6_LUNA_FAST_PRICING.shortContext.output,1);assert.ok(Math.abs(fast.totalUsd-standard.totalUsd*2)<1e-12);
});

test("an OAuth lane's unreported cache writes are priced like the API lanes' writes, and the reported price is kept",()=>{
  const records=[
    {inputTokens:100_000,cachedInputTokens:90_000,cacheWriteInputTokens:0,outputTokens:1_000},
    {inputTokens:300_000,cachedInputTokens:280_000,cacheWriteInputTokens:0,outputTokens:2_000},
    {inputTokens:50_000,cachedInputTokens:40_000,cacheWriteInputTokens:9_000,outputTokens:500},
  ];
  const reported=estimateGpt6LunaCostFromRecords(records,{serviceTier:"fast"});
  const oauth=estimateGpt6LunaCostFromRecords(records,{serviceTier:"fast",cacheWritesUnreported:true});
  // 10k short-context and 20k long-context non-cached tokens move from input to cache-write rates (1.25x input).
  assert.ok(Math.abs(oauth.totalUsd-reported.totalUsd-(10_000*0.20*0.25+20_000*0.40*0.25)/1e6)<1e-12);
  assert.equal(oauth.asReported.totalUsd,reported.totalUsd);
  assert.equal(oauth.imputedCacheWriteInputTokens,30_000);
  assert.deepEqual(oauth.usage,reported.usage);
  // The request that reports its own writes keeps its 1k non-cached tokens at the input rate.
  assert.ok(Math.abs(oauth.uncachedInputUsd-1_000*0.20/1e6)<1e-12);
  assert.equal(reported.asReported,undefined);assert.equal(reported.cacheWritesUnreported,undefined);
});

test("the aggregate estimate prices unreported cache writes the same way",()=>{
  const record={inputTokens:1000,cachedInputTokens:900,outputTokens:100};
  const reported=estimateGpt6LunaCostFromAggregate(record,{maxObservedInputTokens:1000,serviceTier:"fast"});
  const oauth=estimateGpt6LunaCostFromAggregate(record,{maxObservedInputTokens:1000,serviceTier:"fast",cacheWritesUnreported:true});
  assert.ok(Math.abs(oauth.totalUsd-reported.totalUsd-100*0.20*0.25/1e6)<1e-12);
  assert.equal(oauth.asReported.totalUsd,reported.totalUsd);assert.equal(oauth.imputedCacheWriteInputTokens,100);
});
