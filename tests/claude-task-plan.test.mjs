// Claude Code's to-do list is the thread's plan, as Cursor's and OpenCode's are: the root's TodoWrite list, and the one task list per
// Claude session its Task tools keep (TaskCreate, TaskUpdate, TaskList), from their structured results and from the text that is all
// a subagent's call returns (T3 Code's emitClaudePlanProjection, applyClaudeTaskTool and bda042aad), and from Claude Code's own list on
// disk for a session Trebell has not followed since it started (29aec6b88). The SDK is scripted: nothing runs, and each session has a
// Claude home of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as claudeSession from "../src/claude-agent-session.mjs";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const {ClaudeAgentSession}=claudeSession;
const claudeTaskList=(...args)=>claudeSession.claudeTaskList(...args),claudeTodoEntries=input=>claudeSession.claudeTodoEntries(input);
const homes=[];
test.after(()=>{for(const home of homes)rmSync(home,{recursive:true,force:true})});
function claudeHome(){const home=mkdtempSync(join(tmpdir(),"trebell-claude-tasks-"));homes.push(home);return home}
function session(sdk,{env={CLAUDE_CONFIG_DIR:claudeHome()},...options}={}){
  const updates=[],claude=new ClaudeAgentSession({cwd:process.cwd(),env,sdk,onUpdate:({update})=>updates.push(update),...options});
  return Object.assign(claude,{updates});
}
const plans=claude=>claude.updates.filter(update=>update.sessionUpdate==="plan").map(update=>update.entries);
const call=(id,name,input,parent=null)=>({type:"assistant",uuid:"a-"+id,parent_tool_use_id:parent,message:{id:"m-"+id,content:[{type:"tool_use",id,name,input}]}});
// A tool's result as Claude Code sends it: the text the model reads and, for the root's calls, the tool's structured result.
const answer=(id,text,{structured,parent=null,failed=false,meta}={})=>({
  type:"user",parent_tool_use_id:parent,message:{role:"user",content:[{type:"tool_result",tool_use_id:id,content:text,...(failed?{is_error:true}:{})}]},
  ...(structured!==undefined?{tool_use_result:structured}:{}),...(meta?{tool_result_meta:meta}:{}),
});
const created=(id,subject,parent=null)=>[call("create-"+id,"TaskCreate",{subject,description:subject+"."},parent),answer("create-"+id,`Task #${id} created successfully: ${subject}`,parent?{parent}:{structured:{task:{id,subject}}})];
const updated=(id,input,parent=null,callId="update-"+id+"-"+(input.status||"subject"))=>[call(callId,"TaskUpdate",{taskId:id,...input},parent),answer(callId,`Updated task #${id} ${Object.keys(input).join(", ")}`,parent?{parent}:{structured:{success:true,taskId:id,updatedFields:Object.keys(input)}})];

test("the root's TodoWrite list is the thread's plan, each list replacing the last, while its call still shows as a row",async()=>{
  const {sdk}=scriptedClaudeSdk({turn:({message,emit})=>{
    emit(call("todo-1","TodoWrite",{todos:[{content:"Read the release checklist",status:"in_progress",activeForm:"Reading the checklist"},{content:"Update the changelog",status:"pending",activeForm:"Updating the changelog"}]}));
    emit(answer("todo-1","Todos have been modified successfully.",{structured:{oldTodos:[],newTodos:[]}}));
    // A subagent's own list is not the thread's.
    emit(call("todo-sub","TodoWrite",{todos:[{content:"A subagent's own step",status:"pending"}]},"agent-1"));
    emit(call("todo-2","TodoWrite",{todos:[{content:"Read the release checklist",status:"completed"},{content:"Update the changelog",status:"in_progress"},{content:"  "},null,{content:"Tag the release",status:"later"}]}));
    emit(claudeResult(message));
  }});
  const claude=session(sdk);await claude.start();
  assert.equal((await claude.prompt([{type:"text",text:"Plan the release"}])).stopReason,"end_turn");
  assert.deepEqual(plans(claude),[
    [{content:"Read the release checklist",status:"in_progress"},{content:"Update the changelog",status:"pending"}],
    [{content:"Read the release checklist",status:"completed"},{content:"Update the changelog",status:"in_progress"},{content:"Tag the release",status:"pending"}],
  ]);
  assert.ok(claude.updates.some(update=>update.sessionUpdate==="tool_call"&&update.toolCallId==="todo-1"&&update.title==="TodoWrite"),"the call's own row");
});

