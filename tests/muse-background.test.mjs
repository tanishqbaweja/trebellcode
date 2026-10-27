import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as muse from "../src/muse-agent-session.mjs";
import { FakeMuse, ReplayMuse, event, itemFrame, settlesWithin, startSession, until } from "./fixtures/muse/fake-host.mjs";
import { eventually, museRelay } from "./fixtures/muse/relay-harness.mjs";

// Muse Code's work that runs past its turn (T3 c1d528a34, d81afa0a6, 6ba6a0daf, 519d64f6c): subagents and workflows as rows, the todo
// list as the turn's plan, the report turns Muse starts itself, and the relay's idle sweep keeping a session while that work runs.
// Sessions run on a fake `muse serve` and on T3's recorded sessions (fixtures/muse/workflow, subagent and subagent_interrupt, from its
// muse_workflow, subagent_v2 and muse_subagent_interrupt transcripts); the relay test on the stand-in Muse Code (fake-muse.cjs).

// A session whose updates keep the turn they name (turnKey) and whether work still ran then, with the report turns it started.
async function workSession({muse:host=child=>new FakeMuse(child),options={},...rest}={}){
  const seen=[],wakes=[],box={};
  const fixture=await startSession({muse:host,...rest,options:{...options,onUpdate:params=>seen.push({...params,pending:box.session?.pendingBackgroundWork}),onWakeTurn:promise=>{wakes.push(promise)}}});
  box.session=fixture.session;
  return {...fixture,seen,wakes};
}
const rowsOf=(seen,id)=>seen.filter(entry=>entry.update.toolCallId===id).map(entry=>entry.update);
const replyOf=(seen,turnKey)=>seen.filter(entry=>entry.update.sessionUpdate==="agent_message_chunk"&&(turnKey===undefined||entry.turnKey===turnKey)).map(entry=>entry.update.content.text).join("");
async function runningTurn(fixture,text="go"){
  const running=fixture.session.prompt([{type:"text",text}]);
  const {params:{commandId:turnId}}=await fixture.muse.next("turn/start");
  return {running,turnId,sid:fixture.session.sessionId};
}
const complete=(fixture,turnId,terminal="completed",extra={})=>fixture.muse.notify("turn/completed",{sessionId:fixture.session.sessionId,viewCursor:"v",terminal,turnId,...extra});
const workflowItem=(turnId,revision,children,fields={})=>({itemId:"wf-1",kind:"workflow",revision,status:"inProgress",turnId,entryId:"Probe workflow",children,...fields});
const REPORT="01a12d5d-6ba0-75d1-aa8f-0d40852d8721";

test("T3's recorded workflow: its row runs on past the turn that launched it, one row per agent keeps its label and first end, and Muse's report on it is a turn of its own",async()=>{
  const fixture=await workSession({muse:child=>new ReplayMuse(child,"workflow"),permissionMode:"full"});
  const {session,seen,wakes}=fixture;
  const result=await session.prompt([{type:"text",text:"Run a workflow with two agents, ping and pong."}]);
  assert.equal(result.stopReason,"end_turn");
  const turnId=fixture.muse.frames.find(frame=>frame.method==="turn/start").params.commandId;
  await until(()=>wakes.length===1,"Muse's report turn");
  assert.equal((await settlesWithin(wakes[0],5000,"the report turn")).stopReason,"end_turn");
  // The workflow's row: running when its turn ended, then done with Muse's final summary, all in the turn that launched it.
  const workflow=rowsOf(seen,"e1f5bbdc-9a2d-52c5-8501-9b6ef280aa94");
  assert.deepEqual(workflow.map(row=>[row.sessionUpdate,row.status,row.title,row.rawOutput]),[
    ["tool_call","in_progress","Workflow ping-pong","Workflow: model-chosen generated workflow"],
    ["tool_call_update","completed","Workflow ping-pong","{\"status\":\"ok\"}"],
  ]);
  assert.ok(seen.filter(entry=>entry.update.toolCallId?.startsWith("e1f5bbdc")).every(entry=>entry.turnKey===turnId),"every row of it names the turn that launched it");
  // Each agent: scheduled is pending, started runs and done once, under its label though later revisions leave it out.
  const ping=rowsOf(seen,"e1f5bbdc-9a2d-52c5-8501-9b6ef280aa94:agent:01a12d5d-5e54-7f10-a55a-9537347f2ad8");
  assert.deepEqual(ping.map(row=>[row.status,row.title]),[["pending","Workflow ping-pong · ping"],["in_progress","Workflow ping-pong · ping"],["completed","Workflow ping-pong · ping"]]);
  const pong=rowsOf(seen,"e1f5bbdc-9a2d-52c5-8501-9b6ef280aa94:agent:01a12d5d-5ef4-72b3-aeed-f42a5925a87b");
  assert.deepEqual(pong.map(row=>[row.status,row.title]),[["pending","Workflow ping-pong · pong"],["in_progress","Workflow ping-pong · pong"],["completed","Workflow ping-pong · pong"]]);
  // The launch tool and Muse's reminder children are no rows of their own.
  assert.equal(seen.some(entry=>entry.update.toolCallId==="01a12d5d-5cfd-72f3-bfab-d3f27075df9a"),false);
  // While the workflow ran past its turn the session had work pending; its report came as a turn of Muse's own, and then none was left.
  const firstAgent=seen.findIndex(entry=>entry.update.toolCallId?.includes(":agent:"));
  assert.equal(seen[firstAgent].pending,true);
  assert.equal(replyOf(seen,REPORT),"The workflow with `ping` and `pong` agents is complete.");
  assert.equal(replyOf(seen,turnId),"");
  assert.equal(session.pendingBackgroundWork,false);
  assert.equal(session.busy,false);
  assert.deepEqual(fixture.muse.unexpected,[]);
  await session.close();
});

