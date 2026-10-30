import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client, flush } from "./fixtures/fake-opencode2-client.mjs";

// An OpenCode 2 event stream that is lost (it sends nothing, not even OpenCode's heartbeat, for 45 seconds while the session waits on it,
// or it fails) is a lost stream, not a lost turn. The session subscribes again (five tries, two seconds apart) and asks OpenCode which
// sessions it still runs: a turn whose run goes on goes on, one whose run ended meanwhile ends as its messages say, and a request asked
// meanwhile is asked again; only a turn it cannot follow again fails. Trebell ended the turn and interrupted its run after the first 45
// seconds of silence, even with OpenCode answering at once. On mocked timers.
const LOST="Trebell lost its connection to OpenCode's event stream and could not reconnect, so it stopped following the turn. Send the message again to retry.";
async function along(t,promise,stepMs=250){
  let done=false;promise.then(()=>{done=true},()=>{done=true});
  for(let step=0;step<400&&!done;step++){t.mock.timers.tick(stepMs);await flush()}
  return promise;
}
async function startedSession(t,fake,options={}){
  const updates=[],session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:params=>updates.push(params.update),...options});
  await along(t,session.start({}));
  return {session,updates};
}
// A turn, and how it ended once it has ("running" while it has not).
function running(session,text="Fix the parser"){
  const turn=session.prompt([{type:"text",text}]),state={value:"running"};
  turn.then(result=>{state.value=result.stopReason},error=>{state.value=error.message});
  return state;
}
const settle=async()=>{for(let index=0;index<40;index++)await flush()};
const RUNNING={ses_main:{type:"running"}};

test("an OpenCode 2 turn whose stream goes silent while OpenCode still runs it goes on once Trebell subscribes again, and ends as OpenCode ends it",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const fake=fakeOpenCode2Client({overrides:{"session.active":async()=>RUNNING}}),{session,updates}=await startedSession(t,fake);
  try{
    const turn=running(session);
    await eventually(()=>fake.called("session.prompt").length===1);
    t.mock.timers.tick(45_000);
    await eventually(()=>fake.called("session.active").length===1);await settle();
    assert.equal(turn.value,"running","the turn goes on");
    assert.equal(fake.subscriptions(),2);assert.equal(fake.listening(),1);
    assert.equal(fake.called("session.interrupt").length,0,"OpenCode's run is not stopped");
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a1",delta:"Fixed."}});
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    await eventually(()=>turn.value!=="running");
    assert.equal(turn.value,"end_turn");
    assert.deepEqual(updates.filter(update=>update.sessionUpdate==="runtime_error"),[]);
  }finally{await session.close()}
});

test("an OpenCode 2 turn whose run ended while its stream was lost ends as its messages say, without an interrupt",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  // OpenCode keeps the run's end as an idle item with its outcome (OpenCode 2.0.24, live).
  const fake=fakeOpenCode2Client({overrides:{
    "session.active":async()=>({}),
    "message.list":async()=>({data:[{id:"msg_idle",type:"idle",outcome:"succeeded"},{id:"msg_a1",type:"assistant",content:[{type:"text",text:"Done while the stream was gone."}]},{id:"msg_user",type:"user"}]}),
  }});
  const {session,updates}=await startedSession(t,fake);
  try{
    const turn=running(session);
    await eventually(()=>fake.called("session.prompt").length===1);
    t.mock.timers.tick(45_000);
    await eventually(()=>turn.value!=="running");
    assert.equal(turn.value,"end_turn");
    assert.ok(updates.some(update=>update.sessionUpdate==="agent_message_chunk"&&update.content?.text==="Done while the stream was gone."),"the reply it missed is shown");
    assert.equal(fake.called("session.interrupt").length,0);
  }finally{await session.close()}
});

test("an OpenCode 2 stream that fails is followed again, and a question and an approval asked while it was gone are asked then",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const asked=[];
  const fake=fakeOpenCode2Client({overrides:{
    "session.active":async()=>RUNNING,
    "session.form.list":async({sessionID})=>sessionID==="ses_main"?[{id:"frm_gap",sessionID,title:"Questions",fields:[{key:"q0",type:"string",title:"Color",options:[{value:"Red",label:"Red"}],custom:true}]}]:[],
    "permission.list":async({sessionID})=>sessionID==="ses_main"?[{id:"per_gap",sessionID,action:"shell",resources:["npm test"],save:[],metadata:{command:"npm test"}}]:[],
  }});
  const {session,updates}=await startedSession(t,fake,{permissionMode:"supervised",onQuestion:async request=>{asked.push(request.toolName);return {q0:["Red"]}},onPermission:async request=>{asked.push(request.method);return "accept"}});
  try{
    const turn=running(session);
    await eventually(()=>fake.called("session.prompt").length===1);
    // OpenCode's server restarts: the stream fails at once.
    fake.breakStreams();
    await eventually(()=>fake.called("permission.reply").length===1&&fake.called("session.form.reply").length===1);
    assert.deepEqual(asked.sort(),["permission","question"]);
    assert.deepEqual(fake.called("permission.reply"),[{sessionID:"ses_main",requestID:"per_gap",decision:"once"}]);
    assert.deepEqual(fake.called("session.form.reply"),[{sessionID:"ses_main",formID:"frm_gap",answer:{q0:"Red"}}]);
    assert.equal(turn.value,"running");
    assert.deepEqual(updates.filter(update=>update.sessionUpdate==="runtime_error"),[],"a lost stream is no error of the turn's");
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    await eventually(()=>turn.value!=="running");assert.equal(turn.value,"end_turn");
  }finally{await session.close()}
});

test("an OpenCode 2 turn whose stream cannot be opened again ends saying so after five tries, its run is stopped, and the next turn listens again",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let refusing=true,runs=RUNNING;
  const failing={async*[Symbol.asyncIterator](){throw Object.assign(new Error("Transport: fetch failed"),{name:"ClientError",reason:"Transport"})}};
  const fake=fakeOpenCode2Client({overrides:{"event.subscribe":(_options,count)=>count>0&&refusing?failing:null,"session.active":async()=>runs,"session.interrupt":async()=>{runs={};return {interrupted:true}}}});
  const {session,updates}=await startedSession(t,fake);
  try{
    const turn=running(session);
    await eventually(()=>fake.called("session.prompt").length===1);
    t.mock.timers.tick(45_000);
    for(let step=0;step<60&&turn.value==="running";step++){t.mock.timers.tick(500);await settle()}
    assert.equal(turn.value,LOST);
    assert.equal(fake.subscriptions(),6,"the lost stream and five tries");
    // Trebell no longer follows the run, so it stops it where OpenCode still takes requests.
    assert.equal(fake.called("session.interrupt").length,1);
    assert.deepEqual(updates.filter(update=>update.sessionUpdate==="runtime_error"),[]);
    // The server answers again: the next turn subscribes first.
    refusing=false;
    const next=running(session,"Again");
    await eventually(()=>fake.called("session.prompt").length===2);
    await eventually(()=>fake.listening()===1);
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    await eventually(()=>next.value!=="running");assert.equal(next.value,"end_turn");
  }finally{await session.close()}
});
