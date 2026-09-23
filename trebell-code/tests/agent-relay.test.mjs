import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { restoreClaudeRejectedRewind } from "../src/agent-relay.mjs";

test("rejected Claude rewind restores the original provider session and removed turns",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-claude-rewind-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const store=new AgentThreadStore(env);
    const source="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",target="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const original=[
      {id:"turn-1",status:"completed",items:[],providerMessageId:"assistant-1"},
      {id:"turn-2",status:"completed",items:[],providerMessageId:"assistant-2"},
      {id:"turn-3",status:"completed",items:[],providerMessageId:"assistant-3"},
    ];
    const thread=store.create({runtime:"claude",cwd:process.cwd(),providerSessionId:source});
    store.update(thread.id,{
      providerSessionId:target,
      turns:[original[0],{id:"replacement",status:"inProgress",items:[]}],
      providerMeta:{
        keep:"value",
        claudeFork:{sourceSessionId:source,targetSessionId:target,resumeSessionAt:"assistant-1"},
        claudeRewindBackup:{sourceSessionId:source,retainedCount:1,removedTurns:original.slice(1),createdAt:Date.now()},
      },
    });
    const restored=restoreClaudeRejectedRewind(store,thread.id,{claudeFork:{sourceSessionId:source}});
    assert.equal(restored.providerSessionId,source);
    assert.deepEqual(restored.turns.map(turn=>turn.id),["turn-1","turn-2","turn-3"]);
    assert.equal(restored.providerMeta.keep,"value");
    assert.equal(Object.prototype.hasOwnProperty.call(restored.providerMeta,"claudeFork"),false);
    assert.equal(Object.prototype.hasOwnProperty.call(restored.providerMeta,"claudeRewindBackup"),false);
  }finally{await rm(home,{recursive:true,force:true})}
});
