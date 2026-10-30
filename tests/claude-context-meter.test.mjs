// A Claude Code thread's context meter: the latest root request's prompt (its input and cache tokens, from the stream's message_start
// and message_delta) is the context, against the window Claude Code's own context reading gives for the model (getContextUsage,
// asked once per model), while the turn's result keeps its usage and cost as the total; a compaction leaves what it kept. The
// relay hands the context on as the last request, which the composer's meter and the auto-compaction cue read. The SDK
// is scripted: nothing runs.
import test from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ClaudeAgentSession } from "../src/claude-agent-session.mjs";
import { autoCompactionDecision } from "../ui/src/auto-compaction.js";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function session(sdk,options={}){
  const updates=[],claude=new ClaudeAgentSession({cwd:process.cwd(),sdk,onUpdate:({update})=>updates.push(update),...options});
  return Object.assign(claude,{updates});
}
const meters=claude=>claude.updates.filter(update=>update.sessionUpdate==="usage_update");
const started=(id,usage)=>({type:"stream_event",parent_tool_use_id:null,event:{type:"message_start",message:{id,usage}}});
const delta=usage=>({type:"stream_event",parent_tool_use_id:null,event:{type:"message_delta",delta:{stop_reason:"end_turn"},usage}});
const reading=(input,cacheRead,cacheWrite,output)=>({totalTokens:input+cacheRead+cacheWrite+output,inputTokens:input+cacheRead+cacheWrite,cachedInputTokens:cacheRead,cacheWriteInputTokens:cacheWrite,outputTokens:output});
// Claude Code's own context reading, as its control request answers it, by model.
const contextUsage=windows=>({getContextUsage:(options,call)=>{const window=windows[call.options.model]??windows.default;return {rawMaxTokens:window,maxTokens:window,totalTokens:20_000,percentage:10,isAutoCompactEnabled:true}}});

