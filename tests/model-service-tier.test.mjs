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
