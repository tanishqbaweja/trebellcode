import test from "node:test";
import assert from "node:assert/strict";
import { heldElsewhere, hydratePersistedQueue, persistedQueueItems } from "../ui/src/persistent-queue.js";

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
