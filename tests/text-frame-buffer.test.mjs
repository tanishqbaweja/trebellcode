import test from "node:test";
import assert from "node:assert/strict";
import { createKeyedTextFrameBuffer, createTextFrameBuffer } from "../ui/src/text-frame-buffer.js";

test("text frame buffer coalesces bursty streaming deltas into one render flush",()=>{
  const scheduled=[];const flushed=[];
  const buffer=createTextFrameBuffer({schedule:callback=>{scheduled.push(callback);return scheduled.length},cancel:()=>{},onFlush:value=>flushed.push(value)});
  for(const part of ["h","e","l","l","o"])buffer.push(part);
  assert.equal(scheduled.length,1);
  assert.equal(buffer.pending(),"hello");
  scheduled[0]();
  assert.deepEqual(flushed,["hello"]);
  assert.equal(buffer.pending(),"");
});

test("text frame buffer reset prevents stale deltas from leaking into a completed turn",()=>{
  const scheduled=[];const flushed=[];const cancelled=[];
  const buffer=createTextFrameBuffer({schedule:callback=>{scheduled.push(callback);return 7},cancel:handle=>cancelled.push(handle),onFlush:value=>flushed.push(value)});
  buffer.push("old partial");
  buffer.reset();
  assert.deepEqual(cancelled,[7]);
  scheduled[0]();
  assert.deepEqual(flushed,[]);
  buffer.push("new turn");
  assert.equal(buffer.pending(),"new turn");
});

test("keyed text frame buffer coalesces command output independently in one render batch",()=>{
  const scheduled=[];const flushed=[];
  const buffer=createKeyedTextFrameBuffer({schedule:callback=>{scheduled.push(callback);return scheduled.length},cancel:()=>{},onFlush:entries=>flushed.push(entries)});
  buffer.push("command-a","hel");
  buffer.push("command-b","x");
  buffer.push("command-a","lo");
  assert.equal(scheduled.length,1);
  assert.equal(buffer.pending("command-a"),"hello");
  assert.equal(buffer.pending("command-b"),"x");
  scheduled[0]();
  assert.deepEqual(flushed,[[["command-a","hello"],["command-b","x"]]]);
  assert.equal(buffer.pending("command-a"),"");
});

test("keyed text frame buffer can settle one command without flushing another",()=>{
  const scheduled=[];const flushed=[];
  const buffer=createKeyedTextFrameBuffer({schedule:callback=>{scheduled.push(callback);return scheduled.length},cancel:()=>{},onFlush:entries=>flushed.push(entries)});
  buffer.push("command-a","alpha");
  buffer.push("command-b","beta");
  buffer.flushKey("command-a");
  assert.deepEqual(flushed,[[["command-a","alpha"]]]);
  assert.equal(buffer.pending("command-a"),"");
  assert.equal(buffer.pending("command-b"),"beta");
  scheduled[0]();
  assert.deepEqual(flushed,[[["command-a","alpha"]],[["command-b","beta"]]]);
});
