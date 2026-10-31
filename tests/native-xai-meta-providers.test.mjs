import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_PROVIDERS, ProviderManager } from "../src/provider-manager.mjs";
import { keepResponsesReasoning } from "../src/provider-turn.mjs";
import { configuredReasoningEffort, supportedReasoningEfforts } from "../src/model-reasoning-effort.mjs";
import { providerCapabilities } from "../src/provider-capabilities.mjs";
import { MODEL_PROVIDER_LABELS } from "../ui/src/provider-labels.js";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { createGuiServer } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

// Trebell Native on xAI's API and on the Meta Model API, against scripted HTTP servers that stand in for api.x.ai and
// api.meta.ai: the key check, the model list and a Native turn's request, and Settings' key save on the GUI server.
// No request leaves the machine: the fetch given to ProviderManager sends each provider URL to the local server.

// A local server that answers each "METHOD /path" from a script and keeps every request it gets.
async function scriptedServer(script){
  const requests=[];
  const server=createServer(async(req,res)=>{
    let body="";for await(const chunk of req)body+=chunk;
    const request={method:req.method,path:req.url,headers:req.headers,body:body?JSON.parse(body):null};requests.push(request);
    const answer=script[`${req.method} ${req.url}`];
    const reply=typeof answer==="function"?answer(request,requests):answer;
    if(!reply){res.writeHead(404,{"content-type":"application/json"});res.end(JSON.stringify({error:{message:"No such route in the script"}}));return}
    res.writeHead(reply.status||200,{"content-type":"application/json"});res.end(JSON.stringify(reply.body??{}));
  });
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const origin=`http://127.0.0.1:${server.address().port}`;
  // api.x.ai and api.meta.ai are served from the scripted server under /xai and /meta; any other host is refused.
  const fetchFn=async(url,init)=>{
    const text=String(url);
    const local=text.startsWith("https://api.x.ai/")?origin+"/xai/"+text.slice("https://api.x.ai/".length)
      :text.startsWith("https://api.meta.ai/")?origin+"/meta/"+text.slice("https://api.meta.ai/".length):null;
    if(!local)throw new Error("Unexpected request outside the scripted providers: "+text);
    return fetch(local,init);
  };
  return {requests,fetchFn,close:()=>new Promise(resolve=>server.close(resolve))};
}
const home=()=>mkdtempSync(join(tmpdir(),"trebell-xai-meta-"));
// An environment with no provider key from the machine running the tests.
function cleanEnv(root,extra={}){
  const env={...process.env,TREBELL_HOME:root};
  for(const provider of Object.values(MODEL_PROVIDERS))for(const name of provider.envKeys||[provider.envKey])delete env[name];
  return {...env,...extra};
}

const XAI_MODELS={models:[
  {id:"grok-4.7",object:"model",owned_by:"xai",created:1776556800,aliases:["grok-4.7-latest"],input_modalities:["text","image"],output_modalities:["text"],capabilities:{reasoning_effort:["low","medium","high","xhigh"],default_reasoning_effort:"high"}},
  {id:"grok-4.5",object:"model",owned_by:"xai",created:1770000000,aliases:[],input_modalities:["text"],output_modalities:["text"],capabilities:{reasoning_effort:["low","medium","high"],default_reasoning_effort:"high"}},
  {id:"latest",object:"model",owned_by:"xai",created:1776556800,aliases:[],input_modalities:["text"],output_modalities:["text"]},
]};
const META_MODELS={object:"list",data:[
  {id:"muse-spark-1.3",object:"model",created:1777000000,owned_by:"meta"},
  {id:"muse-image-1.0",object:"model",created:1777000000,owned_by:"meta"},
  {id:"muse-voice-transcribe-1.0",object:"model",created:1777000000,owned_by:"meta"},
  {id:"sam-3.1",object:"model",created:1777000000,owned_by:"meta"},
  {id:"muse-wonder-1.0",object:"model",created:1777000000,owned_by:"meta"},
  {id:"muse-spark-1.3-contributor",object:"model",created:1777000000,owned_by:"meta"},
]};

