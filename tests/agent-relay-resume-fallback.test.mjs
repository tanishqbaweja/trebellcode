// A thread whose harness lost its conversation: the relay continues it in one fresh session, hands the fresh session the thread's
// earlier messages once, and keeps a row on the turn saying so. Scripted harnesses only: an ACP agent, an OpenCode server and
// the Claude Agent SDK.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { attachAgentRelay, claudePersistedTurns } from "../src/agent-relay.mjs";
import { openCodeMessageId } from "../src/opencode-agent-session.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

// Cleanups run newest first, so a harness and the relay stop before their folder goes (Windows keeps a running process's folder busy).
const cleanups=new WeakMap();
function onCleanup(t,step){
  let stack=cleanups.get(t);
  if(!stack){stack=[];cleanups.set(t,stack);t.after(async()=>{let failure=null;for(const next of stack.reverse()){try{await next()}catch(error){failure??=error}}if(failure)throw failure})}
  stack.push(step);
}
async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}
async function connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws}
function request(ws){
  let id=0;return (method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id;
    const onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
}
// Every notification the open window gets, and a wait for the next one that matches.
function notifications(ws){
  const seen=[],waiters=[];
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(!message.method)return;seen.push(message);for(const waiter of [...waiters])if(waiter.match(message)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message)}});
  return {seen,next:match=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("timed out waiting for a relay notification")),20_000);waiters.push({match,resolve:value=>{clearTimeout(timer);resolve(value)}})})};
}
function memoryState(settings={}){
  const meta=new Map();
  return {settings:()=>({activeEnvironmentId:null,...settings}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
}
function memoryJournal(){const entries=[];return {entries,record:entry=>{entries.push(entry)},list:()=>[]}}
const fallbacks=journal=>journal.entries.filter(entry=>entry.name==="agent.session.resume_fallback");
const userMessages=turn=>turn.items.filter(item=>item.type==="userMessage");
async function startRelay(options){
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{terminals:{},version:"test",...options});
  const port=await listen(server),ws=await connect("ws://127.0.0.1:"+port+"/api/agent/ws");
  return {ws,rpc:request(ws),events:notifications(ws),close:async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()))}};
}
// A saved thread as a restart leaves it: one finished turn in a conversation the harness keeps under providerSessionId.
function savedThread(threadStore,{runtime,instanceId,providerSessionId,model="fixture-model",cwd}){
  const thread=threadStore.create({runtime,cwd,providerSessionId,model,providerMeta:{runtimeInstanceId:instanceId,permissionProfile:"supervised"}});
  threadStore.update(thread.id,{runtimeInstanceId:instanceId});
  const earlier=threadStore.addTurn(thread.id,{inputText:"Remember the word PELICAN",items:[{type:"agentMessage",id:"answer-1",text:"REMEMBERED"},{type:"commandExecution",id:"cmd-1",command:"echo PELICAN",aggregatedOutput:"PELICAN\n",exitCode:0}]});
  threadStore.updateTurn(thread.id,earlier.id,{providerMessageId:"provider-message-1"});
  threadStore.finishTurn(thread.id,earlier.id);
  return threadStore.get(thread.id);
}
const HISTORY_ENTRY="[application context · trebell.thread_history]\nThe earlier conversation of this thread, handed over because ";

