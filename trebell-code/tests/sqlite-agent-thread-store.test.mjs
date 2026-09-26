import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";

const require=createRequire(import.meta.url);
const {DatabaseSync}=require("node:sqlite");

test("legacy agent thread JSON imports once into normalized SQLite thread and turn tables",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-sqlite-migration-")),secret="legacy-secret-that-must-not-survive",env={...process.env,TREBELL_HOME:home,LEGACY_THREAD_SECRET:secret};
  const legacyPath=join(home,"agent-threads.json"),sqlitePath=join(home,"trebell.sqlite");
  const legacy={version:1,threads:[{
    id:"legacy-thread",runtime:"claude",providerSessionId:"provider-legacy",cwd:home,model:"sonnet",createdAt:10,updatedAt:20,status:{type:"idle"},archived:false,section:null,
    turns:[{id:"legacy-turn",status:"completed",startedAt:11,completedAt:12,durationMs:1000,error:null,items:[{id:"message-1",type:"agentMessage",text:"Imported history token="+secret}]}],
  }]};
  try{
    await writeFile(legacyPath,JSON.stringify(legacy),"utf8");
    const first=new AgentThreadStore(env),imported=first.get("legacy-thread");
    assert.equal(imported.providerSessionId,"provider-legacy");assert.equal(imported.turns.length,1);assert.match(imported.turns[0].items[0].text,/Imported history token=\[redacted\]/);assert.doesNotMatch(JSON.stringify(imported),new RegExp(secret));
    const db=new DatabaseSync(sqlitePath);try{
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM agent_threads").get().count),1);
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM agent_turns").get().count),1);
      assert.ok(db.prepare("SELECT value FROM agent_store_meta WHERE key='legacy_agent_threads_imported'").get()?.value);
    }finally{db.close()}

    const retired=JSON.parse(await readFile(legacyPath,"utf8"));assert.equal(retired.migratedTo,"trebell.sqlite");assert.equal(retired.importedThreads,1);assert.equal(Object.prototype.hasOwnProperty.call(retired,"threads"),false);assert.doesNotMatch(JSON.stringify(retired),new RegExp(secret));
    const changed={version:1,threads:[{id:"late-legacy-thread",runtime:"claude",providerSessionId:"late",cwd:home,createdAt:30,updatedAt:30,status:{type:"idle"},archived:false,turns:[]}]};
    await writeFile(legacyPath,JSON.stringify(changed),"utf8");
    const second=new AgentThreadStore(env);
    assert.equal(second.get("late-legacy-thread"),null,"legacy JSON must not become an active second source of truth after migration");
    const created=second.create({runtime:"native",cwd:home,providerSessionId:"native-new"});second.addTurn(created.id,{id:"native-turn",inputText:"Persist me"});second.finishTurn(created.id,"native-turn");
    const third=new AgentThreadStore(env);assert.equal(third.get(created.id).turns[0].status,"completed");
    const retiredAgain=JSON.parse(await readFile(legacyPath,"utf8"));assert.equal(retiredAgain.migratedTo,"trebell.sqlite");assert.equal(Object.prototype.hasOwnProperty.call(retiredAgain,"threads"),false,"a recreated legacy file must be retired instead of becoming a second source of truth");
  }finally{await rm(home,{recursive:true,force:true})}
});