test("the context is the latest root request's prompt from the stream, against Claude Code's window for the model, and the result keeps the turn's total and cost",async()=>{
  const {sdk,calls}=scriptedClaudeSdk({
    init:options=>({model:options.model==="haiku"?"claude-haiku-test":"claude-test"}),
    control:contextUsage({default:200_000,haiku:100_000}),
    turn:async({message,index,emit})=>{
      if(index===0){
        // A proxy's placeholder (no input) is no reading.
        emit(started("m0",{input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0}));
        emit(started("m1",{input_tokens:1200,cache_creation_input_tokens:2800,cache_read_input_tokens:120_000,output_tokens:1}));
        // A message_delta counts its message so far: what it leaves null keeps message_start's.
        emit(delta({input_tokens:null,cache_read_input_tokens:null,output_tokens:350}));
        await tick();await tick();
        emit(started("m2",{input_tokens:400,cache_creation_input_tokens:0,cache_read_input_tokens:124_350,output_tokens:2}));
        emit(delta({output_tokens:90}));
        emit(claudeResult(message,{usage:{input_tokens:1600,cache_creation_input_tokens:2800,cache_read_input_tokens:244_350,output_tokens:440},total_cost_usd:0.25}));
        return;
      }
      // A later turn: Claude compacts in the middle of it. The request it ended is stale, so its later delta changes nothing.
      emit(started("m3",{input_tokens:100,cache_creation_input_tokens:0,cache_read_input_tokens:179_900,output_tokens:1}));
      emit({type:"system",subtype:"compact_boundary",compact_metadata:{trigger:"auto",pre_tokens:180_000,post_tokens:30_000}});
      emit(delta({output_tokens:500}));
      emit(started("m4",{input_tokens:200,cache_creation_input_tokens:31_000,cache_read_input_tokens:0,output_tokens:1}));
      emit(claudeResult(message,{usage:{input_tokens:300,cache_creation_input_tokens:31_000,cache_read_input_tokens:179_900,output_tokens:502},total_cost_usd:0.4}));
    },
  });
  const claude=session(sdk);await claude.start();
  await claude.prompt([{type:"text",text:"Summarize the repository"}]);
  let shown=meters(claude);
  assert.ok(shown.every(update=>update.context?.inputTokens!==0),"no reading of the placeholder");
  assert.ok(shown.some(update=>isDeepStrictEqual(update.context,reading(1200,120_000,2800,350))),"the delta's output joins message_start's prompt");
  const mid=shown.find(update=>isDeepStrictEqual(update.context,reading(400,124_350,0,2)));
  assert.equal(mid?.size,200_000,"the window comes from Claude Code's own reading");
  assert.deepEqual([mid.used,mid.cost],[1200+2800+120_000+350+400+124_350+2,undefined],"while the turn runs, its requests so far are the total, with no cost yet");
  const last=shown.at(-1);
  assert.deepEqual([last.used,last.size,last.cost,last.context],[1600+2800+244_350+440,200_000,{amount:0.25,currency:"USD"},reading(400,124_350,0,90)],"the result's usage and cost are the total, the last request the context");
  assert.deepEqual(calls[0].log.filter(entry=>entry[0]==="getContextUsage").map(entry=>entry[1]),[{detail:"summary"}],"asked once");

  const before=meters(claude).length;
  await claude.prompt([{type:"text",text:"Go on"}]);
  shown=meters(claude).slice(before);
  const kept=shown.findIndex(update=>update.context?.inputTokens===30_000);
  assert.ok(kept>=0,"a compaction leaves what it kept");
  assert.deepEqual(shown[kept].context,{totalTokens:30_000,inputTokens:30_000,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0});
  assert.deepEqual(shown.slice(kept+1).map(update=>update.context.inputTokens),[31_200,31_200],"the stale request's delta reads nothing; the next request does");
  assert.equal(shown.at(-1).cost.amount.toFixed(2),"0.15","the turn's own cost");
  assert.equal(calls[0].log.filter(entry=>entry[0]==="getContextUsage").length,1,"the same model is not asked again");

  // Another model runs in a process of its own, whose window Claude Code is asked for once.
  await claude.setModel("haiku");
  await claude.prompt([{type:"text",text:"Summarize the parser"}]);
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1].log.filter(entry=>entry[0]==="getContextUsage").map(entry=>entry[1]),[{detail:"summary"}]);
  await tick();
  assert.equal(meters(claude).at(-1).size,100_000,"the model's own window");
});

test("an assistant snapshot fills in a prompt the stream sent as zeros and reports a request it did not stream, but no synthetic frame",async()=>{
  const {sdk}=scriptedClaudeSdk({control:contextUsage({default:200_000}),turn:({message,emit})=>{
    emit(started("m1",{input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0}));
    emit({type:"assistant",uuid:"a1",parent_tool_use_id:null,message:{id:"m1",model:"claude-test",usage:{input_tokens:5000,cache_read_input_tokens:1000,output_tokens:20},content:[{type:"text",text:"Reading."}]}});
    // Claude Code sends no stream for this request (its partial messages are off for it).
    emit({type:"assistant",uuid:"a2",parent_tool_use_id:null,message:{id:"m2",model:"claude-test",usage:{input_tokens:7000,output_tokens:5},content:[{type:"text",text:" Done."}]}});
    emit({type:"assistant",uuid:"a3",parent_tool_use_id:null,message:{id:"m3",model:"<synthetic>",usage:{input_tokens:1,output_tokens:0},content:[{type:"text",text:"No response requested."}]}});
    // A subagent's request is its own context.
    emit({type:"assistant",uuid:"a4",parent_tool_use_id:"agent-1",message:{id:"m4",model:"claude-test",usage:{input_tokens:90_000,output_tokens:5},content:[{type:"text",text:"Sub."}]}});
    emit(claudeResult(message));
  }});
  const claude=session(sdk);await claude.start();
  await claude.prompt([{type:"text",text:"Read the notes"}]);
  const contexts=meters(claude).map(update=>update.context?.inputTokens);
  assert.deepEqual([...new Set(contexts)],[6000,7000],"the snapshot's prompt, then the unstreamed request's");
  assert.equal(meters(claude).find(update=>update.context?.inputTokens===6000).context.outputTokens,20);
});

