// The edges of what a Claude Code session reads from Claude Code, as Trebell's requirements for it say: the task list from the
// task tools' text and from Claude Code's own files, the approval card's text, usage windows and their waits, a result's failure,
// a turn Claude Code says was interrupted, a steer past a subagent move that is still open, and an MCP registration Claude Code
// answers with an error. The SDK is scripted: nothing runs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_USAGE_LIMIT_HINT,
  ClaudeAgentSession,
  claudePermissionPrompt,
  claudeLimitHolds,
  claudeRefusedWindow,
  claudeResultFailure,
  claudeSessionGrant,
  claudeTaskList,
  claudeUsageLimitHint,
  claudeUsagePauseNotice,
  readClaudeTaskStore,
} from "../src/claude-agent-session.mjs";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let round=0;round<200&&!check();round++)await tick();assert.ok(check(),"the session got there")}
const entries=map=>map===null?null:[...map];
// What the card sets between a command or path and Claude Code's own sentence: a middle dot between spaces (U+00B7).
const GAP=" · ";

test("TaskCreate's text names the task only in Claude Code's own sentence, and a created id the list has is replaced in its place",()=>{
  const tasks=new Map([["1",{content:"Write",status:"completed"}],["2",{content:"Test",status:"in_progress"}]]);
  assert.deepEqual(entries(claudeTaskList(tasks,"TaskCreate",{subject:"Ignored"},"  Task #7 created successfully:  Ship it  \n")),[...tasks,["7",{content:"Ship it",status:"pending"}]]);
  assert.deepEqual(entries(claudeTaskList(tasks,"TaskCreate",{},"Task #7 created successfully: two\nlines")).at(-1),["7",{content:"two\nlines",status:"pending"}]);
  for(const text of ["Task #7 created successfully:","Task # created successfully: x","Task #7\tcreated successfully: x","Task #7  created successfully: x","task #7 created successfully: x","Task #7 created successfully:x"])
    assert.equal(claudeTaskList(tasks,"TaskCreate",{subject:"From the input"},text),null,text);
  assert.deepEqual(entries(claudeTaskList(tasks,"TaskCreate",{},{task:{id:"1",subject:"Write again"}})),[["1",{content:"Write again",status:"pending"}],["2",{content:"Test",status:"in_progress"}]]);
});

test("TaskUpdate finds its task by the input's id, else the result's, and changes only what it names",()=>{
  const tasks=new Map([["1",{content:"Write",status:"pending"}],["2",{content:"Test",status:"pending"}]]);
  assert.deepEqual(entries(claudeTaskList(tasks,"TaskUpdate",{status:"completed"},{success:true,taskId:"2"})),[["1",{content:"Write",status:"pending"}],["2",{content:"Test",status:"completed"}]]);
  assert.deepEqual(entries(claudeTaskList(tasks,"TaskUpdate",{taskId:" 1 ",subject:" Write the parser "},"Updated task #1 subject")),[["1",{content:"Write the parser",status:"pending"}],["2",{content:"Test",status:"pending"}]]);
  assert.equal(claudeTaskList(tasks,"TaskUpdate",{taskId:"1",subject:"   ",status:"pending"},{success:true}),null,"a blank subject keeps the task's");
  assert.equal(claudeTaskList(tasks,"TaskUpdate",{taskId:"1",status:"completed"},"Task #1 is blocked"),null,"a refusal");
  assert.deepEqual(entries(claudeTaskList(tasks,"TaskUpdate",{taskId:"2",status:"deleted"},undefined)),[["1",{content:"Write",status:"pending"}]],"no result to refuse it");
  assert.equal(tasks.size,2,"the list given is never changed");
});

