import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderManager } from "../src/provider-manager.mjs";

const BUNDLED_CODEX_VERSION=JSON.parse(readFileSync(new URL("../node_modules/@openai/codex/package.json",import.meta.url),"utf8")).version;

function abortingFetch(seen) {
  return async (url, init = {}) => {
    seen.push({ url, signal: init.signal });
    return await new Promise((resolve, reject) => {
      const signal = init.signal;
      const aborted = () => reject(signal.reason);
      if (signal?.aborted) return aborted();
      signal?.addEventListener?.("abort", aborted, { once: true });
    });
  };
}

test("provider keys are stored separately and never returned by definitions", () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const env={...process.env,TREBELL_HOME:root};
  const manager=new ProviderManager({env,fetchFn:async()=>new Response("{}")});
  manager.setKey("agentrouter","ar-secret");
  assert.equal(manager.hasKey("agentrouter"),true);
  assert.equal(manager.childEnv("agentrouter",{}).AGENTROUTER_API_KEY,"ar-secret");
  const def=manager.definitions().find(x=>x.id==="agentrouter");
  assert.equal(def.hasKey,true);
  assert.deepEqual(def.protocolCompatibility,["openai-chat-completions"]);
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
  assert.equal(seen.url,"https://co.agentrouter.org/v1/models");
  assert.equal(seen.headers.Authorization,"Bearer ar-key");
  assert.equal(seen.headers["Content-Type"],"application/json");
  assert.equal(seen.headers["User-Agent"],`codex_cli_rs/${BUNDLED_CODEX_VERSION}`);
  assert.equal(seen.headers.originator,"codex_cli_rs");
  assert.equal(seen.headers.version,BUNDLED_CODEX_VERSION);
  assert.deepEqual(result.models,["claude-opus-4-8","glm-5.1","gpt-5.5","kimi-k2.6"]);
  assert.equal(result.source,"live");
  assert.ok(result.metadata.every(model=>model.protocolCompatibility?.[0]==="openai-chat-completions"));
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
  assert.equal(seen.url,"https://co.agentrouter.org/v1/chat/completions");
  assert.equal(seen.headers.Authorization,"Bearer ar-key");
  assert.equal(seen.headers["User-Agent"],`codex_cli_rs/${BUNDLED_CODEX_VERSION}`);
  assert.equal(seen.headers.originator,"codex_cli_rs");
  assert.equal(seen.headers.version,BUNDLED_CODEX_VERSION);
  assert.equal(seen.body.model,"gpt-5.5");
});

test("JustWorker and HCNSec expose only their configured model", async () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const manager=new ProviderManager({env:{...process.env,TREBELL_HOME:root}});
  assert.deepEqual((await manager.models("justworker")).models,["claude-opus-4-8"]);
  assert.deepEqual((await manager.models("hcnsec")).models,["glm-5.3"]);
  assert.deepEqual((await manager.models("justworker")).metadata[0].protocolCompatibility,["anthropic-messages"]);
  assert.deepEqual((await manager.models("hcnsec")).metadata[0].protocolCompatibility,["openai-chat-completions"]);
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

test("official API providers are first-class Trebell Native inference providers without exposing keys", () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const manager=new ProviderManager({env:{TREBELL_HOME:root,OPENAI_API_KEY:"oa-env",ANTHROPIC_API_KEY:"an-env",GOOGLE_API_KEY:"gm-env"}});
  const definitions=manager.definitions();
  for(const id of ["openai","anthropic","gemini"]){
    const provider=definitions.find(item=>item.id===id);
    assert.equal(provider?.official,true);
    assert.equal(provider?.hasKey,true);
    assert.equal("apiKey" in provider,false);
  }
  assert.equal(manager.key("openai"),"oa-env");
  assert.equal(manager.key("anthropic"),"an-env");
  assert.equal(manager.key("gemini"),"gm-env");
  assert.equal(manager.childEnv("gemini",{}).GEMINI_API_KEY,"gm-env");
});

test("official API model catalogs use their documented authentication styles",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const requests=[];
  const manager=new ProviderManager({env:{TREBELL_HOME:root},fetchFn:async(url,init={})=>{
    requests.push({url,headers:init.headers});
    return Response.json({data:[{id:url.includes("anthropic.com")?"claude-opus-5":url.includes("googleapis.com")?"gemini-3.8-flash":"gpt-5.6"}]});
  }});
  manager.setKey("openai","oa-key");manager.setKey("anthropic","an-key");manager.setKey("gemini","gm-key");
  assert.deepEqual((await manager.models("openai")).models,["gpt-5.6"]);
  assert.deepEqual((await manager.models("anthropic")).models,["claude-opus-5"]);
  assert.deepEqual((await manager.models("gemini")).models,["gemini-3.8-flash"]);
  const openai=requests.find(item=>item.url==="https://api.openai.com/v1/models");
  const anthropic=requests.find(item=>item.url==="https://api.anthropic.com/v1/models");
  const gemini=requests.find(item=>item.url==="https://generativelanguage.googleapis.com/v1beta/openai/models");
  assert.equal(openai.headers.Authorization,"Bearer oa-key");
  assert.equal(anthropic.headers["x-api-key"],"an-key");
  assert.equal(anthropic.headers["anthropic-version"],"2023-06-01");
  assert.equal(gemini.headers.Authorization,"Bearer gm-key");
});