test("a Claude Code that cannot report its context window leaves the meter at its token count",async()=>{
  const {sdk}=scriptedClaudeSdk({turn:({message,emit})=>{emit(started("m1",{input_tokens:900,output_tokens:1}));emit(claudeResult(message))}});
  const claude=session(sdk);await claude.start();
  assert.equal((await claude.prompt([{type:"text",text:"Hello"}])).stopReason,"end_turn");
  await tick();
  assert.deepEqual(meters(claude).map(update=>[update.size,update.context?.inputTokens]),[[0,900],[0,900]]);
});

// The relay with the scripted SDK, as the window's composer reads it.
const CLAUDE={id:"claude-default",kind:"claude",displayName:"Claude Code",enabled:true};
const runtimeManager={
  instances:()=>[{...CLAUDE}],activeInstance:()=>({...CLAUDE}),activeRuntime:()=>"claude",compatibleInstanceIds:()=>[CLAUDE.id],
  probe:async()=>({id:CLAUDE.id,name:"Claude Code",available:true,authenticated:true,version:"fixture"}),
  runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),executable:()=>"claude",
};
const state={settings:()=>({activeEnvironmentId:null}),threadMeta:()=>({}),updateThreadMeta:(_id,patch)=>patch};
async function startRelay(threadStore,sdk,relayState=state){
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,state:relayState,terminals:{},version:"test",claudeSdk:sdk});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  let id=0;const seen=[];
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.method)seen.push(message)});
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
  return {rpc,seen,close:async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()))}};
}

test("the relay hands Claude's context on as the last request, apart from the turn's total, so the meter and auto-compaction read it",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-claude-context-meter-"));let relay=null;
  t.after(async()=>{await relay?.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
  const {sdk}=scriptedClaudeSdk({control:contextUsage({default:200_000}),turn:({message,emit})=>{
    emit(started("m1",{input_tokens:1200,cache_creation_input_tokens:2800,cache_read_input_tokens:120_000,output_tokens:1}));
    emit({type:"assistant",uuid:"a1",parent_tool_use_id:null,message:{id:"m1",content:[{type:"text",text:"Summarized."}]}});
    emit(delta({output_tokens:30}));
    emit(claudeResult(message,{usage:{input_tokens:1200,cache_creation_input_tokens:2800,cache_read_input_tokens:120_000,output_tokens:30},total_cost_usd:0.12}));
  }});
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"home")});
  const thread=threadStore.create({runtime:"claude",cwd:root,providerSessionId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",model:"claude-test",providerMeta:{runtimeInstanceId:CLAUDE.id,permissionProfile:"supervised"}});
  relay=await startRelay(threadStore,sdk);
  const {turn}=await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Summarize the repository"}]});
  const usage=()=>relay.seen.filter(message=>message.method==="thread/tokenUsage/updated"&&message.params.turnId===turn.id).map(message=>message.params.tokenUsage);
  for(let round=0;round<400&&!(relay.seen.some(message=>message.method==="turn/completed")&&usage().at(-1)?.cost&&usage().at(-1).modelContextWindow);round++)await tick();
  const final=usage().at(-1);
  assert.equal(final.modelContextWindow,200_000);
  assert.deepEqual([final.last.inputTokens,final.last.cachedInputTokens,final.last.cacheWriteInputTokens,final.last.outputTokens],[124_000,120_000,2800,30],"the context");
  assert.deepEqual([final.total.totalTokens,final.total.inputTokens,final.total.cachedInputTokens,final.cost],[124_030,1200,120_000,{amount:0.12,currency:"USD"}],"the turn's total and cost");
  // The cue Trebell's auto-compaction setting runs on (70% at the least) reads Claude's context against its window.
  const decision=autoCompactionDecision(final,{enabled:true,thresholdPercent:70});
  assert.deepEqual([decision.reason,decision.utilizationPercent],["below-threshold",62],"the auto-compaction cue reads Claude's context");
});

