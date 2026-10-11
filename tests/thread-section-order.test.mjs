import test from "node:test";
import assert from "node:assert/strict";
import { compareSectionOrder, sectionMovePlacement, sectionPlaced, sectionRanks, withSectionPlace } from "../src/thread-section-order.mjs";

const pinned={id:"Pinned",name:"Pinned"};
// Apply a placement the way the relay stores it, and read a section back top first.
function apply(threads,placement,sectionId){
  return threads.map(thread=>{const order=placement.get(thread.id);if(!order)return thread;return {...thread,...order,...(thread.id===[...placement.keys()][0]?{section:sectionId?{id:sectionId,name:sectionId}:null}:{})}});
}
const order=(threads,sectionId=null)=>threads.filter(thread=>(thread.section?.id??null)===sectionId&&!thread.archived).sort(compareSectionOrder).map(thread=>thread.id);
const move=(threads,threadId,beforeThreadId,sectionId=null)=>apply(threads,sectionMovePlacement(threads,{threadId,sectionId,beforeThreadId}),sectionId);

test("a section nobody reordered lists its threads newest first, and a new thread comes first",()=>{
  const threads=[{id:"b",updatedAt:20},{id:"a",updatedAt:30},{id:"c",updatedAt:10},{id:"old",updatedAt:40,archived:true}];
  assert.deepEqual(order(threads),["a","b","c"]);
  assert.deepEqual(order([...threads,{id:"new",updatedAt:50}]),["new","a","b","c"]);
  assert.deepEqual([...sectionRanks(threads)],[["a",0],["b",1],["c",2]]);
});

test("a move puts a thread right before the one named, or at the end, and the others keep their order",()=>{
  let threads=[{id:"a",updatedAt:40},{id:"b",updatedAt:30},{id:"c",updatedAt:20},{id:"d",updatedAt:10}];
  threads=move(threads,"a","c");assert.deepEqual(order(threads),["b","a","c","d"]);
  threads=move(threads,"d","c");assert.deepEqual(order(threads),["b","a","d","c"]);
  threads=move(threads,"c","b");assert.deepEqual(order(threads),["c","b","a","d"]);
  threads=move(threads,"c",null);assert.deepEqual(order(threads),["b","a","d","c"]);
  // Only the moved thread changed: no last-update time, and nothing else got a place.
  assert.deepEqual(threads.map(thread=>[thread.id,thread.updatedAt]),[["a",40],["b",30],["c",20],["d",10]]);
  assert.equal(threads.find(thread=>thread.id==="b").sectionPosition,undefined);
  // A thread updated later than every place goes first, as a new one does; a moved thread keeps its place through its own activity.
  threads=[...threads,{id:"e",updatedAt:5}];assert.deepEqual(order(threads),["b","a","d","c","e"]);
  threads=threads.map(thread=>thread.id==="e"?{...thread,updatedAt:99}:thread);assert.deepEqual(order(threads),["e","b","a","d","c"]);
  threads=threads.map(thread=>thread.id==="a"?{...thread,updatedAt:100}:thread);assert.deepEqual(order(threads),["e","b","a","d","c"]);
});

test("threads with the same last-update second are told apart, so a move between them lands exactly there",()=>{
  let threads=["a","b","c","d"].map(id=>({id,updatedAt:50}));
  const before=order(threads);
  threads=move(threads,before[3],before[1]);assert.deepEqual(order(threads),[before[0],before[3],before[1],before[2]]);
  threads=move(threads,before[0],before[2]);assert.deepEqual(order(threads),[before[3],before[1],before[0],before[2]]);
  // Repeated halving between the same two neighbours still has room.
  threads=[{id:"x",updatedAt:2},{id:"y",updatedAt:1},{id:"z",updatedAt:0}];
  for(let step=0;step<80;step++){threads=move(threads,step%2?"z":"x","y");threads=move(threads,step%2?"x":"z",null)}
  assert.equal(new Set(order(threads)).size,3);
  threads=move(threads,"z","y");const now=order(threads);assert.equal(now.indexOf("z"),now.indexOf("y")-1);
});

