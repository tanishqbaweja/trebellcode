import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_TEXT_THREAD_SOURCE, isListedThread, prependThread } from "../ui/src/thread-list-state.js";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");

test("a new thread goes first in the sidebar list",()=>{
  const older=[{id:"a",name:"A"},{id:"b",name:"B"}];
  assert.deepEqual(prependThread(older,{id:"c",name:"C"}).map(thread=>thread.id),["c","a","b"]);
  assert.deepEqual(older.map(thread=>thread.id),["a","b"],"the previous list is not mutated");
});

test("thread/started before the thread/start response lists the new thread once",()=>{
  // The agent relay broadcasts thread/started and then answers thread/start on the same socket: the UI applies both.
  const announced={id:"e7dc7957",model:"antigravity-default",status:{type:"idle"}};
  const answered={...announced,cwd:"H:/work"};
  let list=[{id:"grok-thread"}];
  list=prependThread(list,announced);
  list=prependThread(list,answered);
  assert.deepEqual(list.map(thread=>thread.id),["e7dc7957","grok-thread"]);
  assert.equal(list[0],answered,"the later copy replaces the earlier one");
  // And the other order (response first) is just as single.
  assert.deepEqual(prependThread(prependThread([],answered),announced).map(thread=>thread.id),["e7dc7957"]);
});

test("thread ids compare as strings and a missing thread leaves the list alone",()=>{
  const list=[{id:7},{id:"8"}];
  assert.deepEqual(prependThread(list,{id:"7"}).map(thread=>String(thread.id)),["7","8"]);
  assert.equal(prependThread(list,null),list);
  assert.equal(prependThread(list,{}),list);
  assert.deepEqual(prependThread(undefined,{id:"x"}),[{id:"x"}]);
});

test("one-shot Git text threads are never listed",()=>{
  assert.equal(isListedThread({id:"t1",ephemeral:false,threadSource:"trebell-code"}),true);
  assert.equal(isListedThread({id:"t2"}),true);
  assert.equal(isListedThread({id:"t3",ephemeral:true}),false,"ephemeral threads are never saved, so never listed");
  assert.equal(isListedThread({id:"t4",threadSource:GIT_TEXT_THREAD_SOURCE}),false);
  assert.equal(isListedThread({id:"t5",providerMeta:{threadSource:GIT_TEXT_THREAD_SOURCE}}),false);
  assert.equal(isListedThread(null),false);
  assert.equal(isListedThread({}),false);
});

test("App never prepends a thread without replacing an earlier copy of it",()=>{
  const app=readFileSync(join(root,"ui","src","App.jsx"),"utf8");
  // setThreads(prev=>[thread,...prev]) duplicated the thread that thread/started had already listed.
  const unguarded=[...app.matchAll(/setThreads\(\s*(\w+)\s*=>\s*\[\s*[\w.]+\s*,\s*\.\.\.\1\s*\]\s*\)/g)].map(match=>match[0]);
  assert.deepEqual(unguarded,[],"every prepend must drop an existing copy of the thread");
  assert.match(app,/method==="thread\/started"[\s\S]{0,240}isListedThread\(p\.thread\)\)setThreads\(prev=>prependThread\(prev,p\.thread\)\)/);
  assert.match(app,/createThreadFor\([^;]+\);activeThreadRef\.current=thread;setActiveThread\(thread\);setThreads\(prev=>prependThread\(prev,thread\)\)/);
});
