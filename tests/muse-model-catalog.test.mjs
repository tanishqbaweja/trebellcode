import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { MuseAgentSession } from "../src/muse-agent-session.mjs";
import { museModelCatalog, museModelEfforts, museModelName, readMuseModelCatalog, resolveMuseReasoningEffort } from "../src/muse-model-catalog.mjs";
import { normalizeRuntimeReasoningEffort, supportedReasoningEfforts } from "../src/model-reasoning-effort.mjs";

// Muse Code's model list (model/list, read as T3 Code's modelCatalog.ts reads it) and what a Muse Code session does with it: the
// thread's model sent before a turn (session/setModel) and the Thinking level the model lists. The list is composed from Muse
// 1.4.13's schema (fixtures/muse/model-list-1.4.13.json says how); hosts are a scripted `muse serve` driven by Meta's SDK.
const LIST=JSON.parse(readFileSync(new URL("./fixtures/muse/model-list-1.4.13.json",import.meta.url),"utf8")).result;
const INIT=JSON.parse(readFileSync(new URL("./fixtures/muse/initialize-1.4.13.json",import.meta.url),"utf8")).result;

test("Muse's model list keeps Meta's rows once each, named by their label or a title-cased muse-* id, with the levels each lists",()=>{
  const catalog=museModelCatalog(LIST);
  assert.deepEqual(catalog.models,["muse-wonder-1.0","muse-spark-1.3","muse-spark-1.2","muse-spark-1.3-contributor"],"the second muse-spark-1.3 row and the local provider's row are left out");
  const row=id=>catalog.metadata.find(item=>item.id===id);
  assert.deepEqual(row("muse-wonder-1.0"),{
    id:"muse-wonder-1.0",name:"Muse Wonder 1.0",provider:"muse",agent:"Muse Code",description:"Meta's most capable model, in preview.",contextWindow:1048576,
    reasoningEfforts:["minimal","low","medium","high","xhigh","max"],defaultReasoningEffort:"high",
    reasoningEffortDescriptions:{minimal:"Fastest answers",high:"Deep reasoning for most coding work",max:"The longest reasoning Wonder offers"},
  });
  assert.equal(row("muse-spark-1.3").name,"Muse Spark 1.3","a label that is the bare id reads as words (T3 eb1db5ff8)");
  assert.deepEqual(row("muse-spark-1.3").reasoningEfforts,["minimal","low","medium","high","xhigh","max"],"None, which Meta's provider refuses, is never offered");
  assert.deepEqual([row("muse-spark-1.2").reasoningEfforts,row("muse-spark-1.2").defaultReasoningEffort],[["low","medium","high","xhigh","max"],"high"],"unknown levels: Low to Max, High by default");
  assert.equal(row("muse-spark-1.2").isDefault,true);
  assert.deepEqual([row("muse-spark-1.3-contributor").name,row("muse-spark-1.3-contributor").reasoningEfforts,row("muse-spark-1.3-contributor").defaultReasoningEffort],["Muse Spark 1.3 Contributor",["low","medium","high"],"medium"]);
  assert.equal(catalog.preferred,"muse-spark-1.2","a new chat picks Muse's own default row");
  assert.equal(Object.hasOwn(row("muse-spark-1.3"),"isDefault"),false);
});

