import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client, flush } from "./fixtures/fake-opencode2-client.mjs";

// A turn Trebell stops following because its OpenCode 2 event stream was lost may leave OpenCode running its message. Trebell ended such
// a turn ("Send the message again to retry") and left the run going, and the next turn took that run's events: its text, and its end
// as the new turn's end. As T3 Code does, a stream that opens again counts only once OpenCode says which sessions it runs (another try
// otherwise), a turn Trebell stops following has its run stopped, and the next prompt asks OpenCode first: a run still going is
// stopped and the message refused, saying so (T3's OPENCODE_2_STILL_STOPPING). On mocked timers.
const UNKNOWN="Trebell lost OpenCode's event stream, and OpenCode did not say whether it still runs the turn, so Trebell stopped following it. Send the message again to retry.";
const STILL_STOPPING="OpenCode was still running the turn Trebell stopped following, so Trebell stopped that run and did not send this message. Send the message again in a moment.";
const RUNNING={ses_main:{type:"running"}};
async function along(t,promise,stepMs=250){
  let done=false;promise.then(()=>{done=true},()=>{done=true});
  for(let step=0;step<400&&!done;step++){t.mock.timers.tick(stepMs);await flush()}
  return promise;
}
async function startedSession(t,fake){
  const updates=[],session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:params=>updates.push(params.update)});
  await along(t,session.start({}));
  return {session,updates};
}
// A turn, and how it ended once it has ("running" while it has not).
function running(session,text){
  const turn=session.prompt([{type:"text",text}]),state={value:"running"};
  turn.then(result=>{state.value=result.stopReason},error=>{state.value=error.message});
  return state;
}
const settle=async()=>{for(let index=0;index<40;index++)await flush()};
const chunks=updates=>updates.filter(update=>update.sessionUpdate==="agent_message_chunk").map(update=>update.content.text).join("");

test("an OpenCode 2 stream opened again whose session.active check fails is tried again, as T3 Code tries its reconnect, and the turn goes on once OpenCode answers",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let checks=0;
  const fake=fakeOpenCode2Client({overrides:{"session.active":async()=>{if(++checks===1)throw Object.assign(new Error("Internal error"),{_tag:"UnknownError"});return RUNNING}}});
  const {session,updates}=await startedSession(t,fake);
  try{
    const turn=running(session,"Fix the parser");
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.breakStreams();
    for(let step=0;step<40&&checks<2;step++){t.mock.timers.tick(500);await settle()}
    assert.equal(checks,2,"OpenCode is asked again on the next try");
    assert.equal(turn.value,"running","the turn goes on");
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a1",delta:"Fixed."}});
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    await eventually(()=>turn.value!=="running");
    assert.equal(turn.value,"end_turn");
    assert.equal(chunks(updates),"Fixed.");
    assert.equal(fake.called("session.interrupt").length,0,"a run Trebell follows again is not stopped");
  }finally{await session.close()}
});

test("a turn Trebell stops following has its OpenCode 2 run stopped, and the next message waits for OpenCode to say the run ended: one still going is stopped and the message refused, and its text reaches no later turn",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  // OpenCode cannot say which sessions it runs while Trebell reconnects, and its first interrupt does not take.
  let answering=false,prompts=0;
  const fake=fakeOpenCode2Client({overrides:{
    "session.active":async()=>{if(!answering)throw Object.assign(new Error("Internal error"),{_tag:"UnknownError"});return fake.runs},
    "session.interrupt":async()=>{if(!answering)return {interrupted:false};fake.runs={};return {interrupted:true}},
    "session.prompt":async()=>({id:`msg_user_${++prompts}`}),
  }});
  fake.runs=RUNNING;
  const {session,updates}=await startedSession(t,fake);
  try{
    const first=running(session,"Fix the parser");
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.breakStreams();
    for(let step=0;step<80&&first.value==="running";step++){t.mock.timers.tick(500);await settle()}
    assert.equal(first.value,UNKNOWN);
    assert.ok(fake.called("session.interrupt").length>=1,"the run Trebell stopped following is stopped");
    // OpenCode answers again, and still runs the first message.
    answering=true;
    const second=running(session,"Fix the parser again");
    await eventually(()=>second.value!=="running");
    assert.equal(second.value,STILL_STOPPING);
    assert.equal(fake.called("session.prompt").length,1,"the message is not sent while OpenCode runs the last one");
    assert.ok(fake.called("session.interrupt").length>=2,"the run still going is stopped");
    // What the first run said on its way out reaches no turn.
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_old",delta:"The old run's words."}});
    fake.emit({type:"session.execution.interrupted",data:{sessionID:"ses_main",reason:"user"}});
    await settle();
    const third=running(session,"Fix the parser, third time");
    await eventually(()=>fake.called("session.prompt").length===2);
    await settle();
    assert.equal(third.value,"running");
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a3",delta:"Fixed for good."}});
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    await eventually(()=>third.value!=="running");
    assert.equal(third.value,"end_turn");
    assert.equal(chunks(updates),"Fixed for good.","only the third turn's own text is shown");
  }finally{await session.close()}
});

test("an OpenCode 2 turn ended because OpenCode never answered its prompt request has its run stopped once the request answers after all",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let answer=()=>{};
  const fake=fakeOpenCode2Client({overrides:{"session.prompt":()=>new Promise(resolve=>{answer=resolve}),"session.active":async()=>({})}});
  const {session}=await startedSession(t,fake);
  try{
    const turn=running(session,"Hello");
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.breakStreams();
    await eventually(()=>turn.value!=="running");
    assert.match(turn.value,/^OpenCode never confirmed the message/);
    assert.equal(fake.called("session.interrupt").length,0,"nothing runs yet");
    // OpenCode takes the message after all: its run is stopped, as no turn follows it.
    answer({id:"msg_user_late"});
    await eventually(()=>fake.called("session.interrupt").length===1);
  }finally{await session.close()}
});