test("a thread entering or leaving a section takes its place there by recent activity; a move within it or before a thread fixes one",()=>{
  let threads=[{id:"a",updatedAt:40},{id:"b",updatedAt:30},{id:"p",updatedAt:10,section:pinned},{id:"q",updatedAt:20,section:pinned}];
  assert.deepEqual(order(threads,"Pinned"),["q","p"]);
  // Pin: b joins Pinned where its last update puts it, with no place of its own.
  threads=move(threads,"b",null,"Pinned");assert.deepEqual(order(threads,"Pinned"),["b","q","p"]);assert.equal(threads.find(thread=>thread.id==="b").sectionPosition,null);
  // Move down past the last thread of its section: the end, where it stays through its own activity.
  threads=move(threads,"b",null,"Pinned");assert.deepEqual(order(threads,"Pinned"),["q","p","b"]);
  threads=threads.map(thread=>thread.id==="b"?{...thread,updatedAt:99}:thread);assert.deepEqual(order(threads,"Pinned"),["q","p","b"]);
  // Before a thread in the section, also from outside it: a place there.
  threads=move(threads,"a","q","Pinned");assert.deepEqual(order(threads,"Pinned"),["a","q","p","b"]);assert.deepEqual(order(threads),[]);
  threads=move(threads,"a",null,null);assert.deepEqual(order(threads),["a"]);assert.equal(threads.find(thread=>thread.id==="a").sectionPosition,null);
  // The thread to go before must be in the destination section, as Codex requires.
  assert.throws(()=>sectionMovePlacement(threads,{threadId:"p",sectionId:"Pinned",beforeThreadId:"a"}),/not in section Pinned/);
  assert.throws(()=>sectionMovePlacement(threads,{threadId:"a",sectionId:null,beforeThreadId:"q"}),/not in the threads outside a section/);
  assert.throws(()=>sectionMovePlacement(threads,{threadId:"missing",sectionId:null}),/Thread not found/);
});

test("pinning a thread nobody moved and undoing it leaves it no place, so new activity still lifts it as it lifts the others",()=>{
  let threads=[{id:"one",updatedAt:40},{id:"two",updatedAt:30},{id:"three",updatedAt:20},{id:"four",updatedAt:10}];
  // Pin, then its undo (back to the threads outside a section with no thread to go before: it held no place).
  threads=move(threads,"two",null,"Pinned");threads=move(threads,"two",null,null);
  assert.deepEqual(order(threads),["one","two","three","four"]);assert.equal(sectionPlaced(threads.find(thread=>thread.id==="two")),false);
  threads=threads.map(thread=>thread.id==="four"?{...thread,updatedAt:50}:thread);assert.deepEqual(order(threads),["four","one","two","three"]);
  threads=threads.map(thread=>thread.id==="two"?{...thread,updatedAt:60}:thread);assert.deepEqual(order(threads),["two","four","one","three"]);
  // A thread someone moved keeps the place an undo gives back (before the thread that followed it), and says so.
  threads=move(threads,"one","three");assert.deepEqual(order(threads),["two","four","one","three"]);assert.equal(sectionPlaced(threads.find(thread=>thread.id==="one")),true);
  threads=move(threads,"one",null,"Pinned");threads=move(threads,"one","three",null);
  assert.deepEqual(order(threads),["two","four","one","three"]);assert.equal(sectionPlaced(threads.find(thread=>thread.id==="one")),true);
  assert.deepEqual(withSectionPlace({id:"one",sectionPosition:5},new Map([["one",2]])),{id:"one",sectionPosition:5,sectionRank:2,sectionPlaced:true});
  assert.deepEqual(withSectionPlace({id:"x"},new Map()),{id:"x",sectionRank:null,sectionPlaced:false});
});
