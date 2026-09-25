import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventJournal } from "../src/event-journal.mjs";

test("event journal persists bounded lifecycle metadata while redacting secrets",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-events-"));
  try{
    const journal=new EventJournal({TREBELL_HOME:home,HOME:home},{maxRecords:100,maxBytes:256*1024});
    journal.record({runtime:"codex",threadId:"thread-1",turnId:"turn-1",category:"tool",name:"item/completed",data:{
      command:["node","test.mjs","--api-key","plain-secret-value"],authorization:"Bearer sk-super-secret-token",nested:{apiKey:"sk-another-secret",note:"safe"},
    }});
    journal.recordProtocol({runtime:"codex",method:"item/agentMessage/delta",params:{threadId:"thread-1",turnId:"turn-1",delta:"do not persist token stream"}});
    journal.recordProtocol({runtime:"codex",method:"turn/completed",params:{threadId:"thread-1",turn:{id:"turn-1",status:"completed",durationMs:42}}});
    await journal.flush();
    const items=journal.list({threadId:"thread-1"});
    assert.equal(items.length,2);
    assert.equal(journal.status().lastError,null);
    assert.equal(journal.status().records,2);
    assert.equal(items[0].name,"turn/completed");
    assert.equal(items[1].data.authorization,"[redacted]");
    assert.equal(items[1].data.nested.apiKey,"[redacted]");
    const disk=await readFile(join(home,"events.jsonl"),"utf8");
    assert.doesNotMatch(disk,/super-secret|another-secret|plain-secret-value|do not persist token stream/);
    assert.match(disk,/turn\/completed/);
    assert.equal(journal.status().backend,"sqlite");assert.ok(journal.status().databasePath?.endsWith("trebell.sqlite"));
    await journal.close();
  }finally{await rm(home,{recursive:true,force:true})}
});

test("event journal keeps its in-memory trace ring bounded",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-events-"));
  try{
    const journal=new EventJournal({TREBELL_HOME:home},{maxRecords:100,maxBytes:256*1024});
    for(let index=0;index<140;index++)journal.record({name:"event-"+index,at:index+1,data:{index}});
    await journal.flush();
    const items=journal.list({limit:500});
    assert.equal(items.length,100);
    assert.equal(items[0].name,"event-139");
    assert.equal(items.at(-1).name,"event-40");
    await journal.close();
  }finally{await rm(home,{recursive:true,force:true})}
});

test("event journal keeps compact tool completion and surfaced error evidence",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-events-evidence-"));
  try{
    const journal=new EventJournal({TREBELL_HOME:home},{maxRecords:100,maxBytes:256*1024});
    journal.recordProtocol({runtime:"claude",method:"item/completed",params:{threadId:"thread-2",turnId:"turn-2",checkpointId:"checkpoint-2",item:{id:"cmd-2",type:"commandExecution",status:"completed",command:["npm","test"],exitCode:0,durationMs:123,success:true}}});
    journal.recordProtocol({runtime:"claude",method:"error",params:{threadId:"thread-2",turnId:"turn-2",message:"Provider command failed visibly"}});
    await journal.flush();
    const items=journal.list({threadId:"thread-2"});
    assert.equal(items.length,2);
    assert.equal(items[0].name,"error");assert.equal(items[0].data.message,"Provider command failed visibly");
    assert.equal(items[1].name,"item/completed");assert.equal(items[1].data.item.exitCode,0);assert.equal(items[1].data.item.durationMs,123);assert.equal(items[1].data.item.success,true);assert.equal(items[1].data.checkpointId,"checkpoint-2");
    await journal.close();
  }finally{await rm(home,{recursive:true,force:true})}
});

