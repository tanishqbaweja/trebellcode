import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configuration from "../src/native-configuration.mjs";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeProviderTurn } from "../src/native-provider-turn.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

// Native's Meta lane streams Meta's Responses. Meta answers a JSON request only once the whole answer is written, under a whole-request
// timeout of 300 s, so a turn whose answer took longer timed out on every attempt (regex-chess and adaptive-rejection-sampler on
// Terminal-Bench 2.0, 2026-10-30). A streamed request gets its headers at once and its events as each output item is written, read with
// an idle timeout instead. The stand-in for api.meta.ai below serves the events recorded live (tests/fixtures/meta-responses-stream.json)
// and answers a JSON request as Meta does: headers and body only when the whole answer is written. No request leaves the machine.

const fixture=JSON.parse(readFileSync(new URL("./fixtures/meta-responses-stream.json",import.meta.url),"utf8"));
const MODEL="muse-spark-1.3-contributor";
const encoder=new TextEncoder();
const frame=({event,data})=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const completedOf=recorded=>recorded.events.find(item=>item.data?.type==="response.completed").data.response;
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(signal.reason);
  const timer=setTimeout(resolve,ms);
  signal?.addEventListener?.("abort",()=>{clearTimeout(timer);reject(signal.reason)},{once:true});
});
const home=()=>mkdtempSync(join(tmpdir(),"trebell-meta-stream-"));
const managerFor=(root,fetchFn,options={})=>new ProviderManager({env:{TREBELL_HOME:root,META_API_KEY:"meta-test-key"},fetchFn,...options});

