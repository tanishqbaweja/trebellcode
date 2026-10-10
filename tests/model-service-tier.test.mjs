import test from "node:test";
import assert from "node:assert/strict";
import { configuredModelServiceTier, modelServiceTierKey, normalizeModelServiceTier, supportedModelServiceTiers } from "../src/model-service-tier.mjs";

test("OpenAI Native exposes Fast as a processing tier for GPT-6 Luna and Sol",()=>{
  assert.deepEqual(supportedModelServiceTiers("native","openai","gpt-6-luna"),["fast"]);
  assert.deepEqual(supportedModelServiceTiers("native","openai","gpt-6-sol"),["fast"]);
  assert.deepEqual(supportedModelServiceTiers("native","gemini","gpt-6-luna"),[]);
});

test("service tier settings normalize Priority to Fast and stay model scoped",()=>{
  assert.equal(normalizeModelServiceTier("FAST"),"fast");
  assert.equal(normalizeModelServiceTier("priority"),"fast");
  assert.equal(normalizeModelServiceTier("ultrafast"),null);
  const key=modelServiceTierKey("native","openai","gpt-6-luna");
  assert.equal(configuredModelServiceTier({modelServiceTiers:{[key]:"fast"}},"native","openai","gpt-6-luna"),"fast");
  assert.equal(configuredModelServiceTier({modelServiceTiers:{[key]:"fast"}},"native","openai","gpt-6-sol"),null);
});

test("Claude Code offers Fast mode only for models its model list marks as supporting it",()=>{
  assert.deepEqual(supportedModelServiceTiers("claude","claude","opus",{supportsFastMode:true,supportedServiceTiers:["fast"]}),["fast"]);
  assert.deepEqual(supportedModelServiceTiers("claude","claude","haiku",{supportsFastMode:false}),[]);
});

test("Codex speed options are its catalog's service tiers by id, with Standard as Codex's default tier",async()=>{
  const {CODEX_STANDARD_SERVICE_TIER,codexDefaultServiceTier,codexServiceTierForTurn,codexServiceTierOptions,codexServiceTierPickerValue,modelServiceTierLabel,normalizeRuntimeModelServiceTier}=await import("../src/model-service-tier.mjs");
  const metadata={serviceTiers:[{id:"priority",name:"Fast",description:"Faster responses"},{id:"default",name:"Standard"},{id:"flex",name:"Flex"}],defaultServiceTier:"default"};
  assert.equal(CODEX_STANDARD_SERVICE_TIER,"default");
  assert.deepEqual(codexServiceTierOptions(metadata),[{id:"priority",label:"Fast",description:"Faster responses"},{id:"flex",label:"Flex",description:""}]);
  assert.deepEqual(supportedModelServiceTiers("codex","openai","gpt-6-luna",metadata),["priority","flex"],"Codex's own ids, not Trebell's fast");
  assert.deepEqual(codexServiceTierOptions({additionalSpeedTiers:["fast"]}),[{id:"fast",label:"Fast",description:""}],"the older additionalSpeedTiers list");
  assert.equal(normalizeRuntimeModelServiceTier("codex"," Priority "),"priority");
  assert.equal(normalizeRuntimeModelServiceTier("codex","has space"),null);
  // Only an explicit pick is sent (T3 sends serviceTier only when chosen); a saved "fast" still picks Codex's Fast tier.
  assert.equal(codexServiceTierForTurn({configured:"priority",metadata}),"priority");
  assert.equal(codexServiceTierForTurn({configured:"fast",metadata}),"priority");
  assert.equal(codexServiceTierForTurn({configured:"default",metadata}),"default","Standard is sent as Codex's default tier");
  assert.equal(codexServiceTierForTurn({metadata}),null,"no pick keeps the thread's own tier");
  assert.equal(codexServiceTierForTurn({configured:"turbo",custom:"flex",metadata}),"flex","an unknown pick falls to the custom model's tier");
  assert.equal(codexServiceTierForTurn({custom:"priority",metadata:{}}),"priority","a model without listed tiers sends only a custom tier");
  // The picker shows the pick, else the catalog's default tier, else Standard (T3 currentValue).
  assert.equal(codexServiceTierPickerValue("priority",metadata),"priority");
  assert.equal(codexServiceTierPickerValue(null,metadata),"default");
  assert.equal(codexDefaultServiceTier({...metadata,defaultServiceTier:"priority"}),"priority");
  assert.equal(codexDefaultServiceTier({...metadata,defaultServiceTier:"unlisted"}),"default");
  assert.equal(modelServiceTierLabel("codex","default",metadata),"Standard");
  assert.equal(modelServiceTierLabel("codex","priority",metadata),"Fast");
  assert.equal(modelServiceTierLabel("native","fast"),"Fast");
  const key=modelServiceTierKey("codex","openai","gpt-6-luna");
  assert.equal(configuredModelServiceTier({modelServiceTiers:{[key]:"priority"}},"codex","openai","gpt-6-luna"),"priority");
});
