import test from "node:test";
import assert from "node:assert/strict";
import { executeDelegation } from "../src/delegation-executor.mjs";

test("delegation executor preserves lifecycle ordering and returns the child",async()=>{
  const calls=[];
  const result=await executeDelegation({
    parentThreadId:"parent-1",request:{task:"Implement parser",isolation:"worktree"},
    makeId:()=>"delegation-1",
    reserve:async()=>{calls.push("reserve");return()=>calls.push("release")},
    prepareWorkspace:async()=>{calls.push("workspace");return{cwd:"/repo-wt",isolation:"worktree",worktree:true}},
    startThread:async()=>{calls.push("thread");return{id:"child-1"}},
    configureChild:async()=>calls.push("configure"),
    startTurn:async()=>{calls.push("turn");return{id:"turn-1"}},
    onStarted:async()=>calls.push("started"),
  });
  assert.deepEqual(calls,["reserve","workspace","thread","configure","turn","started","release"]);
  assert.equal(result.delegationId,"delegation-1");assert.equal(result.thread.id,"child-1");assert.equal(result.turn.id,"turn-1");assert.equal(result.turnId,"turn-1");assert.equal(result.cwd,"/repo-wt");assert.equal(result.isolation,"worktree");assert.equal(result.permission,"supervised");
});

test("delegation executor cleans an isolated workspace when child creation fails",async()=>{
  const calls=[];
  await assert.rejects(executeDelegation({
    parentThreadId:"parent-1",request:{task:"Fail early"},
    reserve:async()=>()=>calls.push("release"),
    prepareWorkspace:async()=>({cwd:"/repo-wt",worktree:true}),
    startThread:async()=>{throw new Error("thread failed")},
    cleanupWorkspace:async()=>calls.push("cleanup"),
  }),/thread failed/);
  assert.deepEqual(calls,["cleanup","release"]);
});

test("delegation executor preserves a created child for inspection when turn start fails",async()=>{
  const calls=[];
  await assert.rejects(executeDelegation({
    parentThreadId:"parent-1",request:{task:"Fail turn"},
    reserve:async()=>()=>calls.push("release"),
    prepareWorkspace:async()=>({cwd:"/repo-wt",worktree:true}),
    startThread:async()=>({id:"child-1"}),
    configureChild:async()=>calls.push("configure"),
    startTurn:async()=>{throw new Error("turn failed")},
    cleanupWorkspace:async()=>calls.push("cleanup"),
    markFailed:async({childThread,error})=>calls.push("failed:"+childThread.id+":"+error.message),
  }),/turn failed/);
  assert.deepEqual(calls,["configure","failed:child-1:turn failed","release"]);
});
