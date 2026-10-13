import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitInfo, commitAll, createBranch, createWorktree, removeWorktree, safeAutoPull, worktreeSubmoduleArgs } from "../src/git-service.mjs";

test("a commit git refuses fails with git's reason, and a commit with nothing to commit says so",{timeout:20000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-commit-"));
  try{
    await git(dir,["init"]);await git(dir,["config","user.email","trebell@example.test"]);await git(dir,["config","user.name","Trebell Test"]);
    // Nothing staged yet, not even a first commit.
    await assert.rejects(()=>commitAll(dir,"Empty start"),{message:"Nothing to commit: the working tree has no changes."});
    await writeFile(join(dir,"a.txt"),"hello\n");await commitAll(dir,"First");
    // A pre-commit hook that refuses: its own words are the reason, and no commit is made.
    await writeFile(join(dir,".git","hooks","pre-commit"),"#!/bin/sh\necho 'the hook refuses this commit' >&2\nexit 1\n");
    await writeFile(join(dir,"a.txt"),"changed\n");
    await assert.rejects(()=>commitAll(dir,"Refused"),{message:"the hook refuses this commit"});
    assert.equal((await git(dir,["log","--format=%s"])).stdout.trim(),"First");
    await rm(join(dir,".git","hooks","pre-commit"));
    const committed=await commitAll(dir,"Accepted");
    assert.equal(committed.status.length,0);assert.equal((await git(dir,["log","-1","--format=%s"])).stdout.trim(),"Accepted");
    await assert.rejects(()=>commitAll(dir,"Nothing here"),{message:"Nothing to commit: the working tree has no changes."});
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50})}
});

// The Git panel's Commit in a merge stopped on a conflict that the person resolved by keeping this branch's side: the index then
// matches HEAD, and the commit still concludes the merge, as git commit does.
test("a commit concludes a merge whose conflicts were resolved by keeping this branch's side",{timeout:20000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-merge-commit-"));
  try{
    await git(dir,["init","--initial-branch=main"]);await git(dir,["config","user.email","trebell@example.test"]);await git(dir,["config","user.name","Trebell Test"]);
    await writeFile(join(dir,"notes.txt"),"base\n");await commitAll(dir,"Base");
    await git(dir,["switch","-c","other"]);await writeFile(join(dir,"notes.txt"),"theirs\n");await commitAll(dir,"Theirs");
    await git(dir,["switch","main"]);await writeFile(join(dir,"notes.txt"),"ours\n");await commitAll(dir,"Ours");
    const merge=await git(dir,["merge","other"],{allowFailure:true});
    assert.equal(merge.ok,false,"the merge stopped on its conflict");
    assert.match((await git(dir,["status","--porcelain"])).stdout,/^UU notes\.txt/m);
    await writeFile(join(dir,"notes.txt"),"ours\n");
    const committed=await commitAll(dir,"Merge other, keeping ours");
    assert.equal(committed.status.length,0);
    assert.equal((await git(dir,["rev-list","--parents","-n","1","HEAD"])).stdout.trim().split(" ").length,3,"HEAD is a merge commit");
    assert.equal((await git(dir,["log","-1","--format=%s"])).stdout.trim(),"Merge other, keeping ours");
    assert.equal((await git(dir,["rev-parse","-q","--verify","MERGE_HEAD"],{allowFailure:true})).ok,false,"the merge is concluded");
    // With the merge concluded, nothing is left to commit, and Commit says so again.
    await assert.rejects(()=>commitAll(dir,"Nothing here"),{message:"Nothing to commit: the working tree has no changes."});
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50})}
});

