import test from "node:test";
import assert from "node:assert/strict";
import { startSameThreadVerificationRepair } from "../ui/src/verification-repair.js";

test("verification repair prefers the native harness RPC",async()=>{
  const calls=[],rpc={request:async(method,params)=>{calls.push({method,params});return {turn:{id:"native-turn"}}}};
  const result=await startSameThreadVerificationRepair({rpc,thread:{id:"thread-1",status:{type:"idle"}},fetcher:async()=>{throw new Error("fallback should not run")}});
  assert.equal(result.turn.id,"native-turn");assert.deepEqual(calls.map(item=>item.method),["thread/verification/repair"]);
});

test("verification repair falls back to a normal same-thread turn when the runtime lacks the custom RPC",async()=>{
  const calls=[],rpc={request:async(method,params)=>{
    calls.push({method,params});
    if(method==="thread/verification/repair")throw Object.assign(new Error("Unsupported external-agent RPC method"),{code:-32601});
    if(method==="turn/start")return {turn:{id:"fallback-turn"}};
  }};
  const fetcher=async()=>({ok:true,json:async()=>({record:{id:"verification-1"},nextAction:{action:"repair"},prompt:"Repair the failed verification.",context:"sanitized evidence"})});
  const result=await startSameThreadVerificationRepair({rpc,thread:{id:"thread-1",status:{type:"idle"}},fetcher});
  assert.equal(result.turn.id,"fallback-turn");assert.equal(result.fallback,true);
  assert.equal(calls[1].method,"turn/start");assert.equal(calls[1].params.threadId,"thread-1");assert.equal(calls[1].params.additionalContext["trebell.verification_repair"].value,"sanitized evidence");
});

test("verification repair refuses to overlap an active turn",async()=>{
  await assert.rejects(startSameThreadVerificationRepair({rpc:{request:async()=>({})},thread:{id:"thread-1",status:{type:"active"}}}),/Stop the running turn/i);
});
