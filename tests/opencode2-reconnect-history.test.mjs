import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client, flush } from "./fixtures/fake-opencode2-client.mjs";

// What OpenCode 2 did while Trebell was not listening to its event stream is in the session's history, from this turn's own message on
// (backfill): the run's end is the idle item OpenCode keeps with its outcome (OpenCode 2.0.24 keeps one for every run, live),
// and its reply is the text of its assistant messages, one per step. Trebell read only the session's newest assistant message: a run
// that ended without a reply of its own took the previous turn's reply as its answer, and a reply with text Trebell missed, or written
// over two steps, was shown again in full after what the window had. On mocked timers.
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
function running(session,text="Fix the parser"){
  const turn=session.prompt([{type:"text",text}]),state={value:"running",result:null};
  turn.then(result=>{state.value=result.stopReason;state.result=result},error=>{state.value=error.message;state.error=error});
  return state;
}
const settle=async()=>{for(let index=0;index<40;index++)await flush()};
const chunks=updates=>updates.filter(update=>update.sessionUpdate==="agent_message_chunk").map(update=>update.content.text).join("");
const text=(id,...parts)=>({id,type:"assistant",content:parts.map(part=>({type:"text",text:part}))});
// The session's history as OpenCode lists it (newest first): the earlier turn's message, reply and end, then this turn's.
const EARLIER=[{id:"msg_idle_1",type:"idle",outcome:"succeeded"},text("msg_a1","The earlier answer."),{id:"msg_user_1",type:"user",text:"Earlier"}];

// A run that ended with no end kept (a restarted server keeps none for the run it lost) read as stopped, though nobody stopped it.
const RUN_LOST="OpenCode lost this turn's run while Trebell was reconnecting to it, so the turn did not finish. Send the message again to retry.";

test("an OpenCode 2 turn whose run ended while its stream was lost, with no reply or end of its own in OpenCode's history, ends saying OpenCode lost the run instead of with the earlier turn's reply",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const fake=fakeOpenCode2Client({overrides:{
    "session.prompt":async()=>({id:"msg_user_2"}),"session.active":async()=>({}),
    // A server of the profile's own restarted: the run is gone, and nothing of it was kept.
    "message.list":async()=>({data:[{id:"msg_user_2",type:"user",text:"Fix the parser"},...EARLIER]}),
  }});
  const {session,updates}=await startedSession(t,fake);
  try{
    const turn=running(session);
    await eventually(()=>fake.called("session.prompt").length===1);await settle();
    fake.breakStreams();
    await eventually(()=>turn.value!=="running");
    assert.equal(turn.value,RUN_LOST);
    assert.equal(fake.called("session.interrupt").length,0,"OpenCode runs nothing to stop");
    assert.equal(chunks(updates),"","the earlier turn's reply is not shown again");
  }finally{await session.close()}
});

test("an OpenCode 2 turn whose run failed while its stream was lost fails with OpenCode's reason, as a run that fails in sight does",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const fake=fakeOpenCode2Client({overrides:{
    "session.prompt":async()=>({id:"msg_user_2"}),"session.active":async()=>({}),
    "message.list":async()=>({data:[{id:"msg_idle_2",type:"idle",outcome:"failed"},{id:"msg_a2",type:"assistant",content:[],finish:"error",error:{type:"provider.quota",status:429,message:"Free usage limit reached."}},{id:"msg_user_2",type:"user",text:"Fix the parser"},...EARLIER]}),
  }});
  const {session}=await startedSession(t,fake);
  try{
    const turn=running(session);
    await eventually(()=>fake.called("session.prompt").length===1);await settle();
    fake.breakStreams();
    await eventually(()=>turn.value!=="running");
    assert.equal(turn.value,"Free usage limit reached. See Usage for your OpenCode limits.");
    assert.equal(turn.error.usageLimit,true);
  }finally{await session.close()}
});

test("an OpenCode 2 turn whose run ended while its stream was lost ends with the rest of its own reply, shown once",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const fake=fakeOpenCode2Client({overrides:{
    "session.prompt":async()=>({id:"msg_user_2"}),"session.active":async()=>({}),
    "message.list":async()=>({data:[{id:"msg_idle_2",type:"idle",outcome:"succeeded"},text("msg_a2","The parser handles nested quotes now."),{id:"msg_user_2",type:"user",text:"Fix the parser"},...EARLIER]}),
  }});
  const {session,updates}=await startedSession(t,fake);
  try{
    const turn=running(session);
    await eventually(()=>fake.called("session.prompt").length===1);await settle();
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a2",ordinal:0,delta:"The parser "}});
    await eventually(()=>chunks(updates)==="The parser ");
    fake.breakStreams();
    await eventually(()=>turn.value!=="running");
    assert.equal(turn.value,"end_turn");
    assert.equal(chunks(updates),"The parser handles nested quotes now.");
    assert.equal(turn.result.assistantMessageId,"msg_a2");
  }finally{await session.close()}
});

test("an OpenCode 2 turn whose run goes on shows the text OpenCode sent while its stream was lost in its place, and the reply once",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let history=[];
  const fake=fakeOpenCode2Client({overrides:{"session.prompt":async()=>({id:"msg_user_2"}),"session.active":async()=>RUNNING,"message.list":async()=>({data:history})}});
  const {session,updates}=await startedSession(t,fake);
  try{
    const turn=running(session);
    await eventually(()=>fake.called("session.prompt").length===1);await settle();
    fake.emit({type:"session.text.started",data:{sessionID:"ses_main",assistantMessageID:"msg_a2",ordinal:0}});
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a2",ordinal:0,delta:"The parser "}});
    await eventually(()=>chunks(updates)==="The parser ");
    // The stream drops; OpenCode writes on meanwhile.
    history=[text("msg_a2","The parser handles nested"),{id:"msg_user_2",type:"user",text:"Fix the parser"},...EARLIER];
    fake.breakStreams();
    await eventually(()=>chunks(updates)==="The parser handles nested");
    // The new stream sends on: a part of the block OpenCode had already kept, then the rest, then the block's end with its whole text.
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a2",ordinal:0,delta:" nested"}});
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a2",ordinal:0,delta:" quotes now."}});
    fake.emit({type:"session.text.ended",data:{sessionID:"ses_main",assistantMessageID:"msg_a2",ordinal:0,text:"The parser handles nested quotes now."}});
    history=[{id:"msg_idle_2",type:"idle",outcome:"succeeded"},text("msg_a2","The parser handles nested quotes now."),...history.slice(1)];
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    await eventually(()=>turn.value!=="running");
    assert.equal(turn.value,"end_turn");
    assert.equal(chunks(updates),"The parser handles nested quotes now.");
  }finally{await session.close()}
});

test("an OpenCode 2 reply written over two steps, two assistant messages, is shown once",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const fake=fakeOpenCode2Client({overrides:{
    "session.prompt":async()=>({id:"msg_user_2"}),
    "message.list":async()=>({data:[{id:"msg_idle_2",type:"idle",outcome:"succeeded"},text("msg_a3","Fixed."),text("msg_a2","Let me look."),{id:"msg_user_2",type:"user",text:"Fix the parser"},...EARLIER]}),
  }});
  const {session,updates}=await startedSession(t,fake);
  try{
    const turn=running(session);
    await eventually(()=>fake.called("session.prompt").length===1);await settle();
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a2",ordinal:0,delta:"Let me look."}});
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a3",ordinal:0,delta:"Fixed."}});
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    await eventually(()=>turn.value!=="running");
    assert.equal(turn.value,"end_turn");
    assert.equal(chunks(updates),"Let me look.Fixed.");
  }finally{await session.close()}
});
