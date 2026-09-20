import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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

test("AgentRouter models are loaded live from key-scoped /v1/models", async () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const env={...process.env,TREBELL_HOME:root};
  let seen=null;
  const manager=new ProviderManager({env,fetchFn:async(url,init)=>{
    seen={url,authorization:init?.headers?.Authorization};
    return new Response(JSON.stringify({object:"list",data:[{id:"gpt-5.5"},{id:"claude-opus-4-8"},{id:"gpt-5.5"}]}),{status:200});
  }});
  manager.setKey("agentrouter","ar-key");
  const result=await manager.models("agentrouter");
  assert.equal(seen.url,"https://co.agentrouter.org/v1/models");
  assert.equal(seen.authorization,"Bearer ar-key");
  assert.deepEqual(result.models,["claude-opus-4-8","gpt-5.5"]);
  assert.equal(result.source,"live");
});

test("JustWorker and HCNSec expose only their configured model", async () => {
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-"));
  const manager=new ProviderManager({env:{...process.env,TREBELL_HOME:root}});
  manager.setKey("justworker","jw");
  manager.setKey("hcnsec","hc");
  assert.deepEqual((await manager.models("justworker")).models,["claude-opus-4-8"]);
  assert.deepEqual((await manager.models("hcnsec")).models,["glm-5.3"]);
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
      {id:"deepseek-v4-flash"},
      {id:"auto"},
    ]}),{status:200});
  }});
  manager.setKey("vyceai","sk-vyce");
  const result=await manager.models("vyceai");
  assert.equal(seen.url,"https://vyceai.com/v1/models");
  assert.equal(seen.authorization,"Bearer sk-vyce");
  assert.deepEqual(result.models,["auto","claude-sonnet-4-6","deepseek-v4-flash","gpt-astra"]);
  assert.equal(result.source,"live");
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
