import test from "node:test";
import assert from "node:assert/strict";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointService } from "../src/checkpoint-service.mjs";
import { git } from "../src/git-service.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

test("named local environments keep local checkpoint mechanics while preserving environment identity",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-checkpoint-local-env-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  try{
    await git(repo,["init"]);await git(repo,["config","user.email","checkpoint@example.invalid"]);await git(repo,["config","user.name","Checkpoint Test"]);await writeFile(join(repo,"file.txt"),"base\n");await git(repo,["add","."]);await git(repo,["commit","-m","base"]);
    const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);let environmentExecutions=0;
    const environments={get:id=>id==="local-named"?{id:"local-named",type:"local",cwd:repo}:null,executeArgv:async()=>{environmentExecutions++;throw new Error("named local checkpoint should not use remote environment execution")}};
    const service=new CheckpointService({state,env,environments}),checkpoint=await service.create({cwd:repo,threadId:"thread-local",environmentId:"local-named"});
    assert.equal(checkpoint.supported,true);assert.equal(checkpoint.environmentId,"local-named");assert.equal(environmentExecutions,0);
    await writeFile(join(repo,"file.txt"),"changed\n");const changed=await service.changedPaths(checkpoint.id,{threadId:"thread-local"});assert.deepEqual(changed.paths,["file.txt"]);assert.equal(environmentExecutions,0);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});

test("checkpoint creation refuses an unavailable pinned environment instead of silently falling back local",async()=>{
  const state={addCheckpoint:item=>item,checkpoints:()=>[]},service=new CheckpointService({state,environments:{get:()=>null}});
  await assert.rejects(()=>service.create({cwd:process.cwd(),threadId:"thread-missing",environmentId:"missing-env"}),/environment is unavailable/i);
});
