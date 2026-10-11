import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { NATIVE_REPLY_STREAM } from "../src/native-agent-session.mjs";
import { NATIVE_CHAT_REPLY_STREAMING, NATIVE_CHAT_REPLY_STREAMING_BLOCKED, nativeStreamOptions } from "../src/native-reply-streaming.mjs";
import { BENCHMARK_PATH_FIXTURE_URL, BENCHMARK_PATH_SCENARIOS, runBenchmarkPathScenario } from "./fixtures/native-benchmark-path-harness.mjs";

const fixture=JSON.parse(await readFile(BENCHMARK_PATH_FIXTURE_URL,"utf8"));
const isDraft=update=>String(update?.update?.sessionUpdate||"").startsWith("agent_message_draft_");

test("only OpenAI and allowlisted chat providers stream a Native reply, and VyceAi and AgentRouter never do",()=>{
  const onStream=()=>{};
  assert.deepEqual(nativeStreamOptions("openai",onStream),{onStream});
  assert.deepEqual(nativeStreamOptions(" OpenAI ",onStream),{onStream});
  for(const provider of ["vyceai","agentrouter","gemini","anthropic","unknown",null])assert.deepEqual(nativeStreamOptions(provider,onStream),{},String(provider));
  for(const provider of ["openai","justworker","hcnsec","vyceai","agentrouter"])assert.deepEqual(nativeStreamOptions(provider,null),{},provider+" without a hook");
  for(const provider of NATIVE_CHAT_REPLY_STREAMING)assert.deepEqual(nativeStreamOptions(provider,onStream),{streamChat:true,onStream},provider);
  for(const provider of ["justworker","hcnsec"])if(!NATIVE_CHAT_REPLY_STREAMING.includes(provider))assert.deepEqual(nativeStreamOptions(provider,onStream),{},provider+" is off until its live check passes");
  assert.deepEqual([...NATIVE_CHAT_REPLY_STREAMING_BLOCKED].sort(),["agentrouter","vyceai"]);
  assert.equal(NATIVE_CHAT_REPLY_STREAMING.some(provider=>NATIVE_CHAT_REPLY_STREAMING_BLOCKED.includes(provider)),false);
  assert.equal(NATIVE_CHAT_REPLY_STREAMING.includes("openai"),false,"OpenAI streams over its Responses lane, not as a chat provider");
});

// The runner's provider path with drafts on, wired as the app wires it: the session puts its hook on the request, the request
// reaches the provider without it, and the hook rides in the turn options. OpenAI must send and record the same as the
// golden record; the only addition is the draft updates.
for(const name of Object.keys(BENCHMARK_PATH_SCENARIOS)){
  test("with Native drafts on, the runner's provider path still matches its golden record: "+name,async()=>{
    const hooked=[];
    const record=await runBenchmarkPathScenario(name,{
      sessionOptions:{streamDrafts:true},
      prepareRequest:request=>{const {[NATIVE_REPLY_STREAM]:_hook,...providerRequest}=request;return providerRequest},
      turnOptions:request=>{hooked.push(typeof request[NATIVE_REPLY_STREAM]==="function");return nativeStreamOptions("openai",request[NATIVE_REPLY_STREAM])},
    });
    const expected=fixture[name],drafts=record.updates.filter(isDraft);
    assert.deepEqual(record.requestOrder,expected.requestOrder);
    assert.deepEqual(record.wsConnections,expected.wsConnections);
    assert.deepEqual(record.wsPayloads,expected.wsPayloads);
    assert.deepEqual(record.fetches,expected.fetches);
    assert.deepEqual(record.responses.map(response=>response.telemetry),expected.responses.map(response=>response.telemetry));
    assert.deepEqual(record.events,expected.events);
    assert.deepEqual({...record,updates:record.updates.filter(update=>!isDraft(update))},expected);
    if(BENCHMARK_PATH_SCENARIOS[name].semanticCompletionGate===true){
      // A gated mutation prompt is never streamed: no request carries a hook and no draft is sent.
      assert.equal(hooked.length>0&&hooked.every(value=>value===false),true);assert.deepEqual(drafts,[]);return;
    }
    assert.ok(hooked.some(Boolean),"the explanation's calls carry the hook");assert.ok(drafts.length>0,"the final answer streams as a draft");
    const final=record.updates.find(update=>update.update?.sessionUpdate==="agent_message_chunk").update.content.text;
    const lastReset=drafts.map(update=>update.update.sessionUpdate).lastIndexOf("agent_message_draft_reset");
    const shown=drafts.slice(lastReset+1);assert.equal(shown.map(update=>update.update.content.text).join(""),final);
    assert.equal(new Set(shown.map(update=>update.update.draftId)).size,1);
    assert.ok(record.updates.indexOf(drafts.at(-1))<record.updates.findIndex(update=>update.update?.sessionUpdate==="agent_message_chunk"),"no draft update after the final reply");
    assert.equal(drafts.some(update=>String(update.update.content?.text||"").includes("I'll read the module")),false,"the commentary preamble is never shown");
    if(name==="websocket_drop_after_text_then_https")assert.ok(lastReset>=0,"the dropped attempt's shown draft is cleared before the retry streams");
  });
}

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
function rpcClient(ws){
  let id=0;const pending=new Map(),notifications=[],waiters=[];
  ws.on("message",raw=>{
    const message=JSON.parse(String(raw));
    if(message.id!=null&&pending.has(message.id)){const target=pending.get(message.id);pending.delete(message.id);message.error?target.reject(new Error(message.error.message)):target.resolve(message.result);return}
    if(message.method){notifications.push(message);for(let index=waiters.length-1;index>=0;index--){const waiter=waiters[index];if(waiter.predicate(message)){waiters.splice(index,1);clearTimeout(waiter.timer);waiter.resolve(message)}}}
  });
  return {
    notifications,
    request(method,params={}){return new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}))})},
    waitFor(predicate,timeoutMs=10000){const found=notifications.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error("Timed out waiting for relay notification"))},timeoutMs)};waiters.push(waiter)})},
  };
}

