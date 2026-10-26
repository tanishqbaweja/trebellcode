// A steer is a "now" message, which cancels the root turn's running tool calls, and a subagent the turn runs in the foreground is one
// of them. The session first moves each such subagent to the background (T3 Code's 0b68a4a9c), for at most 5 s from the steer, so
// typing into a running Claude turn no longer ends the subagent it was waiting on.
import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAgentSession } from "../src/claude-agent-session.mjs";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let round=0;round<200&&!check();round++)await tick();assert.ok(check(),"the session got there")}
const steps=call=>call.log.map(entry=>entry[0]==="input"?`input:${entry[1].priority||"next"}`:`${entry[0]}:${entry[1]}`);
const agent=(id,name,input={})=>({type:"tool_use",id,name,input:{description:"Review the parser",prompt:"Review src/parser.js",subagent_type:"code-reviewer",...input}});
// The turn launches a reviewer it waits on (toolu_x), one in the background, a finder that already answered, a command, and the
// reviewer's own nested agent; the turn stays open.
function launch({message,emit}){
  emit({type:"assistant",uuid:"assistant-launch",parent_tool_use_id:null,message:{id:"msg-launch",content:[
    agent("toolu_x","Agent"),agent("toolu_bg","Agent",{run_in_background:true}),agent("toolu_done","Task"),{type:"tool_use",id:"toolu_cmd",name:"Bash",input:{command:"npm test"}},
  ]}});
  emit({type:"user",parent_tool_use_id:null,message:{role:"user",content:[{type:"tool_result",tool_use_id:"toolu_done",content:"Found src/parser.js"}]}});
  emit({type:"assistant",uuid:"assistant-nested",parent_tool_use_id:"toolu_x",message:{id:"msg-nested",content:[agent("toolu_nested","Agent")]}});
  return message;
}
// Claude Code answers a moved subagent's call at once, as a task running in the background.
const moved=(id,call)=>{call.emit({type:"user",parent_tool_use_id:null,message:{role:"user",content:[{type:"tool_result",tool_use_id:id,content:"The agent is running in the background."}]}});return true};
function session(sdk){
  const updates=[],claude=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:params=>updates.push(params.update)});
  claude.updates=updates;return claude;
}
const launched=claude=>()=>claude.updates.some(update=>update.toolCallId==="toolu_nested");

test("a steer first moves the subagent the turn waits on to the background, then reaches the turn, and moves it only once",async()=>{
  let first=null;const steers=[];
  const {sdk,calls}=scriptedClaudeSdk({control:{backgroundTasks:moved},turn:({message,index,emit})=>{
    if(index===0){first=launch({message,emit});return}
    steers.push(message);if(steers.length<2)return;
    emit({type:"result",subtype:"error_during_execution",is_error:true,terminal_reason:"aborted_tools",errors:[],user_message_uuid:first.uuid});
    emit({type:"assistant",uuid:"assistant-steered",parent_tool_use_id:null,message:{id:"msg-steered",content:[{type:"text",text:"Using tabs, tests kept."}]}});
    emit({type:"result",subtype:"success",is_error:false,result:"Using tabs, tests kept.",user_message_uuids:[first.uuid,...steers.map(steer=>steer.uuid)]});
  }});
  const claude=session(sdk);await claude.start();
  const running=claude.prompt([{type:"text",text:"Review the parser"}]);
  await until(launched(claude));
  assert.deepEqual(await claude.steer([{type:"text",text:"Use tabs"}]),{accepted:true,pending:0});
  assert.deepEqual(steps(calls[0]),["input:next","backgroundTasks:toolu_x","input:now"],"only the root's foreground subagent, before the steer");
  await claude.steer([{type:"text",text:"And keep the tests"}]);
  assert.deepEqual(steps(calls[0]),["input:next","backgroundTasks:toolu_x","input:now","input:now"],"Claude Code answered its call, so it is not moved again");
  const outcome=await running;
  assert.equal(outcome.stopReason,"end_turn");assert.equal(outcome.providerMessageId,"assistant-steered");
  await claude.close();
});

test("a subagent move that hangs holds the steer at most 5 seconds",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const {sdk,calls}=scriptedClaudeSdk({control:{backgroundTasks:()=>new Promise(()=>{})},turn:({message,index,emit})=>{if(index===0)launch({message,emit})}});
  const claude=session(sdk);await claude.start();
  void claude.prompt([{type:"text",text:"Review the parser"}]).catch(()=>{});
  await until(launched(claude));
  let sent=false;const steering=claude.steer([{type:"text",text:"Use tabs"}]).then(result=>{sent=true;return result});
  await until(()=>steps(calls[0]).includes("backgroundTasks:toolu_x"));
  t.mock.timers.tick(4_999);await tick();
  assert.equal(sent,false);assert.deepEqual(steps(calls[0]),["input:next","backgroundTasks:toolu_x"],"the steer waits for the move");
  t.mock.timers.tick(1);
  assert.deepEqual(await steering,{accepted:true,pending:0});
  assert.deepEqual(steps(calls[0]),["input:next","backgroundTasks:toolu_x","input:now"],"and goes after 5 s all the same");
  await claude.close();
});

test("a move Claude Code refuses, with background tasks turned off, does not hold the steer",async()=>{
  const {sdk,calls}=scriptedClaudeSdk({control:{backgroundTasks:()=>{throw new Error("Background tasks are disabled (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)")}},turn:({message,index,emit})=>{if(index===0)launch({message,emit})}});
  const claude=session(sdk);await claude.start();
  void claude.prompt([{type:"text",text:"Review the parser"}]).catch(()=>{});
  await until(launched(claude));
  assert.deepEqual(await claude.steer([{type:"text",text:"Use tabs"}]),{accepted:true,pending:0});
  assert.deepEqual(steps(calls[0]),["input:next","backgroundTasks:toolu_x","input:now"]);
  await claude.close();
});

test("a turn that ends while its subagent moves takes no steer, so the message never starts a turn nobody sent",async()=>{
  const {sdk,calls}=scriptedClaudeSdk({turn:({message,index,emit})=>{if(index===0)launch({message,emit})},control:{backgroundTasks:async(id,call)=>{
    moved(id,call);call.emit({type:"assistant",uuid:"assistant-done",parent_tool_use_id:null,message:{id:"msg-done",content:[{type:"text",text:"The reviewer runs in the background."}]}});
    call.emit(claudeResult(call.inputs[0],{result:"The reviewer runs in the background."}));
    await tick();return true;
  }}});
  const claude=session(sdk);await claude.start();
  const running=claude.prompt([{type:"text",text:"Review the parser"}]);
  await until(launched(claude));
  await assert.rejects(claude.steer([{type:"text",text:"Use tabs"}]),/Claude Code has no running turn to steer\./);
  assert.equal((await running).stopReason,"end_turn");
  assert.deepEqual(steps(calls[0]),["input:next","backgroundTasks:toolu_x"],"nothing was sent into the ended turn");
  await claude.close();
});
