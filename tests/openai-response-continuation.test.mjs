import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiResponseContinuationTracker, openAiContinuationOutputItems } from "../src/openai-response-continuation.mjs";

const body=input=>({model:"gpt-5.6",instructions:"Stable",tools:[{type:"function",name:"trebell_terminal__run",parameters:{type:"object"}}],input,stream:true});

test("OpenAI continuation uses only strict appended input after the prior provider output",()=>{
  const tracker=new OpenAiResponseContinuationTracker(),firstInput=[{type:"message",role:"user",content:[{type:"input_text",text:"Run verifier"}]}],first=tracker.prepare(body(firstInput));
  assert.equal(first.used,false);
  tracker.record("resp-1",first,{model:"gpt-5.6",text:"",toolCalls:[{id:"call-1",namespace:"trebell_terminal",name:"run",arguments:'{"command":"node","args":["verify.mjs"]}'}]});
  const replayedCall=openAiContinuationOutputItems({toolCalls:[{id:"call-1",namespace:"trebell_terminal",name:"run",arguments:'{"command":"node","args":["verify.mjs"]}'}]});
  const toolOutput={type:"function_call_output",call_id:"call-1",output:"failed"},secondFull=body([...firstInput,...replayedCall,toolOutput]),second=tracker.prepare(secondFull,"resp-1");
  assert.equal(second.used,true);assert.equal(second.parentId,"resp-1");assert.deepEqual(second.body.input,[toolOutput]);assert.equal(second.body.previous_response_id,"resp-1");assert.ok(second.savedRequestBytes>0);
});

