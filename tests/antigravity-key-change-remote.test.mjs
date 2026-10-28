// A Gemini API key saved in Settings, or removed, reaches only the Antigravity chats that run on this machine: a chat in a WSL or SSH
// environment starts Antigravity there with that environment's own variables and none of the key saved here (its launch forwards no
// Antigravity variable, runtime-environment.mjs), and the sign-in is local only. So a key change stops only the chats on this machine
// (the relay's closeRuntimeSessions, which Settings' sign-in route calls), and counts only them: a remote chat, its turn and what its
// commands left running go on.
import test from "node:test";
import assert from "node:assert/strict";
import { antigravityRelay } from "./fixtures/antigravity-relay.mjs";

const FIRST="AIzaSyTrebellFixtureKeyFirst0123456789",SECOND="AIzaSyTrebellFixtureKeySecond012345678",REMOTE="AIzaSyTrebellFixtureKeyRemote012345678";

test("a key saved or removed here stops only the Antigravity chats on this machine, and a chat in a WSL or SSH environment goes on",{timeout:120_000},async t=>{
  const fx=await antigravityRelay(t,{key:FIRST,remoteKey:REMOTE,keyNames:{[FIRST]:"first",[SECOND]:"second",[REMOTE]:"remote"}});
  const local=await fx.thread(),remote=await fx.thread({inRemote:true});
  const localFirst=await fx.turn(local,"hello"),remoteFirst=await fx.turn(remote,"hello there");
  assert.equal(localFirst.status,"completed");assert.equal(localFirst.prompt.keyName,"first");
  assert.equal(remoteFirst.status,"completed");assert.equal(remoteFirst.prompt.keyName,"remote","the remote chat runs on its environment's own key");
  // Another key saved here: only the chat on this machine was open on the earlier key.
  fx.setKey(SECOND);
  assert.equal(await fx.relay.closeRuntimeSessions("antigravity"),1,"one chat was open on the earlier key");
  const closed=(await fx.log()).filter(entry=>entry.method==="session/close").map(entry=>entry.pid);
  assert.ok(closed.includes(localFirst.prompt.pid),"the chat on this machine was closed");
  assert.ok(!closed.includes(remoteFirst.prompt.pid),"the remote chat was not");
  assert.ok(!fx.seen.some(message=>message.method==="thread/closed"&&message.params?.threadId===remote),"no window hears the remote chat closed");
  const remoteNext=await fx.turn(remote,"still there?"),localNext=await fx.turn(local,"and now?");
  assert.equal(remoteNext.status,"completed");assert.equal(remoteNext.prompt.pid,remoteFirst.prompt.pid,"the remote chat goes on in its own Antigravity");
  assert.equal(localNext.status,"completed");assert.equal(localNext.prompt.keyName,"second","the chat here runs on the key saved now");
  assert.notEqual(localNext.prompt.pid,localFirst.prompt.pid);
  // Remove key: the same, and nothing is counted for the remote chat.
  fx.setKey(null);
  assert.equal(await fx.relay.closeRuntimeSessions("antigravity"),1);
  const after=await fx.turn(remote,"and still?");
  assert.equal(after.status,"completed");assert.equal(after.prompt.pid,remoteFirst.prompt.pid);
});
