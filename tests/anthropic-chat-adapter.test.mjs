import test from "node:test";
import assert from "node:assert/strict";

import {
  adaptAnthropicResponse,
  anthropicMessageToChatCompletion,
  chatToAnthropic,
  createAnthropicMessageProjector,
  providerTurnAnthropicScaffold,
  providerTurnToAnthropic,
} from "../src/anthropic-chat-adapter.mjs";
import { providerTurnToChat } from "../src/provider-turn.mjs";
const IMAGE_DATA_URL="data:image/png;base64,iVBORw0KGgo=";

test("OpenAI chat payload converts to Anthropic messages and tools",()=>{
  const body=chatToAnthropic({
    model:"claude-opus-4-8",
    messages:[
      {role:"system",content:"You are a coding agent."},
      {role:"user",content:"Inspect the repo"},
      {role:"assistant",content:null,tool_calls:[{id:"call_1",type:"function",function:{name:"shell",arguments:'{"cmd":"ls"}'}}]},
      {role:"tool",tool_call_id:"call_1",content:"package.json"},
    ],
    tools:[{type:"function",function:{name:"shell",description:"Run a command",parameters:{type:"object",properties:{cmd:{type:"string"}},required:["cmd"]}}}],
    stream:true,
  });
  assert.equal(body.system,"You are a coding agent.");
  assert.equal(body.messages[0].role,"user");
  assert.equal(body.messages[1].content[0].type,"tool_use");
  assert.equal(body.messages[2].content[0].type,"tool_result");
  assert.equal(body.tools[0].name,"shell");
  assert.equal(body.stream,true);
});

test("Anthropic conversion maps reasoning effort to adaptive thinking and output effort",()=>{
  const body=chatToAnthropic({model:"claude-opus-4-8",reasoning_effort:"high",messages:[{role:"user",content:"Fix the bug"}]});
  assert.deepEqual(body.thinking,{type:"adaptive"});
  assert.deepEqual(body.output_config,{effort:"high"});
  const direct=providerTurnToAnthropic({model:"claude-opus-4-8",reasoningEffort:"high",messages:[{role:"user",content:"Fix the bug"}]});
  assert.deepEqual(direct.thinking,{type:"adaptive"});
  assert.deepEqual(direct.output_config,{effort:"high"});
});

test("Anthropic tool results preserve data-URL images as image blocks",()=>{
  const body=chatToAnthropic({
    model:"claude-opus-4-8",stream:false,
    messages:[
      {role:"assistant",content:null,tool_calls:[{id:"shot-1",type:"function",function:{name:"trebell_browser__screenshot",arguments:"{}"}}]},
      {role:"tool",tool_call_id:"shot-1",content:[{type:"text",text:"screen metadata"},{type:"image_url",image_url:{url:IMAGE_DATA_URL}}]},
    ],
  });
  const result=body.messages[1].content[0];assert.equal(result.type,"tool_result");assert.ok(Array.isArray(result.content));assert.equal(result.content[1].type,"image");assert.equal(result.content[1].source.media_type,"image/png");assert.equal(result.content[1].source.data,"iVBORw0KGgo=");
});

test("direct canonical Anthropic conversion matches the existing Chat adapter exactly",()=>{
  const request={
    model:"claude-opus-4-8",maxOutputTokens:2048,temperature:.2,toolChoice:{namespace:"trebell_repo",name:"search_symbols"},
    messages:[
      {role:"system",content:"Stable system"},{role:"developer",content:[{type:"text",text:"Developer guidance"}]},{role:"user",content:[{type:"text",text:"Inspect"},{type:"input_image",image_url:IMAGE_DATA_URL}]},
      {role:"assistant",content:[{type:"output_text",text:"Checking"}],toolCalls:[{id:"call-1",namespace:"trebell_repo",name:"search_symbols",arguments:{query:"Session"}}]},
      {role:"tool",toolCallId:"call-1",content:[{type:"text",text:"found"},{type:"image_url",image_url:{url:IMAGE_DATA_URL}}]},
    ],
    tools:[{type:"namespace",name:"trebell_repo",description:"Repo",tools:[{name:"search_symbols",description:"Search",inputSchema:{type:"object",properties:{query:{type:"string"},limit:{type:"integer",maximum:Number.MAX_SAFE_INTEGER}},required:["query"],additionalProperties:false}}]}],
  };
  const legacy=providerTurnToChat(request);legacy.stream=true;legacy.stream_options={include_usage:true};
  assert.deepEqual(providerTurnToAnthropic(request,{stream:true}),chatToAnthropic(legacy));
  assert.deepEqual(providerTurnToAnthropic(request,{stream:true,scaffold:providerTurnAnthropicScaffold(request)}),chatToAnthropic(legacy));
});

