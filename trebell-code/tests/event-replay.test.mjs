import test from "node:test";
import assert from "node:assert/strict";
import { createReplayFixture, replayDiff, replayEventFixture } from "../src/event-replay.mjs";

test("replay fixtures sanitize secrets, report ordering problems, and upsert duplicate ids",()=>{
  const fixture=createReplayFixture([
    {id:"turn",at:200,threadId:"t1",name:"turn/completed",status:"completed",data:{authorization:"Bearer sk-secret-value",turn:{id:"x",status:"completed"}}},
    {id:"start",at:100,threadId:"t1",name:"turn/started",data:{}},
    {id:"turn",at:210,threadId:"t1",name:"turn/completed",status:"failed",data:{message:"Final failure",turn:{id:"x",status:"failed"}}},
    null,
  ],{environment:{}});
  assert.equal(fixture.diagnostics.outOfOrder,1);assert.deepEqual(fixture.diagnostics.duplicateIds,["turn"]);assert.deepEqual(fixture.diagnostics.invalidIndexes,[3]);
  assert.equal(fixture.events.length,2);assert.deepEqual(fixture.events.map(event=>event.at),[100,210]);
  assert.equal(fixture.events[1].data.authorization,undefined);assert.equal(fixture.events[1].data.message,"Final failure");
});

test("replay reconstructs task state at a historical timestamp without model inference",()=>{
  const fixture=createReplayFixture([
    {id:"1",at:100,threadId:"t1",runtime:"codex",category:"client",name:"turn/started",turnId:"turn-1"},
    {id:"2",at:150,threadId:"t1",category:"verification",name:"verification.completed",status:"failed",turnId:"turn-1",data:{recordId:"v1",verified:false,nextAction:"repair"}},
    {id:"3",at:200,threadId:"t1",category:"verification",name:"verification.repair_started",status:"running",turnId:"repair-1",data:{recordId:"v1"}},
  ]);
  const before=replayEventFixture(fixture,{untilAt:160}),after=replayEventFixture(fixture);
  assert.equal(before.threads.t1.status,"active");assert.equal(before.threads.t1.activeTurnId,"turn-1");assert.equal(before.threads.t1.verification.nextAction,"repair");
  assert.equal(after.threads.t1.activeTurnId,"repair-1");assert.equal(after.eventCount,3);assert.equal(after.categories.verification,2);
  const diff=replayDiff(before,after);assert.deepEqual(diff.changedThreadIds,["t1"]);assert.equal(diff.threads.t1.activeTurnId.after,"repair-1");
});

test("replay can scope one thread from a multi-thread fixture",()=>{
  const fixture=createReplayFixture([
    {id:"a",at:1,threadId:"a",name:"turn/started"},
    {id:"b",at:2,threadId:"b",name:"turn/started"},
  ]);
  const replay=replayEventFixture(fixture,{threadId:"b"});
  assert.equal(replay.threadCount,1);assert.ok(replay.threads.b);assert.equal(replay.threads.a,undefined);
});
