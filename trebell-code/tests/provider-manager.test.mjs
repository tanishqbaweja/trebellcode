import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderManager } from "../src/provider-manager.mjs";

test("provider keys are stored separately and never returned by definitions", () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const env={...process.env,TREBELL_HOME:root};
  const manager=new ProviderManager({env,fetchFn:async()=>new Response("{}")});
  manager.setKey("agentrouter","ar-secret");
  assert.equal(manager.hasKey("agentrouter"),true);
  assert.equal(manager.childEnv("agentrouter",{}).AGENTROUTER_API_KEY,"ar-secret");
  const def=manager.definitions().find(x=>x.id==="agentrouter");
  assert.equal(def.hasKey,true);
  assert.equal("apiKey" in def,false);
  const stored=readFileSync(join(root,"provider-secrets.json"),"utf8");
  assert.match(stored,/ar-secret/);
});

test("previously stored provider keys with wrapping quotes are normalized on read", () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  writeFileSync(join(root,"provider-secrets.json"),JSON.stringify({agentrouter:'"ar-existing-key"'}),"utf8");
  const manager=new ProviderManager({env:{...process.env,TREBELL_HOME:root},fetchFn:async()=>new Response("{}")});
  assert.equal(manager.key("agentrouter"),"ar-existing-key");
  assert.equal(manager.childEnv("agentrouter",{}).AGENTROUTER_API_KEY,"ar-existing-key");
});

test("AgentRouter validates the key and loads its live model catalog", async () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const env={...process.env,TREBELL_HOME:root};
  let seen=null;
  const manager=new ProviderManager({env,fetchFn:async(url,init)=>{
    seen={url,headers:init?.headers};
    return new Response(JSON.stringify({object:"list",data:[
      {id:"gpt-5.5"},
      {id:"claude-opus-4-8"},
      {id:"glm-5.1"},
      {id:"kimi-k2.6"},
    ]}),{status:200});
  }});
  const beforeKey=await manager.models("agentrouter");
  assert.equal(beforeKey.error,"API key required");
  assert.deepEqual(beforeKey.models,[]);
  manager.setKey("agentrouter",'"ar-key"');
  assert.equal(manager.key("agentrouter"),"ar-key");
  const result=await manager.models("agentrouter");
  assert.equal(seen.url,"https://agentrouter.org/v1/models");
  assert.equal(seen.headers.Authorization,"Bearer ar-key");
  assert.equal(seen.headers["Content-Type"],"application/json");
  assert.equal(seen.headers["User-Agent"],"codex_cli_rs/0.149.1");
  assert.equal(seen.headers.originator,"codex_cli_rs");
  assert.equal(seen.headers.version,"0.149.1");
  assert.deepEqual(result.models,["claude-opus-4-8","glm-5.1","gpt-5.5","kimi-k2.6"]);
  assert.equal(result.source,"live");
});

test("AgentRouter chat always uses the required Codex fingerprint", async () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const env={...process.env,TREBELL_HOME:root};
  let seen=null;
  const manager=new ProviderManager({env,fetchFn:async(url,init)=>{
    seen={url,headers:init.headers,body:JSON.parse(init.body)};
    return new Response(JSON.stringify({choices:[{message:{role:"assistant",content:"ok"}}]}),{status:200,headers:{"content-type":"application/json"}});
  }});
  manager.setKey("agentrouter","ar-key");
  const response=await manager.forwardChat("agentrouter",{model:"gpt-5.5",messages:[{role:"user",content:"hello"}],stream:false},{userAgent:"generic-client/1.0"});
  assert.equal(response.status,200);
  assert.equal(seen.url,"https://agentrouter.org/v1/chat/completions");
  assert.equal(seen.headers.Authorization,"Bearer ar-key");
  assert.equal(seen.headers["User-Agent"],"codex_cli_rs/0.149.1");
  assert.equal(seen.headers.originator,"codex_cli_rs");
  assert.equal(seen.headers.version,"0.149.1");
  assert.equal(seen.body.model,"gpt-5.5");
});

test("JustWorker and HCNSec expose only their configured model", async () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const manager=new ProviderManager({env:{...process.env,TREBELL_HOME:root}});
  assert.deepEqual((await manager.models("justworker")).models,["claude-opus-4-8"]);
  assert.deepEqual((await manager.models("hcnsec")).models,["glm-5.3"]);
  manager.setKey("justworker","jw");
  manager.setKey("hcnsec","hc");
  assert.equal((await manager.models("justworker")).error,undefined);
  assert.equal((await manager.models("hcnsec")).error,undefined);
});


