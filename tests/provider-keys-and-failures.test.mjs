// Tour lane L10's provider findings: a relay with a fixed model list checks a typed key with the provider before keeping it
// (L10-1), a key read from an environment variable says so and cannot be removed as if it were saved (L10-18), a provider's
// refusal reads in plain words with its reason, never its raw JSON body (L10-16), and a request its provider has not answered
// for a while says the turn is still waiting for that provider (L10-21).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";
import { MODEL_PROVIDERS, ProviderManager } from "../src/provider-manager.mjs";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ContextEngine } from "../src/context-engine.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const jsonResponse=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
// Every key variable of the relays and of Meta empty, so only what a test sets is read.
const NO_KEYS={JUSTWORKER_API_KEY:"",JUST_WORKER_API_KEY:"",HCNSEC_API_KEY:"",HNSEC_API_KEY:"",META_API_KEY:""};

// A relay's model list as one answers it: a key it knows gets its list, any other a 401 with its reason.
function relayFetch(goodKeys,requests){
  return async(input,init={})=>{
    const url=String(input instanceof URL?input.href:input?.url||input),headers=Object.fromEntries(Object.entries(init.headers||{}).map(([name,value])=>[name.toLowerCase(),String(value)]));
    requests.push({url,headers});
    if(!url.endsWith("/models"))throw new Error("Unexpected request: "+url);
    const key=headers["x-api-key"]||String(headers.authorization||"").replace(/^Bearer /,"");
    return goodKeys.includes(key)?jsonResponse({object:"list",data:[{id:"relay-listed-model",object:"model"}]}):jsonResponse({error:{message:"Invalid token (request id: 2026110217)",type:"new_api_error"}},401);
  };
}

