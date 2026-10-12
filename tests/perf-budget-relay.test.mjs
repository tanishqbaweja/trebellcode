import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";

const require=createRequire(import.meta.url);
const {DatabaseSync,StatementSync}=require("node:sqlite");

// Performance budgets for the relay and its thread store, as load-independent counts (the perf plan's section 2).

// B4: a thread read lists its turns in COALESCE(started_at,0),rowid order. Sorting that in a temporary B-tree held every payload and
// spilled to a TEMP file past about 2 MB of history (2,059 KB written per read of a 2 MB thread); an index on the expression is walked.
test("B4: the turn listings a thread read prepares use no temporary B-tree and keep their order",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-budget-b4-")),env={...process.env,TREBELL_HOME:home},path=join(home,"trebell.sqlite");
  try{
    const store=new AgentThreadStore(env);
    const turn=(id,startedAt)=>({id,startedAt,items:[{type:"userMessage",id:"user-"+id,content:[{type:"text",text:"turn "+id}]}]});
    const thread=store.importHistory({runtime:"claude",cwd:home,providerSessionId:"budget-b4",turns:[turn("c",30),turn("a",null),turn("b",30),turn("d",10),turn("e",null)]});
    const prepared=[];
    store.storage.DatabaseSync=class extends DatabaseSync{prepare(sql){prepared.push(String(sql));return super.prepare(sql)}};
    // A turn with no start time sorts first, and equal times keep the order the turns were written in.
    assert.deepEqual(store.get(thread.id).turns.map(item=>item.id),["a","e","d","c","b"]);
    store.storage.untitledFirstMessages();
    const listings=[...new Set(prepared.filter(sql=>/FROM agent_turns\b/i.test(sql)&&/ORDER BY/i.test(sql)))];
    assert.equal(listings.length,2,"get() and the untitled-title read each list a thread's turns");
    const db=new DatabaseSync(path);
    try{
      for(const sql of listings){const plan=db.prepare("EXPLAIN QUERY PLAN "+sql).all().map(row=>String(row.detail));assert.ok(!plan.some(detail=>/TEMP B-TREE/i.test(detail)),sql+" plans "+plan.join("; "))}
      // A home made before the index gets it at the next start.
      db.exec("DROP INDEX agent_turns_thread_order_idx");
    }finally{db.close()}
    new AgentThreadStore(env);
    const reopened=new DatabaseSync(path);
    try{assert.ok(reopened.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='agent_turns_thread_order_idx'").get())}finally{reopened.close()}
  }finally{await rm(home,{recursive:true,force:true})}
});

// The relay end to end on an isolated home, with a scripted ACP agent (the shape of tests/agent-relay.test.mjs's fake) run as a
// Grok Build harness. Each session/prompt streams the plan in plan.json, and waits for the files the plan names before and after
// its stream, so a test can count the stream alone. No model and no real harness is involved.
const BUDGET_AGENT=String.raw`
import readline from "node:readline";
import { existsSync, readFileSync } from "node:fs";
const sessionId="budget-session";
const send=message=>process.stdout.write(JSON.stringify(message)+"\n");
const update=value=>send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:value}});
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function until(file){while(file&&!existsSync(file))await sleep(5)}
// Paced against the clock, not per timer tick (Windows rounds a short timer up to about 15 ms); no rate sends all at once.
async function paced(count,rate,step){const start=performance.now();for(let i=0;i<count;){const due=rate?Math.floor((performance.now()-start)*rate/1000)+1:count;while(i<count&&i<due)step(i++);if(i<count)await sleep(2)}}
async function prompt(id){
  const plan=JSON.parse(readFileSync(process.argv[2],"utf8"));
  await until(plan.startFile);
  if(plan.toolUpdates){
    const toolCallId="budget-tool";let output="";
    update({sessionUpdate:"tool_call",toolCallId,title:"npm test",kind:"execute",status:"in_progress",rawInput:{command:"npm test"}});
    await paced(plan.toolUpdates,plan.rate,i=>{output+=("ok "+i+" streamed test output ").padEnd(199,".")+"\n";update({sessionUpdate:"tool_call_update",toolCallId,status:"in_progress",rawOutput:output})});
    if(plan.terminal!==false)update({sessionUpdate:"tool_call_update",toolCallId,status:"completed",rawOutput:output});
  }
  await paced(plan.chunks||0,plan.rate,i=>update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:("w"+i+" ").padEnd(23,"x")+" "}}));
  await until(plan.endFile);
  send({jsonrpc:"2.0",id,result:{stopReason:"end_turn"}});
}
function handle(m){
  if(!m.method||m.id==null)return;
  if(m.method==="initialize")return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentInfo:{name:"budget",version:"1"},agentCapabilities:{loadSession:false,sessionCapabilities:{resume:{}}}}});
  if(m.method==="session/new")return send({jsonrpc:"2.0",id:m.id,result:{sessionId,models:{currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture"}]}}});
  if(m.method==="session/prompt")return void prompt(m.id);
  return send({jsonrpc:"2.0",id:m.id,result:{}});
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line))}catch{}});
`;
const BUDGET_INSTANCE=Object.freeze({id:"grok-default",kind:"grok",displayName:"Grok Build",enabled:true});
const BUDGET_THREAD=Object.freeze({runtime:"grok",providerSessionId:"budget-session",model:"fixture-model",providerMeta:{runtimeInstanceId:"grok-default",permissionProfile:"supervised"}});
// The client reads replies with the JSON.parse it had before a test counts the server's.
const parseJson=JSON.parse;
async function budgetRelay(prefix){
  const root=await mkdtemp(join(tmpdir(),prefix)),agent=join(root,"budget-acp.mjs"),plan=join(root,"plan.json");
  await writeFile(agent,BUDGET_AGENT,"utf8");await writeFile(plan,"{}","utf8");
  const env={...process.env,TREBELL_HOME:join(root,"home")},threadStore=new AgentThreadStore(env),meta=new Map();
  const runtimeManager={
    instances:()=>[{...BUDGET_INSTANCE}],activeInstance:()=>({...BUDGET_INSTANCE}),activeRuntime:()=>"grok",compatibleInstanceIds:()=>[BUDGET_INSTANCE.id],
    probe:async()=>({id:BUDGET_INSTANCE.id,name:"Grok Build",available:true,authenticated:true,version:"fixture"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),executable:()=>process.execPath,acpArgs:()=>[agent,plan],
  };
  const state={settings:()=>({activeEnvironmentId:null}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket("ws://127.0.0.1:"+server.address().port+"/api/agent/ws");await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  let requestId=0;
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++requestId,onMessage=raw=>{const message=parseJson(String(raw));if(message.id!==id)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id,method,params}));
  });
  // Resolves once count notifications of method have arrived, matched in their text so that waiting parses nothing.
  const notified=(method,count=1)=>new Promise(resolve=>{let seen=0;const needle='"method":"'+method+'"',onMessage=raw=>{if(String(raw).includes(needle)&&++seen>=count){ws.off("message",onMessage);resolve()}};ws.on("message",onMessage)});
  const close=async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})};
  return {root,threadStore,plan,rpc,notified,close,file:name=>join(root,name)};
}
// A stored history of about mb megabytes: turns of a short request and a 3 KB reply.
function seededTurns(mb){
  const turns=[],reply="x".repeat(3000);
  for(let i=0;i<Math.round(mb*1024*1024/3200);i++)turns.push({id:"seed-"+i,startedAt:1000+i,items:[{type:"userMessage",id:"user-seed-"+i,content:[{type:"text",text:"seed request "+i}]},{type:"agentMessage",id:"agent-seed-"+i,text:reply+" "+i}]});
  return turns;
}
// What the server does between start() and stop(): sqlite connections (a counting DatabaseSync swapped onto the store, as B4 does),
// write transactions, the bytes bound to statements and read from them, and the characters JSON.parse reads.
function serverCounters(store){
  const counts={connections:0,transactions:0,boundBytes:0,readBytes:0,parsedChars:0},original=store.storage.DatabaseSync,proto=StatementSync.prototype,real={run:proto.run,get:proto.get,all:proto.all},parse=JSON.parse;
  const strings=values=>{let size=0;for(const value of values)if(typeof value==="string")size+=value.length;return size};
  return {
    counts,
    start(){
      store.storage.DatabaseSync=class extends original{constructor(...args){super(...args);counts.connections++}exec(sql){if(/BEGIN IMMEDIATE/i.test(String(sql)))counts.transactions++;return super.exec(sql)}};
      proto.run=function(...args){counts.boundBytes+=strings(args);return real.run.apply(this,args)};
      proto.get=function(...args){counts.boundBytes+=strings(args);const row=real.get.apply(this,args);if(row)counts.readBytes+=strings(Object.values(row));return row};
      proto.all=function(...args){counts.boundBytes+=strings(args);const rows=real.all.apply(this,args);for(const row of rows)counts.readBytes+=strings(Object.values(row));return rows};
      JSON.parse=function(text,...rest){if(typeof text==="string")counts.parsedChars+=text.length;return parse.call(this,text,...rest)};
    },
    stop(){store.storage.DatabaseSync=original;Object.assign(proto,real);JSON.parse=parse},
  };
}