const GUI_REPLY_CHUNKS=["A Native thread answers with the model it names. ","The thread keeps that model until you pick another one in the composer, and every turn's request goes to it.\n\n","Switching the model changes the next request only; earlier replies stay as they were written."];
const GUI_REPLY=GUI_REPLY_CHUNKS.join("");
function responsesStream(){
  const encoder=new TextEncoder(),item={id:"msg_gui_1",type:"message",role:"assistant",status:"completed",phase:"final_answer",content:[{type:"output_text",text:GUI_REPLY,annotations:[]}]};
  const events=[
    {type:"response.created",response:{id:"resp_gui_1",object:"response",model:"gpt-stream-fixture",status:"in_progress"}},
    {type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",content:[]}},
    ...GUI_REPLY_CHUNKS.map(delta=>({type:"response.output_text.delta",output_index:0,item_id:item.id,content_index:0,delta})),
    {type:"response.output_text.done",output_index:0,item_id:item.id,content_index:0,text:GUI_REPLY},
    {type:"response.output_item.done",output_index:0,item},
    {type:"response.completed",response:{id:"resp_gui_1",object:"response",model:"gpt-stream-fixture",status:"completed",output:[item],usage:{input_tokens:20,output_tokens:40,total_tokens:60}}},
  ];
  return new Response(new ReadableStream({start(controller){for(const event of events)controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));controller.close()}}),{status:200,headers:{"content-type":"text/event-stream","x-request-id":"req_gui_stream"}});
}

test("the GUI server streams a Native OpenAI reply through the relay and sends other providers' requests as before",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-native-reply-gui-")),repo=join(home,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home,OPENAI_API_KEY:"sk-stream-fixture",HCNSEC_API_KEY:"hc-stream-fixture",HNSEC_API_KEY:"",VYCEAI_API_KEY:"vy-stream-fixture",VYCE_API_KEY:"",TREBELL_OPENAI_RESPONSES_WEBSOCKET:"0"};
  const state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",onboardingComplete:true,activeEnvironmentId:null});state.close?.();
  const sent=[];
  const fetchFn=async(input,init={})=>{
    const url=String(input instanceof URL?input.href:input?.url||input);
    if(url.endsWith("/models"))return new Response(JSON.stringify({data:[{id:"gpt-stream-fixture",created:1},{id:"vy-stream-fixture-model",created:1}]}),{status:200,headers:{"content-type":"application/json"}});
    if(url.endsWith("/responses")){sent.push({url,body:JSON.parse(String(init.body))});return responsesStream()}
    if(url.endsWith("/chat/completions")){
      const body=JSON.parse(String(init.body));sent.push({url,body});
      return new Response(JSON.stringify({id:"chat_gui",object:"chat.completion",model:body.model,choices:[{index:0,message:{role:"assistant",content:GUI_REPLY},finish_reason:"stop"}],usage:{prompt_tokens:20,completion_tokens:40,total_tokens:60}}),{status:200,headers:{"content-type":"application/json"}});
    }
    throw new Error("Unexpected external request: "+url);
  };
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:false,env,fetchFn});
  const ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=rpcClient(ws);
  try{
    const run=async(modelProvider,model)=>{
      const thread=(await rpc.request("thread/start",{model,modelProvider,cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
      const turn=(await rpc.request("turn/start",{threadId:thread.id,model,modelProvider,permissionProfile:"auto",input:[{type:"text",text:"Explain how a Native thread picks the model it answers with. Do not change any files."}]})).turn;
      const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(completed.params.turn.status,"completed",modelProvider);
      const item=await rpc.waitFor(message=>message.method==="item/completed"&&message.params?.turnId===turn.id&&message.params?.item?.type==="agentMessage");
      return {deltas:rpc.notifications.filter(message=>message.method==="item/agentMessage/delta"&&message.params?.turnId===turn.id).map(message=>message.params),resets:rpc.notifications.filter(message=>message.method==="item/agentMessage/reset"&&message.params?.turnId===turn.id),text:item.params.item.text};
    };
    const openai=await run("openai","gpt-stream-fixture");
    assert.equal(openai.text,GUI_REPLY);assert.deepEqual(openai.resets,[]);
    assert.ok(openai.deltas.length>=1&&openai.deltas.every(delta=>typeof delta.offset==="number"&&delta.itemId.startsWith("assistant-")),"OpenAI's reply arrives as draft deltas");
    assert.equal(openai.deltas.map(delta=>delta.delta).join(""),GUI_REPLY);
    const responsesBody=sent.find(entry=>entry.url.endsWith("/responses")).body;assert.equal(responsesBody.stream,true);assert.equal(JSON.stringify(responsesBody).includes("reply-stream"),false);
    for(const [provider,model] of [["hcnsec","glm-5.3"],["vyceai","vy-stream-fixture-model"]]){
      const before=sent.length,result=await run(provider,model),bodies=sent.slice(before);
      assert.equal(result.text,GUI_REPLY,provider);assert.deepEqual(result.resets,[],provider);
      assert.deepEqual(result.deltas.map(delta=>Object.keys(delta).sort()),[["delta","threadId","turnId"]],provider+" keeps today's single reply delta");
      assert.ok(bodies.length>=1,provider);for(const {body} of bodies){assert.equal(body.stream,false,provider);assert.equal("stream_options" in body,false,provider)}
    }
  }finally{try{ws.close()}catch{}await gui.close();await rm(home,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
