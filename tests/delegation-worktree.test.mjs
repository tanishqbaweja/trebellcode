import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupDelegationWorktree, createDelegationWorktree } from "../src/delegation-worktree.mjs";
import { createWorktree, git } from "../src/git-service.mjs";

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

// A delegation's cleanup on this machine is a forced remove, run when the delegation ends with no one asked: git for Windows went into a
// junction in the worktree (node_modules linked to the main checkout's, as a setup may link it) and emptied the folder it points to.
// Everything here is in a folder the test makes under the OS temp folder, the junction's target too.
test("a delegation's cleanup on this machine removes its worktree and leaves the folder a junction in it points to",{timeout:300_000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-delegation-junction-")),repo=join(root,"repo"),tree=join(root,"repo-trebell-delegate-child"),shared=join(root,"node_modules");
  try{
    await mkdir(repo);await git(repo,["init"]);await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Test"]);
    await writeFile(join(repo,".gitignore"),"node_modules\n");await writeFile(join(repo,"README.md"),"seed\n");await git(repo,["add","."]);await git(repo,["commit","-m","seed"]);
    await mkdir(join(shared,"pkg"),{recursive:true});await writeFile(join(shared,"pkg","index.js"),"module.exports=1;\n");
    await createDelegationWorktree({sourceCwd:repo,branch:"trebell/delegate-child",path:tree,baseBranch:"HEAD",submodules:"none",createLocal:createWorktree});
    await symlink(shared,join(tree,"node_modules"),"junction");assert.ok(existsSync(join(tree,"node_modules","pkg","index.js")),"the worktree reads the linked node_modules");
    await cleanupDelegationWorktree({sourceCwd:repo,worktreePath:tree});
    assert.equal(existsSync(tree),false,"the delegation's worktree is gone");assert.equal(existsSync(join(repo,".git","worktrees","repo-trebell-delegate-child")),false,"its admin entry too");
    assert.deepEqual(readdirSync(shared),["pkg"]);assert.equal(readFileSync(join(shared,"pkg","index.js"),"utf8"),"module.exports=1;\n","the linked node_modules is as it was");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100})}
});
