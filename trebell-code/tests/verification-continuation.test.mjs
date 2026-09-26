import test from "node:test";
import assert from "node:assert/strict";
import { MAX_AUTOMATIC_VERIFICATION_CONTINUATIONS, verificationContinuationAttempt, verificationContinuationChainState, verificationContinuationContext, verificationContinuationPrompt, verificationContinuationState } from "../src/verification-continuation.mjs";
import { MAX_AUTOMATIC_VERIFICATION_ACTIONS, verificationAutomationAttempt, verificationAutomationChainState } from "../src/verification-automation.mjs";

const plan={risk:"medium",steps:[{id:"diagnostics",kind:"diagnostics",scope:"changed",cost:"low",required:true,reason:"Check syntax"},{id:"tests",kind:"tests",scope:"affected",cost:"medium",required:true,command:"npm test",reason:"Run tests"}]};

test("verification continuation selects and sanitizes the next missing step",()=>{
  const record={id:"v1",turnId:"user-turn",plan,evidence:[{stepId:"diagnostics",status:"passed",rawOutput:"SECRET"}],assessment:{risk:"medium"}},state=verificationContinuationState([record]);
  assert.equal(state.nextAction.action,"verify");assert.equal(state.nextAction.nextStep.id,"tests");const context=verificationContinuationContext(state);assert.match(context,/npm test/);assert.match(context,/next required verification step/i);assert.doesNotMatch(context,/SECRET/);assert.match(verificationContinuationPrompt(),/stop after that step/i);
});

test("automatic verification continuations and the shared verification automation chain are bounded",()=>{
  let chain=null,record={id:"v1",turnId:"user-turn"};
  for(let index=1;index<=MAX_AUTOMATIC_VERIFICATION_CONTINUATIONS;index++){const attempt=verificationContinuationAttempt(chain,record,{automatic:true});assert.equal(attempt.allowed,true);const turn=`verify-${index}`;chain=verificationContinuationChainState(attempt,turn);record={id:`v${index+1}`,turnId:turn}}
  assert.equal(verificationContinuationAttempt(chain,record,{automatic:true}).allowed,false);
  let global=null,current={id:"g1",turnId:"user-turn"};for(let index=1;index<=MAX_AUTOMATIC_VERIFICATION_ACTIONS;index++){const attempt=verificationAutomationAttempt(global,current,{automatic:true,action:index%2?"verify":"repair"});assert.equal(attempt.allowed,true);const turn=`auto-${index}`;global=verificationAutomationChainState(attempt,turn);current={id:`g${index+1}`,turnId:turn}}
  assert.equal(verificationAutomationAttempt(global,current,{automatic:true,action:"verify"}).allowed,false);
});
