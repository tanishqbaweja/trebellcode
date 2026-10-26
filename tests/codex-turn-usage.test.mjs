import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket,WebSocketServer } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";

// Codex's thread/tokenUsage/updated: total is the thread's running total, last the newest model request's usage.
const FIELDS=["totalTokens","inputTokens","cachedInputTokens","cacheWriteInputTokens","outputTokens","reasoningOutputTokens"];
const request=(input,output,{cached=0,write=0,reasoning=0}={})=>({totalTokens:input+output,inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:write,outputTokens:output,reasoningOutputTokens:reasoning});
const add=(...items)=>Object.fromEntries(FIELDS.map(key=>[key,items.reduce((sum,item)=>sum+(item[key]||0),0)]));
const update=(total,last)=>({total,last,modelContextWindow:200_000});
const usageModule=()=>import("../src/codex-turn-usage.mjs");

test("A Codex turn counts the growth of the thread's total over all its model requests",async()=>{
  const {createCodexTurnUsage}=await usageModule(),usage=createCodexTurnUsage();
  const earlier=request(40_000,6_000,{cached:30_000}),r1=request(9_000,400,{cached:8_000}),r2=request(9_600,700,{cached:9_000,reasoning:200}),r3=request(10_200,1_100,{cached:9_500,write:300});
  assert.equal(usage.update({threadId:"t",turnId:"turn-0",tokenUsage:update(earlier,earlier),running:false}),null,"a turn that does not run records nothing");
  usage.update({threadId:"t",turnId:"turn-1",tokenUsage:update(add(earlier,r1),r1),running:true});
  usage.update({threadId:"t",turnId:"turn-1",tokenUsage:update(add(earlier,r1,r2),r2),running:true});
  assert.deepEqual(usage.update({threadId:"t",turnId:"turn-1",tokenUsage:update(add(earlier,r1,r2,r3),r3),running:true}),add(r1,r2,r3),"three requests count as three");
});

test("The first Codex update with no earlier total uses the request's own usage, and so does a total that went down",async()=>{
  const {createCodexTurnUsage}=await usageModule(),usage=createCodexTurnUsage();
  const restored=request(120_000,9_000),r1=request(8_000,500),r2=request(8_400,900);
  assert.deepEqual(usage.update({threadId:"t",turnId:"turn-1",tokenUsage:update(add(restored,r1),r1),running:true}),r1,"after a resume the thread's whole total is not this turn's");
  assert.deepEqual(usage.update({threadId:"t",turnId:"turn-1",tokenUsage:update(add(restored,r1,r2),r2),running:true}),add(r1,r2));
  const compacted=request(3_000,600),r3=request(3_000,600);
  assert.deepEqual(usage.update({threadId:"t",turnId:"turn-1",tokenUsage:update(compacted,r3),running:true}),add(r1,r2,r3),"a smaller total (a compaction) counts its last request");
  const r4=request(3_500,250);
  assert.deepEqual(usage.update({threadId:"t",turnId:"turn-1",tokenUsage:update(add(compacted,r4),r4),running:true}),add(r1,r2,r3,r4),"and the growth from there");
});

test("A late Codex update for a finished turn changes nothing and only moves the thread's total along",async()=>{
  const {createCodexTurnUsage}=await usageModule(),usage=createCodexTurnUsage();
  const r1=request(5_000,300),r2=request(5_500,450),late=request(200,20),next=request(6_000,500);
  usage.update({threadId:"t",turnId:"turn-1",tokenUsage:update(r1,r1),running:true});
  assert.deepEqual(usage.update({threadId:"t",turnId:"turn-1",tokenUsage:update(add(r1,r2),r2),running:true}),add(r1,r2));
  assert.equal(usage.update({threadId:"t",turnId:"turn-1",tokenUsage:update(add(r1,r2,late),late),running:false}),null);
  assert.deepEqual(usage.update({threadId:"t",turnId:"turn-2",tokenUsage:update(add(r1,r2,late,next),next),running:true}),next,"the next turn counts only its own requests");
});

