import test from "node:test";
import assert from "node:assert/strict";
import { requestTurnVerificationPlan, verificationPlanEvent } from "../ui/src/turn-verification.js";

test("turn verification retries only the checkpoint-link race and returns the persisted plan",async()=>{
  const calls=[],sleeps=[];
  const result=await requestTurnVerificationPlan({
    threadId:"thread-1",turnId:"turn-1",retries:3,
    request:async(path,options)=>{
      calls.push({path,options});
      if(calls.length<3)return {supported:false,reason:"checkpoint_unavailable"};
      return {supported:true,record:{id:"verification-1",turnId:"turn-1",risk:"medium",assessment:{summary:{required:3}}},nextAction:{action:"verify",nextStep:{id:"diagnostics"}},changedPaths:["ui/App.jsx"]};
    },
    sleep:async ms=>sleeps.push(ms),
  });
  assert.equal(calls.length,3);assert.deepEqual(sleeps,[100,200]);
  assert.deepEqual(calls[0].options.body,{threadId:"thread-1",turnId:"turn-1"});
  assert.equal(result.record.id,"verification-1");
  const event=verificationPlanEvent(result,"turn-1");
  assert.equal(event.status,"incomplete");assert.equal(event.title,"Verification planned · medium risk · 3 required checks · next diagnostics");
});

test("a turn whose checks already ran shows the assessment's outcome, not a waiting plan",()=>{
  const plan=(status,summary,nextAction={action:"complete"})=>verificationPlanEvent({record:{id:"verification-2",risk:"low",assessment:{status,summary}},nextAction},"turn-2");
  const verified=plan("verified",{required:2,passed:2,failed:0,blocked:0,missing:0});
  assert.equal(verified.title,"Verified · low risk · 2 required checks passed");assert.equal(verified.status,"done");assert.equal(verified.raw.outcome,"verified");
  assert.equal(plan("verified",{required:0}).title,"Verified · low risk · no required checks");
  const failed=plan("failed",{required:3,passed:2,failed:1,blocked:0,missing:0},{action:"repair",nextStep:{id:"targeted_tests"}});
  assert.equal(failed.title,"Verification failed · low risk · 1 of 3 required checks failed");assert.equal(failed.status,"failed");
  const blocked=plan("blocked",{required:2,passed:1,failed:0,blocked:1,missing:0},{action:"verify",nextStep:{id:"browser_interaction"}});
  assert.equal(blocked.title,"Verification blocked · low risk · 1 of 2 required checks blocked · next browser_interaction");assert.equal(blocked.status,"warning");
  const partial=plan("incomplete",{required:3,passed:1,failed:0,blocked:0,missing:2},{action:"verify",nextStep:{id:"targeted_tests"}});
  assert.equal(partial.title,"Verification planned · low risk · 3 required checks · 1 passed · next targeted_tests");assert.equal(partial.status,"incomplete");
});

test("turn verification stays quiet when no verification record is needed",async()=>{
  const noChanges={supported:true,changedPaths:[],record:null,nextAction:{action:"complete"}};
  assert.equal(verificationPlanEvent(noChanges,"turn-1"),null);
  let calls=0;
  const unsupported=await requestTurnVerificationPlan({threadId:"thread-1",turnId:"turn-1",retries:3,request:async()=>{calls++;return {supported:false,reason:"not_git"}}});
  assert.equal(calls,1);assert.equal(unsupported.reason,"not_git");
});