test("Claude Code's own task files are read in number order, an unreadable folder is no list, and only bookkeeping metadata is left out",()=>{
  const folder=mkdtempSync(join(tmpdir(),"trebell-claude-edges-"));
  try{
    const write=(name,task)=>writeFileSync(join(folder,name),JSON.stringify(task));
    write("10.json",{id:"10",subject:"Ten",status:"pending"});
    write("9.json",{id:"9",subject:"Nine",status:"completed",metadata:{owner:"team",_internal:false}});
    write("02.json",{id:"2",subject:"Two",status:"in_progress"});
    write("3.json",{id:"3",subject:"Null metadata",status:"pending",metadata:null});
    write("4.json",{id:"4",subject:"Text metadata",status:"pending",metadata:"x"});
    write("5.json",{id:5,subject:"A number id",status:"pending"});
    write("6.JSON",{id:"6",subject:"Upper case name",status:"pending"});
    write("task-7.json",{id:"7",subject:"Not numbered",status:"pending"});
    writeFileSync(join(folder,"8.json"),"[1,2]");
    assert.deepEqual(entries(readClaudeTaskStore(folder)),[["2",{content:"Two",status:"in_progress"}],["9",{content:"Nine",status:"completed"}],["10",{content:"Ten",status:"pending"}]]);
    assert.equal(readClaudeTaskStore(join(folder,"missing")),null);
    assert.equal(readClaudeTaskStore(join(folder,"10.json")),null,"a file is no folder");
  }finally{rmSync(folder,{recursive:true,force:true})}
});

test("the approval card names what the call acts on from Claude Code's documented fields, cuts what it shows, and adds Claude Code's reason when it is new",()=>{
  // The command first, then the file, the notebook and the folder; a field with no text is passed over.
  assert.equal(claudePermissionPrompt("Bash",{command:"  make test  ",file_path:"Makefile"},{}),"Bash: make test");
  assert.equal(claudePermissionPrompt("Read",{path:"a.txt",file_path:"b.txt"},{}),"Read: b.txt");
  assert.equal(claudePermissionPrompt("NotebookEdit",{notebook_path:"/repo/a.ipynb",path:"/repo"},{}),"NotebookEdit: /repo/a.ipynb");
  assert.equal(claudePermissionPrompt("Grep",{command:"  ",pattern:"TODO",path:"src"},{}),"Grep: src");
  // Fields no Claude Code tool has name nothing: the input shows.
  assert.equal(claudePermissionPrompt("Read",{filename:"c.txt"},{}),'Read: {"filename":"c.txt"}');
  assert.equal(claudePermissionPrompt("Bash",{cmd:"make"},{}),'Bash: {"cmd":"make"}');
  assert.equal(claudePermissionPrompt("Write",{file_path:"notes.txt"},{decisionReason:"Writes outside the folder need approval"}),`Write: notes.txt${GAP}Writes outside the folder need approval`,"the reason is the sentence when Claude Code gives no other");
  assert.equal(claudePermissionPrompt("Write",{file_path:"notes.txt"},{title:"Claude wants to write notes.txt",decisionReason:"Outside the folder"}),"Claude wants to write notes.txt (Outside the folder)");
  assert.equal(claudePermissionPrompt("Write",{file_path:"notes.txt"},{title:"Claude wants to write notes.txt",decisionReason:"notes.txt"}),"Claude wants to write notes.txt");
  assert.equal(claudePermissionPrompt("Write",{file_path:"notes.txt"},{description:"Claude will write notes.txt"}),"Claude will write notes.txt","the subtitle stands for a missing title");
  // At most 500 characters of a command, a reason or an input; a cut one ends in three dots.
  assert.equal(claudePermissionPrompt("Bash",{command:"c".repeat(500)},{}),"Bash: "+"c".repeat(500));
  assert.equal(claudePermissionPrompt("Bash",{command:"c".repeat(550)},{}),"Bash: "+"c".repeat(497)+"...");
  assert.equal(claudePermissionPrompt("Fetch",{url:"https://example.com"},{decisionReason:"r".repeat(550)}),"r".repeat(497)+"...");
  const fits={q:"x".repeat(492)},over={q:"x".repeat(493)};
  assert.equal(JSON.stringify(fits).length,500);
  assert.equal(claudePermissionPrompt(undefined,fits,{}),"Tool: "+JSON.stringify(fits));
  assert.equal(claudePermissionPrompt("T",over,{}),"T: "+JSON.stringify(over).slice(0,497)+"...");
  assert.equal(claudePermissionPrompt("T",{n:1n},{}),"T: ","an input with no JSON form");
  assert.equal(claudePermissionPrompt("T",undefined,{}),"T: {}");
  assert.equal(claudePermissionPrompt("Bash",{command:"ls"},{title:"\u001b[1mList the folder\u001b[0m"}),`Bash: ls${GAP}List the folder`,"terminal escapes are no part of Claude Code's sentence");
});

