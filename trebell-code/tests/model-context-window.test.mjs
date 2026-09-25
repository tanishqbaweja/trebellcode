import test from "node:test";
import assert from "node:assert/strict";
import { modelContextWindowFromMetadata, modelContextWindowKey } from "../src/model-context-window.mjs";

test("model context windows come only from explicit provider metadata",()=>{
  assert.equal(modelContextWindowFromMetadata({context_length:131072}),131072);
  assert.equal(modelContextWindowFromMetadata({contextWindow:"200000"}),200000);
  assert.equal(modelContextWindowFromMetadata({limits:{context_length:65536}}),65536);
  assert.equal(modelContextWindowFromMetadata({max_model_len:32768}),32768);
  assert.equal(modelContextWindowFromMetadata({max_output_tokens:8192}),null);
  assert.equal(modelContextWindowFromMetadata({context_length:-1}),null);
  assert.equal(modelContextWindowFromMetadata({context_length:"unknown"}),null);
  assert.equal(modelContextWindowFromMetadata(null),null);
});

test("model context cache keys keep providers isolated",()=>{
  assert.notEqual(modelContextWindowKey("agentrouter","shared-model"),modelContextWindowKey("hcnsec","shared-model"));
  assert.equal(modelContextWindowKey(" AgentRouter ","model-a"),modelContextWindowKey("agentrouter","model-a"));
});
