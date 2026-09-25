import test from "node:test";
import assert from "node:assert/strict";
import { verificationRepairContext, verificationRepairPrompt, verificationRepairState } from "../src/verification-repair.mjs";

const plan={risk:"medium",steps:[{id:"tests",kind:"tests",scope:"affected",required:true,reason:"Changed code has related tests."}]};

test("verification repair selects the persisted record and exposes deterministic failed evidence",()=>{
  const records=[{id:"verification-1",plan,evidence:[{stepId:"tests",exitCode:1,status:"failed",reason:"Parser test failed",stdout:"SECRET_SHOULD_NOT_BE_INCLUDED"}],assessment:{risk:"medium"}}];
  const state=verificationRepairState(records);
  assert.equal(state.record.id,"verification-1");assert.equal(state.nextAction.action,"repair");assert.deepEqual(state.nextAction.failedSteps,["tests"]);
  const context=verificationRepairContext(state);
  assert.match(context,/verification-1/);assert.match(context,/Parser test failed/);assert.match(context,/"exitCode": 1/);
  assert.doesNotMatch(context,/SECRET_SHOULD_NOT_BE_INCLUDED/);
  assert.match(verificationRepairPrompt(),/Repair the failed verification/i);
});

test("verification repair refuses missing records and non-failed verification",()=>{
  assert.throws(()=>verificationRepairState([]),/No persisted verification record/i);
  const passed={id:"verified",plan,evidence:[{stepId:"tests",exitCode:0}],assessment:{risk:"medium"}};
  const state=verificationRepairState([passed]);assert.equal(state.nextAction.action,"complete");assert.equal(verificationRepairContext(state),"");
});
