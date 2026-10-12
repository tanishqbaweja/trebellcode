import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

const require=createRequire(import.meta.url);
const sqlite=require("node:sqlite");

// Performance budgets for the server's state, its Codex relay hook and its HTTP serving, as load-independent counts (the perf plan's
// section 2).
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Counts, while on, the sqlite connections, statements and write transactions of every store built after it is installed (they take
// DatabaseSync from node:sqlite when constructed), and the JSON the process parses.
function processCounter(){
  const counts={opens:0,statements:0,writes:0,parsedChars:0},RealDatabase=sqlite.DatabaseSync,realParse=JSON.parse;let on=false;
  sqlite.DatabaseSync=class extends RealDatabase{
    constructor(...args){super(...args);if(on)counts.opens++}
    prepare(sql){if(on)counts.statements++;return super.prepare(sql)}
    exec(sql){if(on&&/BEGIN IMMEDIATE/i.test(String(sql)))counts.writes++;return super.exec(sql)}
  };
  JSON.parse=function(text,reviver){if(on&&typeof text==="string")counts.parsedChars+=text.length;return realParse.call(this,text,reviver)};
  return {counts,start(){for(const key of Object.keys(counts))counts[key]=0;on=true},stop(){on=false},restore(){sqlite.DatabaseSync=RealDatabase;JSON.parse=realParse}};
}

// B5: the Codex relay hook read the thread meta twice from sqlite (a connection each, plus a parse and a clone of the whole meta) and
// the settings for every upstream message, before the journal dropped deltas as noise (scripts/perf/codex-relay.mjs: 2 connections
// and 198 KB parsed per delta with a 50 KB meta). It now skips the lookups for a method the journal drops, and the state store keeps
// its connection and the meta it last read or wrote.
test("B5: a Codex reply delta through the relay opens no sqlite connection and parses none of the thread's meta",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-budget-b5-")),[port,appPort]=await Promise.all([freePort(),freePort()]),counter=processCounter();
  const upstreamHttp=createServer(),wss=new WebSocketServer({noServer:true});
  upstreamHttp.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!=null&&message.method)ws.send(JSON.stringify({id:message.id,result:{}}))}));
  let gui=null,client=null;
  try{
    await new Promise((resolve,reject)=>upstreamHttp.listen(appPort,"127.0.0.1",resolve).once("error",reject));
    gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});
    const threadId="codex-budget-b5";
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,patch:{runtime:"codex",runtimeInstanceId:"codex-default",cwd:home,environmentId:null,codexToolCallIds:Array.from({length:1500},(_,i)=>"call_"+i.toString(36).padStart(24,"0"))}})});
    client=new WebSocket(gui.url.replace(/^http/,"ws")+"/api/codex/ws");await new Promise((resolve,reject)=>{client.once("open",resolve);client.once("error",reject)});
    const arrived={};client.on("message",raw=>{const method=/"method":"([^"]+)"/.exec(String(raw).slice(0,120))?.[1]||"(reply)";arrived[method]=(arrived[method]||0)+1});
    client.send(JSON.stringify({id:1,method:"model/list",params:{}}));
    for(let i=0;i<500&&!arrived["(reply)"];i++)await sleep(10);
    assert.ok(arrived["(reply)"],"the relay opened its upstream connection");
    const send=(method,make,count)=>{const before=arrived[method]||0,messages=Array.from({length:count},make);counter.start();for(const text of messages)for(const socket of wss.clients)socket.send(text);return (async()=>{for(let i=0;i<3000&&(arrived[method]||0)-before<count;i++)await sleep(2);counter.stop();assert.equal((arrived[method]||0)-before,count,method+" all arrived");return {...counter.counts}})()};
    const deltas=200,delta=await send("item/agentMessage/delta",()=>JSON.stringify({method:"item/agentMessage/delta",params:{threadId,turnId:"turn-1",itemId:"item-1",delta:"tok "}}),deltas);
    assert.equal(delta.opens,0,"sqlite connections for "+deltas+" deltas");assert.equal(delta.statements,0,"sqlite statements for "+deltas+" deltas");assert.equal(delta.writes,0);
    // The relay parses each message once (about 130 characters); the meta is 48 KB.
    assert.ok(delta.parsedChars/deltas<=512,"JSON characters parsed per delta: "+delta.parsedChars/deltas);
    // A tool call is recorded (one write each) on the connection the store keeps.
    let toolSequence=0;const tools=20,tool=await send("item/started",()=>JSON.stringify({method:"item/started",params:{threadId,turnId:"turn-1",item:{type:"commandExecution",id:"tool-"+(++toolSequence),command:["npm","test"],status:"inProgress"}}}),tools);
    assert.equal(tool.opens,0,"sqlite connections for "+tools+" tool calls");assert.equal(tool.writes,tools,"one write transaction per tool call");
    const meta=await fetch(gui.url+"/api/thread-meta?threadId="+threadId).then(response=>response.json());
    assert.equal(meta.codexToolCallCount,tools);assert.deepEqual(meta.codexToolCallIds.slice(-2),["turn-1:tool-19","turn-1:tool-20"]);
    // The server answers from the meta it keeps, so check the row too.
    const db=new sqlite.DatabaseSync(join(home,"trebell.sqlite"));
    try{const row=JSON.parse(db.prepare("SELECT payload_json FROM state_thread_meta WHERE thread_id=?").get(threadId).payload_json);assert.deepEqual(row,meta)}finally{db.close()}
  }finally{counter.restore();client?.close();await gui?.close();for(const socket of wss.clients)socket.terminate();wss.close();await new Promise(resolve=>upstreamHttp.close(resolve));await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});

