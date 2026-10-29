import test from "node:test";
import assert from "node:assert/strict";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { eventually, fakeOpenCode2Client, flush } from "./fixtures/fake-opencode2-client.mjs";

// An answer OpenCode 2 refuses (a choice not among the field's options, say: FormInvalidAnswerError). The form is cancelled with
// OpenCode's reason, which fails the question tool with it, so the model is told and goes on, and the question's own row shows it. A
// notice the relay sends the window as an error would end the window's turn: its spinner and Stop gone and a desktop notification
// sent, while OpenCode still runs the turn and a message typed then would go out as a new turn into a busy session.
const FORM={id:"frm_1",sessionID:"ses_main",title:"Questions",metadata:{kind:"question"},fields:[
  {key:"k1",type:"multiselect",title:"Colors",description:"Which colors should the theme use?",options:[{value:"a",label:"Amber"},{value:"b",label:"Blue"}]},
  {key:"k2",type:"string",title:"Name",description:"What should the theme be called?"},
]};

test("an answer OpenCode 2 refuses reaches the model with OpenCode's reason, and nothing ends the window's turn while OpenCode goes on with it",async()=>{
  const updates=[],fake=fakeOpenCode2Client({overrides:{"session.form.reply":async()=>{throw Object.assign(new Error("Invalid option for form field: k1"),{name:"FormInvalidAnswerError"})}}});
  const session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:params=>updates.push(params.update),onQuestion:async()=>({k1:["a","zzz"],k2:["x"]})});
  await session.start({});
  try{
    let state="running";const turn=session.prompt([{type:"text",text:"Make a theme"}]);turn.then(result=>{state=result.stopReason},error=>{state=error.message});
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.emit({type:"form.created",data:{form:FORM}});
    await eventually(()=>fake.called("session.form.cancel").length===1);
    assert.deepEqual(fake.called("session.form.cancel")[0],{sessionID:"ses_main",formID:"frm_1",message:"The user's answer could not be given: Invalid option for form field: k1. Continue without it, and tell the user what you would need from them."});
    for(let index=0;index<50;index++)await flush();
    assert.deepEqual(updates.filter(update=>update.sessionUpdate==="runtime_error"),[],"no error notice, which the window takes for the turn's end");
    assert.equal(state,"running");
    // OpenCode fails the question tool with the reason, and the model goes on and ends the turn. The tool's row says it in the person's
    // words, as text to read: each question with the answer given (a choice by its label) and OpenCode's reason.
    fake.emit({type:"session.tool.input.started",data:{sessionID:"ses_main",id:"call_q",name:"question"}});
    fake.emit({type:"session.tool.failed",data:{sessionID:"ses_main",id:"call_q",error:{type:"unknown",message:fake.called("session.form.cancel")[0].message}}});
    await eventually(()=>updates.some(update=>update.toolCallId==="call_q"&&update.status==="failed"));
    const failed=updates.find(update=>update.toolCallId==="call_q"&&update.status==="failed");
    assert.equal(failed.rawOutput,"Which colors should the theme use?\nAnswer: Amber, zzz\nWhat should the theme be called?\nAnswer: x\nOpenCode refused the answer (Invalid option for form field: k1), so the turn went on without it.");
    assert.equal(failed.textOutput,true);
    fake.emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    assert.equal((await turn).stopReason,"end_turn");
  }finally{await session.close()}
});
