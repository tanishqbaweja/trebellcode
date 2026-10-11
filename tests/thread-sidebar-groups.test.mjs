import test from "node:test";
import assert from "node:assert/strict";
import { groupSidebarThreads, runningThreadIds, settleTurnStates, THREAD_GROUP_NAMES } from "../ui/src/thread-sidebar-groups.js";

test("a thread shows as running from the open window's state, the turn events seen, or its listed status",()=>{
  const threads=[{id:"open"},{id:"detached"},{id:"listed",status:{type:"active"}},{id:"finished",status:{type:"active"}},{id:"idle",status:{type:"idle"}}];
  const ids=runningThreadIds(threads,{activeThreadId:"open",activeRunning:true,turnStates:{detached:true,finished:false}});
  assert.deepEqual([...ids],["open","detached","listed"]);
  // The open thread follows its own state even when an older event said otherwise.
  assert.deepEqual([...runningThreadIds(threads,{activeThreadId:"detached",activeRunning:false,turnStates:{detached:true}})],["listed","finished"]);
  // A listing that reports a status replaces the events seen for that thread; others keep theirs.
  assert.deepEqual(settleTurnStates({finished:false,detached:true},[{id:"finished",status:{type:"idle"}},{id:"detached"}]),{detached:true});
  const unchanged={detached:true};assert.equal(settleTurnStates(unchanged,[{id:"other",status:{type:"idle"}}]),unchanged);
});

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
