import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
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
    // The last turn a chunk reads from sqlite alone (a thread the store keeps no parsed copy of) is the one get() lists last.
    assert.deepEqual(store.storage.lastTurn(thread.id),{id:"b",status:"completed"});
    const listings=[...new Set(prepared.filter(sql=>/FROM agent_turns\b/i.test(sql)&&/ORDER BY/i.test(sql)))];
    assert.equal(listings.length,3,"get(), the untitled-title read and the last-turn read each list a thread's turns");
    const db=new DatabaseSync(path);
    try{
      for(const sql of listings){const plan=db.prepare("EXPLAIN QUERY PLAN "+sql).all().map(row=>String(row.detail));assert.ok(!plan.some(detail=>/TEMP B-TREE/i.test(detail)),sql+" plans "+plan.join("; "))}
      // A home made before the index gets it at the next start.
      db.exec("DROP INDEX agent_turns_thread_order_idx");
    }finally{db.close()}
    new AgentThreadStore(env);
    const reopened=new DatabaseSync(path);
    try{assert.ok(reopened.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='agent_turns_thread_order_idx'").get())}finally{reopened.close()}
  }finally{await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// What a chunk reads of its thread: the last turn's id and status, the same from the store's parsed copy as from sqlite's turn row
// when no copy is kept, and through each write; the row read takes no payload and parses nothing.
test("the last turn a chunk reads matches the stored thread whether the store keeps it or not, and reads no history",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-budget-last-turn-")),env={...process.env,TREBELL_HOME:home};
  try{
    const store=new AgentThreadStore(env),thread=store.importHistory({runtime:"grok",cwd:home,providerSessionId:"budget-last",name:"Seeded",turns:seededTurns(0.5)}),empty=store.create({runtime:"grok",cwd:home,name:"Empty"});
    const turn=store.addTurn(thread.id,{inputText:"Next"}),cold=new AgentThreadStore(env),counters=serverCounters(cold);
    counters.start();let read;try{read=cold.lastTurn(thread.id)}finally{counters.stop()}
    assert.deepEqual(read,{id:turn.id,status:"inProgress"});assert.deepEqual(store.lastTurn(thread.id),read,"the parsed copy agrees");
    assert.ok(counters.counts.parsedChars===0&&counters.counts.readBytes<=100,"the row read "+JSON.stringify(counters.counts));
    store.finishTurn(thread.id,turn.id);
    for(const each of [store,cold])assert.deepEqual(each.lastTurn(thread.id),{id:turn.id,status:"completed"});
    assert.deepEqual(cold.lastTurn(empty.id),{id:null,status:null});assert.deepEqual(store.lastTurn(empty.id),{id:null,status:null});
    store.delete(thread.id);
    for(const each of [store,cold])assert.equal(each.lastTurn(thread.id),null,"a deleted thread has none");
  }finally{await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// The relay end to end on an isolated home, with a scripted ACP agent (the shape of tests/agent-relay.test.mjs's fake) run as a
// Grok Build harness. Each session/prompt streams the plan in plan.json, and waits for the files the plan names before and after
// its stream, so a test can count the stream alone. No model and no real harness is involved.
const BUDGET_AGENT=String.raw`
import readline from "node:readline";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
// Each agent process logs the requests it gets to a file of its own in the folder it is given, named for its start and its pid.
const log=process.argv[3]?join(process.argv[3],Date.now()+"-"+process.pid+".log"):null;if(log)appendFileSync(log,"");
const sessionId="budget-session";
const send=message=>process.stdout.write(JSON.stringify(message)+"\n");
const update=value=>send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:value}});
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
// Stop (session/cancel) ends the stream where it is, and the prompt answers cancelled.
let cancelled=false;
async function until(file){while(file&&!existsSync(file)&&!cancelled)await sleep(5)}
// Paced against the clock, not per timer tick (Windows rounds a short timer up to about 15 ms); no rate sends all at once.
async function paced(count,rate,step){const start=performance.now();for(let i=0;i<count&&!cancelled;){const due=rate?Math.floor((performance.now()-start)*rate/1000)+1:count;while(i<count&&i<due&&!cancelled)step(i++);if(i<count)await sleep(2)}}
const readPlan=()=>JSON.parse(readFileSync(process.argv[2],"utf8"));
async function prompt(id){
  const plan=readPlan();cancelled=false;
  await until(plan.startFile);
  // Tools the turn reports, each started and completed; spawnPidFile leaves a process running, as a command run in the background does.
  for(const [index,tool] of (plan.tools||[]).entries()){
    const toolCallId="budget-call-"+index;
    update({sessionUpdate:"tool_call",toolCallId,title:tool.title||tool.kind,kind:tool.kind,status:"in_progress",rawInput:{}});
    if(tool.spawnPidFile){const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});writeFileSync(tool.spawnPidFile,String(child.pid))}
    update({sessionUpdate:"tool_call_update",toolCallId,status:"completed",rawOutput:tool.rawOutput??"done"});
  }
  if(plan.toolUpdates){
    const toolCallId="budget-tool";let output="";
    update({sessionUpdate:"tool_call",toolCallId,title:"npm test",kind:"execute",status:"in_progress",rawInput:{command:"npm test"}});
    await paced(plan.toolUpdates,plan.rate,i=>{output+=("ok "+i+" streamed test output ").padEnd(199,".")+"\n";update({sessionUpdate:"tool_call_update",toolCallId,status:"in_progress",rawOutput:output})});
    if(plan.terminal!==false)update({sessionUpdate:"tool_call_update",toolCallId,status:"completed",rawOutput:output});
  }
  await paced(plan.chunks||0,plan.rate,i=>update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:("w"+i+" ").padEnd(23,"x")+" "}}));
  await until(plan.endFile);
  send({jsonrpc:"2.0",id,result:{stopReason:cancelled?"cancelled":"end_turn"}});
  // What the harness sends on its own once the prompt has answered, as Grok answers a finished background task in a turn of its own.
  for(const step of plan.after||[]){
    if(step.delay)await sleep(step.delay);
    if(step.update)send({jsonrpc:"2.0",method:"session/update",params:{sessionId,...(step.meta?{_meta:step.meta}:{}),update:step.update}});
    if(step.notify)send({jsonrpc:"2.0",method:step.notify.method,params:step.notify.params});
  }
}
function handle(m){
  if(log&&m.method)appendFileSync(log,m.method+"\n");
  if(m.method==="session/cancel"){cancelled=true;return}
  if(!m.method||m.id==null)return;
  if(m.method==="initialize")return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentInfo:{name:"budget",version:"1"},agentCapabilities:readPlan().agentCapabilities||{loadSession:false,sessionCapabilities:{resume:{}}}}});
  if(m.method==="session/new")return send({jsonrpc:"2.0",id:m.id,result:{sessionId,models:{currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture"}]}}});
  if(m.method==="session/prompt")return void prompt(m.id);
  // A fork that takes forkDelayMs to answer, as a harness copying a long conversation does.
  if(m.method==="session/fork")return void setTimeout(()=>send({jsonrpc:"2.0",id:m.id,result:{sessionId:"budget-fork"}}),readPlan().forkDelayMs||0);
  // A session/close that takes closeDelayMs to answer, as a harness saving its conversation does.
  if(m.method==="session/close")return void setTimeout(()=>send({jsonrpc:"2.0",id:m.id,result:{}}),readPlan().closeDelayMs||0);
  return send({jsonrpc:"2.0",id:m.id,result:{}});
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line))}catch{}});
`;
const BUDGET_INSTANCE=Object.freeze({id:"grok-default",kind:"grok",displayName:"Grok Build",enabled:true});
const BUDGET_THREAD=Object.freeze({runtime:"grok",providerSessionId:"budget-session",model:"fixture-model",providerMeta:{runtimeInstanceId:"grok-default",permissionProfile:"supervised"}});
// The client reads replies with the JSON.parse it had before a test counts the server's.
const parseJson=JSON.parse;
// instances: the harnesses the relay offers (the first is the active one); env: what the server's environment adds;
// nativeProviderTurn: the model a Trebell Native thread's turns call.
async function budgetRelay(prefix,{instances=[BUDGET_INSTANCE],env:extra={},nativeProviderTurn=null}={}){
  const root=await mkdtemp(join(tmpdir(),prefix)),agent=join(root,"budget-acp.mjs"),plan=join(root,"plan.json"),agents=join(root,"agents");
  await writeFile(agent,BUDGET_AGENT,"utf8");await writeFile(plan,"{}","utf8");await mkdir(agents,{recursive:true});
  const env={...process.env,TREBELL_HOME:join(root,"home"),...extra},threadStore=new AgentThreadStore(env),meta=new Map(),launches={n:0},modes=[];
  const runtimeManager={
    env,instances:()=>instances.map(item=>({...item})),activeInstance:()=>({...instances[0]}),activeRuntime:()=>instances[0].kind,compatibleInstanceIds:()=>instances.map(item=>item.id),
    probe:async instance=>({id:instance.id,name:instance.displayName,available:true,authenticated:true,version:"fixture"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),childEnvironmentKeys:()=>[],
    // The relay asks for a harness's command only to build a session for it: each ask is a launch. The permission mode is the
    // launch argument Grok and Cursor take it in.
    executable:()=>{launches.n++;return process.execPath},acpArgs:(_instance,mode)=>{modes.push(mode);return [agent,plan,agents]},
  };
  const state={settings:()=>({activeEnvironmentId:null}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"test",nativeProviderTurn});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket("ws://127.0.0.1:"+server.address().port+"/api/agent/ws");await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  let requestId=0;
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++requestId,onMessage=raw=>{const message=parseJson(String(raw));if(message.id!==id)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id,method,params}));
  });
  // Resolves once count notifications of method have arrived (those whose text also holds text, when given), matched in their text so
  // that waiting parses nothing.
  const notified=(method,count=1,text="")=>new Promise(resolve=>{let seen=0;const needle='"method":"'+method+'"',onMessage=raw=>{const message=String(raw);if(message.includes(needle)&&message.includes(text)&&++seen>=count){ws.off("message",onMessage);resolve(true)}};ws.on("message",onMessage)});
  // shutdown stops the relay and its server; close also removes the home, once.
  let shut=null;const shutdown=()=>shut||=(async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()))})();
  const close=async()=>{await shutdown();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})};
  // How many notifications of method have arrived so far, counted as notified() matches them.
  const counter=method=>{const needle='"method":"'+method+'"',counts={n:0};ws.on("message",raw=>{if(String(raw).includes(needle))counts.n++});return counts};
  // The agent processes started so far, oldest first: each one's pid and the requests it got.
  const agentProcesses=async()=>(await readdir(agents)).sort().map(name=>({pid:Number(name.split(/[-.]/)[1]),methods:readFileSync(join(agents,name),"utf8").split("\n").filter(Boolean)}));
  return {root,threadStore,plan,rpc,notified,counter,shutdown,close,launches,modes,agentProcesses,file:name=>join(root,name)};
}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
// Whether promise settles within ms (false if it does not).
const within=(promise,ms)=>Promise.race([promise,new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),ms);timer.unref?.()})]);
async function eventually(check,ms=10_000){const end=Date.now()+ms;while(!(await check())){if(Date.now()>end)return false;await new Promise(done=>setTimeout(done,20))}return true}
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
// The store's parsed copy (peek) serves it now; what is left is the thread metadata each notification names.
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
    assert.equal(perChunk.connections,0,"connections per chunk "+JSON.stringify(perChunk));
    assert.ok(perChunk.parsedKB<=2,"JSON parsed per chunk "+JSON.stringify(perChunk));
    const reply=relay.threadStore.get(thread.id).turns.at(-1).items.find(item=>item.type==="agentMessage");
    assert.ok(reply?.text.startsWith("w0 ")&&reply.text.includes("w199 "),"the reply is stored whole");
  }finally{await relay.close()}
});

