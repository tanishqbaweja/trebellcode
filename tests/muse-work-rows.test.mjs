import test from "node:test";
import assert from "node:assert/strict";
import { agentToolLifecycle } from "../src/agent-relay.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityRow, settledRow, storedRow } from "../ui/src/activity-item.js";
import { cardRowsFromItemEntries, cardRowsFromTurns } from "../ui/src/turn-activity.js";
import { FakeMuse, event, itemFrame, settlesWithin, startSession, until } from "./fixtures/muse/fake-host.mjs";
import { eventually, museRelay } from "./fixtures/muse/relay-harness.mjs";

// Work that runs on past the turn that started it (Muse Code's workflows, their agents, subagents and commands in the background) as
// the window shows it: its rows say so (runsPastTurn), from Muse Code's session through the relay's item, and the turn's end leaves
// them as they are in the open window, for the work's own later rows to settle; a harness's call that has not started reads pending.
// Every other harness's steps still running or pending when their turn ends settle as before.

const mapped=update=>agentToolLifecycle(update).item;
const live=update=>activityRow(mapped(update),{turnId:"turn-1"});

test("a harness's call that has not started reads pending, and ends with its turn as a running one does, as every harness's running step still does",()=>{
  // ACP's pending (input still streaming, an approval waited on, a workflow's agent scheduled) is the row's own status.
  for(const update of [{toolCallId:"c1",title:"npm test",kind:"execute",status:"pending"},{toolCallId:"c2",title:"Read notes.txt",kind:"read",status:"pending"},{toolCallId:"c3",kind:"edit",status:"pending",locations:[{path:"a.txt"}]},{toolCallId:"c4",namespace:"trebell_repository",tool:"search",status:"pending"}]){
    assert.equal(mapped(update).status,"pending",update.toolCallId);
    const row=live(update);assert.equal(row.status,"pending");
    assert.equal(settledRow(row,{keepPast:true}).status,"done","the live window's turn end");
    assert.equal(storedRow(row).status,"done","the thread's history");
  }
  // The other statuses map as before.
  assert.deepEqual(["in_progress","completed","failed",undefined].map(status=>mapped({toolCallId:"c",title:"x",kind:"execute",status}).status),["inProgress","completed","failed","inProgress"]);
  // Codex's command, Claude Code's and Cursor's ACP calls and Trebell Native's tool, still running as their turn ends: done, as before.
  const running=[
    activityRow({type:"commandExecution",id:"codex-1",command:["npm","test"],status:"inProgress"},{turnId:"turn-1"}),
    live({toolCallId:"toolu_1",title:"Bash",kind:"execute",status:"in_progress",rawInput:{command:"sleep 60"}}),
    live({toolCallId:"cursor-1",title:"Edit File",kind:"edit",status:"in_progress"}),
    live({toolCallId:"native-1",namespace:"native",tool:"read_file",title:"native / read_file",kind:"read",status:"in_progress"}),
  ];
  for(const row of running){assert.equal(row.status,"running",row.id);assert.equal(settledRow(row,{keepPast:true}).status,"done",row.id);assert.equal(storedRow(row).status,"done",row.id)}
  // Settled steps keep their end, and a plan's steps that have not started stay pending (they are no items).
  for(const row of [live({toolCallId:"ok",title:"x",kind:"execute",status:"completed"}),live({toolCallId:"no",title:"x",kind:"execute",status:"failed"})])assert.equal(settledRow(row,{keepPast:true}),row);
  const plan={id:"plan-1",kind:"plan",title:"Read its result",status:"pending",raw:{},turnId:"turn-1"};
  assert.equal(settledRow(plan,{keepPast:true}),plan);
});

test("a row of work that runs on past its turn stays as it is at the turn's end in the open window, and the thread's history settles it as before",()=>{
  const workflow=mapped({toolCallId:"wf-1",title:"Workflow ping-pong",kind:"other",status:"in_progress",runsPastTurn:true});
  assert.equal(workflow.runsPastTurn,true);
  for(const flag of [undefined,false,"yes"])assert.equal("runsPastTurn" in mapped({toolCallId:"t",title:"x",kind:"other",status:"in_progress",runsPastTurn:flag}),false);
  const running=activityRow(workflow,{turnId:"turn-1"}),scheduled=live({toolCallId:"wf-1:agent:ping",title:"Workflow ping-pong · ping",kind:"other",status:"pending",runsPastTurn:true});
  for(const row of [running,scheduled]){
    assert.equal(settledRow(row,{keepPast:true}),row,"left for the work's own rows");
    assert.equal(settledRow(row).status,"done");
    assert.equal(storedRow(row).status,"done","a thread opened again shows what its history stored");
  }
  assert.deepEqual([running.status,scheduled.status],["running","pending"]);
});

