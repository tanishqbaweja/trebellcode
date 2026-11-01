// Claude Code turn errors that say what happened: a full context is not a usage limit, an API failure keeps the API's own words, and a
// quick retry into a usage limit still says when it resets. Git text shares them.
import test from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_USAGE_LIMIT_HINT, ClaudeAgentSession, claudeResultFailure } from "../src/claude-agent-session.mjs";
import { generateTextWithHarness } from "../src/harness-text-generation.mjs";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const CONTEXT_FULL="Claude Code ended the turn: this thread has grown past the model's context window. Compact it with /compact, or continue in a new thread.";
const API_KEPT_FAILING="Claude Code ended the turn after its requests to the Claude API failed again and again.";
const OVERLOADED="The Claude API is overloaded right now (HTTP 529). Wait a moment, then send the message again.";
const RATE_LIMITED="The Claude API is limiting how fast requests come in (HTTP 429). Wait a little, then send the message again.";
const failed=(terminal_reason,extra={})=>({type:"result",subtype:"success",is_error:true,terminal_reason,result:"",...extra});
// A turn the API ended: its HTTP status and the result's text.
const apiFailed=(status,text,extra={})=>failed("api_error",{...(status==null?{}:{api_error_status:status}),result:text,...extra});
// The reset of a rejected five-hour window 90 minutes from now; the wait reads 1 h 30 min, or 1 h 29 min once a minute has turned.
const resetsAt=()=>Math.floor(Date.now()/1000)+90*60;
const WAIT=/in 1 h (?:29|30) min\.$/;
const LIMIT_WITH_WAIT=/^Claude Code has used up its five-hour allowance\. Try the message again when it resets, in 1 h (?:29|30) min\.$/;
// Claude Code's own reply text once the context window is full; Trebell never reads it.
const TOO_LONG="Prompt is too long";

test("a blocking limit reads as a full context unless rate-limit evidence makes it a usage limit, and a long prompt says what to do",()=>{
  for(const text of [TOO_LONG,"Context window exhausted after 212 turns",""])assert.equal(claudeResultFailure(failed("blocking_limit",{result:text})),CONTEXT_FULL,`result text ${JSON.stringify(text)}`);
  assert.equal(claudeResultFailure(failed("blocking_limit"),{knownCause:CLAUDE_USAGE_LIMIT_HINT}),CLAUDE_USAGE_LIMIT_HINT);
  assert.equal(claudeResultFailure(failed("prompt_too_long",{result:"API Error: 400 prompt is too long: 204811 tokens > 200000 maximum"})),CONTEXT_FULL);
});

const SERVER_ERROR='API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}';

test("an API failure keeps the API's own words, secrets redacted and cut to 600 characters, unless something names it better",()=>{
  // The API's words as they came, and trimmed, also from a result that does not mark itself an error.
  const kept=[
    [apiFailed(500,SERVER_ERROR),SERVER_ERROR],
    [apiFailed(400,"\tAPI Error: 400 Output blocked by the content filter.\n\n",{is_error:false}),"API Error: 400 Output blocked by the content filter."],
  ];
  for(const [result,expected] of kept)assert.equal(claudeResultFailure(result),expected);
  // A Bearer token that runs over the 600th character goes whole: the cut comes after the redaction, and ends in three dots.
  const filler="m".repeat(552),token="abc123".repeat(12);
  const bearer=claudeResultFailure(apiFailed(400,`API Error: 400 ${filler} Bearer ${token} then the request id`));
  assert.equal(bearer,`API Error: 400 ${filler} Bearer [redacted] then the request id`.slice(0,597)+"...");
  assert.equal(bearer.length,600);assert.ok(!bearer.includes("abc"),"no piece of the token is left");
  const whole=`API Error: 400 ${"w".repeat(585)}`;
  assert.equal(whole.length,600);assert.equal(claudeResultFailure(apiFailed(400,whole)),whole,"600 characters show whole");
  assert.equal(claudeResultFailure(apiFailed(500,"Renamed the helper in two files.")),API_KEPT_FAILING,"an ordinary reply is not an API error");
  // A listed error names it better; Claude Code's own diagnostic entries never do, and with only those the API's words stay.
  const refused="API Error: 400 messages: text content blocks must be non-empty",diagnostic="[ede_diagnostic] stream closed after 3 attempts";
  assert.equal(claudeResultFailure(apiFailed(400,refused,{errors:[diagnostic,"Write failed: /repo/dist is read-only"]})),"Write failed: /repo/dist is read-only");
  assert.equal(claudeResultFailure(apiFailed(400,refused,{errors:[diagnostic]})),refused);
  assert.equal(claudeResultFailure(apiFailed(529,'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')),OVERLOADED);
  assert.equal(claudeResultFailure(apiFailed(429,"API Error: 429 Too many requests in the last minute.")),RATE_LIMITED);
  assert.equal(claudeResultFailure(apiFailed(502,"API Error: 502 Bad gateway"),{knownCause:CLAUDE_USAGE_LIMIT_HINT}),CLAUDE_USAGE_LIMIT_HINT);
});

