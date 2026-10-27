import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client, flush } from "./fixtures/fake-opencode2-client.mjs";

// When the session lets go of a silent event stream itself, @opencode/client 2.0.24 ends it as it ends every failed read: it throws
// its ClientError, "Transport: This operation was aborted" (sse() wraps the aborted read), not an AbortError. That is Trebell's own
// doing, not an error of OpenCode's: the window must get no error for it, which would add an error row, stop the window's turn and send
// a desktop notification, also for a thread with no turn running. On mocked timers; the fake throws on abort as the client does.
async function along(t,promise,stepMs=250){
  let done=false;promise.then(()=>{done=true},()=>{done=true});
  for(let step=0;step<400&&!done;step++){t.mock.timers.tick(stepMs);await flush()}
  return promise;
}
async function startedSession(t,fake,updates){
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:params=>updates.push(params.update)});
  await along(t,session.start({}));
  return session;
}
const errors=updates=>updates.filter(update=>update.sessionUpdate==="runtime_error");

test("an idle OpenCode 2 session that lets go of its silent event stream says nothing of it and listens again",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const updates=[],fake=fakeOpenCode2Client(),session=await startedSession(t,fake,updates);
  try{
    t.mock.timers.tick(45_000);
    await eventually(()=>fake.subscriptions()===2);
    for(let index=0;index<20;index++)await flush();
    assert.deepEqual(errors(updates),[],"no error for the stream Trebell let go of");
    assert.equal(fake.listening(),1);
  }finally{await session.close()}
});

test("an OpenCode 2 turn whose silent event stream Trebell lets go of gets no Transport error for it",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const updates=[],fake=fakeOpenCode2Client(),session=await startedSession(t,fake,updates);
  try{
    const turn=session.prompt([{type:"text",text:"Think it over"}]);turn.catch(()=>{});
    await eventually(()=>fake.called("session.prompt").length===1);
    t.mock.timers.tick(45_000);
    await eventually(()=>fake.subscriptions()===2);
    for(let index=0;index<20;index++)await flush();
    assert.deepEqual(errors(updates),[],"no Transport: This operation was aborted");
  }finally{await session.close()}
});