test("a relay with a fixed model list asks the provider about a typed key before keeping it, and lists its fixed models (L10-1)",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-relay-key-check-")),requests=[];
  try{
    const manager=new ProviderManager({env:{TREBELL_HOME:home,...NO_KEYS},fetchFn:relayFetch(["jw-good-key","hc-good-key"],requests)});
    await assert.rejects(manager.checkKey("justworker","jw-wrong-key"),error=>error.message==="HTTP 401: Invalid token (request id: 2026110217). The key was not saved."&&error.keyCheck?.status===401);
    assert.equal(manager.hasKey("justworker"),false,"a key the provider refused is not kept");
    // JustWorker.icu's turns go as Anthropic Messages with an x-api-key: its list is asked with that header and a Bearer one.
    assert.equal(requests[0].url,"https://api.justwoker.icu/v1/models");
    assert.equal(requests[0].headers["x-api-key"],"jw-wrong-key");assert.equal(requests[0].headers.authorization,"Bearer jw-wrong-key");assert.equal(requests[0].headers["anthropic-version"],"2023-06-01");
    const catalog=await manager.checkKey("justworker","jw-good-key");
    assert.deepEqual([catalog.models,catalog.source],[["claude-opus-4-8"],"static"],"the fixed list stays what Trebell offers");
    assert.equal(manager.hasKey("justworker"),true);assert.equal(manager.status("justworker").keyCheck,null);

    await assert.rejects(manager.checkKey("hcnsec","hc-wrong-key"),/HTTP 401: Invalid token/);
    assert.equal(manager.hasKey("hcnsec"),false);
    assert.equal(requests[2].url,"https://api.hcnsec.cn/v1/models");assert.equal(requests[2].headers.authorization,"Bearer hc-wrong-key");assert.equal(requests[2].headers["x-api-key"],undefined);
    assert.deepEqual((await manager.checkKey("hcnsec","hc-good-key")).models,["glm-5.3"]);
    // The catalog of a saved relay key, which the composer and the benchmark runner read, still asks the provider nothing.
    const asked=requests.length;
    assert.deepEqual((await manager.models("hcnsec")).models,["glm-5.3"]);assert.deepEqual((await manager.models("justworker")).models,["claude-opus-4-8"]);
    assert.equal(requests.length,asked);
  }finally{await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("a relay that serves no model list keeps a typed key for its first turn to check, and a relay that cannot be reached keeps none (L10-1)",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-relay-no-list-")),requests=[];let answer=404;
  try{
    const cloudflare={type:"https://developers.cloudflare.com/",title:"Error 522: Connection timed out",detail:"Cloudflare could not establish a TCP connection to the origin server."};
    const manager=new ProviderManager({env:{TREBELL_HOME:home,...NO_KEYS},fetchFn:async input=>{requests.push(String(input));return answer===404?new Response("Not Found",{status:404}):answer===405?new Response("",{status:405}):jsonResponse(cloudflare,522)}});
    assert.deepEqual((await manager.checkKey("hcnsec","hc-any-key")).models,["glm-5.3"]);
    assert.equal(manager.hasKey("hcnsec"),true);assert.equal(manager.status("hcnsec").keyCheck,null);assert.deepEqual(requests,["https://api.hcnsec.cn/v1/models"]);
    answer=405;assert.deepEqual((await manager.checkKey("justworker","jw-any-key")).models,["claude-opus-4-8"]);assert.equal(manager.hasKey("justworker"),true);
    answer=522;manager.setKey("justworker","");
    await assert.rejects(manager.checkKey("justworker","jw-any-key"),error=>error.message==="HTTP 522: Cloudflare could not establish a TCP connection to the origin server. The key was not saved."&&error.keyCheck?.status===522);
    assert.equal(manager.hasKey("justworker"),false);
  }finally{await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// Trebell Native's benchmark runner bundles the provider manager (scripts/build-harbor-native-agent.mjs) and reads only its
// status().hasKey besides its turns, whose code this lane leaves as it was. The key reads and the model list requests of every
// provider are the ones 40f024d6 makes, header for header (this test passes there unchanged): only a relay's key check asks more.
test("the provider manager reads keys and asks each provider's model list as before, so Trebell Native's runner sends the same requests",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-provider-requests-")),requests=[];
  try{
    const blank=Object.fromEntries(Object.values(MODEL_PROVIDERS).flatMap(provider=>provider.envKeys||[provider.envKey]).map(name=>[name,""]));
    const manager=new ProviderManager({env:{TREBELL_HOME:home,...blank,META_API_KEY:"meta-env-fixture"},fetchFn:async(input,init={})=>{requests.push([String(input),init.method||"GET",init.headers||{}]);return jsonResponse({data:[{id:"model-a",object:"model"}]})}});
    const ids=Object.keys(MODEL_PROVIDERS);
    assert.deepEqual(ids.map(id=>manager.status(id).hasKey),ids.map(id=>id==="meta"));
    for(const id of ids)if(id!=="meta")manager.setKey(id,id+"-saved-fixture");
    assert.deepEqual(ids.map(id=>manager.status(id).hasKey),ids.map(()=>true));
    const listed={};for(const id of ids){const catalog=await manager.models(id);listed[id]=[catalog.source,...catalog.models]}
    assert.deepEqual(listed,{openai:["live","model-a"],anthropic:["live","model-a"],gemini:["live","model-a"],xai:["live","model-a"],meta:["live","model-a"],agentrouter:["live","model-a"],justworker:["static","claude-opus-4-8"],hcnsec:["static","glm-5.3"],vyceai:["live","model-a"]});
    const bearer=key=>({Authorization:"Bearer "+key,Accept:"application/json"});
    assert.deepEqual(requests,[
      ["https://api.openai.com/v1/models","GET",bearer("openai-saved-fixture")],
      ["https://api.anthropic.com/v1/models","GET",{"x-api-key":"anthropic-saved-fixture","anthropic-version":"2023-06-01",Accept:"application/json"}],
      ["https://generativelanguage.googleapis.com/v1beta/openai/models","GET",bearer("gemini-saved-fixture")],
      ["https://api.x.ai/v1/language-models","GET",bearer("xai-saved-fixture")],
      ["https://api.meta.ai/v1/models","GET",bearer("meta-env-fixture")],
      ["https://co.agentrouter.org/v1/models","GET",{Authorization:"Bearer agentrouter-saved-fixture","Content-Type":"application/json",Accept:"application/json","User-Agent":"codex_cli_rs/0.155.1",originator:"codex_cli_rs",version:"0.155.1"}],
      ["https://vyceai.com/v1/models","GET",bearer("vyceai-saved-fixture")],
    ]);
  }finally{await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

async function guiServer(t,{env={},fetchFn}){
  const root=await mkdtemp(join(tmpdir(),"trebell-provider-keys-gui-")),home=join(root,"home"),codexHome=join(root,"codex"),claudeConfig=join(root,"claude");
  await Promise.all([mkdir(home,{recursive:true}),mkdir(codexHome,{recursive:true}),mkdir(claudeConfig,{recursive:true})]);
  const serverEnv={...process.env,TREBELL_HOME:home,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claudeConfig,OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:"",XAI_API_KEY:"",...NO_KEYS,...env};
  const state=new TrebellStateStore(serverEnv);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:env.META_API_KEY?"meta":"hcnsec",onboardingComplete:true});state.close?.();
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:false,env:serverEnv,fetchFn});
  t.after(async()=>{await gui.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  const post=body=>fetch(gui.url+"/api/providers",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(async response=>({status:response.status,body:await response.json()}));
  return {gui,post,get:()=>fetch(gui.url+"/api/providers").then(response=>response.json())};
}

test("Settings' key save refuses a relay key its provider refuses, with the provider's reason (L10-1)",async t=>{
  const requests=[],{post,get}=await guiServer(t,{fetchFn:relayFetch(["hc-good-key"],requests)});
  const refused=await post({provider:"hcnsec",apiKey:"l10-wrong-key-fixture"});
  assert.equal(refused.status,400);
  assert.equal(refused.body.error,"HCNSec.cn API key check failed: HTTP 401: Invalid token (request id: 2026110217). The key was not saved.");
  const after=await get();assert.equal(after.status.hasKey,false);assert.equal(after.status.keyCheck?.status,401);
  assert.ok(requests.some(request=>request.url==="https://api.hcnsec.cn/v1/models"),"the key went to the provider");
  const saved=await post({provider:"hcnsec",apiKey:"hc-good-key"});
  assert.equal(saved.status,200);assert.equal(saved.body.status.hasKey,true);assert.equal(saved.body.status.keyCheck,null);assert.equal(saved.body.status.keySource,"settings");
});

test("a key from an environment variable says which, and Remove key says it cannot remove it instead of saying it did (L10-18)",async t=>{
  const metaList=async input=>{const url=String(input?.url||input);if(url.endsWith("/models"))return jsonResponse({data:[{id:"muse-spark-1.3",object:"model",owned_by:"meta"}]});throw new Error("Unexpected request: "+url)};
  const {post,get}=await guiServer(t,{env:{META_API_KEY:"meta-env-key-fixture"},fetchFn:metaList});
  const before=await get(),row=before.providers.find(item=>item.id==="meta");
  assert.deepEqual([row.hasKey,row.keySource,row.keyVariable],[true,"environment","META_API_KEY"]);
  assert.deepEqual([before.status.keySource,before.status.keyVariable],["environment","META_API_KEY"]);
  assert.doesNotMatch(JSON.stringify(before),/meta-env-key-fixture/,"the key itself is never listed");
  const removed=await post({provider:"meta",apiKey:""});
  assert.equal(removed.status,400);
  assert.equal(removed.body.error,"The Meta Model API key comes from the META_API_KEY environment variable, so Trebell Code cannot remove it. Unset META_API_KEY and restart Trebell Code to stop using it.");
  assert.equal((await get()).status.hasKey,true);
  // A key saved in Settings takes its place, and removing that one goes back to the variable's.
  const saved=await post({provider:"meta",apiKey:"meta-saved-key-fixture"});
  assert.equal(saved.status,200);assert.deepEqual([saved.body.status.keySource,saved.body.status.keyVariable],["settings",null]);
  const back=await post({provider:"meta",apiKey:""});
  assert.equal(back.status,200);assert.deepEqual([back.body.status.hasKey,back.body.status.keySource,back.body.status.keyVariable],[true,"environment","META_API_KEY"]);
});

test("a provider's refusal reads in plain words with its reason, never its raw JSON body (L10-16)",async()=>{
  const {plainProviderFailure,providerWaitNotice}=await import("../src/provider-failure-words.mjs");
  const cloudflare=JSON.stringify({type:"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-522/",title:"Error 522: Connection timed out",status:522,detail:"Cloudflare could not establish a TCP connection to the origin server.",error_code:522,retryable:true,retry_after:120,what_you_should_do:"**Wait and retry.**"});
  assert.equal(plainProviderFailure("JustWorker.icu HTTP 522: "+cloudflare),"JustWorker.icu cannot be reached right now (HTTP 522): Cloudflare could not establish a TCP connection to the origin server. Try again in a few minutes.");
  const meta=JSON.stringify({error:{code:null,message:"Duplicate function_call_output for call_id 'call_fixture'. Each function_call must have exactly one matching function_call_output",param:null,type:"invalid_request_error"}});
  assert.equal(plainProviderFailure("Meta Model API HTTP 400: "+meta),"Meta Model API refused the request (HTTP 400): Duplicate function_call_output for call_id 'call_fixture'. Each function_call must have exactly one matching function_call_output.");
  assert.equal(plainProviderFailure('HCNSec.cn HTTP 401: {"error":{"message":"Invalid token","type":"new_api_error"}}'),"HCNSec.cn refused the API key (HTTP 401): Invalid token. Check the key in Settings, Agents & models.");
  assert.equal(plainProviderFailure('VyceAi HTTP 429: {"error":{"message":"Too many requests"}}'),"VyceAi is limiting requests right now (HTTP 429): Too many requests. Try again in a minute.");
  // A body cut short (the error keeps 1,200 characters of it) or an HTML page gives no reason: the plain words alone.
  assert.equal(plainProviderFailure('JustWorker.icu HTTP 502: {"type":"https://developers.cloudflare.com/","title":"Error 5'),"JustWorker.icu cannot be reached right now (HTTP 502). Try again in a few minutes.");
  assert.equal(plainProviderFailure("HCNSec.cn HTTP 503: <html><body>Service Unavailable</body></html>"),"HCNSec.cn cannot be reached right now (HTTP 503). Try again in a few minutes.");
  // Anything else is left as it is.
  for(const other of ["Codex HTTP 400: {\"error\":1}","Could not reach HCNSec.cn: getaddrinfo ENOTFOUND api.hcnsec.cn","HCNSec.cn did not answer within 300 seconds"])assert.equal(plainProviderFailure(other),other);
  assert.equal(providerWaitNotice("hcnsec"),"Still waiting for HCNSec.cn to answer.");
  assert.equal(providerWaitNotice("constructor"),"Still waiting for the model provider to answer.");
});

async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}
function rpcClient(ws){
  let id=0;const pending=new Map(),notifications=[],waiters=[];
  ws.on("message",raw=>{
    const message=JSON.parse(String(raw));
    if(message.id!=null&&pending.has(message.id)){const target=pending.get(message.id);pending.delete(message.id);message.error?target.reject(new Error(message.error.message)):target.resolve(message.result);return}
    if(message.method){notifications.push(message);for(const waiter of [...waiters])if(waiter.predicate(message)){waiters.splice(waiters.indexOf(waiter),1);clearTimeout(waiter.timer);waiter.resolve(message)}}
  });
  return {notifications,
    request(method,params={}){return new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}))})},
    waitFor(predicate,timeoutMs=60_000){const found=notifications.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(new Error("notification timed out"))},timeoutMs)};waiters.push(waiter)})}};
}
async function nativeRelay(t,nativeProviderTurn,options={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-provider-failure-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await writeFile(join(repo,"notes.md"),"notes\n","utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"hcnsec",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,nativeModelContextWindow:()=>64000,version:"test",...options});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  t.after(async()=>{ws.close();await relay.close?.();await new Promise(resolve=>server.close(resolve));threadStore.close?.();state.close?.();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  const rpc=rpcClient(ws);
  const thread=(await rpc.request("thread/start",{model:"glm-5.3",modelProvider:"hcnsec",cwd:repo,projectless:false,approvalPolicy:"never",sandbox:"read-only",dynamicTools:[]})).thread;
  return {rpc,threadId:thread.id,threadStore};
}

test("a Native turn its provider refused ends with the plain words and the provider's reason (L10-16)",async t=>{
  const body=JSON.stringify({error:{code:null,message:"Duplicate function_call_output for call_id 'call_fixture'. Each function_call must have exactly one matching function_call_output",param:null,type:"invalid_request_error"}});
  const {rpc,threadId,threadStore}=await nativeRelay(t,async()=>{throw Object.assign(new Error("HCNSec.cn HTTP 400: "+body),{status:400,retryable:false})});
  const turn=(await rpc.request("turn/start",{threadId,model:"glm-5.3",modelProvider:"hcnsec",approvalPolicy:"never",sandboxPolicy:{type:"readOnly"},input:[{type:"text",text:"Reply with PONG"}]})).turn;
  const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);
  const words="HCNSec.cn refused the request (HTTP 400): Duplicate function_call_output for call_id 'call_fixture'. Each function_call must have exactly one matching function_call_output.";
  assert.equal(completed.params.turn.status,"failed");assert.equal(completed.params.turn.error?.message,words);
  assert.equal(rpc.notifications.find(message=>message.method==="error"&&message.params?.turnId===turn.id)?.params?.message,words);
  assert.equal(threadStore.get(threadId).turns.find(item=>item.id===turn.id)?.error?.message,words,"the thread keeps the plain words, as it is opened again");
});

test("a request its provider has not answered for a while says the turn is still waiting for that provider; a quick answer says nothing (L10-21)",async t=>{
  let answerAfterMs=400;
  const turnOf=request=>({id:"answer-"+Date.now(),provider:request.provider,model:request.model,text:"PONG",toolCalls:[],finishReason:"stop",usage:{inputTokens:4,outputTokens:1,totalTokens:5}});
  const {rpc,threadId}=await nativeRelay(t,async request=>{await new Promise(resolve=>setTimeout(resolve,answerAfterMs));return turnOf(request)},{nativeProviderWaitNoticeMs:120});
  const slow=(await rpc.request("turn/start",{threadId,model:"glm-5.3",modelProvider:"hcnsec",approvalPolicy:"never",sandboxPolicy:{type:"readOnly"},input:[{type:"text",text:"Reply with PONG"}]})).turn;
  const waiting=await rpc.waitFor(message=>message.method==="error"&&message.params?.turnId===slow.id);
  assert.deepEqual([waiting.params.willRetry,waiting.params.waiting,waiting.params.error?.message],[true,true,"Still waiting for HCNSec.cn to answer."]);
  const done=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===slow.id);
  assert.equal(done.params.turn.status,"completed");
  answerAfterMs=0;
  const quick=(await rpc.request("turn/start",{threadId,model:"glm-5.3",modelProvider:"hcnsec",approvalPolicy:"never",sandboxPolicy:{type:"readOnly"},input:[{type:"text",text:"Again"}]})).turn;
  await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===quick.id);
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(rpc.notifications.filter(message=>message.method==="error"&&message.params?.turnId===quick.id).length,0,"no notice for an answer that came at once");
  assert.equal(rpc.notifications.filter(message=>message.method==="error"&&message.params?.turnId===slow.id).length,1,"one notice for the slow request");
});