test("Claude's Task tools keep one task list for the Claude session, from the root's structured results and a subagent's text, over turns",async()=>{
  const {sdk}=scriptedClaudeSdk({turn:({message,index,emit})=>{
    const frames=index===0?[
      ...created("1","Write the migration"),
      // A subagent's calls reach the same list (bda042aad), through the text their results are.
      call("agent-1","Agent",{description:"Test the migration",prompt:"Run its tests"}),
      ...created("2","Run the migration tests","agent-1"),
      ...updated("2",{status:"in_progress"},"agent-1"),
      // An update Claude Code refused (its text is the reason), a call that failed and one that never ran change nothing.
      call("refused","TaskUpdate",{taskId:"2",status:"completed"},"agent-1"),answer("refused","Tests must pass before completing.",{parent:"agent-1"}),
      call("failed","TaskUpdate",{taskId:"1",status:"completed"}),answer("failed","<tool_use_error>Task store is busy</tool_use_error>",{failed:true}),
      call("cancelled","TaskUpdate",{taskId:"1",status:"completed"}),answer("cancelled","Cancelled.",{structured:{success:true,taskId:"1",updatedFields:["status"]},meta:[{id:"cancelled",non_execution_kind:"cancelled"}]}),
      call("refused-root","TaskUpdate",{taskId:"1",status:"completed"}),answer("refused-root","Task #1 not found",{structured:{success:false,taskId:"1",updatedFields:[],error:"Task #1 not found"}}),
      // An update of a task the list does not have, and one that changes nothing, show nothing new.
      ...updated("9",{status:"completed"}),
      ...updated("1",{status:"pending"},null,"same"),
      ...updated("1",{status:"completed"}),
      answer("agent-1","The migration tests run."),
    ]:[
      // The next turn goes on with the list: a renamed task, a new one, a deleted one, then TaskList's own list replaces it.
      ...updated("1",{subject:"Write and review the migration"}),
      ...created("3","Tag the release"),
      ...updated("2",{status:"deleted"}),
      call("list","TaskList",{}),answer("list","#1 [completed] Write and review the migration\n#3 [in_progress] Tag the release",{structured:{tasks:[{id:"1",subject:"Write and review the migration",status:"completed",blockedBy:[]},{id:"3",subject:"Tag the release",status:"in_progress",blockedBy:[]},{id:"4",subject:"",status:"pending",blockedBy:[]}]}}),
    ];
    for(const frame of frames)emit(frame);
    emit(claudeResult(message));
  }});
  const claude=session(sdk);await claude.start();
  await claude.prompt([{type:"text",text:"Track the migration as tasks"}]);
  const W="Write the migration",R="Run the migration tests";
  assert.deepEqual(plans(claude),[
    [{content:W,status:"pending"}],
    [{content:W,status:"pending"},{content:R,status:"pending"}],
    [{content:W,status:"pending"},{content:R,status:"in_progress"}],
    [{content:W,status:"completed"},{content:R,status:"in_progress"}],
  ]);
  await claude.prompt([{type:"text",text:"Go on"}]);
  const WR="Write and review the migration",T="Tag the release";
  assert.deepEqual(plans(claude).slice(4),[
    [{content:WR,status:"completed"},{content:R,status:"in_progress"}],
    [{content:WR,status:"completed"},{content:R,status:"in_progress"},{content:T,status:"pending"}],
    [{content:WR,status:"completed"},{content:T,status:"pending"}],
    [{content:WR,status:"completed"},{content:T,status:"in_progress"}],
  ]);
  // A conversation started over (Edit from here, back to its start) is another Claude session, with a task list of its own.
  await claude.rewindConversation(null);
  const {sdk:fresh}=scriptedClaudeSdk({turn:({message,emit})=>{for(const frame of [...updated("1",{status:"in_progress"}),...created("1","Start over")])emit(frame);emit(claudeResult(message))}});
  claude.sdk=fresh;
  await claude.prompt([{type:"text",text:"Start again"}]);
  assert.deepEqual(plans(claude).slice(8),[[{content:"Start over",status:"pending"}]]);
});

