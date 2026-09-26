import test from "node:test";
import assert from "node:assert/strict";
import { maybeStartAutomaticVerificationRepair } from "../ui/src/auto-verification-repair.js";

test("automatic verification repair starts exactly once for a failed persisted record",async()=>{
  const calls=[],seen=new Set(),rpc={request:async(method,params)=>{calls.push({method,params});return {turn:{id:"repair-turn"}}}};
  const result={record:{id:"verification-1"},nextAction:{action:"repair"}};
  const first=await maybeStartAutomaticVerificationRepair({rpc,threadId:"thread-1",result,seen});assert.equal(first.started,true);assert.equal(first.turn.id,"repair-turn");assert.deepEqual(calls,[{method:"thread/verification/repair",params:{threadId:"thread-1",recordId:"verification-1",auto:true}}]);
  const duplicate=await maybeStartAutomaticVerificationRepair({rpc,threadId:"thread-1",result,seen});assert.equal(duplicate.started,false);assert.equal(duplicate.reason,"already-attempted");assert.equal(calls.length,1);
});

test("automatic verification repair ignores incomplete or verified plans",async()=>{
  const rpc={request:async()=>{throw new Error("should not run")}},seen=new Set();
  for(const action of ["verify","complete","resolve_blocker",null])assert.equal((await maybeStartAutomaticVerificationRepair({rpc,threadId:"thread-1",result:{record:{id:"v"},nextAction:{action}},seen})).started,false);
});

test("failed automatic repair requests remain retryable",async()=>{
  const seen=new Set(),rpc={request:async()=>{throw new Error("temporary relay failure")}},result={record:{id:"verification-retry"},nextAction:{action:"repair"}};
  await assert.rejects(maybeStartAutomaticVerificationRepair({rpc,threadId:"thread-1",result,seen}),/temporary relay failure/);assert.equal(seen.has("verification-retry"),false);
});