// B1 with three harness threads streaming at once (three chats working side by side). The store keeps parsed copies of the 2
// threads used last, so each chunk pushed another out and read and parsed its whole thread again, as it did for a thread too large
// to keep (over 32 M characters). A chunk takes the last turn's id and status alone now, from sqlite's turn row when no copy is kept.
test("B1: three harness threads streaming at once read and parse none of their stored history per chunk",async t=>{
  const relay=await budgetRelay("trebell-budget-b1-three-");
  try{
    const threads=[0,1,2].map(n=>relay.threadStore.importHistory({...BUDGET_THREAD,providerSessionId:"budget-session-"+n,cwd:relay.root,turns:seededTurns(0.5)})),chunks=3*60;
    await writeFile(relay.plan,JSON.stringify({chunks:chunks/3,rate:30,startFile:relay.file("start"),endFile:relay.file("end")}),"utf8");
    for(const thread of threads)await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Stream a reply"}]});
    const counters=serverCounters(relay.threadStore),streamed=relay.notified("item/agentMessage/delta",chunks);
    counters.start();try{await writeFile(relay.file("start"),"go","utf8");await streamed}finally{counters.stop()}
    const completed=relay.notified("turn/completed",3);await writeFile(relay.file("end"),"done","utf8");await completed;
    const perChunk={connections:counters.counts.connections/chunks,readKB:counters.counts.readBytes/1024/chunks,parsedKB:counters.counts.parsedChars/1024/chunks};t.diagnostic("per chunk "+JSON.stringify(perChunk));
    assert.ok(perChunk.readKB<=2&&perChunk.parsedKB<=2,"read and parsed per chunk "+JSON.stringify(perChunk));
    for(const thread of threads){const reply=relay.threadStore.get(thread.id).turns.at(-1).items.find(item=>item.type==="agentMessage");assert.ok(reply?.text.includes("w59 "),"each reply is stored whole")}
  }finally{await relay.close()}
});