test("a workflow agent that completed with a failure kind is failed, with it as its result; one cancelled or left unended by its workflow's failure fails too",async()=>{
  const fixture=await workSession(),{running,turnId,sid}=await runningTurn(fixture);
  const child=(childId,fields)=>({childId,attempt:1,...fields});
  fixture.muse.write(itemFrame("item/started",sid,workflowItem(turnId,1,[child("c1",{status:"finished",terminal:"completed",failureKind:"budget_exhausted"}),child("c2",{status:"started",label:"second"})])));
  fixture.muse.write(itemFrame("item/updated",sid,workflowItem(turnId,2,[child("c1",{status:"finished",terminal:"completed",failureKind:"budget_exhausted"}),child("c2",{status:"terminal",terminal:"cancelled"}),child("c3",{status:"scheduled",label:"third"})])));
  fixture.muse.write(itemFrame("item/completed",sid,workflowItem(turnId,3,[child("c1",{status:"finished",terminal:"completed",failureKind:"budget_exhausted"}),child("c2",{status:"terminal",terminal:"cancelled"}),child("c3",{status:"scheduled"})],{status:"failed",failureReason:"the workflow script threw"})));
  complete(fixture,turnId);await running;
  const last=id=>rowsOf(fixture.seen,"wf-1:agent:"+id).at(-1);
  assert.deepEqual([last("c1").status,last("c1").title,last("c1").rawOutput],["failed","Workflow Probe workflow · agent 1: budget_exhausted","budget_exhausted"]);
  assert.deepEqual([last("c2").status,last("c2").title],["failed","Workflow Probe workflow · second: Muse Code reported cancelled."]);
  assert.deepEqual([last("c3").status,last("c3").title],["failed","Workflow Probe workflow · third: The workflow ended before this agent finished."]);
  assert.deepEqual([rowsOf(fixture.seen,"wf-1").at(-1).status,rowsOf(fixture.seen,"wf-1").at(-1).title],["failed","Workflow Probe workflow: the workflow script threw"]);
  assert.equal(rowsOf(fixture.seen,"wf-1:agent:c1").length,1,"a settled agent is sent once, however often Muse sends it again");
  // The pure mapping: a scheduled agent is pending, and the last label stays.
  const labels=new Map();
  assert.deepEqual(muse.museWorkflowAgentUpdates?.(workflowItem("t",1,[child("x",{status:"scheduled",label:"ping"})]),labels).map(row=>[row.status,row.title]),[["pending","Workflow Probe workflow · ping"]]);
  assert.deepEqual(muse.museWorkflowAgentUpdates?.(workflowItem("t",2,[child("x",{status:"started"})]),labels).map(row=>[row.status,row.title]),[["in_progress","Workflow Probe workflow · ping"]]);
  await fixture.session.close();
});

test("T3's recorded subagent: one row titled by its role, done once its result is ready though Muse's item still runs, with its objective as its prompt and its result as its output; the child's own reply is not the turn's",async()=>{
  const fixture=await workSession({muse:child=>new ReplayMuse(child,"subagent"),permissionMode:"full"});
  const result=await fixture.session.prompt([{type:"text",text:"Spawn one subagent that replies Hello."}]);
  assert.equal(result.stopReason,"end_turn");
  const agent=rowsOf(fixture.seen,"01a12d17-81f1-7990-b8c5-4aec1f46ac18");
  assert.deepEqual(agent.map(row=>[row.status,row.title,row.rawOutput]),[["in_progress","Subagent · hello agent",""],["completed","Subagent · hello agent","Hello"]]);
  assert.deepEqual(agent[0].rawInput,{objective:"Reply with exactly: Hello",role:"hello agent"});
  assert.equal(replyOf(fixture.seen),"Hello","the child session's own reply is not the turn's");
  assert.equal(fixture.session.pendingBackgroundWork,false,"a subagent whose result is ready holds nothing");
  assert.equal(muse.museWorkStatus?.({kind:"subagent",status:"inProgress",controlStatus:"resultReady"}),"completed");
  assert.deepEqual(fixture.muse.unexpected,[]);
  await fixture.session.close();
});

