import test from "node:test";
import assert from "node:assert/strict";
import { defineToolPolicy, mcpAnnotationsForPolicy, REPOSITORY_READ_POLICY } from "../src/tool-policy.mjs";

test("tool policy normalizes reusable safety and execution metadata",()=>{
  const policy=defineToolPolicy({permissions:["workspace:write","workspace:write"],risk:"high",reversibility:"full",idempotent:false,externalSideEffects:true,workspace:"required",environment:"local",cost:"medium",latency:"high",progressiveDisclosure:false,readOnly:false,openWorld:true});
  assert.deepEqual(policy.permissions,["workspace:write"]);assert.equal(policy.risk,"high");assert.equal(policy.reversibility,"full");assert.equal(policy.progressiveDisclosure,false);
  assert.deepEqual(mcpAnnotationsForPolicy(policy),{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true});
});

test("repository read policy is closed-world and non-mutating",()=>{
  assert.equal(REPOSITORY_READ_POLICY.readOnly,true);assert.equal(REPOSITORY_READ_POLICY.risk,"low");assert.equal(REPOSITORY_READ_POLICY.reversibility,"not-applicable");
  assert.deepEqual(REPOSITORY_READ_POLICY.permissions,["repository:read"]);
  assert.deepEqual(mcpAnnotationsForPolicy(REPOSITORY_READ_POLICY),{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
});

test("tool policy rejects contradictory read-only side effects and invalid enums",()=>{
  assert.throws(()=>defineToolPolicy({readOnly:true,externalSideEffects:true}),/read-only tools cannot declare external side effects/i);
  assert.throws(()=>defineToolPolicy({risk:"banana"}),/invalid tool risk/i);
});
