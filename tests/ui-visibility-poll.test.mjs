import test from "node:test";
import assert from "node:assert/strict";
import { startVisibilityPoll } from "../ui/src/visibility-poll.js";

function fakeDocument(){
  const listeners=new Map();
  return {
    hidden:false,
    addEventListener(type,listener){listeners.set(type,listener)},
    removeEventListener(type,listener){if(listeners.get(type)===listener)listeners.delete(type)},
    emit(type){listeners.get(type)?.()},
    has(type){return listeners.has(type)},
  };
}

test("visibility polling pauses while hidden and resumes when visible",async()=>{
  const documentRef=fakeDocument();
  let tick=null,cleared=null,calls=0;
  const poll=startVisibilityPoll(async()=>{calls++},{
    intervalMs:4000,
    documentRef,
    setIntervalFn(callback){tick=callback;return 42},
    clearIntervalFn(id){cleared=id},
  });
  await Promise.resolve();
  assert.equal(calls,1);
  documentRef.hidden=true;tick();await Promise.resolve();
  assert.equal(calls,1);
  documentRef.hidden=false;documentRef.emit("visibilitychange");await Promise.resolve();
  assert.equal(calls,2);
  poll.dispose();
  assert.equal(cleared,42);
  assert.equal(documentRef.has("visibilitychange"),false);
});

test("visibility polling does not overlap an in-flight task",async()=>{
  const documentRef=fakeDocument();
  let tick=null,calls=0,release;
  const first=new Promise(resolve=>{release=resolve});
  const poll=startVisibilityPoll(async()=>{calls++;if(calls===1)await first},{
    documentRef,
    setIntervalFn(callback){tick=callback;return 7},
    clearIntervalFn(){},
  });
  await Promise.resolve();
  assert.equal(calls,1);
  tick();tick();await Promise.resolve();
  assert.equal(calls,1);
  release();await first;await Promise.resolve();
  tick();await Promise.resolve();
  assert.equal(calls,2);
  poll.dispose();
});
