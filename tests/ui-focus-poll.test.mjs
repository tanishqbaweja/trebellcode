import test from "node:test";
import assert from "node:assert/strict";
import { startFocusPoll } from "../ui/src/focus-poll.js";

function fakeTarget(extra={}){
  const listeners=new Map();
  return {
    ...extra,
    addEventListener(type,listener){listeners.set(type,listener)},
    removeEventListener(type,listener){if(listeners.get(type)===listener)listeners.delete(type)},
    emit(type){listeners.get(type)?.()},
    has(type){return listeners.has(type)},
  };
}
// One pending timeout at a time, as the poll keeps; fire() runs it.
function fakeTimers(){
  const timers={pending:null,delays:[],cleared:0,
    setTimeoutFn(callback,delay){timers.pending=callback;timers.delays.push(delay);return timers.delays.length},
    clearTimeoutFn(id){if(id!=null)timers.cleared++},
    fire(){const callback=timers.pending;timers.pending=null;callback?.()},
  };
  return timers;
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test("the poll runs every 3.5 s while the window has focus and every 30 s while it does not",async()=>{
  let focused=true,calls=0;
  const documentRef=fakeTarget({hidden:false,hasFocus:()=>focused}),windowRef=fakeTarget(),timers=fakeTimers();
  const poll=startFocusPoll(async()=>{calls++},{documentRef,windowRef,...timers});
  await settle();
  assert.equal(calls,1);assert.deepEqual(timers.delays,[3500]);
  timers.fire();await settle();
  assert.equal(calls,2);assert.deepEqual(timers.delays,[3500,3500]);
  focused=false;timers.fire();await settle();
  assert.equal(calls,3);assert.deepEqual(timers.delays.slice(2),[30_000]);
  timers.fire();await settle();
  assert.equal(calls,4);assert.deepEqual(timers.delays.slice(3),[30_000]);
  poll.dispose();
  assert.equal(windowRef.has("focus"),false);assert.equal(documentRef.has("visibilitychange"),false);assert.equal(timers.pending===null||timers.cleared>0,true);
});

test("focus coming back polls at once and goes back to the focused pace",async()=>{
  let focused=false,calls=0;
  const documentRef=fakeTarget({hidden:false,hasFocus:()=>focused}),windowRef=fakeTarget(),timers=fakeTimers();
  const poll=startFocusPoll(async()=>{calls++},{documentRef,windowRef,...timers});
  await settle();
  assert.equal(calls,1);assert.deepEqual(timers.delays,[30_000]);
  focused=true;windowRef.emit("focus");await settle();
  assert.equal(calls,2);assert.deepEqual(timers.delays,[30_000,3500]);
  poll.dispose();
});

test("a hidden page is not polled, and showing it polls at once",async()=>{
  let calls=0;
  const documentRef=fakeTarget({hidden:true,hasFocus:()=>false}),windowRef=fakeTarget(),timers=fakeTimers();
  const poll=startFocusPoll(async()=>{calls++},{documentRef,windowRef,...timers});
  await settle();timers.fire();await settle();
  assert.equal(calls,0);
  documentRef.hidden=false;documentRef.emit("visibilitychange");await settle();
  assert.equal(calls,1);
  poll.dispose();
});

test("the poll does not overlap a task still running, and stops when disposed",async()=>{
  let calls=0,release;
  const first=new Promise(resolve=>{release=resolve});
  const documentRef=fakeTarget({hidden:false,hasFocus:()=>true}),windowRef=fakeTarget(),timers=fakeTimers();
  const poll=startFocusPoll(async()=>{calls++;if(calls===1)await first},{documentRef,windowRef,...timers});
  await settle();
  timers.fire();windowRef.emit("focus");await settle();
  assert.equal(calls,1);
  release();await settle();
  timers.fire();await settle();
  assert.equal(calls,2);
  poll.dispose();timers.fire();windowRef.emit("focus");await settle();
  assert.equal(calls,2);
});

test("a window that cannot say whether it has focus polls at the focused pace",async()=>{
  const documentRef=fakeTarget({hidden:false}),windowRef=fakeTarget(),timers=fakeTimers();
  const poll=startFocusPoll(async()=>{},{focusedMs:15_000,documentRef,windowRef,...timers});
  await settle();
  assert.deepEqual(timers.delays,[15_000]);
  poll.dispose();
});
