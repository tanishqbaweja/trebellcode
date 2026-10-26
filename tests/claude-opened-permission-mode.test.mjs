// The mode a Claude Code process opened in is the one its first init reports, since Claude Code can fall back from the one asked
// for (T3 Code's 598298cc3), and only a process Claude switched to Plan is put back in it (T3 Code's 0b84aa3fa). A follow-up in Auto
// on a model without Auto no longer restarts Claude Code each time, ending its background agents and shells.
import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAgentSession } from "../src/claude-agent-session.mjs";
import { isSessionRefusal } from "../src/session-refusal.mjs";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const BACKGROUND_WORK="Claude is still running background agents or commands, and this model or setting change would end them. Wait for them to finish (or ask Claude to stop them), or keep the current model and settings, then send the message again.";
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const modes=call=>call.log.filter(entry=>entry[0]==="setPermissionMode").map(entry=>entry[1]);
const steps=call=>call.log.map(entry=>entry[0]==="input"?"input":`${entry[0]}:${entry[1]}`);
// A turn that leaves Claude in Plan, as EnterPlanMode or a denied ExitPlanMode does: Claude Code says so in a status frame.
const intoPlan=({message,index,emit})=>{if(index===0)emit({type:"system",subtype:"status",status:null,permissionMode:"plan"});emit(claudeResult(message))};
function session(sdk,permissionMode){return new ClaudeAgentSession({cwd:"/repo",sdk,permissionMode,onUpdate:()=>{}})}

test("in Auto on a model without Auto, the mode Claude Code fell back to stands: follow-ups share its process and keep its background work",async()=>{
  const {sdk,calls}=scriptedClaudeSdk({init:{permissionMode:"default"},control:{setPermissionMode:mode=>{if(mode==="auto")throw new Error("Auto mode is unavailable for this model")}}});
  const claude=session(sdk,"auto");await claude.start();
  await claude.prompt([{type:"text",text:"Start the watcher"}]);
  assert.equal(calls[0].options.permissionMode,"auto","Auto was asked for");
  assert.equal(claude.live.openedPermissionMode,"default","the first init says what Claude Code opened in");
  calls[0].emit({type:"system",subtype:"background_tasks_changed",tasks:[{task_id:"bg-1",description:"npm run watch"}]});await tick();
  assert.equal((await claude.prompt([{type:"text",text:"And now the tests"}])).stopReason,"end_turn");
  await claude.prompt([{type:"text",text:"Once more"}]);
  assert.equal(calls.length,1,"one process for every follow-up");assert.equal(calls[0].closed,false,"its background work goes on");
  assert.deepEqual(modes(calls[0]),[],"nothing tries to switch it to Auto");
  await claude.close();
});

test("a process Claude switched to Plan goes back to the mode it opened in before the next prompt, and Full access that cannot goes to Manual",async()=>{
  const {sdk,calls}=scriptedClaudeSdk({turn:intoPlan});
  const edits=session(sdk,"edits");await edits.start();
  await edits.prompt([{type:"text",text:"Look first"}]);
  assert.equal(edits.live.permissionMode,"plan");
  await edits.prompt([{type:"text",text:"Now fix it"}]);
  assert.deepEqual(steps(calls[0]),["input","setPermissionMode:acceptEdits","input"],"restored before the prompt reaches Claude Code");
  await edits.close();
  // Full access an administrator turned off since the process opened cannot come back: the process leaves Plan for Manual and stays.
  const {sdk:locked,calls:lockedCalls}=scriptedClaudeSdk({turn:intoPlan,control:{setPermissionMode:mode=>{if(mode==="bypassPermissions")throw new Error("Bypass permissions mode is disabled by your organization")}}});
  const full=session(locked,"full");await full.start();
  await full.prompt([{type:"text",text:"Look first"}]);
  await full.prompt([{type:"text",text:"Now fix it"}]);
  assert.deepEqual(steps(lockedCalls[0]),["input","setPermissionMode:bypassPermissions","setPermissionMode:default","input"]);
  assert.equal(lockedCalls.length,1,"the process stays");assert.equal(full.live.permissionMode,"default");
  await full.prompt([{type:"text",text:"Go on"}]);
  assert.equal(lockedCalls.length,1);assert.deepEqual(modes(lockedCalls[0]),["bypassPermissions","default"],"Manual is not Plan: nothing more to restore");
  await full.close();
});

test("only the first init says what a process opened in: a later one that reports Plan is still put back",async()=>{
  const {sdk,calls}=scriptedClaudeSdk({turn:({message,index,emit,options})=>{
    if(index===0)emit({type:"system",subtype:"init",session_id:options.sessionId,model:"claude-test",permissionMode:"plan",tools:[],mcp_servers:[],slash_commands:[],agents:[],capabilities:[]});
    emit(claudeResult(message));
  }});
  const claude=session(sdk,"full");await claude.start();
  await claude.prompt([{type:"text",text:"one"}]);
  assert.equal(claude.live.openedPermissionMode,"bypassPermissions");
  await claude.prompt([{type:"text",text:"two"}]);
  assert.deepEqual(modes(calls[0]),["bypassPermissions"]);assert.equal(calls.length,1);
  await claude.close();
});

test("a process that cannot leave Plan is replaced only once no background work runs in it",async()=>{
  const {sdk,calls}=scriptedClaudeSdk({turn:intoPlan,control:{setPermissionMode:()=>{throw new Error("The mode cannot change now")}}});
  const claude=session(sdk,"edits");await claude.start();
  await claude.prompt([{type:"text",text:"Look first"}]);
  calls[0].emit({type:"system",subtype:"background_tasks_changed",tasks:[{task_id:"bg-1",description:"npm run watch"}]});await tick();
  await assert.rejects(claude.prompt([{type:"text",text:"Now fix it"}]),error=>isSessionRefusal(error)&&error.message===BACKGROUND_WORK);
  assert.equal(calls.length,1);assert.equal(calls[0].closed,false,"the process and its background work go on");
  calls[0].emit({type:"system",subtype:"background_tasks_changed",tasks:[]});await tick();
  assert.equal((await claude.prompt([{type:"text",text:"Now fix it"}])).stopReason,"end_turn");
  assert.equal(calls.length,2,"with nothing running in it, the process is replaced");assert.equal(calls[0].closed,true);
  assert.equal(calls[1].options.permissionMode,"acceptEdits");
  await claude.close();
});
