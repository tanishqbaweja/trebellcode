import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_FAST_MODE_BETA, ProviderManager } from "../src/provider-manager.mjs";
import { nativeProviderTurn } from "../src/native-provider-turn.mjs";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { anthropicFastMode, configuredModelServiceTier, supportedModelServiceTiers } from "../src/model-service-tier.mjs";
import { serviceTierPickerTitle } from "../ui/src/harness-turn-options.js";

// The composer's Speed option on Trebell Native: Standard (no pick, the default) or Fast. On Anthropic, Fast is fast mode (the beta
// Messages endpoint, the fast-mode-2026-02-01 beta header and speed "fast" in the body); on OpenAI, the processing tier the model
// lists, sent as 2.1.5 sends it. Standard sends nothing new on either.

const tool={type:"function",namespace:"trebell_repo",name:"read_file",description:"Read a file.",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}};
const conversation=()=>[{role:"system",content:"You are Trebell Native."},{role:"user",content:"Read README.md."}];
const anthropicReply=(speed)=>({id:"msg_1",type:"message",role:"assistant",model:"claude-opus-5-5",content:[{type:"text",text:"ok"}],stop_reason:"end_turn",usage:{input_tokens:12,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:3,...(speed?{speed}:{})}});

function recordingManager(root,reply){
  const sent=[];
  const manager=new ProviderManager({env:{TREBELL_HOME:root},fetchFn:async(url,init={})=>{
    sent.push({url:String(url),headers:{...init.headers},body:String(init.body||"")});
    return reply(sent.length,String(url),JSON.parse(init.body||"{}"));
  }});
  manager.setKey("anthropic","an-key");manager.setKey("openai","oa-key");
  return {manager,sent};
}

function withRoot(run){
  const root=mkdtempSync(join(tmpdir(),"trebell-fast-mode-"));
  return Promise.resolve().then(()=>run(root)).finally(()=>rmSync(root,{recursive:true,force:true}));
}

test("Native on Anthropic: Standard sends the 2.1.5 request, Fast adds only fast mode's endpoint, beta header and speed",()=>withRoot(async root=>{
  const {manager,sent}=recordingManager(root,(_n,url)=>Response.json(anthropicReply(url.includes("?beta=true")?"fast":null)));
  const request=serviceTier=>({provider:"anthropic",model:"claude-opus-5-5",messages:conversation(),tools:[tool],reasoningEffort:null,serviceTier});
  const standard=await nativeProviderTurn(manager,request(null));
  const fast=await nativeProviderTurn(manager,request("fast"));
  const [plain,quick]=sent;

  // Standard: the Messages endpoint, the headers 2.1.5 sends in its order, no speed, prompt caching on.
  assert.equal(plain.url,"https://api.anthropic.com/v1/messages");
  assert.deepEqual(Object.keys(plain.headers),["x-api-key","anthropic-version","Content-Type","Accept","User-Agent"]);
  const plainBody=JSON.parse(plain.body);
  assert.equal("speed" in plainBody,false);
  assert.deepEqual(plainBody.cache_control,{type:"ephemeral"});
  assert.equal(standard.usage.speed,undefined);assert.equal(standard.telemetry.serviceTier,null);assert.equal(standard.telemetry.requestedServiceTier,null);

  // Fast: the beta endpoint, the fast-mode beta header, speed "fast" at the top level, prompt caching kept.
  assert.equal(quick.url,"https://api.anthropic.com/v1/messages?beta=true");
  assert.equal(quick.headers["anthropic-beta"],ANTHROPIC_FAST_MODE_BETA);
  assert.equal(ANTHROPIC_FAST_MODE_BETA,"fast-mode-2026-02-01");
  const quickBody=JSON.parse(quick.body);
  assert.equal(quickBody.speed,"fast");
  assert.deepEqual(quickBody.cache_control,{type:"ephemeral"});
  // Byte for byte, the fast body is the standard one with speed added, and its headers are the standard ones with the beta header.
  assert.equal(quick.body.replace(',"speed":"fast"',""),plain.body);
  const {"anthropic-beta":_beta,...rest}=quick.headers;assert.deepEqual(rest,plain.headers);
  assert.deepEqual(Object.keys(quick.headers),["x-api-key","anthropic-version","anthropic-beta","Content-Type","Accept","User-Agent"]);

  // usage.speed is kept with the request's usage and named as the tier the request ran at.
  assert.equal(fast.usage.speed,"fast");assert.equal(fast.telemetry.serviceTier,"fast");assert.equal(fast.telemetry.requestedServiceTier,"fast");
}));