test("Anthropic message projector preserves exact conversion across append-only Native history",()=>{
  const messages=[{role:"system",content:"System"},{role:"developer",content:"Developer"},{role:"user",content:"Task"}],request={model:"claude-opus-4-8",messages,tools:[]},projector=createAnthropicMessageProjector();
  const first=providerTurnToAnthropic(request,{messageProjector:projector});assert.deepEqual(first,providerTurnToAnthropic(request));
  messages.push({role:"assistant",content:"",toolCalls:[{id:"call-1",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/a.mjs"}}]},{role:"tool",toolCallId:"call-1",content:"data"});
  const second=providerTurnToAnthropic(request,{messageProjector:projector});assert.deepEqual(second,providerTurnToAnthropic(request));assert.equal(second.messages,first.messages);
});

test("Anthropic message projector resets on replaced old messages and fails closed without stable tool-call ids",()=>{
  const projector=createAnthropicMessageProjector(),messages=[{role:"user",content:"Task"},{role:"assistant",content:"first"}],request={model:"claude-opus-4-8",messages,tools:[]};providerTurnToAnthropic(request,{messageProjector:projector});
  messages[1]={role:"assistant",content:"rewritten"};assert.deepEqual(providerTurnToAnthropic(request,{messageProjector:projector}),providerTurnToAnthropic(request));
  messages.push({role:"assistant",content:"",toolCalls:[{namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/a.mjs"}}]});assert.equal(projector(messages),null);
  const fallback=providerTurnToAnthropic(request,{messageProjector:projector}),toolUse=fallback.messages.at(-1).content.find(block=>block?.type==="tool_use");assert.match(toolUse?.id,/^toolu_/);
});

test("Anthropic SSE converts to OpenAI chat SSE including tool calls",async()=>{
  const encoder=new TextEncoder();
  const event=(name,data)=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const source=new ReadableStream({start(controller){
    controller.enqueue(encoder.encode(event("message_start",{type:"message_start",message:{model:"claude-opus-4-8",usage:{input_tokens:12,cache_read_input_tokens:7,cache_creation_input_tokens:3}}})));
    controller.enqueue(encoder.encode(event("content_block_start",{type:"content_block_start",index:0,content_block:{type:"text",text:""}})));
    controller.enqueue(encoder.encode(event("content_block_delta",{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"hello"}})));
    controller.enqueue(encoder.encode(event("content_block_start",{type:"content_block_start",index:1,content_block:{type:"tool_use",id:"toolu_1",name:"shell",input:{}}})));
    controller.enqueue(encoder.encode(event("content_block_delta",{type:"content_block_delta",index:1,delta:{type:"input_json_delta",partial_json:'{"cmd":"ls"}'}})));
    controller.enqueue(encoder.encode(event("message_delta",{type:"message_delta",delta:{stop_reason:"tool_use"},usage:{output_tokens:5}})));
    controller.enqueue(encoder.encode(event("message_stop",{type:"message_stop"})));
    controller.close();
  }});
  const response=await adaptAnthropicResponse(new Response(source,{status:200,headers:{"content-type":"text/event-stream"}}),{stream:true,model:"claude-opus-4-8"});
  const text=await response.text();
  assert.match(text,/"content":"hello"/);
  assert.match(text,/"name":"shell"/);
  assert.ok(text.includes('\\\"cmd\\\":\\\"ls\\\"'));
  assert.match(text,/"finish_reason":"tool_calls"/);
  assert.match(text,/"prompt_tokens":22/);
  assert.match(text,/"cached_tokens":7/);
  assert.match(text,/"cache_write_tokens":3/);
  assert.match(text,/\[DONE\]/);
});

test("Anthropic SSE cancellation propagates to the upstream provider body",async()=>{
  let cancelReason=null;
  const source=new ReadableStream({pull(){},cancel(reason){cancelReason=reason}});
  const response=await adaptAnthropicResponse(new Response(source,{status:200,headers:{"content-type":"text/event-stream"}}),{stream:true,model:"claude-opus-4-8"});
  const reader=response.body.getReader(),pendingRead=reader.read(),reason=new Error("idle timeout");
  await new Promise(resolve=>setImmediate(resolve));
  await reader.cancel(reason);
  await pendingRead;
  assert.equal(cancelReason,reason);
});

test("Anthropic JSON converts to OpenAI chat completion",()=>{
  const result=anthropicMessageToChatCompletion({
    id:"msg_1",
    model:"claude-opus-4-8",
    stop_reason:"end_turn",
    content:[{type:"text",text:"done"}],
    usage:{input_tokens:3,output_tokens:2},
  });
  assert.equal(result.choices[0].message.content,"done");
  assert.equal(result.choices[0].finish_reason,"stop");
  assert.equal(result.usage.total_tokens,5);
});

test("Anthropic cached input usage is retained in normalized prompt accounting",()=>{
  const result=anthropicMessageToChatCompletion({
    id:"msg_cache",model:"claude-test",role:"assistant",content:[{type:"text",text:"ok"}],stop_reason:"end_turn",
    usage:{input_tokens:10,cache_read_input_tokens:7,cache_creation_input_tokens:3,output_tokens:2},
  },"claude-test");
  assert.equal(result.usage.prompt_tokens,20);
  assert.equal(result.usage.completion_tokens,2);
  assert.equal(result.usage.total_tokens,22);
  assert.equal(result.usage.prompt_tokens_details.cached_tokens,7);
  assert.equal(result.usage.prompt_tokens_details.cache_write_tokens,3);
});
