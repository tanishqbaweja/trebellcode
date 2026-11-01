import test from "node:test";
import assert from "node:assert/strict";
import { CODEX_STANDARD_SERVICE_TIER, codexConfiguredServiceTier, codexDefaultServiceTier, codexServiceTierForTurn, codexServiceTierOptions, codexServiceTierPickerValue, configuredModelServiceTier, modelServiceTierKey, modelServiceTierLabel, normalizeModelServiceTier, normalizeRuntimeModelServiceTier, supportedModelServiceTiers } from "../src/model-service-tier.mjs";

test("OpenAI Native exposes Fast as a processing tier for GPT-6 Luna and Sol",()=>{
  assert.deepEqual(supportedModelServiceTiers("native","openai","gpt-6-luna"),["fast"]);
  assert.deepEqual(supportedModelServiceTiers("native","openai","gpt-6-sol"),["fast"]);
  assert.deepEqual(supportedModelServiceTiers("native","gemini","gpt-6-luna"),[]);
});

test("OpenAI Native offers Fast on GPT-6 point releases of Luna and Sol as on their base models",()=>{
  assert.deepEqual(supportedModelServiceTiers("native","openai","gpt-6.1-sol"),["fast"]);
  assert.deepEqual(supportedModelServiceTiers("native","openai","gpt-6.1-luna"),["fast"]);
  assert.deepEqual(supportedModelServiceTiers("native","openai","gpt-6.1-sol-2026-09-30"),["fast"]);
  assert.deepEqual(supportedModelServiceTiers("native","openai","gpt-6.1-astra"),supportedModelServiceTiers("native","openai","gpt-6-astra"));
  assert.deepEqual(supportedModelServiceTiers("native","openai","gpt-60-sol"),[]);
  assert.deepEqual(supportedModelServiceTiers("native","hcnsec","gpt-6.1-sol"),[]);
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

test("Codex speed options are its catalog's service tiers by id, with Standard as Codex's default tier",()=>{
  assert.equal(CODEX_STANDARD_SERVICE_TIER,"default");
  const metadata={serviceTiers:[{id:"priority",name:"Fast",description:"Faster responses"},{id:"default",name:"Standard"},{id:"flex",name:"Flex"}],defaultServiceTier:"default"};
  assert.deepEqual(codexServiceTierOptions(metadata),[{id:"priority",label:"Fast",description:"Faster responses"},{id:"flex",label:"Flex",description:""}]);
  assert.deepEqual(supportedModelServiceTiers("codex","openai","gpt-6-luna",metadata),["priority","flex"],"Codex's own ids, not Trebell's fast");
  assert.deepEqual(codexServiceTierOptions({additionalSpeedTiers:["fast"]}),[{id:"fast",label:"Fast",description:""}],"the older additionalSpeedTiers list");
  assert.equal(normalizeRuntimeModelServiceTier("codex"," Priority "),"priority");
  assert.equal(normalizeRuntimeModelServiceTier("codex","has space"),null);
  // Only an explicit pick is sent; a saved "fast" still picks Codex's Fast tier.
  assert.equal(codexServiceTierForTurn({configured:"priority",metadata}),"priority");
  assert.equal(codexServiceTierForTurn({configured:"fast",metadata}),"priority");
  assert.equal(codexServiceTierForTurn({configured:"default",metadata}),"default","Standard is sent as Codex's default tier");
  assert.equal(codexServiceTierForTurn({metadata}),null,"no pick keeps the thread's own tier");
  assert.equal(codexServiceTierForTurn({configured:"turbo",custom:"flex",metadata}),"flex","an unknown pick falls to the custom model's tier");
  assert.equal(codexServiceTierForTurn({custom:"priority",metadata:{}}),"priority","a model without listed tiers sends only a custom tier");
  // The picker shows the pick, else the catalog's default tier, else Standard.
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

test("a Codex model's speed options come from serviceTiers alone when it lists any, else from the older additionalSpeedTiers",()=>{
  const option=(id,label,description="")=>({id,label,description});
  assert.deepEqual(codexServiceTierOptions({serviceTiers:[],additionalSpeedTiers:["fast","flex"]}),[option("fast","Fast"),option("flex","flex")],"an empty serviceTiers falls back to the older ids, and only fast has a display name");
  assert.deepEqual(codexServiceTierOptions({serviceTiers:[{id:"priority",name:"Fast"}],additionalSpeedTiers:["fast","flex"]}),[option("priority","Fast")],"the newer list wins");
  assert.deepEqual(codexServiceTierOptions({serviceTiers:[{id:"default",name:"Standard"}],additionalSpeedTiers:["fast"]}),[],"a non-empty serviceTiers is used alone, even with nothing but Standard");
  // Bare ids, trimmed and lower-cased; entries that name no tier are skipped.
  assert.deepEqual(codexServiceTierOptions({serviceTiers:[" Priority ",null,5,true,{name:"No id"},{id:"has space",name:"Bad"},["flex"],"flex"]}),[option("priority","priority"),option("flex","flex")]);
  // A tier listed twice keeps its first label and description.
  assert.deepEqual(codexServiceTierOptions({serviceTiers:[{id:"priority",name:"Fast",description:"First"},{id:"PRIORITY",name:"Again",description:"Second"}]}),[option("priority","Fast","First")]);
  assert.deepEqual(codexServiceTierOptions({serviceTiers:[{id:"flex",name:"",description:null}]}),[option("flex","flex")],"an empty name shows the id");
  for(const row of [undefined,null,{},"fast",{serviceTiers:"priority"},{additionalSpeedTiers:"fast"}])assert.deepEqual(codexServiceTierOptions(row),[],JSON.stringify(row)??"undefined");
});

test("the tier a Codex config names is read without case or spaces, Standard is every model's, and fast answers the first listed of priority and fast",()=>{
  assert.equal(codexConfiguredServiceTier({serviceTiers:[{id:"priority",name:"Fast"}]}," FAST "),"priority");
  assert.equal(codexConfiguredServiceTier({serviceTiers:[{id:"priority",name:"Fast"}]},"Priority"),"priority");
  assert.equal(codexConfiguredServiceTier({},"default"),"default","Standard needs no listing");
  assert.equal(codexConfiguredServiceTier(null,"default"),"default");
  assert.equal(codexConfiguredServiceTier({serviceTiers:["priority","fast"]},"fast"),"priority");
  assert.equal(codexConfiguredServiceTier({serviceTiers:["fast","priority"]},"fast"),"fast");
  assert.equal(codexConfiguredServiceTier({serviceTiers:["fast","priority"]},"priority"),"priority","priority names only priority");
  assert.equal(codexConfiguredServiceTier({additionalSpeedTiers:["flex"]},"flex"),"flex");
  assert.equal(codexConfiguredServiceTier({additionalSpeedTiers:["flex"]},"fast"),null);
  assert.equal(codexConfiguredServiceTier({serviceTiers:[{id:"priority",name:"Fast"}]},"Fast!"),null);
  assert.equal(codexConfiguredServiceTier({serviceTiers:[{id:"priority",name:"Fast"}]}),null,"a config with no tier names none");
});