test("Allow for this session grants every suggestion in the session only, and with none allows the tool there",()=>{
  const suggestions=[{type:"addDirectories",directories:["/shared"],destination:"projectSettings"},{type:"setMode",mode:"acceptEdits",destination:"userSettings"}];
  assert.deepEqual(claudeSessionGrant("Read",suggestions),[
    {type:"addDirectories",directories:["/shared"],destination:"session"},{type:"setMode",mode:"acceptEdits",destination:"session"},
  ]);
  assert.deepEqual(suggestions.map(update=>update.destination),["projectSettings","userSettings"],"the suggestions given stay as they were");
  for(const none of ["not a list",undefined,[]])assert.deepEqual(claudeSessionGrant("Read",none),[{type:"addRules",rules:[{toolName:"Read"}],behavior:"allow",destination:"session"}]);
});

test("a cancelled approval denies the call and stops the turn; a declined one only denies it",async()=>{
  const answers=["cancel","decline"];
  const {sdk,calls}=scriptedClaudeSdk();
  const claude=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:()=>{},onPermission:async()=>answers.shift()});
  await claude.start();await claude.prompt([{type:"text",text:"go"}]);
  const canUse=calls[0].options.canUseTool,options={toolUseID:"tool-1",suggestions:[]};
  assert.deepEqual(await canUse("Bash",{command:"rm -rf build"},options),{behavior:"deny",message:"The approval for this tool call was cancelled in Trebell Code before the user answered, so it did not run.",toolUseID:"tool-1",decisionClassification:"user_reject",interrupt:true});
  assert.deepEqual(await canUse("Bash",{command:"rm -rf build"},options),{behavior:"deny",message:"The user denied this tool call in Trebell Code, so it did not run.",toolUseID:"tool-1",decisionClassification:"user_reject"});
  // Stop aborts a request nobody answered: it is cancelled.
  const stopped=new AbortController();stopped.abort();
  const never=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:()=>{},onPermission:()=>new Promise(()=>{})});
  await never.start();await never.prompt([{type:"text",text:"go"}]);
  const aborted=await calls[1].options.canUseTool("Bash",{command:"ls"},{...options,signal:stopped.signal});
  assert.equal(aborted.interrupt,true);assert.match(aborted.message,/cancelled in Trebell Code/);
  await claude.close();await never.close();
});

test("a usage window's wait reads in whole minutes, rounded up, and only within 30 days; an unknown window is the usage allowance",()=>{
  const now=1_800_000_000_000,at=seconds=>now/1000+seconds;
  const paused=(info)=>claudeUsagePauseNotice(info,now);
  assert.equal(paused({rateLimitType:"seven_day_opus",resetsAt:at(45*60-30)}),"Claude Code has used up its weekly Opus allowance. The turn waits until it resets, in 45 min.");
  assert.equal(paused({rateLimitType:"seven_day",resetsAt:at(2*3600)}),"Claude Code has used up its weekly allowance. The turn waits until it resets, in 2 h.");
  assert.equal(paused({rateLimitType:"overage",resetsAt:at(3600+1)}),"Claude Code has used up its extra usage. The turn waits until it resets, in 1 h 1 min.");
  assert.equal(paused({rateLimitType:"seven_day_overage_included",resetsAt:at(-60)}),"Claude Code has used up its weekly allowance, extra usage included. The turn waits until it resets.");
  assert.equal(paused({rateLimitType:"weekly",resetsAt:at(31*86400)}),"Claude Code has used up its usage allowance. The turn waits until it resets.");
  assert.equal(paused({rateLimitType:"seven_day_sonnet",resetsAt:String(at(30*86400))}),"Claude Code has used up its weekly Sonnet allowance. The turn waits until it resets, in 720 h.");
  assert.equal(paused({rateLimitType:"five_hour",resetsAt:at(1)}),"Claude Code has used up its five-hour allowance. The turn waits until it resets, in 1 min.","a second rounds up to a minute");
  assert.equal(paused({rateLimitType:"five_hour",resetsAt:at(0)}),"Claude Code has used up its five-hour allowance. The turn waits until it resets.","a reset that is now is no wait");
  assert.equal(paused({rateLimitType:"five_hour",resetsAt:at(30*86400+1)}),"Claude Code has used up its five-hour allowance. The turn waits until it resets.","a second past 30 days is no wait");
  // Types the SDK does not list are the usage allowance, whatever they look like.
  for(const type of ["five_hour_opus","seven_day_haiku","seven_day_","","OVERAGE",undefined])assert.equal(paused({rateLimitType:type}),"Claude Code has used up its usage allowance. The turn waits until it resets.",String(type));
  assert.equal(paused(null),"Claude Code has used up its usage allowance. The turn waits until it resets.");
  assert.equal(claudeUsageLimitHint([{rateLimitType:"five_hour",resetsAt:at(600)},{rateLimitType:"seven_day",resetsAt:at(5400)}],now),"Claude Code has used up its usage allowance. Try the message again when it resets, in 1 h 30 min.","the latest reset, no single window");
  assert.equal(claudeUsageLimitHint([{rateLimitType:"seven_day",resetsAt:at(5400)},{rateLimitType:"five_hour",resetsAt:at(600)}],now),"Claude Code has used up its usage allowance. Try the message again when it resets, in 1 h 30 min.","the latest reset in any order");
  assert.equal(claudeUsageLimitHint([{rateLimitType:"five_hour",resetsAt:at(600)}],now),"Claude Code has used up its five-hour allowance. Try the message again when it resets, in 10 min.","a single window is named");
  assert.equal(claudeUsageLimitHint([{rateLimitType:"five_hour",resetsAt:at(600)},{rateLimitType:"seven_day",resetsAt:at(31*86400)}],now),CLAUDE_USAGE_LIMIT_HINT,"a latest reset past 30 days");
  assert.equal(claudeUsageLimitHint([{rateLimitType:"five_hour",resetsAt:at(600)},{rateLimitType:"seven_day"}],now),CLAUDE_USAGE_LIMIT_HINT,"a window that names no reset");
  assert.equal(claudeUsageLimitHint([{rateLimitType:"five_hour",resetsAt:at(600)},null],now),CLAUDE_USAGE_LIMIT_HINT,"a window that is no record");
  assert.equal(claudeUsageLimitHint([],now),CLAUDE_USAGE_LIMIT_HINT);
});