// B2: a command's streamed output. Each tool_call_update read the thread and rewrote the whole turn and its search rows in a write
// transaction of its own: 205 transactions and 4.3 MB bound to statements for 200 updates. A running tool's item is stored at most
// every 500 ms now (with a trailing write), and its search rows stand.
test("B2: a command's 200 output updates take a bounded number of write transactions and bytes, and the stored item is the last",async t=>{
  const relay=await budgetRelay("trebell-budget-b2-");
  try{
    const thread=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root}),updates=200;
    await writeFile(relay.plan,JSON.stringify({toolUpdates:updates,rate:100}),"utf8");
    const counters=serverCounters(relay.threadStore),completed=relay.notified("turn/completed");
    counters.start();try{await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Run the tests"}]});await completed}finally{counters.stop()}
    const totals={transactions:counters.counts.transactions,boundMB:counters.counts.boundBytes/1024/1024};t.diagnostic("per reply "+JSON.stringify(totals));
    assert.ok(totals.transactions<=30,"write transactions "+JSON.stringify(totals));
    assert.ok(totals.boundMB<=1,"bytes bound "+JSON.stringify(totals));
    const item=relay.threadStore.get(thread.id).turns.at(-1).items.find(entry=>entry.type==="commandExecution");
    assert.equal(item?.status,"completed");
    assert.equal(item.aggregatedOutput.split("\n").filter(Boolean).length,updates,"the stored output is the last update's");
  }finally{await relay.close()}
});

// What the 500 ms costs: a crash loses at most that much of a running command's stored output, and the restart marks its turn
// interrupted; a request about the thread reads the output the windows were sent; Stop stores all of it.
test("a running command's stored output trails its stream by at most 500 ms, is current for a request, and is whole after Stop",async t=>{
  const relay=await budgetRelay("trebell-budget-tool-writes-");
  try{
    const thread=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root}),progress=relay.counter("item/tool/progress");
    await writeFile(relay.plan,JSON.stringify({toolUpdates:5000,rate:100,terminal:false,endFile:relay.file("end")}),"utf8");
    const lines=item=>String(item?.aggregatedOutput||"").split("\n").filter(Boolean).length,commandOf=turn=>turn?.items?.find(entry=>entry.type==="commandExecution");
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Run the tests"}]});
    await relay.notified("item/tool/progress",150);
    // A crash leaves what sqlite has: a copy of the database taken now, restarted in a home of its own.
    const sent=progress.n,crashHome=join(relay.root,"crash-home"),source=new DatabaseSync(join(relay.root,"home","trebell.sqlite"));
    await mkdir(crashHome,{recursive:true});
    try{source.exec("VACUUM INTO '"+join(crashHome,"trebell.sqlite").replaceAll("'","''")+"'")}finally{source.close()}
    const restarted=new AgentThreadStore({...process.env,TREBELL_HOME:crashHome}),stored=lines(commandOf(restarted.get(thread.id).turns.at(-1)));
    t.diagnostic("crash copy: sent "+sent+", stored "+stored);
    assert.ok(stored>0&&sent-stored<=60,"at 100 updates a second, the stored output trails what was sent by at most 500 ms: sent "+sent+", stored "+stored);
    restarted.reconcileRestart({continueAfterRestart:true});
    const recovered=restarted.get(thread.id);
    assert.equal(recovered.turns.at(-1).status,"interrupted");assert.equal(recovered.recovery?.blocked,true,"its unfinished command blocks an automatic continuation");
    // Every update this window had when it asked was already on the server, so the answer holds at least that much output.
    const seen=progress.n,listed=await relay.rpc("thread/items/list",{threadId:thread.id,limit:10,sortDirection:"desc"});
    assert.ok(lines(listed.data.find(entry=>entry.item.type==="commandExecution")?.item)>=seen,"a request writes what waits before it reads");
    const completed=relay.notified("turn/completed");await relay.rpc("turn/interrupt",{threadId:thread.id});await completed;
    const final=relay.threadStore.get(thread.id).turns.at(-1);
    assert.equal(final.status,"cancelled");assert.equal(lines(commandOf(final)),progress.n,"Stop stores every update the windows were sent");
  }finally{await relay.close()}
});

// B3: opening a long thread as the app does: a resume without turns, then the newest page of items and the turn outcomes beside it.
// Each request read the whole stored thread: 15.8 MB read from sqlite and 31.6 MB of JSON parsed per open of a 3.2 MB thread. They
// read the store's shared parsed copy now, so every thread it hands out is frozen here: a request that changed it would fail.
function deepFreeze(value){if(value&&typeof value==="object"&&!Object.isFrozen(value)){Object.freeze(value);for(const item of Object.values(value))deepFreeze(item)}return value}
test("B3: opening a long thread reads its history from sqlite at most once, and a second open soon after reads none",async t=>{
  const relay=await budgetRelay("trebell-budget-b3-");
  try{
    const thread=relay.threadStore.importHistory({...BUDGET_THREAD,cwd:relay.root,turns:seededTurns(3.2)});
    const peek=relay.threadStore.peek.bind(relay.threadStore);relay.threadStore.peek=id=>deepFreeze(peek(id));
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
    assert.ok(first.readMB<=3.5&&first.parsedMB<=4,"first open "+report);
    assert.ok(second.readMB===0&&second.parsedMB<=0.01,"second open "+report);
    // The other ways the window reads a thread, each over the frozen copy (no copy of it is parsed): the whole thread, the items of one
    // turn from the oldest, turns with all or some of their items, and a search.
    const counters=serverCounters(relay.threadStore);counters.start();
    try{
      const whole=await relay.rpc("thread/resume",{threadId:thread.id,cwd:relay.root});assert.equal(whole.thread.turns.length,thread.turns.length);
      const oneTurn=await relay.rpc("thread/items/list",{threadId:thread.id,turnId:thread.turns[3].id,limit:10});assert.deepEqual(oneTurn.data.map(entry=>entry.item.id),["user-seed-3","agent-seed-3"]);
      for(const itemsView of ["full","summary"]){const page=await relay.rpc("thread/turns/list",{threadId:thread.id,limit:5,sortDirection:"asc",itemsView});assert.equal(page.data[0].items.length,2)}
      const found=await relay.rpc("thread/searchOccurrences",{threadId:thread.id,searchTerm:"seed request 7",limit:5});assert.equal(found.data[0].turnId,"seed-7");
    }finally{counters.stop()}
    assert.ok(counters.counts.readBytes===0&&counters.counts.parsedChars<=10_000,"the other reads "+JSON.stringify(counters.counts));
  }finally{await relay.close()}
});

