import test from "node:test";
import assert from "node:assert/strict";
import { SOURCE_CONTROL_PAGE_SIZE, sourceControlWindow } from "../ui/src/source-control-window.js";

test("source control windows keep small collections intact",()=>{
  const items=Array.from({length:8},(_,id)=>({id}));
  assert.deepEqual(sourceControlWindow(items),{
    visible:items,
    total:8,
    shown:8,
    hasMore:false,
    nextCount:0,
  });
});

test("source control windows bound large collections and expose the next increment",()=>{
  const items=Array.from({length:145},(_,id)=>({id}));
  const window=sourceControlWindow(items);
  assert.equal(window.visible.length,SOURCE_CONTROL_PAGE_SIZE);
  assert.equal(window.total,145);
  assert.equal(window.shown,SOURCE_CONTROL_PAGE_SIZE);
  assert.equal(window.hasMore,true);
  assert.equal(window.nextCount,SOURCE_CONTROL_PAGE_SIZE);

  const expanded=sourceControlWindow(items,{limit:120});
  assert.equal(expanded.visible.length,120);
  assert.equal(expanded.nextCount,25);
});

test("source control windows retain an active item outside the first page",()=>{
  const items=Array.from({length:100},(_,number)=>({number}));
  const window=sourceControlWindow(items,{activeKey:88,keyOf:item=>item.number});
  assert.equal(window.visible.length,SOURCE_CONTROL_PAGE_SIZE+1);
  assert.equal(window.visible.at(-1).number,88);
  assert.equal(window.shown,SOURCE_CONTROL_PAGE_SIZE);
});
