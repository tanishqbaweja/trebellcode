import test from "node:test";
import assert from "node:assert/strict";
import { createLatestValueBuffer } from "../ui/src/latest-value-buffer.js";

test("latest value buffer coalesces rapid updates by key",()=>{
  const scheduled=[];const flushed=[];
  const buffer=createLatestValueBuffer({schedule:callback=>{scheduled.push(callback);return scheduled.length},cancel:()=>{},onFlush:entries=>flushed.push(entries)});
  for(let index=1;index<=64;index++)buffer.push("diff",{value:index});
  buffer.push("other",{value:"other"});
  assert.equal(scheduled.length,1);
  scheduled[0]();
  assert.equal(flushed.length,1);
  assert.deepEqual(flushed[0],[ ["diff",{value:64}], ["other",{value:"other"}] ]);
});

test("latest value buffer flush delivers what waits at once and leaves nothing for the scheduled flush",()=>{
  let callback=null,cancelled=0;const flushed=[];
  const buffer=createLatestValueBuffer({schedule:next=>{callback=next;return 3},cancel:handle=>{assert.equal(handle,3);cancelled++},onFlush:entries=>flushed.push(entries)});
  buffer.flush();assert.equal(flushed.length,0,"nothing waits, nothing goes out");
  buffer.push("diff",1);buffer.push("diff",2);buffer.flush();
  assert.equal(cancelled,1);assert.deepEqual(flushed,[[["diff",2]]]);
  callback?.();assert.equal(flushed.length,1);
  buffer.push("diff",3);assert.equal(typeof callback,"function");callback();
  assert.deepEqual(flushed.at(-1),[["diff",3]],"a push after a flush is scheduled again");
});

test("latest value buffer reset cancels pending work",()=>{
  let callback=null,cancelled=0,flushes=0;
  const buffer=createLatestValueBuffer({schedule:next=>{callback=next;return 7},cancel:handle=>{assert.equal(handle,7);cancelled++},onFlush:()=>flushes++});
  buffer.push("diff",1);buffer.reset();callback?.();
  assert.equal(cancelled,1);assert.equal(flushes,0);
});
