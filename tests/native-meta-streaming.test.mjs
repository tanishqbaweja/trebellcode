import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configuration from "../src/native-configuration.mjs";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeProviderTurn } from "../src/native-provider-turn.mjs";
import { MODEL_PROVIDERS, ProviderManager } from "../src/provider-manager.mjs";

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
// every event would have been written (events x gapMs), as Meta's JSON replies come. holdOpen: the stream stays open after "data: [DONE]".
function answer(recorded,{gapMs=0,stallAfter=null,events=null,holdOpen=false}={}){
  return async({body,signal})=>{
    const list=events||recorded.events;
    if(body.stream!==true){await sleep(list.length*gapMs,signal);return Response.json(completedOf(recorded),{headers:{"x-request-id":"req-meta-test"}})}
    let timer=null,closed=false;
    const stream=new ReadableStream({
      start(controller){
        let index=0;
        const push=()=>{
          if(closed||(stallAfter!=null&&index>=stallAfter))return;
          if(index>=list.length){closed=true;controller.enqueue(encoder.encode("data: [DONE]\n\n"));if(!holdOpen)controller.close();return}
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
  assert.deepEqual(configuration.nativeProviderTurnOptions("meta"),{promptCaching:false,streamResponses:true,streamIdleTimeoutMs:1_800_000});
  assert.equal(configuration.NATIVE_META_STREAM_IDLE_TIMEOUT_MS,1_800_000);
  // The bound outlasts one silent item as long as an action turn's max_output_tokens (65,536) at the slowest output rate seen on the Meta
  // lane (44 tokens a second): about 1,490 s. The settings evidence says so.
  const longestItemMs=Math.ceil(65_536/44)*1000;
  assert.equal(longestItemMs,1_490_000);assert.ok(configuration.NATIVE_META_STREAM_IDLE_TIMEOUT_MS>longestItemMs);
  const evidence=configuration.NATIVE_SETTINGS_EVIDENCE.find(row=>row.setting==="Meta Responses streaming");
  assert.match(evidence.value,/\b1,800 s idle bound\b/);assert.match(evidence.value,/TCP keepalive \(60 s\) and 10 s connect timeout/);
  assert.match(evidence.evidence,/max_output_tokens \(65,536\) at the slowest rate seen \(44 output tokens a second, about 1,490 s/);
  assert.match(evidence.evidence,/only a genuine server stall waits the full bound/);assert.doesNotMatch(evidence.value+evidence.evidence,/\b600 s\b/);
  assert.deepEqual(configuration.nativeProviderTurnOptions("openai"),{promptCaching:false,streamResponses:true});
  assert.deepEqual(configuration.nativeProviderTurnOptions("anthropic"),{promptCaching:true,streamResponses:false});
  for(const provider of ["xai","gemini","agentrouter","justworker","hcnsec","vyceai"])assert.deepEqual(configuration.nativeProviderTurnOptions(provider),{promptCaching:false,streamResponses:false},provider);
  // The runner records the configuration's hash: the Meta lane's options are part of it.
  assert.deepEqual(configuration.nativeConfigurationSnapshot().providerTurnOptions,{openai:{promptCaching:false,streamResponses:true},anthropic:{promptCaching:true,streamResponses:false},meta:{promptCaching:false,streamResponses:true,streamIdleTimeoutMs:1_800_000}});
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

test("a Meta stream held open after its final event ends the turn without waiting out the idle bound or sending it again",async()=>{
  const root=home();
  try{
    const meta=metaApi([answer(fixture.text,{holdOpen:true})]),events=[],started=Date.now();
    const result=await runNativeAgentTurn(loopOptions(managerFor(root,meta.fetchFn),events,60_000));
    const elapsed=Date.now()-started;
    assert.equal(result.text,"208");assert.equal(meta.requests.length,1);assert.equal(events.filter(event=>event.name==="native.model.retrying").length,0);
    assert.ok(elapsed>=4_900&&elapsed<15_000,`let go after the 5 s grace, not the 60 s idle bound (${elapsed} ms)`);
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

test("only Meta's streamed request, the long one, asks its fetch for no timeout of its own (timeout:false, which Bun's fetch reads)",async()=>{
  // On a task image with Bun the runner runs on Bun, whose fetch is then the long request's transport and keeps its own timeout unless
  // the init says timeout:false. Bun is not on this machine: what is checked here is the init every provider's requests are sent with.
  const root=home();
  try{
    const sent=[];
    for(const provider of Object.keys(MODEL_PROVIDERS)){
      const definition=MODEL_PROVIDERS[provider],fetchFn=async(url,init={})=>{sent.push({provider,url:String(url),init});throw Object.assign(new Error("stand-in: no answer"),{retryable:false})};
      const manager=new ProviderManager({env:{TREBELL_HOME:join(root,provider),[definition.envKey]:"test-key-"+provider},fetchFn});
      const request={provider,model:provider==="meta"?MODEL:"test-model",messages:[{role:"user",content:"hello"}],tools:[],maxOutputTokens:65536};
      for(const run of [()=>nativeProviderTurn(manager,request),()=>manager.turn(provider,request)]){
        const before=sent.length;await run().catch(()=>{});assert.ok(sent.length>before,provider+" sent its request");
      }
      manager.close?.();
    }
    const long=sent.filter(item=>Object.hasOwn(item.init,"timeout"));
    assert.equal(long.length,1,"one request asks for no timeout: "+long.map(item=>item.provider).join(", "));
    assert.equal(long[0].provider,"meta");assert.equal(long[0].url,"https://api.meta.ai/v1/responses");assert.equal(long[0].init.timeout,false);
    assert.equal(JSON.parse(long[0].init.body).stream,true);
    assert.deepEqual(sent.filter(item=>item.provider==="meta").map(item=>JSON.parse(item.init.body).stream),[true,false],"Meta's plain JSON request has none");
    assert.ok(sent.some(item=>item.provider==="openai"&&JSON.parse(item.init.body).stream===true),"OpenAI's streamed request has none");
  }finally{rmSync(root,{recursive:true,force:true})}
});

// The recorded text answer's first `count` events, then silenceMs with no byte, then the rest and "data: [DONE]".
const silentAfter=(recorded,count,silenceMs)=>async({signal})=>{
  const list=recorded.events;let timer=null;
  return new Response(new ReadableStream({
    start(controller){
      for(const item of list.slice(0,count))controller.enqueue(encoder.encode(frame(item)));
      timer=setTimeout(()=>{for(const item of list.slice(count))controller.enqueue(encoder.encode(frame(item)));controller.enqueue(encoder.encode("data: [DONE]\n\n"));controller.close()},silenceMs);
      signal?.addEventListener?.("abort",()=>{clearTimeout(timer);try{controller.error(signal.reason)}catch{}},{once:true});
    },
    cancel(){clearTimeout(timer)},
  }),{status:200,headers:{"content-type":"text/event-stream","x-request-id":"req-meta-test"}});
};

test("Meta's stream is read with the lane's idle bound, not the provider's request timeout",async()=>{
  const root=home();
  try{
    // A silence longer than requestTimeoutMs (100 ms) and shorter than the lane's bound (1,000 ms): the answer comes, from one request.
    const quiet=metaApi([silentAfter(fixture.text,3,300)]);
    const result=await managerFor(root,quiet.fetchFn,{requestTimeoutMs:100}).turn("meta",nativeRequest({messages:[{role:"user",content:fixture.text.prompt}]}),{...configuration.nativeProviderTurnOptions("meta"),streamIdleTimeoutMs:1_000});
    assert.equal(result.text,"208");assert.equal(quiet.requests.length,1);
    // A silence longer than the lane's bound (300 ms) and shorter than requestTimeoutMs (5 s): the lane's bound ends it.
    const stalled=metaApi([silentAfter(fixture.text,3,1_500)]),started=Date.now();
    await assert.rejects(managerFor(root,stalled.fetchFn,{requestTimeoutMs:5_000}).turn("meta",nativeRequest({messages:[{role:"user",content:fixture.text.prompt}]}),{...configuration.nativeProviderTurnOptions("meta"),streamIdleTimeoutMs:300}),
      error=>error.name==="TimeoutError"&&/Meta Model API Responses stream idle timeout exceeded/.test(error.message)&&error.retryable===true);
    const elapsed=Date.now()-started;
    assert.ok(elapsed<1_200,`ended at the lane's 300 ms bound, not the silence's end or the request timeout (${elapsed} ms)`);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("a Meta stream whose connection drops after its final event gives that answer, without sending it again",async()=>{
  const root=home();
  try{
    // Every recorded event, response.completed included, then the socket drops before "data: [DONE]" and the close (undici's "terminated").
    const dropped=async()=>{let sent=0;const list=fixture.text.events;return new Response(new ReadableStream({pull(controller){if(sent<list.length){controller.enqueue(encoder.encode(frame(list[sent++])));return}controller.error(Object.assign(new TypeError("terminated"),{cause:Object.assign(new Error("other side closed"),{code:"UND_ERR_SOCKET"})}))}}),{status:200,headers:{"content-type":"text/event-stream","x-request-id":"req-meta-test"}})};
    const meta=metaApi([dropped,answer(fixture.text)]),events=[];
    const result=await runNativeAgentTurn(loopOptions(managerFor(root,meta.fetchFn),events));
    assert.equal(result.text,"208");assert.equal(meta.requests.length,1,"the finished answer is not sent again");
    assert.equal(events.filter(event=>event.name==="native.model.retrying").length,0);
    assert.deepEqual(result.usage,{inputTokens:655,outputTokens:305,totalTokens:960,cachedInputTokens:497,cacheWriteInputTokens:0,reasoningOutputTokens:295});
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("an error inside a Meta stream asks the loop to wait as its message says, else as Meta's docs say, on the rate-limit retries",async()=>{
  const root=home();
  try{
    const inStream=(code,message)=>({event:"error",data:{type:"error",code,message,sequence_number:3}});
    for(const [code,message,expected] of [
      // Meta's documented wording (dev.meta.ai/docs/error-handling), verbatim, and the recorded fixture's.
      ["rate_limit_exceeded","Rate limit exceeded. Please retry after 15 seconds.",{rateLimited:true,retryAfterMs:15_000}],
      ["rate_limit_exceeded",fixture.documentedErrors.rateLimitedInStream.data.message,{rateLimited:true,retryAfterMs:15_000}],
      ["rate_limit_exceeded","Rate limit exceeded. Please try again in 2.5s.",{rateLimited:true,retryAfterMs:2_500}],
      ["rate_limit_exceeded","Rate limit exceeded. Please try again in 750ms.",{rateLimited:true,retryAfterMs:750}],
      ["rate_limit_exceeded","Rate limit exceeded. Please retry after 1 minute.",{rateLimited:true,retryAfterMs:60_000}],
      // No wait named: Meta's documented waits.
      ["rate_limit_exceeded","Rate limit exceeded.",{rateLimited:true,retryAfterMs:15_000}],
      ["service_overloaded","The service is overloaded.",{rateLimited:true,retryAfterMs:60_000}],
      ["backend_unavailable","The backend is unavailable.",{rateLimited:true,retryAfterMs:60_000}],
      // A server error or a shutdown is retried at once, as before.
      ["server_error","The server had an error while processing your request.",{rateLimited:undefined,retryAfterMs:undefined}],
      ["server_shutting_down","The server is shutting down. Retry the request.",{rateLimited:undefined,retryAfterMs:undefined}],
    ]){
      const meta=metaApi([answer(fixture.text,{events:failingStream(inStream(code,message))})]);
      await assert.rejects(managerFor(root,meta.fetchFn).turn("meta",nativeRequest(),configuration.nativeProviderTurnOptions("meta")),error=>{
        assert.equal(error.code,code);assert.equal(error.retryable,true,message);
        assert.equal(error.rateLimited,expected.rateLimited,message);assert.equal(error.retryAfterMs,expected.retryAfterMs,message);return true;
      });
      assert.equal(meta.requests.length,1);
    }
  }finally{rmSync(root,{recursive:true,force:true})}
});