// B1: a harness's text chunk needs only the id and status of the thread's last turn. It read and parsed the whole stored thread
// for each chunk: a sqlite connection and 1 MB of JSON per chunk on a 0.5 MB thread, so the server fell behind as a thread grew.
test("B1: a streamed text chunk of a harness reply opens no sqlite connection and parses no stored history",async t=>{
  const relay=await budgetRelay("trebell-budget-b1-");
  try{
    const thread=relay.threadStore.importHistory({...BUDGET_THREAD,cwd:relay.root,turns:seededTurns(0.5)}),chunks=200;
    await writeFile(relay.plan,JSON.stringify({chunks,startFile:relay.file("start"),endFile:relay.file("end")}),"utf8");
    await relay.rpc("thread/resume",{threadId:thread.id,cwd:relay.root,excludeTurns:true});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Stream a reply"}]});
    const counters=serverCounters(relay.threadStore),streamed=relay.notified("item/agentMessage/delta",chunks);
    counters.start();try{await writeFile(relay.file("start"),"go","utf8");await streamed}finally{counters.stop()}
    const completed=relay.notified("turn/completed");await writeFile(relay.file("end"),"done","utf8");await completed;
    const perChunk={connections:counters.counts.connections/chunks,parsedKB:counters.counts.parsedChars/1024/chunks};t.diagnostic("per chunk "+JSON.stringify(perChunk));
    assert.ok(perChunk.connections<=1.1,"connections per chunk "+JSON.stringify(perChunk));
    assert.ok(perChunk.parsedKB<=1.15*1024,"JSON parsed per chunk "+JSON.stringify(perChunk));
    const reply=relay.threadStore.get(thread.id).turns.at(-1).items.find(item=>item.type==="agentMessage");
    assert.ok(reply?.text.startsWith("w0 ")&&reply.text.includes("w199 "),"the reply is stored whole");
  }finally{await relay.close()}
});