// The rest of an open: the app asks for the thread's goal and continuity beside the resume. Each copied the whole stored thread (a
// JSON round trip of 3.2 MB) to read its turns' times, ids and statuses, the continuity twice when the thread has a goal.
test("the goal and continuity reads of an open parse none of the stored history",async t=>{
  const relay=await budgetRelay("trebell-budget-continuity-");
  try{
    const thread=relay.threadStore.importHistory({...BUDGET_THREAD,cwd:relay.root,turns:seededTurns(3.2)});
    await relay.rpc("thread/goal/set",{threadId:thread.id,objective:"Keep the seeded history"});
    const turns=relay.threadStore.get(thread.id).turns,completed=turns.filter(turn=>turn.status==="completed").slice(-10).map(turn=>turn.id);
    // They read the store's shared copy now, frozen here so that a change to it would fail.
    const peek=relay.threadStore.peek.bind(relay.threadStore);relay.threadStore.peek=id=>deepFreeze(peek(id));
    const counters=serverCounters(relay.threadStore);counters.start();let goal,continuity;
    try{[goal,continuity]=await Promise.all([relay.rpc("thread/goal/get",{threadId:thread.id}),relay.rpc("thread/continuity/get",{threadId:thread.id})])}finally{counters.stop()}
    const read={readMB:counters.counts.readBytes/1024/1024,parsedMB:counters.counts.parsedChars/1024/1024};t.diagnostic("goal and continuity "+JSON.stringify(read));
    assert.equal(goal.goal.objective,"Keep the seeded history");assert.equal(goal.goal.turnsUsed,0);
    assert.equal(completed.length,10);assert.deepEqual(continuity.continuity.completedTurnIds,completed);assert.equal(continuity.continuity.objective,"Keep the seeded history");
    assert.ok(read.readMB===0&&read.parsedMB<=0.01,"goal and continuity "+JSON.stringify(read));
  }finally{await relay.close()}
});

// B19: browsing threads starts no harness. A thread of a harness whose session opens with its next turn shows its saved transcript
// and launches nothing; OpenCode's opened its session at once, starting `opencode serve` (4 processes, 499 MB) per reopened chat.
const LAZY_KINDS=["cursor","grok","antigravity","opencode"];
test("B19: reopening a Cursor, Grok, Antigravity or OpenCode thread launches no harness",async t=>{
  const relay=await budgetRelay("trebell-budget-b19-",{instances:LAZY_KINDS.map(kind=>({id:kind+"-default",kind,displayName:kind,enabled:true}))});
  try{
    const launched={},errors={};
    for(const kind of LAZY_KINDS){
      const thread=relay.threadStore.create({...BUDGET_THREAD,runtime:kind,cwd:relay.root,providerMeta:{...BUDGET_THREAD.providerMeta,runtimeInstanceId:kind+"-default"}}),before=relay.launches.n;
      await relay.rpc("thread/resume",{threadId:thread.id,cwd:relay.root,excludeTurns:true}).catch(error=>{errors[kind]=String(error.message).split(/\r?\n/)[0]});
      launched[kind]=relay.launches.n-before;
    }
    t.diagnostic("launches per reopened thread "+JSON.stringify({launched,errors}));
    for(const kind of LAZY_KINDS)assert.equal(launched[kind],0,kind+" "+JSON.stringify({launched,errors}));
  }finally{await relay.close()}
});


// B9: a harness session held its processes until the server stopped (Grok 4 processes and 141 MB, Cursor 5 and 307 MB, OpenCode 4
// and 499 MB per chat). The relay's sweep closes one left idle; TREBELL_AGENT_SESSION_IDLE_MS and _SWEEP_MS shorten it here.
test("B9: an idle harness session is released, one with a running turn is kept, and the next turn resumes the conversation",async t=>{
  const relay=await budgetRelay("trebell-budget-b9-",{env:{TREBELL_AGENT_SESSION_IDLE_MS:"400",TREBELL_AGENT_SESSION_SWEEP_MS:"50"}});
  try{
    const idle=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root,providerMeta:{...BUDGET_THREAD.providerMeta,permissionProfile:"edits"}});
    const working=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root});
    // A harness that only read, searched and edited files has nothing left running once its turn ends.
    await writeFile(relay.plan,JSON.stringify({chunks:3,tools:[{kind:"read",title:"Read README.md"},{kind:"search",title:"Search the workspace"},{kind:"edit",title:"Edit notes.md"}]}),"utf8");
    let completed=relay.notified("turn/completed");await relay.rpc("turn/start",{threadId:idle.id,input:[{type:"text",text:"First"}]});await completed;
    const [first]=await relay.agentProcesses();assert.ok(alive(first.pid),"the idle thread's harness runs after its turn");
    await writeFile(relay.plan,JSON.stringify({chunks:1,endFile:relay.file("end")}),"utf8");
    await relay.rpc("turn/start",{threadId:working.id,input:[{type:"text",text:"Keep working"}]});
    const second=(await relay.agentProcesses()).find(agent=>agent.pid!==first.pid);
    assert.ok(await eventually(()=>!alive(first.pid)),"the idle session is closed and its harness exits");
    await new Promise(done=>setTimeout(done,800));
    assert.ok(alive(second.pid),"a session with a running turn is kept past the idle time");
    completed=relay.notified("turn/completed");await writeFile(relay.file("end"),"done","utf8");await completed;
    assert.ok(await eventually(()=>!alive(second.pid)),"once its turn ends, that session is let go too");
    // The idle thread's next turn starts its harness again with the thread's permission mode, resumes the stored conversation (no
    // new one) and streams.
    await writeFile(relay.plan,JSON.stringify({chunks:5}),"utf8");
    const streamed=relay.notified("item/agentMessage/delta",5);completed=relay.notified("turn/completed");
    await relay.rpc("turn/start",{threadId:idle.id,input:[{type:"text",text:"Again"}]});await streamed;await completed;
    const agents=await relay.agentProcesses(),third=agents.at(-1);
    t.diagnostic("agent processes "+JSON.stringify(agents.map(agent=>({alive:alive(agent.pid),methods:agent.methods}))));
    assert.equal(agents.length,3);assert.ok(third.methods.includes("session/resume")&&!third.methods.includes("session/new"),third.methods.join(","));
    assert.deepEqual([relay.modes[0],relay.modes.at(-1)],["edits","edits"]);
    const reply=relay.threadStore.get(idle.id).turns.at(-1).items.find(item=>item.type==="agentMessage");assert.ok(reply?.text.includes("w4 "),"the resumed turn's reply is stored");
  }finally{await relay.close()}
});

// The sweep stops a released harness's whole process tree (taskkill /T on Windows), so it keeps a session whose harness ran a tool
// that can outlive its turn: what that tool left running went on until the thread closed before the sweep, and nothing says when it
// ends. SWEEP_ENV shortens the idle time to 300 ms, against the default ten minutes.
const SWEEP_ENV=Object.freeze({TREBELL_AGENT_SESSION_IDLE_MS:"300",TREBELL_AGENT_SESSION_SWEEP_MS:"50"});

