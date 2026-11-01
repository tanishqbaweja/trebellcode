// Claude Code's to-do list is the thread's plan, as Cursor's and OpenCode's are: the root's TodoWrite list, and the one task list per
// Claude session its Task tools keep (TaskCreate, TaskUpdate, TaskList), from their structured results and from the text that is all
// a subagent's call returns, and from Claude Code's own list on
// disk for a session Trebell has not followed since it started. A TodoWrite edits no file: it is no step of the turn, unless
// it failed. The SDK is scripted: nothing runs, and each session has a Claude home of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as claudeSession from "../src/claude-agent-session.mjs";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const {ClaudeAgentSession}=claudeSession;
const claudeTaskList=(...args)=>claudeSession.claudeTaskList(...args),claudeTodoEntries=input=>claudeSession.claudeTodoEntries(input);
const configDirs=[];
test.after(()=>{for(const dir of configDirs)rmSync(dir,{recursive:true,force:true})});
function freshClaudeConfig(){const dir=mkdtempSync(join(tmpdir(),"trebell-claude-tasks-"));configDirs.push(dir);return dir}
function session(sdk,{env={CLAUDE_CONFIG_DIR:freshClaudeConfig()},...options}={}){
  const updates=[],claude=new ClaudeAgentSession({cwd:process.cwd(),env,sdk,onUpdate:({update})=>updates.push(update),...options});
  return Object.assign(claude,{updates});
}
const plans=claude=>claude.updates.filter(update=>update.sessionUpdate==="plan").map(update=>update.entries);
const emitAll=(emit,frames)=>{for(const frame of frames)emit(frame)};

// Claude Code's frames for a tool call and its result. A root call's result carries the tool's structured result as well; a
// subagent's (parent: the Agent call it runs under) carries only the text the model reads.
const toolUse=(id,name,input,parent=null)=>({type:"assistant",uuid:"a-"+id,parent_tool_use_id:parent,message:{id:"m-"+id,content:[{type:"tool_use",id,name,input}]}});
function toolResult(id,text,{structured,parent=null,failed=false,meta}={}){
  const block={type:"tool_result",tool_use_id:id,content:text};if(failed)block.is_error=true;
  const frame={type:"user",parent_tool_use_id:parent,message:{role:"user",content:[block]}};
  if(structured!==undefined)frame.tool_use_result=structured;
  if(meta)frame.tool_result_meta=meta;
  return frame;
}
// The task tools' text results, as Claude Code words them: Trebell reads a subagent's calls from this text alone.
const createdText=(id,subject)=>"Task #"+id+" created successfully: "+subject;
const updatedText=(id,fields)=>"Updated task #"+id+" "+fields.join(", ");
function taskCreateFrames(id,subject,parent=null){
  const callId="create-"+id;
  return [toolUse(callId,"TaskCreate",{subject,description:subject+"."},parent),toolResult(callId,createdText(id,subject),parent?{parent}:{structured:{task:{id,subject}}})];
}
function taskUpdateFrames(id,input,{parent=null,callId=`update-${id}-${input.status||"subject"}`}={}){
  const fields=Object.keys(input);
  return [toolUse(callId,"TaskUpdate",{taskId:id,...input},parent),toolResult(callId,updatedText(id,fields),parent?{parent}:{structured:{success:true,taskId:id,updatedFields:fields}})];
}
const entry=(content,status)=>({content,status});