// B2: a command's streamed output. Each tool_call_update read the thread and rewrote the whole turn and its search rows in a write
// transaction of its own: 205 transactions and 4.3 MB bound to statements for 200 updates.
test("B2: a command's 200 output updates take a bounded number of write transactions and bytes, and the stored item is the last",async t=>{
  const relay=await budgetRelay("trebell-budget-b2-");
  try{
    const thread=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root}),updates=200;
    await writeFile(relay.plan,JSON.stringify({toolUpdates:updates,rate:100}),"utf8");
    const counters=serverCounters(relay.threadStore),completed=relay.notified("turn/completed");
    counters.start();try{await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Run the tests"}]});await completed}finally{counters.stop()}
    const totals={transactions:counters.counts.transactions,boundMB:counters.counts.boundBytes/1024/1024};t.diagnostic("per reply "+JSON.stringify(totals));
    assert.ok(totals.transactions<=210,"write transactions "+JSON.stringify(totals));
    assert.ok(totals.boundMB<=4.6,"bytes bound "+JSON.stringify(totals));
    const item=relay.threadStore.get(thread.id).turns.at(-1).items.find(entry=>entry.type==="commandExecution");
    assert.equal(item?.status,"completed");
    assert.equal(item.aggregatedOutput.split("\n").filter(Boolean).length,updates,"the stored output is the last update's");
  }finally{await relay.close()}
});

// B3: opening a long thread as the app does: a resume without turns, then the newest page of items and the turn outcomes beside it.
// Each request read the whole stored thread: 15.8 MB read from sqlite and 31.6 MB of JSON parsed per open of a 3.2 MB thread.
test("B3: opening a long thread reads its history from sqlite at most once, and a second open soon after reads none",async t=>{
  const relay=await budgetRelay("trebell-budget-b3-");
  try{
    const thread=relay.threadStore.importHistory({...BUDGET_THREAD,cwd:relay.root,turns:seededTurns(3.2)});
    const open=async()=>{
      const counters=serverCounters(relay.threadStore);counters.start();
      try{
        const resumed=await relay.rpc("thread/resume",{threadId:thread.id,cwd:relay.root,excludeTurns:true});
        const [items,turns]=await Promise.all([
          relay.rpc("thread/items/list",{threadId:thread.id,cursor:resumed.itemsBackwardsCursor,limit:100,sortDirection:"desc"}),
          relay.rpc("thread/turns/list",{threadId:thread.id,cursor:resumed.turnsBackwardsCursor,limit:200,sortDirection:"desc",itemsView:"notLoaded"}),
        ]);
        assert.equal(items.data.length,100);assert.equal(turns.data.length,200);assert.equal(turns.data[0].id,thread.turns.at(-1).id);
      }finally{counters.stop()}
      return {readMB:counters.counts.readBytes/1024/1024,parsedMB:counters.counts.parsedChars/1024/1024};
    };
    const first=await open(),second=await open(),report=JSON.stringify({first,second});t.diagnostic("per open "+report);
    assert.ok(first.readMB<=17&&first.parsedMB<=34,"first open "+report);
    assert.ok(second.readMB<=17&&second.parsedMB<=34,"second open "+report);
  }finally{await relay.close()}
});
