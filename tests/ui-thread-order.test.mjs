import test from "node:test";
import assert from "node:assert/strict";
import { orderedSectionWithMove, sectionFirstThread, sectionOrderWrites, threadMoveAvailability, threadMoveTarget, threadOrderGroup, threadPlacement, threadPlacementAnchor, threadsInListOrder } from "../ui/src/thread-order.js";

const pinned={name:"Pinned",id:"pinned"};
// Each thread's place in its section in list order, as the agent relay lists them (sectionRank).
function ranked(threads){
  const next=new Map();
  return threads.map(thread=>{const key=thread.section?.id??"";const rank=next.get(key)??0;next.set(key,rank+1);return {...thread,sectionRank:rank}});
}

test("a thread alone in its section can move neither up nor down",()=>{
  const moves=threadMoveAvailability(ranked([{id:"only"}]));
  assert.deepEqual(moves.get("only"),{up:false,down:false});
});

test("only a thread its runtime keeps a place for can move: Codex keeps none outside a section, nor for another harness's thread",()=>{
  // Codex: the unsectioned threads have no place, the pinned ones have their section's.
  const threads=[{id:"a",sectionRank:null},{id:"p1",section:pinned,sectionRank:1},{id:"b"},{id:"p2",section:pinned,sectionRank:0}];
  const moves=threadMoveAvailability(threads);
  assert.equal(moves.get("a"),undefined);assert.equal(moves.get("b"),undefined);
  assert.deepEqual(moves.get("p2"),{up:false,down:true});assert.deepEqual(moves.get("p1"),{up:true,down:false});
  assert.equal(threadMoveTarget(threads,threads[0],1),null);
  // The section shows in the runtime's order, so p1 moves up before p2.
  assert.deepEqual(threadMoveTarget(threads,threads[1],-1),{beforeThreadId:"p2"});
  assert.deepEqual(threadOrderGroup(threads,threads[1]).map(thread=>thread.id),["p2","p1"]);
});

test("a thread goes first in a section it joins, and an undo puts it back before the thread after it",()=>{
  const threads=ranked([{id:"a"},{id:"p1",section:pinned},{id:"b"},{id:"p2",section:pinned},{id:"c"}]);
  assert.equal(sectionFirstThread(threads,"pinned")?.id,"p1");
  assert.equal(sectionFirstThread(threads,"pinned",{},"p1")?.id,"p2");
  assert.equal(sectionFirstThread(threads,"Snoozed"),null);assert.equal(sectionFirstThread(threads,null),null);
  assert.equal(threadPlacementAnchor(threads,threads[0]),"b");assert.equal(threadPlacementAnchor(threads,threads[4]),null);
  assert.equal(threadPlacementAnchor(threads,threads[1]),"p2");
  // No place, no anchor: the thread goes back to its place by recent activity.
  assert.equal(threadPlacementAnchor([{id:"x"},{id:"y"}],{id:"x"}),null);
});

test("threads move within their own section: the first cannot move up and the last cannot move down",()=>{
  const threads=ranked([{id:"a"},{id:"p1",section:pinned},{id:"b"},{id:"p2",section:pinned},{id:"c"}]);
  const moves=threadMoveAvailability(threads);
  assert.deepEqual(moves.get("a"),{up:false,down:true});
  assert.deepEqual(moves.get("b"),{up:true,down:true});
  assert.deepEqual(moves.get("c"),{up:true,down:false});
  assert.deepEqual(moves.get("p1"),{up:false,down:true});
  assert.deepEqual(moves.get("p2"),{up:true,down:false});
  assert.deepEqual(threadOrderGroup(threads,threads[1]).map(thread=>thread.id),["p1","p2"]);
  assert.deepEqual(threadOrderGroup(threads,threads[0]).map(thread=>thread.id),["a","b","c"]);
});

