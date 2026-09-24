import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  }finally{await rm(home,{recursive:true,force:true})}
});
