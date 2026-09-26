import test from "node:test";
import assert from "node:assert/strict";
import { autoCompactionDecision } from "../ui/src/auto-compaction.js";

test("auto compaction stays off without an explicit enabled setting",()=>{
  assert.deepEqual(autoCompactionDecision({modelContextWindow:100000,last:{inputTokens:90000}}),{
    shouldCompact:false,reason:"disabled",thresholdPercent:85,windowSize:null,inputTokens:null,utilizationPercent:null,
  });
});

test("auto compaction triggers at the configured context threshold",()=>{
  const below=autoCompactionDecision({modelContextWindow:100000,last:{inputTokens:84999}},{enabled:true,thresholdPercent:85});
  assert.equal(below.shouldCompact,false);assert.equal(below.reason,"below-threshold");
  const reached=autoCompactionDecision({modelContextWindow:100000,last:{inputTokens:85000}},{enabled:true,thresholdPercent:85});
  assert.equal(reached.shouldCompact,true);assert.equal(reached.utilizationPercent,85);
});

test("auto compaction clamps unsafe threshold settings",()=>{
  assert.equal(autoCompactionDecision({modelContextWindow:100,last:{inputTokens:70}},{enabled:true,thresholdPercent:20}).thresholdPercent,70);
  assert.equal(autoCompactionDecision({modelContextWindow:100,last:{inputTokens:95}},{enabled:true,thresholdPercent:99}).thresholdPercent,95);
});
