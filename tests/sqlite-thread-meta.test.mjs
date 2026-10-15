import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";

const require=createRequire(import.meta.url);
const {DatabaseSync}=require("node:sqlite");

test("thread metadata migrates to SQLite and stays durable without returning to ui-state JSON",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-thread-meta-sqlite-")),secret="thread-meta-secret-value",env={...process.env,TREBELL_HOME:home,THREAD_META_TOKEN:secret},statePath=join(home,"ui-state.json"),dbPath=join(home,"trebell.sqlite");
  const legacyMeta={
    "thread-1":{
      cwd:"C:/repo",runtime:"native",runtimeInstanceId:"native-default",provider:"openai",environmentId:null,branch:"feature/sqlite",projectless:true,snoozedUntil:12345,
      threadSnapshot:{id:"thread-1",name:"SQLite thread",preview:"Catalog preview",cwd:"C:/repo",model:"model-a",updatedAt:102,createdAt:90,status:{type:"idle"},runtime:"native",provider:"openai"},
      goal:{threadId:"thread-1",status:"active",objective:"Ship the durable migration",updatedAt:100},
      queuedSubmissions:[{id:"queued-1",input:[{type:"text",text:"Run verification with "+secret}]}],
      continuityNotes:{completedWork:["Created schema"],pendingNextActions:["Run tests"],updatedAt:101},
      trebellContext:{task:"heavy active context",exactInjectedContext:"x".repeat(20000)},reviewedFiles:["src/one.js","src/two.js"],
      delegation:{parentThreadId:"parent-1",task:"Implement the child",status:"running",permissions:"supervised",isolation:"worktree",branch:"delegate/x",ownership:["src/child.js"]},
      linkedPullRequests:[{identity:{provider:"github",host:"github.com",repository:"acme/demo",number:17},title:"Compact PR",state:"OPEN",url:"https://github.com/acme/demo/pull/17",headRefName:"feature",baseRefName:"main"}],
      updatedAt:102,
    },
  };
  try{
    await writeFile(statePath,JSON.stringify({version:2,projects:[],threadMeta:legacyMeta,settings:{appearance:"dark"},environments:[],stashes:[]}),"utf8");
    const first=new TrebellStateStore(env);
    assert.equal(first.threadMeta("thread-1").goal.objective,"Ship the durable migration");
    assert.equal(first.listThreadMeta()["thread-1"].branch,"feature/sqlite");
    assert.equal(first.snapshot({includeCollections:false}).threadMeta["thread-1"].queuedSubmissions[0].id,"queued-1");
    const catalog=first.snapshot({includeCollections:false,threadMetaView:"catalog"}).threadMeta["thread-1"];
    assert.equal(catalog.runtime,"native");assert.equal(catalog.runtimeInstanceId,"native-default");assert.equal(catalog.projectless,true);assert.equal(catalog.threadSnapshot.name,"SQLite thread");
    assert.equal(catalog.delegation.parentThreadId,"parent-1");assert.equal(catalog.delegation.ownership[0],"src/child.js");assert.equal(catalog.linkedPullRequests[0].identity.number,17);
    for(const heavy of ["goal","queuedSubmissions","continuityNotes","trebellContext","reviewedFiles"])assert.equal(Object.prototype.hasOwnProperty.call(catalog,heavy),false,heavy+" must stay out of bootstrap catalog metadata");
    assert.match(first.threadMeta("thread-1").queuedSubmissions[0].input[0].text,/Run verification with \[redacted\]/);assert.doesNotMatch(JSON.stringify(first.threadMeta("thread-1")),new RegExp(secret));

    const persisted=JSON.parse(await readFile(statePath,"utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(persisted,"threadMeta"),false,"ui-state JSON should stop carrying per-thread durable state");
    const db=new DatabaseSync(dbPath);try{
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM state_thread_meta").get().count),1);
      assert.equal(db.prepare("SELECT runtime FROM state_thread_meta WHERE thread_id=?").get("thread-1").runtime,"native");
      const row=db.prepare("SELECT catalog_json,payload_json FROM state_thread_meta WHERE thread_id=?").get("thread-1");assert.ok(row.catalog_json.length<row.payload_json.length/2,"catalog projection should stay materially smaller than full active-thread metadata");
    }finally{db.close()}

    first.updateThreadMeta("thread-1",{goal:{...first.threadMeta("thread-1").goal,status:"complete",updatedAt:200},delegation:{status:"done",error:"token="+secret},queuedSubmissions:[{id:"queued-secret",input:[{type:"text",text:"Use "+secret+" later"}]}]});
    first.updateThreadMeta("thread-2",{cwd:"C:/repo-2",runtime:"codex",environmentId:"ssh-1",goal:{threadId:"thread-2",status:"active",objective:"Remote goal"}});
    const second=new TrebellStateStore(env);
    assert.equal(second.threadMeta("thread-1").goal.status,"complete");assert.equal(second.threadMeta("thread-1").delegation.status,"done");assert.match(second.threadMeta("thread-1").delegation.error,/\[redacted\]/);assert.match(second.threadMeta("thread-1").queuedSubmissions[0].input[0].text,/Use \[redacted\] later/);assert.doesNotMatch(JSON.stringify(second.threadMeta("thread-1")),new RegExp(secret));
    assert.equal(second.threadMeta("thread-2").environmentId,"ssh-1");assert.equal(second.listThreadMeta()["thread-2"].goal.objective,"Remote goal");
    const persistedAgain=JSON.parse(await readFile(statePath,"utf8"));assert.equal(Object.prototype.hasOwnProperty.call(persistedAgain,"threadMeta"),false);
  }finally{await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// The store keeps the text of the meta it last read or wrote and, when asked, one sqlite connection. The row stays the source of
// truth: a write lands in sqlite before it is served, a write that fails is not served, and a removed thread reads as empty.
test("thread meta reads come from a write-through copy that always matches the row",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-thread-meta-cache-")),env={...process.env,TREBELL_HOME:home},dbPath=join(home,"trebell.sqlite");
  const withDb=fn=>{const db=new DatabaseSync(dbPath);try{return fn(db)}finally{db.close()}};
  const row=threadId=>withDb(db=>{const found=db.prepare("SELECT payload_json FROM state_thread_meta WHERE thread_id=?").get(threadId);return found?JSON.parse(found.payload_json):null});
  let state=null;
  try{
    state=new TrebellStateStore(env,{keepConnection:true});
    const counts={opens:0,statements:0};
    state.collections.DatabaseSync=class extends DatabaseSync{constructor(...args){super(...args);counts.opens++}prepare(sql){counts.statements++;return super.prepare(sql)}};
    const written=state.updateThreadMeta("thread-1",{cwd:"C:/repo",tags:["a"],nested:{value:1}});
    assert.deepEqual(row("thread-1"),written);assert.deepEqual(counts,{opens:1,statements:2},"one kept connection; a read of the missing row and the write");
    // The kept connection runs at the durability a connection of its own has, not the schema setup's synchronous=NORMAL.
    assert.equal(state.collections.db.prepare("PRAGMA synchronous").get().synchronous,withDb(db=>db.prepare("PRAGMA synchronous").get().synchronous));counts.statements--;
    const read=state.threadMeta("thread-1");
    assert.deepEqual(read,written);assert.equal(counts.statements,2,"a cached read runs no statement");
    read.tags.push("changed");read.nested.value=2;written.tags.push("changed");
    assert.deepEqual(state.threadMeta("thread-1").tags,["a"],"callers get their own copy");assert.equal(state.threadMeta("thread-1").nested.value,1);
    // A write that sqlite rejects is neither served nor kept, and the connection it failed on is replaced.
    withDb(db=>db.exec("CREATE TRIGGER reject_meta BEFORE UPDATE ON state_thread_meta WHEN NEW.payload_json LIKE '%C:/rejected%' BEGIN SELECT RAISE(ABORT,'rejected write'); END;"));
    assert.throws(()=>state.updateThreadMeta("thread-1",{cwd:"C:/rejected"}),/rejected write/);
    withDb(db=>db.exec("DROP TRIGGER reject_meta"));
    const statementsBefore=counts.statements;
    assert.equal(state.threadMeta("thread-1").cwd,"C:/repo");assert.equal(row("thread-1").cwd,"C:/repo");
    assert.equal(counts.statements,statementsBefore+1,"the read after a failed write goes to sqlite");assert.equal(counts.opens,2);
    assert.equal(state.updateThreadMeta("thread-1",{cwd:"C:/next"}).cwd,"C:/next");assert.equal(state.threadMeta("thread-1").cwd,"C:/next");assert.equal(row("thread-1").cwd,"C:/next");
    assert.equal(state.removeThreadMeta("thread-1"),true);assert.deepEqual(state.threadMeta("thread-1"),{});assert.equal(row("thread-1"),null);
    // It keeps the 64 threads used last.
    for(let index=0;index<70;index++)state.updateThreadMeta("thread-many-"+index,{cwd:"C:/repo-"+index});
    const statementsAfterWrites=counts.statements;
    assert.equal(state.threadMeta("thread-many-69").cwd,"C:/repo-69");assert.equal(state.threadMeta("thread-many-6").cwd,"C:/repo-6");assert.equal(counts.statements,statementsAfterWrites);
    assert.equal(state.threadMeta("thread-many-0").cwd,"C:/repo-0");assert.equal(counts.statements,statementsAfterWrites+1);
    // After close, a late write still lands and each call opens and closes its own connection.
    state.close();const opensAfterClose=counts.opens;
    state.updateThreadMeta("thread-late",{cwd:"C:/late"});assert.equal(row("thread-late").cwd,"C:/late");assert.equal(state.collections.db,null);assert.equal(counts.opens,opensAfterClose+2);
  }finally{state?.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// A patch that changes nothing but the time is not written. Everything else writes as before: a new thread, an empty patch or one of
// only updatedAt (a touch), a removed key, and a stored value the redaction would now change.
test("an unchanged thread meta patch keeps the row and its updatedAt",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-thread-meta-unchanged-")),secret="unchanged-meta-secret",env={...process.env,TREBELL_HOME:home},dbPath=join(home,"trebell.sqlite");
  const row=threadId=>{const db=new DatabaseSync(dbPath);try{return db.prepare("SELECT updated_at,payload_json FROM state_thread_meta WHERE thread_id=?").get(threadId)||null}finally{db.close()}};
  const later=()=>new Promise(resolve=>setTimeout(resolve,5));
  try{
    let state=new TrebellStateStore(env),writes=0;
    const count=store=>{store.collections.DatabaseSync=class extends DatabaseSync{exec(sql){if(/BEGIN IMMEDIATE/i.test(String(sql)))writes++;return super.exec(sql)}}};count(state);
    assert.equal(state.updateThreadMeta("thread-new",{archived:undefined}).archived,undefined);assert.equal(writes,1,"a new thread gets its row");assert.ok(row("thread-new"));
    const stored=state.updateThreadMeta("thread-1",{cwd:"C:/repo",goal:{status:"active",objective:"Ship"},note:"uses "+secret});
    const storedRow=row("thread-1");writes=0;await later();
    const same=state.updateThreadMeta("thread-1",{cwd:"C:/repo",goal:{objective:"Ship",status:"active"},missing:undefined});
    assert.equal(writes,0,"same values, keys in another order, and an absent key cleared");assert.deepEqual(same,stored);assert.deepEqual(row("thread-1"),storedRow);
    same.goal.status="changed";assert.equal(state.threadMeta("thread-1").goal.status,"active","the returned meta is the caller's copy");
    for(const patch of [{},{updatedAt:1}]){await later();const touched=state.updateThreadMeta("thread-1",patch);assert.ok(touched.updatedAt>stored.updatedAt,JSON.stringify(patch)+" still touches the thread")}
    assert.equal(writes,2);
    await later();assert.equal(Object.prototype.hasOwnProperty.call(state.updateThreadMeta("thread-1",{note:undefined}),"note"),false);assert.equal(writes,3,"removing a key is written");
    state.updateThreadMeta("thread-1",{note:"uses "+secret});writes=0;
    // A secret that is now in the environment is redacted on the next write, so that write is not skipped.
    state=new TrebellStateStore({...env,THREAD_META_TOKEN:secret});count(state);
    const redacted=state.updateThreadMeta("thread-1",{cwd:"C:/repo"});
    assert.equal(writes,1);assert.match(redacted.note,/[redacted]/);assert.doesNotMatch(row("thread-1").payload_json,new RegExp(secret));
    assert.equal(state.updateThreadMeta("thread-1",{note:"uses "+secret}).updatedAt,redacted.updatedAt,"the same secret again stores the same redacted text");assert.equal(writes,1);
  }finally{await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});
