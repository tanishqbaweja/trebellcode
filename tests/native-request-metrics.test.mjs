import test from "node:test";
import assert from "node:assert/strict";
import { attachNativePromptProvenance, nativeRequestMetrics } from "../src/native-request-metrics.mjs";

test("Native request metrics separate user text from Trebell working context without changing wire-visible messages",()=>{
  const current=attachNativePromptProvenance({role:"user",content:"context block\nuser request"},{
    userParts:["user request"],
    contextText:"context block",
    contextEntries:[
      {source:"trebell.goal",kind:"application",value:"goal text"},
      {source:"trebell.repo_evidence",kind:"untrusted",value:"repo evidence"},
    ],
  });
  const messages=[
    {role:"system",content:"system"},
    {role:"developer",content:"developer"},
    {role:"user",content:"old request"},
    {role:"assistant",content:"old answer"},
    {role:"tool",toolCallId:"t1",content:"large tool result"},
    {role:"developer",trebellCompaction:true,content:"compacted prior history"},
    current,
  ];
  const tools=[{type:"namespace",name:"trebell_workspace",tools:[{type:"function",name:"read_file",description:"read",inputSchema:{type:"object",properties:{path:{type:"string"}}}}]}];
  const result=nativeRequestMetrics(messages,tools);
  assert.ok(result.system.bytes>0);assert.ok(result.developer.bytes>0);assert.ok(result.compactedContext.bytes>0);
  assert.ok(result.conversationHistory.bytes>0);assert.ok(result.toolResults.bytes>0);assert.ok(result.toolSchemas.bytes>0);
  assert.ok(result.currentUser.bytes>0);assert.ok(result.currentUser.bytes<result.workingContext.bytes+result.currentUser.bytes);
  assert.ok(result.applicationContext.bytes>0);assert.ok(result.untrustedContext.bytes>0);
  assert.equal(typeof result.stablePrefixHash,"string");assert.equal(result.stablePrefixHash.length,16);
  assert.doesNotMatch(JSON.stringify(current),/userParts|contextEntries|contextText/);
});
