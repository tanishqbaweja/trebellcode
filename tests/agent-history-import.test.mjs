import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeMessagesToTurns, parseCodexHistoryPrefix, publicHistoryCandidate, scanCodexHistory } from "../src/agent-history-import.mjs";

test("Codex history prefixes expose safe metadata without leaking source paths",()=>{
  const parsed=parseCodexHistoryPrefix([
    JSON.stringify({timestamp:"2026-09-23T01:00:00Z",type:"session_meta",payload:{id:"12345678-1234-4abc-8123-123456789abc",cwd:"C:\\repo"}}),
    JSON.stringify({type:"turn_context",payload:{model:"gpt-test"}}),
    JSON.stringify({type:"event_msg",payload:{type:"user_message",message:"Fix the thing please"}}),
  ].join("\n"),{path:"C:\\Users\\me\\.codex\\sessions\\rollout.jsonl",updatedAt:1234,createdAt:1200});
  assert.equal(parsed.providerSessionId,"12345678-1234-4abc-8123-123456789abc");
  assert.equal(parsed.cwd,"C:\\repo");
  assert.equal(parsed.title,"Fix the thing please");
  assert.equal(parsed.model,"gpt-test");
  const publicValue=publicHistoryCandidate(parsed,{alreadyImported:true});
  assert.equal(publicValue.alreadyImported,true);
  assert.equal(Object.prototype.hasOwnProperty.call(publicValue,"sourcePath"),false);
});

test("Codex history scan is bounded to existing workspaces and excludes Trebell's own Codex home",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-history-"));
  const workspace=join(root,"workspace");
  const externalHome=join(root,"external-codex");
  const ownHome=join(root,"trebell-home");
  try{
    await mkdir(workspace,{recursive:true});
    const sessions=join(externalHome,"sessions","2026","09","23");await mkdir(sessions,{recursive:true});
    await writeFile(join(sessions,"rollout-test.jsonl"),[
      JSON.stringify({timestamp:"2026-09-23T01:00:00Z",type:"session_meta",payload:{id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",cwd:workspace}}),
      JSON.stringify({type:"event_msg",payload:{type:"user_message",message:"Remember me"}}),
    ].join("\n"));
    const env={...process.env,TREBELL_HOME:ownHome};
    const found=await scanCodexHistory({env,sourceHome:externalHome});
    assert.equal(found.length,1);
    assert.equal(found[0].cwd,workspace);
    assert.equal((await scanCodexHistory({env,sourceHome:join(ownHome,"codex")})).length,0);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Claude history is converted into completed user/assistant turns",()=>{
  const turns=claudeMessagesToTurns([
    {type:"user",uuid:"u1",message:{content:"First question"}},
    {type:"assistant",uuid:"a1",message:{content:[{type:"text",text:"First answer"}]}},
    {type:"user",uuid:"u2",message:{content:"Second question"}},
    {type:"assistant",uuid:"a2",message:{content:[{type:"text",text:"Second answer"}]}},
  ],{createdAt:1000});
  assert.equal(turns.length,2);
  assert.equal(turns[0].items[0].content[0].text,"First question");
  assert.equal(turns[0].items[1].text,"First answer");
  assert.equal(turns[1].items[0].content[0].text,"Second question");
  assert.equal(turns[1].status,"completed");
});
