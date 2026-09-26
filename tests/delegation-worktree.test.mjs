import test from "node:test";
import assert from "node:assert/strict";
import { cleanupDelegationWorktree, createDelegationWorktree } from "../src/delegation-worktree.mjs";

test("remote delegation worktrees use remote Git and honor recursive submodule policy",async()=>{
  const gitCalls=[],execCalls=[];
  const created=await createDelegationWorktree({
    sourceCwd:"/srv/repo",environmentId:"ssh-1",branch:"trebell/delegate-child",path:"/srv/repo-child",baseBranch:"main",submodules:"recursive",
    createLocal:async()=>{throw new Error("local worktree path must not run")},
    runRemoteGit:async action=>{gitCalls.push(action);return {info:{root:"/srv/repo",branch:"main"},output:"created"}},
    executeRemoteArgv:async options=>{execCalls.push(options);return {exitCode:0,stdout:"",stderr:""}},
  });
  assert.equal(created.worktree,"/srv/repo-child");assert.equal(created.remote,true);
  assert.deepEqual(gitCalls,[{action:"worktree-create",name:"trebell/delegate-child",path:"/srv/repo-child",startPoint:"main"}]);
  assert.deepEqual(execCalls[0].args,["submodule","update","--init","--recursive"]);assert.equal(execCalls[0].cwd,"/srv/repo-child");
});

test("remote delegation worktree creation removes the worktree if setup fails",async()=>{
  const gitCalls=[];
  await assert.rejects(()=>createDelegationWorktree({
    sourceCwd:"/srv/repo",environmentId:"ssh-1",branch:"trebell/delegate-child",path:"/srv/repo-child",baseBranch:"main",submodules:"top-level",
    runRemoteGit:async action=>{gitCalls.push(action);return {info:{root:"/srv/repo"}}},
    executeRemoteArgv:async()=>({exitCode:1,stderr:"submodule failed"}),
  }),/submodule failed/i);
  assert.deepEqual(gitCalls,[
    {action:"worktree-create",name:"trebell/delegate-child",path:"/srv/repo-child",startPoint:"main"},
    {action:"worktree-remove",path:"/srv/repo-child",force:true},
  ]);
});

test("delegation worktree cleanup stays inside the selected remote environment",async()=>{
  const calls=[];
  await cleanupDelegationWorktree({sourceCwd:"/srv/repo",worktreePath:"/srv/repo-child",environmentId:"wsl-1",runRemoteGit:async action=>{calls.push(action);return {ok:true}}});
  assert.deepEqual(calls,[{action:"worktree-remove",path:"/srv/repo-child",force:true}]);
});
