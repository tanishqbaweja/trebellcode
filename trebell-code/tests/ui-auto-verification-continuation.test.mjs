import test from "node:test";
import assert from "node:assert/strict";
import { automaticVerificationContinuationSupported, maybeStartAutomaticVerificationContinuation } from "../ui/src/auto-verification-continuation.js";

test("automatic verification continuation starts one command or test step per persisted record",async()=>{
  const calls=[],seen=new Set(),rpc={request:async(method,params)=>{calls.push({method,params});return {turn:{id:"verify-turn"}}}},result={record:{id:"verification-1"},nextAction:{action:"verify",nextStep:{id:"tests",kind:"tests"}}};
  assert.equal(automaticVerificationContinuationSupported(result),true);const first=await maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result,seen});assert.equal(first.started,true);assert.equal(first.nextStepId,"tests");assert.deepEqual(calls,[{method:"thread/verification/continue",params:{threadId:"thread-1",recordId:"verification-1",auto:true}}]);
  assert.equal((await maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result,seen})).reason,"already-attempted");assert.equal(calls.length,1);
});

test("automatic verification continuation refuses browser visual integration and review steps",async()=>{
  const rpc={request:async()=>{throw new Error("should not run")}},seen=new Set();
  for(const kind of ["browser","browser-runtime","visual","integration","review","diagnostics"])assert.equal((await maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result:{record:{id:"v-"+kind},nextAction:{action:"verify",nextStep:{id:kind,kind}}},seen})).started,false);
});

test("failed automatic verification continuation remains retryable",async()=>{
  const seen=new Set(),rpc={request:async()=>{throw new Error("temporary verification relay failure")}},result={record:{id:"verification-retry"},nextAction:{action:"verify",nextStep:{id:"build",kind:"command"}}};
  await assert.rejects(maybeStartAutomaticVerificationContinuation({rpc,threadId:"thread-1",result,seen}),/temporary verification relay failure/);assert.equal(seen.size,0);
});