test("Muse's todo list is the turn's plan, pending, in progress or done, without the steps Muse cancelled or left blank; an empty list clears it, and write_todos is no row",async()=>{
  const fixture=await workSession(),{running,turnId,sid}=await runningTurn(fixture);
  fixture.muse.write(itemFrame("item/completed",sid,{itemId:"todo-tool",turnId,kind:"toolCall",tool:"write_todos",revision:1,status:"completed"}));
  fixture.muse.write(event("session/todoListChanged",sid,{items:[{text:" Investigate ",status:"completed"},{text:"Fix",status:"inProgress"},{text:"Discarded",status:"cancelled"},{text:"  ",status:"pending"},{text:"Test",status:"pending"}],revision:1,sourceTool:"write_todos",sourceRange:{}}));
  fixture.muse.write(event("session/todoListChanged",sid,{items:[],revision:2,sourceTool:"write_todos",sourceRange:{}}));
  complete(fixture,turnId);await running;
  const plans=fixture.seen.filter(entry=>entry.update.sessionUpdate==="plan");
  assert.deepEqual(plans.map(entry=>entry.update.entries),[[{content:"Investigate",status:"completed"},{content:"Fix",status:"in_progress"},{content:"Test",status:"pending"}],[]]);
  assert.ok(plans.every(entry=>entry.turnKey===turnId));
  assert.equal(rowsOf(fixture.seen,"todo-tool").length,0);
  await fixture.session.close();
});

test("a turn Muse starts while none runs is a turn of its own: the report streams and ends on its turn/completed, the session holds it as pending work, and a late copy of a turn that ended starts nothing",async()=>{
  const fixture=await workSession(),{session,seen,wakes}=fixture,{running,turnId,sid}=await runningTurn(fixture);
  complete(fixture,turnId);await running;
  fixture.muse.write(event("turn/started",sid,{turnId:REPORT,commandId:REPORT}));
  await until(()=>wakes.length===1,"the report turn");
  assert.equal(session.pendingBackgroundWork,true);assert.equal(session.busy,true);
  fixture.muse.write(itemFrame("item/started",sid,{itemId:"report-reply",kind:"agentMessage",turnId:REPORT,revision:1,status:"inProgress",text:"The workflow finished."}));
  complete(fixture,REPORT);
  assert.equal((await settlesWithin(wakes[0],5000,"the report turn")).stopReason,"end_turn");
  assert.equal(replyOf(seen,REPORT),"The workflow finished.");
  await until(()=>!session.busy,"the report turn to end");assert.equal(session.pendingBackgroundWork,false);
  // A copy of turn/started for a turn that ended (Trebell's own, or the report) starts no turn.
  fixture.muse.write(event("turn/started",sid,{turnId,commandId:turnId}));fixture.muse.write(event("turn/started",sid,{turnId:REPORT,commandId:REPORT}));
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(wakes.length,1);assert.equal(session.busy,false);
  await session.close();
});

test("a message sent while Muse's report turn runs takes it over (T3: a user turn takes a held report turn, approvals included): the report ends, its card stays to answer, its end does not end the message's turn",async()=>{
  const fixture=await workSession(),{session,seen,wakes,asks}=fixture,sid=session.sessionId;
  fixture.muse.write(event("turn/started",sid,{turnId:REPORT,commandId:REPORT}));
  await until(()=>wakes.length===1,"the report turn");
  fixture.muse.write(event("approval/requested",sid,{approvalId:"ap-report",turnId:REPORT,itemId:"ap-report",toolName:"bash",subject:{kind:"shell",command:"touch report.txt"},currentRequirementId:{approvalId:"ap-report",sourceIndex:0},
    availableChoices:[{choiceId:"allow_once",label:"Allow once",decision:"approved",scope:"once"},{choiceId:"abort",label:"Reject",decision:"abort",scope:"once"}],protectedWrite:false}));
  await until(()=>asks.length===1,"the report's approval card");
  const message=session.prompt([{type:"text",text:"And also this"}]);
  assert.equal((await settlesWithin(wakes[0],5000,"the report turn")).stopReason,"end_turn","the report ends in Trebell");
  const {params:start}=await fixture.muse.next("turn/start");
  assert.equal(start.ifBusy,"queue");
  assert.equal(asks[0].withdrawn,false,"the report's card stays");
  asks[0].answer("accept");
  const {params:decide}=await fixture.muse.next("approval/decide");
  assert.equal(decide.choiceId,"allow_once");
  fixture.muse.write(event("approval/resolved",sid,{approvalId:"ap-report",turnId:REPORT,decision:"approved",resolvedBy:"user"}));
  // The rest of the report is the message's turn, and its end does not end that turn.
  fixture.muse.write(itemFrame("item/started",sid,{itemId:"report-tail",kind:"agentMessage",turnId:REPORT,revision:1,status:"inProgress",text:"Report done."}));
  complete(fixture,REPORT);
  fixture.muse.write(itemFrame("item/started",sid,{itemId:"answer",kind:"agentMessage",turnId:start.commandId,revision:1,status:"inProgress",text:"Also done."}));
  await until(()=>replyOf(seen,start.commandId).includes("Also done."),"the message's reply");
  assert.equal(session.busy,true,"the message's turn still runs");
  complete(fixture,start.commandId);
  assert.equal((await message).stopReason,"end_turn");
  assert.equal(replyOf(seen,start.commandId),"Report done.\n\nAlso done.");
  await session.close();
});

