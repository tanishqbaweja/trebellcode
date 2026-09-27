import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { attachNativePromptProvenance, nativeRequestMetrics, NATIVE_TOOL_SCHEMA_FINGERPRINT } from "../src/native-request-metrics.mjs";

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
  assert.match(result[NATIVE_TOOL_SCHEMA_FINGERPRINT],/^[a-f0-9]{64}$/);
  assert.deepEqual({system:result.system,developer:result.developer,compactedContext:result.compactedContext,conversationHistory:result.conversationHistory,toolResults:result.toolResults,toolSchemas:result.toolSchemas,messages:result.messages,totalLogical:result.totalLogical,stablePrefixHash:result.stablePrefixHash,systemHash:result.systemHash,developerHash:result.developerHash,toolSchemaHash:result.toolSchemaHash,conversationHistoryHash:result.conversationHistoryHash},{system:{bytes:38,estimatedTokens:10},developer:{bytes:44,estimatedTokens:11},compactedContext:{bytes:83,estimatedTokens:21},conversationHistory:{bytes:85,estimatedTokens:22},toolResults:{bytes:65,estimatedTokens:17},toolSchemas:{bytes:191,estimatedTokens:48},messages:{bytes:367,estimatedTokens:92},totalLogical:{bytes:558,estimatedTokens:140},stablePrefixHash:"ee7416affa6acde1",systemHash:"cb8b7d8ecc01e973",developerHash:"9e21da67daca0313",toolSchemaHash:"1318ec39939924ff",conversationHistoryHash:"14bdd6f825c29235"});
});

test("Native request metrics preserve stable-prefix fallback semantics for non-serializable tools",()=>{
  const circular={type:"function",name:"circular"};circular.self=circular;
  const messages=[{role:"system",content:"system"},{role:"developer",content:"developer"},{role:"user",content:"request"}],tools=[circular];
  const expected=createHash("sha256").update(String({system:[messages[0]],developer:[messages[1]],tools})).digest("hex").slice(0,16),result=nativeRequestMetrics(messages,tools);
  assert.equal(result.stablePrefixHash,expected);
});

test("Native request metrics preserve array JSON semantics when a message defines toJSON",()=>{
  const tricky={role:"system",content:"source",toJSON(key){return {role:"system",content:key==="0"?"array-value":"standalone-value"}}},messages=[tricky,{role:"user",content:"request"}],result=nativeRequestMetrics(messages,[]),systemJson=JSON.stringify([tricky]),messagesJson=JSON.stringify(messages);
  assert.equal(result.system.bytes,Buffer.byteLength(systemJson,"utf8"));assert.equal(result.messages.bytes,Buffer.byteLength(messagesJson,"utf8"));
  assert.equal(result.systemHash,createHash("sha256").update(systemJson).digest("hex").slice(0,16));assert.equal(result.messages.estimatedTokens,Math.ceil(Buffer.byteLength(messagesJson,"utf8")/4));
});
