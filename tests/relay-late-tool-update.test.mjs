// A tool update that comes after its call's turn ended goes to the turn that holds the call, for every harness (tour L10-2). The relay
// wrote it into the thread's last turn instead, so the thread stored the call twice, and Native's history then sent two outputs for it.
import test from "node:test";
import assert from "node:assert/strict";
import { acpRelay, scriptedAcp, select } from "./fixtures/scripted-acp.mjs";

const CURSOR={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:{sessionId:"cursor-session",configOptions:[select("mode","mode","agent",["agent","plan","ask"]),select("model","model","default",[["default","Auto"]])]}};
const step=update=>({update});

test("a late update of an earlier turn's call settles it in that turn, and one of a call already settled is left out",{timeout:60000},async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,prompts:[
    {steps:[
      step({sessionUpdate:"tool_call",toolCallId:"run-1",title:"npm test",kind:"execute",status:"in_progress"}),
      step({sessionUpdate:"tool_call",toolCallId:"run-2",title:"npm run lint",kind:"execute",status:"in_progress"}),
      step({sessionUpdate:"tool_call_update",toolCallId:"run-2",status:"completed",rawOutput:"lint clean"}),
      step({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Started the tests."}}),
    ]},
    {steps:[
      step({sessionUpdate:"tool_call_update",toolCallId:"run-1",status:"completed",rawOutput:"12 passed"}),
      step({sessionUpdate:"tool_call_update",toolCallId:"run-2",status:"failed",rawOutput:"late copy"}),
      step({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"The tests passed."}}),
    ]},
  ]});
  const {rpc,next,threadStore}=await acpRelay(t,"cursor",fx);
  const thread=(await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"})).thread;
  for(const text of ["run the tests","how did they go?"]){
    const completed=next(message=>message.method==="turn/completed");
    await rpc("turn/start",{threadId:thread.id,input:[{type:"text",text}]});
    assert.equal((await completed).params.turn.status,"completed");
  }
  const [first,second]=threadStore.get(thread.id).turns,ids=turn=>turn.items.filter(item=>item.type!=="userMessage"&&item.type!=="agentMessage").map(item=>item.id);
  assert.deepEqual(ids(first),["run-1","run-2"]);
  assert.deepEqual(ids(second),[],"the later turn stores no copy of an earlier turn's call");
  assert.equal(first.items.find(item=>item.id==="run-1").status,"completed","the late result settles the call in its own turn");
  assert.equal(first.items.find(item=>item.id==="run-1").aggregatedOutput,"12 passed");
  assert.equal(first.items.find(item=>item.id==="run-2").status,"completed","a call already settled keeps its first result");
  assert.equal(first.items.find(item=>item.id==="run-2").aggregatedOutput,"lint clean");
});
