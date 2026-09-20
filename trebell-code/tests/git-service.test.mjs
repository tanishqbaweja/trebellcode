import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitInfo, createBranch } from "../src/git-service.mjs";

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