test("official OpenAI Anthropic and Gemini turns use their native compatibility endpoints",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const requests=[];
  const manager=new ProviderManager({env:{TREBELL_HOME:root},fetchFn:async(url,init={})=>{
    const body=JSON.parse(init.body||"{}");requests.push({url,headers:init.headers,body});
    if(url.endsWith("/responses"))return Response.json({id:"resp-official",model:body.model,status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"openai-ok"}]}],usage:{input_tokens:3,output_tokens:2,total_tokens:5}});
    if(url.includes("anthropic.com"))return Response.json({id:"msg-official",type:"message",role:"assistant",model:body.model,content:[{type:"text",text:"anthropic-ok"}],stop_reason:"end_turn",usage:{input_tokens:3,output_tokens:2}},{headers:{"content-type":"application/json"}});
    return Response.json({id:"chat-official",model:body.model,choices:[{finish_reason:"stop",message:{role:"assistant",content:"gemini-ok"}}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}});
  }});
  manager.setKey("openai","oa-key");manager.setKey("anthropic","an-key");manager.setKey("gemini","gm-key");
  const common={messages:[{role:"user",content:"hello"}],tools:[],toolChoice:"none"};
  assert.equal((await manager.turn("openai",{...common,model:"gpt-5.6"})).text,"openai-ok");
  assert.equal((await manager.turn("anthropic",{...common,model:"claude-opus-5"})).text,"anthropic-ok");
  assert.equal((await manager.turn("gemini",{...common,model:"gemini-3.8-flash"})).text,"gemini-ok");
  const openai=requests.find(item=>item.url==="https://api.openai.com/v1/responses");
  const anthropic=requests.find(item=>item.url==="https://api.anthropic.com/v1/messages");
  const gemini=requests.find(item=>item.url==="https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(openai.headers.Authorization,"Bearer oa-key");
  assert.equal(anthropic.headers["x-api-key"],"an-key");
  assert.equal(anthropic.headers["anthropic-version"],"2023-06-01");
  assert.equal(gemini.headers.Authorization,"Bearer gm-key");
  assert.equal(anthropic.body.messages[0].content[0].text,"hello");
  assert.equal(gemini.body.messages[0].content,"hello");
});

