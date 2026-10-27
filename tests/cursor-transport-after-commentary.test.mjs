// Cursor streams a lost backend connection as its reply and ends the turn normally. Each assistant message is classified on its own
// (T3 656f3f409): a turn whose last message is only that diagnostic fails, even after commentary, a thought, a plan or a tool call
// earlier in the turn, while a message that quotes the diagnostic in prose is an answer.
import test from "node:test";
import assert from "node:assert/strict";
import { threadHistoryEntries } from "../src/thread-history-handoff.mjs";
import { historyFromItemEntries } from "../ui/src/thread-history.js";
import { assistantRowDecorations, mergeTurnOutcomes, turnEndRows } from "../ui/src/turn-outcome.js";
import { acpRelay, acpSession, scriptedAcp, select } from "./fixtures/scripted-acp.mjs";

const CURSOR={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:{sessionId:"cursor-session",configOptions:[select("mode","mode","agent",["agent","plan","ask"]),select("model","model","default",[["default","Auto"]])]}};
const DUMP="Error: ConnectError: [unavailable] upstream connect error or disconnect/reset before headers",STACK="\n    at Http2Stream.<anonymous> (index.js:1:1)\n";
const chunk=text=>({update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text}}});
const toolCall=[
  {update:{sessionUpdate:"tool_call",toolCallId:"read-1",title:"Read src/app.js",kind:"read",status:"pending"}},
  {update:{sessionUpdate:"tool_call_update",toolCallId:"read-1",status:"completed"}},
];
// The failure carries the message that ended the turn, the dump with its stack lines (dump), and nothing Cursor wrote before it.
const isTransportFailure=(message,dump=message)=>error=>error?.code==="CURSOR_TRANSPORT_FAILURE"&&error.message===message&&error.dump===dump;

test("a Cursor turn whose last message is only a lost-connection dump fails, after commentary and a tool call too, with that message",async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,prompts:[
    {steps:[chunk("Checking the file."),...toolCall,chunk(DUMP+STACK)]},
    // A message's text can come in several chunks; they are one message.
    {steps:[chunk("Looking at the build."),...toolCall,chunk("Error: ConnectError: "),chunk("[unavailable] backend gone")]},
    {steps:[chunk("Let me think about it."),{update:{sessionUpdate:"agent_thought_chunk",content:{type:"text",text:"The server may be down."}}},chunk("Something went wrong communicating with the server. Please try again.")]},
    {steps:[chunk("Here is the plan."),{update:{sessionUpdate:"plan",entries:[{content:"Fix the build",status:"pending",priority:"medium"}]}},chunk(DUMP)]},
    {steps:[chunk(DUMP+STACK)]},
  ]});
  const {session}=acpSession(t,fx,{runtime:"cursor"});
  await session.start();
  await assert.rejects(session.prompt([{type:"text",text:"one"}]),isTransportFailure(DUMP,DUMP+STACK));
  await assert.rejects(session.prompt([{type:"text",text:"two"}]),isTransportFailure("Error: ConnectError: [unavailable] backend gone"));
  await assert.rejects(session.prompt([{type:"text",text:"three"}]),isTransportFailure("Something went wrong communicating with the server. Please try again."));
  await assert.rejects(session.prompt([{type:"text",text:"four"}]),isTransportFailure(DUMP));
  await assert.rejects(session.prompt([{type:"text",text:"five"}]),isTransportFailure(DUMP,DUMP+STACK));
});

test("a Cursor message that quotes the dump in prose, or a dump that Cursor went on from, ends the turn normally",async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,prompts:[
    {steps:[chunk("Checking the file."),...toolCall,chunk("The server log shows:\n"+DUMP+"\nso the deploy failed before the tests ran.")]},
    // Session metadata between two chunks is no new message: the reply stays the commentary that quotes the dump.
    {steps:[chunk("The log said:\n"),{update:{sessionUpdate:"available_commands_update",availableCommands:[{name:"review",description:"Review"}]}},chunk(DUMP+"\n")]},
    {steps:[chunk(DUMP),...toolCall,chunk("The connection is back; the file has two functions.")]},
  ]});
  const {session}=acpSession(t,fx,{runtime:"cursor"});
  await session.start();
  for(const text of ["one","two","three"])assert.deepEqual(await session.prompt([{type:"text",text}]),{stopReason:"end_turn"},text);
});