// A window keeps a note of each turn of a thread it sent a Stop for until it hears the turn end (ui/src/thread-turn-notes.js), and
// heard nothing when the sweep let a thread's session go. The sweep says so as Codex does of a thread it unloads (thread/closed), for
// that thread alone: one whose turn runs keeps its session until the turn ends.
test("the idle sweep tells the windows which thread's session it let go, with thread/closed, and not a thread whose turn runs",async()=>{
  const relay=await budgetRelay("trebell-budget-closed-",{env:SWEEP_ENV});
  try{
    const idle=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root}),working=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root});
    await writeFile(relay.plan,JSON.stringify({chunks:1,tools:[{kind:"read",title:"Read README.md"}]}),"utf8");
    let completed=relay.notified("turn/completed");
    await relay.rpc("turn/start",{threadId:idle.id,input:[{type:"text",text:"What does the README say?"}]});await completed;
    const closedIdle=relay.notified("thread/closed",1,'"threadId":"'+idle.id+'"'),closed=relay.counter("thread/closed");
    await writeFile(relay.plan,JSON.stringify({chunks:1,endFile:relay.file("end")}),"utf8");
    await relay.rpc("turn/start",{threadId:working.id,input:[{type:"text",text:"Keep working"}]});
    const [first]=await relay.agentProcesses();
    assert.ok(await within(closedIdle,6000),"the windows hear that the idle thread's session closed");
    assert.ok(await eventually(()=>!alive(first.pid)),"and its harness exits");
    await new Promise(done=>setTimeout(done,800));
    assert.equal(closed.n,1,"the thread whose turn runs keeps its session, and nothing says it closed");
    const closedWorking=relay.notified("thread/closed",1,'"threadId":"'+working.id+'"');
    completed=relay.notified("turn/completed");await writeFile(relay.file("end"),"done","utf8");await completed;
    assert.ok(await within(closedWorking,6000),"once its turn ends, its session is let go and the windows hear it");
    assert.equal(closed.n,2);
  }finally{await relay.close()}
});

// Grok runs a long command in the background (its tool call answers BackgroundTaskStarted while the command runs) and answers once it
// ends in a task-completed-* turn of its own, with no prompt running in between. Closing the idle session stopped Grok and its task.
test("the idle sweep keeps a Grok session whose background task has not reported back, so its wake turn still arrives",async()=>{
  const relay=await budgetRelay("trebell-budget-wake-",{env:SWEEP_ENV});
  try{
    const thread=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root});
    await writeFile(relay.plan,JSON.stringify({chunks:1,tools:[{kind:"execute",title:"npm test",rawOutput:{type:"BackgroundTaskStarted",task_id:"task-1"}}],after:[
      {delay:1500,meta:{promptId:"task-completed-1"},update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Background task finished."}}},
      {delay:50,notify:{method:"_x.ai/session_notification",params:{sessionId:"budget-session",update:{sessionUpdate:"turn_completed",prompt_id:"task-completed-1",stop_reason:"end_turn"}}}},
    ]}),"utf8");
    const first=relay.notified("turn/completed");
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Run the long test suite in the background"}]});await first;
    const woke=await within(relay.notified("turn/completed"),6000),turns=relay.threadStore.get(thread.id).turns;
    assert.ok(woke,"the background task's wake turn completes; agent processes "+JSON.stringify((await relay.agentProcesses()).map(agent=>({alive:alive(agent.pid),methods:agent.methods}))));
    assert.equal(turns.length,2);
    assert.ok(turns[1].items.some(item=>item.type==="agentMessage"&&item.text.includes("Background task finished.")),"the wake turn's reply is stored");
  }finally{await relay.close()}
});

// A command a harness ran can leave a process going after its turn, such as a dev server or a watcher started in the background. A
// second thread whose harness only read a file shows the sweep at work in the same relay: its session is let go.
test("the idle sweep leaves a process a harness's command started in the background running",async()=>{
  const relay=await budgetRelay("trebell-budget-background-",{env:SWEEP_ENV});let backgroundPid=0;
  try{
    const thread=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root}),reader=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root}),pidFile=relay.file("background.pid");
    await writeFile(relay.plan,JSON.stringify({chunks:1,tools:[{kind:"execute",title:"npm run dev",spawnPidFile:pidFile,rawOutput:"Started the dev server in the background."}]}),"utf8");
    let completed=relay.notified("turn/completed");
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Start the dev server in the background"}]});await completed;
    backgroundPid=Number(readFileSync(pidFile,"utf8"));assert.ok(alive(backgroundPid),"the background process runs once the turn ends");
    await writeFile(relay.plan,JSON.stringify({chunks:1,tools:[{kind:"read",title:"Read README.md"}]}),"utf8");
    completed=relay.notified("turn/completed");
    await relay.rpc("turn/start",{threadId:reader.id,input:[{type:"text",text:"What does the README say?"}]});await completed;
    const [harness,read]=await relay.agentProcesses();
    assert.ok(await eventually(()=>!alive(read.pid)),"the session that only read a file is let go");
    await new Promise(done=>setTimeout(done,1000));
    const agents=(await relay.agentProcesses()).map(agent=>({alive:alive(agent.pid),methods:agent.methods}));
    assert.ok(alive(backgroundPid),"the background process still runs after the sweep; agent processes "+JSON.stringify(agents));
    assert.ok(alive(harness.pid),"its harness is kept");
  }finally{await relay.close();if(backgroundPid&&alive(backgroundPid))try{process.kill(backgroundPid)}catch{}}
});

// thread/fork, thread/compact/start and thread/revert wait on the thread's live session with no prompt running (a fork, OpenCode's
// summarize, a rewind). The sweep closed the session under such a request once the idle time since the last turn had passed, and the
// request failed with "ACP runtime stopped". Here a fork that takes 1.5 s starts right after a turn.
test("the idle sweep keeps a session while a request on its thread is in flight, and lets it go once it is answered",async()=>{
  const relay=await budgetRelay("trebell-budget-fork-",{env:SWEEP_ENV});
  try{
    const thread=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root});
    await writeFile(relay.plan,JSON.stringify({chunks:1,forkDelayMs:1500,agentCapabilities:{loadSession:false,sessionCapabilities:{resume:{},fork:{}}}}),"utf8");
    const completed=relay.notified("turn/completed");
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Hello"}]});await completed;
    const forked=await relay.rpc("thread/fork",{threadId:thread.id}).then(result=>({ok:true,result}),error=>({ok:false,error:String(error.message).split(/\r?\n/)[0]}));
    const [agent]=await relay.agentProcesses();
    assert.ok(forked.ok,"the fork completes: "+JSON.stringify(forked)+"; agent requests "+JSON.stringify(agent.methods));
    assert.equal(forked.result.thread.providerSessionId,"budget-fork");
    assert.ok(await eventually(()=>!alive(agent.pid)),"once the fork is answered, the idle session is let go");
  }finally{await relay.close()}
});