test("Git service reports status and branch operations",{timeout:20000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-git-"));
  try{
    await git(dir,["init"]);
    await git(dir,["config","user.email","trebell@example.test"]);
    await git(dir,["config","user.name","Trebell Test"]);
    await writeFile(join(dir,"a.txt"),"hello");
    await git(dir,["add","a.txt"]);
    await git(dir,["commit","-m","init"]);
    let info=await gitInfo(dir);
    assert.equal(info.isGit,true);
    assert.equal(info.status.length,0);
    await createBranch(dir,"feature-test");
    info=await gitInfo(dir);
    assert.equal(info.branch,"feature-test");
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("worktree submodule policy maps to exact Git commands",()=>{
  assert.deepEqual(worktreeSubmoduleArgs("recursive"),["submodule","update","--init","--recursive"]);
  assert.deepEqual(worktreeSubmoduleArgs("top-level"),["submodule","update","--init"]);
  assert.equal(worktreeSubmoduleArgs("none"),null);
  assert.deepEqual(worktreeSubmoduleArgs("unexpected"),["submodule","update","--init","--recursive"]);
});

test("worktree creation records the selected submodule policy",{timeout:20000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-worktree-root-"));
  const worktree=root+"-child";
  try{
    await git(root,["init"]);await git(root,["config","user.email","trebell@example.test"]);await git(root,["config","user.name","Trebell Test"]);
    await writeFile(join(root,"file.txt"),"base");await git(root,["add","file.txt"]);await git(root,["commit","-m","base"]);
    const created=await createWorktree(root,{branch:"trebell-test-worktree",path:worktree,submodules:"none"});
    assert.equal(created.worktree,worktree);assert.equal(created.submodules,"none");assert.equal((await gitInfo(worktree)).branch,"trebell-test-worktree");
  }finally{await rm(worktree,{recursive:true,force:true}).catch(()=>{});await rm(root,{recursive:true,force:true})}
});

test("non-forced worktree removal preserves dirty delegated work for inspection",{timeout:20000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-dirty-worktree-root-")),worktree=root+"-child";
  try{
    await git(root,["init"]);await git(root,["config","user.email","trebell@example.test"]);await git(root,["config","user.name","Trebell Test"]);
    await writeFile(join(root,"file.txt"),"base\n");await git(root,["add","file.txt"]);await git(root,["commit","-m","base"]);
    await createWorktree(root,{branch:"trebell-dirty-worktree",path:worktree,submodules:"none"});
    await writeFile(join(worktree,"file.txt"),"setup changed this before failing\n");
    await assert.rejects(()=>removeWorktree(root,worktree),/modified|changes|force/i);
    assert.equal(await readFile(join(worktree,"file.txt"),"utf8"),"setup changed this before failing\n");
    await removeWorktree(root,worktree,{force:true});
  }finally{await rm(worktree,{recursive:true,force:true}).catch(()=>{});await rm(root,{recursive:true,force:true})}
});

test("safe auto-pull updates only a clean default branch with no local commits",{timeout:30000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-autopull-"));const origin=join(root,"origin.git"),seed=join(root,"seed"),checkout=join(root,"checkout");
  try{
    await mkdir(seed,{recursive:true});
    await git(root,["init","--bare","--initial-branch=main",origin]);
    await git(seed,["init","-b","main"]);await git(seed,["config","user.email","trebell@example.test"]);await git(seed,["config","user.name","Trebell Test"]);
    await writeFile(join(seed,"value.txt"),"one\n");await git(seed,["add","value.txt"]);await git(seed,["commit","-m","one"]);await git(seed,["remote","add","origin",origin]);await git(seed,["push","-u","origin","main"]);
    await git(root,["clone",origin,checkout]);await git(checkout,["config","user.email","trebell@example.test"]);await git(checkout,["config","user.name","Trebell Test"]);
    await writeFile(join(seed,"value.txt"),"two\n");await git(seed,["add","value.txt"]);await git(seed,["commit","-m","two"]);await git(seed,["push"]);
    const pulled=await safeAutoPull(checkout);assert.equal(pulled.ok,true);assert.equal(pulled.changed,true);assert.equal(pulled.defaultBranch,"main");assert.equal(await readFile(join(checkout,"value.txt"),"utf8"),"two\n");
    await git(checkout,["switch","-c","feature"]);await git(checkout,["branch","--set-upstream-to=origin/main","feature"]);
    const feature=await safeAutoPull(checkout);assert.equal(feature.ok,false);assert.equal(feature.reason,"not_default_branch");
    await git(checkout,["switch","main"]);await writeFile(join(checkout,"local.txt"),"local\n");await git(checkout,["add","local.txt"]);await git(checkout,["commit","-m","local"]);
    const ahead=await safeAutoPull(checkout);assert.equal(ahead.ok,false);assert.equal(ahead.reason,"local_commits");assert.equal(ahead.ahead,1);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50})}
});