// A thread opened again as the app reads it: its item page as conversation rows, how its turns ended, the rows that end turns with
// no reply (each turn's pill and error) and the pills under replies.
async function reopened(rpc,threadId){
  const messages=historyFromItemEntries((await rpc("thread/items/list",{threadId,limit:150})).data);
  const turnInfo=mergeTurnOutcomes({},threadId,(await rpc("thread/turns/list",{threadId,sortDirection:"desc",itemsView:"notLoaded"})).data),options={harnessLabel:"Cursor",turnInfo,threadId};
  return {messages,ends:[...turnEndRows(messages,options).values()].flat(),pills:[...assistantRowDecorations(messages,options).values()]};
}
const handedOver=turns=>threadHistoryEntries(turns).filter(entry=>entry.role!=="user").map(entry=>[entry.label,entry.text]);

// The turn keeps what Cursor wrote before the dump, as a turn that completes keeps its reply. The dump is the turn's error, not its
// answer (cursor-transport-failure.mjs), so the reply, the thread opened again and the history a fresh session is handed carry it
// only as that error.
test("the turn that ends in Cursor's dump after commentary fails in the thread, with the dump as its error and the commentary as its reply",async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,prompts:[{steps:[chunk("Checking the file."),...toolCall,chunk(DUMP+STACK)]}]});
  const {rpc,next,threadStore}=await acpRelay(t,"cursor",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const replied=next(message=>message.method==="item/completed"&&message.params.item?.type==="agentMessage"),completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId,input:[{type:"text",text:"read src/app.js"}]});
  const turn=(await completed).params.turn;
  assert.equal(turn.status,"failed");
  const stored=threadStore.get(threadId).turns.at(-1);
  assert.equal(stored.error?.message,DUMP);
  assert.equal(stored.items.find(item=>item.type==="agentMessage")?.text,"Checking the file.","the stored turn keeps what Cursor wrote before the dump");
  // The open window gets the reply as it ended, as it does for a turn that completes.
  assert.equal((await replied).params.item.text,"Checking the file.");
  const view=await reopened(rpc,threadId);
  assert.deepEqual(view.messages.map(message=>[message.role,message.text]),[["user","read src/app.js"],["assistant","Checking the file."]]);
  assert.deepEqual(view.pills.map(pill=>pill.outcomeTone),["err"],"the reply carries the failed pill");
  assert.deepEqual(view.ends,[]);
  assert.deepEqual(handedOver(threadStore.get(threadId).turns),[["assistant","Checking the file."],["error",DUMP]]);
});

// A turn whose only message is the dump, alone or after a read, keeps no reply: it ends with its error, which the thread opened again
// shows in the turn's own row under the failed pill.
test("a Cursor turn that loses its connection before writing anything fails with the dump as its error and keeps no reply",async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,prompts:[{steps:[chunk(DUMP+STACK)]},{steps:[...toolCall,chunk(DUMP)]}]});
  const {ws,rpc,next,threadStore}=await acpRelay(t,"cursor",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const replies=[];ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.method==="item/completed"&&message.params.item?.type==="agentMessage")replies.push(message.params.item.text)});
  for(const text of ["what is in src/app.js?","read src/app.js"]){
    const completed=next(message=>message.method==="turn/completed");
    await rpc("turn/start",{threadId,input:[{type:"text",text}]});
    assert.equal((await completed).params.turn.status,"failed",text);
  }
  const turns=threadStore.get(threadId).turns;
  assert.deepEqual(turns.map(turn=>[turn.error?.message,turn.items.some(item=>item.type==="agentMessage")]),[[DUMP,false],[DUMP,false]],"no reply is stored");
  assert.deepEqual(replies,[],"the window gets no reply");
  const view=await reopened(rpc,threadId);
  assert.deepEqual(view.messages.map(message=>message.role),["user","user"]);
  assert.deepEqual(view.ends.map(row=>[row.heading,row.outcomeTone,row.message]),[["Cursor","err",DUMP],["Cursor","err",DUMP]],"each turn ends with its own row, its error in it");
  assert.deepEqual(handedOver(turns),[["error",DUMP],["error",DUMP]]);
});