test("xAI and the Meta Model API are official Native providers on their Responses APIs, with Settings' labels",()=>{
  const ids=Object.keys(MODEL_PROVIDERS);
  assert.deepEqual(ids.slice(0,5),["openai","anthropic","gemini","xai","meta"]);
  assert.deepEqual(MODEL_PROVIDERS.xai,{id:"xai",name:"xAI API",baseUrl:"https://api.x.ai/v1",wireApi:"responses",protocolCompatibility:["openai-responses"],envKey:"XAI_API_KEY",requiresKey:true,official:true,modelsPath:"/language-models",statelessResponses:true});
  // Meta's tool_choice takes only "auto" (tests/native-meta-tool-choice.test.mjs).
  assert.deepEqual(MODEL_PROVIDERS.meta,{id:"meta",name:"Meta Model API",baseUrl:"https://api.meta.ai/v1",wireApi:"responses",protocolCompatibility:["openai-responses"],envKey:"META_API_KEY",requiresKey:true,official:true,statelessResponses:true,autoToolChoiceOnly:true});
  // The browser-safe labels list the same providers, in the same order, by the same names.
  assert.deepEqual(MODEL_PROVIDER_LABELS,Object.fromEntries(Object.values(MODEL_PROVIDERS).map(provider=>[provider.id,provider.name])));
  for(const id of ["xai","meta"]){
    const features=providerCapabilities(id);
    assert.equal(features.previousResponseContinuation.status,"unsupported",id);
    assert.equal(features.persistentConnection.status,"unsupported",id);
    assert.equal(features.nativeCompaction.status,"unsupported",id);
    assert.equal(features.promptCaching.status,"unverified",id);
    assert.doesNotMatch(features.promptCaching.reason,/third-party compatibility endpoint/,id);
  }
});

test("an xAI key is checked against /v1/language-models, kept only when it answers, and its models carry their reasoning efforts",async()=>{
  const root=home();
  const server=await scriptedServer({
    "GET /xai/v1/language-models":request=>request.headers.authorization==="Bearer xai-good-key"
      ?{body:XAI_MODELS}
      :{status:401,body:{code:"Client specified an invalid argument",error:"Incorrect API key provided: xa***ey. You can obtain an API key from https://console.x.ai."}},
  });
  try{
    const manager=new ProviderManager({env:cleanEnv(root),fetchFn:server.fetchFn});
    await assert.rejects(manager.checkKey("xai","xai-bad-key"),error=>{
      assert.equal(error.keyCheck.status,401);
      assert.equal(error.message,"HTTP 401: Incorrect API key provided: [redacted] You can obtain an API key from https://console.x.ai. The key was not saved.");
      return true;
    });
    assert.equal(manager.hasKey("xai"),false,"a refused key is not saved");
    const catalog=await manager.checkKey("xai","  Bearer xai-good-key​ ");
    assert.deepEqual(catalog.models,["grok-4.5","grok-4.7","latest"]);
    assert.equal(catalog.source,"live");assert.equal(catalog.defaultModel,null);
    const grok=catalog.metadata.find(row=>row.id==="grok-4.7");
    assert.deepEqual(grok.reasoningEfforts,["low","medium","high","xhigh"]);assert.equal(grok.provider,"xai");assert.deepEqual(grok.protocolCompatibility,["openai-responses"]);
    assert.equal(catalog.metadata.find(row=>row.id==="latest").reasoningEfforts,undefined,"a model without listed efforts gets none");
    // The Thinking picker and the level a turn sends follow what xAI lists for the model.
    assert.deepEqual(supportedReasoningEfforts("native","xai","grok-4.5",catalog.metadata.find(row=>row.id==="grok-4.5")),["low","medium","high"]);
    assert.equal(configuredReasoningEffort({modelReasoningEfforts:{"native:xai:grok-4.5":"xhigh"}},"native","xai","grok-4.5",catalog.metadata.find(row=>row.id==="grok-4.5")),null);
    assert.equal(configuredReasoningEffort({modelReasoningEfforts:{"native:xai:grok-4.7":"xhigh"}},"native","xai","grok-4.7",grok),"xhigh");
    assert.deepEqual(server.requests.map(request=>[request.method,request.path,request.headers.authorization,request.headers.accept]),[
      ["GET","/xai/v1/language-models","Bearer xai-bad-key","application/json"],
      ["GET","/xai/v1/language-models","Bearer xai-good-key","application/json"],
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(root,"provider-secrets.json"),"utf8")),{xai:"xai-good-key"});
  }finally{await server.close();rmSync(root,{recursive:true,force:true})}
});