test("a report a message takes over goes on in the message's turn from where it stopped, its earlier words and tokens left to the report's own turn, so none shows or counts twice",async()=>{
  const fixture=await workSession(),{session,seen,wakes}=fixture,sid=session.sessionId;
  fixture.muse.write(event("turn/started",sid,{turnId:REPORT,commandId:REPORT}));
  await until(()=>wakes.length===1,"the report turn");
  fixture.muse.write(itemFrame("item/started",sid,{itemId:"report-reply",kind:"agentMessage",turnId:REPORT,revision:1,status:"inProgress",text:""}));
  fixture.muse.write(event("item/delta",sid,{itemId:"report-reply",field:"text",delta:"The work is done."}));
  fixture.muse.write(event("session/tokenUsage",sid,{turnId:REPORT,usage:{inputTokens:1000,outputTokens:50,cacheReadTokens:800,reasoningTokens:5},promptTokens:1000}));
  await until(()=>replyOf(seen,REPORT)==="The work is done.","the report's first words");
  const message=session.prompt([{type:"text",text:"And this"}]);
  const report=await settlesWithin(wakes[0],5000,"the report turn");
  assert.deepEqual([report.raw.usage.inputTokens,report.raw.usage.outputTokens],[1000,50],"the report's own tokens");
  const {params:start}=await fixture.muse.next("turn/start");
  // The report's reply goes on in the same message: only what it adds is the message's turn's.
  fixture.muse.write(event("item/delta",sid,{itemId:"report-reply",field:"text",delta:" Nothing else."}));
  fixture.muse.write(event("session/tokenUsage",sid,{turnId:REPORT,usage:{inputTokens:200,outputTokens:20},promptTokens:200}));
  fixture.muse.write(itemFrame("item/completed",sid,{itemId:"report-reply",kind:"agentMessage",turnId:REPORT,revision:2,status:"completed",text:"The work is done. Nothing else."}));
  complete(fixture,REPORT,"completed",{usage:{inputTokens:1200,outputTokens:70,cacheReadTokens:800,reasoningTokens:5}});
  fixture.muse.write(event("session/tokenUsage",sid,{turnId:start.commandId,usage:{inputTokens:300,outputTokens:30},promptTokens:300}));
  fixture.muse.write(itemFrame("item/completed",sid,{itemId:"answer",kind:"agentMessage",turnId:start.commandId,revision:1,status:"completed",text:"Done too."}));
  complete(fixture,start.commandId,"completed",{usage:{inputTokens:300,outputTokens:30}});
  const result=await settlesWithin(message,5000,"the message's turn");
  // The rest of the report and the message's own reply and tokens, each once.
  assert.deepEqual([replyOf(seen,start.commandId),result.raw.usage.inputTokens,result.raw.usage.outputTokens,result.raw.usage.cachedInputTokens],[" Nothing else.\n\nDone too.",500,50,0]);
  await session.close();
});

test("a report Muse starts after the relay asked for a message's turn and before the message went joins that turn, as no turn of its own, and Stop before the message went ends both",async()=>{
  for(const stop of [false,true]){
    const fixture=await workSession(),{session,seen,wakes}=fixture,sid=session.sessionId;
    // The relay asks for the message's turn before it starts it and gathers its context (agent-relay turn/start).
    assert.equal(session.takeOverWake(),false,"no report to take over yet");
    fixture.muse.write(event("turn/started",sid,{turnId:REPORT,commandId:REPORT}));
    fixture.muse.write(itemFrame("item/started",sid,{itemId:"report-reply",kind:"agentMessage",turnId:REPORT,revision:1,status:"inProgress",text:"The workflow finished."}));
    fixture.muse.write(event("session/tokenUsage",sid,{turnId:REPORT,usage:{inputTokens:1000,outputTokens:50},promptTokens:1000}));
    await until(()=>replyOf(seen).includes("The workflow finished."),"the report's words");
    assert.equal(wakes.length,0,"the report is no turn of its own");
    const turnKey=seen.find(entry=>entry.update.sessionUpdate==="agent_message_chunk").turnKey;
    if(stop){
      await session.cancel();
      assert.deepEqual(fixture.muse.sent("turn/interrupt").map(frame=>frame.params.turnId),[REPORT],"Stop ends the report the message's turn took in");
      assert.equal(fixture.muse.sent("turn/start").length,0,"and the message never goes");
      await until(()=>!session.busy,"the message's turn to end");
      await session.close();continue;
    }
    const message=session.prompt([{type:"text",text:"And this"}]);
    const {params:start}=await fixture.muse.next("turn/start");
    assert.equal(start.commandId,turnKey,"the message goes in the turn the report's words came in");
    complete(fixture,REPORT,"completed",{usage:{inputTokens:1000,outputTokens:50}});
    fixture.muse.write(itemFrame("item/completed",sid,{itemId:"answer",kind:"agentMessage",turnId:start.commandId,revision:1,status:"completed",text:"Done too."}));
    fixture.muse.write(event("session/tokenUsage",sid,{turnId:start.commandId,usage:{inputTokens:300,outputTokens:30},promptTokens:300}));
    complete(fixture,start.commandId,"completed",{usage:{inputTokens:300,outputTokens:30}});
    const result=await settlesWithin(message,5000,"the message's turn");
    assert.equal(replyOf(seen,start.commandId),"The workflow finished.\n\nDone too.");
    assert.deepEqual([result.raw.usage.inputTokens,result.raw.usage.outputTokens],[1300,80],"the report's tokens and the message's, once each");
    assert.equal(wakes.length,0);
    await session.close();
  }
});

