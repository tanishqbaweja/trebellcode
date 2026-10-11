import test from "node:test";
import assert from "node:assert/strict";
import { loadThreadListPages,nativeThreadSearchMatches, rankThreadSections, threadListParams } from "../ui/src/thread-list-query.js";

test("each listed thread gets its place in its section: Codex's sections are read in their order, the relay's places are kept",async()=>{
  // Codex: the listing has no places; each section is listed by section_position (top first), and the threads outside a section
  // get none. A section that cannot be read is named, and its threads get none.
  const listing=[{id:"a"},{id:"p1",section:{id:"pin",name:"Pinned"}},{id:"r1",section:{id:"res",name:"Research"}},{id:"p2",section:{id:"pin",name:"Pinned"}},{id:"s1",section:{id:"snz",name:"Snoozed"}}];
  const calls=[];
  const client={request:async(method,params)=>{
    calls.push(params);
    if(params.sectionId==="pin")return {data:[{id:"p2",section:{id:"pin"}},{id:"unlisted",section:{id:"pin"}},{id:"p1",section:{id:"pin"}}],nextCursor:null};
    if(params.sectionId==="res")return {data:[{id:"r1",section:{id:"res"}}],nextCursor:null};
    throw new Error("section listing failed");
  }};
  const ranked=await rankThreadSections(client,listing);
  assert.deepEqual(ranked.threads.map(thread=>[thread.id,thread.sectionRank]),[["a",null],["p1",2],["r1",0],["p2",0],["s1",null]]);
  assert.deepEqual(ranked.failures.map(failure=>[failure.sectionId,failure.name,failure.error.message]),[["snz","Snoozed","section listing failed"]]);
  assert.deepEqual(calls.map(params=>params.sectionId).sort(),["pin","res","snz"]);
  assert.deepEqual(calls[0],{limit:100,sectionId:calls[0].sectionId,sortKey:"section_position",sortDirection:"asc"});
  // The relay: every listed thread has its place already, so nothing more is asked.
  const relay={request:async()=>{throw new Error("not asked")}};
  const relayed=await rankThreadSections(relay,[{id:"x",sectionRank:1},{id:"y",section:{id:"Pinned"},sectionRank:0}]);
  assert.deepEqual(relayed.threads.map(thread=>thread.sectionRank),[1,0]);assert.deepEqual(relayed.failures,[]);
});

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
