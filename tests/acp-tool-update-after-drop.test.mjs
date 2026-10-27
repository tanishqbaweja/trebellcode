// An ACP session merges each tool frame into its call's last state before the relay maps it (acp-tool-state.mjs). A frame the relay
// throws on is dropped with a warning (acp-client.mjs), and it stays out of that state, as T3 drops an update it cannot decode before
// it reaches the call's state: kept, its fields went with every later update of the call, which the relay threw on again, so the
// whole call never showed, though its next update alone was one the relay can map.
import test from "node:test";
import assert from "node:assert/strict";
import { acpRelay, acpSession, scriptedAcp, select } from "./fixtures/scripted-acp.mjs";

const CURSOR={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:{sessionId:"cursor-session",configOptions:[select("mode","mode","agent",["agent","plan","ask"]),select("model","model","default",[["default","Auto"]])]}};
const step=update=>({update});

test("a tool frame the relay throws on stays out of its call's state, and a frame it took still goes with the call's next update",async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,prompts:[{steps:[
    step({sessionUpdate:"tool_call",toolCallId:"delete-1",title:"Delete old.txt",kind:"delete",status:"pending",locations:[null]}),
    step({sessionUpdate:"tool_call_update",toolCallId:"delete-1",status:"completed"}),
    step({sessionUpdate:"tool_call",toolCallId:"read-1",title:"Read notes.txt",kind:"read",status:"pending",locations:[{path:"notes.txt"}]}),
    step({sessionUpdate:"tool_call_update",toolCallId:"read-1",status:"completed"}),
  ]}]});
  // The listener throws on a location that is no object, as the relay's file-change mapping does.
  const frames=[],onUpdate=params=>{const update=params.update;if(!String(update.sessionUpdate).startsWith("tool_call"))return;frames.push(update);for(const location of update.locations||[])void location.path};
  const {session}=acpSession(t,fx,{runtime:"cursor",onUpdate});
  await session.start();
  assert.deepEqual(await session.prompt([{type:"text",text:"tidy up"}]),{stopReason:"end_turn"});
  const of=id=>frames.filter(frame=>frame.toolCallId===id);
  assert.equal(of("delete-1").length,2);
  assert.deepEqual(of("delete-1")[1],{sessionUpdate:"tool_call_update",toolCallId:"delete-1",status:"completed"},"the update carries none of the dropped frame's fields");
  assert.deepEqual(of("read-1")[1],{sessionUpdate:"tool_call_update",toolCallId:"read-1",title:"Read notes.txt",kind:"read",status:"completed",locations:[{path:"notes.txt"}]},"a frame the relay took is merged into the next");
});

test("through the relay, a tool call whose first frame the relay cannot map shows from its next update, and the turn goes on",{timeout:60000},async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,prompts:[{steps:[
    step({sessionUpdate:"tool_call",toolCallId:"delete-1",kind:"delete",locations:[null]}),
    step({sessionUpdate:"tool_call_update",toolCallId:"delete-1",status:"completed"}),
    step({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Removed old.txt."}}),
  ]}]});
  const {rpc,next,threadStore}=await acpRelay(t,"cursor",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"});
  const shown=next(message=>message.method==="item/completed"&&message.params.item?.id==="delete-1"),completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"remove old.txt"}]});
  assert.equal((await completed).params.turn.status,"completed");
  const items=threadStore.get(started.thread.id).turns.at(-1).items;
  assert.equal(items.find(item=>item.type==="agentMessage")?.text,"Removed old.txt.");
  assert.equal(items.find(item=>item.id==="delete-1")?.status,"completed","the thread keeps the call");
  assert.equal((await shown).params.item.status,"completed","the window is told the call finished");
});
