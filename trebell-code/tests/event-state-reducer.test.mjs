import test from "node:test";
import assert from "node:assert/strict";
import { reduceEventJournal, reduceThreadEvents } from "../src/event-state-reducer.mjs";

test("thread event reducer reconstructs lifecycle, verification, checkpoints, policy and delegation",()=>{
  const events=[
    {id:"1",at:100,runtime:"codex",provider:"freebuff",threadId:"thread-1",turnId:"turn-1",category:"client",name:"turn/started"},
    {id:"2",at:120,threadId:"thread-1",turnId:"turn-1",category:"checkpoint",name:"checkpoint.created",status:"completed",data:{checkpointId:"cp-1",root:"/repo",label:"before edit"}},
    {id:"3",at:140,threadId:"thread-1",turnId:"turn-1",category:"policy",name:"policy.decision",status:"confirm",data:{decision:"CONFIRM",reason:"External side effect"}},
    {id:"4",at:160,threadId:"thread-1",turnId:"turn-1",category:"runtime",name:"turn/completed",status:"completed",data:{turn:{id:"turn-1",status:"completed",durationMs:60}}},
    {id:"5",at:180,threadId:"thread-1",turnId:"turn-1",category:"verification",name:"verification.completed",status:"failed",data:{recordId:"v-1",risk:"medium",verified:false,nextAction:"repair",summary:{failed:1}}},
    {id:"6",at:200,threadId:"thread-1",turnId:"repair-1",category:"verification",name:"verification.repair_started",status:"running",data:{recordId:"v-1"}},
    {id:"7",at:220,threadId:"thread-1",category:"delegation",name:"delegation.started",status:"running",data:{childThreadId:"child-1"}},
  ];
  const state=reduceThreadEvents(events,{threadId:"thread-1"});
  assert.equal(state.runtime,"codex");assert.equal(state.provider,"freebuff");assert.equal(state.status,"active");assert.equal(state.activeTurnId,"repair-1");
  assert.equal(state.turns.started,1);assert.equal(state.turns.completed,1);assert.equal(state.checkpoint.id,"cp-1");
  assert.equal(state.verification.recordId,"v-1");assert.equal(state.verification.nextAction,"repair");assert.equal(state.verification.repairTurnId,"repair-1");
  assert.equal(state.policy.lastDecision,"CONFIRM");assert.equal(state.policy.confirmedCount,1);assert.equal(state.delegation.lastChildThreadId,"child-1");
  assert.ok(state.recentFailures.some(item=>item.kind==="verification"));
});

test("thread event reducer reconstructs budget blocks and bounded unique failures",()=>{
  const events=[
    {at:1,threadId:"thread-2",turnId:"turn-a",name:"turn/started"},
    {at:2,threadId:"thread-2",turnId:"turn-a",name:"error",status:"error",data:{message:"Provider disconnected"}},
    {at:3,threadId:"thread-2",turnId:"turn-a",name:"error",status:"error",data:{message:"Provider disconnected"}},
    {at:4,threadId:"thread-2",name:"goal.budget_blocked",status:"blocked",data:{reason:"Tool budget exhausted"}},
    {at:5,threadId:"thread-2",name:"policy.decision",status:"reject",data:{decision:"REJECT",reason:"Outside workspace"}},
  ];
  const state=reduceThreadEvents(events);
  assert.equal(state.status,"failed");assert.equal(state.budget.blocked,true);assert.equal(state.budget.reason,"Tool budget exhausted");
  assert.equal(state.policy.blockedCount,1);assert.equal(state.recentFailures.filter(item=>item.message==="Provider disconnected").length,1);
});

test("event journal reducer materializes independent thread states",()=>{
  const materialized=reduceEventJournal([
    {at:1,threadId:"a",turnId:"a1",name:"turn/started"},
    {at:2,threadId:"b",turnId:"b1",name:"turn/started"},
    {at:3,threadId:"a",turnId:"a1",name:"turn/completed",status:"completed",data:{turn:{id:"a1",status:"completed"}}},
  ]);
  assert.equal(materialized.a.status,"idle");assert.equal(materialized.b.status,"active");assert.equal(materialized.b.activeTurnId,"b1");
});