test("Copies of a Codex update that other windows get count once, in any order, and parts never exceed their whole",async()=>{
  const {createCodexTurnUsage}=await usageModule(),usage=createCodexTurnUsage();
  const r1=request(5_000,300),r2=request(5_500,450),first=update(r1,r1),second=update(add(r1,r2),r2);
  for(const item of [first,first,second,first,second])usage.update({threadId:"t",turnId:"turn-1",tokenUsage:item,running:true});
  assert.deepEqual(usage.update({threadId:"t",turnId:"turn-1",tokenUsage:second,running:true}),null,"a copy records nothing new");
  const r3=request(6_000,500);
  assert.deepEqual(usage.update({threadId:"t",turnId:"turn-1",tokenUsage:update(add(r1,r2,r3),r3),running:true}),add(r1,r2,r3));
  const odd=createCodexTurnUsage(),bad={totalTokens:150,inputTokens:100,cachedInputTokens:180,cacheWriteInputTokens:120,outputTokens:50,reasoningOutputTokens:70};
  assert.deepEqual(odd.update({threadId:"t",turnId:"turn-1",tokenUsage:update(bad,bad),running:true}),{totalTokens:150,inputTokens:100,cachedInputTokens:100,cacheWriteInputTokens:100,outputTokens:50,reasoningOutputTokens:50});
});

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws}
function rpcClient(ws){
  let id=0;
  return (method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);if(message.error)reject(Object.assign(new Error(message.error.message),{code:message.error.code}));else resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
}
// A Codex app-server whose notifications the test sends: notify() to every connection, as Codex sends a thread's events to each window
// that shows it; a resume gets the thread's last token usage replayed on its own connection, as Codex does (token_usage_replay.rs).
async function fakeCodexAppServer(port,{replay}){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set();let turns=0;
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
      const params=message.params||{},reply=result=>ws.send(JSON.stringify({id:message.id,result}));
      if(message.method==="turn/start")return reply({turn:{id:"usage-turn-"+(++turns),status:"inProgress",items:[]}});
      if(message.method==="thread/resume"){reply({thread:{id:params.threadId,status:{type:"idle"},turns:[]}});const last=replay();if(last)ws.send(JSON.stringify({method:"thread/tokenUsage/updated",params:last}));return}
      if(message.method==="thread/read")return reply({thread:{id:params.threadId,status:{type:"idle"},turns:[]}});
      reply({});
    });
  });
  await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {connections:()=>sockets.size,notify(method,params){for(const ws of sockets)ws.send(JSON.stringify({method,params}))},async close(){for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

test("The Usage record of a Codex turn holds all its model requests, once, whatever a resume replays or a late update says",async()=>{
  const threadId="codex-usage-thread";let lastUpdate=null;
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-usage-")),[port,appPort]=await Promise.all([freePort(),freePort()]),upstream=await fakeCodexAppServer(appPort,{replay:()=>lastUpdate});
  const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});let first,second;
  const tokenUsage=(turnId,total,last)=>{lastUpdate={threadId,turnId,tokenUsage:update(total,last)};upstream.notify("thread/tokenUsage/updated",lastUpdate)};
  const record=async turnId=>(await fetch(gui.url+"/api/usage?days=1").then(response=>response.json())).records.find(item=>item.turnId===turnId)||null;
  try{
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,patch:{runtime:"codex",runtimeInstanceId:"codex-default",environmentId:null,cwd:home,active:false}})});
    first=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");second=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");
    const window1=rpcClient(first),window2=rpcClient(second);
    // Both windows show the thread, so each update reaches the server twice. A request each that Codex answers after them makes sure
    // the server has read every update sent before.
    await Promise.all([window1("thread/read",{threadId}),window2("thread/read",{threadId})]);assert.equal(upstream.connections(),2);
    const settle=()=>Promise.all([window1("config/read",{}),window2("config/read",{})]);
    const earlier=request(60_000,7_000,{cached:50_000}),r1=request(12_000,500,{cached:11_000}),r2=request(12_600,900,{cached:12_000,reasoning:300}),r3=request(13_300,1_400,{cached:12_500,write:400});
    const turn1=(await window1("turn/start",{threadId,input:[{type:"text",text:"Fix the parser"}]})).turn.id;
    upstream.notify("turn/started",{threadId,turn:{id:turn1,status:"inProgress",items:[]}});
    tokenUsage(turn1,add(earlier,r1),r1);tokenUsage(turn1,add(earlier,r1,r2),r2);tokenUsage(turn1,add(earlier,r1,r2,r3),r3);
    upstream.notify("turn/completed",{threadId,turn:{id:turn1,status:"completed",items:[]}});await settle();
    assert.deepEqual((await record(turn1))?.usage,add(r1,r2,r3),"the turn's record is its three requests, not the last one, the thread's total or twice the windows' copies");
    await window2("thread/resume",{threadId});await settle();
    assert.deepEqual((await record(turn1))?.usage,add(r1,r2,r3),"a window that resumes the thread gets the last usage replayed, and the record stays");

    const r4=request(14_000,800),compacted=request(4_000,700),r5=request(4_000,700),late=request(300,40);
    const turn2=(await window1("turn/start",{threadId,input:[{type:"text",text:"Now the tests"}]})).turn.id;
    upstream.notify("turn/started",{threadId,turn:{id:turn2,status:"inProgress",items:[]}});
    tokenUsage(turn2,add(earlier,r1,r2,r3,r4),r4);tokenUsage(turn2,compacted,r5);
    upstream.notify("turn/completed",{threadId,turn:{id:turn2,status:"completed",items:[]}});tokenUsage(turn2,add(compacted,late),late);await settle();
    assert.deepEqual((await record(turn2))?.usage,add(r4,r5),"a compaction's smaller total counts its request, and a late update after the turn changes nothing");
    const usage=await fetch(gui.url+"/api/usage?days=1").then(response=>response.json());
    assert.equal(usage.records.filter(item=>item.runtime==="codex").length,2);
    assert.equal(usage.total.totalTokens,add(r1,r2,r3,r4,r5).totalTokens,"the Usage page's total counts every request once");
  }finally{
    try{first?.close()}catch{}try{second?.close()}catch{}await gui.close();await upstream.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});
