import test from "node:test";
import assert from "node:assert/strict";
import { configuredReasoningEffort, defaultReasoningEffort, modelReasoningEffortKey, normalizeReasoningEffort, normalizeRuntimeReasoningEffort, supportedReasoningEfforts } from "../src/model-reasoning-effort.mjs";
import * as efforts from "../src/model-reasoning-effort.mjs";

// Native's default is the effort a model was measured with (src/native-configuration.mjs: Max for gpt-6-luna, which the benchmarks
// run); a model without a measured row keeps the provider's default, and a saved Thinking level always wins.
test("reasoning effort helpers give the measured default and keep the provider default for unmeasured models unless the user overrides them",()=>{
  assert.equal(defaultReasoningEffort("native","openai","gpt-6-luna"),"max");
  assert.equal(defaultReasoningEffort("native","openai","gpt-6-sol"),null);
  assert.equal(defaultReasoningEffort("native","openai","gpt-5"),null);
  assert.equal(defaultReasoningEffort("codex","openai","gpt-6-luna"),null,"only Native's default comes from its configuration");
  const key=modelReasoningEffortKey("native","openai","gpt-6-luna");
  assert.equal(configuredReasoningEffort({modelReasoningEfforts:{[key]:"high"}},"native","openai","gpt-6-luna"),"high");
  assert.equal(configuredReasoningEffort({},"native","openai","gpt-6-luna"),"max");
  assert.equal(configuredReasoningEffort({},"native","openai","gpt-6-sol"),null);
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

test("the Native Thinking picker offers only effort levels the OpenAI Responses API accepts for the model",()=>{
  // Live, 2026-10-11: any other level came back HTTP 400 "Unsupported value: '<effort>' is not supported with the '<model>'
  // model. Supported values are: ...", which fails the turn. These are OpenAI's own lists from those answers.
  const accepted={
    "gpt-5":["minimal","low","medium","high"],"gpt-5-mini":["minimal","low","medium","high"],"gpt-5-nano":["minimal","low","medium","high"],"gpt-5-2025-08-07":["minimal","low","medium","high"],
    "gpt-5.1":["none","low","medium","high"],
    "gpt-5.2":["none","low","medium","high","xhigh"],"gpt-5.3-codex":["none","low","medium","high","xhigh"],"gpt-5.4":["none","low","medium","high","xhigh"],"gpt-5.4-mini":["none","low","medium","high","xhigh"],"gpt-5.4-nano":["none","low","medium","high","xhigh"],"gpt-5.5":["none","low","medium","high","xhigh"],
    "gpt-5.6-sol":["none","low","medium","high","xhigh","max"],"gpt-5.6-terra":["none","low","medium","high","xhigh","max"],
    "gpt-5-pro":["high"],"gpt-5.2-pro":["medium","high","xhigh"],"gpt-5.4-pro":["medium","high","xhigh"],"gpt-5.5-pro":["medium","high","xhigh"],
    "o1":["low","medium","high"],"o1-pro":["low","medium","high"],"o3":["low","medium","high"],"o3-mini":["low","medium","high"],"o4-mini":["low","medium","high"],
    "gpt-6-luna":["none","low","medium","high","xhigh","max"],"gpt-6-astra":["low","medium","high","xhigh","max"],"gpt-6.1-sol":["low","medium","high","xhigh","max"],
  };
  const rejected={},missing=[];
  for(const [model,ok] of Object.entries(accepted)){
    const offered=supportedReasoningEfforts("native","openai",model,{});
    const bad=offered.filter(effort=>!ok.includes(effort));if(bad.length)rejected[model]=bad;
    if(!offered.length)missing.push(model);
  }
  assert.deepEqual(rejected,{},"offered levels the model rejects with HTTP 400");
  assert.deepEqual(missing,[],"each of these models takes a level, so the picker stays");
  assert.deepEqual(supportedReasoningEfforts("native","openai","gpt-5-pro",{}),["high"]);
  assert.deepEqual(supportedReasoningEfforts("native","openai","o3",{}),["low","medium","high"]);
});

test("a Native Thinking level the model's own list leaves out gives way to the provider default",()=>{
  // Saved per model while the picker still offered them, before the per-model lists; the Responses API refuses each with
  // HTTP 400 ("Unsupported value: 'xhigh' is not supported with the 'gpt-5' model"), so every turn failed.
  const saved={"gpt-5":"xhigh","gpt-5.1":"xhigh","o3":"xhigh","gpt-5-pro":"medium","gpt-5.2-pro":"low"};
  const settings={modelReasoningEfforts:Object.fromEntries(Object.entries(saved).map(([model,effort])=>[modelReasoningEffortKey("native","openai",model),effort]))};
  const used=Object.fromEntries(Object.keys(saved).map(model=>[model,configuredReasoningEffort(settings,"native","openai",model)]));
  assert.deepEqual(used,{"gpt-5":null,"gpt-5.1":null,"o3":null,"gpt-5-pro":null,"gpt-5.2-pro":null});
  assert.equal(configuredReasoningEffort({modelReasoningEfforts:{[modelReasoningEffortKey("native","openai","gpt-5")]:"high"}},"native","openai","gpt-5"),"high");
  // A level the provider's catalog lists for the model counts as offered, as the picker shows it.
  const key=modelReasoningEffortKey("native","vyceai","vyce-thinker");
  assert.equal(configuredReasoningEffort({modelReasoningEfforts:{[key]:"high"}},"native","vyceai","vyce-thinker",{reasoningEfforts:["low","high"]}),"high");
  assert.equal(configuredReasoningEffort({modelReasoningEfforts:{[key]:"high"}},"native","vyceai","vyce-thinker"),null,"a model with no levels offered takes none");
});

test("Codex effort levels are the ones its model list advertises, Ultra included",()=>{
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

// The composer's Thinking picker (review of native-one-config, 2026-10-29): on gpt-6-luna it showed Max with nothing saved, and its
// Default option, which deletes the saved level, jumped back to Max, so it could never be chosen and its "the provider's own level"
// was untrue. A model with a measured level now lists that level and offers no Default; other models keep Default.
test("the Thinking picker on gpt-6-luna shows Max with no Default option, and other models keep Default for the provider's level",()=>{
  assert.equal(typeof efforts.reasoningEffortPicker,"function");
  assert.deepEqual(efforts.reasoningEffortPicker({},"native","openai","gpt-6-luna"),{value:"max",defaultOption:false,defaultLevel:"max"});
  assert.ok(supportedReasoningEfforts("native","openai","gpt-6-luna").includes("max"),"the default is one of the listed levels");
  const picked={modelReasoningEfforts:{"native:openai:gpt-6-luna":"high"}};
  assert.deepEqual(efforts.reasoningEffortPicker(picked,"native","openai","gpt-6-luna"),{value:"high",defaultOption:false,defaultLevel:"max"});
  assert.equal(configuredReasoningEffort(picked,"native","openai","gpt-6-luna"),"high","a message runs at the level shown");
  // An unmeasured model: Default, the provider's own level, which a message sends no effort for.
  assert.deepEqual(efforts.reasoningEffortPicker({},"native","openai","gpt-5"),{value:"",defaultOption:true,defaultLevel:null});
  assert.equal(configuredReasoningEffort({},"native","openai","gpt-5"),null);
  // A level the model no longer takes shows as Default there and as the measured level on gpt-6-luna.
  assert.equal(efforts.reasoningEffortPicker({modelReasoningEfforts:{"native:openai:gpt-5":"xhigh"}},"native","openai","gpt-5").value,"");
  // Other harnesses keep Default and their saved level.
  assert.deepEqual(efforts.reasoningEffortPicker({modelReasoningEfforts:{"opencode:opencode:big":"Thinking"}},"opencode","opencode","big"),{value:"Thinking",defaultOption:true,defaultLevel:null});
});
