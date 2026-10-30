import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client } from "./fixtures/fake-opencode2-client.mjs";

// A profile's own OpenCode 2 server (its serverUrl) keeps running when Trebell restarts. A run that waited on a question (a form) or
// an approval then still waits: Trebell never saw it asked, so it would neither ask nor stop it, and the thread's next prompt would
// queue behind a run that never ends. Such leftover requests are now stopped when a session resumes (stopLeftoverRequests): a form
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