// A session whose updates keep the turn they name (turnKey).
async function workSession(){
  const seen=[];
  const fixture=await startSession({muse:child=>new FakeMuse(child),options:{onUpdate:params=>seen.push(params)}});
  return {...fixture,seen};
}
const rowsOf=(seen,id)=>seen.filter(entry=>entry.update.toolCallId===id).map(entry=>entry.update);
const workflowItem=(turnId,revision,children,fields={})=>({itemId:"wf-1",kind:"workflow",revision,status:"inProgress",turnId,entryId:"ping-pong",children,...fields});

test("Muse Code's workflow, its agents and a command it sends to the background say on each of their rows, to the one that settles them, that they run on past their turn; its other steps do not",async()=>{
  const fixture=await workSession(),{session,seen}=fixture,sid=session.sessionId;
  const running=session.prompt([{type:"text",text:"Run the workflow and the dev server"}]);
  const {params:{commandId:turnId}}=await fixture.muse.next("turn/start");
  const call=(itemId,revision,status,extra={})=>({itemId,kind:"toolCall",turnId,revision,status,tool:"bash",callId:"call_"+itemId,args:"{\"command\":\"npm test\"}",...extra});
  fixture.muse.write(itemFrame("item/started",sid,call("check",1,"inProgress")));
  fixture.muse.write(itemFrame("item/completed",sid,call("check",2,"completed",{visibleOutput:"ok"})));
  // The dev server's call goes to the background, as Muse sends it there (background), and settles as it goes.
  fixture.muse.write(itemFrame("item/started",sid,call("dev",1,"inProgress")));
  fixture.muse.write(itemFrame("item/updated",sid,call("dev",2,"inProgress",{background:true,backgroundInitiator:"timeout"})));
  fixture.muse.write(itemFrame("item/completed",sid,call("dev",3,"completed",{background:true,backgroundInitiator:"timeout",visibleOutput:"Running in the background."})));
  fixture.muse.write(itemFrame("item/started",sid,workflowItem(turnId,1,[])));
  await until(()=>rowsOf(seen,"wf-1").length===1,"the workflow's row");
  fixture.muse.notify("turn/completed",{sessionId:sid,viewCursor:"v",terminal:"completed",turnId});
  assert.equal((await running).stopReason,"end_turn");
  // Past the turn's end: the agent is scheduled, then the workflow and the command in the background end.
  fixture.muse.write(itemFrame("item/updated",sid,workflowItem(turnId,2,[{childId:"ping",attempt:1,status:"scheduled",label:"ping"}])));
  fixture.muse.write(itemFrame("item/completed",sid,workflowItem(turnId,3,[{childId:"ping",attempt:1,status:"terminal",terminal:"completed"}],{status:"completed",finalSummary:"done"})));
  const end={itemId:"dev-finished",kind:"backgroundTerminalCompletion",turnId,revision:1,status:"completed",backgroundTerminalCompletion:{command:"npm run dev",output:"Dev server stopped.",outputTruncated:false,terminalStatus:"completed",toolCallId:"call_dev"}};
  fixture.muse.write(itemFrame("item/completed",sid,end));
  await until(()=>rowsOf(seen,"dev").some(row=>row.rawOutput==="Dev server stopped.")&&rowsOf(seen,"wf-1:agent:ping").length===2,"the work's ends");
  const shape=id=>rowsOf(seen,id).map(row=>[row.status,row.runsPastTurn===true]);
  assert.deepEqual(shape("wf-1"),[["in_progress",true],["completed",true]]);
  assert.deepEqual(shape("wf-1:agent:ping"),[["pending",true],["completed",true]]);
  assert.deepEqual(shape("dev"),[["in_progress",false],["in_progress",true],["completed",true],["completed",true]],"from the update that sent it to the background");
  assert.deepEqual(shape("check"),[["in_progress",false],["completed",false]],"a step that ends in its turn says nothing of the kind");
  assert.ok(seen.filter(entry=>entry.update.toolCallId).every(entry=>entry.turnKey===turnId),"every row names the turn that started it");
  // Through the relay's mapping, the window gets the agent's row pending, the work's rows as running past the turn.
  assert.deepEqual(rowsOf(seen,"wf-1:agent:ping").map(row=>[mapped(row).status,mapped(row).runsPastTurn]),[["pending",true],["completed",true]]);
  await session.close();
});