test("OpenAI continuation records cumulative history after a delta request",()=>{
  const tracker=new OpenAiResponseContinuationTracker(),user={type:"message",role:"user",content:[{type:"input_text",text:"Fix it"}]},first=tracker.prepare(body([user]));
  tracker.record("resp-a",first,{model:"gpt-5.6",text:"Reading",toolCalls:[{id:"read",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/a.mjs"}}]});
  const priorOutput=openAiContinuationOutputItems({text:"Reading",toolCalls:[{id:"read",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/a.mjs"}}]}),tool={type:"function_call_output",call_id:"read",output:"source"},second=tracker.prepare(body([user,...priorOutput,tool]),"resp-a");
  assert.equal(second.used,true);tracker.record("resp-b",second,{model:"gpt-5.6",text:"Done",toolCalls:[]});
  const secondOutput=openAiContinuationOutputItems({text:"Done"}),nextUser={type:"message",role:"user",content:[{type:"input_text",text:"Continue"}]},third=tracker.prepare(body([user,...priorOutput,tool,...secondOutput,nextUser]),"resp-b");
  assert.equal(third.used,true);assert.deepEqual(third.body.input,[nextUser]);
});

test("OpenAI continuation fails closed on rewritten history, missing state, or model change",()=>{
  const tracker=new OpenAiResponseContinuationTracker(),user={type:"message",role:"user",content:[{type:"input_text",text:"Task"}]},first=tracker.prepare(body([user]));
  tracker.record("resp-1",first,{model:"gpt-5.6",text:"Answer",toolCalls:[]});
  const output=openAiContinuationOutputItems({text:"Answer"}),next={type:"message",role:"user",content:[{type:"input_text",text:"Next"}]};
  assert.equal(tracker.prepare(body([{...user,content:[{type:"input_text",text:"Rewritten"}]},...output,next]),"resp-1").used,false);
  assert.equal(tracker.prepare(body([user,...output,next]),"missing").used,false);
  assert.equal(tracker.prepare({...body([user,...output,next]),model:"gpt-6"},"resp-1").used,false);
});

test("OpenAI continuation tracker is bounded and clearable",()=>{
  const tracker=new OpenAiResponseContinuationTracker({maxEntries:2});
  for(let index=1;index<=3;index++){const prep=tracker.prepare(body([{type:"message",role:"user",content:[{type:"input_text",text:String(index)}]}]));tracker.record("resp-"+index,prep,{model:"gpt-5.6",text:"ok"})}
  assert.equal(tracker.entries.size,2);assert.equal(tracker.prepare(body([]),"resp-1").used,false);tracker.clear();assert.equal(tracker.entries.size,0);
});

test("OpenAI continuation expires an aged wire parent while retaining local prefix reuse",()=>{
  let now=1_000;const tracker=new OpenAiResponseContinuationTracker({maxParentAgeMs:1_000,now:()=>now}),token={},userRef={role:"user",content:"Task"},assistantRef={role:"assistant",content:"Done"},nextRef={role:"user",content:"Next"},user={type:"message",role:"user",content:[{type:"input_text",text:"Task"}]},first=tracker.prepare(body([user]),"",{messageRefs:[userRef],identityToken:token});
  tracker.record("resp-stale",first,{model:"gpt-5.6",text:"Done",toolCalls:[]});now=2_001;
  const full=body([user,...openAiContinuationOutputItems({text:"Done"}),{type:"message",role:"user",content:[{type:"input_text",text:"Next"}]}]),prepared=tracker.prepare(full,"resp-stale",{messageRefs:[userRef,assistantRef,nextRef],identityToken:token});
  assert.equal(tracker.preflight("resp-stale",{messageRefs:[userRef,assistantRef,nextRef],identityToken:token,model:"gpt-5.6"}),null);
  assert.equal(prepared.used,false);assert.equal(prepared.parentExpired,true);assert.equal(Object.prototype.hasOwnProperty.call(prepared.body,"previous_response_id"),false);assert.equal(prepared.fastPrefixCount,1);
});

test("OpenAI continuation saved-byte telemetry matches exact full-body serialization",()=>{
  const tracker=new OpenAiResponseContinuationTracker(),firstInput=[{type:"message",role:"user",content:[{type:"input_text",text:"Task"}]}],first=tracker.prepare(body(firstInput));
  tracker.record("resp-1",first,{model:"gpt-5.6",text:"",toolCalls:[{id:"call-1",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/a.mjs"}}]});
  const priorOutput=openAiContinuationOutputItems({toolCalls:[{id:"call-1",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/a.mjs"}}]}),toolOutput={type:"function_call_output",call_id:"call-1",output:"x".repeat(5000)},full=body([...firstInput,...priorOutput,toolOutput]),prepared=tracker.prepare(full,"resp-1");
  const exact=Buffer.byteLength(JSON.stringify(full),"utf8")-Buffer.byteLength(JSON.stringify(prepared.body),"utf8");
  assert.equal(prepared.used,true);assert.equal(prepared.savedRequestBytes,exact);
});

test("OpenAI continuation keeps exact saved-byte accounting for preexisting parent fields",()=>{
  const tracker=new OpenAiResponseContinuationTracker(),user={type:"message",role:"user",content:[{type:"input_text",text:"Task"}]},first=tracker.prepare(body([user]));tracker.record("resp-1",first,{model:"gpt-5.6",text:"Done"});
  const next={...body([user,...openAiContinuationOutputItems({text:"Done"}),{type:"message",role:"user",content:[{type:"input_text",text:"Next"}]}]),previous_response_id:"legacy-parent"},prepared=tracker.prepare(next,"resp-1"),exact=Buffer.byteLength(JSON.stringify(next),"utf8")-Buffer.byteLength(JSON.stringify(prepared.body),"utf8");
  assert.equal(prepared.used,true);assert.equal(prepared.savedRequestBytes,exact);
});

test("OpenAI continuation can reuse prior request fingerprints from stable Native message identity",()=>{
  const fast=new OpenAiResponseContinuationTracker(),slow=new OpenAiResponseContinuationTracker(),token={},userRef={role:"user",content:"Task"},assistantRef={role:"assistant",content:""},toolRef={role:"tool",content:"failed"},firstInput=[{type:"message",role:"user",content:[{type:"input_text",text:"Task"}]}];
  const firstFast=fast.prepare(body(firstInput),"",{messageRefs:[userRef],identityToken:token}),firstSlow=slow.prepare(body(firstInput));
  fast.record("resp-fast",firstFast,{model:"gpt-5.6",text:"",toolCalls:[{id:"call-1",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["verify.mjs"]}}]});
  slow.record("resp-slow",firstSlow,{model:"gpt-5.6",text:"",toolCalls:[{id:"call-1",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["verify.mjs"]}}]});
  const output=openAiContinuationOutputItems({toolCalls:[{id:"call-1",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["verify.mjs"]}}]}),toolOutput={type:"function_call_output",call_id:"call-1",output:"failed"},full=body([...firstInput,...output,toolOutput]);
  const fastPrepared=fast.prepare(full,"resp-fast",{messageRefs:[userRef,assistantRef,toolRef],identityToken:token}),slowPrepared=slow.prepare(full,"resp-slow");
  assert.equal(fastPrepared.fastPrefixCount,firstInput.length);assert.equal(fastPrepared.used,true);assert.deepEqual(fastPrepared.body.input,slowPrepared.body.input);assert.equal(fastPrepared.savedRequestBytes,slowPrepared.savedRequestBytes);assert.deepEqual(fastPrepared.fullInputDigests,slowPrepared.fullInputDigests);
});

test("OpenAI continuation identity acceleration fails back to full fingerprinting across Native turn tokens",()=>{
  const tracker=new OpenAiResponseContinuationTracker(),tokenA={},tokenB={},userRef={role:"user",content:"Task"},firstInput=[{type:"message",role:"user",content:[{type:"input_text",text:"Task"}]}],first=tracker.prepare(body(firstInput),"",{messageRefs:[userRef],identityToken:tokenA});
  tracker.record("resp-1",first,{model:"gpt-5.6",text:"Done"});
  const next=body([...firstInput,...openAiContinuationOutputItems({text:"Done"}),{type:"message",role:"user",content:[{type:"input_text",text:"Next"}]}]),prepared=tracker.prepare(next,"resp-1",{messageRefs:[userRef,{role:"assistant",content:"Done"},{role:"user",content:"Next"}],identityToken:tokenB});
  assert.equal(prepared.fastPrefixCount,0);assert.equal(prepared.used,true);
});

test("OpenAI continuation snapshots Native message refs instead of trusting a later-mutated array",()=>{
  const tracker=new OpenAiResponseContinuationTracker(),token={},userRef={role:"user",content:"Task"},refs=[userRef],firstInput=[{type:"message",role:"user",content:[{type:"input_text",text:"Task"}]}],first=tracker.prepare(body(firstInput),"",{messageRefs:refs,identityToken:token});
  tracker.record("resp-1",first,{model:"gpt-5.6",text:"Done"});
  refs[0]={role:"user",content:"Rewritten"};refs.push({role:"assistant",content:"Done"},{role:"user",content:"Next"});
  const rewritten={type:"message",role:"user",content:[{type:"input_text",text:"Rewritten"}]},next=body([rewritten,...openAiContinuationOutputItems({text:"Done"}),{type:"message",role:"user",content:[{type:"input_text",text:"Next"}]}]),prepared=tracker.prepare(next,"resp-1",{messageRefs:refs,identityToken:token});
  assert.equal(prepared.fastPrefixCount,0);assert.equal(prepared.used,false,"snapshot proof must reject an in-place replacement of an old canonical message reference");
});

test("OpenAI continuation can prove a provider-input suffix without rebuilding the old canonical prefix",()=>{
  const fast=new OpenAiResponseContinuationTracker(),slow=new OpenAiResponseContinuationTracker(),token={},userRef={role:"user",content:"Task"},assistantRef={role:"assistant",content:"",toolCalls:[]},toolRef={role:"tool",toolCallId:"call-1",content:"failed"},userItem={type:"message",role:"user",content:[{type:"input_text",text:"Task"}]},firstFast=fast.prepare(body([userItem]),"",{messageRefs:[userRef],identityToken:token}),firstSlow=slow.prepare(body([userItem]));
  const turn={model:"gpt-5.6",text:"",toolCalls:[{id:"call-1",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["verify.mjs"]}}]};
  fast.record("resp-fast",firstFast,turn);slow.record("resp-slow",firstSlow,turn);
  const replay=openAiContinuationOutputItems(turn),toolOutput={type:"function_call_output",call_id:"call-1",output:"failed"},refs=[userRef,assistantRef,toolRef],full=body([userItem,...replay,toolOutput]),suffix=body([...replay,toolOutput]),proof=fast.preflight("resp-fast",{messageRefs:refs,identityToken:token,model:"gpt-5.6"});
  assert.equal(proof.messageCount,1);
  const accelerated=fast.prepareSuffix(suffix,"resp-fast",{messageRefs:refs,identityToken:token}),baseline=slow.prepare(full,"resp-slow");
  assert.equal(accelerated.used,true);assert.equal(accelerated.inputBuildReused,true);assert.equal(accelerated.canonicalPrefixMessageCount,1);assert.deepEqual(accelerated.body.input,baseline.body.input);assert.equal(accelerated.savedRequestBytes,baseline.savedRequestBytes);assert.deepEqual(accelerated.fullInputDigests,baseline.fullInputDigests);
});

test("OpenAI continuation incremental byte accounting matches full fingerprint reduction",()=>{
  const cached=new OpenAiResponseContinuationTracker(),legacy=new OpenAiResponseContinuationTracker({reuseByteAccounting:false}),token={},userRef={role:"user",content:"Task"},assistantRef={role:"assistant",content:""},toolRef={role:"tool",content:"failed"},firstInput=[{type:"message",role:"user",content:[{type:"input_text",text:"Task "+"x".repeat(2000)}]}],firstCached=cached.prepare(body(firstInput),"",{messageRefs:[userRef],identityToken:token}),firstLegacy=legacy.prepare(body(firstInput),"",{messageRefs:[userRef],identityToken:token}),turn={model:"gpt-5.6",text:"",toolCalls:[{id:"call-1",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["verify.mjs"]}}]};
  cached.record("resp-1",firstCached,turn);legacy.record("resp-1",firstLegacy,turn);
  const replay=openAiContinuationOutputItems(turn),toolOutput={type:"function_call_output",call_id:"call-1",output:"failed "+"y".repeat(5000)},full=body([...firstInput,...replay,toolOutput]),refs=[userRef,assistantRef,toolRef],cachedPrepared=cached.prepare(full,"resp-1",{messageRefs:refs,identityToken:token}),legacyPrepared=legacy.prepare(full,"resp-1",{messageRefs:refs,identityToken:token});
  assert.equal(cachedPrepared.used,true);assert.equal(cachedPrepared.savedRequestBytes,legacyPrepared.savedRequestBytes);assert.deepEqual(cachedPrepared.body,legacyPrepared.body);assert.deepEqual(cachedPrepared.fullInputDigests,legacyPrepared.fullInputDigests);assert.equal(cachedPrepared.fullInputCount,legacyPrepared.fullInputCount);assert.ok(cachedPrepared.requestFingerprintByteSum>firstCached.requestFingerprintByteSum);
});

test("OpenAI continuation suffix proof fails closed when replayed provider output changes",()=>{
  const tracker=new OpenAiResponseContinuationTracker(),token={},userRef={role:"user",content:"Task"},first=tracker.prepare(body([{type:"message",role:"user",content:[{type:"input_text",text:"Task"}]}]),"",{messageRefs:[userRef],identityToken:token}),turn={model:"gpt-5.6",text:"Done",toolCalls:[]};
  tracker.record("resp-1",first,turn);
  const refs=[userRef,{role:"assistant",content:"Changed"},{role:"user",content:"Next"}],changed=[{type:"message",role:"assistant",content:[{type:"output_text",text:"Changed"}]},{type:"message",role:"user",content:[{type:"input_text",text:"Next"}]}];
  assert.ok(tracker.preflight("resp-1",{messageRefs:refs,identityToken:token,model:"gpt-5.6"}));
  assert.equal(tracker.prepareSuffix(body(changed),"resp-1",{messageRefs:refs,identityToken:token}),null);
});
