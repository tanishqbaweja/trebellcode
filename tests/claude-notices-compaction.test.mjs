// Claude Code's own notices and failed compactions: a warning such as a hook's reason for dropping the prompt, and a switch to the
// fallback model after a refusal, show once as a finished row of the turn, never again as its answer, and a
// compaction that failed fails Compact with Claude Code's reason, which the session's status carries too, instead of reading as
// compacted, as a /compact sent as a message fails once the usage limit stopped it. The SDK is scripted: nothing
// runs.
import test from "node:test";
import assert from "node:assert/strict";
import * as claudeSession from "../src/claude-agent-session.mjs";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const {ClaudeAgentSession}=claudeSession;
const CLAUDE_COMPACT_FAILED="Claude Code could not compact its context.";
const HOOK_REASON="Blocked by the freeze-guard hook: no releases while the audit runs.";
const FALLBACK_NOTE="claude-opus-test turned the request down; claude-sonnet-test answered it instead.";
const TOO_SHORT="Nothing to compact yet: the conversation is too short.";
const LIMIT_STOPPED="Compaction stopped: the 5-hour usage limit was reached (resets 07:05, America/Chicago).";
const LIMIT_WITH_WAIT=/^Claude Code has used up its five-hour allowance\. Try the message again when it resets, in 1 h (?:29|30) min\.$/;

function session(sdk){
  const updates=[],claude=new ClaudeAgentSession({cwd:process.cwd(),sdk,onUpdate:({update})=>updates.push(update)});
  return Object.assign(claude,{updates});
}
const text=claude=>claude.updates.filter(update=>update.sessionUpdate==="agent_message_chunk").map(update=>update.content.text).join("");
const notices=claude=>claude.updates.filter(update=>update.sessionUpdate==="tool_call"&&String(update.toolCallId).startsWith("claude-notice:"));
const reply=(id,words)=>({type:"assistant",uuid:"a-"+id,parent_tool_use_id:null,message:{id:"m-"+id,content:[{type:"text",text:words}]}});
const systemFrame=(subtype,fields)=>({type:"system",subtype,...fields,session_id:"s"});
const ask=(claude,words)=>claude.prompt([{type:"text",text:words}]);

test("a hook's reason for dropping the prompt shows once as a finished row and not as the answer, and an info line does not show",async()=>{
  const {sdk}=scriptedClaudeSdk({turn:({message,index,emit})=>{
    if(index===0){
      emit(systemFrame("informational",{content:"Background bash task b7 is still running",level:"info",uuid:"info-1"}));
      // Claude Code's own terminal escapes (bold red, then a reset) and its wrapping are not part of the reason.
      emit(systemFrame("informational",{content:`\u001b[1;31m${HOOK_REASON}\u001b[0m`,level:"warning",prevent_continuation:true,uuid:"warning-1"}));
      emit(claudeResult(message,{result:HOOK_REASON.replace(" no releases","\n   no releases")+"\n",num_turns:0}));return;
    }
    // A refused request answered on the fallback model says so, and the answer still shows.
    emit(systemFrame("model_refusal_fallback",{trigger:"refusal",direction:"retry",scope:"session",original_model:"claude-opus-test",fallback_model:"claude-sonnet-test",request_id:null,content:FALLBACK_NOTE,uuid:"fallback-1"}));
    emit(reply("r1","The release plan has four steps."));
    emit(claudeResult(message,{result:"The release plan has four steps."}));
  }});
  const claude=session(sdk);await claude.start();
  assert.equal((await ask(claude,"Cut the 2.4 release")).stopReason,"end_turn");
  assert.deepEqual(notices(claude).map(update=>[update.toolCallId,update.title,update.status,update.kind]),[["claude-notice:warning-1",HOOK_REASON,"completed","other"]]);
  assert.equal(text(claude),"","the reason is not the answer too");
  await ask(claude,"Draft the release plan");
  assert.deepEqual(notices(claude).slice(1).map(update=>update.title),[FALLBACK_NOTE]);
  assert.equal(text(claude),"The release plan has four steps.");
});

test("Compact whose compaction failed rejects with Claude Code's reason, which the session's status carries, and one that worked resolves",async()=>{
  const resetsAt=Math.floor(Date.now()/1000)+90*60;
  // What each turn's compaction does, in the order the turns come; a turn past the list compacts on its own and goes on.
  const script=[
    {result:"failed",error:TOO_SHORT},
    // The usage limit stops the compaction with no reason of its own: the limit's is the turn's.
    {result:"failed",limited:true},
    {result:"failed"},
    {result:"success"},
    // A /compact sent as the message: the status says why its compaction failed, and only the usage limit fails the turn.
    {result:"failed",error:TOO_SHORT},
    {result:"failed",error:LIMIT_STOPPED,limited:true},
  ];
  const {sdk}=scriptedClaudeSdk({turn:({message,index,emit})=>{
    const compacting=systemFrame("status",{status:"compacting",uuid:"status-"+index});
    const step=script[index];
    if(!step){
      // A turn whose own automatic compaction failed goes on and ends as Claude Code ends it.
      emit(compacting);emit(systemFrame("status",{status:null,compact_result:"failed",compact_error:"The summary request timed out."}));
      emit(reply("r"+index,"Still working on the audit."));emit(claudeResult(message,{result:"Still working on the audit."}));return;
    }
    if(step.limited)emit({type:"rate_limit_event",rate_limit_info:{status:"rejected",rateLimitType:"five_hour",resetsAt},session_id:"s"});
    emit(compacting);
    emit(systemFrame("status",{status:null,compact_result:step.result,...(step.error?{compact_error:step.error}:{})}));
    if(step.result==="success")emit(systemFrame("compact_boundary",{compact_metadata:{trigger:"manual",pre_tokens:84_000,post_tokens:9_500}}));
    // Claude Code ends a /compact with a success result that names the command, also when the compaction failed.
    emit(claudeResult(message,{result:"",local_command:"compact"}));
  }});
  const claude=session(sdk);await claude.start();
  await assert.rejects(()=>claude.compact(),error=>error.message===TOO_SHORT);
  const statuses=()=>claude.updates.filter(update=>update.sessionUpdate==="session_info_update"&&update.compactResult).map(update=>[update.compactResult,update.compactError]);
  assert.deepEqual(statuses(),[["failed",TOO_SHORT]],"the status says why, for the window's row");
  await assert.rejects(()=>claude.compact(),error=>LIMIT_WITH_WAIT.test(error.message));
  await assert.rejects(()=>claude.compact(),error=>error.message===CLAUDE_COMPACT_FAILED,"one that says no reason");
  assert.equal((await claude.compact()).stopReason,"end_turn","a compaction that worked");
  assert.equal((await ask(claude,"/compact")).stopReason,"end_turn");
  assert.deepEqual(statuses().at(-1),["failed",TOO_SHORT]);
  await assert.rejects(()=>ask(claude,"/compact"),error=>error.message===LIMIT_STOPPED);
  assert.equal(claudeSession.CLAUDE_COMPACT_FAILED,CLAUDE_COMPACT_FAILED);
  assert.equal((await ask(claude,"Carry on")).stopReason,"end_turn");
  assert.equal(text(claude),"Still working on the audit.");
});
