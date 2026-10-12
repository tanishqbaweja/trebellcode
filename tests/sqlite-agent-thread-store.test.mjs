import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { SqliteAgentThreadStore } from "../src/sqlite-agent-thread-store.mjs";

const require=createRequire(import.meta.url);
const {DatabaseSync}=require("node:sqlite");

test("legacy agent thread JSON imports once into normalized SQLite thread and turn tables",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-sqlite-migration-")),secret="legacy-secret-that-must-not-survive",env={...process.env,TREBELL_HOME:home,LEGACY_THREAD_SECRET:secret};
  const legacyPath=join(home,"agent-threads.json"),sqlitePath=join(home,"trebell.sqlite");
  const legacy={version:1,threads:[{
    id:"legacy-thread",runtime:"claude",providerSessionId:"provider-legacy",cwd:home,model:"sonnet",createdAt:10,updatedAt:20,status:{type:"idle"},archived:false,section:null,
    turns:[{id:"legacy-turn",status:"completed",startedAt:11,completedAt:12,durationMs:1000,error:null,items:[{id:"message-1",type:"agentMessage",text:"Imported history token="+secret}]}],
  }]};
  try{
    await writeFile(legacyPath,JSON.stringify(legacy),"utf8");
    const first=new AgentThreadStore(env),imported=first.get("legacy-thread");
    assert.equal(imported.providerSessionId,"provider-legacy");assert.equal(imported.turns.length,1);assert.match(imported.turns[0].items[0].text,/Imported history token=\[redacted\]/);assert.doesNotMatch(JSON.stringify(imported),new RegExp(secret));
    assert.deepEqual(first.searchCandidates("claude","Imported history").map(item=>item.id),["legacy-thread"]);
    const db=new DatabaseSync(sqlitePath);try{
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM agent_threads").get().count),1);
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM agent_turns").get().count),1);
      assert.ok(db.prepare("SELECT value FROM agent_store_meta WHERE key='legacy_agent_threads_imported'").get()?.value);
    }finally{db.close()}

    const retired=JSON.parse(await readFile(legacyPath,"utf8"));assert.equal(retired.migratedTo,"trebell.sqlite");assert.equal(retired.importedThreads,1);assert.equal(Object.prototype.hasOwnProperty.call(retired,"threads"),false);assert.doesNotMatch(JSON.stringify(retired),new RegExp(secret));
    const changed={version:1,threads:[{id:"late-legacy-thread",runtime:"claude",providerSessionId:"late",cwd:home,createdAt:30,updatedAt:30,status:{type:"idle"},archived:false,turns:[]}]};
    await writeFile(legacyPath,JSON.stringify(changed),"utf8");
    const second=new AgentThreadStore(env);
    assert.equal(second.get("late-legacy-thread"),null,"legacy JSON must not become an active second source of truth after migration");
    const created=second.create({runtime:"native",cwd:home,providerSessionId:"native-new"});second.addTurn(created.id,{id:"native-turn",inputText:"Persist me"});second.finishTurn(created.id,"native-turn");
    const third=new AgentThreadStore(env);assert.equal(third.list().find(item=>item.id===created.id)?.turns?.length,0,"startup catalog must not hydrate transcript turns");assert.equal(third.get(created.id).turns[0].status,"completed");
    const retiredAgain=JSON.parse(await readFile(legacyPath,"utf8"));assert.equal(retiredAgain.migratedTo,"trebell.sqlite");assert.equal(Object.prototype.hasOwnProperty.call(retiredAgain,"threads"),false,"a recreated legacy file must be retired instead of becoming a second source of truth");
  }finally{await rm(home,{recursive:true,force:true})}
});

