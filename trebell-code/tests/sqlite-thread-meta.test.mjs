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
      cwd:"C:/repo",runtime:"native",environmentId:null,branch:"feature/sqlite",
      goal:{threadId:"thread-1",status:"active",objective:"Ship the durable migration",updatedAt:100},
      queuedSubmissions:[{id:"queued-1",input:[{type:"text",text:"Run verification with "+secret}]}],
      continuityNotes:{completedWork:["Created schema"],pendingNextActions:["Run tests"],updatedAt:101},
      updatedAt:102,
    },
  };
  try{
    await writeFile(statePath,JSON.stringify({version:2,projects:[],threadMeta:legacyMeta,settings:{appearance:"dark"},environments:[],stashes:[]}),"utf8");
    const first=new TrebellStateStore(env);
    assert.equal(first.threadMeta("thread-1").goal.objective,"Ship the durable migration");
    assert.equal(first.listThreadMeta()["thread-1"].branch,"feature/sqlite");
    assert.equal(first.snapshot({includeCollections:false}).threadMeta["thread-1"].queuedSubmissions[0].id,"queued-1");
    assert.match(first.threadMeta("thread-1").queuedSubmissions[0].input[0].text,/Run verification with \[redacted\]/);assert.doesNotMatch(JSON.stringify(first.threadMeta("thread-1")),new RegExp(secret));

    const persisted=JSON.parse(await readFile(statePath,"utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(persisted,"threadMeta"),false,"ui-state JSON should stop carrying per-thread durable state");
    const db=new DatabaseSync(dbPath);try{
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM state_thread_meta").get().count),1);
      assert.equal(db.prepare("SELECT runtime FROM state_thread_meta WHERE thread_id=?").get("thread-1").runtime,"native");
    }finally{db.close()}

    first.updateThreadMeta("thread-1",{goal:{...first.threadMeta("thread-1").goal,status:"complete",updatedAt:200},delegation:{status:"done",error:"token="+secret},queuedSubmissions:[{id:"queued-secret",input:[{type:"text",text:"Use "+secret+" later"}]}]});
    first.updateThreadMeta("thread-2",{cwd:"C:/repo-2",runtime:"codex",environmentId:"ssh-1",goal:{threadId:"thread-2",status:"active",objective:"Remote goal"}});
    const second=new TrebellStateStore(env);
    assert.equal(second.threadMeta("thread-1").goal.status,"complete");assert.equal(second.threadMeta("thread-1").delegation.status,"done");assert.match(second.threadMeta("thread-1").delegation.error,/\[redacted\]/);assert.match(second.threadMeta("thread-1").queuedSubmissions[0].input[0].text,/Use \[redacted\] later/);assert.doesNotMatch(JSON.stringify(second.threadMeta("thread-1")),new RegExp(secret));
    assert.equal(second.threadMeta("thread-2").environmentId,"ssh-1");assert.equal(second.listThreadMeta()["thread-2"].goal.objective,"Remote goal");
    const persistedAgain=JSON.parse(await readFile(statePath,"utf8"));assert.equal(Object.prototype.hasOwnProperty.call(persistedAgain,"threadMeta"),false);
  }finally{await rm(home,{recursive:true,force:true})}
});
