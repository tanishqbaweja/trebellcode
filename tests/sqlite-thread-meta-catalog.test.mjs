import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";

const require=createRequire(import.meta.url);
const {DatabaseSync}=require("node:sqlite");

test("thread metadata catalog backfills old SQLite rows and excludes active-thread heavy state",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-thread-catalog-")),env={...process.env,TREBELL_HOME:home},dbPath=join(home,"trebell.sqlite");
  const fullMeta={
    runtime:"native",runtimeInstanceId:"native-default",provider:"freebuff",model:"model-a",cwd:"C:/repo",environmentId:null,branch:"feature/catalog",
    projectless:false,snoozedUntil:12345,updatedAt:500,
    threadSnapshot:{id:"thread-old",name:"Catalog thread",preview:"Compact me",cwd:"C:/repo",model:"model-a",updatedAt:500,createdAt:100,status:{type:"idle"},section:{id:"Pinned",name:"Pinned"},runtime:"native",provider:"freebuff"},
    delegation:{parentThreadId:"parent-1",label:"Parser child",task:"Fix parser",role:"delegate",status:"running",permissions:"supervised",isolation:"worktree",branch:"child/parser",ownership:["src/parser.js"]},
    linkedPullRequests:[{identity:{provider:"github",host:"github.com",repository:"acme/widget",number:17},number:17,title:"Parser fix",state:"OPEN",url:"https://github.com/acme/widget/pull/17"}],
    goal:{objective:"This belongs to active-thread state",completionConditions:["Done"]},
    continuityNotes:{completedWork:["A".repeat(5000)],pendingNextActions:["B".repeat(5000)]},
    trebellQueue:[{id:"queued-1",input:[{type:"text",text:"Q".repeat(20000)}]}],
    trebellContext:{task:"T".repeat(20000),selectedFiles:Array.from({length:100},(_,index)=>({path:"src/file-"+index+".js",reason:"R".repeat(200)}))},
    reviewedFiles:Array.from({length:1000},(_,index)=>"src/reviewed-"+index+".js"),
  };
  try{
    await writeFile(join(home,"ui-state.json"),JSON.stringify({version:2,projects:[],settings:{},threadMeta:{},environments:[],stashes:[]}),"utf8");
    const db=new DatabaseSync(dbPath);
    try{
      db.exec("CREATE TABLE state_thread_meta(thread_id TEXT PRIMARY KEY,runtime TEXT,environment_id TEXT,updated_at INTEGER NOT NULL,payload_json TEXT NOT NULL)");
      db.prepare("INSERT INTO state_thread_meta(thread_id,runtime,environment_id,updated_at,payload_json) VALUES(?,?,?,?,?)").run("thread-old","native",null,500,JSON.stringify(fullMeta));
    }finally{db.close()}

    const state=new TrebellStateStore(env);
    const full=state.threadMeta("thread-old");
    assert.equal(full.goal.objective,"This belongs to active-thread state");
    assert.equal(full.trebellQueue[0].id,"queued-1");
    assert.equal(full.trebellContext.selectedFiles.length,100);
    assert.equal(full.reviewedFiles.length,1000);

    const catalog=state.snapshot({includeCollections:false,threadMetaView:"catalog"}).threadMeta["thread-old"];
    assert.equal(catalog.__catalogOnly,true);assert.equal(catalog.runtime,"native");assert.equal(catalog.runtimeInstanceId,"native-default");assert.equal(catalog.branch,"feature/catalog");
    assert.equal(catalog.threadSnapshot.name,"Catalog thread");assert.equal(catalog.delegation.parentThreadId,"parent-1");
    assert.equal(catalog.linkedPullRequests[0].identity.number,17);
    for(const heavy of ["goal","continuityNotes","trebellQueue","trebellContext","reviewedFiles"])assert.equal(Object.prototype.hasOwnProperty.call(catalog,heavy),false,heavy+" should stay out of bootstrap catalog metadata");

    const migrated=new DatabaseSync(dbPath);
    try{
      const columns=migrated.prepare("PRAGMA table_info(state_thread_meta)").all().map(row=>String(row.name));
      assert.ok(columns.includes("catalog_json"));
      const row=migrated.prepare("SELECT catalog_json,payload_json FROM state_thread_meta WHERE thread_id=?").get("thread-old");
      assert.ok(String(row.catalog_json).length<String(row.payload_json).length/4,"catalog projection should be materially smaller than the full active-thread payload");
    }finally{migrated.close()}

    state.updateThreadMeta("thread-old",{branch:"feature/catalog-v2",goal:{objective:"Still full only"},trebellQueue:[{id:"queued-2",input:[{type:"text",text:"later"}]}]});
    const updatedCatalog=state.snapshot({includeCollections:false,threadMetaView:"catalog"}).threadMeta["thread-old"];
    assert.equal(updatedCatalog.branch,"feature/catalog-v2");assert.equal(Object.prototype.hasOwnProperty.call(updatedCatalog,"goal"),false);assert.equal(Object.prototype.hasOwnProperty.call(updatedCatalog,"trebellQueue"),false);
    assert.equal(state.threadMeta("thread-old").goal.objective,"Still full only");assert.equal(state.threadMeta("thread-old").trebellQueue[0].id,"queued-2");
  }finally{await rm(home,{recursive:true,force:true})}
});
