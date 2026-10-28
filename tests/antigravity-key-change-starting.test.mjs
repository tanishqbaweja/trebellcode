// A Gemini API key saved or removed while an Antigravity chat starts ends that start (the relay's closeRuntimeSessions), as a restart
// of the harness ends one: the message that started it is refused with the restart's notice, never kept in a session whose process the
// close then stops (whose next turns would all fail, "ACP runtime is not connected", until the chat was archived), nor failed as a
// harness that could not run (with a check of whether Antigravity runs). The chat's next message starts Antigravity on the key saved
// now. Here the relay runs each chat's Antigravity as a stand-in that answers session/resume, and session/close, when the test says.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { antigravityRelay, until } from "./fixtures/antigravity-relay.mjs";

const FIRST="AIzaSyTrebellFixtureKeyFirst0123456789",SECOND="AIzaSyTrebellFixtureKeySecond012345678",THIRD="AIzaSyTrebellFixtureKeyThird0123456789";
const keyNames={[FIRST]:"first",[SECOND]:"second",[THIRD]:"third"};
const RESTARTED=/restarted while this conversation was starting/;

// A chat whose Antigravity was stopped by a key change (to SECOND): its next message resumes the conversation in a new Antigravity,
// which loads it once releaseLoad exists (and closes once releaseClose does, when given).
async function chatResuming(t,{holdClose}){
  const fx=await antigravityRelay(t,{key:FIRST,keyNames}),releaseLoad=join(fx.root,"release-load"),releaseClose=join(fx.root,"release-close");
  const threadId=await fx.thread();
  assert.equal((await fx.turn(threadId,"hello")).prompt.keyName,"first");
  fx.setKey(SECOND);assert.equal(await fx.relay.closeRuntimeSessions("antigravity"),1);
  await fx.scenario({holdLoadUntil:releaseLoad,...(holdClose?{holdCloseUntil:releaseClose}:{})});
  const sent=fx.rpc("turn/start",{threadId,input:[{type:"text",text:"and now?"}]}).then(result=>({result}),error=>({error}));
  // Antigravity takes the conversation up again with session/resume (session/load where it offers no resume).
  const loads=async()=>(await fx.log()).filter(entry=>(entry.method==="session/resume"||entry.method==="session/load")&&entry.keyName==="second");
  await until(async()=>(await loads()).length>0,"the new Antigravity loads the conversation");
  const loading=(await loads())[0];
  await fx.scenario({});
  return {fx,threadId,sent,loading,release:{load:()=>writeFile(releaseLoad,""),close:()=>writeFile(releaseClose,"")}};
}

test("a key saved while an Antigravity chat starts, its load answered before its close, refuses that start, and the next message runs on the key saved now",{timeout:120_000},async t=>{
  const {fx,threadId,sent,loading,release}=await chatResuming(t,{holdClose:true});
  // Another key is saved while the conversation loads: the start is ended, and its Antigravity is asked to close while the load is
  // still on its way.
  fx.setKey(THIRD);
  const closing=fx.relay.closeRuntimeSessions("antigravity");
  const ofIt=async()=>(await fx.log()).filter(entry=>entry.pid===loading.pid&&(entry.method==="session/close"||entry.method==="session/prompt"));
  await until(async()=>(await ofIt()).some(entry=>entry.method==="session/close"),"the starting chat's Antigravity is asked to close");
  // The load is answered first. The start goes on: kept, its turn's prompt would go to that Antigravity; refused, it is closed again.
  await release.load();
  await until(async()=>(await ofIt()).length>=2,"the start went on after the load");
  await release.close();
  assert.equal(await closing,1,"the starting chat counts as one stopped");
  const outcome=await sent;
  // The chat's next message runs, in an Antigravity on the key saved now, not in a session whose process the close stopped.
  const next=await fx.turn(threadId,"once more");
  assert.equal(next.status,"completed","the chat's next message runs");
  assert.equal(next.prompt?.keyName,"third","on the key saved now");assert.notEqual(next.prompt?.pid,loading.pid);
  assert.match(outcome.error?.message||"",RESTARTED,"the message that started it is refused as a restart refuses it");
  assert.ok(!(await fx.log()).some(entry=>entry.method==="session/prompt"&&entry.pid===loading.pid),"no prompt went to the Antigravity on the earlier key");
});

test("a key saved while an Antigravity chat starts, its close answered at once, refuses that start as a restart, not as an Antigravity that failed",{timeout:120_000},async t=>{
  const {fx,threadId,sent,loading,release}=await chatResuming(t,{holdClose:false});
  fx.setKey(THIRD);
  assert.equal(await fx.relay.closeRuntimeSessions("antigravity"),1);
  const outcome=await sent;
  assert.match(outcome.error?.message||"",RESTARTED,"the message that started it is refused as a restart refuses it");
  assert.equal(fx.rechecks.length,0,"the relay does not check whether Antigravity runs, as for a failure of its own");
  await release.load();
  const next=await fx.turn(threadId,"once more");
  assert.equal(next.status,"completed");assert.equal(next.prompt?.keyName,"third");assert.notEqual(next.prompt?.pid,loading.pid);
});
