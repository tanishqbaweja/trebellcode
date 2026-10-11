import test from "node:test";
import assert from "node:assert/strict";
import { captureHistoryPrependAnchor, captureThreadScrollPosition, historyAnchorDisturbed, historyAnchorOffset, historyAnchorShortfall, historyHoldAfterScroll, rememberThreadScrollPosition, restoreHistoryPrependAnchor, restoredThreadScrollTop } from "../ui/src/thread-scroll.js";

test("thread scroll capture distinguishes following-end from reading earlier content",()=>{
  assert.deepEqual(captureThreadScrollPosition({scrollTop:1450,scrollHeight:2000,clientHeight:500}),{top:1450,atEnd:false,distanceFromEnd:50});
  assert.deepEqual(captureThreadScrollPosition({scrollTop:1452,scrollHeight:2000,clientHeight:500}),{top:1452,atEnd:true,distanceFromEnd:48});
});

test("thread scroll restore follows the new end only when the remembered position was at end",()=>{
  const node={scrollHeight:3000,clientHeight:600};
  assert.equal(restoredThreadScrollTop({top:900,atEnd:false},node),900);
  assert.equal(restoredThreadScrollTop({top:900,atEnd:true},node),2400);
  assert.equal(restoredThreadScrollTop({top:9999,atEnd:false},node),2400);
  assert.equal(restoredThreadScrollTop(null,node),2400);
});

test("thread scroll position cache is LRU-bounded to 100 threads",()=>{
  const cache=new Map();
  for(let index=0;index<105;index++)rememberThreadScrollPosition(cache,"thread-"+index,{top:index,atEnd:false},100);
  assert.equal(cache.size,100);
  assert.equal(cache.has("thread-0"),false);
  assert.equal(cache.has("thread-4"),false);
  assert.equal(cache.has("thread-5"),true);
  rememberThreadScrollPosition(cache,"thread-5",{top:999,atEnd:true},100);
  assert.equal(cache.keys().next().value,"thread-6");
  assert.deepEqual(cache.get("thread-5"),{top:999,atEnd:true});
});

test("history prepend anchors preserve the first visible message",()=>{
  let targetTop=150;
  const hidden={dataset:{messageId:"hidden"},getBoundingClientRect:()=>({top:40,bottom:90})};
  const target={dataset:{messageId:"target"},getBoundingClientRect:()=>({top:targetTop,bottom:220})};
  const node={
    scrollTop:200,
    querySelectorAll:()=>[hidden,target],
    getBoundingClientRect:()=>({top:100,bottom:500}),
  };
  const anchor=captureHistoryPrependAnchor(node);
  assert.deepEqual(anchor,{messageId:"target",offset:50});
  targetTop=380;
  assert.equal(restoreHistoryPrependAnchor(node,anchor),true);
  assert.equal(node.scrollTop,430);
});

test("the history anchor yields to a scroll it did not make and keeps correcting layout drift",()=>{
  let rowTop=150;
  const row={dataset:{messageId:"anchor"},getBoundingClientRect:()=>({top:rowTop,bottom:rowTop+60})};
  const node={scrollTop:500,querySelectorAll:()=>[row],getBoundingClientRect:()=>({top:100,bottom:700})};
  const anchor={messageId:"anchor",offset:50};
  // Rows above grew: the anchor row drifted but nobody scrolled, so the anchor corrects it.
  rowTop=190;assert.equal(historyAnchorDisturbed(node,anchor,500),false);
  // The browser's scroll anchoring moved scrollTop and kept the row in place: still the anchor's job.
  node.scrollTop=540;rowTop=150;assert.equal(historyAnchorDisturbed(node,anchor,500),false);
  // The person scrolled to the end: the view and the row both moved.
  node.scrollTop=2400;rowTop=-1750;assert.equal(historyAnchorDisturbed(node,anchor,540),true);
  // The anchor row is gone and the view moved: its chunk unmounted because the view went far from it, so that was a scroll.
  assert.equal(historyAnchorDisturbed({...node,querySelectorAll:()=>[]},anchor,540),true);
  // Gone while the view stayed put tells nothing either way.
  assert.equal(historyAnchorDisturbed({...node,querySelectorAll:()=>[]},anchor,2400),false);
  assert.equal(historyAnchorDisturbed(null,anchor,540),true);
  assert.equal(historyAnchorOffset(node,anchor),-1850);
});

test("a restore that the end of the rows cuts short reports how far the anchor row still sits below its spot",()=>{
  let rowTop=207;
  const row={dataset:{messageId:"anchor"},getBoundingClientRect:()=>({top:rowTop,bottom:rowTop+60})};
  const node={scrollTop:213,querySelectorAll:()=>[row],getBoundingClientRect:()=>({top:0,bottom:616})};
  assert.equal(historyAnchorShortfall(node,{messageId:"anchor",offset:82}),125);
  rowTop=82;assert.equal(historyAnchorShortfall(node,{messageId:"anchor",offset:82}),0);
  // Above its spot is the restore's own job (it scrolls up), not a shortfall; a row not mounted reports none.
  rowTop=40;assert.equal(historyAnchorShortfall(node,{messageId:"anchor",offset:82}),0);
  assert.equal(historyAnchorShortfall({...node,querySelectorAll:()=>[]},{messageId:"anchor",offset:82}),0);
});

test("a history hold gives back what lies below the view as it scrolls up, and never grows",()=>{
  // A column held at 848px with the view at the end of its 954px scroll: all of it is needed.
  assert.equal(historyHoldAfterScroll({scrollTop:338,scrollHeight:954,clientHeight:616},848),848);
  // Scrolled up by 100: the 100px now below the view's bottom edge are given back.
  assert.equal(historyHoldAfterScroll({scrollTop:238,scrollHeight:954,clientHeight:616},848),748);
  // Scrolled to the top: what is left is below the rows' own height, so it holds nothing (App then drops it).
  assert.equal(historyHoldAfterScroll({scrollTop:0,scrollHeight:954,clientHeight:616},848),510);
  assert.equal(historyHoldAfterScroll({scrollTop:0,scrollHeight:2000,clientHeight:616},848),0);
  assert.equal(historyHoldAfterScroll({scrollTop:338,scrollHeight:954,clientHeight:616},0),0);
  assert.equal(historyHoldAfterScroll(null,848),0);
});