// An ACP agent scripted by a JSON file: it logs each request (one JSON line, with the process it reached), answers session/load and
// session/resume with config.lostError when set (config.loadDelayMs late), numbers its new sessions across launches and answers
// prompts with config.reply.
const FAKE_ACP_AGENT=String.raw`
import readline from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
const [log,configPath]=process.argv.slice(2),config=JSON.parse(readFileSync(configPath,"utf8"));
const send=message=>process.stdout.write(JSON.stringify(message)+"\n");
function handle(m){
  if(!m.method||m.id==null)return;
  appendFileSync(log,JSON.stringify({pid:process.pid,method:m.method,params:m.params??null})+"\n");
  const reply=result=>send({jsonrpc:"2.0",id:m.id,result}),fail=error=>send({jsonrpc:"2.0",id:m.id,error});
  if(m.method==="initialize")return reply({protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:config.capabilities});
  if(m.method==="session/load"||m.method==="session/resume")return setTimeout(()=>config.lostError?fail(config.lostError):reply({}),config.loadDelayMs||0);
  if(m.method==="session/new"){
    if(config.newError)return fail(config.newError);
    const count=readFileSync(log,"utf8").split("\n").filter(line=>line.includes('"method":"session/new"')).length;
    return reply({sessionId:"fresh-"+count,models:{currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture"}]}});
  }
  if(m.method==="session/prompt"){
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:config.reply||"PELICAN"}}}});
    return reply({stopReason:"end_turn"});
  }
  return reply({});
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line))}catch{}});
`;
const ACP_HARNESSES={
  cursor:{instance:{id:"cursor-default",kind:"cursor",displayName:"Cursor",enabled:true},label:"Cursor",capabilities:{loadSession:true},method:"session/load",lostError:{code:-32603,message:"Internal error",data:{message:"Session \"cursor-lost\" not found"}}},
  grok:{instance:{id:"grok-default",kind:"grok",displayName:"Grok Build",enabled:true},label:"Grok Build",capabilities:{loadSession:true,sessionCapabilities:{resume:{}}},method:"session/resume",lostError:{code:-32603,message:"Internal error",data:{message:"Path not found"}}},
};
async function acpHarness(t,runtime,config={}){
  const root=await mkdtemp(join(tmpdir(),`trebell-resume-fallback-${runtime}-`)),fixture=join(root,"agent.mjs"),log=join(root,"log.jsonl"),configPath=join(root,"config.json");
  onCleanup(t,()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const harness=ACP_HARNESSES[runtime];
  await writeFile(fixture,FAKE_ACP_AGENT,"utf8");await writeFile(configPath,JSON.stringify({capabilities:harness.capabilities,lostError:harness.lostError,...config}),"utf8");
  const instance=harness.instance;
  const runtimeManager={
    instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>runtime,compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:harness.label,available:true,authenticated:true,version:"fixture"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),executable:()=>process.execPath,acpArgs:()=>[fixture,log,configPath],
  };
  const requests=async()=>(await readFile(log,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
  return {root,harness,runtimeManager,requests,env:{...process.env,TREBELL_HOME:join(root,"home")}};
}

for(const runtime of ["cursor","grok"]){
  test(`a ${runtime} conversation the harness lost continues in one fresh session that is handed the earlier messages once`,async t=>{
    const fx=await acpHarness(t,runtime),threadStore=new AgentThreadStore(fx.env),journal=memoryJournal();
    const saved=savedThread(threadStore,{runtime,instanceId:fx.harness.instance.id,providerSessionId:`${runtime}-lost`,cwd:fx.root});
    const relay=await startRelay({runtimeManager:fx.runtimeManager,threadStore,state:memoryState(),journal});onCleanup(t,relay.close);
    const opened=await relay.rpc("thread/resume",{threadId:saved.id,cwd:fx.root});
    assert.equal(opened.thread.turns.length,1,"the thread opens with its saved history");
    const row=relay.events.next(message=>message.method==="item/completed"&&message.params.item?.type==="sessionHandoff");
    const completed=relay.events.next(message=>message.method==="turn/completed");
    const started=await relay.rpc("turn/start",{threadId:saved.id,input:[{type:"text",text:"What word did I ask you to remember?"}]});
    assert.equal((await completed).params.turn.status,"completed");
    const live=(await row).params;
    assert.equal(live.turnId,started.turn.id);
    const sent=(await fx.requests()).filter(entry=>entry.method.startsWith("session/"));
    assert.deepEqual(sent.map(entry=>[entry.method,entry.params?.sessionId??null]).filter(([method])=>method!=="session/set_model"&&method!=="session/set_config_option"),[[fx.harness.method,`${runtime}-lost`],["session/new",null],["session/prompt","fresh-1"]],"one resume, one fresh session, one prompt");
    const [context,request]=sent.find(entry=>entry.method==="session/prompt").params.prompt;
    assert.deepEqual(request,{type:"text",text:"What word did I ask you to remember?"});
    assert.ok(context.text.includes(HISTORY_ENTRY+fx.harness.label+" no longer had it."));
    assert.ok(context.text.includes("[turn 1 · user]\nRemember the word PELICAN\n\n[turn 1 · assistant]\nREMEMBERED\n\n[turn 1 · command · exit code 0]\necho PELICAN\nPELICAN"));
    assert.equal(context.text.includes("What word did I ask"),false,"the turn's own message goes once, as the request");
    const thread=threadStore.get(saved.id),turn=thread.turns.at(-1);
    assert.equal(thread.providerSessionId,"fresh-1");
    assert.deepEqual(turn.items.map(item=>item.type),["userMessage","sessionHandoff","agentMessage"]);
    assert.equal(userMessages(turn).length,1);
    const item=turn.items[1];
    assert.deepEqual(item,live.item,"the window is told the row the turn stores");
    assert.deepEqual(item,{type:"sessionHandoff",id:`session-handoff-${turn.id}`,status:"completed",title:`${fx.harness.label} no longer had this conversation, so it continues in a new session with the earlier messages handed over.`,runtime,harness:fx.harness.label,previousSessionId:`${runtime}-lost`,sessionId:"fresh-1",reason:item.reason,handedOver:{included:3,omitted:0}});
    assert.match(item.reason,new RegExp(`^${fx.harness.label} could not resume this conversation: `));
    assert.deepEqual({...thread.providerMeta.historyHandoff,at:0,deliveredAt:0},{status:"delivered",runtime,previousSessionId:`${runtime}-lost`,sessionId:"fresh-1",reason:item.reason,at:0,turnId:turn.id,deliveredAt:0,included:3,omitted:0});
    const [entry,...more]=fallbacks(journal);
    assert.equal(more.length,0);
    assert.equal(entry.category,"turn");assert.equal(entry.status,"completed");assert.equal(entry.threadId,saved.id);
    assert.deepEqual(entry.data,{lostSessionId:`${runtime}-lost`,sessionId:"fresh-1",reason:item.reason});
    // The next turn runs in the same fresh session without the history, and the row stays where it was, after a reload too.
    const again=relay.events.next(message=>message.method==="turn/completed");
    await relay.rpc("turn/start",{threadId:saved.id,input:[{type:"text",text:"Thanks"}]});await again;
    const prompts=(await fx.requests()).filter(entry=>entry.method==="session/prompt");
    assert.deepEqual(prompts.map(entry=>entry.params.sessionId),["fresh-1","fresh-1"]);
    assert.equal(JSON.stringify(prompts[1].params.prompt).includes("trebell.thread_history"),false,"handed over once");
    assert.equal((await fx.requests()).filter(entry=>entry.method==="session/new").length,1);
    const reopened=await relay.rpc("thread/resume",{threadId:saved.id,cwd:fx.root});
    assert.deepEqual(reopened.thread.turns.map(turn=>turn.items.filter(item=>item.type==="sessionHandoff").length),[0,1,0]);
  });
}

test("a fresh session that cannot start either fails the turn before it exists, once, and keeps the thread's saved session",async t=>{
  const fx=await acpHarness(t,"grok",{newError:{code:-32603,message:"Internal error",data:{message:"Out of disk space"}}}),threadStore=new AgentThreadStore(fx.env),journal=memoryJournal();
  const saved=savedThread(threadStore,{runtime:"grok",instanceId:fx.harness.instance.id,providerSessionId:"grok-lost",cwd:fx.root});
  const relay=await startRelay({runtimeManager:fx.runtimeManager,threadStore,state:memoryState(),journal});onCleanup(t,relay.close);
  await assert.rejects(relay.rpc("turn/start",{threadId:saved.id,input:[{type:"text",text:"What word did I ask you to remember?"}]}),/Out of disk space/);
  const sent=(await fx.requests()).map(entry=>entry.method).filter(method=>method.startsWith("session/"));
  assert.deepEqual(sent,["session/resume","session/new"],"one fresh attempt, no loop and no prompt");
  const thread=threadStore.get(saved.id);
  assert.equal(thread.turns.length,1,"no turn exists, so the message stays in the composer");
  assert.equal(thread.providerSessionId,"grok-lost");assert.equal(thread.providerMeta.historyHandoff,undefined);
  const [entry]=fallbacks(journal);
  assert.equal(entry.status,"error");assert.equal(entry.data.lostSessionId,"grok-lost");assert.equal(entry.data.sessionId,null);assert.match(entry.data.error,/Out of disk space/);
});

test("a harness that asks to sign in cannot run: its resume failure fails the turn as before, with no fresh session",async t=>{
  const fx=await acpHarness(t,"cursor",{lostError:{code:-32000,message:"Authentication required"}}),threadStore=new AgentThreadStore(fx.env),journal=memoryJournal();
  const saved=savedThread(threadStore,{runtime:"cursor",instanceId:fx.harness.instance.id,providerSessionId:"cursor-lost",cwd:fx.root});
  const relay=await startRelay({runtimeManager:fx.runtimeManager,threadStore,state:memoryState(),journal});onCleanup(t,relay.close);
  await assert.rejects(relay.rpc("turn/start",{threadId:saved.id,input:[{type:"text",text:"Hello"}]}),/Cursor could not resume this conversation: Authentication required/);
  assert.equal((await fx.requests()).some(entry=>entry.method==="session/new"),false);
  assert.equal(threadStore.get(saved.id).providerSessionId,"cursor-lost");assert.equal(fallbacks(journal).length,0);
});

// Two turn/starts for one thread at once (two windows, or restart recovery racing a send): one harness process and, for a
// conversation the harness lost, one fresh session that is handed the earlier messages once, with one journal entry and one row.
for(const lost of [true,false]){
  test(`two sends at once on a Grok conversation ${lost?"the harness lost":"it still has"} share one session start`,async t=>{
    const fx=await acpHarness(t,"grok",{loadDelayMs:150,...(lost?{}:{lostError:null})}),threadStore=new AgentThreadStore(fx.env),journal=memoryJournal();
    // Every agent process the test started ends with it, also one the relay would no longer track.
    onCleanup(t,async()=>{for(const pid of new Set((await fx.requests()).map(entry=>entry.pid)))try{process.kill(pid)}catch{}});
    const saved=savedThread(threadStore,{runtime:"grok",instanceId:fx.harness.instance.id,providerSessionId:lost?"grok-lost":"grok-kept",cwd:fx.root});
    const relay=await startRelay({runtimeManager:fx.runtimeManager,threadStore,state:memoryState(),journal});onCleanup(t,relay.close);
    const started=await Promise.all(["First question","Second question"].map(text=>relay.rpc("turn/start",{threadId:saved.id,input:[{type:"text",text}]})));
    for(let waited=0;relay.events.seen.filter(message=>message.method==="turn/completed").length<2;waited+=50){assert.ok(waited<15_000,"both turns complete");await new Promise(resolve=>setTimeout(resolve,50))}
    const requests=await fx.requests(),thread=threadStore.get(saved.id),prompts=requests.filter(entry=>entry.method==="session/prompt");
    assert.deepEqual(relay.events.seen.filter(message=>message.method==="turn/completed").map(message=>message.params.turn.status),["completed","completed"]);
    assert.equal(new Set(requests.map(entry=>entry.pid)).size,lost?2:1,lost?"one process for the resume, one for the fresh session":"one process");
    assert.equal(requests.filter(entry=>entry.method==="session/resume").length,1,"the saved session is resumed once");
    assert.equal(requests.filter(entry=>entry.method==="session/new").length,lost?1:0);
    assert.deepEqual(prompts.map(entry=>entry.params.sessionId),lost?["fresh-1","fresh-1"]:["grok-kept","grok-kept"],"both turns run in the thread's one session");
    assert.equal(prompts.filter(entry=>JSON.stringify(entry.params.prompt).includes("trebell.thread_history")).length,lost?1:0,"the earlier messages go over once");
    assert.equal(fallbacks(journal).length,lost?1:0);
    const rows=thread.turns.flatMap(turn=>turn.items.filter(item=>item.type==="sessionHandoff").map(()=>turn.id));
    assert.equal(rows.length,lost?1:0);if(lost)assert.ok(started.some(result=>result.turn.id===rows[0]),"the row is on the turn that handed them over");
    assert.equal(thread.providerSessionId,lost?"fresh-1":"grok-kept");
  });
}

// A stand-in for `opencode serve` that keeps sessions in memory and answers a session it does not have with 404. It lists a
// session's messages and forks one as OpenCode does, copying the messages whose IDs sort before the fork's messageID.
async function fakeOpenCodeServe(){
  const calls=[],streams=new Set(),sessions=new Map();let created=0,clock=0n;
  const stamp=(after=0n)=>{const now=BigInt(Date.now())*0x1000n;clock=[now,clock+1n,after+1n].reduce((a,b)=>a>b?a:b);return openCodeMessageId(clock)};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,"http://127.0.0.1");let text="";for await(const chunk of req)text+=chunk;
    const body=text?JSON.parse(text):null,key=`${req.method} ${url.pathname}`;
    const json=(status,value)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value))};
    calls.push({key,body});
    if(key==="GET /event"){res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});res.write(`data: ${JSON.stringify({type:"server.connected",properties:{}})}\n\n`);streams.add(res);res.on("close",()=>streams.delete(res));return}
    if(key==="GET /provider")return json(200,{connected:["anthropic"],default:{anthropic:"claude-sonnet-4-5"},all:[{id:"anthropic",name:"Anthropic",models:{sonnet:{id:"claude-sonnet-4-5",name:"Claude Sonnet 4.5"}}}]});
    if(key==="GET /config")return json(200,{});
    if(key==="POST /session"){const id=`ses_${++created}`;sessions.set(id,{permission:body?.permission||[],messages:[]});return json(200,{id,permission:body?.permission||[]})}
    const [,id,rest=""]=/^\/session\/([^/]+)(\/[^/]+)?$/.exec(url.pathname)||[],entry=sessions.get(id);
    if(entry&&req.method==="GET"&&!rest)return json(200,{id,permission:entry.permission});
    if(entry&&req.method==="PATCH"&&!rest){entry.permission=[...entry.permission,...(body?.permission||[])];return json(200,{id,permission:entry.permission})}
    if(entry&&req.method==="GET"&&rest==="/message")return json(200,entry.messages.map(message=>({info:{id:message.id,role:message.role,sessionID:id},parts:[]})));
    if(entry&&req.method==="POST"&&rest==="/fork"){
      const forked=`ses_${++created}`,boundary=body?.messageID||null;
      sessions.set(forked,{permission:[],messages:entry.messages.filter(message=>!boundary||message.id<boundary).map(message=>({...message,id:stamp()}))});
      return json(200,{id:forked,permission:[]});
    }
    if(entry&&req.method==="POST"&&rest==="/message"){
      const reply={id:stamp(BigInt("0x"+body.messageID.slice(4,16))),parentID:body.messageID,role:"assistant",providerID:"anthropic",modelID:"claude-sonnet-4-5",tokens:{input:3,output:1}};
      entry.messages.push({id:body.messageID,role:"user"},reply);
      return json(200,{info:reply,parts:[{id:`prt_${id}_${entry.messages.length}`,type:"text",text:"PELICAN"}]});
    }
    json(404,{name:"NotFoundError",data:{message:`Session not found: ${id||key}`}});
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,calls,sessions,called:key=>calls.filter(call=>call.key===key),close:()=>{for(const res of streams)res.end();server.closeAllConnections?.();return new Promise(resolve=>server.close(resolve))}};
}

