import test from "node:test";
import assert from "node:assert/strict";
import { SIDEBAR_CHUNK_SIZE, shouldVirtualizeSidebarGroup, sidebarChunkIndexForThread, sidebarVirtualChunks } from "../ui/src/sidebar-virtualization.js";

const threads=count=>Array.from({length:count},(_,index)=>({id:"thread-"+index}));

test("small sidebar groups stay unwindowed",()=>{
  assert.equal(shouldVirtualizeSidebarGroup(threads(40)),false);
  assert.equal(shouldVirtualizeSidebarGroup(threads(120)),true);
});

test("sidebar chunks are bounded and stable when newer threads are prepended",()=>{
  const current=threads(125),chunks=sidebarVirtualChunks(current);
  assert.equal(chunks.at(-1).items.length,SIDEBAR_CHUNK_SIZE);
  const newer=[...Array.from({length:7},(_,index)=>({id:"new-"+index})),...current],next=sidebarVirtualChunks(newer);
  assert.equal(next.at(-1).key,chunks.at(-1).key);
  assert.equal(next.at(-2).key,chunks.at(-2).key);
});

test("active threads resolve to the correct virtual sidebar chunk",()=>{
  const chunks=sidebarVirtualChunks(threads(1000));
  const index=sidebarChunkIndexForThread(chunks,"thread-517");
  assert.ok(index>=0);assert.ok(chunks[index].items.some(thread=>thread.id==="thread-517"));
  assert.equal(sidebarChunkIndexForThread(chunks,"missing"),-1);
});