test("the root's TodoWrite list is the thread's plan, each list replacing the last, and a TodoWrite is no step of the turn unless it failed",async()=>{
  const {sdk}=scriptedClaudeSdk({turn:({message,emit})=>{
    emit(toolUse("todo-1","TodoWrite",{todos:[{content:"Read the release checklist",status:"in_progress",activeForm:"Reading the checklist"},{content:"Update the changelog",status:"pending",activeForm:"Updating the changelog"}]}));
    emit(toolResult("todo-1","Todos have been modified successfully.",{structured:{oldTodos:[],newTodos:[]}}));
    // A subagent's own list is not the thread's.
    emit(toolUse("todo-sub","TodoWrite",{todos:[{content:"A subagent's own step",status:"pending"}]},"agent-1"));
    emit(toolUse("todo-2","TodoWrite",{todos:[{content:"Read the release checklist",status:"completed"},{content:"Update the changelog",status:"in_progress"},{content:"  "},null,{content:"Tag the release",status:"later"}]}));
    // One that failed shows as the call it is, which edits no file; Claude's edits stay edits.
    emit(toolUse("todo-failed","TodoWrite",{todos:[{content:"A subagent's next step"}]},"agent-1"));
    emit(toolResult("todo-failed","<tool_use_error>InputValidationError: The required parameter `todos[0].status` is missing</tool_use_error>",{parent:"agent-1",failed:true}));
    const edits=[["edit","Edit",{file_path:"CHANGELOG.md"}],["write","Write",{file_path:"NOTES.md"}],["multi","MultiEdit",{file_path:"package.json"}],["notebook","NotebookEdit",{notebook_path:"checks.ipynb"}]];
    for(const [id,name,input] of edits)emitAll(emit,[toolUse(id,name,input),toolResult(id,"Done.")]);
    emit(claudeResult(message));
  }});
  const claude=session(sdk);await claude.start();
  assert.equal((await claude.prompt([{type:"text",text:"Plan the release"}])).stopReason,"end_turn");
  assert.deepEqual(plans(claude),[
    [entry("Read the release checklist","in_progress"),entry("Update the changelog","pending")],
    [entry("Read the release checklist","completed"),entry("Update the changelog","in_progress"),entry("Tag the release","pending")],
  ]);
  const rows=claude.updates.filter(update=>update.sessionUpdate==="tool_call"||update.sessionUpdate==="tool_call_update").map(({sessionUpdate,toolCallId,title,kind,status})=>({sessionUpdate,toolCallId,title,kind,status}));
  assert.deepEqual(rows.filter(row=>row.toolCallId.startsWith("todo-")),[{sessionUpdate:"tool_call",toolCallId:"todo-failed",title:"TodoWrite",kind:"other",status:"failed"}],"no to-do list is a row but the one that failed");
  assert.deepEqual(rows.filter(row=>!row.toolCallId.startsWith("todo-")).map(row=>[row.sessionUpdate,row.title,row.kind]),["Edit","Write","MultiEdit","NotebookEdit"].flatMap(name=>[["tool_call",name,"edit"],["tool_call_update",name,"edit"]]));
});

test("Claude's Task tools keep one task list for the Claude session, from the root's structured results and a subagent's text, over turns",async()=>{
  const W="Write the migration",R="Run the migration tests",WR="Write and review the migration",T="Tag the release";
  const sub={parent:"agent-1"};
  const turns=[
    [
      ...taskCreateFrames("1",W),
      // A subagent's calls reach the same list, through the text their results are.
      toolUse("agent-1","Agent",{description:"Test the migration",prompt:"Run its tests"}),
      ...taskCreateFrames("2",R,"agent-1"),
      ...taskUpdateFrames("2",{status:"in_progress"},sub),
      // An update Claude Code refused (its text is the reason), a call that failed and one that never ran change nothing.
      toolUse("refused","TaskUpdate",{taskId:"2",status:"completed"},"agent-1"),toolResult("refused","Blocked by the task-completed hook: run the migration tests first.",sub),
      toolUse("failed","TaskUpdate",{taskId:"1",status:"completed"}),toolResult("failed","<tool_use_error>Task store is busy</tool_use_error>",{failed:true}),
      toolUse("cancelled","TaskUpdate",{taskId:"1",status:"completed"}),toolResult("cancelled","Cancelled.",{structured:{success:true,taskId:"1",updatedFields:["status"]},meta:[{id:"cancelled",non_execution_kind:"cancelled"}]}),
      toolUse("refused-root","TaskUpdate",{taskId:"1",status:"completed"}),toolResult("refused-root","Task #1 not found",{structured:{success:false,taskId:"1",updatedFields:[],error:"Task #1 not found"}}),
      // An update of a task the list does not have, and one that changes nothing, show nothing new.
      ...taskUpdateFrames("9",{status:"completed"}),
      ...taskUpdateFrames("1",{status:"pending"},{callId:"same"}),
      ...taskUpdateFrames("1",{status:"completed"}),
      toolResult("agent-1","The migration tests run."),
    ],
    [
      // The next turn goes on with the list: a renamed task, a new one, a deleted one, then TaskList's own list replaces it.
      ...taskUpdateFrames("1",{subject:WR}),
      ...taskCreateFrames("3",T),
      ...taskUpdateFrames("2",{status:"deleted"}),
      toolUse("list","TaskList",{}),toolResult("list",`#1 [completed] ${WR}\n#3 [in_progress] ${T}`,{structured:{tasks:[{id:"1",subject:WR,status:"completed",blockedBy:[]},{id:"3",subject:T,status:"in_progress",blockedBy:[]},{id:"4",subject:"",status:"pending",blockedBy:[]}]}}),
    ],
  ];
  const {sdk}=scriptedClaudeSdk({turn:({message,index,emit})=>{emitAll(emit,turns[index]||[]);emit(claudeResult(message))}});
  const claude=session(sdk);await claude.start();
  await claude.prompt([{type:"text",text:"Track the migration as tasks"}]);
  assert.deepEqual(plans(claude),[
    [entry(W,"pending")],
    [entry(W,"pending"),entry(R,"pending")],
    [entry(W,"pending"),entry(R,"in_progress")],
    [entry(W,"completed"),entry(R,"in_progress")],
  ]);
  await claude.prompt([{type:"text",text:"Go on"}]);
  assert.deepEqual(plans(claude).slice(4),[
    [entry(WR,"completed"),entry(R,"in_progress")],
    [entry(WR,"completed"),entry(R,"in_progress"),entry(T,"pending")],
    [entry(WR,"completed"),entry(T,"pending")],
    [entry(WR,"completed"),entry(T,"in_progress")],
  ]);
  // A conversation started over (Edit from here, back to its start) is another Claude session, with a task list of its own.
  await claude.rewindConversation(null);
  const {sdk:fresh}=scriptedClaudeSdk({turn:({message,emit})=>{emitAll(emit,[...taskUpdateFrames("1",{status:"in_progress"}),...taskCreateFrames("1","Start over")]);emit(claudeResult(message))}});
  claude.sdk=fresh;
  await claude.prompt([{type:"text",text:"Start again"}]);
  assert.deepEqual(plans(claude).slice(8),[[entry("Start over","pending")]]);
});

