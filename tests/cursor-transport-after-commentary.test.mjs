// Cursor streams a lost backend connection as its reply and ends the turn normally. Each assistant message is classified on its own
// (T3 656f3f409): a turn whose last message is only that diagnostic fails, even after commentary, a thought, a plan or a tool call
// earlier in the turn, while a message that quotes the diagnostic in prose is an answer.
import test from "node:test";
import assert from "node:assert/strict";
import { acpRelay, acpSession, scriptedAcp, select } from "./fixtures/scripted-acp.mjs";

const CURSOR={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:{sessionId:"cursor-session",configOptions:[select("mode","mode","agent",["agent","plan","ask"]),select("model","model","default",[["default","Auto"]])]}};
const DUMP="Error: ConnectError: [unavailable] upstream connect error or disconnect/reset before headers";
const chunk=text=>({update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text}}});
const toolCall=[
  {update:{sessionUpdate:"tool_call",toolCallId:"read-1",title:"Read src/app.js",kind:"read",status:"pending"}},
  {update:{sessionUpdate:"tool_call_update",toolCallId:"read-1",status:"completed"}},
];
const isTransportFailure=message=>error=>error?.code==="CURSOR_TRANSPORT_FAILURE"&&error.message===message;

test("a Cursor turn whose last message is only a lost-connection dump fails, after commentary and a tool call too",async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,prompts:[
    {steps:[chunk("Checking the file."),...toolCall,chunk(DUMP+"\n    at Http2Stream.<anonymous> (index.js:1:1)\n")]},
    // A message's text can come in several chunks; they are one message.
    {steps:[chunk("Looking at the build."),...toolCall,chunk("Error: ConnectError: "),chunk("[unavailable] backend gone")]},
    {steps:[chunk("Let me think about it."),{update:{sessionUpdate:"agent_thought_chunk",content:{type:"text",text:"The server may be down."}}},chunk("Something went wrong communicating with the server. Please try again.")]},
    {steps:[chunk("Here is the plan."),{update:{sessionUpdate:"plan",entries:[{content:"Fix the build",status:"pending",priority:"medium"}]}},chunk(DUMP)]},
  ]});
  const {session}=acpSession(t,fx,{runtime:"cursor"});
  await session.start();
  await assert.rejects(session.prompt([{type:"text",text:"one"}]),isTransportFailure(DUMP));
  await assert.rejects(session.prompt([{type:"text",text:"two"}]),isTransportFailure("Error: ConnectError: [unavailable] backend gone"));
  await assert.rejects(session.prompt([{type:"text",text:"three"}]),isTransportFailure("Something went wrong communicating with the server. Please try again."));
  await assert.rejects(session.prompt([{type:"text",text:"four"}]),isTransportFailure(DUMP));
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

test("the turn that ends in Cursor's dump after commentary fails in the thread, with the dump as its error",async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,prompts:[{steps:[chunk("Checking the file."),...toolCall,chunk(DUMP)]}]});
  const {rpc,next,threadStore}=await acpRelay(t,"cursor",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"});
  const completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"read src/app.js"}]});
  const turn=(await completed).params.turn;
  assert.equal(turn.status,"failed");
  assert.equal(threadStore.get(started.thread.id).turns.at(-1).error?.message,DUMP);
});