test("an OpenCode thread whose session is gone opens with its history, and its next turn runs in a fresh session",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-resume-fallback-opencode-")),fixture=await fakeOpenCodeServe();
  onCleanup(t,async()=>{await fixture.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,serverUrl:fixture.url};
  const runtimeManager={
    instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>"opencode",compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:"OpenCode",available:true,authenticated:true,version:"1.18.32"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),executable:()=>"opencode",
  };
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"home")}),journal=memoryJournal(),model="anthropic/claude-sonnet-4-5";
  const saved=savedThread(threadStore,{runtime:"opencode",instanceId:instance.id,providerSessionId:"ses_gone",model,cwd:root});
  const relay=await startRelay({runtimeManager,threadStore,state:memoryState(),journal});onCleanup(t,relay.close);
  // Opening the thread asks OpenCode for the session, which it no longer has: the open still shows the saved history.
  const opened=await relay.rpc("thread/resume",{threadId:saved.id,cwd:root});
  assert.deepEqual(opened.thread.turns.map(turn=>turn.items.map(item=>item.type)),[["userMessage","agentMessage","commandExecution"]]);
  assert.equal(fixture.called("GET /session/ses_gone").length,1);assert.equal(fixture.called("POST /session").length,0,"no fresh session before a turn");
  assert.equal(fallbacks(journal).length,0);
  const completed=relay.events.next(message=>message.method==="turn/completed");
  await relay.rpc("turn/start",{threadId:saved.id,model,input:[{type:"text",text:"What word did I ask you to remember?"}]});
  assert.equal((await completed).params.turn.status,"completed");
  assert.equal(fixture.called("GET /session/ses_gone").length,2);assert.equal(fixture.called("POST /session").length,1);
  const [prompt]=fixture.called("POST /session/ses_1/message").map(call=>call.body);
  const texts=prompt.parts.filter(part=>part.type==="text").map(part=>part.text);
  assert.ok(texts[0].includes(HISTORY_ENTRY+"OpenCode no longer had it."));assert.ok(texts[0].includes("[turn 1 · user]\nRemember the word PELICAN"));
  assert.equal(texts.at(-1),"What word did I ask you to remember?");
  const thread=threadStore.get(saved.id),turn=thread.turns.at(-1);
  assert.equal(thread.providerSessionId,"ses_1");assert.equal(thread.providerMeta.historyHandoff.status,"delivered");
  assert.deepEqual(turn.items.map(item=>item.type),["userMessage","sessionHandoff","agentMessage"]);
  assert.equal(turn.items[1].title,"OpenCode no longer had this conversation, so it continues in a new session with the earlier messages handed over.");
  assert.match(turn.items[1].reason,/^OpenCode could not resume this conversation: Session not found: ses_gone/);
  assert.deepEqual(fallbacks(journal).map(entry=>[entry.data.lostSessionId,entry.data.sessionId]),[["ses_gone","ses_1"]]);
});

