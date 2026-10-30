// An Antigravity chat's process keeps the sign-in it was started with, for as long as it runs. So once Settings saves another Google
// Gemini key while Antigravity runs on its API key, or sets it back to its own sign-in, the Antigravity chats open on the earlier one
// stop: the next message starts Antigravity again on the key saved now, or says
// it must sign in, and a turn still running stops as Stop stops it. Here the GUI server runs outside mock mode with a stand-in for
// Antigravity's ACP server, which logs each key it runs on by a name of the test's (never the key), and its process id; a stand-in
// for Google's model list answers the key check of a key saved.
import test from "node:test";
import assert from "node:assert/strict";
import { antigravityGui, until } from "./fixtures/antigravity-gui.mjs";

const FIRST="AIzaSyTrebellFixtureKeyFirst0123456789",SECOND="AIzaSyTrebellFixtureKeySecond012345678";
const SIGN_IN=/Antigravity is not signed in\./;
// Google's OpenAI-compatible model list, as the key check reads it; no request leaves the machine.
const googleModels=async url=>{
  if(!String(url).startsWith("https://generativelanguage.googleapis.com/"))throw new Error("no other request: "+url);
  return new Response(JSON.stringify({object:"list",data:[{id:"models/gemini-fixture-pro",object:"model",owned_by:"google"}]}),{status:200,headers:{"content-type":"application/json"}});
};

test("another Gemini key saved, and Sign in chosen again, stop the Antigravity chats open on the earlier one",{timeout:180_000},async t=>{
  const fx=await antigravityGui(t,{expectKey:FIRST,keyNames:{[FIRST]:"first",[SECOND]:"second"}},{auth:"api-key",geminiKey:FIRST,fetchFn:googleModels});
  const window=await fx.connect();
  const started=await window.rpc("thread/start",{cwd:fx.project,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const prompts=async()=>(await fx.log()).filter(entry=>entry.method==="session/prompt");
  // One turn, answered by the chat's Antigravity: its prompt says which key, and which process, Antigravity runs on.
  const turn=async text=>{
    const from=window.seen.length,before=(await prompts()).length;
    await window.rpc("turn/start",{threadId,input:[{type:"text",text}]});
    const completed=await window.next(message=>message.method==="turn/completed"&&message.params?.threadId===threadId,{from});
    return {status:completed.params.turn?.status,prompt:(await prompts())[before]};
  };
  const first=await turn("hello");
  assert.equal(first.status,"completed");assert.equal(first.prompt.keyName,"first");

  // Another key saved for the Gemini provider: the chat's Antigravity, still on the first key, is stopped, and the next message
  // starts one on the second.
  const changed=await fx.saveKey("gemini",SECOND);
  assert.equal(changed.status,200,changed.text);assert.equal(changed.body.stoppedChats,1,"the answer says one chat was open on the earlier key");
  assert.ok(!changed.text.includes(SECOND),"the key is not in the answer");
  const second=await turn("and now?");
  assert.equal(second.status,"completed");assert.equal(second.prompt.keyName,"second","the next message runs on the key saved now");
  assert.notEqual(second.prompt.pid,first.prompt.pid,"in an Antigravity started again");
  assert.ok((await fx.log()).some(entry=>entry.method==="session/close"&&entry.pid===first.prompt.pid),"the chat's Antigravity on the first key was closed");
  // A key of another provider changes nothing for Antigravity.
  const other=await fx.saveKey("xai","xai-fixture-key-not-checked");
  assert.equal(other.body?.stoppedChats,undefined);
  const third=await turn("still the same?");
  assert.equal(third.prompt.pid,second.prompt.pid,"the same Antigravity answers");

  // Sign in chosen while a turn runs: the turn stops as Stop stops it, and the next message says Antigravity must sign in.
  const from=window.seen.length,before=(await prompts()).length;
  await window.rpc("turn/start",{threadId,input:[{type:"text",text:"keep going [hang]"}]});
  await until(async()=>(await prompts()).length>before,"the turn reached Antigravity");
  const chosen=await fx.post({action:"method",method:"sign-in"});
  assert.equal(chosen.status,200,chosen.text);assert.equal(chosen.body.stoppedChats,1);
  const stopped=await window.next(message=>message.method==="turn/completed"&&message.params?.threadId===threadId,{from});
  assert.equal(stopped.params.turn?.status,"cancelled","the running turn stopped, as Stop stops it");
  await assert.rejects(window.rpc("turn/start",{threadId,input:[{type:"text",text:"still there?"}]}),error=>SIGN_IN.test(error.message));
  assert.equal((await prompts()).length,before+1,"no prompt went to an Antigravity on the earlier key");
});