test("a Meta key is checked against /v1/models, and only Meta's chat models are listed",async()=>{
  const root=home();
  const server=await scriptedServer({
    "GET /meta/v1/models":request=>request.headers.authorization==="Bearer meta-good-key"
      ?{body:META_MODELS}
      :{status:401,body:{error:{message:"Invalid API key.",type:"authentication_error",code:"invalid_api_key"}}},
  });
  try{
    const manager=new ProviderManager({env:cleanEnv(root),fetchFn:server.fetchFn});
    await assert.rejects(manager.checkKey("meta","meta-bad-key"),/^Error: HTTP 401: Invalid API key\. The key was not saved\.$/);
    assert.equal(manager.hasKey("meta"),false);
    const catalog=await manager.checkKey("meta","meta-good-key");
    assert.deepEqual(catalog.models,["muse-spark-1.3","muse-spark-1.3-contributor","muse-wonder-1.0"],"image, speech-to-text and segmentation models cannot run a turn");
    assert.deepEqual(catalog.metadata.map(row=>[row.id,row.provider,row.owned_by]),[["muse-spark-1.3","meta","meta"],["muse-wonder-1.0","meta","meta"],["muse-spark-1.3-contributor","meta","meta"]]);
    // Meta's list names no levels: the Thinking picker offers what Meta documents for each model.
    assert.deepEqual(supportedReasoningEfforts("native","meta","muse-spark-1.3"),["minimal","low","medium","high","xhigh","max"]);
    assert.deepEqual(supportedReasoningEfforts("native","meta","muse-wonder-1.0"),["minimal","low","medium","high","xhigh","max"]);
    assert.deepEqual(supportedReasoningEfforts("native","meta","muse-spark-1.3-contributor"),["minimal","low","medium","high","xhigh"]);
    assert.deepEqual(supportedReasoningEfforts("native","meta","muse-spark-1.2"),["minimal","low","medium","high","xhigh"]);
    assert.deepEqual(supportedReasoningEfforts("native","meta","muse-image-1.0"),[]);
    assert.equal(configuredReasoningEffort({modelReasoningEfforts:{"native:meta:muse-spark-1.3-contributor":"max"}},"native","meta","muse-spark-1.3-contributor"),null);
    assert.deepEqual(server.requests.map(request=>[request.method,request.path,request.headers.authorization]),[["GET","/meta/v1/models","Bearer meta-bad-key"],["GET","/meta/v1/models","Bearer meta-good-key"]]);
  }finally{await server.close();rmSync(root,{recursive:true,force:true})}
});