test("Edit from here on the OpenCode turn that handed the history over hands the kept turns over again to the fork",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-resume-fallback-opencode-revert-")),fixture=await fakeOpenCodeServe();
  onCleanup(t,async()=>{await fixture.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,serverUrl:fixture.url};
  const runtimeManager={
    instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>"opencode",compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:"OpenCode",available:true,authenticated:true,version:"1.18.32"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),executable:()=>"opencode",
  };
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"home")}),journal=memoryJournal(),model="anthropic/claude-sonnet-4-5";
  const saved=savedThread(threadStore,{runtime:"opencode",instanceId:instance.id,providerSessionId:"ses_gone",model,cwd:root});
  threadStore.updateTurn(saved.id,saved.turns[0].id,{providerMessageId:openCodeMessageId(1n)});
  const relay=await startRelay({runtimeManager,threadStore,state:memoryState(),journal});onCleanup(t,relay.close);
  // OpenCode lost ses_gone: ses_1 takes over, and the turn hands it turn 1.
  let completed=relay.events.next(message=>message.method==="turn/completed");
  const handoff=await relay.rpc("turn/start",{threadId:saved.id,model,input:[{type:"text",text:"What word did I ask you to remember?"}]});
  assert.equal((await completed).params.turn.status,"completed");
  assert.equal(threadStore.get(saved.id).providerMeta.historyHandoff.status,"delivered");
  // Edit from here on that turn: OpenCode's copy of ses_1 before it is empty, so turn 1 waits to go over again.
  await relay.rpc("thread/revert",{threadId:saved.id,beforeTurnId:handoff.turn.id});
  const reverted=threadStore.get(saved.id),forkId=reverted.providerSessionId;
  assert.notEqual(forkId,"ses_1");assert.equal(fixture.sessions.get(forkId).messages.length,0);
  assert.deepEqual(reverted.turns.map(turn=>turn.id),[saved.turns[0].id]);
  assert.deepEqual({status:reverted.providerMeta.historyHandoff.status,sessionId:reverted.providerMeta.historyHandoff.sessionId,turnId:reverted.providerMeta.historyHandoff.turnId},{status:"pending",sessionId:forkId,turnId:undefined});
  completed=relay.events.next(message=>message.method==="turn/completed");
  const edited=await relay.rpc("turn/start",{threadId:saved.id,model,input:[{type:"text",text:"Which word was it?"}]});
  assert.equal((await completed).params.turn.status,"completed");
  const [prompt]=fixture.called(`POST /session/${forkId}/message`).map(call=>call.body);
  const texts=prompt.parts.filter(part=>part.type==="text").map(part=>part.text);
  assert.ok(texts[0].includes(HISTORY_ENTRY+"OpenCode no longer had it."));assert.ok(texts[0].includes("[turn 1 · user]\nRemember the word PELICAN"));
  assert.equal(texts[0].includes("What word did I ask you to remember?"),false,"the turn the edit dropped is not handed over");
  assert.equal(texts.at(-1),"Which word was it?");
  const thread=threadStore.get(saved.id);
  assert.equal(thread.providerMeta.historyHandoff.status,"delivered");assert.equal(thread.providerMeta.historyHandoff.turnId,edited.turn.id);
  assert.deepEqual(thread.turns.map(turn=>turn.items.filter(item=>item.type==="sessionHandoff").length),[0,1]);
  assert.equal(fallbacks(journal).length,1,"the edit is no new fallback");
});

