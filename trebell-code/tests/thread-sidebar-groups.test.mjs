import test from "node:test";
import assert from "node:assert/strict";
import { groupSidebarThreads, THREAD_GROUP_NAMES } from "../ui/src/thread-sidebar-groups.js";

test("sidebar grouping classifies each thread exactly once in display order",()=>{
  const threads=[
    {id:"p",section:{name:"Pinned"}},
    {id:"g"},
    {id:"a"},
    {id:"s",section:{name:"Snoozed"}},
    {id:"d",section:{name:"Settled"}},
  ];
  const groups=groupSidebarThreads(threads,{g:{projectless:true}});
  assert.deepEqual(THREAD_GROUP_NAMES.map(name=>groups[name].map(item=>item.id)),[["p"],["g"],["a"],["s"],["d"]]);
  assert.equal(THREAD_GROUP_NAMES.reduce((sum,name)=>sum+groups[name].length,0),threads.length);
});

test("sidebar grouping preserves source order inside a section",()=>{
  const threads=Array.from({length:500},(_,index)=>({id:"thread-"+index}));
  const groups=groupSidebarThreads(threads,{});
  assert.equal(groups.Active.length,500);
  assert.equal(groups.Active[0].id,"thread-0");
  assert.equal(groups.Active.at(-1).id,"thread-499");
});