const TOOLS=[
  {type:"function",name:"read_file",description:"Read a file",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}},
  {type:"namespace",name:"trebell_repo",description:"Repository tools",tools:[{type:"function",name:"search_symbols",description:"Search symbols",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"]}}]},
];
const FLAT_TOOLS=[
  {type:"function",name:"read_file",description:"Read a file",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}},
  {type:"function",name:"trebell_repo__search_symbols",description:"Search symbols",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}},
];
const responseWithCall=(id,{reasoning="enc-reasoning-1",callId="call_find_1"}={})=>({id,object:"response",status:"completed",model:"fixture",output:[
  ...(reasoning?[{type:"reasoning",id:"rs_"+id,summary:[],encrypted_content:reasoning}]:[]),
  {type:"function_call",id:"fc_"+id,call_id:callId,name:"trebell_repo__search_symbols",arguments:"{\"query\":\"Session\"}",status:"completed"},
],usage:{input_tokens:120,input_tokens_details:{cached_tokens:64},output_tokens:30,output_tokens_details:{reasoning_tokens:12},total_tokens:150}});
const responseWithText=id=>({id,object:"response",status:"completed",output:[{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"Session lives in src/session.mjs.",annotations:[]}]}],usage:{input_tokens:200,output_tokens:9,total_tokens:209}});

for(const [providerId,name,baseUrl,model,prefix,keyName] of [["xai","xAI API","https://api.x.ai/v1","grok-4.7","/xai","XAI_API_KEY"],["meta","Meta Model API","https://api.meta.ai/v1","muse-spark-1.3","/meta","META_API_KEY"]]){
  test(`a Native turn on ${name} sends a stateless Responses request and carries the turn's reasoning back`,async()=>{
    const root=home();let replies=0;
    const server=await scriptedServer({[`POST ${prefix}/v1/responses`]:()=>(++replies===1?{body:responseWithCall("resp_1")}:{body:responseWithText("resp_2")})});
    try{
      // The key comes from the environment variable Native reads for the provider.
      const manager=new ProviderManager({env:cleanEnv(root,{[keyName]:`${providerId}-env-key`}),fetchFn:server.fetchFn});
      const messages=[
        {role:"system",content:"You are Trebell Native."},
        {role:"developer",content:"Repository seed."},
        {role:"user",content:"Where is Session?"},
      ];
      const first=await manager.turn(providerId,{model,messages,tools:TOOLS,reasoningEffort:"high",maxOutputTokens:8192});
      assert.deepEqual(first.toolCalls,[{id:"call_find_1",namespace:"trebell_repo",name:"search_symbols",arguments:"{\"query\":\"Session\"}"}]);
      assert.equal(first.finishReason,"tool_calls");assert.equal(first.provider,providerId);
      assert.deepEqual(first.usage,{inputTokens:120,outputTokens:30,totalTokens:150,cachedInputTokens:64,cacheWriteInputTokens:0,reasoningOutputTokens:12});
      assert.equal(first.telemetry.endpoint,baseUrl+"/responses");assert.equal(first.telemetry.wireApi,"openai-responses");assert.equal(first.telemetry.streaming,false);
      const [sent]=server.requests;
      assert.equal(sent.method,"POST");assert.equal(sent.path,`${prefix}/v1/responses`);
      assert.equal(sent.headers.authorization,`Bearer ${providerId}-env-key`);assert.equal(sent.headers["content-type"],"application/json");
      assert.match(sent.headers["user-agent"],/^Trebell/);
      assert.match(sent.body.prompt_cache_key,/^trebell-[0-9a-f]{32}$/);
      const {prompt_cache_key:_key,...body}=sent.body;
      assert.deepEqual(body,{
        model,
        input:[{type:"message",role:"user",content:[{type:"input_text",text:"Where is Session?"}]}],
        tools:FLAT_TOOLS,stream:false,parallel_tool_calls:true,
        instructions:"You are Trebell Native.\n\nRepository seed.",
        tool_choice:"auto",max_output_tokens:8192,reasoning:{effort:"high"},
        store:false,include:["reasoning.encrypted_content"],
      });

      // The agent loop keeps the reply's reasoning on its message; the next call of the turn sends it back before its call.
      const next=[...messages,keepResponsesReasoning({role:"assistant",content:"",toolCalls:first.toolCalls},first),{role:"tool",toolCallId:"call_find_1",content:"src/session.mjs:12"},{role:"developer",content:"Check the change against the tests."}];
      const second=await manager.turn(providerId,{model,messages:next,tools:TOOLS,reasoningEffort:"high"});
      assert.equal(second.text,"Session lives in src/session.mjs.");assert.deepEqual(second.toolCalls,[]);
      const replay=server.requests[1].body;
      assert.deepEqual(replay.input,[
        {type:"message",role:"user",content:[{type:"input_text",text:"Where is Session?"}]},
        {type:"reasoning",summary:[],encrypted_content:"enc-reasoning-1"},
        {type:"function_call",call_id:"call_find_1",name:"trebell_repo__search_symbols",arguments:"{\"query\":\"Session\"}"},
        {type:"function_call_output",call_id:"call_find_1",output:"src/session.mjs:12"},
        {type:"message",role:"developer",content:[{type:"input_text",text:"Check the change against the tests."}]},
      ]);
      assert.equal(replay.instructions,"You are Trebell Native.\n\nRepository seed.");assert.equal(replay.prompt_cache_key,sent.body.prompt_cache_key,"the same prefix keeps its cache key");
      for(const field of ["previous_response_id","text","context_management","prompt_cache_options","service_tier"])assert.equal(Object.hasOwn(replay,field),false,field);
      assert.equal(Object.hasOwn(replay.reasoning,"context"),false,"reasoning.context is OpenAI's own");
    }finally{await server.close();rmSync(root,{recursive:true,force:true})}
  });
}