// The SDK's Query as the Claude session drives it (see claude-agent-session.test.mjs): `turn` runs for each user message.
class Channel{
  constructor(){this.items=[];this.waiters=[];this.done=false;this.error=null}
  push(value){if(this.done)return;const waiter=this.waiters.shift();if(waiter)waiter.resolve({value,done:false});else this.items.push(value)}
  end(error=null){if(this.done)return;this.done=true;this.error=error;for(const waiter of this.waiters.splice(0))error?waiter.reject(error):waiter.resolve({value:undefined,done:true})}
  next(){
    if(this.items.length)return Promise.resolve({value:this.items.shift(),done:false});
    if(this.done)return this.error?Promise.reject(this.error):Promise.resolve({value:undefined,done:true});
    return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
  }
}
// transcripts: the sessions Claude Code has a transcript for (a query creates one). fail(options): an error the CLI exits with
// before it starts the session, or null.
function fakeClaudeSdk({transcripts=new Set(),fail=()=>null}={}){
  const calls=[];
  const query=({prompt,options})=>{
    const out=new Channel(),call={options,inputs:[]};calls.push(call);
    const failure=fail(options,calls.length);
    if(failure){setTimeout(()=>out.end(failure),20);void (async()=>{for await(const message of prompt)call.inputs.push(message)})()}
    else void (async()=>{
      let index=0;
      for await(const message of prompt){
        call.inputs.push(message);
        const sessionId=options.sessionId||options.resume;
        if(index===0){transcripts.add(sessionId);out.push({type:"system",subtype:"init",session_id:sessionId,model:"claude-test",permissionMode:options.permissionMode,tools:[],mcp_servers:[],slash_commands:[],agents:[],capabilities:[]})}
        const id=`msg-${index++}`;
        out.push({type:"assistant",uuid:`assistant-${calls.length}-${index}`,parent_tool_use_id:null,message:{id,content:[{type:"text",text:"PELICAN"}]}});
        out.push({type:"result",subtype:"success",is_error:false,result:"PELICAN",user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:3,output_tokens:1}});
      }
      out.end();
    })();
    return {next:()=>out.next(),return:()=>{out.end();return Promise.resolve({value:undefined,done:true})},[Symbol.asyncIterator](){return this},async interrupt(){},close(){out.end()},async setPermissionMode(){},initializationResult:async()=>({commands:[],agents:[],models:[]})};
  };
  const sdk={query,getSessionInfo:async id=>transcripts.has(id)?{sessionId:id}:undefined,forkSession:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  return {sdk,calls,transcripts};
}
const CLAUDE_INSTANCE={id:"claude-default",kind:"claude",displayName:"Claude Code",enabled:true};
const claudeRuntimeManager={
  instances:()=>[{...CLAUDE_INSTANCE}],activeInstance:()=>({...CLAUDE_INSTANCE}),activeRuntime:()=>"claude",compatibleInstanceIds:()=>[CLAUDE_INSTANCE.id],
  probe:async()=>({id:CLAUDE_INSTANCE.id,name:"Claude Code",available:true,authenticated:true,version:"fixture"}),
  runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),executable:()=>"claude",
};
const promptText=call=>call.inputs[0].message.content.filter(part=>part.type==="text").map(part=>part.text);
async function claudeHome(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-resume-fallback-claude-"));onCleanup(t,()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  return {root,env:{...process.env,TREBELL_HOME:join(root,"home")}};
}

