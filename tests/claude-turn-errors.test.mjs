// Claude Code turn errors that say what happened: a full context is not a usage limit, an API failure keeps the API's own words, and a
// quick retry into a usage limit still says when it resets (T3 Code's fb9af9e57, 55a8fe9a9 and 9957790c9). Git text shares them.
import test from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_USAGE_LIMIT_HINT, ClaudeAgentSession, claudeResultFailure } from "../src/claude-agent-session.mjs";
import { generateTextWithHarness } from "../src/harness-text-generation.mjs";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const CONTEXT_FULL="Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.";
const failed=(terminal_reason,extra={})=>({type:"result",subtype:"success",is_error:true,terminal_reason,result:"",...extra});
// The reset of a rejected five-hour window 90 minutes from now; the wait reads 1h 30m, or 1h 29m once a minute has turned.
const resetsAt=()=>Math.floor(Date.now()/1000)+90*60;
const WAIT=/in 1h (?:29|30)m\.$/;

test("a blocking limit reads as a full context unless rate-limit evidence makes it a usage limit, and a long prompt says what to do",()=>{
  assert.equal(claudeResultFailure(failed("blocking_limit",{result:"Prompt is too long"})),CONTEXT_FULL);
  assert.equal(claudeResultFailure(failed("blocking_limit"),{failureHint:CLAUDE_USAGE_LIMIT_HINT}),CLAUDE_USAGE_LIMIT_HINT);
  assert.equal(claudeResultFailure(failed("prompt_too_long",{result:"API Error: 400 Request rejected."})),CONTEXT_FULL);
});

test("an API failure keeps the API's own words, secrets redacted and cut to 500 characters, unless something names it better",()=>{
  assert.equal(claudeResultFailure(failed("api_error",{api_error_status:500,result:'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'})),
    'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}');
  assert.equal(claudeResultFailure(failed("api_error",{is_error:false,api_error_status:400,result:"  API Error: 400 Request rejected by a safeguard.\n"})),"API Error: 400 Request rejected by a safeguard.");
  const leaked=failed("api_error",{api_error_status:400,result:`API Error: 400 ${"x".repeat(440)} Bearer ${"s".repeat(100)} ${"y".repeat(100)}`});
  assert.equal(claudeResultFailure(leaked),`API Error: 400 ${"x".repeat(440)} Bearer [redacted] ${"y".repeat(26)}`,"the token is gone before the cut");
  assert.equal(claudeResultFailure(failed("api_error",{api_error_status:500,result:"I found three files."})),"Claude gave up after repeated API errors.","an ordinary reply is not an API error");
  assert.equal(claudeResultFailure(failed("api_error",{api_error_status:400,result:"API Error: 400 Request rejected.",errors:["[ede_diagnostic] internal detail","Tool execution failed: EACCES"]})),"Tool execution failed: EACCES");
  assert.equal(claudeResultFailure(failed("api_error",{api_error_status:529,result:"API Error: 529 Overloaded."})),"Claude API is overloaded (529). Try again shortly.");
  assert.equal(claudeResultFailure(failed("api_error",{api_error_status:429,result:"API Error: 429 Rate limited."})),"Claude API rate limit reached. Try again later.");
  assert.equal(claudeResultFailure(failed("api_error",{api_error_status:500,result:"API Error: 500"}),{failureHint:CLAUDE_USAGE_LIMIT_HINT}),CLAUDE_USAGE_LIMIT_HINT);
});

// One Claude Code turn whose CLI messages are frames (each a function of the prompt's message); resolves with the session's outcome.
async function claudeTurn(frames){
  const {sdk}=scriptedClaudeSdk({turn:({message,emit})=>{for(const frame of frames)emit(typeof frame==="function"?frame(message):frame)}});
  const updates=[],session=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:params=>updates.push(params.update)});
  await session.start();
  const error=await session.prompt([{type:"text",text:"go"}]).then(()=>null,failure=>failure);
  await session.close();
  return {error,notices:updates.filter(update=>update.sessionUpdate==="tool_call"&&String(update.toolCallId).startsWith("usage-limit:")).map(update=>update.title)};
}
const blockedReply=(info,extra={})=>({type:"assistant",uuid:"blocked",parent_tool_use_id:null,error:"rate_limit",api_error_params:{rate_limit_info:info},message:{id:"m-blocked",content:[{type:"text",text:"API Error: Rate limited"}]},...extra});