test("a model that refuses include gets the request again without it and without replayed reasoning, and later requests leave both out",async()=>{
  const root=home();
  const server=await scriptedServer({"POST /xai/v1/responses":request=>Array.isArray(request.body.include)
    ?{status:400,body:{code:"Client specified an invalid argument",error:"Argument not supported on this model: include"}}
    :{body:responseWithText("resp_plain")}});
  try{
    const manager=new ProviderManager({env:cleanEnv(root),fetchFn:server.fetchFn});manager.setKey("xai","xai-key");
    const reasoned=keepResponsesReasoning({role:"assistant",content:"",toolCalls:[{id:"call_1",name:"read_file",arguments:"{}"}]},{reasoningItems:[{before:"function_call",callId:"call_1",item:{type:"reasoning",summary:[],encrypted_content:"enc-old"}}]});
    const result=await manager.turn("xai",{model:"grok-fixture-plain",messages:[{role:"user",content:"hi"},reasoned,{role:"tool",toolCallId:"call_1",content:"{}"}],tools:TOOLS});
    assert.equal(result.text,"Session lives in src/session.mjs.");
    const [refused,resent]=server.requests.map(request=>request.body);
    assert.deepEqual(refused.include,["reasoning.encrypted_content"]);assert.equal(refused.input.filter(item=>item.type==="reasoning").length,1);
    assert.equal(Object.hasOwn(resent,"include"),false);assert.equal(resent.input.some(item=>item.type==="reasoning"),false);assert.equal(resent.store,false);
    await manager.turn("xai",{model:"grok-fixture-plain",messages:[{role:"user",content:"again"}],tools:[]});
    assert.equal(server.requests.length,3,"the next request goes once");
    assert.equal(Object.hasOwn(server.requests[2].body,"include"),false);
    // Another model of the provider still asks for its reasoning.
    await manager.turn("xai",{model:"grok-fixture-other",messages:[{role:"user",content:"hi"}],tools:[]}).catch(()=>{});
    assert.deepEqual(server.requests[3].body.include,["reasoning.encrypted_content"]);
  }finally{await server.close();rmSync(root,{recursive:true,force:true})}
});

