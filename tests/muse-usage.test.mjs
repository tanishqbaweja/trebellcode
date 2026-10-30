import test from "node:test";
import assert from "node:assert/strict";
import * as muse from "../src/muse-agent-session.mjs";
import { FakeMuse, INIT, ReplayMuse, event, startSession, until } from "./fixtures/muse/fake-host.mjs";
import { museRelay } from "./fixtures/muse/relay-harness.mjs";

// Muse Code's token usage and context meter (Muse's cache counters are subsets of input, reasoning of output): each model step's
// tokens added up over the turn as Trebell keeps
// OpenAI-style usage, the context Muse holds of its window, the turn's totals at its end, and the last usage/changed kept for the
// Usage page.

const usageUpdates=updates=>updates.filter(update=>update.sessionUpdate==="usage_update");
async function runningTurn(fixture){
  const running=fixture.session.prompt([{type:"text",text:"go"}]);
  const {params:{commandId:turnId}}=await fixture.muse.next("turn/start");
  return {running,turnId,sid:fixture.session.sessionId};
}
const step=(sid,turnId,{prompt,output,cacheRead=0,cacheWrite=0,reasoning=0})=>event("session/tokenUsage",sid,{turnId,modelId:"muse-spark-1.3",promptTokens:prompt,totalTokens:prompt+output,
  usage:{inputTokens:prompt,outputTokens:output,cachedTokens:cacheRead,cacheReadTokens:cacheRead,cacheWriteTokens:cacheWrite,reasoningTokens:reasoning},cumulative:{promptTokens:prompt,outputTokens:output,totalTokens:prompt+output,cost:{usd:0.0033,partial:false}},sourceRange:{}});
const contextUsage=(sid,usedTokens,windowTokens=1048576)=>event("session/contextUsage",sid,{usedTokens,windowTokens,pressure:"normal",sourceRange:{}});

