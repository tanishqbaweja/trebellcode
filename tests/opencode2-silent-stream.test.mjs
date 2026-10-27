import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client, flush } from "./fixtures/fake-opencode2-client.mjs";

// OpenCode 2 sends a heartbeat on its event stream every 10 to 15 seconds (15 s live, OpenCode 2.0.24). A stream that sent nothing for
// 45 seconds is lost (T3 Code's OpenCode2Client and OpenCode's own app wait as long), and a turn waiting on it waited for good. As T3
// Code does, the session subscribes again and asks OpenCode whether it still runs the turn (opencode2-stream-reconnect has the rest).
// These run on mocked timers; polling uses setImmediate.
const UNSENT="OpenCode never confirmed the message and is not running it, so Trebell stopped the turn. Send the message again to retry.";
// Runs a promise to its end while time goes by in steps (the session's start waits a quarter second between two model reads).
async function along(t,promise,stepMs=250){
  let done=false;promise.then(()=>{done=true},()=>{done=true});
  for(let step=0;step<400&&!done;step++){t.mock.timers.tick(stepMs);await flush()}
  return promise;
}
async function startedSession(t,fake){
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:()=>{}});
  await along(t,session.start({}));
  return session;
}
const settledWithin=async promise=>{let state="pending";promise.then(()=>{state="resolved"},()=>{state="rejected"});for(let index=0;index<50;index++)await flush();return state};

test("heartbeats keep a quiet OpenCode 2 turn going, and after 45 seconds of nothing the session listens on a new stream while OpenCode runs it",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const fake=fakeOpenCode2Client({overrides:{"session.active":async()=>({ses_main:{type:"running"}})}}),session=await startedSession(t,fake);
  try{
    const turn=session.prompt([{type:"text",text:"Think it over"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    // A model thinking for a minute sends nothing, but OpenCode's heartbeat comes every 15 s: the turn waits.
    for(let beat=0;beat<4;beat++){t.mock.timers.tick(15_000);fake.heartbeat();await flush()}
    assert.equal(await settledWithin(turn),"pending","heartbeats keep the turn waiting");
    assert.equal(fake.subscriptions(),1);
    t.mock.timers.tick(44_000);await flush();
    assert.equal(fake.subscriptions(),1);
    t.mock.timers.tick(1_000);
    // Lost: the session subscribes again, and OpenCode still runs the turn, which goes on and is not interrupted.
    await eventually(()=>fake.called("session.active").length===1);
    assert.equal(await settledWithin(turn),"pending");
    assert.equal(fake.subscriptions(),2);assert.equal(fake.listening(),1);assert.equal(fake.called("session.interrupt").length,0);
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a1",delta:"Done."}});
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    assert.equal((await turn).stopReason,"end_turn");
  }finally{await session.close()}
});

test("an OpenCode 2 turn whose prompt request OpenCode never answered ends after 45 silent seconds when OpenCode does not run it, and an idle stream is reopened quietly",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let answered=0;
  const fake=fakeOpenCode2Client({overrides:{"session.prompt":()=>++answered===1?new Promise(()=>{}):{id:"msg_user_2"}}});
  const session=await startedSession(t,fake);
  try{
    const turn=session.prompt([{type:"text",text:"Hello"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    t.mock.timers.tick(45_000);
    await assert.rejects(turn,{message:UNSENT});
    // An idle session's stream that goes quiet is opened again without a word.
    await eventually(()=>fake.subscriptions()===2);
    t.mock.timers.tick(45_000);await eventually(()=>fake.subscriptions()===3);
    assert.equal(fake.called("session.interrupt").length,0,"a run OpenCode does not have is not stopped");
  }finally{await session.close()}
});

test("an OpenCode 2 server that does not answer server.info within 5 seconds fails the session's start saying so",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const signals=[];
  const fake=fakeOpenCode2Client({overrides:{"server.info":(_input,options)=>{signals.push(options?.signal);return new Promise(()=>{})}}});
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:()=>{}});
  try{
    const starting=session.start({});
    await eventually(()=>fake.called("server.info").length===1);
    t.mock.timers.tick(4_999);await flush();
    assert.equal(await settledWithin(starting),"pending");
    t.mock.timers.tick(1);
    await assert.rejects(starting,{message:"OpenCode server did not answer within 5 seconds."});
    assert.equal(signals[0]?.aborted,true,"the request is cancelled");
    assert.equal(fake.called("session.create").length,0);
  }finally{await session.close()}
});