// B10: on every load the page posts the catalog fields of each listed thread it has not seen in this tab (100 on the perf home), and
// each POST /api/thread-meta was a sqlite write transaction even when nothing had changed (scripts/perf/reload.mjs: 100 write
// transactions on a reload and on a restart). A patch that changes nothing but the time is no longer written.
test("B10: re-posting a thread's unchanged catalog fields makes no write transaction and keeps its updatedAt",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-budget-b10-")),env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);let writes=0;
    state.collections.DatabaseSync=class extends sqlite.DatabaseSync{exec(sql){if(/BEGIN IMMEDIATE/i.test(String(sql)))writes++;return super.exec(sql)}};
    const snapshot={id:"thread-b10",name:"Fix the build",preview:"The build fails on main",cwd:home,model:"gpt-5",updatedAt:1000,createdAt:900,status:{type:"idle",activeFlags:[]},section:null,projectId:null,runtime:"codex",provider:"openai"};
    const patch={runtime:"codex",provider:"openai",runtimeInstanceId:"codex-default",model:"gpt-5",threadSnapshot:snapshot};
    const first=state.updateThreadMeta("thread-b10",patch);assert.equal(writes,1,"the first post is written");
    await new Promise(resolve=>setTimeout(resolve,5));
    // The page sends the same fields again as JSON, on every load.
    const again=state.updateThreadMeta("thread-b10",JSON.parse(JSON.stringify(patch)));
    assert.equal(writes-1,0,"write transactions for an unchanged post");assert.deepEqual(again,first);assert.equal(again.updatedAt,first.updatedAt);
    const changed=state.updateThreadMeta("thread-b10",{...patch,threadSnapshot:{...snapshot,name:"Fix the build on main"}});
    assert.equal(writes-1,1,"a changed field is written");assert.ok(changed.updatedAt>first.updatedAt);
  }finally{await rm(home,{recursive:true,force:true})}
});

// B12b: a reload or a restart fetched the whole bundle again (1,577 KB on the perf home, scripts/perf/reload.mjs), because nothing
// was served with a cache header. Hashed assets are now kept for good and index.html is revalidated.
test("B12b: hashed assets are served immutable and index.html revalidates to a 304 that carries no body",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-budget-b12b-")),dist=join(home,"dist"),[port,appPort]=await Promise.all([freePort(),freePort()]);
  await mkdir(join(dist,"assets"),{recursive:true});
  await writeFile(join(dist,"index.html"),'<!doctype html><script type="module" src="/assets/index-Bf3x9Q2a.js"></script>');
  await writeFile(join(dist,"assets","index-Bf3x9Q2a.js"),"console.log('app')");await writeFile(join(dist,"trebell-code-icon.svg"),"<svg/>");
  let gui=null;
  try{
    gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:join(home,"home"),TREBELL_UI_DIST:dist}});
    const get=(path,headers={})=>fetch(gui.url+path,{headers});
    const asset=await get("/assets/index-Bf3x9Q2a.js");
    assert.equal(asset.status,200);assert.equal(asset.headers.get("cache-control"),"public, max-age=31536000, immutable");assert.equal(await asset.text(),"console.log('app')");
    const page=await get("/"),etag=page.headers.get("etag");
    assert.equal(page.status,200);assert.equal(page.headers.get("cache-control"),"no-cache");assert.match(etag,/^W\/"[0-9a-f]+-[0-9a-f]+"$/);assert.match(await page.text(),/index-Bf3x9Q2a\.js/);
    for(const path of ["/","/index.html","/threads/some-route"]){
      const again=await get(path,{"if-none-match":etag});
      assert.equal(again.status,304,path);assert.equal(again.headers.get("etag"),etag);assert.equal(await again.text(),"",path+" sends no body");
    }
    // A missing asset falls back to index.html, which must not be cached as if it were the asset.
    const missing=await get("/assets/gone-0000aaaa.js");
    assert.equal(missing.status,200);assert.match(missing.headers.get("content-type"),/text\/html/);assert.equal(missing.headers.get("cache-control"),"no-cache");
    // A file outside assets/ has no hash in its name, so it revalidates as index.html does.
    const icon=await get("/trebell-code-icon.svg");
    assert.equal(icon.headers.get("cache-control"),"no-cache");assert.equal(await icon.text(),"<svg/>");
    assert.equal((await get("/trebell-code-icon.svg",{"if-none-match":icon.headers.get("etag")})).status,304);
    // A new build changes index.html, and the old tag no longer matches.
    await new Promise(resolve=>setTimeout(resolve,20));
    await writeFile(join(dist,"index.html"),'<!doctype html><script type="module" src="/assets/index-Zz81kLm0.js"></script>');
    const rebuilt=await get("/",{"if-none-match":etag});
    assert.equal(rebuilt.status,200);assert.notEqual(rebuilt.headers.get("etag"),etag);assert.match(await rebuilt.text(),/index-Zz81kLm0\.js/);
  }finally{await gui?.close();await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});
