import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";

const require=createRequire(import.meta.url);
const {DatabaseSync}=require("node:sqlite");

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