test("a Claude turn that fills its context says so, and one a usage window blocked says when it resets",async()=>{
  const full=await claudeTurn([message=>failed("blocking_limit",{result:"Prompt is too long",user_message_uuid:message.uuid})]);
  assert.equal(full.error?.message,CONTEXT_FULL);assert.deepEqual(full.notices,[]);
  const at=resetsAt();
  const limited=await claudeTurn([{type:"rate_limit_event",rate_limit_info:{status:"rejected",rateLimitType:"five_hour",resetsAt:at}},message=>failed("blocking_limit",{user_message_uuid:message.uuid})]);
  assert.match(limited.error?.message||"",/^Claude usage limit reached\. Send the message again once the 5-hour limit resets in 1h (?:29|30)m\.$/);
  assert.equal(limited.notices.length,1);assert.match(limited.notices[0],WAIT);
});

test("a quick retry into a usage limit still says when it resets, from the window the blocked reply repeats",async()=>{
  const at=resetsAt(),info={status:"rejected",rateLimitType:"five_hour",resetsAt:at};
  // No rate_limit_event: Claude Code throttles an unchanged one, and only the blocked reply carries the window.
  const retried=await claudeTurn([blockedReply(info),message=>failed("api_error",{api_error_status:429,result:"API Error: Rate limited",user_message_uuid:message.uuid})]);
  assert.deepEqual(retried.notices.length,1,"the usage-limit notice comes back");
  assert.match(retried.notices[0],/^Claude usage limit reached\. This turn is paused until the 5-hour limit resets in 1h (?:29|30)m\.$/);
  assert.equal(retried.error?.message,"Claude API rate limit reached. Try again later.");
  const unstated=await claudeTurn([blockedReply(info),message=>failed("api_error",{result:"API Error: Rate limited",user_message_uuid:message.uuid})]);
  assert.match(unstated.error?.message||"",/^Claude usage limit reached\. Send the message again once the 5-hour limit resets in 1h (?:29|30)m\.$/,"the turn's error carries the wait too");
  // An allowed overage takes over the window: nothing is paused.
  const overage=await claudeTurn([blockedReply({...info,overageStatus:"allowed"}),message=>failed("api_error",{api_error_status:500,result:"API Error: 500 Internal error",user_message_uuid:message.uuid})]);
  assert.deepEqual(overage.notices,[]);assert.equal(overage.error?.message,"API Error: 500 Internal error");
});

// Git text through Claude Code: the same evidence names the same failure.
function claudeRuntimeManager(){
  return {
    definitions:()=>[{id:"claude",name:"Claude Code",protocol:"claude"}],activeInstance:()=>({id:"claude-default",kind:"claude"}),
    probe:async()=>({available:true}),executable:()=>"fixture-cli",childEnv:()=>({}),processSpawner:()=>null,remoteIo:()=>null,runtimeCwd:cwd=>cwd,
  };
}
const gitText=frames=>generateTextWithHarness({runtimeManager:claudeRuntimeManager(),prompt:"PROMPT",deps:{claudeQuery:()=>(async function*(){yield* frames})()}}).then(()=>null,error=>error.message);

test("Git text through Claude Code names a full context, a usage limit with its wait and the API's own error as a thread does",async()=>{
  const prefix="Claude Code could not write the Git text: ";
  assert.equal(await gitText([failed("blocking_limit",{result:"Prompt is too long"})]),prefix+CONTEXT_FULL);
  const info={status:"rejected",rateLimitType:"five_hour",resetsAt:resetsAt()};
  assert.match(await gitText([blockedReply(info),failed("blocking_limit")]),/^Claude Code could not write the Git text: Claude usage limit reached\. Send the message again once the 5-hour limit resets in 1h (?:29|30)m\.$/);
  assert.equal(await gitText([{type:"assistant",error:"server_error",message:{content:[{type:"text",text:"API Error: 500"}]}},failed("api_error",{api_error_status:500,result:"API Error: 500 Internal server error"})]),prefix+"API Error: 500 Internal server error");
});

test("a turn Claude Code answers keeps its reply, whatever the window said earlier",async()=>{
  const {sdk}=scriptedClaudeSdk({turn:({message,emit})=>{
    emit({type:"rate_limit_event",rate_limit_info:{status:"allowed_warning",rateLimitType:"five_hour",resetsAt:resetsAt()}});
    emit({type:"assistant",uuid:"a-1",parent_tool_use_id:null,message:{id:"m-1",content:[{type:"text",text:"Done."}]}});
    emit(claudeResult(message,{result:"Done."}));
  }});
  const session=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:()=>{}});await session.start();
  assert.equal((await session.prompt([{type:"text",text:"go"}])).stopReason,"end_turn");
  await session.close();
});
