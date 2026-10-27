import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client } from "./fixtures/fake-opencode2-client.mjs";
import { openCode1Relay } from "./fixtures/opencode1-relay.mjs";

// An OpenCode 2 question (a form) the person dismisses, with the question dialog's Cancel or its close button (both answer with no
// answers), or leaves unanswered until the window's wait for it ends. T3 Code cancels such a form without a message, which OpenCode
// takes as the person dismissing the question: the asking session's run stops ("The user dismissed this question", then
// session.execution.interrupted, seen live on OpenCode 2.0.24). Cancelled with a message, only the question tool fails and the model
// goes on as if it had not asked.
const DISMISSED="OpenCode's question was dismissed, so Trebell declined it and stopped the turn.";
const UNANSWERED="OpenCode's question was not answered in time, so Trebell declined it and stopped the turn.";
const form=(id,sessionID="ses_main")=>({id,sessionID,title:"Questions",metadata:{kind:"question"},fields:[{key:"q0",type:"string",title:"Color",description:"Which color?",options:[{value:"Red",label:"Red"},{value:"Blue",label:"Blue"}],custom:true}]});
async function startedSession(fake,options={}){
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:()=>{},...options});
  await session.start({});return session;
}
async function asked(fake,session,question=form("frm_1")){
  const turn=session.prompt([{type:"text",text:"Ask me"}]);
  await eventually(()=>fake.called("session.prompt").length===1);
  fake.emit({type:"form.created",data:{form:question}});
  // How the turn ended, once it has ("running" while it has not): its stop reason, or the message it failed with.
  const ended={state:"running"};turn.then(result=>{ended.state=result.stopReason},error=>{ended.state=error.message});
  return {turn,ended};
}
async function outcome(ended){
  for(let index=0;index<200;index++)await new Promise(resolve=>setImmediate(resolve));
  return ended.state;
}

test("an OpenCode 2 question the person dismisses is cancelled without a message, which stops OpenCode's run, and the turn ends saying so",async()=>{
  const fake=fakeOpenCode2Client(),session=await startedSession(fake,{onQuestion:async()=>({})});
  try{
    const {ended}=await asked(fake,session);
    await eventually(()=>fake.called("session.form.cancel").length===1);
    assert.deepEqual(fake.called("session.form.cancel"),[{sessionID:"ses_main",formID:"frm_1"}]);
    assert.equal(await outcome(ended),DISMISSED);
    assert.equal(fake.called("session.interrupt").length,0,"the cancel itself stops the run");
  }finally{await session.close()}
});

test("an OpenCode 2 question left unanswered until the window stops waiting for it is cancelled the same way, and the turn says it was not answered",async()=>{
  const fake=fakeOpenCode2Client(),session=await startedSession(fake,{onQuestion:async()=>{throw new Error("item/tool/requestUserInput user response timed out")}});
  try{
    const {ended}=await asked(fake,session);
    await eventually(()=>fake.called("session.form.cancel").length===1);
    assert.deepEqual(fake.called("session.form.cancel"),[{sessionID:"ses_main",formID:"frm_1"}]);
    assert.equal(await outcome(ended),UNANSWERED);
  }finally{await session.close()}
});

test("a dismissed question whose cancel OpenCode does not take stops the run with Stop, and a subagent's is cancelled while the turn goes on",async()=>{
  const fake=fakeOpenCode2Client({sessions:{ses_child:{id:"ses_child",parentID:"ses_main"}},overrides:{"session.form.cancel":async input=>{if(input.formID==="frm_1")throw Object.assign(new Error("connect ECONNRESET"),{name:"ClientError"})}}});
  const session=await startedSession(fake,{onQuestion:async()=>({})});
  try{
    const {ended}=await asked(fake,session);
    await eventually(()=>fake.called("session.form.cancel").length===1);
    assert.equal(await outcome(ended),DISMISSED);
    assert.deepEqual(fake.called("session.interrupt"),[{sessionID:"ses_main"}]);
    // A subagent's question ends the subagent's run only; the turn goes on, and ends, as OpenCode's main run does.
    const next=session.prompt([{type:"text",text:"Delegate it"}]);
    await eventually(()=>fake.called("session.prompt").length===2);
    fake.emit({type:"form.created",data:{form:form("frm_2","ses_child")}});
    await eventually(()=>fake.called("session.form.cancel").length===2);
    assert.deepEqual(fake.called("session.form.cancel")[1],{sessionID:"ses_child",formID:"frm_2"});
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    assert.equal((await next).stopReason,"end_turn");
    assert.equal(fake.called("session.interrupt").length,1);
  }finally{await session.close()}
});

// Polls on setImmediate, which mocked timers leave alone, while the relay and the fake server talk over the network.
async function settled(check,{turns=200_000,message="condition was not met"}={}){
  for(let turn=0;turn<turns;turn++){const value=check();if(value)return value;await new Promise(resolve=>setImmediate(resolve))}
  throw new Error(message);
}

test("a question the window leaves unanswered for five minutes leaves the window when the relay stops waiting for it",async t=>{
  const relay=await openCode1Relay(t,{onPrompt:async({sessionID,emit,answered})=>{
    emit({type:"question.asked",properties:{id:"que_wait",sessionID,questions:[{header:"Color",question:"Which color?",options:[{label:"Red",description:""}]}]}});
    await answered("que_wait");return "Going on without it.";
  }});
  t.mock.timers.enable({apis:["setTimeout"]});
  await relay.rpc("turn/start",{threadId:relay.threadId,input:[{type:"text",text:"Ask me"}]});
  const question=await settled(()=>relay.messages.find(message=>message.method==="item/tool/requestUserInput"),{message:"the window was not asked"});
  t.mock.timers.tick(5*60_000);
  // OpenCode is told the question went unanswered, and the card goes: it can no longer be answered.
  await settled(()=>relay.fake.called("POST /question/que_wait/reject").length===1,{message:"OpenCode was not told"});
  const resolved=await settled(()=>relay.messages.find(message=>message.method==="serverRequest/resolved"),{message:"the card was left on the window"});
  assert.deepEqual(resolved.params,{requestId:question.id,threadId:relay.threadId});
  t.mock.timers.reset();
  assert.equal((await relay.completed()).turn.status,"completed");
});
