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
  assert.equal(event.status,"pending");assert.match(event.title,/medium risk/);assert.match(event.title,/3 required checks/);assert.match(event.title,/next diagnostics/);
});

test("turn verification stays quiet when no verification record is needed",async()=>{
  const noChanges={supported:true,changedPaths:[],record:null,nextAction:{action:"complete"}};
  assert.equal(verificationPlanEvent(noChanges,"turn-1"),null);
  let calls=0;
  const unsupported=await requestTurnVerificationPlan({threadId:"thread-1",turnId:"turn-1",retries:3,request:async()=>{calls++;return {supported:false,reason:"not_git"}}});
  assert.equal(calls,1);assert.equal(unsupported.reason,"not_git");
});
