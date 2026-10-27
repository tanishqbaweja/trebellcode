import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client, flush } from "./fixtures/fake-opencode2-client.mjs";

// An approval the person takes over 45 seconds to answer on a Supervised OpenCode 2 thread. The session handles OpenCode's
// permission.asked while it waits on the person, and @opencode/client 2.0.24 reads the event stream only when asked for the next event
// (sse() is a lazy generator: reader.read(), onActivity, yield), so OpenCode's heartbeats wait unread meanwhile. The silence watchdog
// counted that wait as silence: 45 s after the request it let go of the stream, and once the person answered, it ended the turn with
// "sent nothing for 45 seconds" and interrupted the command just approved. T3 Code's timeout runs only while a read waits. The fake
// reports a heartbeat only when its stream is read, as the client does. On mocked timers.
async function along(t,promise,stepMs=250){
  let done=false;promise.then(()=>{done=true},()=>{done=true});
  for(let step=0;step<400&&!done;step++){t.mock.timers.tick(stepMs);await flush()}
  return promise;
}

test("an OpenCode 2 approval answered after a minute lets the turn go on, with no silent-stream stop and no interrupt",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let answer=()=>{};const asked=[];
  const fake=fakeOpenCode2Client();
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:()=>{},permissionMode:"supervised",
    onPermission:request=>{asked.push(request);return new Promise(resolve=>{answer=resolve})}});
  await along(t,session.start({}));
  try{
    let state="running";const turn=session.prompt([{type:"text",text:"Run the tests"}]);turn.then(result=>{state=result.stopReason},error=>{state=error.message});
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.emit({type:"permission.asked",data:{id:"per_1",sessionID:"ses_main",action:"shell",resources:["npm test"],save:[],metadata:{command:"npm test"}}});
    await eventually(()=>asked.length===1);
    // The card stays open a minute; OpenCode's heartbeat comes every 15 s meanwhile.
    for(let beat=0;beat<4;beat++){t.mock.timers.tick(15_000);fake.heartbeat();await flush()}
    for(let index=0;index<20;index++)await flush();
    assert.equal(state,"running","the turn waits on the person, not on a stream gone silent");
    answer("accept");
    await eventually(()=>fake.called("permission.reply").length===1);
    assert.deepEqual(fake.called("permission.reply"),[{sessionID:"ses_main",requestID:"per_1",decision:"once"}]);
    // The approved command runs and OpenCode goes on; the stream the session reads again is the one it had.
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a1",delta:"The tests pass."}});
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    await eventually(()=>state!=="running");
    assert.equal(state,"end_turn");
    assert.equal(fake.called("session.interrupt").length,0,"the approved command is not interrupted");
    assert.equal(fake.subscriptions(),1);
  }finally{await session.close()}
});
