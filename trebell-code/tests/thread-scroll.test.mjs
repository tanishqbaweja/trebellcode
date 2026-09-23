import test from "node:test";
import assert from "node:assert/strict";
import { captureThreadScrollPosition, rememberThreadScrollPosition, restoredThreadScrollTop } from "../ui/src/thread-scroll.js";

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