test("SQLite search projection indexes visible conversation only and removes rewound turns",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-sqlite-search-")),env={...process.env,TREBELL_HOME:home};
  try{
    const store=new AgentThreadStore(env),thread=store.create({runtime:"native",cwd:home,providerSessionId:"native-search",name:"Searchable workspace"});
    const turn=store.addTurn(thread.id,{id:"search-turn",inputText:"alpha user request"});
    store.addItem(thread.id,turn.id,{id:"draft-agent",type:"agentMessage",text:"draft-only-phrase"});
    store.addItem(thread.id,turn.id,{id:"tool-output",type:"commandExecution",status:"completed",aggregatedOutput:"tool-only-phrase"});
    store.addItem(thread.id,turn.id,{id:"final-agent",type:"agentMessage",text:"omega final answer"});
    store.finishTurn(thread.id,turn.id);
    assert.deepEqual(store.searchCandidates("native","Searchable workspace").map(item=>item.id),[thread.id]);
    const user=store.searchCandidates("native","alpha user");assert.equal(user.length,1);assert.match(JSON.stringify(user[0].turns),/alpha user request/);
    const assistant=store.searchCandidates("native","omega final");assert.equal(assistant.length,1);assert.match(JSON.stringify(assistant[0].turns),/omega final answer/);
    assert.deepEqual(store.searchCandidates("native","tool-only-phrase"),[]);
    assert.deepEqual(store.searchCandidates("native","draft-only-phrase"),[]);
    assert.deepEqual(store.searchCandidates("native","al").map(item=>item.id),[thread.id],"short substring search falls back without changing semantics");
    store.update(thread.id,{turns:[]});
    assert.deepEqual(store.searchCandidates("native","alpha user"),[],"rewind/removal must remove stale search projection rows");
  }finally{await rm(home,{recursive:true,force:true})}
});