// A harness that offers neither session/load nor session/resume cannot take a conversation up again in a new process, and the next
// turn refuses to start a new one silently: once the sweep had released such a session, every later turn of its thread failed.
test("the idle sweep keeps a session its harness could not take up again, so the thread's next turn still runs",async()=>{
  const relay=await budgetRelay("trebell-budget-noresume-",{env:SWEEP_ENV});
  try{
    const thread=relay.threadStore.create({...BUDGET_THREAD,providerSessionId:"",cwd:relay.root});
    await writeFile(relay.plan,JSON.stringify({chunks:1,agentCapabilities:{loadSession:false}}),"utf8");
    let completed=relay.notified("turn/completed");
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Hello"}]});await completed;
    await new Promise(done=>setTimeout(done,800));
    completed=relay.notified("turn/completed");
    const started=await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"And again"}]}).then(result=>({ok:true,result}),error=>({ok:false,error:String(error.message)}));
    const agents=(await relay.agentProcesses()).map(agent=>agent.methods);
    assert.ok(started.ok,"the second turn starts: "+JSON.stringify(started)+"; agent requests "+JSON.stringify(agents));
    assert.ok(await within(completed,6000),"the second turn completes");
    assert.equal(agents.length,1,"both turns ran in the one harness");
  }finally{await relay.close()}
});

// Two sends at once on a thread whose session the sweep let go (two windows, or a send beside a fork) each started a harness, and the
// later one took the thread: the other's was held by nothing, so neither the sweep nor the relay's close stopped it.
test("two sends at once on a thread the sweep let go start one harness, and the relay's close stops it",async()=>{
  const relay=await budgetRelay("trebell-budget-two-sends-",{env:SWEEP_ENV});let left=[];
  try{
    const thread=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root});
    await writeFile(relay.plan,JSON.stringify({chunks:1}),"utf8");
    let completed=relay.notified("turn/completed");await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"First"}]});await completed;
    const [first]=await relay.agentProcesses();assert.ok(await eventually(()=>!alive(first.pid)),"the sweep lets the idle session go");
    completed=relay.notified("turn/completed",2);
    await Promise.all(["From one window","From another"].map(text=>relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text}]})));
    assert.ok(await within(completed,8000),"both turns complete");
    const agents=await relay.agentProcesses();
    assert.equal(agents.length,2,"the first turn's harness, then one for both sends: "+JSON.stringify(agents.map(agent=>agent.methods)));
  }finally{
    // A harness the relay's close leaves running is counted, then stopped: it would hold the home and keep this process alive.
    const pids=(await relay.agentProcesses()).map(agent=>agent.pid);await relay.shutdown();
    await eventually(()=>!pids.some(alive),3000);left=pids.filter(alive);for(const pid of left)try{process.kill(pid)}catch{}
    await relay.close();
  }
  assert.deepEqual(left,[],"the relay's close stops every harness the thread started");
});

// The sweep closes a session it lets go in the background: the session waits up to 5 s for its harness to answer session/close, then
// stops the harness's process tree. The relay's close (the server's shutdown) returned without waiting for that, so a server that
// exited right after a sweep let a session go left its harness running. Here the harness takes 3 s to answer session/close.
test("the relay's close waits for a session the idle sweep is still closing, so its harness stops with the relay",async()=>{
  const relay=await budgetRelay("trebell-budget-sweep-close-",{env:SWEEP_ENV});
  try{
    const thread=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root});
    await writeFile(relay.plan,JSON.stringify({chunks:1,closeDelayMs:3000}),"utf8");
    const completed=relay.notified("turn/completed");await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Hello"}]});await completed;
    const [agent]=await relay.agentProcesses();
    assert.ok(await eventually(async()=>(await relay.agentProcesses())[0].methods.includes("session/close"),5000),"the sweep is closing the idle session");
    await relay.shutdown();
    assert.ok(await eventually(()=>!alive(agent.pid),1000),"the harness the sweep was closing stops with the relay's close");
  }finally{await relay.close()}
});

// OpenCode's local session names each OpenCode tool's ACP kind. Its searches (grep, glob, list) went out as "other", a kind the sweep
// keeps, so an OpenCode chat that only searched the workspace held its `opencode serve` (4 processes, 499 MB) until the thread closed.
// A stand-in for `opencode serve` (its routes and event stream, as tests/opencode-agent-session.test.mjs's) reports the turn's tools
// as completed tool parts, then answers; a released session has aborted its OpenCode session and dropped the event stream.
async function fakeOpenCodeServer(tools){
  const streams=new Set(),sessionID="ses_budget";let aborts=0,seq=0;
  const emit=event=>{for(const res of streams)res.write("data: "+JSON.stringify(event)+"\n\n")};
  const server=createServer(async(req,res)=>{
    const key=req.method+" "+new URL(req.url,"http://127.0.0.1").pathname,json=value=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(value))};
    for await(const _chunk of req);
    if(key==="GET /event"){res.writeHead(200,{"content-type":"text/event-stream"});res.write("data: "+JSON.stringify({type:"server.connected",properties:{}})+"\n\n");streams.add(res);res.on("close",()=>streams.delete(res));return}
    if(key==="GET /provider")return json({connected:["opencode"],default:{opencode:"big-pickle"},all:[{id:"opencode",models:{pickle:{id:"big-pickle"}}}]});
    if(key==="GET /config")return json({});
    if(key==="GET /command"||key==="GET /agent"||key==="GET /skill"||key==="GET /session/"+sessionID+"/message")return json([]);
    if(key==="POST /session"||key==="GET /session/"+sessionID||key==="PATCH /session/"+sessionID)return json({id:sessionID});
    if(key==="POST /session/"+sessionID+"/abort"){aborts++;return json(true)}
    if(key==="POST /session/"+sessionID+"/message"){
      const messageID="msg_a"+(++seq);
      emit({type:"message.updated",properties:{sessionID,info:{id:messageID,sessionID,role:"assistant"}}});
      for(const tool of tools)emit({type:"message.part.updated",properties:{part:{id:"prt_"+(++seq),sessionID,messageID,type:"tool",tool,callID:"call_"+seq,state:{status:"completed",title:tool,input:{},output:"done"}}}});
      await new Promise(done=>setTimeout(done,150));
      return json({info:{id:messageID,role:"assistant",tokens:{input:3,output:1}},parts:[{id:"prt_text_"+seq,type:"text",text:"OK"}]});
    }
    res.writeHead(404,{"content-type":"application/json"});res.end(JSON.stringify({name:"NotFoundError",data:{message:"No fixture route for "+key}}));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {url:"http://127.0.0.1:"+server.address().port,released:()=>aborts>0&&!streams.size,close:()=>{for(const res of streams)res.end();server.closeAllConnections?.();return new Promise(resolve=>server.close(resolve))}};
}
test("the idle sweep lets an OpenCode session go whose turn only read and searched, and keeps one whose turn ran a command",async()=>{
  for(const [tools,released] of [[["read","grep","glob","list"],true],[["bash"],false]]){
    const fixture=await fakeOpenCodeServer(tools),relay=await budgetRelay("trebell-budget-opencode-",{instances:[{id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,serverUrl:fixture.url}],env:SWEEP_ENV});
    try{
      const thread=relay.threadStore.create({runtime:"opencode",providerSessionId:"ses_budget",cwd:relay.root,model:"opencode/big-pickle",providerMeta:{runtimeInstanceId:"opencode-default",permissionProfile:"supervised"}});
      const completed=relay.notified("turn/completed");await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Where is the retry limit set?"}]});await completed;
      const rows=relay.threadStore.get(thread.id).turns.at(-1).items.filter(item=>item.id?.startsWith("call_")).map(item=>item.type);
      assert.deepEqual(rows,tools.map(tool=>tool==="bash"?"commandExecution":"dynamicToolCall"),"each tool shows the row it showed before");
      if(released)assert.ok(await eventually(()=>fixture.released(),3000),"the session whose harness only read and searched is let go: "+tools.join(", "));
      else{await new Promise(done=>setTimeout(done,1000));assert.ok(!fixture.released(),"the session whose harness ran a command is kept")}
    }finally{await relay.close();await fixture.close()}
  }
});

