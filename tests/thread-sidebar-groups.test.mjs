import test from "node:test";
import assert from "node:assert/strict";
import { groupSidebarThreads, runningThreadIds, settleTurnStates, sidebarThreadGroups, THREAD_GROUP_NAMES } from "../ui/src/thread-sidebar-groups.js";

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

// Each Codex thread runs on an app-server of its own, and the listing comes from another one, which has not loaded it: "notLoaded"
// says nothing about the thread's turn, so the turn events seen stay.
test("a listing that has not loaded a thread leaves the turn events seen for it",()=>{
  const seen={background:true,ended:false};
  assert.equal(settleTurnStates(seen,[{id:"background",status:{type:"notLoaded"}},{id:"ended",status:{type:"notLoaded"}}]),seen);
  assert.deepEqual(settleTurnStates(seen,[{id:"background",status:{type:"notLoaded"}},{id:"ended",status:{type:"idle"}}]),{background:true});
  assert.deepEqual([...runningThreadIds([{id:"background",status:{type:"notLoaded"}}],{turnStates:seen})],["background"]);
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

test("a thread in any other section shows in a group named after it, never nowhere",()=>{
  // A Codex section made or renamed in another Codex client, two threads in it, a relay thread saved under a section id, and one
  // whose section has only a name: each lands in exactly one group, the other sections between Active and Snoozed.
  const threads=[
    {id:"p",section:{id:"0198-pinned",name:"Pinned"}},
    {id:"r1",section:{id:"0199-research",name:"Research"}},
    {id:"a"},
    {id:"r2",section:{id:"0199-research",name:"Research"}},
    {id:"later",section:{id:"0199-later",name:"Later"}},
    {id:"relay",section:{id:"0198-custom",name:"0198-custom"}},
    {id:"named",section:{name:"Ideas"}},
    {id:"s",section:{id:"Snoozed",name:"Snoozed"}},
    {id:"none",section:{id:null,name:""}},
  ];
  const groups=sidebarThreadGroups(threads,{});
  assert.deepEqual(groups.map(group=>[group.name,group.threads.map(thread=>thread.id)]),[
    ["Pinned",["p"]],["General",[]],["Active",["a","none"]],["Research",["r1","r2"]],["Later",["later"]],["0198-custom",["relay"]],["Ideas",["named"]],["Snoozed",["s"]],["Settled",[]],
  ]);
  assert.equal(groups.reduce((sum,group)=>sum+group.threads.length,0),threads.length);
  const keyed=groupSidebarThreads(threads,{});
  assert.deepEqual(Object.keys(keyed),["Pinned","General","Active","section:0199-research","section:0199-later","section:0198-custom","section:Ideas","Snoozed","Settled"]);
});

test("a group shows its threads in the order their runtime keeps, and a thread with no place keeps its own",()=>{
  const pinned={id:"Pinned",name:"Pinned"};
  // The list is newest first; the runtime's places say b, then c, then a. The other harness's thread x has no place and stays second.
  const threads=[{id:"a",sectionRank:2},{id:"x"},{id:"b",sectionRank:0},{id:"c",sectionRank:1},{id:"p2",section:pinned,sectionRank:1},{id:"p1",section:pinned,sectionRank:0}];
  const groups=groupSidebarThreads(threads,{});
  assert.deepEqual(groups.Active.map(thread=>thread.id),["b","x","c","a"]);
  assert.deepEqual(groups.Pinned.map(thread=>thread.id),["p1","p2"]);
  // Without places (Codex outside a section), the list's order stands.
  assert.deepEqual(groupSidebarThreads([{id:"n1"},{id:"n2"},{id:"n3",sectionRank:null}],{}).Active.map(thread=>thread.id),["n1","n2","n3"]);
});

test("sidebar grouping preserves source order inside a section",()=>{
  const threads=Array.from({length:500},(_,index)=>({id:"thread-"+index}));
  const groups=groupSidebarThreads(threads,{});
  assert.equal(groups.Active.length,500);
  assert.equal(groups.Active[0].id,"thread-0");
  assert.equal(groups.Active.at(-1).id,"thread-499");
});