// A rate_limit_event of a refused five-hour window, with what info adds or changes.
const refusedFrame=info=>({type:"rate_limit_event",rate_limit_info:{status:"rejected",rateLimitType:"five_hour",...info}});
test("overage that carries the account past a window is no rejection, and only a usage-limit end agrees with the evidence",()=>{
  assert.equal(claudeRefusedWindow(refusedFrame({overageStatus:"allowed_warning"})),null);
  assert.equal(claudeRefusedWindow(refusedFrame({overageStatus:"allowed"})),null);
  assert.equal(claudeRefusedWindow(refusedFrame({isUsingOverage:true})),null);
  assert.equal(claudeRefusedWindow(refusedFrame({overageInUse:true})),null);
  assert.deepEqual(claudeRefusedWindow(refusedFrame({overageStatus:"rejected",isUsingOverage:"true"})),refusedFrame({overageStatus:"rejected",isUsingOverage:"true"}).rate_limit_info);
  const refused=refusedFrame({});assert.equal(claudeRefusedWindow(refused),refused.rate_limit_info,"the window as the frame carried it");
  assert.equal(claudeRefusedWindow({type:"assistant",error:"server_error",api_error_params:{rate_limit_info:{status:"rejected"}}}),null);
  const blocked={type:"assistant",error:"rate_limit",api_error_params:{rate_limit_info:{status:"rejected",rateLimitType:"seven_day"}}};
  assert.equal(claudeRefusedWindow(blocked),blocked.api_error_params.rate_limit_info);
  // No window, a window that is no record, a window that lets requests through, a frame of another kind, no frame: nothing refused.
  const noRefusal=[refusedFrame({status:"allowed_warning"}),{...refusedFrame({}),rate_limit_info:"rejected"},{...refusedFrame({}),rate_limit_info:undefined},{...refusedFrame({}),type:"user"},null];
  for(const frame of noRefusal)assert.equal(claudeRefusedWindow(frame),null,JSON.stringify(frame));
  assert.equal(claudeLimitHolds({subtype:"success",api_error_status:400,terminal_reason:"api_error"},true),false,"another status");
  assert.equal(claudeLimitHolds({subtype:"error_during_execution",api_error_status:400,terminal_reason:"api_error"},true),true);
  assert.equal(claudeLimitHolds({subtype:"success",terminal_reason:"model_error"},true),false,"another end");
  assert.equal(claudeLimitHolds({subtype:"success",terminal_reason:"blocking_limit"},false),false,"no evidence");
  assert.equal(claudeLimitHolds({subtype:"success",api_error_status:429,terminal_reason:null},true),true);
  assert.equal(claudeLimitHolds({subtype:"success",api_error_status:null},true),true);
  assert.equal(claudeLimitHolds({subtype:"error_during_execution",terminal_reason:"max_turns"},true),false,"no end a limit gives");
  assert.equal(claudeLimitHolds(undefined,true),true,"no result says otherwise");
});

