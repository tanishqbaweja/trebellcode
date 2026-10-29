import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client, flush } from "./fixtures/fake-opencode2-client.mjs";

// An approval the person takes over 45 seconds to answer on a Supervised OpenCode 2 thread. The session handles OpenCode's
// permission.asked while it waits on the person, and the silence watchdog must not count that wait as a stream gone silent, which would
// end the turn ("sent nothing for 45 seconds") and interrupt the command just approved. @opencode/client 2.0.24's event.subscribe
// reads the stream in the background (its shared reader) and reports OpenCode's heartbeats (onActivity) meanwhile, as the fake does,
// and the session counts the silence only while it waits on the stream, as T3 Code's timeout runs only while a read waits. A guard: the
// code before the repair kept such a turn too (the client's heartbeats reset its watchdog). On mocked timers.
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

// An approval the window stopped waiting for (the relay's five minutes ran out, the card left the window) was no answer of the person's.
// It was declined as a Deny is, telling the model the person declined the command, and nothing said it had not been answered. As a
// question left unanswered does, it ends the turn saying so, rejected without a message, which stops OpenCode's run; a subagent's is
// refused saying it was not answered, and the turn goes on.
const UNANSWERED="OpenCode's shell request (npm run deploy) was not answered in time, so Trebell declined it and stopped the turn.";
const timedOut=async()=>{throw new Error("item/tool/requestApproval user response timed out")};
const deploy=(id,sessionID)=>({type:"permission.asked",data:{id,sessionID,action:"shell",resources:["npm run deploy"],save:[],metadata:{command:"npm run deploy"}}});

test("an OpenCode 2 approval left unanswered until the window stops waiting for it is rejected without a message, which stops OpenCode's run, and the turn ends saying it was not answered in time",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const fake=fakeOpenCode2Client();
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:()=>{},permissionMode:"supervised",onPermission:timedOut});
  await along(t,session.start({}));
  try{
    let state="running";const turn=session.prompt([{type:"text",text:"Deploy the docs site"}]);turn.then(result=>{state=result.stopReason},error=>{state=error.message});
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.emit(deploy("per_1","ses_main"));
    await eventually(()=>fake.called("permission.reply").length===1);
    assert.deepEqual(fake.called("permission.reply"),[{sessionID:"ses_main",requestID:"per_1",decision:"reject"}],"a reject without a message, OpenCode's stop");
    assert.equal(fake.called("session.synthetic").length,0,"the model is not told the person declined it");
    await eventually(()=>state!=="running");
    assert.equal(state,UNANSWERED);
    assert.equal(fake.called("session.interrupt").length,0,"the reject itself stops the run");
  }finally{await session.close()}
});

test("a subagent's OpenCode 2 approval left unanswered is refused saying it was not answered in time, and the turn goes on",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const fake=fakeOpenCode2Client({sessions:{ses_child:{id:"ses_child",parentID:"ses_main"}}});
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:()=>{},permissionMode:"supervised",onPermission:timedOut});
  await along(t,session.start({}));
  try{
    let state="running";const turn=session.prompt([{type:"text",text:"Delegate the deploy"}]);turn.then(result=>{state=result.stopReason},error=>{state=error.message});
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.emit(deploy("per_2","ses_child"));
    await eventually(()=>fake.called("permission.reply").length===1);
    const said="The shell request (npm run deploy) was not answered in time, so it was declined.";
    assert.deepEqual(fake.called("permission.reply"),[{sessionID:"ses_child",requestID:"per_2",decision:"reject",message:said}]);
    assert.equal(fake.called("session.synthetic")[0]?.text,said+" Do not retry it; continue without it, and tell the user what it would need.");
    for(let index=0;index<20;index++)await flush();
    assert.equal(state,"running","the turn goes on");
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    await eventually(()=>state!=="running");
    assert.equal(state,"end_turn");
  }finally{await session.close()}
});