test("Vyce AI models are loaded live from /v1/models", async () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const env={...process.env,TREBELL_HOME:root};
  let seen=null;
  const manager=new ProviderManager({env,fetchFn:async(url,init)=>{
    seen={url,authorization:init?.headers?.Authorization};
    return new Response(JSON.stringify({object:"list",data:[
      {id:"claude-sonnet-4-6"},
      {id:"gpt-astra"},
      {id:"deepseek-v4.1"},
      {id:"auto"},
    ]}),{status:200});
  }});
  manager.setKey("vyceai","sk-vyce");
  const result=await manager.models("vyceai");
  assert.equal(seen.url,"https://vyceai.com/v1/models");
  assert.equal(seen.authorization,"Bearer sk-vyce");
  assert.deepEqual(result.models,["auto","claude-sonnet-4-6","deepseek-v4.1","gpt-astra"]);
  assert.equal(result.source,"live");
});

test("Vyce accepts VYCE_API_KEY as an environment alias", () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const manager=new ProviderManager({env:{TREBELL_HOME:root,VYCE_API_KEY:"sk-vyce-alias"},fetchFn:async()=>new Response("{}")});
  assert.equal(manager.key("vyceai"),"sk-vyce-alias");
  assert.equal(manager.childEnv("vyceai",{}).VYCEAI_API_KEY,"sk-vyce-alias");
});

test("provider environment aliases match Trebell root .env names", () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const manager=new ProviderManager({env:{TREBELL_HOME:root,JUST_WORKER_API_KEY:"jw-alias",HNSEC_API_KEY:"hc-alias"},fetchFn:async()=>new Response("{}")});
  assert.equal(manager.key("justworker"),"jw-alias");
  assert.equal(manager.key("hcnsec"),"hc-alias");
  assert.equal(manager.childEnv("justworker",{}).JUSTWORKER_API_KEY,"jw-alias");
  assert.equal(manager.childEnv("hcnsec",{}).HCNSEC_API_KEY,"hc-alias");
});


test("JustWorker uses the documented Anthropic-compatible messages endpoint", async () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const env={...process.env,TREBELL_HOME:root};
  let seen=null;
  const manager=new ProviderManager({env,fetchFn:async(url,init)=>{
    seen={url,headers:init.headers,body:JSON.parse(init.body)};
    return new Response(JSON.stringify({
      id:"msg_jw",
      type:"message",
      role:"assistant",
      model:"claude-opus-4-8",
      content:[{type:"text",text:"justworker-ok"}],
      stop_reason:"end_turn",
      usage:{input_tokens:4,output_tokens:2},
    }),{status:200,headers:{"content-type":"application/json"}});
  }});
  manager.setKey("justworker","jw-key");
  const response=await manager.forwardChat("justworker",{
    model:"claude-opus-4-8",
    messages:[{role:"user",content:"hello"}],
    stream:false,
  });
  const payload=await response.json();
  assert.equal(seen.url,"https://api.justwoker.icu/v1/messages");
  assert.equal(seen.headers["x-api-key"],"jw-key");
  assert.equal(seen.headers["anthropic-version"],"2023-06-01");
  assert.equal(seen.body.messages[0].content[0].text,"hello");
  assert.equal(payload.choices[0].message.content,"justworker-ok");
});

test("HCNSec chat forwarding explicitly requests SSE when Codex streams", async () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const env={...process.env,TREBELL_HOME:root};
  let seen=null;
  const manager=new ProviderManager({env,fetchFn:async(url,init)=>{
    seen={url,headers:init.headers,body:JSON.parse(init.body)};
    return new Response('data: [DONE]\\n\\n',{status:200,headers:{"content-type":"text/event-stream"}});
  }});
  manager.setKey("hcnsec","hc-key");
  const response=await manager.forwardChat("hcnsec",{
    model:"glm-5.3",
    messages:[{role:"user",content:"hello"}],
    stream:true,
  });
  assert.equal(response.status,200);
  assert.equal(seen.url,"https://api.hcnsec.cn/v1/chat/completions");
  assert.equal(seen.headers.Authorization,"Bearer hc-key");
  assert.match(seen.headers.Accept,/text\/event-stream/);
  assert.equal(seen.body.stream,true);
});


test("provider key normalization strips copied Bearer prefix and invisible characters", () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const manager=new ProviderManager({env:{...process.env,TREBELL_HOME:root}});
  manager.setKey("agentrouter","\uFEFFBearer  ar-live-key\u200B");
  assert.equal(manager.key("agentrouter"),"ar-live-key");
  assert.equal(manager.childEnv("agentrouter",{}).AGENTROUTER_API_KEY,"ar-live-key");
});


