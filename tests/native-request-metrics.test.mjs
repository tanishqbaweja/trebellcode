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

test("Native request metrics can reuse a stable tool-schema serialization within one agent turn",()=>{
  const messages=[{role:"system",content:"system"},{role:"user",content:"request"}],tools=[{type:"namespace",name:"trebell_workspace",tools:[{name:"read_file",description:"read",inputSchema:{type:"object",properties:{path:{type:"string"}}}}]}],cache=new WeakMap();
  const uncached=nativeRequestMetrics(messages,tools),cachedFirst=nativeRequestMetrics(messages,tools,{toolSchemaCache:cache}),cachedSecond=nativeRequestMetrics(messages,tools,{toolSchemaCache:cache});
  assert.deepEqual(cachedFirst,uncached);assert.deepEqual(cachedSecond,uncached);
  assert.equal(cachedFirst[NATIVE_TOOL_SCHEMA_FINGERPRINT],uncached[NATIVE_TOOL_SCHEMA_FINGERPRINT]);assert.equal(cachedSecond[NATIVE_TOOL_SCHEMA_FINGERPRINT],uncached[NATIVE_TOOL_SCHEMA_FINGERPRINT]);
  assert.equal(cache.has(tools),true);
});

test("Native request metrics can reuse unchanged canonical message serialization within one agent turn",()=>{
  const first={role:"system",content:"system"},second={role:"user",content:"request"},messages=[first,second],cache=new WeakMap();
  const uncached=nativeRequestMetrics(messages,[]),cachedFirst=nativeRequestMetrics(messages,[],{messageSerializationCache:cache}),cachedSecond=nativeRequestMetrics(messages,[],{messageSerializationCache:cache});
  assert.deepEqual(cachedFirst,uncached);assert.deepEqual(cachedSecond,uncached);assert.equal(cache.has(first),true);assert.equal(cache.has(second),true);
  const replacement={role:"user",content:"different"},next=[first,replacement],nextCached=nativeRequestMetrics(next,[],{messageSerializationCache:cache}),nextUncached=nativeRequestMetrics(next,[]);assert.deepEqual(nextCached,nextUncached);assert.equal(cache.has(replacement),true);
});

test("Native request metrics never cache custom toJSON message semantics",()=>{
  let calls=0;const tricky={role:"system",content:"source",toJSON(key){calls++;return {role:"system",content:key==="0"?"array-value":"standalone-value"}}},messages=[tricky,{role:"user",content:"request"}],cache=new WeakMap();
  const first=nativeRequestMetrics(messages,[],{messageSerializationCache:cache}),firstCalls=calls,second=nativeRequestMetrics(messages,[],{messageSerializationCache:cache});
  assert.deepEqual(second,first);assert.equal(cache.has(tricky),false);assert.ok(calls>firstCalls);
});

test("Native request metrics incrementally reuse only an unchanged history-hash prefix",()=>{
  const system={role:"system",content:"system"},oldUser={role:"user",content:"old request"},oldAssistant={role:"assistant",content:"old answer"},currentUser={role:"user",content:"current request"},messageCache=new WeakMap(),historyHashCache={};
  const firstMessages=[system,oldUser,oldAssistant,currentUser],first=nativeRequestMetrics(firstMessages,[],{messageSerializationCache:messageCache,historyHashCache}),firstUncached=nativeRequestMetrics(firstMessages,[]);assert.deepEqual(first,firstUncached);
  const appended={role:"assistant",content:"new answer"},nextMessages=[...firstMessages,appended],next=nativeRequestMetrics(nextMessages,[],{messageSerializationCache:messageCache,historyHashCache}),nextUncached=nativeRequestMetrics(nextMessages,[]);assert.deepEqual(next,nextUncached);
  const rewritten={role:"assistant",content:"rewritten old answer"},rewrittenMessages=[system,oldUser,rewritten,currentUser,appended],rewrittenCached=nativeRequestMetrics(rewrittenMessages,[],{messageSerializationCache:messageCache,historyHashCache}),rewrittenUncached=nativeRequestMetrics(rewrittenMessages,[]);assert.deepEqual(rewrittenCached,rewrittenUncached);assert.notEqual(rewrittenCached.conversationHistoryHash,next.conversationHistoryHash);
});

test("Native request metrics incrementally classify one append-only in-turn conversation",()=>{
  const system={role:"system",content:"system"},user={role:"user",content:"request"},messages=[system,user],messageCache=new WeakMap(),historyHashCache={},messageClassificationCache={};
  const cached=()=>nativeRequestMetrics(messages,[],{messageSerializationCache:messageCache,historyHashCache,messageClassificationCache});
  assert.deepEqual(cached(),nativeRequestMetrics(messages,[]));
  messages.push({role:"assistant",content:"answer"},{role:"tool",toolCallId:"call-1",content:"result"});assert.deepEqual(cached(),nativeRequestMetrics(messages,[]));
  messages.push({role:"assistant",content:"follow-up answer"});assert.deepEqual(cached(),nativeRequestMetrics(messages,[]));
  messages.push({role:"user",content:"steered request"});assert.deepEqual(cached(),nativeRequestMetrics(messages,[]));
});

