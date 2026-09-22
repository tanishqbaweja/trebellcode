import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitInfo, createBranch, createWorktree, worktreeSubmoduleArgs } from "../src/git-service.mjs";

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
