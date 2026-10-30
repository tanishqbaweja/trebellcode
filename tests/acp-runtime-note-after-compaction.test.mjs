// Trebell's runtime notes (which harness and model the agent runs in) go with an ACP session's first ordinary prompt, and again
// with the first one after the harness compacted its context: after a lone /compact that the
// harness finished, the relay's or the person's, and after a compaction_update that reports a finished compaction, also one in the
// turn that carried them. The /compact itself goes alone, and a stopped or refused one, or one still running or failed, keeps them.
import test from "node:test";
import assert from "node:assert/strict";
import { acpRelay, acpSession, scriptedAcp } from "./fixtures/scripted-acp.mjs";

const GROK={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}},_meta:{availableCommands:[{name:"compact",description:"Compact the context"}]}},sessionNew:{sessionId:"grok-session"}};
const OPENCODE={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:{sessionId:"opencode-session"}};
const compaction=status=>({update:{sessionUpdate:"compaction_update",compactionId:"compact-1",status}});
// The prompts the harness got, in order, each as [its text parts, whether it carried the runtime notes].
async function prompts(fx){
  return (await fx.log()).filter(entry=>entry.method==="session/prompt").map(entry=>{
    const parts=entry.params.prompt.map(part=>String(part?.text||""));
    return [parts.filter(text=>!text.includes("<trebell_runtime>")).join(" | "),parts.some(text=>text.includes("<trebell_runtime>"))];
  });
}

test("after Grok's /compact the next prompt carries the runtime notes again, and the /compact goes alone",async t=>{
  const fx=await scriptedAcp(t,GROK);
  const {session}=acpSession(t,fx,{runtime:"grok"});
  await session.start();
  for(const text of ["one","two","/compact","three","four"])assert.equal((await session.prompt([{type:"text",text}])).stopReason,"end_turn",text);
  assert.deepEqual(await prompts(fx),[["one",true],["two",false],["/compact",false],["three",true],["four",false]]);
  assert.deepEqual((await fx.log()).filter(entry=>entry.method==="session/prompt")[2].params.prompt,[{type:"text",text:"/compact"}],"the command goes alone");
});

test("a /compact that was stopped or refused keeps the runtime notes the harness has",async t=>{
  const fx=await scriptedAcp(t,{...GROK,prompts:[{},{stopReason:"cancelled"},{},{stopReason:"refusal"},{}]});
  const {session}=acpSession(t,fx,{runtime:"grok"});
  await session.start();
  for(const text of ["one","/compact","two","/compact","three"])await session.prompt([{type:"text",text}]);
  assert.deepEqual(await prompts(fx),[["one",true],["/compact",false],["two",false],["/compact",false],["three",false]]);
});

test("a compaction the harness reports finished sends the notes again, also one in the turn that carried them, and an unfinished one does not",async t=>{
  const fx=await scriptedAcp(t,{...OPENCODE,prompts:[
    {steps:[compaction("in_progress"),compaction("completed")]},
    {},
    {steps:[compaction("in_progress"),compaction("failed")]},
    {steps:[compaction("completed")]},
    {},
    {},
  ]});
  const {session}=acpSession(t,fx,{runtime:"opencode"});
  await session.start();
  for(const text of ["one","two","three","four","five","six"])await session.prompt([{type:"text",text}]);
  assert.deepEqual(await prompts(fx),[["one",true],["two",true],["three",false],["four",false],["five",true],["six",false]]);
});

test("a Grok thread compacted from Trebell tells Grok again on its next turn that it runs inside Trebell",{timeout:60000},async t=>{
  const fx=await scriptedAcp(t,GROK);
  const {rpc,next}=await acpRelay(t,"grok",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const turn=async text=>{const completed=next(message=>message.method==="turn/completed");await rpc("turn/start",{threadId,input:[{type:"text",text}]});return (await completed).params.turn.status};
  assert.equal(await turn("hello"),"completed");
  const compacted=next(message=>message.method==="thread/compacted"),settled=next(message=>message.method==="turn/completed");
  await rpc("thread/compact/start",{threadId});
  await compacted;assert.equal((await settled).params.turn.status,"completed");
  assert.equal(await turn("and now"),"completed");
  const sent=await prompts(fx);
  assert.deepEqual(sent.map(([,notes])=>notes),[true,false,true]);
  assert.equal(sent[1][0],"/compact");
  assert.match(sent[2][0],/and now/);
});