test("Native request metrics can reuse the current user/context breakdown and invalidate on new provenance",()=>{
  const user=attachNativePromptProvenance({role:"user",content:"Fix it"},{userParts:[{type:"text",text:"Fix it"}],contextText:"ctx:"+"x".repeat(4000),contextEntries:[{kind:"application",value:"app"},{kind:"untrusted",value:"repo"}]}),messages=[{role:"system",content:"stable"},user],cache=new WeakMap();
  const baseline=nativeRequestMetrics(messages,[],{}),cached=nativeRequestMetrics(messages,[],{currentTurnBreakdownCache:cache});assert.deepEqual(cached,baseline);
  const second=nativeRequestMetrics(messages,[],{currentTurnBreakdownCache:cache});assert.deepEqual(second,baseline);
  attachNativePromptProvenance(user,{userParts:[{type:"text",text:"Fix it again"}],contextText:"replacement:"+"y".repeat(2000),contextEntries:[{kind:"application",value:"changed"}]});
  const refreshed=nativeRequestMetrics(messages,[],{currentTurnBreakdownCache:cache}),uncached=nativeRequestMetrics(messages,[],{});assert.deepEqual(refreshed,uncached);assert.notEqual(refreshed.workingContext.bytes,baseline.workingContext.bytes);
});

test("Native request metrics cumulative classified byte sums preserve exact array metrics",()=>{
  const messages=[{role:"system",content:"sys"},{role:"developer",content:"dev"},{role:"assistant",content:"old"},{role:"tool",toolCallId:"t1",content:"result"},{role:"user",content:"current"}],tools=[],messageSerializationCache=new WeakMap(),historyHashCache={},messageClassificationCache={};
  const baseline=nativeRequestMetrics(messages,tools,{messageSerializationCache,historyHashCache,messageClassificationCache,reuseClassifiedByteMetrics:false}),candidate=nativeRequestMetrics(messages,tools,{messageSerializationCache,historyHashCache,messageClassificationCache,reuseClassifiedByteMetrics:true});assert.deepEqual(candidate,baseline);
  messages.push({role:"assistant",content:"new"},{role:"tool",toolCallId:"t2",content:"next"});
  const grownBaseline=nativeRequestMetrics(messages,tools,{messageSerializationCache,historyHashCache,messageClassificationCache,reuseClassifiedByteMetrics:false}),grownCandidate=nativeRequestMetrics(messages,tools,{messageSerializationCache,historyHashCache,messageClassificationCache,reuseClassifiedByteMetrics:true});assert.deepEqual(grownCandidate,grownBaseline);
});

test("Native request metrics classification cache falls back when appended JSON semantics become custom",()=>{
  const messages=[{role:"system",content:"system"},{role:"user",content:"request"}],messageCache=new WeakMap(),historyHashCache={},messageClassificationCache={};
  nativeRequestMetrics(messages,[],{messageSerializationCache:messageCache,historyHashCache,messageClassificationCache});
  messages.push({role:"assistant",content:"source",toJSON(key){return {role:"assistant",content:key==="2"?"array-value":"standalone-value"}}});
  const cached=nativeRequestMetrics(messages,[],{messageSerializationCache:messageCache,historyHashCache,messageClassificationCache}),uncached=nativeRequestMetrics(messages,[]);assert.deepEqual(cached,uncached);
});

test("Native request metrics invalidate cached stable-prefix hashes when instructions change",()=>{
  const tools=[{type:"namespace",name:"trebell_workspace",tools:[{name:"read_file",description:"read",inputSchema:{type:"object",properties:{path:{type:"string"}}}}]}],cache=new WeakMap(),firstMessages=[{role:"system",content:"system-a"},{role:"developer",content:"developer-a"},{role:"user",content:"request"}],secondMessages=[{role:"system",content:"system-b"},{role:"developer",content:"developer-a"},{role:"user",content:"request"}];
  const first=nativeRequestMetrics(firstMessages,tools,{toolSchemaCache:cache}),secondCached=nativeRequestMetrics(secondMessages,tools,{toolSchemaCache:cache}),secondUncached=nativeRequestMetrics(secondMessages,tools);
  assert.deepEqual(secondCached,secondUncached);assert.notEqual(first.stablePrefixHash,secondCached.stablePrefixHash);assert.notEqual(first.systemHash,secondCached.systemHash);assert.equal(first.developerHash,secondCached.developerHash);
  assert.equal(secondCached[NATIVE_TOOL_SCHEMA_FINGERPRINT],secondUncached[NATIVE_TOOL_SCHEMA_FINGERPRINT]);
});

test("Native request metrics stream UTF-8 message buckets with exact JSON byte and hash semantics",()=>{
  const messages=[{role:"system",content:"सिस्टम 🧠"},{role:"user",content:"पुराना सवाल 🙂"},{role:"assistant",content:"答え café 🚀"},{role:"tool",toolCallId:"t1",content:"結果 ✅"},{role:"user",content:"नया सवाल 🌍"}],result=nativeRequestMetrics(messages,[]);
  const history=messages.filter((message,index)=>!["system","developer","tool"].includes(message.role)&&index!==messages.length-1),toolResults=messages.filter(message=>message.role==="tool"),messagesJson=JSON.stringify(messages),historyJson=JSON.stringify(history),toolResultsJson=JSON.stringify(toolResults);
  assert.equal(result.messages.bytes,Buffer.byteLength(messagesJson,"utf8"));assert.equal(result.conversationHistory.bytes,Buffer.byteLength(historyJson,"utf8"));assert.equal(result.toolResults.bytes,Buffer.byteLength(toolResultsJson,"utf8"));
  assert.equal(result.conversationHistoryHash,createHash("sha256").update(historyJson).digest("hex").slice(0,16));
});
