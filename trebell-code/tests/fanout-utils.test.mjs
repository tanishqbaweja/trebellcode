import test from "node:test";
import assert from "node:assert/strict";
import { fanoutWorkspaceError, nextModelSelection, normalizedPathKey, threadForWorktree } from "../ui/src/fanout-utils.js";

test("multi-model picker shift-click adds/removes while regular click returns to one model",()=>{
  assert.deepEqual(nextModelSelection(["a"],"b",{shiftKey:true,allowMulti:true}),["a","b"]);
  assert.deepEqual(nextModelSelection(["a","b"],"a",{shiftKey:true,allowMulti:true}),["b"]);
  assert.deepEqual(nextModelSelection(["b"],"b",{shiftKey:true,allowMulti:true}),["b"]);
  assert.deepEqual(nextModelSelection(["a","b"],"c",{shiftKey:false,allowMulti:true}),["c"]);
  assert.deepEqual(nextModelSelection(["a"],"b",{shiftKey:true,allowMulti:false}),["b"]);
});

test("fan-out recovery matches unique worktree paths across slash and case differences",()=>{
  const threads=[{id:"one",cwd:"H:\\Repo\\Worktree\\"},{id:"two",cwd:"/tmp/other"}];
  assert.equal(normalizedPathKey("H:\\Repo\\Worktree\\"),"h:/repo/worktree");
  assert.equal(threadForWorktree(threads,"h:/repo/worktree")?.id,"one");
  assert.equal(threadForWorktree(threads,"/missing"),null);
});

test("multi-model fan-out requires a Git branch",()=>{
  assert.match(fanoutWorkspaceError({isGit:false,branch:null}),/Git project/);
  assert.match(fanoutWorkspaceError({isGit:true,branch:null}),/base branch/);
  assert.equal(fanoutWorkspaceError({isGit:true,branch:"main"}),null);
});
