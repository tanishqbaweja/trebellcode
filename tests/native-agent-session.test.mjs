import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeAgentSession, nativeCompactionMessage, nativeMessagesFromThread } from "../src/native-agent-session.mjs";
import { NativeToolOutputStore } from "../src/native-tool-output-store.mjs";
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
  const providerObservation=requests[1].messages.at(-1);assert.equal(providerObservation.role,"tool");assert.match(providerObservation.content,/untrusted tool data/i);assert.match(providerObservation.content,/src\/session\.js/);
  const persisted=agentToolLifecycle(lifecycle[1].update).item;assert.equal(persisted.type,"dynamicToolCall");assert.equal(persisted.namespace,"trebell_repo");assert.equal(persisted.tool,"search_symbols");assert.doesNotMatch(JSON.stringify(persisted.rawOutput),/untrusted tool data/i);
});

test("Native session keeps large tool output outside hot provider history behind a persistent handle",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-output-session-"));const requests=[],updates=[];
  try{
    const store=new NativeToolOutputStore({directory:root,maxHotBytes:4096});let calls=0;
    const session=new NativeAgentSession({
      model:"model-a",provider:"fixture",tools:[{type:"namespace",name:"trebell_terminal",tools:[]}],toolOutputStore:store,onUpdate:update=>updates.push(update),
      providerTurn:async request=>{requests.push(structuredClone(request));calls++;return calls===1
        ?{id:"tool",text:"",toolCalls:[{id:"big",namespace:"trebell_terminal",name:"run",arguments:'{"command":"test"}'}],usage:{}}
        :{id:"done",text:"done",toolCalls:[],usage:{}}},
      executeTool:async()=>({exitCode:1,stdout:"x".repeat(40_000),stderr:"FAIL important"}),
    });
    await session.start({providerSessionId:"native-output",model:"model-a"});await session.prompt([{type:"text",text:"run"}]);
    const observation=requests[1].messages.at(-1);assert.equal(observation.role,"tool");assert.match(observation.content,/trebell_output\/read/);assert.ok(observation.content.length<20_000);
    const persisted=updates.find(entry=>entry.update?.sessionUpdate==="tool_call_update")?.update?.rawOutput;assert.ok(persisted?._trebell_output?.handle);assert.ok(JSON.stringify(persisted).length<20_000);
    const read=await store.read({handle:persisted._trebell_output.handle,start_line:1,max_chars:48000});assert.match(read.content,/x{1000}/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native session deduplicates only byte-identical repeated hot file observations",async()=>{
  const requests=[],events=[];let providerCalls=0,content="A".repeat(4000);
  const session=new NativeAgentSession({
    model:"model-a",provider:"fixture",tools:[{type:"namespace",name:"trebell_workspace",tools:[]}],onEvent:event=>events.push(event),
    providerTurn:async request=>{
      requests.push(structuredClone(request));providerCalls++;
      if(providerCalls===1)return {id:"read-1",text:"",toolCalls:[{id:"read-a",namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"large.txt"}'}],usage:{}};
      if(providerCalls===2)return {id:"read-2",text:"",toolCalls:[{id:"read-b",namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"large.txt"}'}],usage:{}};
      return {id:"done",text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async()=>({path:"large.txt",size:content.length,content}),
  });
  await session.start({providerSessionId:"native-dedupe",model:"model-a"});await session.prompt([{type:"text",text:"read twice"}]);
  const firstObservation=requests[1].messages.at(-1);assert.equal(firstObservation.role,"tool");assert.match(firstObservation.content,/A{1000}/);
  const repeatedObservation=requests[2].messages.at(-1);assert.equal(repeatedObservation.role,"tool");assert.match(repeatedObservation.content,/byte-identical/i);assert.doesNotMatch(repeatedObservation.content,/A{1000}/);
  const dedupe=events.find(event=>event.name==="native.tool.observation_deduplicated");assert.ok(dedupe);assert.ok(dedupe.data.savedBytes>3000);
});

test("Native session returns full file content again when a repeated read has changed",async()=>{
  const requests=[];let providerCalls=0,reads=0;
  const session=new NativeAgentSession({
    model:"model-a",provider:"fixture",tools:[{type:"namespace",name:"trebell_workspace",tools:[]}],
    providerTurn:async request=>{
      requests.push(structuredClone(request));providerCalls++;
      if(providerCalls===1)return {id:"read-1",text:"",toolCalls:[{id:"read-a",namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"large.txt"}'}],usage:{}};
      if(providerCalls===2)return {id:"read-2",text:"",toolCalls:[{id:"read-b",namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"large.txt"}'}],usage:{}};
      return {id:"done",text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async()=>{reads++;const marker=reads===1?"A":"B";return {path:"large.txt",size:4000,content:marker.repeat(4000)}},
  });
  await session.start({providerSessionId:"native-dedupe-change",model:"model-a"});await session.prompt([{type:"text",text:"read changed file"}]);
  assert.match(requests[1].messages.at(-1).content,/A{1000}/);
  assert.match(requests[2].messages.at(-1).content,/B{1000}/);
  assert.doesNotMatch(requests[2].messages.at(-1).content,/byte-identical/i);
});

test("Native session passes a recipe tool allowlist only to tool calls in that turn",async()=>{
  const contexts=[];let providerCalls=0;
  const session=new NativeAgentSession({
    model:"model-a",provider:"fixture",tools:[{type:"namespace",name:"trebell_repo",tools:[{type:"function",name:"search_symbols",inputSchema:{type:"object",properties:{}}}]}],
    executeTool:async(_call,context)=>{contexts.push(context);return {success:true,contentItems:[{type:"inputText",text:"ok"}]}},
    providerTurn:async()=>{providerCalls++;return providerCalls===1?{id:"tool-turn",provider:"fixture",model:"model-a",text:"",toolCalls:[{id:"call-1",namespace:"trebell_repo",name:"search_symbols",arguments:"{}"}],finishReason:"tool_calls",usage:{}}:{id:"done",provider:"fixture",model:"model-a",text:"done",toolCalls:[],finishReason:"stop",usage:{}}},
  });
  await session.start({providerSessionId:"allowlist-session",model:"model-a"});await session.prompt([{type:"text",text:"search"}],{toolAllowlist:["trebell_repo/search_symbols"]});
  assert.deepEqual(contexts,[{toolAllowlist:["trebell_repo/search_symbols"]}]);await session.close();
});

test("Native persisted thread evidence reconstructs model and tool history after restart",()=>{
  const thread={turns:[{items:[
    {type:"userMessage",id:"u1",content:[{type:"text",text:"find Session"}]},
    {type:"dynamicToolCall",id:"call-1",namespace:"trebell_repo",tool:"search_symbols",arguments:{query:"Session"},status:"completed",rawOutput:{data:[{path:"src/session.js"}]}},
    {type:"agentMessage",id:"a1",text:"Found Session."},
  ]}]};
  const messages=nativeMessagesFromThread(thread);assert.deepEqual(messages.map(item=>item.role),["user","assistant","tool","assistant"]);
  assert.equal(messages[1].toolCalls[0].namespace,"trebell_repo");assert.match(messages[2].content,/untrusted tool data/i);assert.match(messages[2].content,/session\.js/);assert.equal(messages[3].content,"Found Session.");
});

test("Native persisted tool content reconstructs image observations when available",()=>{
  const thread={turns:[{items:[
    {type:"dynamicToolCall",id:"shot-1",namespace:"trebell_browser",tool:"screenshot",arguments:{},status:"completed",contentItems:[{type:"inputText",text:"screen metadata"},{type:"inputImage",imageUrl:IMAGE_DATA_URL}],success:true},
  ]}]};
  const messages=nativeMessagesFromThread(thread);assert.equal(messages.length,2);assert.equal(messages[1].role,"tool");assert.ok(Array.isArray(messages[1].content));assert.match(messages[1].content[0].text,/untrusted tool data/i);assert.equal(messages[1].content[2].type,"image_url");assert.equal(messages[1].content[2].image_url.url,IMAGE_DATA_URL);
});

test("Native compaction replaces old provider context with a bounded continuation brief",async()=>{
  const requests=[];let call=0;
  const session=new NativeAgentSession({
    provider:"fixture",model:"model",initialMessages:[{role:"developer",content:"Always preserve exact paths."},{role:"user",content:"OLD USER REQUEST"},{role:"assistant",content:"OLD ASSISTANT ANSWER"}],
    providerTurn:async request=>{
      requests.push(structuredClone({...request,signal:undefined}));call++;
      if(call===1)return {id:"compact-1",provider:"fixture",model:"model",text:"Goal: preserve the parser fix.\nChanged: src/parser.js.\nNext: run parser tests.",toolCalls:[],usage:{inputTokens:30,outputTokens:12,totalTokens:42}};
      return {id:"after-compact",provider:"fixture",model:"model",text:"continuing",toolCalls:[],usage:{}};
    },executeTool:async()=>"",
  });
  await session.start({model:"model"});const compacted=await session.compact({maxOutputTokens:1024});
  assert.match(compacted.summary,/src\/parser\.js/);assert.equal(compacted.usage.totalTokens,42);assert.equal(session.messages.length,2);assert.equal(session.messages[0].content,"Always preserve exact paths.");assert.equal(session.messages[1].trebellCompaction,true);
  await session.prompt([{type:"text",text:"Continue now"}]);
  const after=requests[1].messages;assert.equal(after.some(message=>String(message.content||"").includes("OLD USER REQUEST")),false);assert.equal(after.some(message=>String(message.content||"").includes("OLD ASSISTANT ANSWER")),false);assert.ok(after.some(message=>message.trebellCompaction&&String(message.content).includes("src/parser.js")));assert.equal(after.at(-1).content,"Continue now");
});

test("Native compaction preserves a recent hot window and deterministic continuity beside the model summary",async()=>{
  const requests=[];let call=0;
  const recent=[{role:"user",content:"RECENT USER exact_identifier"},{role:"assistant",content:"RECENT ANSWER keep this verbatim"}];
  const session=new NativeAgentSession({
    provider:"fixture",model:"model",initialMessages:[
      {role:"system",content:"base"},
      {role:"user",content:"OLD USER"},
      {role:"assistant",content:"OLD ANSWER"},
      ...recent,
    ],
    providerTurn:async request=>{
      requests.push(structuredClone({...request,signal:undefined}));call++;
      if(call===1){
        assert.equal(request.messages.some(message=>String(message.content||"").includes("RECENT USER")),false);
        assert.match(JSON.stringify(request.messages),/Active goal: Preserve auth protocol/);
        return {id:"compact-hot",text:"Model summary omitted the goal on purpose.",toolCalls:[],usage:{inputTokens:20,outputTokens:5,totalTokens:25}};
      }
      return {id:"after-hot",text:"continued",toolCalls:[],usage:{}};
    },executeTool:async()=>"",
  });
  await session.start({model:"model"});
  const result=await session.compact({recentMessages:recent,deterministicContext:"Active goal: Preserve auth protocol\nLatest verification: tests passed"});
  assert.equal(result.retainedRecentMessageCount,2);assert.match(result.summary,/Preserve auth protocol/);
  assert.deepEqual(session.messages.slice(-2),recent);
  await session.prompt([{type:"text",text:"NEXT"}]);
  const after=requests[1].messages;assert.equal(after.some(message=>String(message.content||"").includes("OLD USER")),false);
  assert.ok(after.some(message=>message.trebellCompaction&&String(message.content||"").includes("Preserve auth protocol")));
  assert.ok(after.some(message=>String(message.content||"").includes("RECENT USER exact_identifier")));
  assert.ok(after.some(message=>String(message.content||"").includes("RECENT ANSWER keep this verbatim")));
});

test("Native persisted history can resume strictly after a compaction turn boundary",()=>{
  const thread={turns:[
    {id:"turn-old",items:[{type:"userMessage",content:[{type:"text",text:"old request"}]},{type:"agentMessage",text:"old answer"}]},
    {id:"turn-boundary",items:[{type:"userMessage",content:[{type:"text",text:"boundary request"}]},{type:"agentMessage",text:"boundary answer"}]},
    {id:"turn-new",items:[{type:"userMessage",content:[{type:"text",text:"new request"}]},{type:"agentMessage",text:"new answer"}]},
  ]};
  const after=nativeMessagesFromThread(thread,{afterTurnId:"turn-boundary"});assert.deepEqual(after.map(message=>message.content),["new request","new answer"]);
  const missing=nativeMessagesFromThread(thread,{afterTurnId:"missing-turn"});assert.equal(missing.some(message=>message.content==="old request"),true);
  const compact=nativeCompactionMessage("summary");assert.equal(compact.role,"developer");assert.equal(compact.trebellCompaction,true);
});

test("Native session cancellation returns a cancelled stop reason",async()=>{
  const session=new NativeAgentSession({provider:"fixture",model:"model",providerTurn:async request=>{
    await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,200);request.signal?.addEventListener("abort",()=>{clearTimeout(timer);const error=new Error("aborted");error.name="AbortError";reject(error)},{once:true})});
    return{text:"late",toolCalls:[],usage:{}};
  },executeTool:async()=>""});
  await session.start({model:"model"});const pending=session.prompt([{type:"text",text:"wait"}]);setTimeout(()=>session.cancel(),10);
  const result=await pending;assert.equal(result.stopReason,"cancelled");await session.close();
});

test("Native steering interrupts only the in-flight model request and continues the same turn",async()=>{
  const requests=[];let startedFirst;const firstStarted=new Promise(resolve=>{startedFirst=resolve});let calls=0;
  const session=new NativeAgentSession({provider:"fixture",model:"model",providerTurn:async request=>{
    calls++;requests.push(structuredClone({...request,signal:undefined}));
    if(calls===1){startedFirst();await new Promise((resolve,reject)=>{request.signal.addEventListener("abort",()=>{const error=new Error("aborted");error.name="AbortError";reject(error)},{once:true})});return{text:"never",toolCalls:[],usage:{}}}
    assert.match(JSON.stringify(request.messages.at(-1).content),/Use parser\.ts instead/);return{id:"steered",text:"Switched to parser.ts.",toolCalls:[],usage:{inputTokens:4,outputTokens:2,totalTokens:6}};
  },executeTool:async()=>""});
  await session.start({model:"model"});const pending=session.prompt([{type:"text",text:"Work on auth.ts"}]);await firstStarted;
  const steered=session.steer([{type:"text",text:"Use parser.ts instead"}]);assert.equal(steered.accepted,true);
  const result=await pending;assert.equal(result.stopReason,"end_turn");assert.equal(result.providerMessageId,"steered");assert.equal(calls,2);
  assert.equal(requests[0].messages.at(-1).content,"Work on auth.ts");assert.match(JSON.stringify(requests[1].messages.at(-1).content),/Use parser\.ts instead/);
});

test("Native steering skips remaining old-plan tools without replaying side effects",async()=>{
  const requests=[],executed=[];let session,turn=0;
  session=new NativeAgentSession({provider:"fixture",model:"model",tools:[{type:"namespace",name:"trebell_workspace",tools:[]}],providerTurn:async request=>{
    requests.push(structuredClone({...request,signal:undefined}));turn++;
    if(turn===1)return {id:"old-plan",text:"",toolCalls:[
      {id:"tool-one",namespace:"trebell_workspace",name:"write_file",arguments:'{"path":"one.txt","content":"one"}'},
      {id:"tool-two",namespace:"trebell_workspace",name:"write_file",arguments:'{"path":"two.txt","content":"two"}'},
    ],usage:{}};
    const tail=request.messages.slice(-3);assert.equal(tail[0].role,"tool");assert.equal(tail[0].toolCallId,"tool-one");assert.equal(tail[1].role,"tool");assert.equal(tail[1].toolCallId,"tool-two");assert.match(tail[1].content,/cancelled before execution/i);assert.equal(tail[2].role,"user");assert.match(JSON.stringify(tail[2].content),/Do not create two\.txt/);
    return {id:"redirected",text:"Kept only the first requested change.",toolCalls:[],usage:{}};
  },executeTool:async call=>{executed.push(call.id);if(call.id==="tool-one")session.steer([{type:"text",text:"Do not create two.txt"}]);return {success:true,content:"done"}}});
  await session.start({model:"model"});const result=await session.prompt([{type:"text",text:"Create both files"}]);
  assert.equal(result.stopReason,"end_turn");assert.deepEqual(executed,["tool-one"]);assert.equal(requests.length,2);
});