// Until a turn's first request the meter still shows the turn before's tokens (and a compaction's context against them), which are not
// the new turn's: a turn that fails before a request of its own (its request failing after Claude compacted on its own, or at once
// with a cost its background agents ran up since the last result) keeps only its own cost in the Usage records, never the turn
// before's tokens or cost again.
test("a Claude turn that fails before a request of its own records only its own cost, never the turn before's tokens or cost, while the meter still shows the context",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-claude-carried-usage-"));let relay=null;
  t.after(async()=>{await relay?.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
  const compacted=kept=>({type:"system",subtype:"compact_boundary",compact_metadata:{trigger:"auto",pre_tokens:150_000,post_tokens:kept}});
  const overloaded=(message,total)=>({type:"result",subtype:"success",is_error:true,terminal_reason:"api_error",api_error_status:529,result:"API Error: 529 Overloaded",user_message_uuid:message.uuid,total_cost_usd:total,usage:{input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0}});
  const {sdk}=scriptedClaudeSdk({control:contextUsage({default:200_000}),turn:({message,index,emit})=>{
    if(index===0){
      emit(started("m1",{input_tokens:1200,cache_creation_input_tokens:2800,cache_read_input_tokens:120_000,output_tokens:1}));
      emit({type:"assistant",uuid:"a1",parent_tool_use_id:null,message:{id:"m1",content:[{type:"text",text:"Summarized."}]}});
      emit(delta({output_tokens:30}));
      return emit(claudeResult(message,{usage:{input_tokens:1200,cache_creation_input_tokens:2800,cache_read_input_tokens:120_000,output_tokens:30},total_cost_usd:0.12}));
    }
    // Claude compacts on its own as the turn starts, and the request after it fails: the compaction's cost is the turn's own.
    if(index===1){emit({type:"system",subtype:"status",status:"compacting"});emit({type:"system",subtype:"status",status:null,compact_result:"success"});emit(compacted(30_000));return emit(overloaded(message,0.15))}
    // It fails at once, with what background agents spent since the last result.
    if(index===2)return emit(overloaded(message,0.18));
    // It compacts and fails with nothing of its own.
    emit(compacted(28_000));emit(overloaded(message,0.18));
  }});
  const records=[],relayState={...state,recordUsage:entry=>records.push(entry)};
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"home")});
  const thread=threadStore.create({runtime:"claude",cwd:root,providerSessionId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",model:"claude-test",providerMeta:{runtimeInstanceId:CLAUDE.id,permissionProfile:"supervised"}});
  relay=await startRelay(threadStore,sdk,relayState);
  const turns=[];
  for(const text of ["Summarize the repository","Go on","Go on again","Once more"]){
    const {turn}=await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text}]});turns.push(turn.id);
    for(let round=0;round<400&&!relay.seen.some(message=>message.method==="turn/completed"&&message.params.turn?.id===turn.id);round++)await tick();
    assert.ok(relay.seen.some(message=>message.method==="turn/completed"&&message.params.turn?.id===turn.id),`turn ${turns.length} ended`);
  }
  const recorded=id=>records.filter(entry=>entry.turnId===id).map(entry=>[entry.usage.totalTokens,entry.cost?Number(entry.cost.amount.toFixed(2)):null]);
  assert.deepEqual(recorded(turns[0]),[[124_030,0.12]],"the first turn's own usage");
  assert.deepEqual(recorded(turns[1]),[[0,0.03]],"the compaction's cost, and none of the first turn's tokens or cost");
  assert.deepEqual(recorded(turns[2]),[[0,0.03]],"its own cost only");
  assert.deepEqual(recorded(turns[3]),[],"nothing of its own to record");
  // The meter goes on showing the context the compaction kept against the window, with the earlier turn's tokens as its total.
  const shown=relay.seen.filter(message=>message.method==="thread/tokenUsage/updated"&&message.params.turnId===turns[1]).map(message=>message.params.tokenUsage);
  const kept=shown.find(usage=>usage.last.inputTokens===30_000);
  assert.ok(kept&&kept.total.totalTokens>0&&kept.modelContextWindow===200_000,"the composer's meter still reads 15% after the compaction");
});
