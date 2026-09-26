import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeChatTurnResponse,
  normalizeResponsesTurnResponse,
  providerTurnToChat,
  providerTurnToResponses,
} from "../src/provider-turn.mjs";

const tools=[{
  type:"namespace",name:"trebell_repo",description:"Repository intelligence",tools:[
    {type:"function",name:"search_symbols",description:"Search symbols",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false}},
  ],
}];
const IMAGE_DATA_URL="data:image/png;base64,iVBORw0KGgo=";

test("provider turn converts one canonical conversation to Chat Completions without losing namespaced tools",()=>{
  const request=providerTurnToChat({
    model:"glm-5.3",tools,maxOutputTokens:4096,
    messages:[
      {role:"system",content:"You are Trebell Native."},
      {role:"user",content:"Find Session"},
      {role:"assistant",content:"",toolCalls:[{id:"call-1",namespace:"trebell_repo",name:"search_symbols",arguments:{query:"Session"}}]},
      {role:"tool",toolCallId:"call-1",content:"found"},
    ],
  });
  assert.equal(request.model,"glm-5.3");assert.equal(request.max_tokens,4096);assert.equal(request.stream,false);
  assert.equal(request.tools[0].function.name,"trebell_repo__search_symbols");assert.deepEqual(request.tools[0].function.parameters.required,["query"]);
  assert.equal(request.messages[2].tool_calls[0].function.name,"trebell_repo__search_symbols");assert.equal(request.messages[2].tool_calls[0].function.arguments,'{"query":"Session"}');
  assert.equal(request.messages[3].tool_call_id,"call-1");
});

test("provider turn converts the same conversation to Responses while preserving namespace identity",()=>{
  const request=providerTurnToResponses({
    model:"gpt-5.6",tools,maxOutputTokens:8192,
    messages:[
      {role:"system",content:"System guidance"},{role:"developer",content:"Developer guidance"},
      {role:"user",content:"Find Session"},
      {role:"assistant",content:"Checking",toolCalls:[{id:"call-1",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Session"}'}]},
      {role:"tool",toolCallId:"call-1",content:"found"},
    ],
  });
  assert.equal(request.instructions,"System guidance\n\nDeveloper guidance");assert.equal(request.max_output_tokens,8192);assert.equal(request.stream,false);
  assert.equal(request.input[0].type,"message");assert.equal(request.input[0].role,"user");
  assert.equal(request.input[2].type,"function_call");assert.equal(request.input[2].namespace,"trebell_repo");assert.equal(request.input[2].name,"search_symbols");
  assert.equal(request.input[3].type,"function_call_output");assert.equal(request.input[3].call_id,"call-1");
  assert.equal(request.tools[0].name,"trebell_repo");
});

test("provider turns preserve image tool observations for Chat and Responses transports",()=>{
  const messages=[
    {role:"assistant",content:"",toolCalls:[{id:"call-image",namespace:"trebell_browser",name:"screenshot",arguments:"{}"}]},
    {role:"tool",toolCallId:"call-image",content:[{type:"text",text:"screen metadata"},{type:"image_url",image_url:{url:IMAGE_DATA_URL}}]},
  ];
  const chat=providerTurnToChat({model:"vision-chat",messages});
  assert.equal(chat.messages[1].role,"tool");assert.equal(chat.messages[1].content[1].type,"image_url");assert.equal(chat.messages[1].content[1].image_url.url,IMAGE_DATA_URL);
  const responses=providerTurnToResponses({model:"vision-responses",messages});
  const output=responses.input.find(item=>item.type==="function_call_output");assert.ok(Array.isArray(output.output));assert.equal(output.output[1].type,"input_image");assert.equal(output.output[1].image_url,IMAGE_DATA_URL);
});

test("provider turn normalizes Chat Completions text, tool calls, finish reason and usage",()=>{
  const result=normalizeChatTurnResponse({
    id:"chat-1",model:"glm-5.3",choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:"Checking",tool_calls:[{id:"call-7",type:"function",function:{name:"trebell_repo__search_symbols",arguments:'{"query":"Auth"}'}}]}}],
    usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16,prompt_tokens_details:{cached_tokens:3},completion_tokens_details:{reasoning_tokens:2}},
  },"hcnsec");
  assert.equal(result.text,"Checking");assert.equal(result.finishReason,"tool_calls");assert.equal(result.provider,"hcnsec");
  assert.deepEqual(result.toolCalls,[{id:"call-7",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Auth"}'}]);
  assert.deepEqual(result.usage,{inputTokens:12,outputTokens:4,totalTokens:16,cachedInputTokens:3,cacheWriteInputTokens:0,reasoningOutputTokens:2});
});

test("provider turn normalizes Responses text, namespaced calls and usage",()=>{
  const result=normalizeResponsesTurnResponse({
    id:"resp-1",model:"gpt-5.6",status:"completed",output:[
      {type:"message",role:"assistant",content:[{type:"output_text",text:"Checking"}]},
      {type:"function_call",call_id:"call-9",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Auth"}'},
    ],usage:{input_tokens:20,output_tokens:5,total_tokens:25,input_tokens_details:{cached_tokens:8},output_tokens_details:{reasoning_tokens:3}},
  },"agentrouter");
  assert.equal(result.text,"Checking");assert.equal(result.finishReason,"tool_calls");assert.equal(result.provider,"agentrouter");
  assert.deepEqual(result.toolCalls,[{id:"call-9",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Auth"}'}]);
  assert.deepEqual(result.usage,{inputTokens:20,outputTokens:5,totalTokens:25,cachedInputTokens:8,cacheWriteInputTokens:0,reasoningOutputTokens:3});
});