// Claude Code's own list on disk, as its task tools write it before their result comes: a task a file, with fields the plan does not show.
function storeTasks(folder,tasks){
  mkdirSync(folder,{recursive:true});
  for(const [name,task] of Object.entries(tasks))writeFileSync(join(folder,name),typeof task==="string"?task:JSON.stringify({description:"",blocks:[],blockedBy:[],...task}));
}
const SESSION="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

test("a Claude session Trebell has not followed reads Claude Code's own task list once, so the first change after a restart keeps every task",async()=>{
  const home=claudeHome(),folder=join(home,"tasks",SESSION);
  // Claude Code's internal task, a file cut short, a folder and a file that is not a task's are left out; the order is the tasks'.
  storeTasks(folder,{"1.json":{id:"1",subject:"Inspect the parser",status:"completed"},"2.json":{id:"2",subject:"Fix the parser",status:"completed"},"3.json":{id:"3",subject:"Internal",status:"pending",metadata:{_internal:true}},"4.json":"{","10.json":{id:"10",subject:"Tag the release",status:"pending"},".highwatermark":"10"});
  mkdirSync(join(folder,"5.json"));
  const {sdk}=scriptedClaudeSdk({turn:({message,index,emit})=>{
    for(const frame of index===0?updated("2",{status:"completed"}):updated("10",{status:"in_progress"}))emit(frame);
    emit(claudeResult(message));
  }});
  const claude=session(sdk,{env:{CLAUDE_CONFIG_DIR:home}});await claude.start({providerSessionId:SESSION});
  await claude.prompt([{type:"text",text:"Mark the fix done"}]);
  const I={content:"Inspect the parser",status:"completed"},F={content:"Fix the parser",status:"completed"};
  assert.deepEqual(plans(claude),[[I,F,{content:"Tag the release",status:"pending"}]],"the update Claude Code already wrote, with the tasks it did not change");
  // Read once: what the folder holds later is Claude Code's, and the session's own list goes on from what it read.
  storeTasks(folder,{"11.json":{id:"11",subject:"Not read",status:"pending"}});
  await claude.prompt([{type:"text",text:"Start the release"}]);
  assert.deepEqual(plans(claude).slice(1),[[I,F,{content:"Tag the release",status:"in_progress"}]]);
});

