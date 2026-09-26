import test from "node:test";
import assert from "node:assert/strict";
import { loadThreadListPages,nativeThreadSearchMatches, threadListParams } from "../ui/src/thread-list-query.js";

test("thread listing is provider-independent",()=>{
  const params=threadListParams(100);
  assert.deepEqual(params,{limit:100,sortKey:"updated_at",sortDirection:"desc"});
  assert.equal(Object.prototype.hasOwnProperty.call(params,"modelProviders"),false);
});

test("thread listing drains bounded pages and deduplicates overlapping thread ids",async()=>{
  const calls=[];const client={request:async(method,params)=>{
    calls.push({method,params});
    if(!params.cursor)return {data:[{id:"t3"},{id:"t2"}],nextCursor:"older-1"};
    if(params.cursor==="older-1")return {data:[{id:"t2"},{id:"t1"}],nextCursor:null};
    throw new Error("unexpected cursor");
  }};
  const result=await loadThreadListPages(client,{limit:2});
  assert.deepEqual(result.data.map(thread=>thread.id),["t3","t2","t1"]);assert.equal(result.truncated,false);assert.equal(result.nextCursor,null);assert.equal(result.pages,2);
  assert.deepEqual(calls,[
    {method:"thread/list",params:{limit:2,sortKey:"updated_at",sortDirection:"desc"}},
    {method:"thread/list",params:{limit:2,sortKey:"updated_at",sortDirection:"desc",cursor:"older-1"}},
  ]);
});

test("thread listing stops on repeated cursors and hard page bounds",async()=>{
  const repeating={request:async()=>({data:[{id:"same"}],nextCursor:"loop"})};
  const looped=await loadThreadListPages(repeating,{limit:1,maxPages:10});
  assert.equal(looped.truncated,true);assert.equal(looped.nextCursor,"loop");assert.equal(looped.pages,2);
  let count=0;const endless={request:async()=>({data:[{id:"t"+(++count)}],nextCursor:"cursor-"+count})};
  const bounded=await loadThreadListPages(endless,{limit:1,maxPages:3});
  assert.equal(bounded.truncated,true);assert.equal(bounded.pages,3);assert.deepEqual(bounded.data.map(thread=>thread.id),["t1","t2","t3"]);
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
