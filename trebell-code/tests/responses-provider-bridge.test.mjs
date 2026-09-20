import test from "node:test";
import assert from "node:assert/strict";

import { responsesRequestToChat, adaptResponsesBody } from "../src/responses-chat-adapter.mjs";
import { startProviderBridge } from "../src/provider-bridge.mjs";

test("Responses request is translated to chat messages and function tools", () => {
  const chat = responsesRequestToChat({
    model:"claude-opus-4-8",
    instructions:"You are a coding agent.",
    input:[
      {type:"message",role:"user",content:[{type:"input_text",text:"Inspect the repo"}]},
      {type:"function_call",call_id:"call_1",namespace:"trebell_browser",name:"open",arguments:"{\"url\":\"https://example.com\"}"},
      {type:"function_call_output",call_id:"call_1",output:"ok"},
    ],
    tools:[{
      type:"namespace",
      name:"trebell_browser",
      tools:[{type:"function",name:"open",description:"Open URL",inputSchema:{type:"object",properties:{url:{type:"string"}},required:["url"]}}],
    }],
    stream:true,
  });

  assert.equal(chat.model,"claude-opus-4-8");
  assert.equal(chat.messages[0].role,"system");
  assert.equal(chat.messages[1].content,"Inspect the repo");
  assert.equal(chat.messages[2].tool_calls[0].function.name,"trebell_browser__open");
  assert.equal(chat.messages[3].role,"tool");
  assert.equal(chat.tools[0].function.name,"trebell_browser__open");
  assert.deepEqual(chat.tools[0].function.parameters.required,["url"]);
  assert.equal(chat.stream,true);
});

test("Chat SSE is translated back into Responses SSE with tool calls", async () => {
  const encoder=new TextEncoder();
  const source=new ReadableStream({
    start(controller){
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"world"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_7","function":{"name":"shell","arguments":"{\"cmd\":\"ls\"}"}}]}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  let forwarded=null;
  const response=await adaptResponsesBody({
    model:"glm-5.3",
    input:[{type:"message",role:"user",content:[{type:"input_text",text:"Hi"}]}],
    stream:true,
  },async(body)=>{
    forwarded=body;
    return new Response(source,{status:200,headers:{"content-type":"text/event-stream"}});
  });

  assert.equal(forwarded.model,"glm-5.3");
  const text=await response.text();
  assert.match(text,/response\.output_text\.delta/);
  assert.match(text,/Hello /);
  assert.match(text,/world/);
  assert.match(text,/response\.output_item\.done/);
  assert.match(text,/"type":"function_call"/);
  assert.match(text,/"call_id":"call_7"/);
  assert.match(text,/response\.completed/);
  assert.match(text,/"total_tokens":14/);
});

test("Provider bridge exposes Responses API while forwarding Chat Completions upstream", async () => {
  const calls=[];
  const providerManager={
    hasKey(provider){return provider==="hcnsec";},
    async models(provider){
      assert.equal(provider,"hcnsec");
      return {models:["glm-5.3"]};
    },
    async forwardChat(provider,body){
      calls.push({provider,body});
      return Response.json({
        choices:[{message:{role:"assistant",content:"bridge-ok"}}],
        usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3},
      });
    },
  };
  const bridge=await startProviderBridge({port:0,providerManager,provider:"hcnsec"});
  try{
    const health=await fetch(bridge.url+"/healthz").then(r=>r.json());
    assert.equal(health.provider,"hcnsec");
    assert.equal(health.ready,true);

    const models=await fetch(bridge.url+"/v1/models").then(r=>r.json());
    assert.deepEqual(models.data.map(x=>x.id),["glm-5.3"]);

    const response=await fetch(bridge.url+"/v1/responses",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({
        model:"glm-5.3",
        input:[{type:"message",role:"user",content:[{type:"input_text",text:"hello"}]}],
        stream:false,
      }),
    });
    assert.equal(response.status,200);
    const json=await response.json();
    assert.equal(json.object,"response");
    assert.equal(json.output[0].content[0].text,"bridge-ok");
    assert.equal(calls.length,1);
    assert.equal(calls[0].provider,"hcnsec");
    assert.equal(calls[0].body.messages[0].content,"hello");
  }finally{
    await bridge.close();
  }
});