test("General chats and project threads are separate groups, as the sidebar shows them",()=>{
  // Both have no section, so the harness lists them together; the sidebar puts a projectless chat under General.
  const meta={"general-chat":{projectless:true},"general-2":{projectless:true}};
  const lone=ranked([{id:"general-chat"},{id:"project-thread"}]);
  const loneMoves=threadMoveAvailability(lone,meta);
  assert.deepEqual(loneMoves.get("general-chat"),{up:false,down:false});
  assert.deepEqual(loneMoves.get("project-thread"),{up:false,down:false});
  assert.deepEqual(threadOrderGroup(lone,lone[1],meta).map(thread=>thread.id),["project-thread"]);
  // A General chat listed between two project threads is not a step for either of them.
  const mixed=ranked([{id:"a"},{id:"general-chat"},{id:"b"},{id:"general-2"}]);
  const moves=threadMoveAvailability(mixed,meta);
  assert.deepEqual(moves.get("a"),{up:false,down:true});
  assert.deepEqual(moves.get("b"),{up:true,down:false});
  assert.deepEqual(moves.get("general-chat"),{up:false,down:true});
  assert.deepEqual(moves.get("general-2"),{up:true,down:false});
  assert.deepEqual(threadOrderGroup(mixed,mixed[0],meta).map(thread=>thread.id),["a","b"]);
  assert.deepEqual(threadOrderGroup(mixed,mixed[3],meta).map(thread=>thread.id),["general-chat","general-2"]);
  // Pinned, Snoozed and Settled threads keep their own groups whether or not they have a project.
  const sectioned=ranked([{id:"general-chat",section:pinned},{id:"a",section:pinned},{id:"b"}]);
  assert.deepEqual(threadMoveAvailability(sectioned,meta).get("general-chat"),{up:false,down:true});
  assert.deepEqual(threadMoveAvailability(sectioned,meta).get("b"),{up:false,down:false});
});

test("a move steps past the neighbour the sidebar shows and lands right next to it in the full list",()=>{
  const threads=ranked([{id:"g0"},{id:"a1"},{id:"b2"},{id:"a3"},{id:"b4"}]);
  // Unfiltered: down goes before the thread after the next one (null at the end), up goes before the previous one.
  assert.deepEqual(threadMoveTarget(threads,threads[1],1),{beforeThreadId:"a3"});
  assert.deepEqual(threadMoveTarget(threads,threads[3],1),{beforeThreadId:null});
  assert.deepEqual(threadMoveTarget(threads,threads[1],-1),{beforeThreadId:"g0"});
  assert.equal(threadMoveTarget(threads,threads[0],-1),null);
  assert.equal(threadMoveTarget(threads,threads[4],1),null);
  // A search shows g0, a1 and a3: a1 down steps past a3 and goes right after it, before the hidden b4 (which keeps its place);
  // a3 up steps past a1, not the hidden b2 next to it; the shown last and first cannot go further.
  const shown=[threads[0],threads[1],threads[3]];
  assert.deepEqual(threadMoveTarget(threads,threads[1],1,{},shown),{beforeThreadId:"b4"});
  assert.deepEqual(threadMoveTarget(threads,threads[3],-1,{},shown),{beforeThreadId:"a1"});
  assert.deepEqual(threadMoveTarget(threads,threads[0],1,{},shown),{beforeThreadId:"b2"});
  assert.equal(threadMoveTarget(threads,threads[3],1,{},shown),null);
  assert.equal(threadMoveTarget(threads,threads[2],1,{},shown),null);
  // The availability over what is shown agrees: a thread alone among the results can do nothing.
  assert.deepEqual(threadMoveAvailability([threads[2]]).get("b2"),{up:false,down:false});
  assert.deepEqual([...threadMoveAvailability(shown).entries()],[["g0",{up:false,down:true}],["a1",{up:true,down:true}],["a3",{up:true,down:false}]]);
  // Groups still apply: a General chat between project threads is no step for them.
  const meta={g0:{projectless:true}};
  assert.deepEqual(threadMoveTarget(threads,threads[1],-1,meta),null);
  assert.deepEqual(threadMoveTarget(threads,threads[1],1,meta,shown),{beforeThreadId:"b4"});
  assert.equal(threadMoveTarget(threads,{id:"elsewhere"},1),null);
  assert.equal(threadMoveTarget(threads,threads[1],0),null);
});

test("search results keep the list's order, with threads the list does not hold after them",()=>{
  const threads=[{id:"g0"},{id:"a1"},{id:"b2"},{id:"a3"}];
  // Title matches first, then message matches, as the search finds them.
  const found=[threads[1],threads[3],{id:"older"},threads[0]];
  assert.deepEqual(threadsInListOrder(found,threads).map(thread=>thread.id),["g0","a1","a3","older"]);
  assert.deepEqual(threadsInListOrder([{id:"x"},{id:"y"}],threads).map(thread=>thread.id),["x","y"]);
  assert.deepEqual(threadsInListOrder(null,threads),[]);
  assert.deepEqual(threadsInListOrder(found,null).map(thread=>thread.id),["a1","a3","older","g0"]);
  // A message match is shown as the list holds it (with its place in its section), not as the search returned it.
  const listed={id:"a1",sectionRank:3},match={id:"a1",name:"From the search"};
  assert.equal(threadsInListOrder([match],[listed])[0],listed);
  // Unless the list holds only what Trebell saved of it (a thread beyond the listed page): the search's copy is the thread as it is now,
  // with the place its runtime gave it, and it keeps the stub's slot in the list's order.
  const stub={id:"old",name:null,__trebellCatalog:true},hit={id:"old",name:"Needle oldest thread",sectionRank:103,sectionPlaced:false};
  assert.deepEqual(threadsInListOrder([hit,{id:"a1"}],[listed,stub]),[listed,hit]);
});