test("a list without Meta's provider is refused, and a signed-out Muse lists no models",()=>{
  assert.throws(()=>museModelCatalog({providerId:"local",profileId:null,source:"configCatalog",models:LIST.models}),/Muse Code listed the models of local, not Meta's/);
  assert.throws(()=>museModelCatalog({models:[]}),/models without a provider/);
  assert.deepEqual(museModelCatalog({providerId:"meta",profileId:"tbh",source:"bundledCatalog",models:[]}),{models:[],metadata:[],preferred:null});
  assert.equal(museModelName("muse-spark-1.3",""),"Muse Spark 1.3");
  assert.equal(museModelName("muse-wonder-1.0","Wonder (preview)"),"Wonder (preview)");
  assert.equal(museModelName("llama-local",""),"llama-local","only Muse's own ids are title-cased");
  assert.deepEqual(museModelEfforts({variants:[]}),{efforts:[],defaultEffort:null,descriptions:{}},"a row that lists no levels has none");
  assert.deepEqual(museModelEfforts({variants:["xhigh","ultra","bogus"],defaultReasoningEffort:"none"}).efforts,["xhigh","ultra"]);
});

test("a turn's Thinking level is the one chosen when the model lists it, else the model's default; none chosen leaves Muse's own (T3 resolveMuseReasoningEffort)",()=>{
  const catalog=museModelCatalog(LIST),row=id=>catalog.metadata.find(item=>item.id===id);
  assert.equal(resolveMuseReasoningEffort(row("muse-wonder-1.0"),"max"),"max");
  assert.equal(resolveMuseReasoningEffort(row("muse-spark-1.3-contributor"),"max"),"medium","Max is not the contributor model's: its default");
  assert.equal(resolveMuseReasoningEffort(row("muse-spark-1.3"),"none"),"high","None is never sent: the model's default instead");
  assert.equal(resolveMuseReasoningEffort(row("muse-wonder-1.0"),null),null);
  assert.equal(resolveMuseReasoningEffort(row("muse-wonder-1.0"),""),null);
  // A model the list does not have (a custom one, or no list yet) takes Low to Max with High by default.
  assert.equal(resolveMuseReasoningEffort(null,"max"),"max");
  assert.equal(resolveMuseReasoningEffort(null,"ultra"),"high");
  const restricted=museModelCatalog({providerId:"meta",models:[{modelId:"muse-x",displayLabel:"X",providerId:"meta",isDefault:false,variants:["xhigh"]}]}).metadata[0];
  assert.equal(resolveMuseReasoningEffort(restricted,"low"),"xhigh");
  const none=museModelCatalog({providerId:"meta",models:[{modelId:"muse-y",displayLabel:"Y",providerId:"meta",isDefault:false,variants:[]}]}).metadata[0];
  assert.equal(resolveMuseReasoningEffort(none,"max"),null,"a model with no levels gets none");
});

test("the composer offers Muse's own levels, Ultra and Minimal included, and saves them; None is never one",()=>{
  for(const effort of ["minimal","low","medium","high","xhigh","max","ultra"])assert.equal(normalizeRuntimeReasoningEffort("muse",effort),effort,effort);
  assert.equal(normalizeRuntimeReasoningEffort("muse","None"),null);
  assert.equal(normalizeRuntimeReasoningEffort("muse","Ultra"),"ultra");
  assert.deepEqual(supportedReasoningEfforts("muse",null,"muse-x",{reasoningEfforts:["minimal","high","ultra"]}),["minimal","high","ultra"]);
  assert.deepEqual(supportedReasoningEfforts("muse",null,"custom",{}),[],"a model without listed levels shows no Thinking picker");
});

// A scripted `muse serve` on a fake child process, as tests/muse-agent-session.test.mjs drives one: answers each request with its
// handler (undefined: no answer) and records every frame Trebell sends.
function fakeChild({pid=4242}={}){
  const child=new EventEmitter();
  child.pid=pid;child.exitCode=null;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
  child.exit=(code=0,signal=null)=>{if(child.exitCode!==null)return;child.exitCode=code;child.stdout.end();child.stderr.end();child.emit("exit",code,signal);child.emit("close",code,signal)};
  return child;
}
const fakeStop=async target=>{target.exit?.(1)};
class FakeMuse{
  constructor(child,handlers={}){
    this.child=child;this.frames=[];
    this.handlers={
      initialize:params=>({...INIT,grantedCapabilities:[...(params.capabilities?.requestedCapabilities||[])]}),
      "model/list":()=>LIST,
      "session/start":params=>({session:{sessionId:params.sessionId,status:"idle",workspaceRoot:params.workspaceRoot,providerId:"meta",modelId:params.modelId??"muse-spark-1.2",kind:"root"},viewCursor:`v4:${params.sessionId}:1`}),
      "session/resume":params=>({session:{sessionId:params.sessionId,status:"idle",modelId:"muse-spark-1.3"},history:{mode:"none",items:null},pendingRequests:[],viewCursor:`v4:${params.sessionId}:9`}),
      "session/setApprovalMode":params=>({commandId:params.commandId,applyOutcome:"noop"}),
      "session/setModel":params=>({commandId:params.commandId,status:"accepted"}),
      "turn/start":params=>{setImmediate(()=>this.notify("turn/completed",{sessionId:params.sessionId,viewCursor:"v",terminal:"completed",turnId:params.commandId}));return {commandId:params.commandId,status:"accepted",turnId:params.commandId,startedNewTurn:true,disposition:"started"}},
      ...handlers,
    };
    readline.createInterface({input:child.stdin}).on("line",line=>{if(line.trim())this.#receive(JSON.parse(line))});
    child.stdin.on("end",()=>setImmediate(()=>child.exit(0)));
  }
  #receive(frame){
    this.frames.push(frame);
    const handler=frame.method&&frame.id!==undefined?this.handlers[frame.method]:null;
    if(handler)Promise.resolve().then(()=>handler(frame.params||{})).then(
      result=>{if(result!==undefined)this.write({jsonrpc:"2.0",id:frame.id,result})},
      error=>this.write({jsonrpc:"2.0",id:frame.id,error:{code:error.code??-32000,message:error.message,data:{kind:error.kind||"internal",retryable:false}}}),
    );
  }
  sent(method){return this.frames.filter(frame=>frame.method===method)}
  write(frame){this.child.stdout.write(JSON.stringify(frame)+"\n")}
  notify(method,params){this.write({jsonrpc:"2.0",method,params})}
}

test("the list is read from a short read-only host: no shell, no writes, no session log, no session capabilities, then closed",async()=>{
  const child=fakeChild(),muse=new FakeMuse(child),spawned=[];
  const catalog=await readMuseModelCatalog({command:"muse",env:{PATH:""},cwd:process.cwd(),spawnFn:(command,args,options)=>{spawned.push({command,args,options});return child},stopTree:fakeStop});
  assert.deepEqual(catalog.models,["muse-wonder-1.0","muse-spark-1.3","muse-spark-1.2","muse-spark-1.3-contributor"]);
  assert.deepEqual(spawned.map(item=>item.args),[["serve","--disable-shell","--disable-write","--no-session-log"]]);
  assert.equal(spawned[0].options.windowsHide,true);assert.equal(spawned[0].options.env.MUSE_NO_AUTO_UPDATE,"1");
  assert.deepEqual(muse.sent("initialize")[0].params.capabilities,{requestedCapabilities:[]});
  assert.deepEqual(muse.sent("model/list").map(frame=>frame.params),[{}]);
  assert.equal(muse.sent("session/start").length,0);
  assert.equal(child.exitCode,0,"its input closed, the host ended");
});

test("a host that does not start within 8 s, or does not list within 12 s in all, fails the read and is closed",async()=>{
  const silent=fakeChild();
  new FakeMuse(silent,{initialize:()=>undefined});
  await assert.rejects(()=>readMuseModelCatalog({command:"muse",env:{},startupTimeoutMs:60,timeoutMs:5000,shutdownTimeoutMs:50,spawnFn:()=>silent,stopTree:fakeStop}),/Muse Code did not start: it did not answer within 0 seconds/);
  assert.ok(silent.exitCode!==null,"the host that did not start is closed");
  const slow=fakeChild();
  new FakeMuse(slow,{"model/list":()=>undefined});
  const reading=Date.now();
  await assert.rejects(()=>readMuseModelCatalog({command:"muse",env:{},timeoutMs:80,shutdownTimeoutMs:50,spawnFn:()=>slow,stopTree:fakeStop}),/Muse Code did not list its models within 0 seconds/);
  assert.ok(Date.now()-reading<3000,"the read ends at its bound");
  assert.ok(slow.exitCode!==null,"the host is closed");
  // One that never exits once its input closes has its process tree stopped after the short grace.
  const stuck=fakeChild(),stops=[];
  const stuckMuse=new FakeMuse(stuck);stuck.stdin.removeAllListeners("end");
  await readMuseModelCatalog({command:"muse",env:{},shutdownTimeoutMs:50,spawnFn:()=>stuck,stopTree:async target=>{stops.push(target.pid);target.exit(1)}});
  assert.deepEqual(stops,[4242]);assert.equal(stuckMuse.sent("model/list").length,1);
  const foreign=fakeChild();
  new FakeMuse(foreign,{"model/list":()=>({...LIST,providerId:"local"})});
  await assert.rejects(()=>readMuseModelCatalog({command:"muse",env:{},spawnFn:()=>foreign,stopTree:fakeStop}),/not Meta's/);
});

async function museSession({catalog=museModelCatalog(LIST),model="muse-wonder-1.0",providerSessionId=null,handlers={}}={}){
  const child=fakeChild(),muse=new FakeMuse(child,handlers);
  const session=new MuseAgentSession({command:"muse",cwd:process.cwd(),env:{PATH:""},version:"1.6.0",modelCatalog:()=>catalog,spawnFn:()=>child,stopTree:fakeStop,onUpdate:()=>{}});
  await session.start({model,providerSessionId});
  return {session,muse};
}

test("a model change goes to Muse once as session/setModel {modelId, providerId 'meta'}, before the next turn, and an equal model is not sent",async()=>{
  const {session,muse}=await museSession();
  try{
    assert.equal(muse.sent("session/start")[0].params.modelId,"muse-wonder-1.0");
    await session.setModel("muse-wonder-1.0");
    assert.equal(muse.sent("session/setModel").length,0,"the session already runs it");
    assert.equal(await session.setModel("muse-spark-1.3-contributor"),"muse-spark-1.3-contributor");
    await session.setModel("muse-spark-1.3-contributor");
    assert.deepEqual(muse.sent("session/setModel").map(frame=>frame.params.model),[{modelId:"muse-spark-1.3-contributor",providerId:"meta"}]);
    assert.equal(muse.sent("session/setModel")[0].params.sessionId,session.sessionId);
    session.setReasoningEffort("max");
    await session.prompt([{type:"text",text:"Go"}]);
    const [turn]=muse.sent("turn/start");
    assert.equal(turn.params.reasoningEffort,"medium","the contributor model lists no Max: its default");
    assert.match(turn.params.input[0].text,/using model muse-spark-1\.3-contributor/,"Trebell's runtime notes name the model the turn runs");
    assert.equal(muse.sent("session/setModel").length,1,"nothing sent again before the turn");
  }finally{await session.close()}
});

test("a resumed session on another model is moved to the thread's model, or to the catalog default for 'default', before its turn; 'default' never reaches Muse",async()=>{
  const resumed=await museSession({providerSessionId:"01a11a6a-bbb5-7000-ad0b-0c9e728406e5",model:"muse-wonder-1.0"});
  try{
    assert.equal(resumed.session.model,"muse-spark-1.3","the session Muse kept runs muse-spark-1.3");
    await resumed.session.prompt([{type:"text",text:"Continue"}]);
    const setModel=resumed.muse.sent("session/setModel"),turn=resumed.muse.sent("turn/start")[0];
    assert.deepEqual(setModel.map(frame=>frame.params.model),[{modelId:"muse-wonder-1.0",providerId:"meta"}]);
    assert.ok(resumed.muse.frames.indexOf(setModel[0])<resumed.muse.frames.indexOf(turn),"session/setModel goes before turn/start");
  }finally{await resumed.session.close()}
  const fresh=await museSession({model:"default"});
  try{
    assert.equal(fresh.muse.sent("session/start")[0].params.modelId,"muse-spark-1.2","'default' is the catalog's default row");
    await fresh.session.setModel("muse-wonder-1.0");await fresh.session.setModel("default");
    assert.deepEqual(fresh.muse.sent("session/setModel").map(frame=>frame.params.model.modelId),["muse-wonder-1.0","muse-spark-1.2"]);
    assert.doesNotMatch(JSON.stringify(fresh.muse.frames),/"modelId":"default"/);
  }finally{await fresh.session.close()}
  const unknown=await museSession({model:"default",catalog:null});
  try{
    assert.equal(Object.hasOwn(unknown.muse.sent("session/start")[0].params,"modelId"),false,"with no list yet, Muse picks its own model");
    unknown.session.setReasoningEffort("ultra");
    await unknown.session.prompt([{type:"text",text:"Go"}]);
    assert.equal(unknown.muse.sent("turn/start")[0].params.reasoningEffort,"high","a model the list does not have takes Low to Max");
  }finally{await unknown.session.close()}
});

test("a model Muse refuses fails with Muse's reason and leaves the session on its model",async()=>{
  const {session,muse}=await museSession({handlers:{"session/setModel":params=>{if(params.model.modelId==="muse-spark-1.3")throw Object.assign(new Error("model muse-spark-1.3 does not exist or you lack access"),{code:-32030,kind:"commandRejected"});return {commandId:params.commandId,status:"accepted"}}}});
  try{
    await assert.rejects(()=>session.setModel("muse-spark-1.3"),/Muse Code could not switch to the thread's model: model muse-spark-1\.3 does not exist or you lack access/);
    assert.equal(session.model,"muse-wonder-1.0");
    await session.prompt([{type:"text",text:"Still on Wonder"}]);
    assert.equal(muse.sent("session/setModel").length,1,"the refused model is not tried again before the next turn");
    assert.match(muse.sent("turn/start")[0].params.input[0].text,/using model muse-wonder-1\.0/);
  }finally{await session.close()}
});
