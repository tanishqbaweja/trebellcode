import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeChatTurnResponse,
  normalizeResponsesTurnResponse,
  providerTurnToChat,
  providerTurnToResponses,
  providerToolsToChat,
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

test("Chat tool schemas omit redundant root closure while preserving runtime-facing schema detail",()=>{
  const schema={
    type:"object",
    properties:{
      line:{type:"integer",minimum:1,maximum:Number.MAX_SAFE_INTEGER},
      options:{type:"object",properties:{mode:{type:"string"}},additionalProperties:false},
    },
    additionalProperties:false,
  };
  const source=[{type:"function",name:"inspect",description:"Inspect",inputSchema:schema}];
  const request=providerTurnToChat({model:"chat-model",tools:source});
  const parameters=request.tools[0].function.parameters;
  assert.equal(parameters.additionalProperties,undefined,"Chat wire schema should not repeat root unknown-field rejection enforced by Trebell");
  assert.equal(parameters.properties.line.maximum,undefined,"implicit JavaScript max-safe bounds should not consume provider wire tokens");
  assert.equal(parameters.properties.options.additionalProperties,false,"nested object closure still guides structured arguments");
  assert.equal(schema.additionalProperties,false,"wire compaction must not mutate Trebell's canonical schema");
  assert.equal(schema.properties.line.maximum,Number.MAX_SAFE_INTEGER);
});

test("Chat conversion can reuse a prepared tool manifest without changing wire JSON or property order",()=>{
  const request={model:"chat-model",tools,messages:[{role:"system",content:"system"},{role:"user",content:"task"}],toolChoice:"auto",parallelToolCalls:true};
  const ordinary=providerTurnToChat(request),prepared=providerTurnToChat(request,{preparedTools:providerToolsToChat(tools)});
  assert.equal(JSON.stringify(prepared),JSON.stringify(ordinary));
});

test("provider turn omits unset output-token and temperature fields instead of coercing null to zero",()=>{
  const chat=providerTurnToChat({model:"chat-model",messages:[{role:"user",content:"hello"}]});
  assert.equal(Object.prototype.hasOwnProperty.call(chat,"max_tokens"),false);
  assert.equal(Object.prototype.hasOwnProperty.call(chat,"temperature"),false);
  const responses=providerTurnToResponses({model:"responses-model",messages:[{role:"user",content:"hello"}]});
  assert.equal(Object.prototype.hasOwnProperty.call(responses,"max_output_tokens"),false);
  assert.equal(Object.prototype.hasOwnProperty.call(responses,"temperature"),false);
});

test("Chat conversion can reuse canonical message conversions without changing the request body",()=>{
  const messages=[{role:"system",content:"stable"},{role:"user",content:[{type:"text",text:"hello"}]},{role:"assistant",content:"",toolCalls:[{id:"c1",namespace:"trebell_repo",name:"search_code",arguments:{query:"Session"}}]},{role:"tool",toolCallId:"c1",content:"result"}],request={model:"chat-model",messages,tools:[]},cache=new WeakMap(),baseline=providerTurnToChat(request),candidate=providerTurnToChat(request,{messageCache:cache});
  assert.deepEqual(candidate,baseline);assert.equal(JSON.stringify(candidate),JSON.stringify(baseline));
  const again=providerTurnToChat(request,{messageCache:cache});assert.deepEqual(again,baseline);
  messages.push({role:"assistant",content:"done"});const grown=providerTurnToChat(request,{messageCache:cache}),grownBaseline=providerTurnToChat(request);assert.deepEqual(grown,grownBaseline);
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

test("Responses can flatten tool names and attach tool-result cache breakpoints during the original conversion",()=>{
  const request=providerTurnToResponses({
    model:"gpt-5.6",
    messages:[
      {role:"assistant",content:"",toolCalls:[{id:"call-1",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Session"}'}]},
      {role:"tool",toolCallId:"call-1",content:[{type:"text",text:"found"},{type:"image_url",image_url:{url:IMAGE_DATA_URL}}]},
    ],
  },{flattenToolCallNames:true,toolResultCacheBreakpoints:true});
  const call=request.input[0],output=request.input[1];
  assert.equal(call.name,"trebell_repo__search_symbols");assert.equal(Object.prototype.hasOwnProperty.call(call,"namespace"),false);
  assert.equal(output.output[0].text,"found");assert.deepEqual(output.output[0].prompt_cache_breakpoint,{mode:"explicit"});assert.equal(output.output[1].type,"input_image");
});

test("Responses can keep only the stable leading instruction block at the prompt prefix",()=>{
  const request=providerTurnToResponses({
    model:"gpt-5.6",
    messages:[
      {role:"system",content:"Stable system guidance"},
      {role:"developer",content:"Stable project guidance"},
      {role:"developer",trebellCompaction:true,content:"Changing continuation brief"},
      {role:"user",content:"Fix the parser"},
      {role:"assistant",content:"Working"},
      {role:"developer",content:"Dynamic finalization guidance"},
    ],
  },{preserveInstructionOrder:true});
  assert.equal(request.instructions,"Stable system guidance\n\nStable project guidance");
  assert.deepEqual(request.input.map(item=>item.role||item.type),["developer","user","assistant","developer"]);
  assert.equal(request.input[0].content[0].text,"Changing continuation brief");
  assert.equal(request.input[3].content[0].text,"Dynamic finalization guidance");
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
