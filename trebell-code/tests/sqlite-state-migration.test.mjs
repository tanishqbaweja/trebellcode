import test from "node:test";
import assert from "node:assert/strict";
import { access,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";

test("legacy JSON collections migrate to SQLite once and survive later restarts",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-sqlite-migration-")),env={...process.env,TREBELL_HOME:home},now=Date.now();
  try{
    await writeFile(join(home,"ui-state.json"),JSON.stringify({
      version:2,projects:[],threadMeta:{},settings:{},environments:[],stashes:[],
      checkpoints:[{id:"checkpoint-legacy",threadId:"thread-1",root:"C:/repo",commit:"abc",ref:"refs/trebell/checkpoints/legacy",createdAt:now-4000}],
      usageRecords:[{id:"usage-legacy",runtime:"native",provider:"agentrouter",model:"model-a",environmentId:null,threadId:"thread-1",turnId:"turn-1",at:now-3000,usage:{totalTokens:10,inputTokens:7,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:3,reasoningOutputTokens:0},cost:null}],
      verificationRecords:[{id:"verification-legacy",environmentId:null,projectPath:"C:/repo",threadId:"thread-1",turnId:"turn-1",plan:{risk:"low",steps:[]},evidence:[],assessment:{status:"verified",risk:"low"},status:"verified",risk:"low",createdAt:now-2000,updatedAt:now-2000}],
      repositoryKnowledge:[{id:"knowledge-legacy",projectPath:"C:/repo",environmentId:null,category:"structure",fact:"Legacy fact",scope:"repository",source:"explicit",confidence:1,status:"verified",evidence:[],createdAt:now-1000,updatedAt:now-1000}],
    },null,2));

    const migrated=new TrebellStateStore(env);
    assert.equal(migrated.checkpoints("thread-1")[0]?.id,"checkpoint-legacy");
    assert.equal(migrated.usage({days:1}).records[0]?.id,"usage-legacy");
    assert.equal(migrated.verificationRecords({threadId:"thread-1"})[0]?.id,"verification-legacy");
    assert.equal(migrated.repositoryKnowledge({projectPath:"C:/repo"})[0]?.id,"knowledge-legacy");
    await access(join(home,"trebell.sqlite"));

    const compactJson=JSON.parse(await readFile(join(home,"ui-state.json"),"utf8"));
    for(const key of ["checkpoints","usageRecords","verificationRecords","repositoryKnowledge"])assert.equal(Object.prototype.hasOwnProperty.call(compactJson,key),false,`${key} should move out of ui-state.json`);

    migrated.updateCheckpoint("checkpoint-legacy",{label:"migrated checkpoint"});
    migrated.recordUsage({id:"usage-legacy",runtime:"native",provider:null,model:null,threadId:"thread-1",turnId:"turn-1",at:now-500,usage:{totalTokens:15,inputTokens:9,outputTokens:6}});
    migrated.recordVerification({id:"verification-legacy",projectPath:"C:/repo",threadId:"thread-1",turnId:"turn-1",plan:{risk:"low",steps:[]},evidence:[],assessment:{status:"failed",risk:"low"},updatedAt:now});
    migrated.upsertRepositoryKnowledge({id:"knowledge-legacy",projectPath:"C:/repo",category:"structure",fact:"Updated fact",status:"verified",updatedAt:now});

    const restarted=new TrebellStateStore(env);
    assert.equal(restarted.checkpoints("thread-1").length,1);assert.equal(restarted.checkpoints("thread-1")[0].label,"migrated checkpoint");
    const usage=restarted.usage({days:1}).records;assert.equal(usage.length,1);assert.equal(usage[0].usage.totalTokens,15);assert.equal(usage[0].provider,"agentrouter");assert.equal(usage[0].model,"model-a");
    const verification=restarted.verificationRecords({threadId:"thread-1"});assert.equal(verification.length,1);assert.equal(verification[0].status,"failed");assert.equal(verification[0].createdAt,now-2000);
    const knowledge=restarted.repositoryKnowledge({projectPath:"C:/repo"});assert.equal(knowledge.length,1);assert.equal(knowledge[0].fact,"Updated fact");assert.equal(knowledge[0].createdAt,now-1000);
  }finally{await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});
