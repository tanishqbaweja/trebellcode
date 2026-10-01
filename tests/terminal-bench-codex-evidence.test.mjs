import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCodexSessionEvidence } from "../scripts/terminal-bench-codex-evidence.mjs";

test("Codex session evidence recovers exact per-request token and cost metrics",()=>{
  const rows=[
    {type:"token_usage_record",payload:{usage:{input_tokens:1000,cached_input_tokens:900,cache_write_input_tokens:50,output_tokens:100,reasoning_output_tokens:60}}},
    {type:"token_usage_record",payload:{usage:{input_tokens:2000,cached_input_tokens:1800,cache_write_input_tokens:100,output_tokens:200,reasoning_output_tokens:120}}},
  ].map(JSON.stringify).join("\n");
  const result=summarizeCodexSessionEvidence([rows]);
  assert.equal(result.modelTurns,2);assert.equal(result.inputTokens,3000);assert.equal(result.cachedTokens,2700);
  assert.equal(result.cacheWriteInputTokens,150);assert.equal(result.outputTokens,300);assert.equal(result.reasoningOutputTokens,180);
  assert.equal(result.maxObservedInputTokens,2000);assert.equal(result.apiEquivalentCostBreakdown.contextPricingExact,true);assert.ok(result.apiEquivalentCostUsd>0);
});