test("a request that asks for no tier and one that asks for Standard send the same bytes on Anthropic",()=>withRoot(async root=>{
  const {manager,sent}=recordingManager(root,()=>Response.json(anthropicReply(null)));
  for(const serviceTier of [null,undefined,""])await nativeProviderTurn(manager,{provider:"anthropic",model:"claude-opus-5-5",messages:conversation(),tools:[tool],serviceTier});
  assert.equal(new Set(sent.map(item=>item.url+"\n"+JSON.stringify(item.headers)+"\n"+item.body)).size,1);
  assert.equal(sent[0].body.includes("speed"),false);
}));

test("a streamed fast turn keeps usage.speed from the stream",()=>withRoot(async root=>{
  const events=[
    {type:"message_start",message:{id:"msg_s",model:"claude-opus-5-5",usage:{input_tokens:9,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1,speed:"fast"}}},
    {type:"content_block_start",index:0,content_block:{type:"text",text:""}},
    {type:"content_block_delta",index:0,delta:{type:"text_delta",text:"fast reply"}},
    {type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:4,speed:"fast"}},
    {type:"message_stop"},
  ];
  const {manager,sent}=recordingManager(root,()=>new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}}));
  const result=await manager.turn("anthropic",{model:"claude-opus-5-5",messages:conversation(),tools:[],serviceTier:"fast"},{promptCaching:true,streamChat:true});
  assert.equal(result.text,"fast reply");assert.equal(result.usage.speed,"fast");assert.equal(result.telemetry.serviceTier,"fast");
  assert.equal(sent[0].url,"https://api.anthropic.com/v1/messages?beta=true");
  assert.equal(JSON.parse(sent[0].body).speed,"fast");assert.equal(JSON.parse(sent[0].body).stream,true);
}));

test("a fast-mode 429 is waited out by its retry-after and sent again fast, never at standard speed",()=>withRoot(async root=>{
  const {manager,sent}=recordingManager(root,n=>n===1
    ?new Response(JSON.stringify({type:"error",error:{type:"rate_limit_error",message:"Fast mode rate limit reached."}}),{status:429,headers:{"content-type":"application/json","retry-after":"0.02"}})
    :Response.json(anthropicReply("fast")));
  const events=[];
  const result=await runNativeAgentTurn({
    model:"claude-opus-5-5",provider:"anthropic",messages:conversation(),retryBaseDelayMs:0,onEvent:event=>events.push(event),
    providerTurn:request=>nativeProviderTurn(manager,{...request,provider:"anthropic",serviceTier:"fast"}),executeTool:async()=>"",
  });
  assert.equal(result.text,"ok");
  assert.equal(sent.length,2);
  for(const item of sent){
    assert.equal(item.url,"https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(item.headers["anthropic-beta"],"fast-mode-2026-02-01");
    assert.equal(JSON.parse(item.body).speed,"fast");
  }
  const retry=events.find(event=>event.name==="native.model.retrying");
  assert.equal(retry.data.rateLimited,true);assert.equal(retry.data.retryAfterMs,20);assert.ok(retry.data.delayMs>=20);assert.equal(retry.data.status,429);
  const completed=events.find(event=>event.name==="native.model.completed");
  assert.equal(completed.data.usage.speed,"fast");assert.equal(completed.data.providerTelemetry.serviceTier,"fast");
}));

test("an Anthropic-wire relay never gets fast mode: only Anthropic's own API has it",()=>withRoot(async root=>{
  const sent=[];
  const manager=new ProviderManager({env:{TREBELL_HOME:root},fetchFn:async(url,init={})=>{sent.push({url:String(url),headers:{...init.headers},body:String(init.body||"")});return Response.json(anthropicReply(null))}});
  manager.setKey("justworker","jw-key");
  await manager.turn("justworker",{model:"claude-opus-5-5",messages:conversation(),tools:[],serviceTier:"fast"});
  assert.equal(sent.length,1);assert.equal(sent[0].url.includes("?beta=true"),false);
  assert.equal("anthropic-beta" in sent[0].headers,false);assert.equal(sent[0].body.includes('"speed"'),false);
}));

test("Native on OpenAI: Fast sends the processing tier as 2.1.5 does and Standard sends none",()=>withRoot(async root=>{
  const {manager,sent}=recordingManager(root,(_n,_url,body)=>Response.json({id:"resp_"+sent.length,model:body.model,status:"completed",...(body.service_tier?{service_tier:body.service_tier==="fast"?"priority":body.service_tier}:{service_tier:"default"}),output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"ok"}]}],usage:{input_tokens:5,output_tokens:1,total_tokens:6}}));
  const request=serviceTier=>({provider:"openai",model:"gpt-6-luna",messages:conversation(),tools:[tool],reasoningEffort:"max",serviceTier});
  const standard=await nativeProviderTurn(manager,request(null));
  const fast=await nativeProviderTurn(manager,request("fast"));
  const [plain,quick]=sent;
  assert.equal(plain.url,"https://api.openai.com/v1/responses");assert.equal(quick.url,plain.url);
  assert.deepEqual(quick.headers,plain.headers);
  const plainBody=JSON.parse(plain.body),quickBody=JSON.parse(quick.body);
  assert.equal("service_tier" in plainBody,false);
  assert.equal(quickBody.service_tier,"fast");
  const {service_tier:_tier,...fastWithoutTier}=quickBody;assert.deepEqual(fastWithoutTier,plainBody);
  assert.equal(standard.telemetry.requestedServiceTier,null);assert.equal(fast.telemetry.requestedServiceTier,"fast");
  assert.equal(fast.telemetry.serviceTier,"fast");
  assert.equal(standard.usage.speed,undefined);assert.equal(fast.usage.speed,undefined);
}));