test("a read of a thread whose Muse Code session still runs a workflow past its turn says so on those items, so a window that opens the thread again keeps their rows running, and once the work ends they settle",{timeout:120_000},async()=>{
  const holds=await mkdtemp(join(tmpdir(),"trebell-muse-live-work-")),release=join(holds,"workflow");
  const relay=await museRelay("trebell-muse-live-work-",{environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_WORKFLOW_HOLD:release}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please run workflow ping-pong"}]});
    await relay.completed(thread.id,1);
    // The workflow runs on past its turn, held after its first agent is scheduled.
    await eventually(()=>relay.notifications.some(item=>/^item\//.test(item.method)&&item.params.item?.tool==="Workflow ping-pong · ping"),"the workflow's agent");
    // The window rebuilds the thread's cards from each of the reads it opens a thread with (an open, a reload, a reconnect).
    const shown=async()=>{
      const resumed=await relay.rpc("thread/resume",{threadId:thread.id}),items=await relay.rpc("thread/items/list",{threadId:thread.id,limit:200});
      const turns=await relay.rpc("thread/turns/list",{threadId:thread.id,itemsView:"full"}),read=await relay.rpc("thread/read",{threadId:thread.id});
      const rows=cards=>Object.fromEntries(Object.values(cards).flat().filter(row=>/^Workflow ping-pong/.test(row.title)).map(row=>[row.title,row.status]));
      return {resume:rows(cardRowsFromTurns(resumed.thread.turns)),items:rows(cardRowsFromItemEntries(items.data)),turns:rows(cardRowsFromTurns(turns.data)),read:rows(cardRowsFromTurns(read.thread.turns))};
    };
    const every=rows=>({resume:rows,items:rows,turns:rows,read:rows});
    assert.deepEqual(await shown(),every({"Workflow ping-pong":"running","Workflow ping-pong · ping":"pending"}),"the work still runs, so its rows stay as they are");
    // The workflow goes on and ends: its rows settle as stored.
    await writeFile(release,"");
    await eventually(()=>relay.notifications.some(item=>item.method==="item/completed"&&item.params.item?.tool==="Workflow ping-pong"),"the workflow's end");
    await relay.completed(thread.id,2);
    assert.deepEqual(await shown(),every({"Workflow ping-pong":"done","Workflow ping-pong · ping":"done","Workflow ping-pong · pong: budget_exhausted":"failed"}));
    // What the thread keeps holds nothing of the reads' word.
    assert.equal(JSON.stringify(relay.threadStore.get(thread.id)).includes("stillRunning"),false);
  }finally{await relay.close();await rm(holds,{recursive:true,force:true}).catch(()=>{})}
});

test("a command Muse Code's report still runs when a message takes the report over says so on its row before the report's turn ends, so that end leaves it running in the window and its own end settles it there",async()=>{
  const REPORT="report-turn",seen=[],wakes=[];
  const fixture=await startSession({muse:child=>new FakeMuse(child),options:{onUpdate:params=>seen.push(params),onWakeTurn:promise=>{wakes.push(promise)}}}),{session}=fixture,sid=session.sessionId;
  // Muse starts its report on its own, which runs `npm test`.
  fixture.muse.write(event("turn/started",sid,{turnId:REPORT,commandId:REPORT}));
  await until(()=>wakes.length===1,"the report turn");
  const check=(revision,status,extra={})=>({itemId:"report-check",kind:"toolCall",turnId:REPORT,revision,status,tool:"bash",callId:"call_check",args:"{\"command\":\"npm test\"}",...extra});
  fixture.muse.write(itemFrame("item/started",sid,check(1,"inProgress")));
  await until(()=>rowsOf(seen,"report-check").length===1,"the command's row in the report");
  // A message takes the report over: the report's turn ends in Trebell, the window's card of it with it (agent-relay settlePrompt).
  let atReportEnd=-1;wakes[0].then(()=>{atReportEnd=seen.length});
  const message=session.prompt([{type:"text",text:"And this"}]);
  await settlesWithin(wakes[0],5000,"the report turn");
  const {params:start}=await fixture.muse.next("turn/start");
  // Muse's next word of the command is its end, as Muse's report command ends once the message comes (fake-muse.cjs).
  fixture.muse.write(itemFrame("item/completed",sid,check(2,"completed",{visibleOutput:"All 12 tests passed.",exitCode:0})));
  await until(()=>rowsOf(seen,"report-check").at(-1)?.status==="completed","the command's end");
  const rows=rowsOf(seen,"report-check");
  // The row says it runs past the report's turn before that turn ends, and its end says so too, to settle it in the report's card.
  const shape=list=>list.map(row=>[row.status,row.runsPastTurn===true]);
  assert.deepEqual({beforeReportEnd:shape(rowsOf(seen.slice(0,atReportEnd),"report-check")),all:shape(rows)},{beforeReportEnd:[["in_progress",false],["in_progress",true]],all:[["in_progress",false],["in_progress",true],["completed",true]]});
  assert.ok(seen.filter(entry=>entry.update.toolCallId==="report-check").every(entry=>entry.turnKey===REPORT),"every row of it names the report's turn");
  // In the window: the report's end leaves the row running, and the end comes as a row of a turn that ended, for that turn's card.
  const shown=activityRow(mapped(rows[1]),{turnId:REPORT});
  assert.deepEqual([settledRow(shown,{keepPast:true}).status,mapped(rows[2]).runsPastTurn],["running",true]);
  fixture.muse.notify("turn/completed",{sessionId:sid,viewCursor:"v",terminal:"completed",turnId:REPORT});
  fixture.muse.notify("turn/completed",{sessionId:sid,viewCursor:"v",terminal:"completed",turnId:start.commandId});
  assert.equal((await settlesWithin(message,5000,"the message's turn")).stopReason,"end_turn");
  await session.close();
});