// Counts the timers that fire while it is on, by kind and delay as scripts/perf/lib/server-tap.mjs keys them: every setTimeout and
// setInterval made after it is installed. during(ms) waits ms on a timer of its own, which is not counted.
function timerCounter(){
  const realTimeout=globalThis.setTimeout,realInterval=globalThis.setInterval,fired={};let on=false;
  const counted=(real,kind)=>function(callback,delay,...args){
    if(typeof callback!=="function")return real(callback,delay,...args);
    const key=kind+":"+(Number(delay)||0);
    return real(function(...inner){if(on)fired[key]=(fired[key]||0)+1;return callback.apply(this,inner)},delay,...args);
  };
  globalThis.setTimeout=counted(realTimeout,"timeout");globalThis.setInterval=counted(realInterval,"interval");
  const start=()=>{for(const key of Object.keys(fired))delete fired[key];on=true},stop=()=>{on=false;return {...fired}};
  return {start,stop,async during(ms){start();await new Promise(resolve=>realTimeout(resolve,ms));return stop()},restore(){globalThis.setTimeout=realTimeout;globalThis.setInterval=realInterval}};
}

// B22: with a project thread open in Trebell Native and no harness session, the idle server fired its timers 3.33 times a minute
// against 1.17 before (scripts/perf/run.mjs idle): the relay's idle sweep ran every minute with no session it could let go. It runs
// only while a harness session it may let go is held now, from the first such session to the last one to go, and a session it never
// sweeps does not arm it: Trebell Native's, and a harness session it keeps until its thread closes (a harness that cannot take its
// conversation up again, or whose turn ran a command), which kept it firing every minute for most harness chats. SWEEP_ENV shortens
// it to 50 ms here.
const NATIVE_INSTANCE=Object.freeze({id:"native-default",kind:"native",displayName:"Trebell Native",enabled:true});
test("B22: an idle relay with no harness session it may let go fires no timer, and its idle sweep runs from the first such session to the last",async t=>{
  const nativeProviderTurn=async()=>{throw new Error("No Trebell Native turn runs here.")};
  const timers=timerCounter();let relay=null;
  const idle=async when=>{const fired=await timers.during(1000);t.diagnostic("timers fired in 1 s "+when+": "+JSON.stringify(fired));assert.deepEqual(fired,{},"timers fired in 1 s "+when)};
  try{
    relay=await budgetRelay("trebell-budget-b22-",{instances:[BUDGET_INSTANCE,NATIVE_INSTANCE],env:SWEEP_ENV,nativeProviderTurn});
    await idle("with no session");
    // A Trebell Native thread is opened, which starts its session, and the session stays.
    const native=relay.threadStore.create({runtime:"native",cwd:relay.root,model:"fixture-model",providerMeta:{runtimeInstanceId:"native-default",permissionProfile:"supervised"}});
    const opened=await relay.rpc("thread/resume",{threadId:native.id,cwd:relay.root,excludeTurns:true});
    assert.match(String(opened.thread.providerSessionId),/^native_/,"opening the Trebell Native thread started its session");
    await idle("with a Trebell Native session and no harness session");
    // A harness turn: the sweep runs while its session is held, and lets it go once it is idle.
    const thread=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root});
    await writeFile(relay.plan,JSON.stringify({chunks:1,tools:[{kind:"read",title:"Read README.md"}]}),"utf8");
    timers.start();
    const completed=relay.notified("turn/completed");await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"What does the README say?"}]});await completed;
    const [agent]=await relay.agentProcesses();
    assert.ok(await eventually(()=>!alive(agent.pid)),"the idle harness session is let go");
    const held=timers.stop();t.diagnostic("timers fired from the harness turn to its session's release: "+JSON.stringify(held));
    assert.ok(held["interval:50"]>0,"the sweep ran while the harness session was held: "+JSON.stringify(held));
    // What the release itself waits on ends first (taskkill gets 3 s).
    await new Promise(done=>setTimeout(done,3500));
    await idle("once the last harness session went, the Trebell Native one still held");
    // A harness session the sweep keeps until its thread closes does not hold it on either: one whose harness can neither load nor
    // resume a conversation never arms it, and one whose turn ran a command (which may have left work running past the turn) stops it
    // from that command on. Armed by either, it fired every 50 ms here until the relay closed.
    const unresumable=relay.threadStore.create({...BUDGET_THREAD,providerSessionId:"",cwd:relay.root});
    await writeFile(relay.plan,JSON.stringify({chunks:1,agentCapabilities:{loadSession:false}}),"utf8");
    timers.start();
    let done=relay.notified("turn/completed");await relay.rpc("turn/start",{threadId:unresumable.id,input:[{type:"text",text:"Hello"}]});await done;
    const unresumableTurn=timers.stop();t.diagnostic("timers fired over the turn of a harness that cannot resume: "+JSON.stringify(unresumableTurn));
    assert.equal(unresumableTurn["interval:50"]||0,0,"the sweep ran for a harness session it never lets go: "+JSON.stringify(unresumableTurn));
    await idle("with a harness session held whose harness cannot take its conversation up again");
    const command=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root});
    await writeFile(relay.plan,JSON.stringify({chunks:1,tools:[{kind:"execute",title:"npm test"}]}),"utf8");
    done=relay.notified("turn/completed");await relay.rpc("turn/start",{threadId:command.id,input:[{type:"text",text:"Run the tests"}]});await done;
    // What the turn's command row still writes ends first (TOOL_WRITE_MS).
    await new Promise(resolve=>setTimeout(resolve,700));
    await idle("with harness sessions held that the sweep keeps: one that cannot resume, one whose turn ran a command");
    assert.equal((await relay.agentProcesses()).filter(agent=>alive(agent.pid)).length,2,"both kept sessions' harnesses still run");
    // A session it may let go arms it again beside them, and the sweep stops once that one is let go.
    const reader=relay.threadStore.create({...BUDGET_THREAD,cwd:relay.root});
    await writeFile(relay.plan,JSON.stringify({chunks:1,tools:[{kind:"read",title:"Read README.md"}]}),"utf8");
    timers.start();
    done=relay.notified("turn/completed");await relay.rpc("turn/start",{threadId:reader.id,input:[{type:"text",text:"What does the README say?"}]});await done;
    const readerAgent=(await relay.agentProcesses()).at(-1);
    assert.ok(await eventually(()=>!alive(readerAgent.pid)),"the session that only read a file is let go beside the kept ones");
    const again=timers.stop();t.diagnostic("timers fired from that turn to its session's release: "+JSON.stringify(again));
    assert.ok(again["interval:50"]>0,"the sweep ran while that session was held: "+JSON.stringify(again));
    await new Promise(resolve=>setTimeout(resolve,3500));
    await idle("once that session went, with the two kept ones still held");
  }finally{timers.restore();await relay?.close()}
});