test("a window Claude Code lets requests through again, or that the extra usage covers, no longer makes the turn a usage limit",async()=>{
  const failure=async frames=>{
    const {sdk}=scriptedClaudeSdk({turn:({message,emit})=>{for(const frame of frames)emit(frame);emit({type:"result",subtype:"success",is_error:true,terminal_reason:"blocking_limit",result:"",user_message_uuid:message.uuid})}});
    const claude=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:()=>{}});await claude.start();
    const error=await claude.prompt([{type:"text",text:"go"}]).then(()=>null,failed=>failed);
    await claude.close();return error?.message;
  };
  const window=info=>({type:"rate_limit_event",rate_limit_info:{rateLimitType:"five_hour",...info}});
  const tooLong="Claude Code ended the turn: this thread has grown past the model's context window. Compact it with /compact, or continue in a new thread.";
  assert.equal(await failure([window({status:"rejected"})]),CLAUDE_USAGE_LIMIT_HINT);
  assert.equal(await failure([window({status:"rejected"}),window({status:"allowed"})]),tooLong);
  assert.equal(await failure([window({status:"rejected"}),window({status:"rejected",overageInUse:true})]),tooLong);
  assert.equal(await failure([window({status:"rejected"}),window({status:"allowed",rateLimitType:"seven_day"})]),CLAUDE_USAGE_LIMIT_HINT,"another window passing is no answer for this one");
});

test("a result's failure: what is no success names its listed error or its end, and a success fails only as its end or error says",()=>{
  assert.equal(claudeResultFailure({subtype:"error_max_turns",errors:["  ","[ede_diagnostic] x"]}),"Claude Code ended the turn with an error (error_max_turns).");
  assert.equal(claudeResultFailure({subtype:"error_during_execution",terminal_reason:"image_error",errors:[]}),"Claude Code ended the turn because an image in this thread could not be read.");
  assert.equal(claudeResultFailure({errors:[]}),"Claude Code ended the turn with an error.");
  assert.equal(claudeResultFailure({subtype:"error_during_execution",terminal_reason:"api_error",result:"API Error: 500"},{explainedError:"Your credit balance is too low."}),"Your credit balance is too low.");
  assert.equal(claudeResultFailure({subtype:"error_during_execution",terminal_reason:"api_error",result:"API Error: 500"}),"Claude Code ended the turn after its requests to the Claude API failed again and again.","no API words read from a result that is no success");
  assert.equal(claudeResultFailure({subtype:"success",is_error:false,terminal_reason:"completed",result:"Done."}),null);
  assert.equal(claudeResultFailure({subtype:"success",is_error:false,terminal_reason:"budget_exhausted"}),"Claude Code ended the turn when it reached its token budget.");
  assert.equal(claudeResultFailure({subtype:"success",is_error:true,result:"  The hook stopped it.  "}),"The hook stopped it.");
  assert.equal(claudeResultFailure({subtype:"success",is_error:true,result:""},{explainedError:"Explained."}),"Explained.");
  assert.equal(claudeResultFailure({subtype:"success",is_error:true}),"Claude Code ended the turn with an error.");
  assert.equal(claudeResultFailure(null),null);
  // Every end reason the SDK lists that names a failure of its own has a sentence of its own; the others say nothing.
  const said=new Map();
  for(const reason of ["malformed_tool_use_exhausted","budget_exhausted","structured_output_retry_exhausted","tool_deferred_unavailable","turn_setup_failed","rapid_refill_breaker","prompt_too_long","image_error","model_error"]){
    const text=claudeResultFailure({subtype:"success",is_error:false,terminal_reason:reason});
    assert.match(text,/^Claude Code .+\.$/,reason);said.set(text,reason);
  }
  assert.equal(said.size,9,"each its own sentence");
  for(const reason of ["completed","max_turns","aborted_streaming","aborted_tools","stop_hook_prevented","hook_stopped","tool_deferred","background_requested",undefined])
    assert.equal(claudeResultFailure({subtype:"success",is_error:false,terminal_reason:reason}),null,String(reason));
  // The API's own status says more than the end reason on a success, and a listed error more than both.
  assert.equal(claudeResultFailure({subtype:"success",is_error:true,api_error_status:529,terminal_reason:"api_error",result:"API Error: 529 Overloaded, try later"}),"The Claude API is overloaded right now (HTTP 529). Wait a moment, then send the message again.");
  assert.equal(claudeResultFailure({subtype:"success",is_error:true,api_error_status:429,errors:["Quota hook refused"]}),"Quota hook refused");
  assert.equal(claudeResultFailure({subtype:"success",is_error:true,api_error_status:500,terminal_reason:"api_error",result:"API Error: 500 boom"},{knownCause:"Signed out."}),"Signed out.");
});

