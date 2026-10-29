import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { heldElsewhere, hydratePersistedQueue, persistedQueueItems } from "../ui/src/persistent-queue.js";
import { compactBeforeTurn } from "../ui/src/turn-support.js";

test("persistent local queue keeps context source paths and drops native entries",()=>{
  const saved=persistedQueueItems([
    {id:"local-1",text:"fix auth",attachments:["/tmp/auth.js"],contextChips:[{path:"/tmp/auth.js",sourcePath:"/repo/src/auth.js"}],model:"m1"},
    {id:"native-1",text:"native",native:true},
  ]);
  assert.equal(saved.length,1);
  assert.equal(saved[0].contextChips[0].sourcePath,"/repo/src/auth.js");
});

test("queue entries left dispatching across a restart require an explicit retry",()=>{
  const [restored]=hydratePersistedQueue([{id:"q1",text:"do work",dispatchingAt:123,attachments:[],contextChips:[]}]);
  assert.equal(restored.dispatchingAt,null);
  assert.equal(restored.autoStartFailed,true);
  assert.equal(restored.recoveredUncertainDispatch,true);
});

test("a queue entry still on its way in this window keeps its dispatch mark when its thread opens again",()=>{
  const [onItsWay,left]=hydratePersistedQueue([{id:"q1",text:"going",dispatchingAt:123},{id:"q2",text:"left by a reload",dispatchingAt:456}],new Set(["q1"]));
  assert.equal(onItsWay.dispatchingAt,123);assert.equal(onItsWay.autoStartFailed,false);assert.equal(onItsWay.recoveredUncertainDispatch,undefined);
  assert.equal(left.dispatchingAt,null);assert.equal(left.autoStartFailed,true);assert.equal(left.recoveredUncertainDispatch,true);
});

test("a message another window holds for its automatic compaction keeps its mark until that window could hold it no longer, and the holding window reloaded marks it to retry at once",()=>{
  const held={id:"h1",text:"waits for the compaction",dispatchingAt:1000,heldBy:"window-a",heldUntil:5000};
  assert.deepEqual(persistedQueueItems([held]).map(item=>[item.heldBy,item.heldUntil]),[["window-a",5000]],"the hold is saved with the message");
  assert.equal(heldElsewhere(held,"window-b",4000),true);
  assert.equal(heldElsewhere(held,"window-a",4000),false,"the window that held it, reloaded");
  assert.equal(heldElsewhere(held,"window-b",5000),false,"once it could hold it no longer");
  const [elsewhere]=hydratePersistedQueue([held],new Set(),"window-b",4000);
  assert.deepEqual([elsewhere.dispatchingAt,elsewhere.autoStartFailed,elsewhere.recoveredUncertainDispatch],[1000,false,undefined]);
  for(const [windowKey,now] of [["window-a",4000],["window-b",6000]]){
    const [left]=hydratePersistedQueue([held],new Set(),windowKey,now);
    assert.deepEqual([left.dispatchingAt,left.autoStartFailed,left.recoveredUncertainDispatch,left.heldBy],[null,true,true,null],windowKey);
    assert.deepEqual(Object.keys(persistedQueueItems([left])[0]).filter(key=>key.startsWith("held")),[],"a message to retry is held by no window");
  }
});

// A copy of the queue read earlier (a thread opened from what the window loaded before) may say a hold has ended that its window has
// renewed since: read with no time, another window's hold counts however old its end, and only a fresh read of the thread's queue,
// with the time, ends it. The holding window reloaded still knows the message by its key, and marks it to retry at once.
test("a queue read with no time keeps another window's hold on a message however old its end, and the holding window reloaded still marks it to retry",()=>{
  const held={id:"h1",text:"waits for the compaction",dispatchingAt:1000,heldBy:"window-a",heldUntil:5000};
  assert.equal(heldElsewhere(held,"window-b"),true);
  const [elsewhere]=hydratePersistedQueue([held],new Set(),"window-b");
  assert.deepEqual([elsewhere.dispatchingAt,elsewhere.heldBy,elsewhere.autoStartFailed,elsewhere.recoveredUncertainDispatch],[1000,"window-a",false,undefined]);
  const [own]=hydratePersistedQueue([held],new Set(),"window-a");
  assert.deepEqual([own.dispatchingAt,own.autoStartFailed,own.heldBy],[null,true,null]);
});

// The window holding a message for its automatic compaction (turn-support.js compactBeforeTurn) renews its hold every 30 seconds, for
// two minutes from then, so a window closed or lost meanwhile holds it no longer two minutes after it last did. A renewal on its way
// when the compaction ends lands before the message leaves the queue, which it would put back otherwise, and none follows.
test("a window renews its hold on a message waiting for its automatic compaction while it waits, and the message leaves the queue only once the renewal on its way has landed",async()=>{
  mock.timers.enable({apis:["setInterval","Date"],now:1_000_000});
  try{
    let queue=[{id:"q0",text:"queued before",attachments:[],contextChips:[]}],gate=null,finish=null,land=null;const writes=[];
    const compaction=new Promise(resolve=>{finish=resolve}),flush=()=>new Promise(resolve=>setImmediate(resolve));
    const deps={activeThread:{id:"t1"},tokenUsage:null,threadTelemetryRef:{current:{t1:{tokenUsage:{modelContextWindow:100_000,last:{inputTokens:90_000}}}}},settings:{autoCompactContext:true,autoCompactThresholdPercent:85},
      requestThreadCompaction:()=>compaction,updateThreadTelemetry:()=>{},activeThreadRef:{current:{id:"t1"}},setTokenUsage:()=>{},localQueueStartRef:{current:new Set()},windowKey:"window-a",holdMs:120_000,
      persistLocalQueue:async(threadId,items)=>{writes.push(items.map(item=>({...item})));if(gate)await gate;queue=items;return items},queueNow:()=>queue};
    const waiting=compactBeforeTurn(deps,{id:"t1"},{text:"Go on",attachments:[],contextChips:[]}),held=()=>writes.at(-1).find(item=>item.text==="Go on");
    await flush();
    assert.equal(writes.length,1);assert.deepEqual([held().heldBy,held().heldUntil],["window-a",1_120_000],"held for two minutes");
    mock.timers.tick(30_000);await flush();
    assert.equal(writes.length,2,"renewed 30 seconds on");assert.equal(held().heldUntil,1_150_000);
    assert.deepEqual(writes[1].map(item=>item.id),writes[0].map(item=>item.id),"the queue as it was");
    gate=new Promise(resolve=>{land=resolve});
    mock.timers.tick(30_000);await flush();
    assert.equal(writes.length,3);
    finish();await flush();await flush();
    assert.equal(writes.length,3,"the message stays in the queue while the renewal is on its way");
    gate=null;land();
    assert.equal((await waiting).compacted,true);
    assert.equal(writes.length,4);assert.deepEqual(writes[3].map(item=>item.id),["q0"],"then leaves it");
    mock.timers.tick(120_000);await flush();
    assert.equal(writes.length,4,"and no renewal follows");
  }finally{mock.timers.reset()}
});
