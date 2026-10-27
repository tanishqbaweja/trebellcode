// Trebell's runtime notes name the harness and the model an ACP session runs, and go with its first ordinary prompt (and the first
// after a compaction). They go again with the first prompt after the session's model changed, a switch Trebell made or one the harness
// reports, so the harness is not left told the model it ran before: T3 sends them with the turn's model on every prompt. A prompt on
// the same model as the notes sent last carries none.
import test from "node:test";
import assert from "node:assert/strict";
import { acpRelay, acpSession, scriptedAcp } from "./fixtures/scripted-acp.mjs";

const MODELS={currentModelId:"grok-a",availableModels:[{modelId:"grok-a",name:"Grok A"},{modelId:"grok-b",name:"Grok B"}]};
const GROK={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}}},sessionNew:{sessionId:"grok-session",models:MODELS}};
// The prompts the harness got, in order, each as [its text, the model its runtime notes named, or null for a prompt without them].
async function prompts(fx){
  return (await fx.log()).filter(entry=>entry.method==="session/prompt").map(entry=>{
    const parts=entry.params.prompt.map(part=>String(part?.text||"")),notes=parts.find(text=>text.includes("<trebell_runtime>"));
    return [parts.filter(text=>!text.includes("<trebell_runtime>")).join(" | "),notes?/ harness using model (.+)\.\n/.exec(notes)?.[1]??"":null];
  });
}

test("after a model switch the next prompt carries the runtime notes again, naming the new model, and a switch to the same model sends none",async t=>{
  const fx=await scriptedAcp(t,GROK);
  const {session}=acpSession(t,fx,{runtime:"grok"});
  await session.start({model:"grok-a"});
  await session.prompt([{type:"text",text:"one"}]);
  await session.setModel("grok-b");
  for(const text of ["two","three"])await session.prompt([{type:"text",text}]);
  await session.setModel("grok-b");
  await session.prompt([{type:"text",text:"four"}]);
  assert.deepEqual(await prompts(fx),[["one","Grok A"],["two","Grok B"],["three",null],["four",null]]);
});

test("a model the harness reports it switched to is named on the next prompt",async t=>{
  const changed={notify:{method:"x.ai/session_notification",params:{sessionId:"grok-session",update:{sessionUpdate:"model_changed",model_id:"grok-b"}}}};
  const fx=await scriptedAcp(t,{...GROK,prompts:[{},{steps:[changed]},{},{}]});
  const {session}=acpSession(t,fx,{runtime:"grok"});
  await session.start({model:"grok-a"});
  for(const text of ["one","two","three","four"])await session.prompt([{type:"text",text}]);
  assert.deepEqual(await prompts(fx),[["one","Grok A"],["two",null],["three","Grok B"],["four",null]]);
});

test("a Grok thread whose turn picks another model tells Grok which model now answers",{timeout:60000},async t=>{
  const fx=await scriptedAcp(t,GROK);
  const {rpc,next}=await acpRelay(t,"grok",fx);
  const started=await rpc("thread/start",{cwd:fx.root,model:"grok-a",approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const turn=async(text,model)=>{const completed=next(message=>message.method==="turn/completed");await rpc("turn/start",{threadId,model,input:[{type:"text",text}]});return (await completed).params.turn.status};
  assert.equal(await turn("hello","grok-a"),"completed");
  assert.equal(await turn("which model answers?","grok-b"),"completed");
  assert.equal(await turn("and now?","grok-b"),"completed");
  assert.deepEqual((await prompts(fx)).map(([,model])=>model),["Grok A","Grok B",null]);
});
