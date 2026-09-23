import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointService, isTransientCheckpointGitError } from "../src/checkpoint-service.mjs";
import { git } from "../src/git-service.mjs";

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
    if(args[0]==="rev-parse")return {ok:true,stdout:"head123\n",stderr:""};
    if(args[0]==="read-tree")return {ok:true,stdout:"",stderr:""};
    if(args[0]==="add"){
      addAttempts++;
      if(addAttempts===1)throw new Error("fatal: Unable to create '/repo/private-index.lock': File exists");
      return {ok:true,stdout:"",stderr:""};
    }
    if(args[0]==="write-tree")return {ok:true,stdout:"tree123\n",stderr:""};
    if(args[0]==="commit-tree")return {ok:true,stdout:"commit123\n",stderr:""};
    if(args[0]==="update-ref")return {ok:true,stdout:"",stderr:""};
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
    assert.equal(calls.filter(args=>args[0]==="read-tree").length,1);
    assert.equal(calls.filter(args=>args[0]==="write-tree").length,1);
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
      if(args[0]==="rev-parse")return {ok:true,stdout:"head123\n",stderr:""};
      if(args[0]==="read-tree")return {ok:true,stdout:"",stderr:""};
      if(args[0]==="add"){addAttempts++;throw new Error("fatal: index file corrupt")}
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
      if(args[0]==="rev-parse")return {ok:true,stdout:"head123\n",stderr:""};
      if(args[0]==="read-tree")return {ok:true,stdout:"",stderr:""};
      if(args[0]==="add")throw new Error("error: 'empty-0/' does not have a commit checked out\nfatal: adding files failed");
      if(args[0]==="ls-files")return {ok:true,stdout:candidates,stderr:""};
      throw new Error("unexpected git "+args.join(" "));
    },
  });
  try{
    await assert.rejects(()=>service.create({cwd:"/repo"}),/does not have a commit checked out/);
    assert.equal(nestedProbes,0);
  }finally{await rm(home,{recursive:true,force:true})}
});
