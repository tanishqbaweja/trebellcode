import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client, flush } from "./fixtures/fake-opencode2-client.mjs";

// A profile's own OpenCode 2 server (its serverUrl) keeps running when Trebell restarts. A run that waited on a question (a form) or
// an approval then still waits: Trebell never saw it asked, so it would neither ask nor stop it, and the thread's next prompt would
// queue behind a run that never ends. Such leftover requests are now refused when a session resumes (refuseUnseenRequests): a form
// cancelled and a permission rejected, both without a message, which ends OpenCode's run.
const FIELDS=[{key:"q0",type:"string",title:"Color",options:[{value:"Red",label:"Red"}],custom:true}];

test("an OpenCode 2 session resumed while its run waited on a question or an approval stops them, so the next prompt is not held behind that run",async()=>{
  const asked=[],fake=fakeOpenCode2Client({overrides:{
    "session.form.list":async({sessionID})=>sessionID==="ses_main"?[{id:"frm_old",sessionID,title:"Questions",fields:FIELDS}]:[],
    "permission.list":async({sessionID})=>sessionID==="ses_main"?[{id:"per_old",sessionID,action:"shell",resources:["npm test"],save:[]}]:[],
  }});
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:()=>{},onQuestion:async request=>{asked.push(request);return {}},onPermission:async request=>{asked.push(request);return "accept"}});
  try{
    await session.start({providerSessionId:"ses_main"});
    await eventually(()=>fake.called("session.form.cancel").length===1&&fake.called("permission.reply").length===1);
    assert.deepEqual(fake.called("session.form.list"),[{sessionID:"ses_main"}]);
    assert.deepEqual(fake.called("session.form.cancel"),[{sessionID:"ses_main",formID:"frm_old"}]);
    assert.deepEqual(fake.called("permission.reply"),[{sessionID:"ses_main",requestID:"per_old",decision:"reject"}]);
    assert.equal(asked.length,0,"they are not asked of the person: no turn of Trebell's waits on them");
    // The next turn goes through as usual.
    const turn=session.prompt([{type:"text",text:"Go on"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    assert.equal((await turn).stopReason,"end_turn");
  }finally{await session.close()}
});

test("a new OpenCode 2 session has nothing left over to stop, and a resumed one whose requests OpenCode cannot list still starts",async()=>{
  const fresh=fakeOpenCode2Client(),created=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fresh.loadClient,onUpdate:()=>{}});
  try{await created.start({});assert.equal(fresh.called("session.form.list").length+fresh.called("permission.list").length,0)}finally{await created.close()}
  const failing=fakeOpenCode2Client({overrides:{"session.form.list":async()=>{throw Object.assign(new Error("Not found"),{name:"NotFoundError"})},"permission.list":async()=>{throw Object.assign(new Error("Not found"),{name:"NotFoundError"})}}});
  const resumed=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:failing.loadClient,onUpdate:()=>{}});
  try{
    const started=await resumed.start({providerSessionId:"ses_main"});
    assert.equal(started.session.sessionId,"ses_main");
    assert.equal(failing.called("session.form.cancel").length+failing.called("permission.reply").length,0);
  }finally{await resumed.close()}
});