test("an API failure's own words keep no secret a JSON key names, quoted as the API repeats it, before they are cut",()=>{
  const words=text=>claudeResultFailure(apiFailed(400,text));
  // A quoted secret that runs over the 600th character.
  const filler="q".repeat(552),value="Zq9".repeat(40);
  const crossing=words(`API Error: 400 ${filler} {"session_token":"${value}"} trailing context`);
  assert.equal(crossing,`API Error: 400 ${filler} {"session_token":"[redacted]"} trailing context`.slice(0,597)+"...");
  assert.ok(!crossing.includes("Zq9"),"no piece of the value is left");
  assert.equal(words(`API Error: 400 {"password": "it's-a-secret", "client_secret":"cs-123", "refresh_token":"rt-\\"quoted\\"-456"}`),`API Error: 400 {"password": "[redacted]", "client_secret":"[redacted]", "refresh_token":"[redacted]"}`);
  assert.equal(words("API Error: 400 {'api_key': 'key-789', 'Authorization': 'Basic dXNlcjpwYXNz'}"),"API Error: 400 {'api_key': '[redacted]', 'Authorization': '[redacted]'}");
  // What names no secret stays as the API said it.
  const plain='API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 64000 > 32000","stop_reason":"max_tokens","input_tokens":12}}';
  assert.equal(words(plain),plain);
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
// The result that ends the turn, answering its user message.
const ending=(reason,extra={})=>message=>failed(reason,{...extra,user_message_uuid:message.uuid});
const windowEvent=info=>({type:"rate_limit_event",rate_limit_info:info});

test("a Claude turn that fills its context says so, and one a usage window blocked says when it resets",async()=>{
  const full=await claudeTurn([ending("blocking_limit",{result:TOO_LONG})]);
  assert.equal(full.error?.message,CONTEXT_FULL);assert.deepEqual(full.notices,[]);
  const limited=await claudeTurn([windowEvent({status:"rejected",rateLimitType:"five_hour",resetsAt:resetsAt()}),ending("blocking_limit")]);
  assert.match(limited.error?.message||"",LIMIT_WITH_WAIT);
  assert.equal(limited.notices.length,1);assert.match(limited.notices[0],WAIT);
});

// What Claude Code sends once the context is full: an invalid_request reply saying "Prompt is too long", which explains itself as an
// API error, then a blocking_limit result.
const tooLongReply={type:"assistant",uuid:"too-long",parent_tool_use_id:null,error:"invalid_request",message:{id:"m-too-long",content:[{type:"text",text:TOO_LONG}]}};
const contextFull=ending("blocking_limit",{result:TOO_LONG,num_turns:212});

test("the frames Claude Code sends once the context is full read as a full context, unless a rejected window makes it a usage limit",async()=>{
  const full=await claudeTurn([windowEvent({status:"allowed",rateLimitType:"five_hour"}),tooLongReply,contextFull]);
  assert.equal(full.error?.message,CONTEXT_FULL,"not the reply's own text");
  const limited=await claudeTurn([windowEvent({status:"rejected",rateLimitType:"five_hour"}),tooLongReply,contextFull]);
  assert.equal(limited.error?.message,CLAUDE_USAGE_LIMIT_HINT);
  // An explained API error still names a request the API refused.
  const noModel="There's an issue with the selected model (claude-legacy-2). It may not exist or you may not have access to it.";
  const unknownModel={...tooLongReply,uuid:"no-model",error:"model_not_found",message:{id:"m-no-model",content:[{type:"text",text:noModel}]}};
  const refused=await claudeTurn([unknownModel,ending("api_error",{api_error_status:404,result:'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-legacy-2"}}'})]);
  assert.equal(refused.error?.message,noModel);
});

test("a quick retry into a usage limit still says when it resets, from the window the blocked reply repeats",async()=>{
  const info={status:"rejected",rateLimitType:"five_hour",resetsAt:resetsAt()};
  // No rate_limit_event: Claude Code throttles an unchanged one, and only the blocked reply carries the window.
  const retried=await claudeTurn([blockedReply(info),ending("api_error",{api_error_status:429,result:"API Error: Rate limited"})]);
  assert.deepEqual(retried.notices.length,1,"the usage-limit notice comes back");
  assert.match(retried.notices[0],/^Claude Code has used up its five-hour allowance\. The turn waits until it resets, in 1 h (?:29|30) min\.$/);
  assert.equal(retried.error?.message,RATE_LIMITED);
  const unstated=await claudeTurn([blockedReply(info),ending("api_error",{result:"API Error: Rate limited"})]);
  assert.match(unstated.error?.message||"",LIMIT_WITH_WAIT,"the turn's error carries the wait too");
  // An allowed overage takes over the window: nothing is paused.
  const overage=await claudeTurn([blockedReply({...info,overageStatus:"allowed"}),ending("api_error",{api_error_status:500,result:"API Error: 500 Internal error"})]);
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
const GIT_PREFIX="Claude Code could not write the Git text: ";

test("Git text through Claude Code names a full context, a usage limit with its wait and the API's own error as a thread does",async()=>{
  assert.equal(await gitText([failed("blocking_limit",{result:TOO_LONG})]),GIT_PREFIX+CONTEXT_FULL);
  assert.equal(await gitText([tooLongReply,failed("blocking_limit",{result:TOO_LONG})]),GIT_PREFIX+CONTEXT_FULL,"on the frames Claude Code sends");
  assert.equal(await gitText([windowEvent({status:"rejected",rateLimitType:"five_hour"}),tooLongReply,failed("blocking_limit",{result:TOO_LONG})]),GIT_PREFIX+CLAUDE_USAGE_LIMIT_HINT);
  const info={status:"rejected",rateLimitType:"five_hour",resetsAt:resetsAt()};
  assert.match(await gitText([blockedReply(info),failed("blocking_limit")]),/^Claude Code could not write the Git text: Claude Code has used up its five-hour allowance\. Try the message again when it resets, in 1 h (?:29|30) min\.$/);
  assert.equal(await gitText([{type:"assistant",error:"server_error",message:{content:[{type:"text",text:"API Error: 500"}]}},apiFailed(500,"API Error: 500 Internal server error")]),GIT_PREFIX+"API Error: 500 Internal server error");
});

test("a turn Claude Code answers keeps its reply, whatever the window said earlier",async()=>{
  const {sdk}=scriptedClaudeSdk({turn:({message,emit})=>{
    emit(windowEvent({status:"allowed_warning",rateLimitType:"five_hour",resetsAt:resetsAt()}));
    emit({type:"assistant",uuid:"a-1",parent_tool_use_id:null,message:{id:"m-1",content:[{type:"text",text:"Done."}]}});
    emit(claudeResult(message,{result:"Done."}));
  }});
  const session=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:()=>{}});await session.start();
  assert.equal((await session.prompt([{type:"text",text:"go"}])).stopReason,"end_turn");
  await session.close();
});

// The retried terminal API failures: a reply the limit blocked names the turn's failure until a later reply of the turn goes
// through (a fallback model, say); a subagent's reply does not clear it, and a subagent's blocked reply is not the turn's.
test("a usage limit a reply ran into no longer names the turn's failure once a later reply goes through",async()=>{
  const info={status:"rejected",rateLimitType:"five_hour",resetsAt:resetsAt()};
  const reply=(uuid,parent=null)=>({type:"assistant",uuid,parent_tool_use_id:parent,message:{id:"m-"+uuid,content:[{type:"text",text:"Summary drafted on the fallback model."}]}});
  const gaveUp=ending("api_error",{result:"API Error"});
  const recovered=await claudeTurn([blockedReply(info),reply("ok"),gaveUp]);
  assert.equal(recovered.error?.message,API_KEPT_FAILING,"no longer a usage limit with a wait");
  assert.equal(recovered.notices.length,1,"the notice the blocked reply gave stays");
  const nestedReply=await claudeTurn([blockedReply(info),reply("nested-ok","toolu_agent"),gaveUp]);
  assert.match(nestedReply.error?.message||"",LIMIT_WITH_WAIT);
  const nestedLimit=await claudeTurn([blockedReply(info,{parent_tool_use_id:"toolu_agent"}),gaveUp]);
  assert.equal(nestedLimit.error?.message,API_KEPT_FAILING);
  // A window Claude Code itself rejected counts for the whole turn, whatever replies follow.
  const rejected=await claudeTurn([windowEvent(info),reply("ok"),gaveUp]);
  assert.match(rejected.error?.message||"",LIMIT_WITH_WAIT);
  assert.equal(await gitText([blockedReply(info),reply("ok"),failed("api_error",{result:"API Error"})]),GIT_PREFIX+API_KEPT_FAILING,"Git text reads the same evidence");
});
