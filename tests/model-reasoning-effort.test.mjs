import test from "node:test";
import assert from "node:assert/strict";
import { configuredReasoningEffort, defaultReasoningEffort, modelReasoningEffortKey, normalizeReasoningEffort, supportedReasoningEfforts } from "../src/model-reasoning-effort.mjs";

test("reasoning effort helpers preserve provider defaults unless the user explicitly overrides them",()=>{
  assert.equal(defaultReasoningEffort("native","openai","gpt-6-luna"),null);
  assert.equal(defaultReasoningEffort("native","openai","gpt-6-sol"),null);
  const key=modelReasoningEffortKey("native","openai","gpt-6-luna");
  assert.equal(configuredReasoningEffort({modelReasoningEfforts:{[key]:"high"}},"native","openai","gpt-6-luna"),"high");
  assert.equal(configuredReasoningEffort({},"native","openai","gpt-6-luna"),null);
  assert.equal(normalizeReasoningEffort(" MAX "),"max");
  assert.equal(normalizeReasoningEffort("turbo"),null);
});

test("reasoning effort capability lists stay provider/model specific",()=>{
  assert.deepEqual(supportedReasoningEfforts("native","openai","gpt-6-luna",{}),["none","low","medium","high","xhigh","max"]);
  assert.deepEqual(supportedReasoningEfforts("native","gemini","gemini-3.8-flash",{}),["low","medium","high"]);
  assert.deepEqual(supportedReasoningEfforts("native","anthropic","claude-opus-4-8",{}),["low","medium","high"]);
  assert.deepEqual(supportedReasoningEfforts("native","vyceai","whatever",{}),[]);
  assert.deepEqual(supportedReasoningEfforts("codex","ignored","custom",{supportedReasoningEfforts:["low","MAX","bogus"]}),["low","max"]);
});