// Approvals and forms are listed apart, so a kind OpenCode cannot list leaves the other to be refused. A listed request without an id
// is passed over, and a refusal OpenCode fails holds up neither the others nor the session.
test("a resumed OpenCode 2 session refuses the kind of request OpenCode lists when it cannot list the other, skips one without an id, and starts whatever the refusals do",async()=>{
  const notFound=async()=>{throw Object.assign(new Error("Not found"),{name:"NotFoundError"})};
  const approvalsOnly=fakeOpenCode2Client({overrides:{
    "session.form.list":notFound,
    "permission.list":async({sessionID})=>[{id:"per_old",sessionID,action:"shell",resources:["npm test"],save:[]},{sessionID,action:"edit",resources:["a.txt"],save:[]}],
  }});
  const first=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:approvalsOnly.loadClient,onUpdate:()=>{}});
  try{
    await first.start({providerSessionId:"ses_main"});
    assert.deepEqual(approvalsOnly.called("permission.reply"),[{sessionID:"ses_main",requestID:"per_old",decision:"reject"}]);
    assert.equal(approvalsOnly.called("session.form.cancel").length,0);
  }finally{await first.close()}
  const formsOnly=fakeOpenCode2Client({overrides:{
    "permission.list":notFound,
    "session.form.list":async({sessionID})=>[{id:"frm_a",sessionID,title:"Questions",fields:FIELDS},{id:"frm_b",sessionID,title:"Questions",fields:FIELDS},{sessionID,title:"Questions",fields:FIELDS}],
    "session.form.cancel":async({formID})=>{if(formID==="frm_a")throw Object.assign(new Error("connect ECONNRESET"),{name:"ClientError"})},
  }});
  const second=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:formsOnly.loadClient,onUpdate:()=>{}});
  try{
    const started=await second.start({providerSessionId:"ses_main"});
    assert.equal(started.session.sessionId,"ses_main");
    // Both cancelled in the resumed session's name and without a message; the one without an id is not sent.
    assert.deepEqual(formsOnly.called("session.form.cancel").map(input=>`${input.sessionID} ${input.formID}${"message" in input?" with a message":""}`),["ses_main frm_a","ses_main frm_b"]);
    assert.equal(formsOnly.called("permission.reply").length,0);
  }finally{await second.close()}
});

// How long a resumed session waits on them, on mocked timers. Re-pinned when the waits were raised to Trebell's own 6 s for the list and
// 12 s for taking the requests back, at or above 2.1.2's 5 s and 10 s (the 4 s and 8 s before them were shorter than 2.1.2's): a list or
// a refusal that takes longer is passed over, and the session starts without it.
const settle=async()=>{for(let index=0;index<40;index++)await flush()};
// Lets mocked time go by in small steps until check holds (the session's start waits between two model reads first), and no further.
async function stepUntil(t,check,stepMs=100){
  for(let step=0;step<400&&!check();step++){t.mock.timers.tick(stepMs);await settle()}
  assert.ok(check(),"the session got that far");
}
test("a resumed OpenCode 2 session waits up to six seconds for OpenCode to list the leftover requests and twelve for it to take them back, then starts",{timeout:30_000},async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const never=()=>new Promise(()=>{});
  const unlisted=fakeOpenCode2Client({overrides:{"session.form.list":never,"permission.list":never}});
  const listing=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:unlisted.loadClient,onUpdate:()=>{}});
  try{
    const state={started:false},start=listing.start({providerSessionId:"ses_main"}).then(()=>{state.started=true});
    await stepUntil(t,()=>unlisted.called("permission.list").length===1&&unlisted.called("session.form.list").length===1);
    t.mock.timers.tick(5_999);await settle();
    assert.equal(state.started,false,"the list has six seconds");
    t.mock.timers.tick(1);await start;
    assert.equal(unlisted.called("session.form.cancel").length+unlisted.called("permission.reply").length,0,"nothing listed, nothing refused");
  }finally{await listing.close()}
  const unrefused=fakeOpenCode2Client({overrides:{
    "permission.list":async({sessionID})=>[{id:"per_old",sessionID,action:"shell",resources:["npm test"],save:[]}],
    "session.form.list":async()=>[],
    "permission.reply":never,
  }});
  const refusing=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:unrefused.loadClient,onUpdate:()=>{}});
  try{
    const state={started:false},start=refusing.start({providerSessionId:"ses_main"}).then(()=>{state.started=true});
    await stepUntil(t,()=>unrefused.called("permission.reply").length===1);
    t.mock.timers.tick(11_999);await settle();
    assert.equal(state.started,false,"taking the requests back has twelve seconds");
    t.mock.timers.tick(1);await start;
  }finally{await refusing.close()}
});