test("a Claude Code transcript that is gone before the turn starts a fresh conversation with the earlier messages",async t=>{
  const {root,env}=await claudeHome(t),threadStore=new AgentThreadStore(env),journal=memoryJournal(),claude=fakeClaudeSdk();
  const saved=savedThread(threadStore,{runtime:"claude",instanceId:CLAUDE_INSTANCE.id,providerSessionId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",model:"claude-test",cwd:root});
  const relay=await startRelay({runtimeManager:claudeRuntimeManager,threadStore,state:memoryState(),journal,claudeSdk:claude.sdk});onCleanup(t,relay.close);
  const opened=await relay.rpc("thread/resume",{threadId:saved.id,cwd:root});
  assert.equal(opened.thread.turns.length,1,"the open does not fail on the lost transcript");
  const completed=relay.events.next(message=>message.method==="turn/completed");
  await relay.rpc("turn/start",{threadId:saved.id,input:[{type:"text",text:"What word did I ask you to remember?"}]});
  assert.equal((await completed).params.turn.status,"completed");
  const thread=threadStore.get(saved.id),turn=thread.turns.at(-1);
  assert.equal(claude.calls.length,1);
  assert.notEqual(thread.providerSessionId,saved.providerSessionId);
  assert.equal(claude.calls[0].options.sessionId,thread.providerSessionId);assert.equal(claude.calls[0].options.resume,undefined,"the fresh conversation is created, not resumed");
  const [context,request]=promptText(claude.calls[0]);
  assert.ok(context.includes(HISTORY_ENTRY+"Claude Code no longer had it."));assert.equal(request,"What word did I ask you to remember?");
  assert.deepEqual(turn.items.map(item=>item.type),["userMessage","sessionHandoff","agentMessage"]);
  assert.match(turn.items[1].reason,/no transcript for session aaaaaaaa-/);
  assert.deepEqual(fallbacks(journal).map(entry=>[entry.data.lostSessionId,entry.data.sessionId]),[[saved.providerSessionId,thread.providerSessionId]]);
  assert.equal(claudePersistedTurns(thread),true,"the new conversation's own turn counts for its next resume");
});

test("Claude Code saying 'No conversation found' as the query opens sends the turn once more to a fresh conversation",async t=>{
  const {root,env}=await claudeHome(t),threadStore=new AgentThreadStore(env),journal=memoryJournal(),lostId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  // The host still lists the transcript, but the CLI cannot load it.
  const claude=fakeClaudeSdk({transcripts:new Set([lostId]),fail:options=>options.resume?new Error(`Claude Code process exited with code 1. stderr: No conversation found with session ID: ${options.resume}`):null});
  const saved=savedThread(threadStore,{runtime:"claude",instanceId:CLAUDE_INSTANCE.id,providerSessionId:lostId,model:"claude-test",cwd:root});
  const relay=await startRelay({runtimeManager:claudeRuntimeManager,threadStore,state:memoryState(),journal,claudeSdk:claude.sdk});onCleanup(t,relay.close);
  const completed=relay.events.next(message=>message.method==="turn/completed");
  const started=await relay.rpc("turn/start",{threadId:saved.id,input:[{type:"text",text:"What word did I ask you to remember?"}]});
  const settled=(await completed).params.turn;
  assert.equal(settled.id,started.turn.id);assert.equal(settled.status,"completed");
  assert.equal(relay.events.seen.filter(message=>message.method==="turn/completed").length,1,"one turn, completed once");
  assert.equal(relay.events.seen.some(message=>message.method==="error"),false,"the lost conversation is not an error");
  assert.deepEqual(claude.calls.map(call=>[call.options.resume??null,call.options.sessionId??null]),[[lostId,null],[null,threadStore.get(saved.id).providerSessionId]]);
  assert.equal(promptText(claude.calls[0]).some(text=>text.includes("trebell.thread_history")),false,"the first send had no handoff");
  const [context,request]=promptText(claude.calls[1]);
  assert.ok(context.includes(HISTORY_ENTRY+"Claude Code no longer had it."));assert.equal(request,"What word did I ask you to remember?");
  const turn=threadStore.get(saved.id).turns.at(-1);
  assert.deepEqual(turn.items.map(item=>item.type),["userMessage","sessionHandoff","agentMessage"]);
  assert.equal(userMessages(turn).length,1,"the user's message is in the thread once");
  assert.match(turn.items[1].reason,/No conversation found with session ID/);
  assert.deepEqual(fallbacks(journal).map(entry=>entry.data.lostSessionId),[lostId]);
});

test("the second send to a fresh Claude Code conversation never sends again: its failure fails the turn and keeps the message",async t=>{
  const {root,env}=await claudeHome(t),threadStore=new AgentThreadStore(env),journal=memoryJournal(),lostId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const claude=fakeClaudeSdk({transcripts:new Set([lostId]),fail:options=>new Error(`Claude Code process exited with code 1. stderr: No conversation found with session ID: ${options.resume||options.sessionId}`)});
  const saved=savedThread(threadStore,{runtime:"claude",instanceId:CLAUDE_INSTANCE.id,providerSessionId:lostId,model:"claude-test",cwd:root});
  const relay=await startRelay({runtimeManager:claudeRuntimeManager,threadStore,state:memoryState(),journal,claudeSdk:claude.sdk});onCleanup(t,relay.close);
  const completed=relay.events.next(message=>message.method==="turn/completed");
  await relay.rpc("turn/start",{threadId:saved.id,input:[{type:"text",text:"What word did I ask you to remember?"}]});
  const settled=(await completed).params.turn;
  assert.equal(settled.status,"failed");assert.match(settled.error.message,/No conversation found/);
  assert.equal(claude.calls.length,2,"one send and one more, no loop");
  const thread=threadStore.get(saved.id),turn=thread.turns.at(-1);
  assert.deepEqual(turn.items.map(item=>item.type),["userMessage"],"the message stays in the thread, once");
  assert.equal(thread.providerMeta.historyHandoff.status,"pending","the fresh conversation never had the history");
});

test("a pending handoff waits through a failed turn and a restart, and the next prompt that reaches Claude Code carries it",async t=>{
  const {root,env}=await claudeHome(t),journal=memoryJournal(),lostId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  let failFresh=true;
  const claude=fakeClaudeSdk({fail:options=>options.sessionId&&failFresh?new Error("Claude Code process exited with code 1. stderr: Could not connect to the API"):null});
  const first=new AgentThreadStore(env);
  const saved=savedThread(first,{runtime:"claude",instanceId:CLAUDE_INSTANCE.id,providerSessionId:lostId,model:"claude-test",cwd:root});
  const before=await startRelay({runtimeManager:claudeRuntimeManager,threadStore:first,state:memoryState(),journal,claudeSdk:claude.sdk});
  const failed=before.events.next(message=>message.method==="turn/completed");
  await before.rpc("turn/start",{threadId:saved.id,input:[{type:"text",text:"What word did I ask you to remember?"}]});
  assert.equal((await failed).params.turn.status,"failed");
  const pending=first.get(saved.id);
  assert.equal(pending.providerMeta.historyHandoff.status,"pending","a turn that failed before the prompt reached Claude Code keeps it waiting");
  assert.equal(pending.turns.at(-1).items.some(item=>item.type==="sessionHandoff"),false,"no row for a handoff that did not happen");
  const freshId=pending.providerSessionId;assert.notEqual(freshId,lostId);
  await before.close();
  // A restart: a new store over the same folder and a new relay.
  failFresh=false;
  const threadStore=new AgentThreadStore(env);
  assert.equal(threadStore.get(saved.id).providerMeta.historyHandoff.status,"pending","the waiting handoff survives the restart");
  const relay=await startRelay({runtimeManager:claudeRuntimeManager,threadStore,state:memoryState(),journal,claudeSdk:claude.sdk});onCleanup(t,relay.close);
  const completed=relay.events.next(message=>message.method==="turn/completed");
  await relay.rpc("turn/start",{threadId:saved.id,input:[{type:"text",text:"Try again: which word?"}]});
  assert.equal((await completed).params.turn.status,"completed");
  const last=claude.calls.at(-1);
  assert.deepEqual([last.options.resume??null,last.options.sessionId??null],[null,freshId],"the fresh conversation, created by its first prompt");
  const [context,request]=promptText(last);
  assert.ok(context.includes("[turn 1 · user]\nRemember the word PELICAN"));
  assert.ok(context.includes("[turn 2 · user]\nWhat word did I ask you to remember?\n\n[turn 2 · error]\n"),"the failed turn is part of the earlier conversation");
  assert.equal(request,"Try again: which word?");
  const thread=threadStore.get(saved.id);
  assert.deepEqual(thread.turns.map(turn=>turn.items.filter(item=>item.type==="userMessage").length),[1,1,1],"every message once");
  assert.deepEqual(thread.turns.map(turn=>turn.items.filter(item=>item.type==="sessionHandoff").length),[0,0,1]);
  assert.equal(thread.providerMeta.historyHandoff.status,"delivered");assert.equal(thread.providerMeta.historyHandoff.turnId,thread.turns[2].id);
  assert.equal(fallbacks(journal).length,1,"one fallback: the restart resumed the fresh conversation's id");
});

// Claude Code as it treats a rewind cursor: a fork or resume of a session it has no transcript for, or at a message that
// transcript lacks, exits before the session starts; a fork copies the source transcript up to the cursor.
function claudeTranscriptSdk(){
  const calls=[],transcripts=new Map();
  const query=({prompt,options})=>{
    const out=new Channel(),call={options,inputs:[]};calls.push(call);
    const source=options.resume||null,target=options.sessionId||options.resume;
    const missingCursor=options.resumeSessionAt&&!(transcripts.get(source)||[]).includes(options.resumeSessionAt);
    if(missingCursor||(source&&!transcripts.has(source))){
      const reason=missingCursor?`No message found with message.uuid of: ${options.resumeSessionAt}`:`No conversation found with session ID: ${source}`;
      setTimeout(()=>out.end(new Error(`Claude Code process exited with code 1. stderr: ${reason}`)),20);
      void (async()=>{for await(const message of prompt)call.inputs.push(message)})();
    }else void (async()=>{
      if(options.forkSession){const kept=transcripts.get(source)||[],cut=options.resumeSessionAt?kept.indexOf(options.resumeSessionAt)+1:kept.length;transcripts.set(target,kept.slice(0,cut))}
      if(!transcripts.has(target))transcripts.set(target,[]);
      let index=0;
      for await(const message of prompt){
        call.inputs.push(message);
        if(index===0)out.push({type:"system",subtype:"init",session_id:target,model:"claude-test",permissionMode:options.permissionMode,tools:[],mcp_servers:[],slash_commands:[],agents:[],capabilities:[]});
        const uuid=`assistant-${calls.length}-${++index}`;transcripts.get(target).push(uuid);
        out.push({type:"assistant",uuid,parent_tool_use_id:null,message:{id:`msg-${uuid}`,content:[{type:"text",text:"PELICAN"}]}});
        out.push({type:"result",subtype:"success",is_error:false,result:"PELICAN",user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:3,output_tokens:1}});
      }
      out.end();
    })();
    return {next:()=>out.next(),return:()=>{out.end();return Promise.resolve({value:undefined,done:true})},[Symbol.asyncIterator](){return this},async interrupt(){},close(){out.end()},async setPermissionMode(){},initializationResult:async()=>({commands:[],agents:[],models:[]})};
  };
  const sdk={query,getSessionInfo:async id=>transcripts.has(id)?{sessionId:id}:undefined,forkSession:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  return {sdk,calls,transcripts};
}

test("Edit from here on the Claude Code turn that handed the history over runs the edit in a fresh conversation handed the kept turns",async t=>{
  const {root,env}=await claudeHome(t),threadStore=new AgentThreadStore(env),journal=memoryJournal(),claude=claudeTranscriptSdk();
  const saved=savedThread(threadStore,{runtime:"claude",instanceId:CLAUDE_INSTANCE.id,providerSessionId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",model:"claude-test",cwd:root});
  const relay=await startRelay({runtimeManager:claudeRuntimeManager,threadStore,state:memoryState(),journal,claudeSdk:claude.sdk});onCleanup(t,relay.close);
  const run=async text=>{const completed=relay.events.next(message=>message.method==="turn/completed");const started=await relay.rpc("turn/start",{threadId:saved.id,input:[{type:"text",text}]});const settled=(await completed).params.turn;assert.equal(settled.status,"completed");return started.turn.id};
  // The transcript is gone: S2 takes over and the turn hands it turn 1, whose message is only in the lost transcript.
  const handoffTurn=await run("What word did I ask you to remember?"),freshId=threadStore.get(saved.id).providerSessionId;
  await relay.rpc("thread/revert",{threadId:saved.id,beforeTurnId:handoffTurn});
  const reverted=threadStore.get(saved.id);
  assert.notEqual(reverted.providerSessionId,freshId);assert.equal(reverted.providerMeta.claudeFork,undefined,"no fork at a message S2 never had");
  assert.deepEqual([reverted.providerMeta.historyHandoff.status,reverted.providerMeta.historyHandoff.sessionId],["pending",reverted.providerSessionId]);
  const edited=await run("Which word was it, exactly?");
  const asked=claude.calls.at(-1);
  assert.deepEqual([asked.options.resume??null,asked.options.resumeSessionAt??null,asked.options.sessionId],[null,null,reverted.providerSessionId],"a fresh conversation, created by the edited message");
  const [context,request]=promptText(asked);
  assert.ok(context.includes("[turn 1 · user]\nRemember the word PELICAN"));assert.equal(context.includes("What word did I ask"),false);
  assert.equal(request,"Which word was it, exactly?");
  let thread=threadStore.get(saved.id);
  assert.deepEqual(thread.turns.map(turn=>turn.id),[saved.turns[0].id,edited]);
  assert.deepEqual(thread.turns.map(turn=>turn.items.filter(item=>item.type==="sessionHandoff").length),[0,1]);
  assert.equal(relay.events.seen.some(message=>message.method==="error"||message.method==="thread/reverted"&&message.params.recovered),false,"nothing was rejected or put back");
  // Edit from here on a later turn forks the new conversation at the turn that handed the history over, which it keeps.
  const later=await run("And the next one?");
  await relay.rpc("thread/revert",{threadId:saved.id,beforeTurnId:later});
  const cursor=thread.turns[1].providerMessageId;assert.ok(cursor);
  await run("Spell it.");
  const forked=claude.calls.at(-1);
  assert.deepEqual([forked.options.resume,forked.options.forkSession,forked.options.resumeSessionAt],[thread.providerSessionId,true,cursor]);
  assert.equal(promptText(forked).some(text=>text.includes("trebell.thread_history")),false,"the fork has the history already");
  thread=threadStore.get(saved.id);
  assert.equal(thread.providerMeta.historyHandoff.status,"delivered");assert.equal(thread.providerMeta.historyHandoff.turnId,edited);
  assert.equal(fallbacks(journal).length,1);
});

test("restart recovery of a lost conversation hands the fresh session the interrupted turn's message too",async t=>{
  const fx=await acpHarness(t,"grok"),threadStore=new AgentThreadStore(fx.env),journal=memoryJournal();
  const saved=savedThread(threadStore,{runtime:"grok",instanceId:fx.harness.instance.id,providerSessionId:"grok-lost",cwd:fx.root});
  const interrupted=threadStore.addTurn(saved.id,{inputText:"Fix the refresh bug"});
  assert.deepEqual(threadStore.reconcileRestart({continueAfterRestart:true}).map(item=>item.turnId),[interrupted.id]);
  const relay=await startRelay({runtimeManager:fx.runtimeManager,threadStore,state:memoryState({continueThreadsAfterRestart:true}),journal});onCleanup(t,relay.close);
  const completed=relay.events.next(message=>message.method==="turn/completed");
  relay.ws.send(JSON.stringify({method:"initialized"}));
  const settled=(await completed).params.turn;
  assert.equal(settled.id,interrupted.id);assert.equal(settled.status,"completed");
  const [prompt]=(await fx.requests()).filter(entry=>entry.method==="session/prompt");
  assert.equal(prompt.params.sessionId,"fresh-1");
  assert.ok(prompt.params.prompt[0].text.includes("[turn 2 · user]\nFix the refresh bug"),"the interrupted turn's message is handed over");
  assert.deepEqual(prompt.params.prompt[1],{type:"text",text:"Continue where you left off."});
  assert.deepEqual(threadStore.get(saved.id).turns.at(-1).items.map(item=>item.type),["userMessage","sessionHandoff","agentMessage"]);
});

test("Trebell Native ignores a handoff record and keeps its measured envelope",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-resume-fallback-native-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  onCleanup(t,()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),requests=[];
  const nativeProviderTurn=async request=>{requests.push(request.messages);return {id:"native-answer-"+requests.length,provider:request.provider,model:request.model,text:"OK",toolCalls:[],finishReason:"stop",usage:{inputTokens:4,outputTokens:1,totalTokens:5}}};
  const relay=await startRelay({runtimeManager,threadStore,state,nativeProviderTurn});onCleanup(t,relay.close);
  const started=await relay.rpc("thread/start",{model:"model-a",modelProvider:"openai",cwd:repo,projectless:false,approvalPolicy:"never",sandbox:"read-only",dynamicTools:[]});
  const first=relay.events.next(message=>message.method==="turn/completed");
  await relay.rpc("turn/start",{threadId:started.thread.id,model:"model-a",modelProvider:"openai",input:[{type:"text",text:"Remember PELICAN"}]});await first;
  const meta=threadStore.get(started.thread.id).providerMeta;
  threadStore.update(started.thread.id,{providerMeta:{...meta,historyHandoff:{status:"pending",runtime:"native",previousSessionId:"x",sessionId:"y"}}});
  const second=relay.events.next(message=>message.method==="turn/completed");
  await relay.rpc("turn/start",{threadId:started.thread.id,model:"model-a",modelProvider:"openai",input:[{type:"text",text:"Which word?"}],additionalContext:{"trebell.repo_evidence":{kind:"untrusted",value:"evidence"}}});await second;
  const user=requests[1].findLast(message=>message.role==="user");
  assert.ok(user.content[0].text.startsWith("Trebell supplied the following bounded working context before the user's message."));
  assert.equal(JSON.stringify(requests[1]).includes("thread_history"),false);
  assert.equal(threadStore.get(started.thread.id).turns.at(-1).items.some(item=>item.type==="sessionHandoff"),false);
  assert.equal(threadStore.get(started.thread.id).providerMeta.historyHandoff.status,"pending");
});