// Claude Code's own list on disk, as its task tools write it before their result comes: a task a file, with fields the plan does not
// show. Each entry of files is a file name and either a task (written as Claude Code writes one) or the file's raw text.
function writeTaskFolder(folder,files){
  mkdirSync(folder,{recursive:true});
  for(const [name,content] of files){
    const body=typeof content==="string"?content:JSON.stringify(Object.assign({description:"",blocks:[],blockedBy:[]},content));
    writeFileSync(join(folder,name),body);
  }
}
const SESSION="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const taskFile=(id,subject,status,extra={})=>[id+".json",{id,subject,status,...extra}];

test("a Claude session Trebell has not followed reads Claude Code's own task list once, so the first change after a restart keeps every task",async()=>{
  const config=freshClaudeConfig(),folder=join(config,"tasks",SESSION);
  // Claude Code's internal task, a file cut short, a folder and a file that is not a task's are left out; the order is the tasks'.
  writeTaskFolder(folder,[
    taskFile("1","Profile the tokenizer","completed"),taskFile("2","Patch the tokenizer","completed"),
    taskFile("3","Internal","pending",{metadata:{_internal:true}}),["4.json","{"],taskFile("10","Tag the release","pending"),[".highwatermark","10"],
  ]);
  mkdirSync(join(folder,"5.json"));
  const {sdk}=scriptedClaudeSdk({turn:({message,index,emit})=>{
    emitAll(emit,index===0?taskUpdateFrames("2",{status:"completed"}):taskUpdateFrames("10",{status:"in_progress"}));
    emit(claudeResult(message));
  }});
  const claude=session(sdk,{env:{CLAUDE_CONFIG_DIR:config}});await claude.start({providerSessionId:SESSION});
  await claude.prompt([{type:"text",text:"Mark the patch done"}]);
  const profiled=entry("Profile the tokenizer","completed"),patched=entry("Patch the tokenizer","completed");
  assert.deepEqual(plans(claude),[[profiled,patched,entry("Tag the release","pending")]],"the update Claude Code already wrote, with the tasks it did not change");
  // Read once: what the folder holds later is Claude Code's, and the session's own list goes on from what it read.
  writeTaskFolder(folder,[taskFile("11","Not read","pending")]);
  await claude.prompt([{type:"text",text:"Start the release"}]);
  assert.deepEqual(plans(claude).slice(1),[[profiled,patched,entry("Tag the release","in_progress")]]);
});

