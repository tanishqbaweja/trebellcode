import test from "node:test";
import assert from "node:assert/strict";
import { nativeThreadSearchMatches, threadListParams } from "../ui/src/thread-list-query.js";

test("thread listing is provider-independent",()=>{
  const params=threadListParams(100);
  assert.deepEqual(params,{limit:100,sortKey:"updated_at",sortDirection:"desc"});
  assert.equal(Object.prototype.hasOwnProperty.call(params,"modelProviders"),false);
});

test("native thread search keeps compact excerpts and matching thread identity",()=>{
  const response={data:[
    {thread:{id:"thread-1",name:"One"},snippet:"  first\n matching   message  "},
    {thread:{id:"thread-1",name:"Duplicate"},snippet:"duplicate"},
    {thread:{id:"thread-2",name:"Two"},snippet:"second match"},
    {thread:{name:"Missing id"},snippet:"ignored"},
  ]};
  assert.deepEqual(nativeThreadSearchMatches(response),[
    {threadId:"thread-1",excerpt:"first matching message",thread:{id:"thread-1",name:"One"}},
    {threadId:"thread-2",excerpt:"second match",thread:{id:"thread-2",name:"Two"}},
  ]);
});
