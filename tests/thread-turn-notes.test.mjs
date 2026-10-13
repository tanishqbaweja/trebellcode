import test from "node:test";
import assert from "node:assert/strict";
import { createThreadTurnNotes } from "../ui/src/thread-turn-notes.js";

// The notes a window keeps of threads it may not show: a send that failed there, and the turns a Stop was sent for. They go with the
// thread or its session, and stay bounded, so a window open for days does not collect them.

test("a thread archived or deleted, in this window or another, takes its failed send and its sent Stops with it",()=>{
  const notes=createThreadTurnNotes();
  for(const id of ["archived-here","deleted-elsewhere","archived-elsewhere","kept"]){notes.failSend(id,{draft:{prompt:id}});notes.stopSent(id,"turn-"+id)}
  assert.deepEqual(notes.sizes(),{failedSends:4,sentStops:4});
  notes.threadEnded("archived-here");
  notes.notify({method:"thread/deleted",params:{threadId:"deleted-elsewhere"}});
  notes.notify({method:"thread/archived",params:{threadId:"archived-elsewhere"}});
  assert.deepEqual(notes.sizes(),{failedSends:1,sentStops:1});
  assert.equal(notes.takeFailedSend("archived-here"),null);assert.equal(notes.stopWasSent("deleted-elsewhere","turn-deleted-elsewhere"),false);
  assert.equal(notes.stopWasSent("kept","turn-kept"),true);assert.deepEqual(notes.takeFailedSend("kept"),{draft:{prompt:"kept"}});
  assert.deepEqual(notes.sizes(),{failedSends:0,sentStops:1});
});

test("a thread whose session ends (closed, released by the idle sweep, or read idle) ends the Stops of its turns and keeps its failed send",()=>{
  const notes=createThreadTurnNotes();
  for(const id of ["closed","swept","idle","reopened","running"]){notes.failSend(id,{draft:{prompt:id}});notes.stopSent(id,"turn-"+id)}
  notes.notify({method:"thread/closed",params:{threadId:"closed"}});
  notes.notify({method:"thread/closed",params:{threadId:"swept",reason:"idle"}});
  notes.notify({method:"thread/status/changed",params:{threadId:"idle",status:{type:"idle"}}});
  notes.turnsEnded("reopened");
  notes.notify({method:"thread/status/changed",params:{threadId:"running",status:{type:"active",activeFlags:[]}}});
  assert.deepEqual(notes.sizes(),{failedSends:5,sentStops:1});
  assert.equal(notes.stopWasSent("running","turn-running"),true);
  notes.notify({method:"turn/completed",params:{threadId:"running",turn:{id:"turn-running",status:"interrupted"}}});
  assert.deepEqual(notes.sizes(),{failedSends:5,sentStops:0});
});

// A thread opened running a turn (openThread) keeps the Stop of that turn alone; a listing's "notLoaded" says nothing of its turns.
test("a thread read running one turn keeps that turn's Stop and ends the others', and a notLoaded status ends none",()=>{
  const notes=createThreadTurnNotes();
  notes.stopSent("thread","turn-old");notes.stopSent("thread","turn-now");notes.stopSent("other","turn-other");
  notes.notify({method:"thread/status/changed",params:{threadId:"thread",status:{type:"notLoaded"}}});
  assert.deepEqual(notes.sizes(),{failedSends:0,sentStops:3});
  notes.turnsEnded("thread","turn-now");
  assert.equal(notes.stopWasSent("thread","turn-old"),false);assert.equal(notes.stopWasSent("thread","turn-now"),true);assert.equal(notes.stopWasSent("other","turn-other"),true);
  notes.turnsEnded("thread");assert.deepEqual(notes.sizes(),{failedSends:0,sentStops:1});
});

test("the notes keep to a bound, the oldest going first",()=>{
  const notes=createThreadTurnNotes(),failedSendLimit=20,sentStopLimit=100;
  for(let index=0;index<failedSendLimit+15;index++)notes.failSend("thread-"+index,{draft:{prompt:String(index)}});
  for(let index=0;index<sentStopLimit+30;index++)notes.stopSent("thread-"+(index%7),"turn-"+index);
  assert.deepEqual(notes.sizes(),{failedSends:failedSendLimit,sentStops:sentStopLimit});
  assert.equal(notes.takeFailedSend("thread-0"),null,"the oldest failed send went first");
  assert.deepEqual(notes.takeFailedSend("thread-"+(failedSendLimit+14)),{draft:{prompt:String(failedSendLimit+14)}});
  assert.equal(notes.stopWasSent("thread-0","turn-0"),false,"the oldest Stop went first");
  assert.equal(notes.stopWasSent("thread-"+((sentStopLimit+29)%7),"turn-"+(sentStopLimit+29)),true);
  // A send that fails again in the same thread replaces its note and counts as the newest.
  notes.failSend("thread-"+(failedSendLimit-5),{draft:{prompt:"again"}});notes.failSend("thread-new",{draft:{prompt:"new"}});
  assert.equal(notes.sizes().failedSends,failedSendLimit);assert.deepEqual(notes.takeFailedSend("thread-"+(failedSendLimit-5)),{draft:{prompt:"again"}});
});
