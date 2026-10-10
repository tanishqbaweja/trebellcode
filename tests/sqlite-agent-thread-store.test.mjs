import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";

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
    const originalGet=store.storage.get;let storageGets=0;store.storage.get=(...args)=>{storageGets++;return originalGet.apply(store.storage,args)};
    const created=store.getMetadata(thread.id);assert.equal(created.id,thread.id);assert.deepEqual(created.turns,[]);assert.equal(created.status.type,"idle");assert.equal(storageGets,0);
    created.providerMeta.permissionProfile="mutated";assert.equal(store.getMetadata(thread.id).providerMeta.permissionProfile,"supervised","metadata callers must receive an isolated copy");
    const turn=store.addTurn(thread.id,{id:"metadata-turn",inputText:"hello"});assert.equal(turn.status,"inProgress");assert.equal(store.getMetadata(thread.id).status.type,"active");assert.deepEqual(store.getMetadata(thread.id).turns,[]);assert.equal(storageGets,1,"the write may hydrate once, but metadata reads must not add storage gets");
    store.finishTurn(thread.id,turn.id);assert.equal(store.getMetadata(thread.id).status.type,"idle");assert.equal(storageGets,2);assert.equal(store.get(thread.id).turns.length,1);assert.equal(storageGets,3);
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
