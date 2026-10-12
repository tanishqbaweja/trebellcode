import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
async function prompt(id){
  const plan=JSON.parse(readFileSync(process.argv[2],"utf8"));cancelled=false;
  await until(plan.startFile);
  if(plan.toolUpdates){
    const toolCallId="budget-tool";let output="";
    update({sessionUpdate:"tool_call",toolCallId,title:"npm test",kind:"execute",status:"in_progress",rawInput:{command:"npm test"}});
    await paced(plan.toolUpdates,plan.rate,i=>{output+=("ok "+i+" streamed test output ").padEnd(199,".")+"\n";update({sessionUpdate:"tool_call_update",toolCallId,status:"in_progress",rawOutput:output})});
    if(plan.terminal!==false)update({sessionUpdate:"tool_call_update",toolCallId,status:"completed",rawOutput:output});
  }
  await paced(plan.chunks||0,plan.rate,i=>update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:("w"+i+" ").padEnd(23,"x")+" "}}));
  await until(plan.endFile);
  send({jsonrpc:"2.0",id,result:{stopReason:cancelled?"cancelled":"end_turn"}});
}
function handle(m){
  if(log&&m.method)appendFileSync(log,m.method+"\n");
  if(m.method==="session/cancel"){cancelled=true;return}
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
// instances: the harnesses the relay offers (the first is the active one); env: what the server's environment adds.
async function budgetRelay(prefix,{instances=[BUDGET_INSTANCE],env:extra={}}={}){
  const root=await mkdtemp(join(tmpdir(),prefix)),agent=join(root,"budget-acp.mjs"),plan=join(root,"plan.json"),agents=join(root,"agents");
  await writeFile(agent,BUDGET_AGENT,"utf8");await writeFile(plan,"{}","utf8");await mkdir(agents,{recursive:true});
  const env={...process.env,TREBELL_HOME:join(root,"home"),...extra},threadStore=new AgentThreadStore(env),meta=new Map(),launches={n:0},modes=[];
  const runtimeManager={
    env,instances:()=>instances.map(item=>({...item})),activeInstance:()=>({...instances[0]}),activeRuntime:()=>instances[0].kind,compatibleInstanceIds:()=>instances.map(item=>item.id),
    probe:async instance=>({id:instance.id,name:instance.displayName,available:true,authenticated:true,version:"fixture"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),
    // The relay asks for a harness's command only to build a session for it: each ask is a launch. The permission mode is the
    // launch argument Grok and Cursor take it in.
    executable:()=>{launches.n++;return process.execPath},acpArgs:(_instance,mode)=>{modes.push(mode);return [agent,plan,agents]},
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
  // How many notifications of method have arrived so far, counted as notified() matches them.
  const counter=method=>{const needle='"method":"'+method+'"',counts={n:0};ws.on("message",raw=>{if(String(raw).includes(needle))counts.n++});return counts};
  // The agent processes started so far, oldest first: each one's pid and the requests it got.
  const agentProcesses=async()=>(await readdir(agents)).sort().map(name=>({pid:Number(name.split(/[-.]/)[1]),methods:readFileSync(join(agents,name),"utf8").split("\n").filter(Boolean)}));
  return {root,threadStore,plan,rpc,notified,counter,close,launches,modes,agentProcesses,file:name=>join(root,name)};
}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
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
    await writeFile(relay.plan,JSON.stringify({chunks:3}),"utf8");
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