test("AgentRouter Responses uses the required Codex fingerprint", async () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const env={...process.env,TREBELL_HOME:root};
  let seen=null;
  const manager=new ProviderManager({env,fetchFn:async(url,init)=>{
    seen={url,headers:init.headers,body:JSON.parse(init.body)};
    return new Response(JSON.stringify({id:"resp_1",object:"response",output:[]}),{status:200,headers:{"content-type":"application/json"}});
  }});
  manager.setKey("agentrouter","ar-key");
  const response=await manager.forwardResponses("agentrouter",{
    model:"deepseek-v4-flash",
    input:"hello",
    stream:false,
  });
  assert.equal(response.status,200);
  assert.equal(seen.url,"https://agentrouter.org/v1/responses");
  assert.equal(seen.headers.Authorization,"Bearer ar-key");
  assert.equal(seen.headers["Content-Type"],"application/json");
  assert.equal(seen.headers["User-Agent"],"codex_cli_rs/0.149.1");
  assert.equal(seen.headers.originator,"codex_cli_rs");
  assert.equal(seen.headers.version,"0.149.1");
  assert.equal(seen.body.model,"deepseek-v4-flash");
});

test("normalized AgentRouter turns keep the Responses transport and namespaced tool calls",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));let seen=null;
  const manager=new ProviderManager({env:{...process.env,TREBELL_HOME:root},fetchFn:async(url,init)=>{
    seen={url,headers:init.headers,body:JSON.parse(init.body)};
    return Response.json({
      id:"resp-native",object:"response",model:"gpt-5.6",status:"completed",
      output:[{type:"function_call",call_id:"call-native",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Session"}'}],
      usage:{input_tokens:11,output_tokens:2,total_tokens:13},
    });
  }});
  manager.setKey("agentrouter","ar-native-key");
  const result=await manager.turn("agentrouter",{
    model:"gpt-5.6",messages:[{role:"user",content:"Find Session"}],
    tools:[{type:"namespace",name:"trebell_repo",tools:[{type:"function",name:"search_symbols",description:"Search",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]}}]}],
  });
  assert.equal(seen.url,"https://agentrouter.org/v1/responses");assert.equal(seen.headers.originator,"codex_cli_rs");assert.equal(seen.body.tools[0].name,"trebell_repo");
  assert.deepEqual(result.toolCalls,[{id:"call-native",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Session"}'}]);
  assert.equal(result.usage.totalTokens,13);
});

test("normalized Chat turns flatten namespaces and recover them from tool calls",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));let seen=null;
  const manager=new ProviderManager({env:{...process.env,TREBELL_HOME:root},fetchFn:async(url,init)=>{
    seen={url,body:JSON.parse(init.body)};
    return Response.json({id:"chat-native",model:"glm-5.3",choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:"",tool_calls:[{id:"call-chat",type:"function",function:{name:"trebell_repo__search_symbols",arguments:'{"query":"Session"}'}}]}}],usage:{prompt_tokens:9,completion_tokens:2,total_tokens:11}});
  }});
  manager.setKey("hcnsec","hc-native-key");
  const result=await manager.turn("hcnsec",{
    model:"glm-5.3",messages:[{role:"user",content:"Find Session"}],
    tools:[{type:"namespace",name:"trebell_repo",tools:[{type:"function",name:"search_symbols",description:"Search",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]}}]}],
  });
  assert.equal(seen.url,"https://api.hcnsec.cn/v1/chat/completions");assert.equal(seen.body.tools[0].function.name,"trebell_repo__search_symbols");
  assert.deepEqual(result.toolCalls,[{id:"call-chat",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Session"}'}]);assert.equal(result.finishReason,"tool_calls");
});

test("normalized Anthropic-compatible turns reuse the existing tool adapter",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));let seen=null;
  const manager=new ProviderManager({env:{...process.env,TREBELL_HOME:root},fetchFn:async(url,init)=>{
    seen={url,body:JSON.parse(init.body)};
    return Response.json({id:"msg-native",type:"message",role:"assistant",model:"claude-opus-4-8",content:[{type:"tool_use",id:"toolu-native",name:"trebell_repo__search_symbols",input:{query:"Session"}}],stop_reason:"tool_use",usage:{input_tokens:7,output_tokens:3}});
  }});
  manager.setKey("justworker","jw-native-key");
  const result=await manager.turn("justworker",{
    model:"claude-opus-4-8",messages:[{role:"user",content:"Find Session"}],
    tools:[{type:"namespace",name:"trebell_repo",tools:[{type:"function",name:"search_symbols",description:"Search",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]}}]}],
  });
  assert.equal(seen.url,"https://api.justwoker.icu/v1/messages");assert.equal(seen.body.tools[0].name,"trebell_repo__search_symbols");
  assert.deepEqual(result.toolCalls,[{id:"toolu-native",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Session"}'}]);assert.equal(result.finishReason,"tool_calls");
});