// The GUI server's provider route on a server that contacts providers (mock off), and in mock mode.
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const probeHarness=AgentRuntimeManager.prototype.probe;
async function guiServer({mock,fetchFn,root}){
  const env=cleanEnv(root,{TREBELL_HISTORY_DISABLE_CLAUDE:"1",CODEX_HOME:join(root,"codex-home"),CLAUDE_CONFIG_DIR:join(root,"claude-config")});
  const state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",onboardingComplete:true});state.close?.();
  // No harness installed here starts: every harness but Native answers as not installed.
  AgentRuntimeManager.prototype.probe=async function(instanceOrKind,options){
    const kind=String((typeof instanceOrKind==="string"?instanceOrKind:instanceOrKind?.kind)||"").trim().toLowerCase();
    if(kind==="native")return probeHarness.call(this,instanceOrKind,options);
    return {id:typeof instanceOrKind==="string"?kind+"-default":instanceOrKind.id,kind,name:kind,available:false,installed:false,authenticated:null,account:null,version:null,message:"Not installed in this test."};
  };
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock,env,fetchFn});
  const post=body=>fetch(gui.url+"/api/providers",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  return {gui,post,close:async()=>{try{await gui.close()}finally{AgentRuntimeManager.prototype.probe=probeHarness}}};
}

test("Settings' key save checks an xAI or Meta key against its provider's model list before keeping it",async()=>{
  const root=home();
  const server=await scriptedServer({
    "GET /xai/v1/language-models":request=>request.headers.authorization==="Bearer xai-good-key"?{body:XAI_MODELS}:{status:401,body:{error:"Incorrect API key provided."}},
    "GET /meta/v1/models":request=>request.headers.authorization==="Bearer meta-good-key"?{body:META_MODELS}:{status:403,body:{error:{message:"This key cannot use the Model API."}}},
  });
  const {post,close}=await guiServer({mock:false,fetchFn:server.fetchFn,root});
  try{
    const refused=await post({provider:"xai",apiKey:"xai-bad-key"});
    assert.equal(refused.status,400);assert.equal((await refused.json()).error,"xAI API key check failed: HTTP 401: Incorrect API key provided. The key was not saved.");
    const saved=await post({provider:"xai",apiKey:"xai-good-key"}).then(response=>response.json());
    assert.equal(saved.selected,"xai");assert.equal(saved.ready,true);assert.deepEqual(saved.models,["grok-4.5","grok-4.7","latest"]);
    assert.deepEqual(saved.metadata.models.find(row=>row.id==="grok-4.7").reasoningEfforts,["low","medium","high","xhigh"]);
    assert.deepEqual(saved.providers.filter(item=>["xai","meta"].includes(item.id)).map(item=>[item.id,item.name,item.official,item.hasKey]),[["xai","xAI API",true,true],["meta","Meta Model API",true,false]]);
    const metaRefused=await post({provider:"meta",apiKey:"meta-bad-key"});
    assert.equal((await metaRefused.json()).error,"Meta Model API key check failed: HTTP 403: This key cannot use the Model API. The key was not saved.");
    const meta=await post({provider:"meta",apiKey:"meta-good-key"}).then(response=>response.json());
    assert.equal(meta.selected,"meta");assert.deepEqual(meta.models,["muse-spark-1.3","muse-spark-1.3-contributor","muse-wonder-1.0"]);
    assert.deepEqual(server.requests.map(request=>request.path),["/xai/v1/language-models","/xai/v1/language-models","/meta/v1/models","/meta/v1/models"],"each key is checked once and the saved catalog is reused");
  }finally{await close();await server.close();rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("in mock mode a key for xAI or Meta is saved without contacting the provider and the mock models are listed",async()=>{
  const root=home();const requests=[];
  const {post,close}=await guiServer({mock:true,fetchFn:async input=>{requests.push(String(input));throw new Error("Mock mode must not contact a model provider")},root});
  try{
    for(const [provider,models] of [["xai",["grok-4.7","grok-4.6"]],["meta",["muse-spark-1.3","muse-wonder-1.0"]]]){
      const saved=await post({provider,apiKey:provider+"-fixture-key"}).then(response=>response.json());
      assert.equal(saved.error,null,provider);assert.equal(saved.selected,provider);assert.equal(saved.status.hasKey,true,provider);assert.deepEqual(saved.models,models,provider);
    }
    assert.deepEqual(requests,[],"mock mode must not contact a model provider");
  }finally{await close();rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});