test("Stop ends a report turn the message's turn took in, then that turn, and a turn Muse starts while Trebell's runs joins it the same way (T3 interruptTurn)",async()=>{
  const fixture=await workSession(),{session,seen,wakes}=fixture,sid=session.sessionId;
  fixture.muse.write(event("turn/started",sid,{turnId:REPORT,commandId:REPORT}));
  await until(()=>wakes.length===1,"the report turn");
  const message=session.prompt([{type:"text",text:"Next"}]);
  const {params:start}=await fixture.muse.next("turn/start");
  // Muse starts a turn of its own while the message's turn runs: it joins it.
  const other="01a17000-0000-7000-8000-0000000000aa";
  fixture.muse.write(event("turn/started",sid,{turnId:other,commandId:other}));
  fixture.muse.write(itemFrame("item/started",sid,{itemId:"other-reply",kind:"agentMessage",turnId:other,revision:1,status:"inProgress",text:"From Muse's own turn."}));
  await until(()=>replyOf(seen,start.commandId).includes("From Muse's own turn."),"the joined turn's reply in the message's turn");
  assert.equal(wakes.length,1,"no turn of its own");
  const stopping=session.cancel();
  const interrupts=[await fixture.muse.next("turn/interrupt"),await fixture.muse.next("turn/interrupt"),await fixture.muse.next("turn/interrupt")].map(frame=>frame.params.turnId);
  assert.deepEqual(interrupts,[REPORT,other,start.commandId],"the turns it took in first, then its own");
  complete(fixture,REPORT,"cancelled");complete(fixture,other,"cancelled");complete(fixture,start.commandId,"cancelled");
  await stopping;
  const result=await message;
  assert.deepEqual([result.stopReason,result.interrupted],["cancelled",true]);
  await session.close();
});

test("T3's recorded interrupted subagent: Stop ends the turn's running subagent with it, and nothing is left pending",async()=>{
  const fixture=await workSession({muse:child=>new ReplayMuse(child,"subagent_interrupt"),permissionMode:"full"});
  const running=fixture.session.prompt([{type:"text",text:"Spawn a subagent that sleeps for 30 seconds."}]);
  await until(()=>rowsOf(fixture.seen,"01a12d28-8885-71f3-9961-b8f4d747382b").length>0,"the subagent's row");
  assert.equal(fixture.session.pendingBackgroundWork,true);
  await fixture.session.cancel();
  const result=await running;
  assert.deepEqual([result.stopReason,result.interrupted,result.raw.reason],["cancelled",true,"cancelled after tool result reconciliation"]);
  const agent=rowsOf(fixture.seen,"01a12d28-8885-71f3-9961-b8f4d747382b");
  assert.deepEqual([agent[0].status,agent[0].title],["in_progress","Subagent · sleeper"]);
  assert.deepEqual([agent.at(-1).status,agent.at(-1).title],["failed","Subagent · sleeper: Stopped with its turn."]);
  assert.equal(fixture.session.pendingBackgroundWork,false);
  assert.deepEqual(fixture.muse.unexpected,[]);
  await fixture.session.close();
});

test("a workflow still running when its turn completed settles its rows in that turn while the next turn runs, and a host that dies ends what still runs, each in its own turn",async()=>{
  const fixture=await workSession(),{session,seen,child}=fixture,first=await runningTurn(fixture);
  fixture.muse.write(itemFrame("item/started",first.sid,workflowItem(first.turnId,1,[])));
  complete(fixture,first.turnId);await first.running;
  assert.equal(session.pendingBackgroundWork,true,"the workflow runs on");
  const second=await runningTurn(fixture,"next");
  fixture.muse.write(itemFrame("item/updated",first.sid,workflowItem(first.turnId,2,[{childId:"c1",attempt:1,status:"started",label:"ping"}])));
  await until(()=>rowsOf(seen,"wf-1:agent:c1").length===1,"the agent's row");
  assert.ok(seen.filter(entry=>entry.update.toolCallId?.startsWith("wf-1")).every(entry=>entry.turnKey===first.turnId),"its rows stay in the turn that launched it");
  child.stderr.write("panic: lost the model stream\n");child.exit(1);
  await assert.rejects(second.running,/Muse Code exited unexpectedly \(code 1\): panic: lost the model stream/);
  const workflow=rowsOf(seen,"wf-1").at(-1),agent=rowsOf(seen,"wf-1:agent:c1").at(-1);
  assert.deepEqual([workflow.status,workflow.title],["failed","Workflow Probe workflow: Muse Code exited unexpectedly (code 1): panic: lost the model stream"]);
  assert.deepEqual([agent.status,agent.title],["failed","Workflow Probe workflow · ping: The workflow ended before this agent finished."]);
  assert.equal(seen.filter(entry=>entry.update.toolCallId?.startsWith("wf-1")).at(-1).turnKey,first.turnId);
  assert.equal(session.pendingBackgroundWork,false);
  await session.close();
});