test("official OpenAI Responses flattens Trebell namespaces into standard function tools and restores them on tool calls",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));let seen=null;
  const manager=new ProviderManager({env:{TREBELL_HOME:root},fetchFn:async(url,init={})=>{
    seen={url,body:JSON.parse(init.body||"{}")};;
    return Response.json({id:"resp-tools",model:"gpt-5.6",status:"completed",output:[{type:"function_call",call_id:"call-1",name:"trebell_repo__search_symbols",arguments:'{"query":"Session"}'}],usage:{input_tokens:5,output_tokens:2,total_tokens:7}});
  }});
  manager.setKey("openai","oa-key");
  const result=await manager.turn("openai",{
    model:"gpt-5.6",messages:[{role:"user",content:"Find Session"}],
    tools:[{type:"namespace",name:"trebell_repo",description:"Repository tools",tools:[{type:"function",name:"search_symbols",description:"Search symbols",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]}}]}],
  });
  assert.equal(seen.url,"https://api.openai.com/v1/responses");
  assert.deepEqual(seen.body.tools,[{type:"function",name:"trebell_repo__search_symbols",description:"Search symbols",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}}]);
  assert.match(seen.body.prompt_cache_key,/^trebell-[a-f0-9]{32}$/);
  assert.deepEqual(result.toolCalls,[{id:"call-1",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Session"}'}]);
});

test("official OpenAI prompt cache key stays stable as later history grows but separates different task prefixes",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-")),bodies=[];
  const manager=new ProviderManager({env:{TREBELL_HOME:root},fetchFn:async(_url,init={})=>{
    const body=JSON.parse(init.body||"{}");bodies.push(body);
    return Response.json({id:"resp-cache",model:body.model,status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"ok"}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
  }});
  manager.setKey("openai","oa-key");
  const tools=[{type:"namespace",name:"trebell_workspace",tools:[{type:"function",name:"read_file",description:"Read file",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"]}}]}];
  const base=[{role:"system",content:"Stable coding instructions"},{role:"user",content:"Fix the parser"}];
  await manager.turn("openai",{model:"gpt-5.6",messages:base,tools});
  await manager.turn("openai",{model:"gpt-5.6",messages:[...base,{role:"assistant",content:"working"},{role:"user",content:"continue"}],tools});
  await manager.turn("openai",{model:"gpt-5.6",messages:[{role:"system",content:"Stable coding instructions"},{role:"user",content:"Fix the renderer"}],tools});
  await manager.turn("openai",{model:"gpt-5.6",messages:base,tools:[{...tools[0],tools:[{...tools[0].tools[0],description:"Read one file"}]}]});
  assert.equal(bodies[0].prompt_cache_key,bodies[1].prompt_cache_key);
  assert.notEqual(bodies[0].prompt_cache_key,bodies[2].prompt_cache_key);
  assert.notEqual(bodies[0].prompt_cache_key,bodies[3].prompt_cache_key);
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
  const env={...process.env,TREBELL_HOME:root,AGENTROUTER_BASE_URL:"https://agentrouter.org/v1/",AGENTROUTER_WIRE_API:"responses",AGENTROUTER_CLIENT_VERSION:"0.149.1"};
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

test("normalized AgentRouter turns use the current Chat transport and preserve namespaced tool calls",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));let seen=null;
  const manager=new ProviderManager({env:{...process.env,TREBELL_HOME:root},fetchFn:async(url,init)=>{
    seen={url,headers:init.headers,body:JSON.parse(init.body)};
    return Response.json({
      id:"chat-native",model:"gpt-5.6",
      choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:"",tool_calls:[{id:"call-native",type:"function",function:{name:"trebell_repo__search_symbols",arguments:'{"query":"Session"}'}}]}}],
      usage:{prompt_tokens:11,completion_tokens:2,total_tokens:13},
    });
  }});
  manager.setKey("agentrouter","ar-native-key");
  const result=await manager.turn("agentrouter",{
    model:"gpt-5.6",messages:[{role:"user",content:"Find Session"}],
    tools:[{type:"namespace",name:"trebell_repo",tools:[{type:"function",name:"search_symbols",description:"Search",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]}}]}],
  });
  assert.equal(seen.url,"https://co.agentrouter.org/v1/chat/completions");assert.equal(seen.headers.originator,"codex_cli_rs");assert.equal(seen.body.tools[0].function.name,"trebell_repo__search_symbols");
  assert.deepEqual(result.toolCalls,[{id:"call-native",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"Session"}'}]);
  assert.equal(result.usage.totalTokens,13);
  assert.equal(result.telemetry.endpoint,"https://co.agentrouter.org/v1/chat/completions");assert.equal(result.telemetry.wireApi,"openai-chat-completions");
  assert.ok(result.telemetry.requestBytes>0);assert.ok(result.telemetry.responseBytes>0);assert.equal(result.telemetry.streaming,false);assert.equal(result.telemetry.timeToFirstTokenMs,null);
});

test("AgentRouter transport and client fingerprint remain explicitly overrideable",()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const manager=new ProviderManager({env:{
    ...process.env,TREBELL_HOME:root,
    AGENTROUTER_BASE_URL:"https://legacy.agentrouter.example/v1/",
    AGENTROUTER_WIRE_API:"responses",
    AGENTROUTER_CLIENT_VERSION:"0.200.7-custom",
  }});
  const status=manager.status("agentrouter");
  assert.equal(status.baseUrl,"https://legacy.agentrouter.example/v1");
  assert.equal(status.wireApi,"responses");
  assert.deepEqual(status.protocolCompatibility,["openai-responses"]);
  const definition=manager.definitions().find(item=>item.id==="agentrouter");
  assert.equal(definition.baseUrl,status.baseUrl);
  assert.equal(definition.wireApi,status.wireApi);
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
  assert.equal(result.telemetry.wireApi,"openai-chat-completions");assert.ok(result.telemetry.requestBytes>0);
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
  assert.equal(result.telemetry.wireApi,"anthropic-messages");assert.ok(result.telemetry.requestBytes>0);
});

test("normalized provider turns expose retryability for transient HTTP failures only",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));let status=429;
  const manager=new ProviderManager({env:{...process.env,TREBELL_HOME:root},fetchFn:async()=>new Response("try later",{status})});manager.setKey("hcnsec","hc-retry-key");
  await assert.rejects(()=>manager.turn("hcnsec",{model:"glm-5.3",messages:[{role:"user",content:"hello"}]}),error=>error?.status===429&&error?.retryable===true);
  status=401;
  await assert.rejects(()=>manager.turn("hcnsec",{model:"glm-5.3",messages:[{role:"user",content:"hello"}]}),error=>error?.status===401&&error?.retryable===false);
});