test("an undo hands its runtime the thread after it only when it held a place a person gave it",()=>{
  // The relay says which threads a person moved (sectionPlaced); Codex's threads of an ordered section all hold theirs.
  const threads=[{id:"a",sectionRank:0,sectionPlaced:false},{id:"b",sectionRank:1,sectionPlaced:true},{id:"c",sectionRank:2,sectionPlaced:false},{id:"p",section:pinned,sectionRank:0,sectionPlaced:false}];
  assert.deepEqual(threadPlacement(threads,threads[0]),{beforeThreadId:"b",anchorThreadId:null,placed:false});
  assert.deepEqual(threadPlacement(threads,threads[1]),{beforeThreadId:"c",anchorThreadId:"c",placed:true});
  assert.deepEqual(threadPlacement([...threads.slice(0,2)],threads[1]),{beforeThreadId:null,anchorThreadId:null,placed:true});
  // Codex outside a section: no place, but the list still puts it back before the thread it showed above.
  const codex=[{id:"x",sectionRank:null,sectionPlaced:false},{id:"y",sectionRank:null,sectionPlaced:false}];
  assert.deepEqual(threadPlacement(codex,codex[0]),{beforeThreadId:"y",anchorThreadId:null,placed:false});
});

test("a Codex section's first ordering writes the order the sidebar shows, with the move, in as few moves to its end as it takes",()=>{
  // Codex keeps Pinned in the order threads entered it (alpha first); the sidebar shows it newest first, and a third thread is beyond
  // the sidebar's page. Beta moves up: beta, gamma, then alpha, then the unlisted one.
  const members=[{id:"alpha",updatedAt:100},{id:"beta",updatedAt:200},{id:"unlisted",updatedAt:50},{id:"gamma",updatedAt:300}];
  const desired=orderedSectionWithMove(["gamma","beta","alpha"],members,"beta","gamma");
  assert.deepEqual(desired,["beta","gamma","alpha","unlisted"]);
  const writes=sectionOrderWrites(members.map(item=>item.id),desired);
  // Beta then gamma already come in that order in Codex's, so only alpha and the unlisted thread move to the end.
  assert.deepEqual(writes,["alpha","unlisted"]);
  // Moving each write to the end of Codex's order gives the order wanted.
  const apply=(order,ids)=>ids.reduce((current,id)=>[...current.filter(item=>item!==id),id],order);
  assert.deepEqual(apply(members.map(item=>item.id),writes),desired);
  // To the end of the section (Move down past the last listed thread), and nothing to write when Codex already holds that order.
  assert.deepEqual(orderedSectionWithMove(["gamma","beta","alpha"],members,"gamma",null),["beta","alpha","unlisted","gamma"]);
  assert.deepEqual(sectionOrderWrites(["a","b","c"],["a","b","c"]),[]);assert.deepEqual(sectionOrderWrites(["a","b","c"],["c","b","a"]),["b","a"]);
  for(const [current,wanted] of [[["a","b","c","d"],["d","c","b","a"]],[["a","b","c","d"],["b","a","d","c"]],[["d","a","c","b"],["a","b","c","d"]]])assert.deepEqual(apply(current,sectionOrderWrites(current,wanted)),wanted);
  // A thread that left the section since, or a thread to go before that did, is not guessed at.
  assert.throws(()=>orderedSectionWithMove(["gamma"],members,"gone",null),/no longer in this section/);
  assert.throws(()=>orderedSectionWithMove(["gamma"],members,"beta","gone"),/thread to go before is no longer in this section/);
});

test("a thread that is not in the ordered list has no moves",()=>{
  assert.equal(threadMoveAvailability(ranked([{id:"a"}])).get("elsewhere"),undefined);
  assert.equal(threadMoveAvailability(null).size,0);
  assert.deepEqual(threadOrderGroup([{id:"a"}],{id:"elsewhere"}),[]);
  assert.deepEqual(threadOrderGroup([{id:"a"}],null),[]);
});