test("a turn Claude Code says was interrupted or cancelled ends cancelled, not failed",async()=>{
  for(const said of ["Request was Interrupted by user","Operation CANCELLED"]){
    const {sdk}=scriptedClaudeSdk({turn:({message,emit})=>emit({type:"result",subtype:"error_during_execution",is_error:true,errors:[said],user_message_uuid:message.uuid})});
    const claude=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:()=>{}});await claude.start();
    assert.equal((await claude.prompt([{type:"text",text:"go"}])).stopReason,"cancelled",said);
    await claude.close();
  }
  const {sdk}=scriptedClaudeSdk({turn:({message,emit})=>emit({type:"result",subtype:"error_during_execution",is_error:true,errors:["The pre-tool hook refused the edit"],user_message_uuid:message.uuid})});
  const claude=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:()=>{}});await claude.start();
  await assert.rejects(claude.prompt([{type:"text",text:"go"}]),/The pre-tool hook refused the edit/);
  await claude.close();
});

test("a steer while an earlier steer's subagent move is still open waits on that move instead of asking again",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const {sdk,calls}=scriptedClaudeSdk({control:{backgroundTasks:()=>new Promise(()=>{})},turn:({message,index,emit})=>{
    if(index>0)return;
    emit({type:"assistant",uuid:"launch",parent_tool_use_id:null,message:{id:"m-launch",content:[{type:"tool_use",id:"toolu_review",name:"Agent",input:{description:"Review",prompt:"Review it"}}]}});
  }});
  const updates=[],claude=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:({update})=>updates.push(update)});await claude.start();
  void claude.prompt([{type:"text",text:"Review the parser"}]).catch(()=>{});
  await until(()=>updates.some(update=>update.toolCallId==="toolu_review"));
  const first=claude.steer([{type:"text",text:"Use tabs"}]);
  await until(()=>calls[0].log.some(entry=>entry[0]==="backgroundTasks"));
  t.mock.timers.tick(2_000);await tick();
  const second=claude.steer([{type:"text",text:"And spaces in YAML"}]);
  await tick();
  // Re-pinned note: each hold is Trebell's own 8 s now (it was 5 s), so the first steer goes 6 s after the second is sent.
  t.mock.timers.tick(6_000);
  assert.deepEqual(await first,{accepted:true,pending:0});
  t.mock.timers.tick(2_000);
  assert.deepEqual(await second,{accepted:true,pending:0});
  assert.deepEqual(calls[0].log.map(entry=>entry[0]==="input"?`input:${entry[1].priority||"next"}`:entry[0]),["input:next","backgroundTasks","input:now","input:now"],"asked once, each steer sent after its own hold");
  await claude.close();
});

test("an MCP registration Claude Code answers with an error is done, and the prompt goes to Claude Code",async()=>{
  const {sdk,calls}=scriptedClaudeSdk({control:{setMcpServers:async()=>{throw new Error("server failed to start")}}});
  const claude=new ClaudeAgentSession({cwd:"/repo",sdk,onUpdate:()=>{},mcpServers:{docs:{type:"stdio",command:"docs-mcp"}}});await claude.start();
  assert.equal((await claude.prompt([{type:"text",text:"hi"}])).stopReason,"end_turn");
  assert.deepEqual(calls[0].log.map(entry=>entry[0]),["setMcpServers","input"]);
  await claude.close();
});
