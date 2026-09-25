import test from "node:test";
import assert from "node:assert/strict";

import {
  adaptAnthropicResponse,
  anthropicMessageToChatCompletion,
  chatToAnthropic,
} from "../src/anthropic-chat-adapter.mjs";
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

test("Anthropic SSE converts to OpenAI chat SSE including tool calls",async()=>{
  const encoder=new TextEncoder();
  const event=(name,data)=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const source=new ReadableStream({start(controller){
    controller.enqueue(encoder.encode(event("message_start",{type:"message_start",message:{model:"claude-opus-4-8",usage:{input_tokens:12}}})));
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
  assert.match(text,/\[DONE\]/);
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
