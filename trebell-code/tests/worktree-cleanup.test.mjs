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

test("remote managed worktree cleanup and restore stay inside the pinned environment",async()=>{
  const root="/srv/repo",worktree="/srv/repo-trebell-feature",environmentId="ssh-1",calls=[];let removed=false;
  let project={id:"remote-project",path:worktree,environmentId,lastOpenedAt:Date.now(),worktreeCleanup:{mode:"custom",rules:{worktreeAfterDays:null,worktreeOnMerge:false,worktreeOnDelete:false,worktreeUnchanged:true}},managedWorktree:{root,branch:"feature",baseBranch:"main",submodules:"none",createdAt:Date.now(),cleanedAt:null,cleanupReason:null}};
  const state={
    settings:()=>({}),projectSettings:()=>({effective:{worktreeCleanup:project.worktreeCleanup}}),projects:()=>[structuredClone(project)],
    touchProject:(_path,patch)=>{project={...project,...patch,managedWorktree:patch.managedWorktree?{...patch.managedWorktree}:project.managedWorktree};return structuredClone(project)},
  };
  const environments={
    get:id=>id===environmentId?{id,type:"ssh",cwd:root}:null,
    executeArgv:async(id,request)=>{
      assert.equal(id,environmentId);assert.equal(request.command,"git");calls.push(structuredClone(request));const args=request.args||[],command=args[0];
      if(command==="rev-parse"&&args[1]==="--show-toplevel"){
        if(removed&&request.cwd===worktree)return {exitCode:128,stdout:"",stderr:"not a git repository"};
        return {exitCode:0,stdout:(request.cwd===worktree?worktree:root)+"\n",stderr:""};
      }
      if(command==="branch")return {exitCode:0,stdout:(request.cwd===worktree?"feature":"main")+"\n",stderr:""};
      if(command==="status")return {exitCode:0,stdout:`## ${request.cwd===worktree?"feature":"main"}\n`,stderr:""};
      if(command==="worktree"&&args[1]==="list")return {exitCode:0,stdout:`worktree ${root}\nHEAD rootsha\nbranch refs/heads/main\n\n${removed?"":`worktree ${worktree}\nHEAD same-sha\nbranch refs/heads/feature\n\n`}`,stderr:""};
      if(command==="rev-parse")return {exitCode:0,stdout:"same-sha\n",stderr:""};
      if(command==="rev-list")return {exitCode:0,stdout:"0\n",stderr:""};
      if(command==="worktree"&&args[1]==="remove"){assert.equal(request.cwd,root);assert.equal(args.at(-1),worktree);removed=true;return {exitCode:0,stdout:"",stderr:""}}
      if(command==="worktree"&&args[1]==="add"){assert.equal(request.cwd,root);assert.deepEqual(args.slice(0,4),["worktree","add",worktree,"feature"]);removed=false;return {exitCode:0,stdout:"",stderr:""}}
      throw new Error(`unexpected remote git ${args.join(" ")} in ${request.cwd}`);
    },
  };
  const service=new WorktreeCleanupService({state,environments});
  const cleaned=await service.sweep();assert.equal(cleaned.removed,1);assert.equal(removed,true);assert.ok(project.managedWorktree.cleanedAt);assert.equal(project.managedWorktree.cleanupReason,"unchanged");
  const restored=await service.ensure(worktree,environmentId);assert.equal(restored.restored,true);assert.equal(removed,false);assert.equal(project.managedWorktree.cleanedAt,null);
  assert.equal(calls.some(call=>/^[A-Za-z]:\\/.test(String(call.cwd||""))),false,"remote cleanup must not reinterpret remote paths as local Windows paths");
});

test("named local worktree environments keep local Git mechanics",{timeout:30000},async()=>{
  const f=await fixture("named-local");
  try{
    const managed={...f.project.managedWorktree},project=f.state.touchProject(f.worktree,{environmentId:"local-named",managedWorktree:managed});let environmentExecutions=0;
    const environments={get:id=>id==="local-named"?{id,type:"local",cwd:f.worktree}:null,executeArgv:async()=>{environmentExecutions++;throw new Error("named local worktrees should use local Git")}};
    const inspection=await new WorktreeCleanupService({state:f.state,environments}).inspect(project);assert.equal(inspection.eligible,true);assert.ok(inspection.triggers.includes("unchanged"));assert.equal(environmentExecutions,0);
  }finally{await rm(f.home,{recursive:true,force:true})}
});

test("managed worktrees never fall back local when their pinned environment disappeared",async()=>{
  const project={id:"missing-env",path:"/srv/worktree",environmentId:"gone",managedWorktree:{root:"/srv/repo",branch:"feature",baseBranch:"main",createdAt:1},worktreeCleanup:{mode:"custom",rules:{worktreeUnchanged:true}}};
  const state={settings:()=>({}),projectSettings:()=>({effective:{worktreeCleanup:project.worktreeCleanup}})};
  await assert.rejects(()=>new WorktreeCleanupService({state,environments:{get:()=>null}}).inspect(project),/environment could not be found/i);
});
