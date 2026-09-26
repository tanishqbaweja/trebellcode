import test from "node:test";
import assert from "node:assert/strict";
import { mergeVerificationEvidence, nextVerificationAction } from "../src/verification-loop.mjs";

test("verification loop runs the cheapest missing required step first",()=>{
  const plan={steps:[{id:"integration",kind:"integration",cost:"high",required:true},{id:"diagnostics",kind:"diagnostics",cost:"low",required:true},{id:"tests",kind:"tests",cost:"medium",required:true}]};
  const next=nextVerificationAction({plan,evidence:[]});
  assert.equal(next.action,"verify");assert.equal(next.nextStep.id,"diagnostics");assert.deepEqual(next.remainingSteps,["integration","diagnostics","tests"]);
});

test("verification failure sends the same workflow back to repair",()=>{
  const plan={steps:[{id:"diagnostics",kind:"diagnostics",required:true},{id:"tests",kind:"tests",required:true}]};
  const next=nextVerificationAction({plan,evidence:[{stepId:"diagnostics",errorCount:1},{stepId:"tests",exitCode:0}]});
  assert.equal(next.action,"repair");assert.deepEqual(next.failedSteps,["diagnostics"]);assert.equal(next.assessment.repairNeeded,true);
});

test("blocked required verification resolves the blocker before further checks",()=>{
  const plan={steps:[{id:"browser",kind:"browser",required:true},{id:"visual",kind:"visual",required:true,evidence:["screenshot"]}]};
  const next=nextVerificationAction({plan,evidence:[{stepId:"browser",status:"blocked",reason:"Browser unavailable"}]});
  assert.equal(next.action,"resolve_blocker");assert.deepEqual(next.blockedSteps,["browser"]);
});

test("verified plans complete while high-risk review remains advisory",()=>{
  const plan={independentReview:true,steps:[{id:"tests",kind:"tests",required:true}]};
  const next=nextVerificationAction({plan,evidence:[{stepId:"tests",exitCode:0}]});
  assert.equal(next.action,"complete");assert.equal(next.assessment.verified,true);assert.equal(next.reviewRecommended,true);
});

test("verification evidence merges repeated step updates without duplicate history slots",()=>{
  const merged=mergeVerificationEvidence([{stepId:"tests",exitCode:1,attempt:1},{stepId:"diagnostics",errorCount:0}],[{stepId:"tests",exitCode:0,attempt:2}]);
  assert.equal(merged.length,2);assert.deepEqual(merged[0],{stepId:"tests",exitCode:0,attempt:2});assert.equal(merged[1].stepId,"diagnostics");
});