test("AgentThreadStore metadata reads stay transcript-free and current without SQLite hydration",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-metadata-")),env={...process.env,TREBELL_HOME:home};
  try{
    const store=new AgentThreadStore(env),thread=store.create({runtime:"native",cwd:home,providerSessionId:"metadata",model:"fixture",providerMeta:{permissionProfile:"supervised"}});
    const originalRead=store.storage.read;let storageReads=0;store.storage.read=(...args)=>{storageReads++;return originalRead.apply(store.storage,args)};
    const created=store.getMetadata(thread.id);assert.equal(created.id,thread.id);assert.deepEqual(created.turns,[]);assert.equal(created.status.type,"idle");assert.equal(storageReads,0);
    created.providerMeta.permissionProfile="mutated";assert.equal(store.getMetadata(thread.id).providerMeta.permissionProfile,"supervised","metadata callers must receive an isolated copy");
    const turn=store.addTurn(thread.id,{id:"metadata-turn",inputText:"hello"});assert.equal(turn.status,"inProgress");assert.equal(store.getMetadata(thread.id).status.type,"active");assert.deepEqual(store.getMetadata(thread.id).turns,[]);assert.equal(storageReads,1,"the write may hydrate once, but metadata reads must not add storage reads");
    // The thread the write read stays parsed, and each later write replaces it with what it wrote: no further sqlite read.
    store.finishTurn(thread.id,turn.id);assert.equal(store.getMetadata(thread.id).status.type,"idle");assert.equal(storageReads,1);assert.equal(store.get(thread.id).turns.length,1);assert.equal(storageReads,1);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("a thread saved with no title is titled by its first message at startup, and keeps its place in the list",async()=>{
  // The live tour: every harness thread saved before a new thread took its first message as its title was listed as "Untitled task",
  // and a later turn would have titled it by that later message.
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-untitled-")),env={...process.env,TREBELL_HOME:home};
  try{
    const first=new AgentThreadStore(env);
    const untitled=first.create({runtime:"cursor",cwd:home,providerSessionId:"cursor-1"});
    first.finishTurn(untitled.id,first.addTurn(untitled.id,{inputText:"  Run this shell command and tell me its output:\n node -e \"console.log('trebell-tour')\"  "}).id);
    first.finishTurn(untitled.id,first.addTurn(untitled.id,{inputText:"Reply with exactly TREBELL_TOUR_RESUMED"}).id);
    const short=first.create({runtime:"grok",cwd:home,providerSessionId:"grok-1"});
    first.finishTurn(short.id,first.addTurn(short.id,{inputText:"Reply with exactly TREBELL_TOUR_OK"}).id);
    const named=first.create({runtime:"cursor",cwd:home,providerSessionId:"cursor-2",name:"Kept name"});
    first.finishTurn(named.id,first.addTurn(named.id,{inputText:"Other words"}).id);
    const empty=first.create({runtime:"grok",cwd:home,providerSessionId:""});
    const order=store=>Object.fromEntries(store.list().map(thread=>[thread.id,thread.updatedAt])),before=order(first);
    const reopened=new AgentThreadStore(env);
    assert.equal(reopened.getMetadata(untitled.id).preview,"Run this shell command and tell me its output: nod...","its first message, on one line, at most 50 characters");
    assert.equal(reopened.getMetadata(short.id).preview,"Reply with exactly TREBELL_TOUR_OK");
    assert.equal(reopened.getMetadata(named.id).name,"Kept name");assert.equal(reopened.getMetadata(named.id).preview,null,"a named thread is left as it is");
    assert.equal(reopened.getMetadata(empty.id).preview,null,"a thread with no message stays untitled");
    assert.deepEqual(order(reopened),before,"no thread moves in the list (its updated time is kept)");
    assert.equal(reopened.get(untitled.id).turns.length,2,"the transcript is untouched");
    assert.equal(new AgentThreadStore(env).getMetadata(untitled.id).preview,"Run this shell command and tell me its output: nod...","the title is saved");
  }finally{await rm(home,{recursive:true,force:true})}
});

test("a thread keeps a reasoning item's start and end within a bound, and redacts it like other stored text",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-reasoning-bound-")),secret="reasoning-secret-that-must-not-survive",env={...process.env,TREBELL_HOME:home,REASONING_SECRET:secret};
  try{
    const store=new AgentThreadStore(env),thread=store.create({runtime:"cursor",cwd:home}),turn=store.addTurn(thread.id,{inputText:"think"});
    const long="FIRST "+"a".repeat(100*1024)+" LAST";
    store.addItem(thread.id,turn.id,{type:"reasoning",id:"r-long",summary:[],content:[long]});
    store.addItem(thread.id,turn.id,{type:"reasoning",id:"r-secret",summary:["Using "+secret],content:[]});
    const [stored,redacted]=store.get(thread.id).turns[0].items.filter(item=>item.type==="reasoning");
    assert.ok(stored.content[0].length<=64*1024,"the stored text is bounded");
    assert.ok(stored.content[0].startsWith("FIRST ")&&stored.content[0].endsWith(" LAST"),"it keeps the thought's start and end");
    assert.deepEqual(redacted.summary,["Using [redacted]"]);
  }finally{await rm(home,{recursive:true,force:true})}
});

function deepFreeze(value){if(value&&typeof value==="object"&&!Object.isFrozen(value)){Object.freeze(value);for(const item of Object.values(value))deepFreeze(item)}return value}

test("the thread a store keeps parsed is what a fresh sqlite read gives after every kind of write, and a write leaves a peeked thread as it was",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-cache-")),secret="cache-secret-that-must-not-survive",env={...process.env,TREBELL_HOME:home,CACHE_SECRET:secret};
  try{
    const store=new AgentThreadStore(env),reader=new SqliteAgentThreadStore(env);
    // Every thread peek hands out, the store's own writes included, is frozen here: a write that changed a shared object would throw.
    const peek=store.peek.bind(store);store.peek=id=>deepFreeze(peek(id));
    const same=(id,label)=>assert.deepEqual(peek(id),reader.get(id),label);
    const thread=store.create({runtime:"cursor",cwd:home,providerSessionId:"cache",providerMeta:{permissionProfile:"supervised"}});
    const first=store.addTurn(thread.id,{inputText:"first "+secret,startedAt:100});same(thread.id,"a first turn");
    const held=store.peek(thread.id);
    store.addItem(thread.id,first.id,{type:"commandExecution",id:"tool-1",status:"inProgress",aggregatedOutput:"line 1"});same(thread.id,"a tool item");
    store.addItem(thread.id,first.id,{type:"commandExecution",id:"tool-1",status:"completed",aggregatedOutput:"line 1\nline 2 "+secret});same(thread.id,"a tool update");
    store.addItem(thread.id,first.id,{type:"agentMessage",id:"answer-1",text:"done"});same(thread.id,"an agent message");
    store.finishTurn(thread.id,first.id);same(thread.id,"a finished turn");
    // sqlite reads turns by start time, then in the order they were written: an earlier start goes before, an equal one after.
    const earlier=store.addTurn(thread.id,{id:"earlier",inputText:"earlier",startedAt:50});same(thread.id,"an earlier turn");
    store.addTurn(thread.id,{id:"tied",inputText:"tied",startedAt:100});same(thread.id,"a turn at an equal time");
    store.addTurn(thread.id,{id:"untimed",inputText:"untimed",startedAt:null});same(thread.id,"a turn with no start time");
    assert.deepEqual(peek(thread.id).turns.map(turn=>turn.id),["untimed","earlier",first.id,"tied"]);
    store.updateTurn(thread.id,earlier.id,{modelTurns:3});same(thread.id,"a turn patch");
    store.updateTurn(thread.id,"tied",{startedAt:10});same(thread.id,"a turn whose start time moved");
    store.restartTurn(thread.id,"tied");same(thread.id,"a restarted turn");
    store.finishTurn(thread.id,"tied",{status:"failed",error:{message:"stopped"}});same(thread.id,"a failed turn");
    store.update(thread.id,{name:"Cache "+secret,providerMeta:{permissionProfile:"auto"}});same(thread.id,"a meta patch");
    store.update(thread.id,{archived:true},{touch:false});same(thread.id,"an archive");
    store.update(thread.id,{turns:peek(thread.id).turns.slice(0,2)});same(thread.id,"a rewind");
    assert.equal(held.turns.length,1,"a thread peeked before the writes is as it was");assert.equal(held.turns[0].items.length,1);
    assert.doesNotMatch(JSON.stringify(peek(thread.id)),new RegExp(secret),"the kept thread is the redacted one sqlite holds");
    assert.equal(store.delete(thread.id),true);assert.equal(peek(thread.id),null,"a deleted thread is not served");
  }finally{await rm(home,{recursive:true,force:true})}
});