// B22: the store's timer for the threads it keeps parsed was set while a reply streamed and fired a minute later to find that thread
// used since, then once for each thread kept (the perf idle's timeout:60001, 71 and 2536 in its first idle minute). It fires only to
// let threads go now: never while they are in use, and at most once for each thread at idle.
test("B22: the thread store's idle timer fires only to let kept threads go, never while they are in use",async t=>{
  t.mock.timers.enable({apis:["setTimeout","Date"],now:Date.now()});
  const home=await mkdtemp(join(tmpdir(),"trebell-budget-b22-store-")),mocked=globalThis.setTimeout;let fired=0;
  globalThis.setTimeout=function(callback,...rest){return mocked(typeof callback==="function"?function(...args){fired++;return callback.apply(this,args)}:callback,...rest)};
  try{
    const store=new AgentThreadStore({...process.env,TREBELL_HOME:home}),[streamed,opened]=["Streamed","Opened"].map(name=>store.create({...BUDGET_THREAD,cwd:home,name}).id);
    const read=store.storage.read;let reads=0;store.storage.read=(...args)=>{reads++;return read.apply(store.storage,args)};
    // A reply streams for three minutes, its thread read at each chunk; another thread opens 2.5 s after it ends, then both sit idle.
    // Time goes on in short steps: a timer that one long tick runs reads the tick's end as the time.
    const wait=ms=>{for(let at=0;at<ms;at+=50)t.mock.timers.tick(50)};
    for(let at=0;at<3*60_000;at+=50){store.peek(streamed);t.mock.timers.tick(50)}
    const inUse=fired;fired=0;
    wait(2_500);store.peek(opened);assert.equal(reads,2,"each thread is read once while it is used");
    wait(10*60_000);t.diagnostic("store timers fired: "+inUse+" in three minutes of use, "+fired+" in ten idle minutes");
    assert.ok(fired<=2,"the store's timer fired "+fired+" times over ten idle minutes with two threads kept (and "+inUse+" times in the three minutes its one thread was read every 50 ms)");
    assert.equal(inUse,0,"the store's timer fired while its one thread was read every 50 ms");
    store.peek(streamed);store.peek(opened);assert.equal(reads,4,"both threads were let go");
  }finally{globalThis.setTimeout=mocked;t.mock.timers.reset();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// B24 (the server half): memory stays flat over thread opens. An open reads its thread's history through the store's peek() (the
// resume and the item and turn pages beside it, B3), which keeps the 2 threads used last parsed (THREAD_CACHE in
// src/agent-thread-store.mjs) and lets them go a minute after their last use. Six threads of 0.75 MB (246 turns, about 0.87 MB of
// heap once parsed) are opened five times each in turn, 2 s apart, each open reading its thread three times, with WeakRefs to every
// thread read to count those still alive after a GC; gc comes from V8 at run time, as node --test runs without --expose-gc. Measured
// in 3 runs: at most 2 parsed threads alive after any open and none once the keep window had passed (the clock and the store's timer
// mocked, as in B22), the heap 1.70-1.73 MB over the warm one while the two were kept, and -1, -1 and +36 KB over it once they were
// let go. The limit, 512 KB, is 14 times the largest and under what one parsed thread holds, so a thread kept past the window, or a
// copy kept of each thread read, fails it (a store keeping each thread it parsed had 36 alive and grew the heap 24.7 MB).
const B24_STORE=Object.freeze({keptThreads:2,heapGrowthBytes:512*1024});
test("B24: six 0.75 MB threads opened five times each keep at most two parsed, and the heap is back to its warm size once they are let go",async t=>{
  setFlagsFromString("--expose-gc");const gc=runInNewContext("gc");
  t.mock.timers.enable({apis:["setTimeout","Date"],now:Date.now()});
  const home=await mkdtemp(join(tmpdir(),"trebell-budget-b24-"));
  try{
    const store=new AgentThreadStore({...process.env,TREBELL_HOME:home}),turns=seededTurns(0.75).length;
    const ids=Array.from({length:6},(_,n)=>store.importHistory({...BUDGET_THREAD,providerSessionId:"budget-b24-"+n,cwd:home,name:"Memory "+n,turns:seededTurns(0.75)}).id);
    const read=store.storage.read;let reads=0;store.storage.read=(...args)=>{reads++;return read.apply(store.storage,args)};
    // Every thread an open reads is held here weakly, so those still alive after a GC are the ones the store (or anything) keeps.
    const refs=[];
    const open=id=>{for(let n=0;n<3;n++){const thread=store.peek(id);assert.equal(thread?.turns?.length,turns);refs.push(new WeakRef(thread))}};
    // A WeakRef holds its thread until the job that made or read it ends, so the GC runs a turn later.
    const collect=async()=>{await new Promise(resolve=>setImmediate(resolve));gc();gc()};
    const alive=()=>new Set(refs.map(ref=>ref.deref()).filter(Boolean)).size;
    const heapUsed=async()=>{await collect();return process.memoryUsage().heapUsed};
    // Time goes on in short steps, as in B22.
    const wait=ms=>{for(let at=0;at<ms;at+=50)t.mock.timers.tick(50)};
    // Warm: each thread opened once, then left for the keep window.
    for(const id of ids){open(id);wait(2_000)}
    wait(70_000);await collect();const warmKept=alive();
    const warm=await heapUsed();let most=0;
    for(let round=0;round<5;round++)for(const id of ids){open(id);await collect();most=Math.max(most,alive());wait(2_000)}
    const peak=await heapUsed();
    wait(70_000);await collect();const left=alive(),end=await heapUsed(),growth=end-warm;
    t.diagnostic("B24 store: "+JSON.stringify({reads,warmKept,mostKept:most,keptAfterWindow:left,warmMB:Number((warm/1048576).toFixed(2)),peakGrowthKB:Math.round((peak-warm)/1024),growthKB:Math.round(growth/1024)}));
    assert.ok(most<=B24_STORE.keptThreads,"parsed threads alive after an open: "+most);
    assert.deepEqual({warmKept,left},{warmKept:0,left:0},"parsed threads alive once the keep window has passed, after the warm-up and at the end");
    assert.ok(growth<=B24_STORE.heapGrowthBytes,"heap growth over the warm heap: "+growth+" bytes");
    assert.equal(reads,6+30,"each open read its thread from sqlite once, the two kept being the two opened before it");
  }finally{t.mock.timers.reset();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});