test("event journal filters trace evidence by runtime, category, turn and time window",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-events-filter-"));
  try{
    const journal=new EventJournal({TREBELL_HOME:home},{maxRecords:100,maxBytes:256*1024});
    journal.record({id:"old-codex",at:1_000,runtime:"codex",threadId:"thread-a",turnId:"turn-a",category:"checkpoint",name:"checkpoint.created"});
    journal.record({id:"new-codex",at:2_000,runtime:"codex",threadId:"thread-a",turnId:"turn-b",category:"budget",name:"goal.budget_blocked"});
    journal.record({id:"new-claude",at:3_000,runtime:"claude",threadId:"thread-b",turnId:"turn-c",category:"policy",name:"permission.resolved"});
    assert.deepEqual(journal.list({runtime:"codex"}).map(item=>item.id),["new-codex","old-codex"]);
    assert.deepEqual(journal.list({category:"budget"}).map(item=>item.id),["new-codex"]);
    assert.deepEqual(journal.list({turnId:"turn-b"}).map(item=>item.id),["new-codex"]);
    assert.deepEqual(journal.list({after:1_500,before:3_000}).map(item=>item.id),["new-codex"]);
    assert.deepEqual(journal.list({threadId:"thread-a",runtime:"codex",category:"checkpoint",after:500,before:1_500}).map(item=>item.id),["old-codex"]);
    await journal.flush();
    await journal.close();
  }finally{await rm(home,{recursive:true,force:true})}
});

test("event journal migrates legacy JSONL into indexed SQLite once",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-events-migrate-"));
  try{
    await writeFile(join(home,"events.jsonl"),[
      JSON.stringify({id:"legacy-1",at:100,runtime:"codex",provider:null,environmentId:null,threadId:"thread-legacy",turnId:"turn-1",category:"runtime",name:"turn/started",status:null,data:{safe:true}}),
      JSON.stringify({id:"legacy-2",at:200,runtime:"codex",provider:null,environmentId:null,threadId:"thread-legacy",turnId:"turn-1",category:"runtime",name:"turn/completed",status:"completed",data:{safe:true}}),
      "",
    ].join("\n"));
    const first=new EventJournal({TREBELL_HOME:home},{maxRecords:100,maxBytes:256*1024});
    assert.equal(first.status().backend,"sqlite");assert.deepEqual(first.list({threadId:"thread-legacy"}).map(item=>item.id),["legacy-2","legacy-1"]);await first.close();
    const second=new EventJournal({TREBELL_HOME:home},{maxRecords:100,maxBytes:256*1024});
    assert.deepEqual(second.list({threadId:"thread-legacy"}).map(item=>item.id),["legacy-2","legacy-1"]);assert.equal(second.status().records,2);await second.close();
  }finally{await rm(home,{recursive:true,force:true})}
});

test("event journal retains the bounded JSONL fallback when SQLite is unavailable",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-events-fallback-"));
  try{
    const first=new EventJournal({TREBELL_HOME:home},{maxRecords:100,maxBytes:256*1024,preferSqlite:false});
    first.record({id:"fallback-1",at:100,threadId:"thread-fallback",category:"runtime",name:"turn/started",data:{safe:true}});
    await first.close();assert.equal(first.status().backend,"jsonl");
    const second=new EventJournal({TREBELL_HOME:home},{maxRecords:100,maxBytes:256*1024,preferSqlite:false});
    assert.deepEqual(second.list({threadId:"thread-fallback"}).map(item=>item.id),["fallback-1"]);assert.equal(second.status().databasePath,null);
    await second.close();
  }finally{await rm(home,{recursive:true,force:true})}
});

test("event journal reconciles newer JSONL fallback events into an existing SQLite database",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-events-reconcile-"));
  try{
    const sqliteFirst=new EventJournal({TREBELL_HOME:home},{maxRecords:100,maxBytes:256*1024});
    sqliteFirst.record({id:"sqlite-first",at:100,threadId:"thread-reconcile",category:"runtime",name:"turn/started"});await sqliteFirst.close();
    const fallback=new EventJournal({TREBELL_HOME:home},{maxRecords:100,maxBytes:256*1024,preferSqlite:false});
    fallback.record({id:"fallback-newer",at:200,threadId:"thread-reconcile",category:"runtime",name:"turn/completed"});await fallback.close();
    const reconciled=new EventJournal({TREBELL_HOME:home},{maxRecords:100,maxBytes:256*1024});
    assert.deepEqual(reconciled.list({threadId:"thread-reconcile"}).map(item=>item.id),["fallback-newer","sqlite-first"]);
    assert.equal(reconciled.status().records,2);await reconciled.close();
  }finally{await rm(home,{recursive:true,force:true})}
});