test("a store keeps the two threads used last, lets one go after a minute unused, and does not serve a write sqlite refused",async t=>{
  t.mock.timers.enable({apis:["setTimeout","Date"],now:Date.now()});
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-cache-bound-")),env={...process.env,TREBELL_HOME:home};
  try{
    const store=new AgentThreadStore(env),ids=["a","b","c"].map(name=>store.create({runtime:"cursor",cwd:home,name}).id);
    const read=store.storage.read;let reads=0;store.storage.read=(...args)=>{reads++;return read.apply(store.storage,args)};
    for(const id of ids)store.peek(id);assert.equal(reads,3);
    store.peek(ids[1]);store.peek(ids[2]);assert.equal(reads,3,"the two used last are held");
    store.peek(ids[0]);assert.equal(reads,4,"the third was let go");
    t.mock.timers.tick(59_000);store.peek(ids[0]);assert.equal(reads,4,"a thread used within the minute stays");
    t.mock.timers.tick(1_001);store.peek(ids[2]);assert.equal(reads,5,"one unused for a minute is let go");
    const turn=store.addTurn(ids[0],{inputText:"hello"}),put=store.storage.putThreadAndTurn;
    store.storage.putThreadAndTurn=()=>{throw new Error("disk full")};
    try{assert.throws(()=>store.addItem(ids[0],turn.id,{type:"agentMessage",id:"lost",text:"lost"}),/disk full/)}finally{store.storage.putThreadAndTurn=put}
    assert.equal(store.peek(ids[0]).turns[0].items.some(item=>item.id==="lost"),false);assert.equal(reads,6,"the refused write dropped the thread, so it is read again");
  }finally{await rm(home,{recursive:true,force:true})}
});

test("a store with a kept connection writes on it as durably as on a connection of its own, and after close opens its own again",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-kept-")),env={...process.env,TREBELL_HOME:home};
  try{
    const store=new AgentThreadStore(env,{keepConnection:true}),reader=new SqliteAgentThreadStore(env),opened=[];
    store.storage.DatabaseSync=class extends DatabaseSync{constructor(...args){super(...args);opened.push(args[0])}};
    const thread=store.create({runtime:"cursor",cwd:home});store.finishTurn(thread.id,store.addTurn(thread.id,{inputText:"kept"}).id);
    assert.equal(opened.length,0,"the reads and writes share the kept connection");
    assert.equal(reader.get(thread.id).turns[0].status,"completed","another connection reads each write at once");
    const probe=new DatabaseSync(store.path);
    try{assert.equal(store.storage.db.prepare("PRAGMA synchronous").get().synchronous,probe.prepare("PRAGMA synchronous").get().synchronous,"not the schema setup's synchronous=NORMAL")}finally{probe.close()}
    store.close();assert.equal(store.storage.db,null);
    store.update(thread.id,{name:"After close"});assert.equal(opened.length,2,"a read and a write after close open connections of their own");
    assert.equal(reader.get(thread.id).name,"After close");
  }finally{await rm(home,{recursive:true,force:true})}
});