test("a command Muse sends to the background holds the host until Muse tells its end (backgroundTerminalCompletion), whether its tool call settles as it goes there or only then, and its row settles with that end in the turn that ran it",async()=>{
  for(const settlesFirst of [true,false]){
    const fixture=await workSession(),{session,seen}=fixture,sid=session.sessionId;
    const {running,turnId}=await runningTurn(fixture,"Start the dev server");
    const call=(revision,status,extra={})=>({itemId:"dev",kind:"toolCall",turnId,revision,status,tool:"bash",callId:"call_dev",args:"{\"command\":\"npm run dev\"}",...extra});
    fixture.muse.write(itemFrame("item/started",sid,call(1,"inProgress")));
    fixture.muse.write(itemFrame("item/updated",sid,call(2,"inProgress",{background:true,backgroundInitiator:"timeout"})));
    if(settlesFirst)fixture.muse.write(itemFrame("item/completed",sid,call(3,"completed",{background:true,backgroundInitiator:"timeout",visibleOutput:"Running in the background."})));
    complete(fixture,turnId);await running;
    assert.equal(session.pendingBackgroundWork,true,settlesFirst?"its call settled as it went to the background, and the command runs":"its call and the command run");
    const end={itemId:"dev-finished",kind:"backgroundTerminalCompletion",turnId,revision:1,status:"completed",backgroundTerminalCompletion:{command:"npm run dev",output:"Dev server stopped.",outputTruncated:false,terminalStatus:"completed",toolCallId:"call_dev"}};
    fixture.muse.write(itemFrame("item/started",sid,end));fixture.muse.write(itemFrame("item/completed",sid,{...end,revision:2}));
    await until(()=>!session.pendingBackgroundWork,"the command's end to let the host go");
    const rows=rowsOf(seen,"dev");
    assert.deepEqual([rows.at(-1).status,rows.at(-1).rawOutput],["completed","Dev server stopped."],settlesFirst?"settled first":"settled at its end");
    assert.ok(seen.filter(entry=>entry.update.toolCallId==="dev").every(entry=>entry.turnKey===turnId),"its row stays in the turn that ran it");
    assert.equal(rowsOf(seen,"dev-finished").length,0,"its end shows no row of its own");
    await session.close();
  }
});

test("work that has said nothing for four hours holds the host no more, and each word from it renews that (T3's maximum idle pin)",async()=>{
  let clock=1_800_000_000_000;
  const fixture=await workSession({options:{now:()=>clock}}),{session}=fixture,{running,turnId,sid}=await runningTurn(fixture);
  assert.equal(muse.MUSE_MAX_IDLE_PIN_MS,4*60*60_000);
  fixture.muse.write(itemFrame("item/started",sid,workflowItem(turnId,1,[])));
  complete(fixture,turnId);await running;
  assert.equal(session.pendingBackgroundWork,true);
  clock+=muse.MUSE_MAX_IDLE_PIN_MS-1;assert.equal(session.pendingBackgroundWork,true,"just under four hours of silence");
  fixture.muse.write(itemFrame("item/updated",sid,workflowItem(turnId,2,[{childId:"c1",attempt:1,status:"scheduled",label:"ping"}])));
  await until(()=>rowsOf(fixture.seen,"wf-1:agent:c1").length===1,"the agent's row");
  clock+=muse.MUSE_MAX_IDLE_PIN_MS-1;assert.equal(session.pendingBackgroundWork,true,"its update renewed the four hours");
  clock+=2;assert.equal(session.pendingBackgroundWork,false,"four hours of silence");
  await session.close();
});

test("a report turn whose host dies fails with the host's exit, and nothing of it is left pending for the host the next message starts (T3: a dead host's report is dropped)",async()=>{
  const fixture=await workSession(),{session,wakes,child}=fixture,sid=session.sessionId;
  fixture.muse.write(event("turn/started",sid,{turnId:REPORT,commandId:REPORT}));
  await until(()=>wakes.length===1,"the report turn");
  assert.equal(session.pendingBackgroundWork,true);
  child.exit(1);
  await assert.rejects(settlesWithin(wakes[0],5000,"the report turn"),/Muse Code exited unexpectedly \(code 1\)/);
  assert.equal(session.pendingBackgroundWork,false);
  assert.equal(session.dead,true,"the next message starts a new host");
  await session.close();
});

// The workflow's own row and its agents' as a launched turn stores them, by title without a failure's detail.
const workflowRows=turn=>Object.fromEntries(turn.items.filter(item=>item.type==="dynamicToolCall").map(item=>[item.tool.replace(/:.*/,""),item.status]));
const SETTLED_WORKFLOW={"Workflow ping-pong":"completed","Workflow ping-pong · ping":"completed","Workflow ping-pong · pong":"failed"};
const turnEnds=(relay,threadId)=>relay.notifications.map((item,index)=>item.method==="turn/completed"&&item.params.threadId===threadId?index:-1).filter(index=>index>=0);
const closedAt=(relay,threadId)=>relay.notifications.findIndex(item=>item.method==="thread/closed"&&item.params.threadId===threadId);

