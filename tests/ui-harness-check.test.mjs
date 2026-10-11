import test from "node:test";
import assert from "node:assert/strict";
import { harnessCheck, harnessStateText, harnessStateTitle } from "../ui/src/harness-check.js";

const ready={id:"native-default",kind:"native",available:true},missing={id:"codex-default",kind:"codex",available:false};

test("the runtime poll's answer decides the harness state, including a probe that answered nothing",()=>{
  assert.deepEqual(harnessCheck({runtime:{agentRuntimeStatus:ready},status:missing,listLoaded:true}),{state:"ok",error:""});
  assert.deepEqual(harnessCheck({runtime:{agentRuntimeStatus:missing},status:ready,listLoaded:true}),{state:"warn",error:""});
  // The server sends null when its probe threw: that is an answer, and it is not ready.
  assert.deepEqual(harnessCheck({runtime:{agentRuntimeStatus:null},listLoading:true}),{state:"warn",error:""});
});

test("the harness list stands in while the runtime poll has not answered or keeps failing",()=>{
  // App's runtime state starts as {} and stays so while every poll fails.
  assert.deepEqual(harnessCheck({runtime:{},status:ready,listLoaded:true}),{state:"ok",error:""});
  assert.deepEqual(harnessCheck({runtime:{},status:missing,listLoaded:true}),{state:"warn",error:""});
  // A cached list keeps showing its answer while its refresh is out.
  assert.deepEqual(harnessCheck({runtime:{},status:ready,listLoaded:true,listLoading:true}),{state:"ok",error:""});
});

test("with neither answer the state is pending only while the list is loading, then unknown with the list's error",()=>{
  assert.deepEqual(harnessCheck({runtime:{}}),{state:"pending",error:""});
  assert.deepEqual(harnessCheck({runtime:null,listLoading:true}),{state:"pending",error:""});
  assert.deepEqual(harnessCheck({runtime:{},listLoaded:true,listError:"Deliberate failure"}),{state:"unknown",error:"Deliberate failure"});
  // A last known status whose refresh failed is not passed off as current.
  assert.deepEqual(harnessCheck({runtime:{},status:ready,listLoaded:true,listError:"offline"}),{state:"unknown",error:"offline"});
  assert.deepEqual(harnessCheck({runtime:{},status:ready,listLoaded:true,listLoading:true,listError:"offline"}),{state:"pending",error:""});
  // The list answered without this harness: nothing is in flight that this page knows of, so it is unknown, not checking.
  assert.deepEqual(harnessCheck({runtime:{},status:null,listLoaded:true}),{state:"unknown",error:""});
  assert.deepEqual(harnessCheck(),{state:"pending",error:""});
});

test("each state reads as words and a tooltip that says why it is neutral",()=>{
  assert.equal(harnessStateText({state:"ok"}),"ready");
  assert.equal(harnessStateText({state:"warn"}),"not ready");
  assert.equal(harnessStateText({state:"pending"}),"checking…");
  assert.equal(harnessStateText({state:"unknown"}),"unknown");
  assert.equal(harnessStateText(null),"unknown");
  assert.equal(harnessStateTitle({state:"pending"}),"Checking the harness");
  assert.equal(harnessStateTitle({state:"unknown",error:"Deliberate failure"}),"Could not check the harness: Deliberate failure");
  assert.equal(harnessStateTitle({state:"unknown",error:""}),"The harness has not reported its status");
  assert.equal(harnessStateTitle({state:"ok"}),undefined);
  assert.equal(harnessStateTitle({state:"warn"}),undefined);
});