test("Claude Code's own list is read from the task list CLAUDE_CODE_TASK_LIST_ID names, as empty, or not at all",async()=>{
  // A shared list, named in the profile's environment: its folder name keeps letters, digits, - and _.
  const shared=claudeHome();storeTasks(join(shared,"tasks","list-ID"),{"1.json":{id:"1",subject:"Inspect",status:"completed"},"2.json":{id:"2",subject:"Implement",status:"pending"}});
  const one=scriptedClaudeSdk({turn:({message,emit})=>{for(const frame of created("2","Implement"))emit(frame);emit(claudeResult(message))}});
  const listed=session(one.sdk,{env:{CLAUDE_CONFIG_DIR:shared,CLAUDE_CODE_TASK_LIST_ID:" list/ID "}});await listed.start({providerSessionId:SESSION});
  await listed.prompt([{type:"text",text:"Plan it"}]);
  assert.deepEqual(plans(listed),[[{content:"Inspect",status:"completed"},{content:"Implement",status:"pending"}]]);

  // The first update after a restart deleted the last task: Claude Code's folder is there and empty, so the plan empties.
  const emptied=claudeHome();storeTasks(join(emptied,"tasks",SESSION),{".highwatermark":"1"});
  const two=scriptedClaudeSdk({turn:({message,emit})=>{for(const frame of updated("1",{status:"deleted"}))emit(frame);emit(claudeResult(message))}});
  const empty=session(two.sdk,{env:{CLAUDE_CONFIG_DIR:emptied}});await empty.start({providerSessionId:SESSION});
  await empty.prompt([{type:"text",text:"Drop it"}]);
  assert.deepEqual(plans(empty),[[]]);

  // A structured TaskList is the whole list already, and a Claude Code that runs elsewhere keeps its list where it runs.
  const kept=claudeHome();storeTasks(join(kept,"tasks",SESSION),{"1.json":{id:"1",subject:"Inspect",status:"completed"}});
  const three=scriptedClaudeSdk({turn:({message,emit})=>{
    emit(call("list","TaskList",{}));emit(answer("list","#3 [pending] Ship",{structured:{tasks:[{id:"3",subject:"Ship",status:"pending",blockedBy:[]}]}}));
    emit(claudeResult(message));
  }});
  const full=session(three.sdk,{env:{CLAUDE_CONFIG_DIR:kept}});await full.start({providerSessionId:SESSION});
  await full.prompt([{type:"text",text:"List them"}]);
  assert.deepEqual(plans(full),[[{content:"Ship",status:"pending"}]]);
  const four=scriptedClaudeSdk({turn:({message,emit})=>{for(const frame of updated("1",{status:"pending"}))emit(frame);emit(claudeResult(message))}});
  const remote=session(four.sdk,{env:{CLAUDE_CONFIG_DIR:kept},spawnProcess:()=>{throw new Error("the scripted SDK starts no process")}});await remote.start({providerSessionId:SESSION});
  await remote.prompt([{type:"text",text:"Reopen it"}]);
  assert.deepEqual(plans(remote),[],"no list to change");
});

test("task tool results are read defensively: what is not a task list's shape changes nothing",()=>{
  const tasks=new Map([["1",{content:"Write the migration",status:"pending"}]]);
  assert.equal(claudeTaskList(tasks,"TaskList",{},"#1 [pending] Write the migration"),null,"a TaskList's text is not read");
  assert.equal(claudeTaskList(new Map(),"TaskList",{},{tasks:[]}),null,"an empty list replacing no list changes nothing");
  assert.deepEqual([...claudeTaskList(tasks,"TaskList",{},{tasks:[]})],[],"an empty list empties one");
  assert.equal(claudeTaskList(tasks,"TaskCreate",{subject:"x"},{task:null}),null,"a created task without an id");
  assert.equal(claudeTaskList(tasks,"TaskCreate",{subject:"x"},"Task created"),null,"or a text that names none");
  assert.deepEqual(claudeTaskList(tasks,"TaskCreate",{subject:"From the input"},{task:{id:"2"}}).get("2"),{content:"From the input",status:"pending"},"the subject the call asked for");
  assert.equal(claudeTaskList(tasks,"TaskUpdate",{taskId:"1",status:"completed"},{success:false,taskId:"1"}),null);
  assert.equal(claudeTaskList(tasks,"TaskUpdate",{taskId:"1",status:"done"},{success:true,taskId:"1"}),null,"a status Claude Code has no such name for");
  assert.equal(claudeTaskList(tasks,"TaskGet",{taskId:"1"},{task:{id:"1",subject:"x",status:"completed"}}),null,"TaskGet only reads");
  assert.deepEqual(claudeTodoEntries({todos:"not a list"}),[]);
  assert.deepEqual(claudeTodoEntries(null),[]);
});
