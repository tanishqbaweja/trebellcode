import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { createWorktree, git, gitInfo } from "../src/git-service.mjs";
import { inspectManagedWorktree, WorktreeCleanupService } from "../src/worktree-cleanup.mjs";

async function fixture(name){
  const home=await mkdtemp(join(tmpdir(),`trebell-cleanup-${name}-`));const root=join(home,"repo"),worktree=join(home,"worktree");
  await import("node:fs/promises").then(fs=>fs.mkdir(root,{recursive:true}));
  await git(root,["init"]);await git(root,["config","user.email","trebell@example.test"]);await git(root,["config","user.name","Trebell Test"]);
  await writeFile(join(root,"base.txt"),"base");await git(root,["add","base.txt"]);await git(root,["commit","-m","base"]);
  const info=await gitInfo(root);const baseBranch=info.branch;const branch=`trebell-${name}`;
  await createWorktree(root,{branch,path:worktree,baseBranch,submodules:"none"});
  const env={...process.env,TREBELL_HOME:join(home,"state")};const state=new TrebellStateStore(env);
  state.updateSettings({worktreeCleanup:{mode:"custom",rules:{worktreeAfterDays:null,worktreeOnMerge:false,worktreeOnDelete:false,worktreeUnchanged:true}}});
  const project=state.touchProject(worktree,{managedWorktree:{root,branch,baseBranch,submodules:"none",createdAt:Date.now()}});
  return {home,root,worktree,branch,baseBranch,state,project};
}

test("unchanged managed worktree cleans and restores on demand",{timeout:30000},async()=>{
  const f=await fixture("unchanged");
  try{
    const service=new WorktreeCleanupService({state:f.state});const cleaned=await service.sweep();
    assert.equal(cleaned.removed,1);assert.equal((await gitInfo(f.worktree)).isGit,false);
    const persisted=f.state.projects().find(item=>item.path===f.worktree);assert.ok(persisted.managedWorktree.cleanedAt);assert.equal(persisted.managedWorktree.cleanupReason,"unchanged");
    const restored=await service.ensure(f.worktree);assert.equal(restored.restored,true);assert.equal((await gitInfo(f.worktree)).branch,f.branch);assert.equal(f.state.projects().find(item=>item.path===f.worktree).managedWorktree.cleanedAt,null);
  }finally{await rm(f.home,{recursive:true,force:true})}
});

test("dirty and active managed worktrees are never cleaned",{timeout:30000},async()=>{
  const dirty=await fixture("dirty");
  try{
    await writeFile(join(dirty.worktree,"dirty.txt"),"keep me");const service=new WorktreeCleanupService({state:dirty.state});const result=await service.sweep();
    assert.equal(result.removed,0);assert.equal(result.results[0].reason,"dirty");assert.equal((await gitInfo(dirty.worktree)).isGit,true);
  }finally{await rm(dirty.home,{recursive:true,force:true})}
  const active=await fixture("active");
  try{
    const service=new WorktreeCleanupService({state:active.state,getUsage:()=>({activePaths:[active.worktree],referencedPaths:[active.worktree]})});const result=await service.sweep();
    assert.equal(result.removed,0);assert.equal(result.results[0].reason,"active");assert.equal((await gitInfo(active.worktree)).isGit,true);
  }finally{await rm(active.home,{recursive:true,force:true})}
});

test("merged and thread-delete rules are conservative",{timeout:30000},async()=>{
  const f=await fixture("merged");
  try{
    await writeFile(join(f.worktree,"feature.txt"),"feature");await git(f.worktree,["add","feature.txt"]);await git(f.worktree,["commit","-m","feature"]);
    await git(f.root,["merge","--no-ff",f.branch,"-m","merge feature"]);
    const mergedProject={...f.state.projects().find(item=>item.path===f.worktree),worktreeCleanup:{mode:"custom",rules:{worktreeAfterDays:null,worktreeOnMerge:true,worktreeOnDelete:false,worktreeUnchanged:false}}};
    const merged=await inspectManagedWorktree(mergedProject,{settings:f.state.settings()});assert.equal(merged.eligible,true);assert.ok(merged.triggers.includes("merged"));
    const deleteProject={...mergedProject,worktreeCleanup:{mode:"custom",rules:{worktreeAfterDays:null,worktreeOnMerge:false,worktreeOnDelete:true,worktreeUnchanged:false}}};
    const blocked=await inspectManagedWorktree(deleteProject,{settings:f.state.settings(),reason:"thread-delete",referencedPaths:[f.worktree]});assert.equal(blocked.eligible,false);assert.equal(blocked.reason,"threads_remain");
    const allowed=await inspectManagedWorktree(deleteProject,{settings:f.state.settings(),reason:"thread-delete",referencedPaths:[]});assert.equal(allowed.eligible,true);assert.ok(allowed.triggers.includes("thread_deleted"));
  }finally{await rm(f.home,{recursive:true,force:true})}
});

test("inactivity cleanup accepts only the configured retention window",{timeout:30000},async()=>{
  const f=await fixture("age");
  try{
    const project={...f.state.projects().find(item=>item.path===f.worktree),lastOpenedAt:Date.now()-31*86400000,worktreeCleanup:{mode:"custom",rules:{worktreeAfterDays:30,worktreeOnMerge:false,worktreeOnDelete:false,worktreeUnchanged:false}}};
    const old=await inspectManagedWorktree(project,{settings:f.state.settings(),now:Date.now()});assert.equal(old.eligible,true);assert.ok(old.triggers.includes("inactive"));
    const recent=await inspectManagedWorktree({...project,lastOpenedAt:Date.now()-5*86400000},{settings:f.state.settings(),now:Date.now()});assert.equal(recent.eligible,false);assert.equal(recent.reason,"no_rule_matched");
  }finally{await rm(f.home,{recursive:true,force:true})}
});
