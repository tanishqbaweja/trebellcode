// An Antigravity chat's process keeps the Gemini API key it was started with, for as long as it runs. So once Settings saves another
// key, or Remove key takes the key out, the Antigravity chats open on the earlier key stop (T3 closes a provider instance whose settings
// changed): the next message starts Antigravity again with the key saved now, or says a key is needed, and a turn still running
// stops as Stop stops it. Here the GUI server runs outside mock mode with a stand-in for Antigravity's ACP server, which logs each key
// it runs on by a name of the test's (never the key), and its process id.
import test from "node:test";
import assert from "node:assert/strict";
import { antigravityGui, until } from "./fixtures/antigravity-gui.mjs";

const FIRST="AIzaSyTrebellFixtureKeyFirst0123456789",SECOND="AIzaSyTrebellFixtureKeySecond012345678";
const KEY_NEEDED=/Antigravity needs a Gemini API key\./;

test("a new Gemini API key, and Remove key, stop the Antigravity chats open on the earlier key, so the next message runs on the key saved now",{timeout:180_000},async t=>{
  const fx=await antigravityGui(t,{expectKey:FIRST,keyNames:{[FIRST]:"first",[SECOND]:"second"}});
  assert.equal((await fx.post({action:"login",apiKey:FIRST})).status,200);
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

  // Another key saved: the chat's Antigravity, still on the first key, is stopped, and the next message starts one on the second.
  const changed=await fx.post({action:"login",apiKey:SECOND});
  assert.equal(changed.status,200,changed.text);
  const second=await turn("and now?");
  assert.equal(second.status,"completed");assert.equal(second.prompt.keyName,"second","the next message runs on the key saved now");
  assert.notEqual(second.prompt.pid,first.prompt.pid,"in an Antigravity started again");
  assert.ok((await fx.log()).some(entry=>entry.method==="session/close"&&entry.pid===first.prompt.pid),"the chat's Antigravity on the first key was closed");
  assert.equal(changed.body.stoppedChats,1,"the answer says one chat was open on the earlier key");
  // The same key signed in again changes nothing: the chat goes on where it runs.
  const same=await fx.post({action:"login"});
  assert.equal(same.status,200,same.text);assert.equal(same.body.stoppedChats,0);
  const third=await turn("still the same?");
  assert.equal(third.status,"completed");assert.equal(third.prompt.pid,second.prompt.pid,"the same Antigravity answers");

  // Remove key while a turn runs: the turn stops as Stop stops it, and the next message says a key is needed.
  const from=window.seen.length,before=(await prompts()).length;
  await window.rpc("turn/start",{threadId,input:[{type:"text",text:"keep going [hang]"}]});
  await until(async()=>(await prompts()).length>before,"the turn reached Antigravity");
  const removed=await fx.post({action:"remove-key"});
  assert.equal(removed.status,200,removed.text);assert.equal(removed.body.stoppedChats,1);
  const stopped=await window.next(message=>message.method==="turn/completed"&&message.params?.threadId===threadId,{from});
  assert.equal(stopped.params.turn?.status,"cancelled","the running turn stopped, as Stop stops it");
  await assert.rejects(window.rpc("turn/start",{threadId,input:[{type:"text",text:"still there?"}]}),error=>KEY_NEEDED.test(error.message));
  assert.equal((await prompts()).length,before+1,"no prompt went to an Antigravity on the removed key");
});