test("a turn's tokens add up over its model steps as Trebell keeps OpenAI-style usage, with the context Muse holds of its window, and turn/completed's totals end it",async()=>{
  const fixture=await startSession(),{updates}=fixture,{running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.write(step(sid,turnId,{prompt:1000,output:100,cacheWrite:30,reasoning:40}));
  fixture.muse.write(contextUsage(sid,1100));
  fixture.muse.write(step(sid,turnId,{prompt:1200,output:50,cacheRead:900,reasoning:10}));
  fixture.muse.write(contextUsage(sid,1250));
  await until(()=>usageUpdates(updates).length===4,"the usage of both steps");
  assert.deepEqual(usageUpdates(updates).map(({usage,used,size,contextTokens})=>({usage,used,size,contextTokens})),[
    {usage:{input_tokens:1000,output_tokens:100,cache_read_input_tokens:0,cache_write_input_tokens:30,reasoning_tokens:40},used:1100,size:0,contextTokens:undefined},
    {usage:{input_tokens:1000,output_tokens:100,cache_read_input_tokens:0,cache_write_input_tokens:30,reasoning_tokens:40},used:1100,size:1048576,contextTokens:1100},
    {usage:{input_tokens:2200,output_tokens:150,cache_read_input_tokens:900,cache_write_input_tokens:30,reasoning_tokens:50},used:2350,size:1048576,contextTokens:1100},
    {usage:{input_tokens:2200,output_tokens:150,cache_read_input_tokens:900,cache_write_input_tokens:30,reasoning_tokens:50},used:2350,size:1048576,contextTokens:1250},
  ]);
  // The turn's totals: its steps' counted-once prompt tokens as input, and turn/completed's output, cache and reasoning counts.
  fixture.muse.notify("turn/completed",{sessionId:sid,viewCursor:"v",terminal:"completed",turnId,usage:{inputTokens:2100,outputTokens:160,cachedTokens:900,cacheReadTokens:900,cacheWriteTokens:30,reasoningTokens:55}});
  const result=await running;
  assert.deepEqual(result.raw.usage,{inputTokens:2200,cachedInputTokens:900,cacheWriteInputTokens:30,outputTokens:160,reasoningOutputTokens:55,totalTokens:2360});
  assert.deepEqual(usageUpdates(updates).at(-1).usage,{input_tokens:2200,output_tokens:160,cache_read_input_tokens:900,cache_write_input_tokens:30,reasoning_tokens:55});
  assert.equal(usageUpdates(updates).at(-1).cost,undefined,"Muse's own cost estimate is not kept");
  await fixture.session.close();
});

test("the recorded subagent turn: its three model steps add up to the turn's tokens, each step's usage reaching the relay as it comes, then the turn's total",async()=>{
  const fixture=await startSession({muse:child=>new ReplayMuse(child,"subagent"),permissionMode:"full"});
  const result=await fixture.session.prompt([{type:"text",text:"Start one greeter subagent that answers Hi."}]);
  assert.deepEqual(result.raw.usage,{inputTokens:3617,cachedInputTokens:600,cacheWriteInputTokens:0,outputTokens:107,reasoningOutputTokens:15,totalTokens:3724});
  assert.deepEqual(usageUpdates(fixture.updates).map(update=>update.used),[1234,2476,3724,3724],"the turn so far after each step, then its total");
  await fixture.session.close();
});

test("a turn Muse reports only turn/completed's totals for ends with them, a turn with no usage gives the relay none, and Muse's raw counters never reach it as Trebell's",async()=>{
  const fixture=await startSession(),first=await runningTurn(fixture);
  fixture.muse.notify("turn/completed",{sessionId:first.sid,viewCursor:"v",terminal:"completed",turnId:first.turnId,usage:{inputTokens:500,outputTokens:20,cachedTokens:400,reasoningTokens:5}});
  assert.deepEqual((await first.running).raw.usage,{inputTokens:500,cachedInputTokens:400,cacheWriteInputTokens:0,outputTokens:20,reasoningOutputTokens:5,totalTokens:520});
  const second=await runningTurn(fixture);
  fixture.muse.notify("turn/completed",{sessionId:second.sid,viewCursor:"v",terminal:"completed",turnId:second.turnId});
  const result=await second.running;
  assert.equal("usage" in result.raw,false);
  // A step Trebell cannot read is skipped with a log line, and the turn goes on.
  const third=await runningTurn(fixture);
  fixture.muse.write(event("session/tokenUsage",third.sid,{turnId:third.turnId,usage:{outputTokens:"many"}}));
  fixture.muse.notify("turn/completed",{sessionId:third.sid,viewCursor:"v",terminal:"completed",turnId:third.turnId});
  assert.equal((await third.running).stopReason,"end_turn");
  assert.ok(fixture.updates.some(update=>update.sessionUpdate==="protocol_warning"&&update.method==="session/tokenUsage"&&update.dropped===true));
  await fixture.session.close();
});

test("a failed turn's tokens so far reach the relay before it fails, so the turn's usage is kept",async()=>{
  const fixture=await startSession(),{running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.write(step(sid,turnId,{prompt:800,output:40}));
  fixture.muse.notify("turn/completed",{sessionId:sid,viewCursor:"v",terminal:"failed",turnId,error:{kind:"modelError",message:"the model stream broke"},usage:{inputTokens:800,outputTokens:60,cachedTokens:0,reasoningTokens:0}});
  await assert.rejects(running,error=>{assert.deepEqual(error.raw.usage,{inputTokens:800,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:60,reasoningOutputTokens:0,totalTokens:860});return true});
  assert.deepEqual(usageUpdates(fixture.updates).at(-1).usage,{input_tokens:800,output_tokens:60,cache_read_input_tokens:0,cache_write_input_tokens:0,reasoning_tokens:0});
  await fixture.session.close();
});

test("Muse's usage report (usage/changed, the account's) is kept by the Muse home it came from for the Usage page, the newest of any without a home",async()=>{
  const report={observedAtMs:1791762448802,tier:"everyday",window:{usedPercent:112.5,windowDurationMins:300,resetsAtMs:1791780000000},weekly:{usedPercent:40,resetsAtMs:1792300000000}};
  const fixture=await startSession({muse:child=>new FakeMuse(child,{handlers:{initialize:()=>({...INIT,museHome:"H:\\homes\\work\\.local\\share\\muse"})}})});
  fixture.muse.notify("usage/changed",report);
  await until(()=>muse.latestMuseSubscriptionUsage?.({museHome:"H:\\homes\\work\\.local\\share\\muse"}),"the kept report");
  assert.deepEqual(muse.latestMuseSubscriptionUsage({museHome:"H:\\homes\\work\\.local\\share\\muse"}),report);
  // A report observed now, which any later one supersedes (the store is the process's: other tests in it read it too).
  muse.rememberMuseSubscriptionUsage({...report,observedAtMs:Date.now()+1,tier:"high"},{museHome:"elsewhere"});
  assert.equal(muse.latestMuseSubscriptionUsage().tier,"high","the newest report of any home");
  assert.equal(muse.latestMuseSubscriptionUsage({museHome:"nowhere"}),null,"none observed yet");
  await fixture.session.close();
});

test("through the relay, a Muse turn's tokens reach the thread's context meter (the context Muse holds of its window as the last request's input, the turn's totals beside it) and the turn's usage record",{timeout:120_000},async()=>{
  const relay=await museRelay("trebell-muse-usage-");
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please spawn subagent and keep a todo list"}]});
    await relay.completed(thread.id,1);
    const meter=relay.notifications.filter(item=>item.method==="thread/tokenUsage/updated"&&item.params.threadId===thread.id).at(-1).params.tokenUsage;
    assert.equal(meter.modelContextWindow,1048576);
    assert.deepEqual(meter.last,{totalTokens:30528,inputTokens:30528,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0});
    assert.deepEqual(meter.total,{totalTokens:60788,inputTokens:60530,cachedInputTokens:29880,cacheWriteInputTokens:0,outputTokens:258,reasoningOutputTokens:49});
    const [record]=relay.usage;
    assert.deepEqual([record.runtime,record.threadId,record.cost],["muse",thread.id,null]);
    assert.deepEqual(record.usage,{totalTokens:60788,inputTokens:60530,cachedInputTokens:29880,cacheWriteInputTokens:0,outputTokens:258,reasoningOutputTokens:49});
  }finally{await relay.close()}
});