test("through the relay, a workflow's rows stay in the turn that launched it, Muse's report is a turn of its own, and the idle sweep keeps the session while the workflow runs and lets it go after",{timeout:120_000},async()=>{
  // The idle limit leaves the report 700 ms to spare on a busy machine, and its delay stays three sweeps long, so a session idle since
  // the launching turn (without the workflow's end counting as use) is swept before the report starts.
  const relay=await museRelay("trebell-muse-background-",{environment:{MUSE_FAKE_WORKFLOW_MS:"400",MUSE_FAKE_REPORT_DELAY_MS:"300"},env:{TREBELL_AGENT_SESSION_IDLE_MS:"1000",TREBELL_AGENT_SESSION_SWEEP_MS:"100"}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please run workflow ping-pong"}]});
    // Muse reports once the workflow is done, in a turn of its own; the session was not swept while the workflow ran (2.4 s, past two
    // idle limits), nor in the moments between the workflow's end and Muse's report (300 ms, three sweeps), as its end counts as use.
    await relay.completed(thread.id,2);
    const ends=turnEnds(relay,thread.id),closed=closedAt(relay,thread.id);
    assert.ok(closed<0||closed>ends[1],"the session was kept while the workflow ran past its turn");
    const [launched,report]=relay.threadStore.get(thread.id).turns;
    assert.equal(report.items.some(item=>item.type==="userMessage"),false,"Muse's report has no message of the person's");
    assert.equal(report.items.filter(item=>item.type==="agentMessage").map(item=>item.text).join(""),"The workflow with ping and pong agents is complete.");
    assert.deepEqual(workflowRows(launched),SETTLED_WORKFLOW,"the workflow and its agents settled in the turn that launched it");
    assert.deepEqual(workflowRows(report),{});
    // With the workflow done and the report over, the idle session is let go.
    const end=Date.now()+15_000;while(closedAt(relay,thread.id)<0&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(closedAt(relay,thread.id)>ends[1],"the idle session was let go once its work was done");
  }finally{await relay.close()}
});

test("through the relay, a workflow's rows settle in the turn that launched it while the person's next turn runs and after it ended",{timeout:120_000},async()=>{
  const relay=await museRelay("trebell-muse-background-turns-",{environment:{MUSE_FAKE_WORKFLOW_MS:"500"}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please run workflow ping-pong"}]});
    await relay.completed(thread.id,1);
    // The next turn runs while the workflow's first agent starts, and ends (steered) before the workflow does.
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Hello Muse, hold until steered"}]});
    await eventually(()=>relay.notifications.some(item=>item.method==="item/started"&&item.params.item?.tool==="Workflow ping-pong · ping"),"the workflow's first agent while the next turn runs");
    assert.equal(relay.threadStore.get(thread.id).turns[1].status,"inProgress");
    await relay.rpc("turn/steer",{threadId:thread.id,expectedTurnId:relay.threadStore.get(thread.id).turns[1].id,input:[{type:"text",text:"go on"}]});
    await relay.completed(thread.id,3);
    const [launched,next,report]=relay.threadStore.get(thread.id).turns;
    assert.deepEqual(workflowRows(launched),SETTLED_WORKFLOW);
    assert.deepEqual(workflowRows(next),{},"none of the workflow's rows went to the next turn");
    assert.equal(report.items.some(item=>item.type==="userMessage"),false);
    const workflowUpdates=relay.notifications.filter(item=>/^item\//.test(item.method)&&item.params.item?.tool?.startsWith("Workflow ping-pong"));
    assert.ok(workflowUpdates.length>3&&workflowUpdates.every(item=>item.params.turnId===launched.id),"every update of its rows named the turn that launched it");
  }finally{await relay.close()}
});

test("through the relay, a message sent while Muse's report turn runs takes it over: the report's turn ends first with its own reply and tokens, then the message's turn runs to its end with the thread active, and no token is counted twice",{timeout:120_000},async()=>{
  const relay=await museRelay("trebell-muse-takeover-",{environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_REPORT_HOLD:"1"}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please run workflow ping-pong"}]});
    await relay.completed(thread.id,1);
    // Muse's report starts once the workflow is done, says its first sentence, and holds.
    await eventually(()=>relay.notifications.some(item=>item.method==="item/agentMessage/delta"&&item.params.turnId===relay.threadStore.get(thread.id).turns[1]?.id),"the report turn's first words");
    const report=relay.threadStore.get(thread.id).turns[1];
    assert.equal(report.status,"inProgress");
    const {turn}=await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"And one more thing"}]});
    await relay.completed(thread.id,3);
    const marks=relay.notifications.map((item,index)=>({item,index}));
    const at=check=>marks.find(({item})=>check(item))?.index??-1;
    const reportEnd=at(item=>item.method==="turn/completed"&&item.params.turn?.id===report.id),started=at(item=>item.method==="turn/started"&&item.params.turn?.id===turn.id),end=at(item=>item.method==="turn/completed"&&item.params.turn?.id===turn.id);
    assert.ok(reportEnd>=0&&reportEnd<started,"the report's turn ended before the message's started");
    assert.equal(marks.filter(({item,index})=>index>started&&index<end&&item.method==="turn/completed").length,0,"no turn ended while the message's ran");
    assert.equal(marks.filter(({item,index})=>index>started&&index<end&&item.method==="thread/status/changed"&&item.params.threadId===thread.id&&item.params.status?.type!=="active").length,0,"the thread stayed active while the message's turn ran");
    const turns=relay.threadStore.get(thread.id).turns,text=stored=>stored.items.filter(item=>item.type==="agentMessage").map(item=>item.text).join("");
    assert.deepEqual(turns.map(stored=>stored.status),["completed","completed","completed"]);
    assert.equal(text(turns[1]),"The workflow with ping and pong agents is complete.","the report keeps its own reply");
    assert.match(text(turns[2]),/^The rest of the report\.\s*Muse fixture reply/,"the rest of Muse's report, then the message's reply, are the message's turn");
    // Each token once: the report's steps before the message on the report's record, its rest and the message's on the message's.
    const records=new Map(relay.usage.map(entry=>[entry.turnId,entry.usage]));
    assert.deepEqual(["inputTokens","outputTokens"].map(key=>records.get(report.id)?.[key]),[36716,262]);
    assert.deepEqual(["inputTokens","outputTokens"].map(key=>records.get(turn.id)?.[key]),[600,30]);
  }finally{await relay.close()}
});

