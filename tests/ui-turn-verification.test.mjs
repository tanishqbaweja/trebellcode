import test from "node:test";
import assert from "node:assert/strict";
import { requestTurnVerificationPlan, verificationPlanEvent, verificationStepWords } from "../ui/src/turn-verification.js";

test("turn verification retries only the checkpoint-link race and returns the persisted plan",async()=>{
  const calls=[],sleeps=[];
  const result=await requestTurnVerificationPlan({
    threadId:"thread-1",turnId:"turn-1",retries:3,
    request:async(path,options)=>{
      calls.push({path,options});
      if(calls.length<3)return {supported:false,reason:"checkpoint_unavailable"};
      return {supported:true,record:{id:"verification-1",turnId:"turn-1",risk:"medium",assessment:{summary:{required:3}}},nextAction:{action:"verify",nextStep:{id:"diagnostics",kind:"diagnostics"}},changedPaths:["ui/App.jsx"]};
    },
    sleep:async ms=>sleeps.push(ms),
  });
  assert.equal(calls.length,3);assert.deepEqual(sleeps,[100,200]);
  assert.deepEqual(calls[0].options.body,{threadId:"thread-1",turnId:"turn-1"});
  assert.equal(result.record.id,"verification-1");
  const event=verificationPlanEvent(result,"turn-1");
  assert.equal(event.status,"incomplete");assert.equal(event.title,"Verification planned · medium risk · 3 required checks · next: one more check");
  // It comes once the turn has ended, and reads on that turn's card as a notice of it after the steps it judged (notice 2).
  assert.equal(event.turnId,"turn-1");assert.equal(event.notice,2);
});

test("a turn whose checks already ran shows the assessment's outcome, not a waiting plan",()=>{
  const plan=(status,summary,nextAction={action:"complete"})=>verificationPlanEvent({record:{id:"verification-2",risk:"low",assessment:{status,summary}},nextAction},"turn-2");
  const verified=plan("verified",{required:2,passed:2,failed:0,blocked:0,missing:0});
  assert.equal(verified.title,"Verified · low risk · 2 required checks passed");assert.equal(verified.status,"done");assert.equal(verified.raw.outcome,"verified");
  assert.equal(plan("verified",{required:0}).title,"Verified · low risk · no required checks");
  const failed=plan("failed",{required:3,passed:2,failed:1,blocked:0,missing:0},{action:"repair",nextStep:{id:"targeted_tests"}});
  assert.equal(failed.title,"Verification failed · low risk · 1 of 3 required checks failed");assert.equal(failed.status,"failed");
  const blocked=plan("blocked",{required:2,passed:1,failed:0,blocked:1,missing:0},{action:"verify",nextStep:{id:"browser_interaction",kind:"browser"}});
  assert.equal(blocked.title,"Verification blocked · low risk · 1 of 2 required checks blocked · next: trying it in a browser");assert.equal(blocked.status,"warning");
  const partial=plan("incomplete",{required:3,passed:1,failed:0,blocked:0,missing:2},{action:"verify",nextStep:{id:"targeted_tests",kind:"tests"}});
  assert.equal(partial.title,"Verification planned · low risk · 3 required checks · 1 passed · next: running the tests");assert.equal(partial.status,"incomplete");
});

test("turn verification stays quiet when no verification record is needed",async()=>{
  const noChanges={supported:true,changedPaths:[],record:null,nextAction:{action:"complete"}};
  assert.equal(verificationPlanEvent(noChanges,"turn-1"),null);
  let calls=0;
  const unsupported=await requestTurnVerificationPlan({threadId:"thread-1",turnId:"turn-1",retries:3,request:async()=>{calls++;return {supported:false,reason:"not_git"}}});
  assert.equal(calls,1);assert.equal(unsupported.reason,"not_git");
});

test("a step reads in plain words for what it checks, never as its id",()=>{
  assert.equal(verificationStepWords({id:"focused_behavior",kind:"behavioral"}),"trying the changed behavior");
  assert.equal(verificationStepWords({id:"project_tests",kind:"tests"}),"running the tests");
  assert.equal(verificationStepWords({id:"typecheck",kind:"command"}),"running a command");
  assert.equal(verificationStepWords({id:"integration",kind:"integration"}),"one more check");assert.equal(verificationStepWords(null),"one more check");
  const behavior=verificationPlanEvent({record:{id:"v",risk:"low",assessment:{status:"incomplete",summary:{required:1,missing:1}}},nextAction:{action:"verify",nextStep:{id:"focused_behavior",kind:"behavioral"}}},"turn-3");
  assert.equal(behavior.title,"Verification planned · low risk · 1 required check · next: trying the changed behavior");assert.doesNotMatch(behavior.title,/focused_behavior/);
});

test("a check turn whose check was not allowed names no next check: its row says checking stopped",()=>{
  const stopped=verificationPlanEvent({stopped:"not-approved",record:{id:"v2",risk:"low",assessment:{status:"incomplete",summary:{required:1,missing:1}}},nextAction:{action:"verify",nextStep:{id:"focused_behavior",kind:"behavioral"}}},"check-turn");
  assert.equal(stopped.title,"Verification planned · low risk · 1 required check · checking stopped");assert.equal(stopped.status,"incomplete");assert.doesNotMatch(stopped.title,/next:/);
});
