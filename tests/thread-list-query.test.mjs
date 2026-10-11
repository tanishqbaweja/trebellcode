import test from "node:test";
import assert from "node:assert/strict";
import { loadThreadListPages,nativeThreadSearchMatches, rankSearchHits, rankThreadSections, threadListParams } from "../ui/src/thread-list-query.js";

test("each listed thread gets its place in its section: a Codex section someone ordered in Codex's order, any other by recent activity",async()=>{
  // Codex: the listing (newest first) has no places. A section a person ordered (pin, snz) is read by section_position, top first, and
  // its threads hold their places; any other section (res) keeps the list's order and is not asked for, with no thread placed, as it
  // has always shown (Codex's order there is only the order threads entered it). The threads outside a section get no place. A section
  // that cannot be read is named, and its threads keep the list's order with no place and say why.
  const listing=[{id:"a"},{id:"p1",section:{id:"pin",name:"Pinned"}},{id:"r2",section:{id:"res",name:"Research"}},{id:"p2",section:{id:"pin",name:"Pinned"}},{id:"r1",section:{id:"res",name:"Research"}},{id:"s1",section:{id:"snz",name:"Snoozed"}}];
  const calls=[];
  const client={request:async(method,params)=>{
    calls.push(params);
    if(params.sectionId==="pin")return {data:[{id:"p2",section:{id:"pin"}},{id:"unlisted",section:{id:"pin"}},{id:"p1",section:{id:"pin"}}],nextCursor:null};
    if(params.sectionId==="res")return {data:[{id:"r1",section:{id:"res"}},{id:"r2",section:{id:"res"}}],nextCursor:null};
    throw new Error("section listing failed");
  }};
  const ranked=await rankThreadSections(client,listing,{orderedSections:["pin","snz"]});
  assert.deepEqual(ranked.threads.map(thread=>[thread.id,thread.sectionRank,thread.sectionPlaced]),[["a",null,false],["p1",2,true],["r2",0,false],["p2",0,true],["r1",1,false],["s1",null,false]]);
  assert.deepEqual(ranked.threads.map(thread=>thread.sectionOrderError),[null,null,null,null,null,"Could not read the order of Snoozed: section listing failed"]);
  assert.deepEqual(ranked.failures.map(failure=>[failure.sectionId,failure.name,failure.error.message]),[["snz","Snoozed","section listing failed"]]);
  assert.deepEqual(calls.map(params=>params.sectionId).sort(),["pin","snz"]);
  assert.deepEqual(calls[0],{limit:100,sectionId:calls[0].sectionId,sortKey:"section_position",sortDirection:"asc"});
  // Nobody has ordered a section yet: nothing is asked, and every section shows as the list gives it.
  const unordered=await rankThreadSections({request:async()=>{throw new Error("not asked")}},listing);
  assert.deepEqual(unordered.threads.map(thread=>thread.sectionRank),[null,0,0,1,1,0]);assert.ok(unordered.threads.every(thread=>thread.sectionPlaced===false));
  // The relay: every listed thread has its place already, so nothing more is asked.
  const relay={request:async()=>{throw new Error("not asked")}};
  const relayed=await rankThreadSections(relay,[{id:"x",sectionRank:1,sectionPlaced:false},{id:"y",section:{id:"Pinned"},sectionRank:0,sectionPlaced:true}],{orderedSections:["Pinned"]});
  assert.deepEqual(relayed.threads.map(thread=>[thread.sectionRank,thread.sectionPlaced]),[[1,false],[0,true]]);assert.deepEqual(relayed.failures,[]);
});

test("a Codex search's thread beyond the listed page gets the place its section gives it, so it moves as a listed thread does",async()=>{
  // The sidebar lists Pinned's two newest threads (shown by recent activity) and Research, which a person ordered (Codex's order: r1,
  // old-r, r2). The search found a listed thread (as the list has it), two older Pinned threads and one of Research beyond the page, and
  // an unsectioned one, which has no place.
  const pinned={id:"pin",name:"Pinned"},research={id:"res",name:"Research"};
  const listed=[{id:"p1",section:pinned,sectionRank:0,sectionPlaced:false},{id:"p2",section:pinned,sectionRank:1,sectionPlaced:false},{id:"r1",section:research,sectionRank:0,sectionPlaced:true},{id:"r2",section:research,sectionRank:2,sectionPlaced:true}];
  const shown=[listed[1],{id:"old-p2",section:pinned,updatedAt:20},{id:"old-p1",section:pinned,updatedAt:30},{id:"old-r",section:research,updatedAt:5},{id:"loose",updatedAt:40}];
  const calls=[];const client={request:async(method,params)=>{calls.push(params.sectionId);return {data:[{id:"r1",section:research},{id:"old-r",section:research},{id:"r2",section:research}],nextCursor:null}}};
  const ranked=await rankSearchHits(client,shown,listed,{orderedSections:["res"]});
  assert.deepEqual(ranked.map(thread=>[thread.id,thread.sectionRank??null,thread.sectionPlaced??null]),[["p2",1,false],["old-p2",3,false],["old-p1",2,false],["old-r",1,true],["loose",null,null]]);
  assert.equal(ranked[0],listed[1]);assert.deepEqual(calls,["res"]);
  // Everything has its place already (the agent relay's search, or no thread beyond the page): nothing is asked.
  const none={request:async()=>{throw new Error("not asked")}};
  assert.deepEqual(await rankSearchHits(none,listed,listed,{orderedSections:["res"]}),listed);
  // A section whose order cannot be read gives no place and says so.
  const failing={request:async()=>{throw new Error("section order unavailable")}};
  const failed=await rankSearchHits(failing,[{id:"old-r",section:research,updatedAt:5}],listed,{orderedSections:["res"]});
  assert.deepEqual([failed[0].sectionRank,failed[0].sectionOrderError],[null,"Could not read the order of Research: section order unavailable"]);
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
