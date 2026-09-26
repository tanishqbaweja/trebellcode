import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";

const require=createRequire(import.meta.url);
const {DatabaseSync}=require("node:sqlite");

test("durable SQLite state redacts known credentials on legacy import and new writes",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-redaction-")),secret="state-persistence-secret-value",env={...process.env,TREBELL_HOME:home,STATE_SECRET_TOKEN:secret},statePath=join(home,"ui-state.json"),dbPath=join(home,"trebell.sqlite"),now=Date.now();
  try{
    await writeFile(statePath,JSON.stringify({
      version:2,projects:[],threadMeta:{},settings:{},environments:[],stashes:[],
      checkpoints:[{id:"legacy-cp",threadId:"thread-1",createdAt:now-3,label:"checkpoint "+secret}],
      usageRecords:[],
      verificationRecords:[{id:"legacy-verification",projectPath:"C:/repo",threadId:"thread-1",turnId:"turn-1",evidence:[{summary:"legacy evidence "+secret}],assessment:{status:"failed",reason:"token="+secret},status:"failed",risk:"low",createdAt:now-2,updatedAt:now-2}],
      repositoryKnowledge:[{id:"legacy-knowledge",projectPath:"C:/repo",category:"architecture",fact:"Legacy fact uses "+secret,scope:"repository",source:"explicit",status:"verified",evidence:[],createdAt:now-1,updatedAt:now-1}],
    }),"utf8");
    const state=new TrebellStateStore(env);
    assert.doesNotMatch(JSON.stringify(state.checkpoints()),new RegExp(secret));assert.match(state.checkpoints()[0].label,/\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(state.verificationRecords({threadId:"thread-1"})),new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(state.repositoryKnowledge({projectPath:"C:/repo"})),new RegExp(secret));

    state.addCheckpoint({id:"new-cp",threadId:"thread-2",label:"new "+secret});
    state.updateCheckpoint("new-cp",{restoreNote:"restored with "+secret});
    state.recordVerification({id:"new-verification",projectPath:"C:/repo",threadId:"thread-2",turnId:"turn-2",plan:{risk:"low",steps:[]},evidence:[{summary:"runtime "+secret}],assessment:{status:"failed",risk:"low",reason:"Bearer "+secret}});
    state.upsertRepositoryKnowledge({id:"new-knowledge",projectPath:"C:/repo",category:"architecture",fact:"Do not persist "+secret,status:"verified",evidence:[{path:"src/app.js",note:"token="+secret}]});

    assert.doesNotMatch(JSON.stringify(state.checkpoints("thread-2")),new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(state.verificationRecords({threadId:"thread-2"})),new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(state.repositoryKnowledge({projectPath:"C:/repo"})),new RegExp(secret));
    const uiText=await readFile(statePath,"utf8");assert.doesNotMatch(uiText,new RegExp(secret));

    const db=new DatabaseSync(dbPath);try{
      const payloads=[
        ...db.prepare("SELECT payload_json FROM state_checkpoints").all(),
        ...db.prepare("SELECT payload_json FROM state_verification").all(),
        ...db.prepare("SELECT payload_json FROM state_knowledge").all(),
      ].map(row=>String(row.payload_json||"")).join("\n");
      assert.doesNotMatch(payloads,new RegExp(secret));assert.match(payloads,/\[redacted\]/);
    }finally{db.close()}
  }finally{await rm(home,{recursive:true,force:true})}
});