// One answer of the stand-in. A streamed request gets its headers at once, then the recorded events every gapMs (stallAfter: no more
// bytes after that many events, with the connection held open), then "data: [DONE]". A JSON request gets headers and body together once
// every event would have been written (events x gapMs), as Meta's JSON replies come.
function answer(recorded,{gapMs=0,stallAfter=null,events=null}={}){
  return async({body,signal})=>{
    const list=events||recorded.events;
    if(body.stream!==true){await sleep(list.length*gapMs,signal);return Response.json(completedOf(recorded),{headers:{"x-request-id":"req-meta-test"}})}
    let timer=null,closed=false;
    const stream=new ReadableStream({
      start(controller){
        let index=0;
        const push=()=>{
          if(closed||(stallAfter!=null&&index>=stallAfter))return;
          if(index>=list.length){closed=true;controller.enqueue(encoder.encode("data: [DONE]\n\n"));controller.close();return}
          controller.enqueue(encoder.encode(frame(list[index++])));timer=setTimeout(push,gapMs);
        };
        signal?.addEventListener?.("abort",()=>{if(closed)return;closed=true;clearTimeout(timer);try{controller.error(signal.reason)}catch{}},{once:true});
        push();
      },
      cancel(){closed=true;clearTimeout(timer)},
    });
    return new Response(stream,{status:200,headers:{"content-type":"text/event-stream","x-request-id":"req-meta-test"}});
  };
}
const httpError=({status,headers,body})=>async()=>new Response(JSON.stringify(body),{status,headers});
// The stand-in serves api.meta.ai only, one step per request (the last step repeats).
function metaApi(steps){
  const requests=[];
  return {requests,fetchFn:async(url,init={})=>{
    if(!String(url).startsWith("https://api.meta.ai/v1/"))throw new Error("Unexpected request outside api.meta.ai: "+url);
    const raw=String(init.body||""),body=JSON.parse(raw||"{}");requests.push({url:String(url),headers:{...init.headers},raw,body});
    return steps[Math.min(requests.length-1,steps.length-1)]({body,signal:init.signal});
  }};
}
// The recorded text turn's first events, then the given failure event.
const failingStream=failure=>[...fixture.text.events.slice(0,3),failure];
const nativeRequest=(extra={})=>({
  provider:"meta",model:MODEL,reasoningEffort:"high",maxOutputTokens:65536,parallelToolCalls:true,toolChoice:"auto",
  messages:[{role:"system",content:"You are Trebell Native, a coding agent."},{role:"user",content:fixture.toolCall.prompt}],
  tools:[{type:"namespace",name:"trebell_workspace",description:"Workspace files.",tools:[{type:"function",name:"read_file",description:"Read a file.",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"]}}]}],
  ...extra,
});
const turnShape=result=>({id:result.id,provider:result.provider,model:result.model,text:result.text,toolCalls:result.toolCalls,finishReason:result.finishReason,status:result.status,serviceTier:result.serviceTier,usage:result.usage,reasoningItems:result.reasoningItems,raw:result.raw});
// The loop as the app and the runner run it on Meta: the lane's own transport options, with the idle bound a test can shorten.
const loopProviderTurn=(manager,idleMs)=>request=>manager.turn("meta",{...request,provider:"meta"},{signal:request.signal,...configuration.nativeProviderTurnOptions("meta"),...(idleMs?{streamIdleTimeoutMs:idleMs}:{})});
const loopOptions=(manager,events,idleMs)=>({provider:"meta",model:MODEL,messages:[{role:"user",content:fixture.text.prompt}],tools:[],retryBaseDelayMs:0,maxModelTurns:2,onEvent:event=>events.push(event),providerTurn:loopProviderTurn(manager,idleMs),executeTool:async()=>""});

test("Native's Meta lane streams, with an idle bound, and every other provider keeps its transport options",()=>{
  assert.deepEqual(configuration.nativeProviderTurnOptions("meta"),{promptCaching:false,streamResponses:true,streamIdleTimeoutMs:600_000});
  assert.equal(configuration.NATIVE_META_STREAM_IDLE_TIMEOUT_MS,600_000);
  assert.deepEqual(configuration.nativeProviderTurnOptions("openai"),{promptCaching:false,streamResponses:true});
  assert.deepEqual(configuration.nativeProviderTurnOptions("anthropic"),{promptCaching:true,streamResponses:false});
  for(const provider of ["xai","gemini","agentrouter","justworker","hcnsec","vyceai"])assert.deepEqual(configuration.nativeProviderTurnOptions(provider),{promptCaching:false,streamResponses:false},provider);
  // The runner records the configuration's hash: the Meta lane's options are part of it.
  assert.deepEqual(configuration.nativeConfigurationSnapshot().providerTurnOptions,{openai:{promptCaching:false,streamResponses:true},anthropic:{promptCaching:true,streamResponses:false},meta:{promptCaching:false,streamResponses:true,streamIdleTimeoutMs:600_000}});
});

test("a Native turn on Meta is sent as the JSON request with stream:true only, and the streamed answer reads as the JSON answer",async()=>{
  const root=home();
  try{
    const json=metaApi([answer(fixture.toolCall)]),streamed=metaApi([answer(fixture.toolCall)]);
    const plain=await managerFor(root,json.fetchFn).turn("meta",nativeRequest());
    const native=await nativeProviderTurn(managerFor(root,streamed.fetchFn),nativeRequest());
    const [sentJson]=json.requests,[sentStream]=streamed.requests;
    assert.equal(sentJson.body.stream,false);assert.equal(sentStream.body.stream,true);
    assert.equal(sentJson.raw.split('"stream":false').length,2,"one stream flag in the JSON request");
    assert.equal(sentStream.raw,sentJson.raw.replace('"stream":false','"stream":true'),"the request body is the JSON one byte for byte but for its stream flag");
    assert.equal(sentStream.url,"https://api.meta.ai/v1/responses");assert.equal(sentStream.headers.Accept,"text/event-stream, application/json");assert.equal(sentJson.headers.Accept,"application/json");
    assert.deepEqual({...sentStream.headers,Accept:null},{...sentJson.headers,Accept:null});
    // Usage, tool calls, text and the reasoning to send back come from the stream's final event as from the JSON body.
    assert.deepEqual(turnShape(native),turnShape(plain));
    assert.deepEqual(native.usage,{inputTokens:640,outputTokens:108,totalTokens:748,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:29});
    assert.deepEqual(native.toolCalls,[{id:fixture.toolCall.events.find(item=>item.data?.item?.type==="function_call").data.item.call_id,namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"README.md"}'}]);
    assert.equal(native.reasoningItems?.length,1);
    assert.equal(native.telemetry.streaming,true);assert.equal(plain.telemetry.streaming,false);
    assert.deepEqual(Object.keys(native.telemetry).sort(),Object.keys(plain.telemetry).sort(),"the same telemetry fields as a JSON turn");
    assert.equal(native.telemetry.endpoint,"https://api.meta.ai/v1/responses");assert.equal(native.telemetry.wireApi,"openai-responses");assert.equal(native.telemetry.providerRequestId,"req-meta-test");
    assert.equal(native.telemetry.requestBytes,Buffer.byteLength(sentStream.raw));assert.ok(native.telemetry.responseBytes>Buffer.byteLength(JSON.stringify(completedOf(fixture.toolCall))));
    assert.equal(typeof native.telemetry.timeToFirstTokenMs,"number");assert.equal(native.telemetry.providerResponseId,completedOf(fixture.toolCall).id);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("a Meta answer that takes longer than the whole-request timeout completes when streamed",async()=>{
  // requestTimeoutMs 300 stands for the 300 s whole-request timeout, the recorded answer spread over about 1 s for one that takes 1,000 s.
  const root=home();
  try{
    const meta=metaApi([answer(fixture.text,{gapMs:90})]),started=Date.now();
    const result=await nativeProviderTurn(managerFor(root,meta.fetchFn,{requestTimeoutMs:300}),nativeRequest({messages:[{role:"user",content:fixture.text.prompt}]}));
    const elapsed=Date.now()-started;
    assert.equal(result.text,"208");assert.equal(result.usage.reasoningOutputTokens,295);assert.equal(result.usage.cachedInputTokens,497);
    assert.ok(elapsed>300,`the turn outlived the whole-request timeout (${elapsed} ms)`);
    assert.equal(result.telemetry.streaming,true);assert.equal(meta.requests.length,1);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("a Meta stream that goes idle is sent again as the loop retries a timed-out request, and the retry's answer ends the turn",async()=>{
  const root=home();
  try{
    // The first answer stops after its reasoning item started, the connection held open; the second is the recorded one.
    const meta=metaApi([answer(fixture.text,{stallAfter:3}),answer(fixture.text)]),events=[];
    const result=await runNativeAgentTurn(loopOptions(managerFor(root,meta.fetchFn,{requestTimeoutMs:5_000}),events,150));
    assert.equal(result.text,"208");assert.equal(meta.requests.length,2);
    assert.ok(meta.requests.every(request=>request.body.stream===true));
    assert.equal(meta.requests[1].raw,meta.requests[0].raw,"the retry sends the same request");
    const retries=events.filter(event=>event.name==="native.model.retrying").map(event=>event.data);
    assert.equal(retries.length,1);assert.match(retries[0].message,/Meta Model API Responses stream idle timeout exceeded/);
    assert.equal(retries[0].providerTelemetry.streaming,true);assert.equal(retries[0].providerTelemetry.providerRequestId,"req-meta-test");
    assert.deepEqual(result.usage,{inputTokens:655,outputTokens:305,totalTokens:960,cachedInputTokens:497,cacheWriteInputTokens:0,reasoningOutputTokens:295},"only the answer that completed is counted");
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("a Meta stream that breaks or ends early is sent again",async()=>{
  const root=home();
  try{
    for(const broken of [
      // The connection drops after three events (undici's "terminated", a socket error under it).
      async({body})=>{let sent=0;const list=fixture.text.events;return new Response(new ReadableStream({pull(controller){if(sent<3){controller.enqueue(encoder.encode(frame(list[sent++])));return}controller.error(Object.assign(new TypeError("terminated"),{cause:Object.assign(new Error("other side closed"),{code:"UND_ERR_SOCKET"})}))}}),{status:200,headers:{"content-type":"text/event-stream"}})},
      // The server closes the stream before the final event.
      answer(fixture.text,{events:fixture.text.events.slice(0,4)}),
    ]){
      const meta=metaApi([broken,answer(fixture.text)]),events=[];
      const result=await runNativeAgentTurn(loopOptions(managerFor(root,meta.fetchFn),events));
      assert.equal(result.text,"208");assert.equal(meta.requests.length,2);assert.ok(meta.requests.every(request=>request.body.stream===true));
      assert.equal(events.filter(event=>event.name==="native.model.retrying").length,1);
    }
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("an error inside a Meta stream retries as Meta documents it: a server error, a shutdown or a rate limit again, any other not",async()=>{
  const root=home();
  try{
    const {responseFailed,streamError,rateLimitedInStream}=fixture.documentedErrors;
    for(const [failure,expected] of [
      [responseFailed,{code:"server_error",rateLimited:false}],
      [streamError,{code:"server_shutting_down",rateLimited:false}],
      // Meta's message names the wait; a short one keeps the test fast.
      [{...rateLimitedInStream,data:{...rateLimitedInStream.data,message:"Rate limit exceeded. Please try again in 20ms."}},{code:"rate_limit_exceeded",rateLimited:true,retryAfterMs:20}],
    ]){
      const meta=metaApi([answer(fixture.text,{events:failingStream(failure)}),answer(fixture.text)]),events=[];
      const result=await runNativeAgentTurn(loopOptions(managerFor(root,meta.fetchFn),events));
      assert.equal(result.text,"208",expected.code);assert.equal(meta.requests.length,2,expected.code);assert.ok(meta.requests.every(request=>request.body.stream===true));
      const [retry]=events.filter(event=>event.name==="native.model.retrying").map(event=>event.data);
      assert.equal(retry.code,expected.code);assert.equal(retry.rateLimited,expected.rateLimited);
      if(expected.retryAfterMs)assert.equal(retry.retryAfterMs,expected.retryAfterMs);
      assert.equal(retry.providerTelemetry.streaming,true);
    }
    // A failure Meta does not call transient ends the turn with its error after one request.
    const refused={event:"response.failed",data:{...responseFailed.data,response:{...responseFailed.data.response,error:{code:"content_policy_violation",message:"The request was refused by the content policy."}}}};
    const meta=metaApi([answer(fixture.text,{events:failingStream(refused)})]);
    await assert.rejects(runNativeAgentTurn(loopOptions(managerFor(root,meta.fetchFn),[])),error=>error.code==="content_policy_violation"&&/refused by the content policy/.test(error.message)&&error.retryable===false&&error.telemetry?.streaming===true);
    assert.equal(meta.requests.length,1);assert.equal(meta.requests[0].body.stream,true);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("a 429 before Meta's stream starts waits as Meta's Retry-After says, and the retry streams",async()=>{
  const root=home();
  try{
    const {rateLimit429}=fixture.documentedErrors;
    const meta=metaApi([httpError({...rateLimit429,headers:{...rateLimit429.headers,"retry-after":"0.02"}}),answer(fixture.text)]),events=[];
    const result=await runNativeAgentTurn(loopOptions(managerFor(root,meta.fetchFn),events));
    assert.equal(result.text,"208");assert.equal(meta.requests.length,2);assert.ok(meta.requests.every(request=>request.body.stream===true));
    const [retry]=events.filter(event=>event.name==="native.model.retrying").map(event=>event.data);
    assert.equal(retry.status,429);assert.equal(retry.rateLimited,true);assert.equal(retry.retryAfterMs,20);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("xAI keeps its JSON request even when a turn asks to stream",async()=>{
  const root=home();
  try{
    const requests=[];
    const manager=new ProviderManager({env:{TREBELL_HOME:root,XAI_API_KEY:"xai-test-key"},fetchFn:async(url,init={})=>{requests.push(JSON.parse(String(init.body)));return Response.json({...completedOf(fixture.text),model:"grok-4.7"})}});
    const result=await manager.turn("xai",{model:"grok-4.7",messages:[{role:"user",content:"hello"}],tools:[]},{streamResponses:true});
    assert.equal(requests[0].stream,false);assert.equal(result.telemetry.streaming,false);assert.equal(result.text,"208");
  }finally{rmSync(root,{recursive:true,force:true})}
});
