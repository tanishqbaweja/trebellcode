import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointService, isTransientCheckpointGitError } from "../src/checkpoint-service.mjs";
import { git } from "../src/git-service.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

function gitCommand(args){
  let index=0;
  while(args[index]==="-c")index+=2;
  return args[index];
}

test("checkpoint retry classification accepts only transient lock and disappearing-file races",()=>{
  assert.equal(isTransientCheckpointGitError(new Error("fatal: Unable to create '/repo/index.lock': File exists")),true);
  assert.equal(isTransientCheckpointGitError(new Error('error: open("/repo/file"): No such file or directory')),true);
  assert.equal(isTransientCheckpointGitError(new Error("fatal: unable to stat '/repo/file': No such file or directory")),true);
  assert.equal(isTransientCheckpointGitError(new Error("fatal: Unable to create '/repo/index.lock': Permission denied")),false);
  assert.equal(isTransientCheckpointGitError(new Error("fatal: index file corrupt")),false);
});

test("checkpoint capture retries a transient Git failure without restarting the whole capture",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-checkpoint-retry-"));
  const calls=[];const sleeps=[];let addAttempts=0;
  const state={addCheckpoint:item=>({...item,createdAt:1}),checkpoints:()=>[],updateCheckpoint:()=>null};
  const gitFn=async(_cwd,args)=>{
    calls.push([...args]);
    const command=gitCommand(args);
    if(command==="rev-parse")return {ok:true,stdout:"head123\n",stderr:""};
    if(command==="read-tree")return {ok:true,stdout:"",stderr:""};
    if(command==="add"){
      addAttempts++;
      if(addAttempts===1)throw new Error("fatal: Unable to create '/repo/private-index.lock': File exists");
      return {ok:true,stdout:"",stderr:""};
    }
    if(command==="write-tree")return {ok:true,stdout:"tree123\n",stderr:""};
    if(command==="commit-tree")return {ok:true,stdout:"commit123\n",stderr:""};
    if(command==="update-ref")return {ok:true,stdout:"",stderr:""};
    throw new Error("unexpected git "+args.join(" "));
  };
  try{
    const service=new CheckpointService({
      state,env:{...process.env,TREBELL_HOME:home},gitFn,
      gitInfoFn:async()=>({isGit:true,root:"/repo"}),
      sleepFn:async ms=>{sleeps.push(ms)},
    });
    const checkpoint=await service.create({cwd:"/repo",threadId:"thread-1",label:"Before edit"});
    assert.equal(checkpoint.supported,true);
    assert.equal(addAttempts,2);
    assert.deepEqual(sleeps,[75]);
    assert.equal(calls.filter(args=>gitCommand(args)==="read-tree").length,1);
    assert.equal(calls.filter(args=>gitCommand(args)==="write-tree").length,1);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("checkpoint capture does not retry non-transient Git failures",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-checkpoint-fail-"));let addAttempts=0,sleepCalls=0;
  const service=new CheckpointService({
    state:{addCheckpoint:item=>item},
    env:{...process.env,TREBELL_HOME:home},
    gitInfoFn:async()=>({isGit:true,root:"/repo"}),
    sleepFn:async()=>{sleepCalls++},
    gitFn:async(_cwd,args)=>{
      const command=gitCommand(args);
      if(command==="rev-parse")return {ok:true,stdout:"head123\n",stderr:""};
      if(command==="read-tree")return {ok:true,stdout:"",stderr:""};
      if(command==="add"){addAttempts++;throw new Error("fatal: index file corrupt")}
      throw new Error("unexpected git "+args.join(" "));
    },
  });
  try{
    await assert.rejects(()=>service.create({cwd:"/repo"}),/index file corrupt/);
    assert.equal(addAttempts,1);
    assert.equal(sleepCalls,0);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("checkpoint capture skips unborn nested repositories but records committed nested repositories",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-checkpoint-nested-"));
  const home=join(root,"trebell-home"),repo=join(root,"repo");
  try{
    await mkdir(repo,{recursive:true});
    await git(repo,["init"]);
    await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Test"]);
    await writeFile(join(repo,"tracked.txt"),"tracked\n");await git(repo,["add","tracked.txt"]);await git(repo,["commit","-m","Base"]);
    const originalIndex=await readFile(join(repo,".git","index"));
    const emptyNested=join(repo,"scratch","empty [repo]");await mkdir(emptyNested,{recursive:true});await git(emptyNested,["init"]);
    await writeFile(join(emptyNested,"private.txt"),"do not capture\n");
    const committedNested=join(repo,"committed");await mkdir(committedNested,{recursive:true});await git(committedNested,["init"]);
    await git(committedNested,["config","user.email","trebell@example.test"]);await git(committedNested,["config","user.name","Trebell Test"]);
    await git(committedNested,["commit","--allow-empty","-m","Nested base"]);
    const nestedHead=(await git(committedNested,["rev-parse","HEAD"])).stdout.trim();
    await writeFile(join(repo,"untracked.txt"),"new\n");
    const state={addCheckpoint:item=>({...item,createdAt:1}),checkpoints:()=>[],updateCheckpoint:()=>null};
    const checkpoint=await new CheckpointService({state,env:{...process.env,TREBELL_HOME:home}}).create({cwd:repo,threadId:"thread-nested"});
    assert.equal(checkpoint.supported,true);
    assert.equal((await git(repo,["show",checkpoint.commit+":untracked.txt"])).stdout,"new\n");
    assert.equal((await git(repo,["ls-tree","-r",checkpoint.commit,"--","scratch/empty [repo]"])).stdout,"");
    assert.match((await git(repo,["ls-tree",checkpoint.commit,"--","committed"])).stdout,new RegExp("160000 commit "+nestedHead+"\\s+committed"));
    assert.deepEqual(await readFile(join(repo,".git","index")),originalIndex);
    assert.equal(await readFile(join(emptyNested,"private.txt"),"utf8"),"do not capture\n");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("checkpoint nested-repository recovery refuses excessive candidates before probing them",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-checkpoint-cap-"));let nestedProbes=0;
  const candidates=Array.from({length:65},(_,index)=>"empty-"+index+"/").join("\0")+"\0";
  const service=new CheckpointService({
    state:{addCheckpoint:item=>item},
    env:{...process.env,TREBELL_HOME:home},
    gitInfoFn:async()=>({isGit:true,root:"/repo"}),
    gitFn:async(cwd,args)=>{
      if(cwd!=="/repo")nestedProbes++;
      const command=gitCommand(args);
      if(command==="rev-parse")return {ok:true,stdout:"head123\n",stderr:""};
      if(command==="read-tree")return {ok:true,stdout:"",stderr:""};
      if(command==="add")throw new Error("error: 'empty-0/' does not have a commit checked out\nfatal: adding files failed");
      if(command==="ls-files")return {ok:true,stdout:candidates,stderr:""};
      throw new Error("unexpected git "+args.join(" "));
    },
  });
  try{
    await assert.rejects(()=>service.create({cwd:"/repo"}),/does not have a commit checked out/);
    assert.equal(nestedProbes,0);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("checkpoint objects and refs request fsync before state publication",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-checkpoint-fsync-"));const calls=[];let published=false;
  const state={addCheckpoint:item=>{published=true;return {...item,createdAt:1}},checkpoints:()=>[],updateCheckpoint:()=>null};
  const gitFn=async(_cwd,args)=>{
    assert.equal(published,false,"checkpoint state must not publish before Git finishes");
    calls.push([...args]);const command=gitCommand(args);
    if(command==="rev-parse")return {ok:true,stdout:"head123\n",stderr:""};
    if(command==="read-tree"||command==="add"||command==="update-ref")return {ok:true,stdout:"",stderr:""};
    if(command==="write-tree")return {ok:true,stdout:"tree123\n",stderr:""};
    if(command==="commit-tree")return {ok:true,stdout:"commit123\n",stderr:""};
    throw new Error("unexpected git "+args.join(" "));
  };
  try{
    await new CheckpointService({state,env:{...process.env,TREBELL_HOME:home},gitFn,gitInfoFn:async()=>({isGit:true,root:"/repo"})}).create({cwd:"/repo"});
    assert.equal(published,true);
    for(const command of ["add","write-tree","commit-tree","update-ref"]){
      const args=calls.find(item=>gitCommand(item)===command);assert.ok(args,command+" was called");
      assert.equal(args[0],"-c");assert.equal(args[1],"core.fsync=objects,reference");
      assert.equal(args[2],"-c");assert.equal(args[3],"core.fsyncMethod=fsync");
      assert.equal(args[4],command);
    }
  }finally{await rm(home,{recursive:true,force:true})}
});

test("checkpoint change inspection compares against the captured tree without blaming pre-existing untracked files",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-checkpoint-diff-"));
  const home=join(root,"home"),repo=join(root,"repo");
  try{
    await mkdir(repo,{recursive:true});await git(repo,["init"]);await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Test"]);
    await writeFile(join(repo,"tracked.txt"),"base\n");await git(repo,["add","tracked.txt"]);await git(repo,["commit","-m","Base"]);
    await writeFile(join(repo,"preexisting.txt"),"already here\n");
    const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env),service=new CheckpointService({state,env});
    const checkpoint=await service.create({cwd:repo,threadId:"thread-diff",label:"Before turn"});
    const checkpointPaths=(await git(repo,["ls-tree","-r","--name-only",checkpoint.commit])).stdout.split(/\r?\n/).filter(Boolean);
    assert.ok(checkpointPaths.includes("preexisting.txt"),"checkpoint must capture pre-existing untracked files before diffing the turn");
    await writeFile(join(repo,"tracked.txt"),"changed\n");
    await writeFile(join(repo,"new-after-turn.txt"),"new\n");
    const changed=await service.changedPaths(checkpoint.id,{threadId:"thread-diff"});
    assert.deepEqual(changed.paths,["new-after-turn.txt","tracked.txt"]);
    await assert.rejects(()=>service.changedPaths(checkpoint.id,{threadId:"wrong-thread"}),/thread that created/i);
    await writeFile(join(repo,"tracked.txt"),"base\n");await rm(join(repo,"new-after-turn.txt"));
    assert.deepEqual((await service.changedPaths(checkpoint.id,{threadId:"thread-diff"})).paths,[]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("file rewind restores only an isolated managed worktree and refuses sibling ownership",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-checkpoint-isolation-"));
  const home=join(root,"home"),repo=join(root,"repo"),worktree=join(root,"worktree");
  try{
    await mkdir(repo,{recursive:true});
    await git(repo,["init"]);await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Test"]);
    await git(repo,["checkout","-b","main"]);await writeFile(join(repo,"file.txt"),"base\n");await git(repo,["add","."]);await git(repo,["commit","-m","Base"]);
    await git(repo,["branch","feature"]);await git(repo,["worktree","add",worktree,"feature"]);
    const env={...process.env,TREBELL_HOME:home};const state=new TrebellStateStore(env);
    state.touchProject(worktree,{managedWorktree:{root:repo,branch:"feature",baseBranch:"main",submodules:"none",createdAt:Date.now()}});
    state.updateThreadMeta("thread-owner",{cwd:worktree,archived:false});
    const service=new CheckpointService({state,env});
    await writeFile(join(worktree,"file.txt"),"checkpoint\n");
    const checkpoint=await service.create({cwd:worktree,threadId:"thread-owner",label:"Before change"});
    await writeFile(join(worktree,"file.txt"),"later\n");
    await service.restore(checkpoint.id,{threadId:"thread-owner"});
    assert.equal(await readFile(join(worktree,"file.txt"),"utf8"),"checkpoint\n");

    await writeFile(join(worktree,"file.txt"),"sibling work\n");
    state.updateThreadMeta("thread-sibling",{cwd:worktree,archived:true});
    await assert.rejects(()=>service.restore(checkpoint.id,{threadId:"thread-owner"}),/another thread|isolated Trebell worktree/i);
    assert.equal(await readFile(join(worktree,"file.txt"),"utf8"),"sibling work\n");

    state.updateThreadMeta("thread-sibling",{deletedAt:Date.now()});
    const nested=join(worktree,"nested-owner");await mkdir(nested,{recursive:true});
    state.updateThreadMeta("thread-nested",{cwd:nested,archived:false});
    await assert.rejects(()=>service.restore(checkpoint.id,{threadId:"thread-owner"}),/another thread|isolated Trebell worktree/i);
    assert.equal(await readFile(join(worktree,"file.txt"),"utf8"),"sibling work\n");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("file rewind refuses ordinary shared project directories and checkpoint cross-thread use",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-checkpoint-shared-"));const home=join(root,"home"),repo=join(root,"repo");
  try{
    await mkdir(repo,{recursive:true});await git(repo,["init"]);await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Test"]);
    await writeFile(join(repo,"file.txt"),"base\n");await git(repo,["add","."]);await git(repo,["commit","-m","Base"]);
    const env={...process.env,TREBELL_HOME:home};const state=new TrebellStateStore(env);
    state.touchProject(repo,{});state.updateThreadMeta("thread-owner",{cwd:repo});
    const service=new CheckpointService({state,env});const checkpoint=await service.create({cwd:repo,threadId:"thread-owner"});
    await assert.rejects(()=>service.restore(checkpoint.id,{threadId:"thread-other"}),/thread that created/i);
    await assert.rejects(()=>service.restore(checkpoint.id,{threadId:"thread-owner"}),/isolated Trebell worktree/i);
  }finally{await rm(root,{recursive:true,force:true})}
});
