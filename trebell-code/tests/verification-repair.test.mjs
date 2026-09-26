import test from "node:test";
import assert from "node:assert/strict";
import { MAX_AUTOMATIC_VERIFICATION_REPAIRS, verificationRepairAttempt, verificationRepairChainState, verificationRepairContext, verificationRepairPrompt, verificationRepairState } from "../src/verification-repair.mjs";

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

test("automatic verification repair chains are bounded while unrelated failures reset the attempt count",()=>{
  const first=verificationRepairAttempt(null,{id:"record-1",turnId:"turn-user"},{automatic:true});assert.equal(first.allowed,true);assert.equal(first.attempts,1);
  const chain1=verificationRepairChainState(first,"repair-turn-1"),second=verificationRepairAttempt(chain1,{id:"record-2",turnId:"repair-turn-1"},{automatic:true});assert.equal(second.attempts,2);assert.equal(second.rootRecordId,"record-1");
  const chain2=verificationRepairChainState(second,"repair-turn-2"),third=verificationRepairAttempt(chain2,{id:"record-3",turnId:"repair-turn-2"},{automatic:true});assert.equal(third.allowed,true);assert.equal(third.attempts,MAX_AUTOMATIC_VERIFICATION_REPAIRS);
  const chain3=verificationRepairChainState(third,"repair-turn-3"),fourth=verificationRepairAttempt(chain3,{id:"record-4",turnId:"repair-turn-3"},{automatic:true});assert.equal(fourth.allowed,false);assert.equal(fourth.attempts,MAX_AUTOMATIC_VERIFICATION_REPAIRS+1);
  const manual=verificationRepairAttempt(chain3,{id:"record-4",turnId:"repair-turn-3"},{automatic:false});assert.equal(manual.allowed,true);
  const unrelated=verificationRepairAttempt(chain3,{id:"new-user-record",turnId:"different-turn"},{automatic:true});assert.equal(unrelated.attempts,1);assert.equal(unrelated.rootRecordId,"new-user-record");
});
