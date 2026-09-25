import test from "node:test";
import assert from "node:assert/strict";
import { assessVerification } from "../src/verification-assessor.mjs";

test("verification assessment requires every required evidence step",()=>{
  const plan={risk:"medium",steps:[{id:"diagnostics",kind:"diagnostics",required:true},{id:"tests",kind:"tests",required:true}]};
  const result=assessVerification({plan,evidence:[{stepId:"diagnostics",errorCount:0}]});
  assert.equal(result.status,"incomplete");assert.equal(result.summary.passed,1);assert.equal(result.summary.missing,1);assert.equal(result.missing[0].id,"tests");
});

test("command and diagnostic failures deterministically request repair",()=>{
  const plan={risk:"high",independentReview:true,steps:[{id:"diagnostics",kind:"diagnostics",required:true},{id:"build",kind:"command",required:true}]};
  const result=assessVerification({plan,evidence:[{stepId:"diagnostics",errorCount:2},{stepId:"build",exitCode:0}]});
  assert.equal(result.status,"failed");assert.equal(result.repairNeeded,true);assert.equal(result.independentReviewRecommended,true);assert.equal(result.failures[0].id,"diagnostics");
});

test("browser runtime fails on console or network errors",()=>{
  const plan={steps:[{id:"runtime",kind:"browser-runtime",required:true}]};
  const result=assessVerification({plan,evidence:[{stepId:"runtime",consoleErrors:["boom"],networkFailures:[]}]});
  assert.equal(result.status,"failed");assert.match(result.failures[0].reason,/1 console\/network failure/);
});

test("visual verification requires the evidence types requested by the plan",()=>{
  const plan={steps:[{id:"visual",kind:"visual",required:true,evidence:["screenshot","responsive-viewport"]}]};
  const incomplete=assessVerification({plan,evidence:[{stepId:"visual",artifacts:[{type:"screenshot",path:"shot.png"}]}]});
  assert.equal(incomplete.status,"incomplete");assert.match(incomplete.missing[0].reason,/responsive-viewport/);
  const verified=assessVerification({plan,evidence:[{stepId:"visual",artifacts:[{type:"screenshot",path:"shot.png"}],viewports:2}]});
  assert.equal(verified.status,"verified");
});

test("successful mixed evidence produces verified completion",()=>{
  const plan={risk:"high",steps:[{id:"diagnostics",kind:"diagnostics",required:true},{id:"tests",kind:"tests",required:true},{id:"runtime",kind:"browser-runtime",required:true},{id:"interaction",kind:"browser",required:true},{id:"integration",kind:"integration",required:true}]};
  const result=assessVerification({plan,evidence:[{stepId:"diagnostics",errorCount:0},{stepId:"tests",exitCode:0},{stepId:"runtime",consoleErrors:[],networkFailures:[]},{stepId:"interaction",passed:true},{stepId:"integration",status:"passed"}]});
  assert.equal(result.status,"verified");assert.equal(result.verified,true);assert.equal(result.summary.passed,5);assert.equal(result.repairNeeded,false);
});