test("provider turns expose bounded wire telemetry without including provider secrets",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-telemetry-"));
  const secret="hc-telemetry-secret";
  try{
    let capturedBody="";
    const manager=new ProviderManager({env:{...process.env,TREBELL_HOME:root,HCNSEC_API_KEY:secret},fetchFn:async(url,init)=>{
      capturedBody=String(init?.body||"");
      return new Response(JSON.stringify({
        id:"chatcmpl-telemetry",model:"glm-5.3",
        choices:[{message:{role:"assistant",content:"done"},finish_reason:"stop"}],
        usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15},
      }),{status:200,headers:{"content-type":"application/json"}});
    }});
    const result=await manager.turn("hcnsec",{model:"glm-5.3",messages:[{role:"user",content:"hello"}],tools:[]});
    assert.equal(result.text,"done");assert.equal(result.telemetry.wireApi,"openai-chat-completions");
    assert.match(result.telemetry.endpoint,/\/chat\/completions$/);
    assert.ok(result.telemetry.requestBytes>0);assert.ok(result.telemetry.responseBytes>0);
    assert.ok(result.telemetry.totalLatencyMs>=result.telemetry.responseHeadersLatencyMs);
    assert.equal(result.telemetry.streaming,false);
    assert.equal(result.telemetry.providerResponseId,"chatcmpl-telemetry");
    assert.doesNotMatch(JSON.stringify(result.telemetry),new RegExp(secret));
    assert.doesNotMatch(capturedBody,new RegExp(secret));
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("provider error bodies redact stored keys and parent environment secrets",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-")),providerSecret="ar-provider-secret-value",runtimeSecret="runtime-private-secret-value";
  const manager=new ProviderManager({
    env:{...process.env,TREBELL_HOME:root,RUNTIME_PRIVATE_SECRET:runtimeSecret},
    fetchFn:async()=>new Response(`provider=${providerSecret}; runtime=${runtimeSecret}; upstream failed`,{status:502}),
  });
  manager.setKey("agentrouter",providerSecret);
  const runs=[
    ()=>manager.models("agentrouter"),
    ()=>manager.turn("agentrouter",{model:"gpt-5.6",messages:[{role:"user",content:"hello"}]}),
    ()=>manager.directChat("agentrouter",{model:"gpt-5.6",prompt:"hello"}),
  ];
  for(const run of runs){
    await assert.rejects(run,error=>{
      const message=String(error?.message||error);assert.doesNotMatch(message,new RegExp(providerSecret));assert.doesNotMatch(message,new RegExp(runtimeSecret));assert.match(message,/\[redacted\]/);return true;
    });
  }
});

test("provider inference transports keep their request timeout when a caller signal exists", async () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const seen=[];
  const manager=new ProviderManager({
    env:{...process.env,TREBELL_HOME:root,AGENTROUTER_WIRE_API:"responses"},
    fetchFn:abortingFetch(seen),
    requestTimeoutMs:20,
  });
  manager.setKey("hcnsec","hc-timeout-key");
  manager.setKey("agentrouter","ar-timeout-key");
  manager.setKey("justworker","jw-timeout-key");

  const cases=[
    () => manager.forwardChat("hcnsec",{model:"glm-5.3",messages:[{role:"user",content:"hello"}],stream:false},{signal:new AbortController().signal}),
    () => manager.forwardResponses("agentrouter",{model:"gpt-5.6",input:"hello",stream:false},{signal:new AbortController().signal}),
    () => manager.forwardChat("justworker",{model:"claude-opus-4-8",messages:[{role:"user",content:"hello"}],stream:false},{signal:new AbortController().signal}),
  ];

  for (const run of cases) {
    await assert.rejects(run,error=>error?.name==="TimeoutError");
  }
  assert.equal(seen.length,3);
  assert.deepEqual(seen.map(item=>new URL(item.url).pathname),["/v1/chat/completions","/v1/responses","/v1/messages"]);
  assert.ok(seen.every(item=>item.signal?.aborted&&item.signal.reason?.name==="TimeoutError"));
});

test("caller cancellation still wins over the provider request timeout", async () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const seen=[];
  const manager=new ProviderManager({
    env:{...process.env,TREBELL_HOME:root},
    fetchFn:abortingFetch(seen),
    requestTimeoutMs:5_000,
  });
  manager.setKey("hcnsec","hc-cancel-key");
  const controller=new AbortController();
  const pending=manager.forwardChat("hcnsec",{model:"glm-5.3",messages:[{role:"user",content:"hello"}],stream:false},{signal:controller.signal});
  const reason=new DOMException("cancelled by caller","AbortError");
  controller.abort(reason);
  await assert.rejects(pending,error=>error===reason);
  assert.equal(seen.length,1);
  assert.notEqual(seen[0].signal,controller.signal);
  assert.equal(seen[0].signal.reason,reason);
});
