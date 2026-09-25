import test from "node:test";
import assert from "node:assert/strict";
import { NativeAgentSession, nativeMessagesFromThread } from "../src/native-agent-session.mjs";
import { agentToolLifecycle } from "../src/agent-relay.mjs";
const IMAGE_DATA_URL="data:image/png;base64,iVBORw0KGgo=";

test("Native session implements the relay start/prompt contract with usage updates",async()=>{
  const updates=[];
  const session=new NativeAgentSession({
    cwd:"/repo",provider:"agentrouter",model:"gpt-test",onUpdate:update=>updates.push(update),
    providerTurn:async request=>{assert.equal(request.provider,"agentrouter");assert.equal(request.messages.at(-1).content,"hello");return{id:"resp-1",provider:"agentrouter",model:"gpt-test",text:"hi",toolCalls:[],usage:{inputTokens:4,outputTokens:2,totalTokens:6,cachedInputTokens:1,cacheWriteInputTokens:0}}},
    executeTool:async()=>{throw new Error("not used")},
  });
  const started=await session.start({model:"gpt-test"});assert.match(started.session.sessionId,/^native_/);assert.equal(started.session.models.currentModelId,"gpt-test");
  const result=await session.prompt([{type:"text",text:"hello"}],{messageId:"user-1"});
  assert.equal(result.stopReason,"end_turn");assert.equal(result.providerMessageId,"resp-1");
  const message=updates.find(item=>item.update.sessionUpdate==="agent_message_chunk");assert.equal(message.update.content.text,"hi");
  const usage=updates.find(item=>item.update.sessionUpdate==="usage_update");assert.equal(usage.update.used,6);assert.equal(usage.update.usage.cache_read_input_tokens,1);
});

test("Native session reports namespaced tool lifecycle and keeps observations in provider history",async()=>{
  const updates=[],requests=[];let turn=0;
  const session=new NativeAgentSession({
    provider:"fixture",model:"model",tools:[{type:"namespace",name:"trebell_repo",tools:[]}],onUpdate:update=>updates.push(update),
    providerTurn:async request=>{requests.push(structuredClone(request));turn++;return turn===1
      ?{id:"r1",text:"",toolCalls:[{id:"call-1",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Session"}'}],usage:{}}
      :{id:"r2",text:"done",toolCalls:[],usage:{}}},
    executeTool:async call=>({query:call.arguments.query,data:[{path:"src/session.js"}]}),
  });
  await session.start({model:"model"});await session.prompt([{type:"text",text:"find Session"}]);
  const lifecycle=updates.filter(item=>["tool_call","tool_call_update"].includes(item.update.sessionUpdate));assert.equal(lifecycle.length,2);
  assert.equal(lifecycle[0].update.namespace,"trebell_repo");assert.equal(lifecycle[0].update.tool,"search_symbols");assert.equal(lifecycle[1].update.status,"completed");
  const providerObservation=requests[1].messages.at(-1);assert.equal(providerObservation.role,"tool");assert.match(providerObservation.content,/src\/session\.js/);
  const persisted=agentToolLifecycle(lifecycle[1].update).item;assert.equal(persisted.type,"dynamicToolCall");assert.equal(persisted.namespace,"trebell_repo");assert.equal(persisted.tool,"search_symbols");
});

test("Native persisted thread evidence reconstructs model and tool history after restart",()=>{
  const thread={turns:[{items:[
    {type:"userMessage",id:"u1",content:[{type:"text",text:"find Session"}]},
    {type:"dynamicToolCall",id:"call-1",namespace:"trebell_repo",tool:"search_symbols",arguments:{query:"Session"},status:"completed",rawOutput:{data:[{path:"src/session.js"}]}},
    {type:"agentMessage",id:"a1",text:"Found Session."},
  ]}]};
  const messages=nativeMessagesFromThread(thread);assert.deepEqual(messages.map(item=>item.role),["user","assistant","tool","assistant"]);
  assert.equal(messages[1].toolCalls[0].namespace,"trebell_repo");assert.match(messages[2].content,/session\.js/);assert.equal(messages[3].content,"Found Session.");
});

test("Native persisted tool content reconstructs image observations when available",()=>{
  const thread={turns:[{items:[
    {type:"dynamicToolCall",id:"shot-1",namespace:"trebell_browser",tool:"screenshot",arguments:{},status:"completed",contentItems:[{type:"inputText",text:"screen metadata"},{type:"inputImage",imageUrl:IMAGE_DATA_URL}],success:true},
  ]}]};
  const messages=nativeMessagesFromThread(thread);assert.equal(messages.length,2);assert.equal(messages[1].role,"tool");assert.ok(Array.isArray(messages[1].content));assert.equal(messages[1].content[1].type,"image_url");assert.equal(messages[1].content[1].image_url.url,IMAGE_DATA_URL);
});

test("Native session cancellation returns a cancelled stop reason",async()=>{
  const session=new NativeAgentSession({provider:"fixture",model:"model",providerTurn:async request=>{
    await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,200);request.signal?.addEventListener("abort",()=>{clearTimeout(timer);const error=new Error("aborted");error.name="AbortError";reject(error)},{once:true})});
    return{text:"late",toolCalls:[],usage:{}};
  },executeTool:async()=>""});
  await session.start({model:"model"});const pending=session.prompt([{type:"text",text:"wait"}]);setTimeout(()=>session.cancel(),10);
  const result=await pending;assert.equal(result.stopReason,"cancelled");await session.close();
});
