import test from "node:test";
import assert from "node:assert/strict";
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
  const relay=await museRelay("trebell-muse-background-",{environment:{MUSE_FAKE_WORKFLOW_MS:"400",MUSE_FAKE_REPORT_DELAY_MS:"150"},env:{TREBELL_AGENT_SESSION_IDLE_MS:"250",TREBELL_AGENT_SESSION_SWEEP_MS:"100"}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please run workflow ping-pong"}]});
    // Muse reports once the workflow is done, in a turn of its own; the session was not swept while the workflow ran (2.4 s, ten idle
    // limits), nor in the moments between the workflow's end and Muse's report (150 ms, past a sweep), as its end counts as use.
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
