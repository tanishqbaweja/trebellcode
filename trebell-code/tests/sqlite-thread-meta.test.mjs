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
      cwd:"C:/repo",runtime:"native",runtimeInstanceId:"native-default",provider:"freebuff",environmentId:null,branch:"feature/sqlite",projectless:true,snoozedUntil:12345,
      threadSnapshot:{id:"thread-1",name:"SQLite thread",preview:"Catalog preview",cwd:"C:/repo",model:"model-a",updatedAt:102,createdAt:90,status:{type:"idle"},runtime:"native",provider:"freebuff"},
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
  }finally{await rm(home,{recursive:true,force:true})}
});
