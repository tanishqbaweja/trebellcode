import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACE_CHANGED_PAGE_SIZE,
  WORKSPACE_DIFF_CHUNK_CHARS,
  WORKSPACE_TREE_PAGE_SIZE,
  workspaceListWindow,
  workspaceTextWindow,
} from "../ui/src/workspace-view-window.js";

test("workspace list windows keep initial tree and change mounts bounded",()=>{
  const items=Array.from({length:500},(_,index)=>index);
  const tree=workspaceListWindow(items,{pageSize:WORKSPACE_TREE_PAGE_SIZE});
  assert.equal(tree.visible.length,120);assert.equal(tree.total,500);assert.equal(tree.nextCount,120);
  const changed=workspaceListWindow(items,{pageSize:WORKSPACE_CHANGED_PAGE_SIZE});
  assert.equal(changed.visible.length,80);assert.equal(changed.nextCount,80);
});

test("workspace list windows expand without losing the full count",()=>{
  const items=Array.from({length:205},(_,index)=>index);
  const window=workspaceListWindow(items,{limit:160,pageSize:80});
  assert.deepEqual({shown:window.shown,total:window.total,nextCount:window.nextCount,hasMore:window.hasMore},{shown:160,total:205,nextCount:45,hasMore:true});
});

test("workspace diff text is progressively bounded without discarding source data",()=>{
  const source="x".repeat(WORKSPACE_DIFF_CHUNK_CHARS*2+123);
  const first=workspaceTextWindow(source);
  assert.equal(first.text.length,WORKSPACE_DIFF_CHUNK_CHARS);assert.equal(first.total,source.length);assert.equal(first.hasMore,true);
  const expanded=workspaceTextWindow(source,{limit:WORKSPACE_DIFF_CHUNK_CHARS*3});
  assert.equal(expanded.text,source);assert.equal(expanded.hasMore,false);
});
