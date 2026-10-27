// Claude Code's own notices and failed compactions: a warning such as a hook's reason for dropping the prompt, and a switch to the
// fallback model after a refusal, show once as a finished row of the turn, never again as its answer (T3 Code's e51c0d677), and a
// compaction that failed fails Compact with Claude Code's reason, which the session's status carries too, instead of reading as
// compacted, as a /compact sent as a message fails once the usage limit stopped it (T3 Code's 499c9ee68). The SDK is scripted: nothing
// runs.
import test from "node:test";
import assert from "node:assert/strict";
import * as claudeSession from "../src/claude-agent-session.mjs";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const {ClaudeAgentSession}=claudeSession;
const CLAUDE_COMPACT_FAILED="Claude Code could not compact its context.";

function session(sdk){
  const updates=[],claude=new ClaudeAgentSession({cwd:process.cwd(),sdk,onUpdate:({update})=>updates.push(update)});
  return Object.assign(claude,{updates});
}
const text=claude=>claude.updates.filter(update=>update.sessionUpdate==="agent_message_chunk").map(update=>update.content.text).join("");
const notices=claude=>claude.updates.filter(update=>update.sessionUpdate==="tool_call"&&String(update.toolCallId).startsWith("claude-notice:"));
const reply=(id,words)=>({type:"assistant",uuid:"a-"+id,parent_tool_use_id:null,message:{id:"m-"+id,content:[{type:"text",text:words}]}});

test("a hook's reason for dropping the prompt shows once as a finished row and not as the answer, and an info line does not show",async()=>{
  const reason="Prompt dropped by a hook: Deploys are frozen until Monday.";
  const {sdk}=scriptedClaudeSdk({turn:({message,index,emit})=>{
    if(index===0){
      emit({type:"system",subtype:"informational",content:"Started in the background: agent-1",level:"info",uuid:"info-1",session_id:"s"});
      // Claude Code's own terminal escapes and wrapping are not part of the reason.
      emit({type:"system",subtype:"informational",content:"\u001b[33m"+reason+"\u001b[39m",level:"warning",prevent_continuation:true,uuid:"warning-1",session_id:"s"});
      emit(claudeResult(message,{result:reason.replace("hook: ","hook:\n"),num_turns:0}));return;
    }
    // A refused request answered on the fallback model says so, and the answer still shows.
    emit({type:"system",subtype:"model_refusal_fallback",trigger:"refusal",direction:"retry",scope:"session",original_model:"claude-opus-test",fallback_model:"claude-sonnet-test",request_id:null,content:"Claude Opus declined this request, so Claude Sonnet answered it.",uuid:"fallback-1",session_id:"s"});
    emit(reply("r1","Here is the deploy plan."));
    emit(claudeResult(message,{result:"Here is the deploy plan."}));
  }});
  const claude=session(sdk);await claude.start();
  assert.equal((await claude.prompt([{type:"text",text:"Deploy to production"}])).stopReason,"end_turn");
  assert.deepEqual(notices(claude).map(update=>[update.toolCallId,update.title,update.status,update.kind]),[["claude-notice:warning-1",reason,"completed","other"]]);
  assert.equal(text(claude),"","the reason is not the answer too");
  await claude.prompt([{type:"text",text:"Plan the deploy"}]);
  assert.deepEqual(notices(claude).slice(1).map(update=>update.title),["Claude Opus declined this request, so Claude Sonnet answered it."]);
  assert.equal(text(claude),"Here is the deploy plan.");
});

test("Compact whose compaction failed rejects with Claude Code's reason, which the session's status carries, and one that worked resolves",async()=>{
  const resetsAt=Math.floor(Date.now()/1000)+90*60,limitError="Error during compaction: You've hit your session limit · resets 5:20pm (Europe/Berlin).";
  const {sdk}=scriptedClaudeSdk({turn:({message,index,emit})=>{
    const compacting={type:"system",subtype:"status",status:"compacting",uuid:"status-"+index,session_id:"s"};
    // Claude Code ends a /compact with a success result that names the command, also when the compaction failed.
    const compacted=(result,extra={})=>{emit(compacting);emit({type:"system",subtype:"status",status:null,compact_result:result,...extra,session_id:"s"});if(result==="success")emit({type:"system",subtype:"compact_boundary",compact_metadata:{trigger:"manual",pre_tokens:90_000,post_tokens:12_000},session_id:"s"});emit(claudeResult(message,{result:"",local_command:"compact"}))};
    const limited=()=>emit({type:"rate_limit_event",rate_limit_info:{status:"rejected",rateLimitType:"five_hour",resetsAt},session_id:"s"});
    if(index===0)return compacted("failed",{compact_error:"Not enough messages to compact."});
    // The usage limit stops the compaction with no reason of its own: the limit's is the turn's.
    if(index===1){limited();return compacted("failed")}
    if(index===2)return compacted("failed");
    if(index===3)return compacted("success");
    // A /compact sent as the message: the status says why its compaction failed, and only the usage limit fails the turn.
    if(index===4)return compacted("failed",{compact_error:"Not enough messages to compact."});
    if(index===5){limited();return compacted("failed",{compact_error:limitError})}
    // A turn whose own automatic compaction failed goes on and ends as Claude Code ends it.
    emit(compacting);emit({type:"system",subtype:"status",status:null,compact_result:"failed",compact_error:"Conversation too long to summarize.",session_id:"s"});
    emit(reply("r"+index,"Still here."));emit(claudeResult(message,{result:"Still here."}));
  }});
  const claude=session(sdk);await claude.start();
  await assert.rejects(()=>claude.compact(),error=>error.message==="Not enough messages to compact.");
  const statuses=()=>claude.updates.filter(update=>update.sessionUpdate==="session_info_update"&&update.compactResult).map(update=>[update.compactResult,update.compactError]);
  assert.deepEqual(statuses(),[["failed","Not enough messages to compact."]],"the status says why, for the window's row");
  await assert.rejects(()=>claude.compact(),error=>/^Claude usage limit reached\. Send the message again once the 5-hour limit resets in 1h (?:29|30)m\.$/.test(error.message));
  await assert.rejects(()=>claude.compact(),error=>error.message===CLAUDE_COMPACT_FAILED,"one that says no reason");
  assert.equal((await claude.compact()).stopReason,"end_turn","a compaction that worked");
  assert.equal((await claude.prompt([{type:"text",text:"/compact"}])).stopReason,"end_turn");
  assert.deepEqual(statuses().at(-1),["failed","Not enough messages to compact."]);
  await assert.rejects(()=>claude.prompt([{type:"text",text:"/compact"}]),error=>error.message===limitError);
  assert.equal(claudeSession.CLAUDE_COMPACT_FAILED,CLAUDE_COMPACT_FAILED);
  assert.equal((await claude.prompt([{type:"text",text:"Keep going"}])).stopReason,"end_turn");
  assert.equal(text(claude),"Still here.");
});