test("the Speed option shows Fast on Anthropic's fast-mode models, from the model list where it says so, and on OpenAI's tiered models",()=>{
  for(const model of ["claude-opus-5-5","claude-opus-5","claude-opus-4-8"])assert.deepEqual(supportedModelServiceTiers("native","anthropic",model,{id:model}),["fast"],model);
  for(const model of ["claude-opus-4-7","claude-opus-4-6","claude-sonnet-5-5","claude-sonnet-5","claude-fable-5-1","claude-haiku-5-5","claude-opus-5-5-fast","claude-opus-50"])assert.deepEqual(supportedModelServiceTiers("native","anthropic",model,{id:model}),[],model);
  // The model list's word wins over the named models when it gives one.
  assert.deepEqual(supportedModelServiceTiers("native","anthropic","claude-sonnet-5-5",{capabilities:{fast_mode:{supported:true}}}),["fast"]);
  assert.deepEqual(supportedModelServiceTiers("native","anthropic","claude-opus-5-5",{capabilities:{fast_mode:{supported:false}}}),[]);
  assert.deepEqual(supportedModelServiceTiers("native","anthropic","claude-opus-5-5",{capabilities:{speed:{fast:{supported:false}}}}),[]);
  // The capabilities Anthropic's list gives today (2026-11-09) name no speed: the named models decide.
  assert.equal(anthropicFastMode("claude-opus-5-5",{capabilities:{effort:{supported:true},thinking:{supported:true}}}),true);
  // Only Trebell Native on Anthropic's own API: Claude Code's own Fast mode and an Anthropic-wire relay are unchanged.
  assert.deepEqual(supportedModelServiceTiers("native","justworker","claude-opus-5-5",{}),[]);
  assert.deepEqual(supportedModelServiceTiers("native","openai","gpt-6-luna",{}),["fast"]);
  assert.deepEqual(supportedModelServiceTiers("native","openai","gpt-5.6",{}),[]);
  // Standard is the default: nothing saved sends no tier; a saved Fast pick is kept per model.
  assert.equal(configuredModelServiceTier({},"native","anthropic","claude-opus-5-5"),null);
  assert.equal(configuredModelServiceTier({modelServiceTiers:{"native:anthropic:claude-opus-5-5":"fast"}},"native","anthropic","claude-opus-5-5"),"fast");
  assert.equal(configuredModelServiceTier({modelServiceTiers:{"native:anthropic:claude-opus-5-5":"fast"}},"native","anthropic","claude-opus-5"),null);
});

test("the Speed option says in plain words what Fast does and that it costs more, on each provider",()=>{
  const anthropic=serviceTierPickerTitle("native","anthropic"),openai=serviceTierPickerTitle("native","openai");
  assert.equal(anthropic,"Speed. Standard runs at the usual speed and price. Fast turns on Anthropic's fast mode: the same model writes up to 2.5 times faster and costs about twice as much per token.");
  assert.equal(openai,"Speed. Standard runs at the usual speed and price. Fast uses OpenAI's priority processing: the same model answers faster and costs more per token.");
  for(const text of [anthropic,openai])assert.equal(/[—–]/.test(text),false);
});