test("Claude Code's own list is read from the task list CLAUDE_CODE_TASK_LIST_ID names, as empty, or not at all",async()=>{
  const scripted=frames=>scriptedClaudeSdk({turn:({message,emit})=>{emitAll(emit,frames);emit(claudeResult(message))}}).sdk;
  // A shared list, named in the profile's environment: its folder name keeps letters, digits, - and _.
  const shared=freshClaudeConfig();writeTaskFolder(join(shared,"tasks","list-ID"),[taskFile("1","Inspect","completed"),taskFile("2","Implement","pending")]);
  const listed=session(scripted(taskCreateFrames("2","Implement")),{env:{CLAUDE_CONFIG_DIR:shared,CLAUDE_CODE_TASK_LIST_ID:" list/ID "}});await listed.start({providerSessionId:SESSION});
  await listed.prompt([{type:"text",text:"Plan it"}]);
  assert.deepEqual(plans(listed),[[entry("Inspect","completed"),entry("Implement","pending")]]);

  // The first update after a restart deleted the last task: Claude Code's folder is there and empty, so the plan empties.
  const emptied=freshClaudeConfig();writeTaskFolder(join(emptied,"tasks",SESSION),[[".highwatermark","1"]]);
  const empty=session(scripted(taskUpdateFrames("1",{status:"deleted"})),{env:{CLAUDE_CONFIG_DIR:emptied}});await empty.start({providerSessionId:SESSION});
  await empty.prompt([{type:"text",text:"Drop it"}]);
  assert.deepEqual(plans(empty),[[]]);

  // A structured TaskList is the whole list already, and a Claude Code that runs elsewhere keeps its list where it runs.
  const kept=freshClaudeConfig();writeTaskFolder(join(kept,"tasks",SESSION),[taskFile("1","Inspect","completed")]);
  const whole=[toolUse("list","TaskList",{}),toolResult("list","#3 [pending] Ship",{structured:{tasks:[{id:"3",subject:"Ship",status:"pending",blockedBy:[]}]}})];
  const full=session(scripted(whole),{env:{CLAUDE_CONFIG_DIR:kept}});await full.start({providerSessionId:SESSION});
  await full.prompt([{type:"text",text:"List them"}]);
  assert.deepEqual(plans(full),[[entry("Ship","pending")]]);
  const remote=session(scripted(taskUpdateFrames("1",{status:"pending"})),{env:{CLAUDE_CONFIG_DIR:kept},spawnProcess:()=>{throw new Error("the scripted SDK starts no process")}});await remote.start({providerSessionId:SESSION});
  await remote.prompt([{type:"text",text:"Reopen it"}]);
  assert.deepEqual(plans(remote),[],"no list to change");
});

test("task tool results are read defensively: what is not a task list's shape changes nothing",()=>{
  const tasks=new Map([["1",entry("Write the migration","pending")]]);
  assert.equal(claudeTaskList(tasks,"TaskList",{},"#1 [pending] Write the migration"),null,"a TaskList's text is not read");
  assert.equal(claudeTaskList(new Map(),"TaskList",{},{tasks:[]}),null,"an empty list replacing no list changes nothing");
  assert.deepEqual([...claudeTaskList(tasks,"TaskList",{},{tasks:[]})],[],"an empty list empties one");
  assert.equal(claudeTaskList(tasks,"TaskCreate",{subject:"x"},{task:null}),null,"a created task without an id");
  assert.equal(claudeTaskList(tasks,"TaskCreate",{subject:"x"},"Task created"),null,"or a text that names none");
  assert.deepEqual(claudeTaskList(tasks,"TaskCreate",{subject:"From the input"},{task:{id:"2"}}).get("2"),entry("From the input","pending"),"the subject the call asked for");
  assert.equal(claudeTaskList(tasks,"TaskUpdate",{taskId:"1",status:"completed"},{success:false,taskId:"1"}),null);
  assert.equal(claudeTaskList(tasks,"TaskUpdate",{taskId:"1",status:"done"},{success:true,taskId:"1"}),null,"a status Claude Code has no such name for");
  assert.equal(claudeTaskList(tasks,"TaskGet",{taskId:"1"},{task:{id:"1",subject:"x",status:"completed"}}),null,"TaskGet only reads");
  assert.deepEqual(claudeTodoEntries({todos:"three items"}),[]);
  assert.deepEqual(claudeTodoEntries(null),[]);
});
