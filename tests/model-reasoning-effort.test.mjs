import test from "node:test";
import assert from "node:assert/strict";
import { configuredReasoningEffort, defaultReasoningEffort, modelReasoningEffortKey, normalizeReasoningEffort, normalizeRuntimeReasoningEffort, supportedReasoningEfforts } from "../src/model-reasoning-effort.mjs";

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
});

test("a Native provider offers no effort levels until a model is chosen",()=>{
  // Live: Gemini without a key (no model in the catalog) still showed a Thinking picker.
  for(const model of [null,undefined,""," "])assert.deepEqual(supportedReasoningEfforts("native","gemini",model,{}),[],String(model));
  assert.deepEqual(supportedReasoningEfforts("native","gemini","gemini-3.8-flash",{}),["low","medium","high"]);
  assert.deepEqual(supportedReasoningEfforts("native","openai","",{}),[]);
});

test("OpenAI GPT-6 point releases offer the Native effort levels OpenAI accepts for them",()=>{
  // gpt-6.1-sol, OpenAI's default model, accepts Low through Max; the Responses API rejects "none" for it, which gpt-6-sol
  // accepts (live, 2026-10-11). Codex's model metadata for gpt-6.1-sol lists the same levels, plus its own Ultra.
  for(const model of ["gpt-6.1-sol","gpt-6.1-luna","gpt-6.2-astra","gpt-6.1-sol-2026-09-30"])assert.deepEqual(supportedReasoningEfforts("native","openai",model,{}),["low","medium","high","xhigh","max"],model);
  assert.deepEqual(supportedReasoningEfforts("native","openai","gpt-6-sol",{}),["none","low","medium","high","xhigh","max"],"the base model keeps None");
  for(const model of ["gpt-60-sol","gpt-6.1","gpt-6.x-sol"])assert.deepEqual(supportedReasoningEfforts("native","openai",model,{}),[],model);
  assert.deepEqual(supportedReasoningEfforts("native","hcnsec","gpt-6.1-sol",{}),[]);
});

test("Codex effort levels are the ones its model list advertises, Ultra included, as T3 Code keeps them",()=>{
  assert.deepEqual(supportedReasoningEfforts("codex","ignored","custom",{supportedReasoningEfforts:["low","MAX","ultra","x-high_2","has spaces","","low"]}),["low","max","ultra","x-high_2"]);
  assert.deepEqual(supportedReasoningEfforts("codex","ignored","custom",{supportedReasoningEfforts:[{reasoningEffort:"xhigh"},{effort:"ultra"}]}),["xhigh","ultra"]);
  assert.deepEqual(supportedReasoningEfforts("codex","ignored","custom",{}),[],"a model Codex lists no efforts for offers no picker");
  assert.equal(normalizeRuntimeReasoningEffort("codex"," Ultra "),"ultra");
  for(const invalid of ["","has spaces","-high","x".repeat(33),null])assert.equal(normalizeRuntimeReasoningEffort("codex",invalid),null);
  const key=modelReasoningEffortKey("codex","openai","gpt-6-astra");
  assert.equal(configuredReasoningEffort({modelReasoningEfforts:{[key]:"ultra"}},"codex","openai","gpt-6-astra"),"ultra");
});

test("Claude Code effort levels are the ones its model list advertises for each model",()=>{
  assert.deepEqual(supportedReasoningEfforts("claude","claude","default",{supportedReasoningEfforts:["low","medium","high","xhigh","max"]}),["low","medium","high","xhigh","max"]);
  assert.deepEqual(supportedReasoningEfforts("claude","claude","claude-opus-4-6",{supportedReasoningEfforts:["low","medium","high","max"]}),["low","medium","high","max"]);
  assert.deepEqual(supportedReasoningEfforts("claude","claude","custom-model",{}),[],"a model Claude Code did not list offers no effort picker");
});

test("OpenCode reasoning levels are the model's own OpenCode variants, kept by the names OpenCode gives them",()=>{
  assert.equal(normalizeRuntimeReasoningEffort("opencode"," Thinking "),"Thinking","variant names keep their case");
  assert.equal(normalizeRuntimeReasoningEffort("opencode","x.high_2"),"x.high_2");
  for(const invalid of ["","bad variant","-high",".high",null,undefined,"x".repeat(65)])assert.equal(normalizeRuntimeReasoningEffort("opencode",invalid),null);
  const model="anthropic/claude-sonnet-4-5";
  assert.deepEqual(supportedReasoningEfforts("opencode","opencode",model,{reasoningEfforts:["high","max","Thinking","high","bad variant"]}),["high","max","Thinking"]);
  assert.deepEqual(supportedReasoningEfforts("opencode","opencode","opencode/big-pickle",{}),[],"a model without variants offers no reasoning picker");
  const key=modelReasoningEffortKey("opencode","opencode",model);
  assert.equal(configuredReasoningEffort({modelReasoningEfforts:{[key]:"Thinking"}},"opencode","opencode",model),"Thinking");
  assert.equal(configuredReasoningEffort({modelReasoningEfforts:{[key]:"not a variant"}},"opencode","opencode",model),null);
});
