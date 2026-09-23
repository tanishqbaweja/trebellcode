import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointService, isTransientCheckpointGitError } from "../src/checkpoint-service.mjs";

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
