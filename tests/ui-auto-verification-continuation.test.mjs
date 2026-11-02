import test from "node:test";
import assert from "node:assert/strict";
import { automaticVerificationContinuationSupported, maybeStartAutomaticVerificationContinuation } from "../ui/src/auto-verification-continuation.js";

test("automatic verification continuation starts one command or test step per persisted record",async()=>{
  const calls=[],seen=new Set(),rpc={request:async(method,params)=>{calls.push({method,params});return {turn:{id:"verify-turn"}}}},result={record:{id:"verification-1"},nextAction:{action:"verify",nextStep:{id:"tests",kind:"tests"}}};
  assert.equal(automaticVerificationContinuationSupported(result),true);const first=await maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result,seen});assert.equal(first.started,true);assert.equal(first.nextStepId,"tests");assert.deepEqual(calls,[{method:"thread/verification/continue",params:{threadId:"thread-1",recordId:"verification-1",auto:true}}]);
  assert.equal((await maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result,seen})).reason,"already-attempted");assert.equal(calls.length,1);
});

test("automatic verification continuation starts a focused behavioral step in the same thread",async()=>{
  const calls=[],seen=new Set(),rpc={request:async(method,params)=>{calls.push({method,params});return {turn:{id:"behavior-turn"}}}},result={record:{id:"verification-behavior"},nextAction:{action:"verify",nextStep:{id:"focused_behavior",kind:"behavioral",evidence:["eligible-transition","ineligible-preservation"]}}};
  assert.equal(automaticVerificationContinuationSupported(result),true);
  const started=await maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result,seen});assert.equal(started.started,true);assert.equal(started.nextStepId,"focused_behavior");
  assert.deepEqual(calls,[{method:"thread/verification/continue",params:{threadId:"thread-1",recordId:"verification-behavior",auto:true}}]);
});

test("automatic verification continuation refuses browser visual integration and review steps",async()=>{
  const rpc={request:async()=>{throw new Error("should not run")}},seen=new Set();
  for(const kind of ["browser","browser-runtime","visual","integration","review","diagnostics"])assert.equal((await maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result:{record:{id:"v-"+kind},nextAction:{action:"verify",nextStep:{id:kind,kind}}},seen})).started,false);
});

test("failed automatic verification continuation remains retryable",async()=>{
  const seen=new Set(),rpc={request:async()=>{throw new Error("temporary verification relay failure")}},result={record:{id:"verification-retry"},nextAction:{action:"verify",nextStep:{id:"build",kind:"command"}}};
  await assert.rejects(maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result,seen}),/temporary verification relay failure/);assert.equal(seen.size,0);
});

test("each check turn's reading is a new record, yet one chain checks a step once by itself, and a check the person did not allow stops it",async()=>{
  const calls=[],seen=new Set(),rpc={request:async(method,params)=>{calls.push({method,params});return {turn:{id:"check-"+calls.length}}}};
  const step={id:"focused_behavior",kind:"behavioral"},first={record:{id:"verification:t:user"},nextAction:{action:"verify",nextStep:step}};
  assert.equal((await maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result:first,seen})).started,true);
  // The check turn left the step unchecked: its reading names the chain's first record, so no second check turn starts.
  const reading={record:{id:"verification:t:check-1"},rootRecordId:"verification:t:user",continuation:true,nextAction:{action:"verify",nextStep:step}};
  assert.equal((await maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result:reading,seen})).reason,"already-attempted");
  // The plan's next step still gets its check turn.
  const tests={...reading,nextAction:{action:"verify",nextStep:{id:"project_tests",kind:"tests"}}};
  assert.equal((await maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result:tests,seen})).started,true);
  // A reading that says the check was not allowed asks for nothing.
  const stopped={record:{id:"verification:t:check-2"},rootRecordId:"verification:t:user",stopped:"not-approved",nextAction:{action:"verify",nextStep:{id:"build",kind:"command"}}};
  assert.equal(automaticVerificationContinuationSupported(stopped),false);
  assert.equal((await maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result:stopped,seen})).started,false);
  assert.deepEqual(calls.map(call=>call.params.recordId),["verification:t:user","verification:t:check-1"]);
});