test("through the relay, a report Muse starts while a message's turn gathers its context joins that turn: no turn of its own after it, the thread and the window's turn run until the message's ends, the report's words show once in it and each token counts once",{timeout:120_000},async()=>{
  // Muse's report starts only once the message's turn gathers its context (the repository knowledge it asks for), and that waits
  // until the report's first words have reached the window: the report starts after the message's turn has started and before the
  // message reaches Muse.
  const holds=await mkdtemp(join(tmpdir(),"trebell-muse-report-start-")),start=join(holds,"report-start");let relay=null;
  const reported=()=>relay.notifications.some(item=>item.method==="item/agentMessage/delta"&&String(item.params.delta).includes("The workflow with ping and pong agents is complete."));
  const repositoryKnowledge={context:async({query})=>{if(/one more thing/.test(query)){await writeFile(start,"");await eventually(reported,"Muse's report to start")}return null}};
  relay=await museRelay("trebell-muse-report-during-send-",{environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_REPORT_HOLD:"1",MUSE_FAKE_REPORT_START_HOLD:start},relayOptions:{repositoryKnowledge}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please run workflow ping-pong"}]});
    await relay.completed(thread.id,1);
    const {turn}=await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"And one more thing"}]});
    await eventually(()=>relay.notifications.some(item=>item.method==="turn/completed"&&item.params.turn?.id===turn.id),"the message's turn to end");
    const marks=relay.notifications.map((item,index)=>({item,index}));
    const started=marks.find(({item})=>item.method==="turn/started"&&item.params.turn?.id===turn.id)?.index??-1,end=marks.find(({item})=>item.method==="turn/completed"&&item.params.turn?.id===turn.id)?.index??-1;
    assert.ok(started>=0&&end>started,"the message's turn started and ended");
    const between=marks.filter(({index})=>index>started&&index<end).map(({item})=>item);
    assert.equal(between.filter(item=>item.method==="turn/started"||item.method==="turn/completed").length,0,"no turn of the report's own started or ended while the message's ran");
    assert.equal(between.filter(item=>item.method==="thread/status/changed"&&item.params.threadId===thread.id&&item.params.status?.type!=="active").length,0,"the thread stayed active while the message's turn ran");
    assert.ok(between.filter(item=>item.method==="item/agentMessage/delta").every(item=>item.params.turnId===turn.id),"the report's words and the message's reply streamed in the message's turn");
    const turns=relay.threadStore.get(thread.id).turns,said=stored=>stored.items.filter(item=>item.type==="agentMessage").map(item=>item.text).join("");
    assert.deepEqual(turns.map(stored=>[stored.id,stored.status]),[[turns[0].id,"completed"],[turn.id,"completed"]],"the report has no turn of its own");
    assert.match(said(turns[1]),/^The workflow with ping and pong agents is complete\. The rest of the report\.\s+Muse fixture reply/,"the report, once, then the message's reply");
    // The report's tokens and the message's are the message's turn's, each once.
    const records=relay.usage.filter(entry=>entry.threadId===thread.id);
    assert.deepEqual(records.map(entry=>entry.turnId),[turns[0].id,turn.id]);
    assert.deepEqual(["inputTokens","outputTokens"].map(key=>records[1].usage[key]),[37316,292]);
  }finally{await relay.close();await rm(holds,{recursive:true,force:true})}
});

test("through the relay, the idle sweep keeps a Muse Code session while a command Muse sent to the background runs, though its tool call settled as it went there, and lets it go once Muse tells the command's end, its row settled in the turn that ran it",{timeout:120_000},async()=>{
  const relay=await museRelay("trebell-muse-background-command-",{environment:{MUSE_FAKE_BACKGROUND_MS:"1500"},env:{TREBELL_AGENT_SESSION_IDLE_MS:"300",TREBELL_AGENT_SESSION_SWEEP_MS:"100"}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please run the dev server in the background"}]});
    await relay.completed(thread.id,1);
    // The command runs on for 1.5 s, five idle limits, and the session is kept meanwhile.
    const endOf=()=>relay.notifications.findIndex(item=>item.method==="item/completed"&&item.params.item?.aggregatedOutput==="Dev server stopped.");
    await eventually(()=>endOf()>=0,"the command's end");
    const closed=closedAt(relay,thread.id);
    assert.ok(closed<0||closed>endOf(),"the session was kept while the command ran in the background");
    const [launched]=relay.threadStore.get(thread.id).turns;
    const row=launched.items.find(item=>item.type==="commandExecution"&&item.command==="npm run dev");
    assert.deepEqual([row?.status,row?.aggregatedOutput],["completed","Dev server stopped."],"its row settled in the turn that ran it");
    // With the command ended, the idle session is let go.
    await eventually(()=>closedAt(relay,thread.id)>endOf(),"the idle session to be let go");
  }finally{await relay.close()}
});
