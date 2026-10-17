import test from "node:test";
import assert from "node:assert/strict";
import { hydratePersistedQueue, persistedQueueItems } from "../ui/src/persistent-queue.js";

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
