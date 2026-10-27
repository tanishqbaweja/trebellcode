// The OpenCode 2 session driven through the real @opencode/client 2.0.24 (no loadClient stand-in), against the fake OpenCode 2 server
// (tests/fixtures/fake-opencode2-server.mjs), which answers as OpenCode 2.0.24 does. The thread's folder holds the `serve` stand-in, so
// the session runs the fake as its own server. tests/opencode2-agent-session.test.mjs drives a stand-in client given through the
// loadClient option, which the session before the port did not have: there every test failed on the code before for that alone. Here
// what fails on that code is the gap itself: an attachment OpenCode 2 refuses, a retry nobody is told of, a question never asked.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { startFakeOpenCode2, writeFakeOpenCode2Serve } from "./fixtures/fake-opencode2-server.mjs";

const IMAGE_PATH=Symbol.for("trebell.prompt.image-path");
const PNG=Buffer.from("89504e470d0a1a0a0000000d49484452","hex");
const later=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check,{timeoutMs=8000,message="condition was not met in time"}={}){
  const startedAt=Date.now();
  for(;;){let value=null;try{value=await check()}catch{}if(value)return value;if(Date.now()-startedAt>timeoutMs)throw new Error(message);await later(20)}
}
const answer=(emit,sessionID,words)=>{
  emit({type:"session.text.started",data:{sessionID,assistantMessageID:"msg_a1",ordinal:0}});
  emit({type:"session.text.delta",data:{sessionID,assistantMessageID:"msg_a1",delta:words}});
  emit({type:"session.execution.succeeded",data:{sessionID}});
};
async function realSession(t,onPrompt,options={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode2-real-client-"));await writeFakeOpenCode2Serve(root);
  // onPrompt gets the fake server too.
  const fake=await startFakeOpenCode2({onPrompt:turn=>onPrompt({...turn,fake})});
  const updates=[],session=new OpenCode2AgentSession({command:process.execPath,cwd:root,env:{...process.env,FAKE_OPENCODE2_URL:fake.url},onUpdate:params=>updates.push(params.update),...options});
  t.after(async()=>{await session.close();await fake.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})});
  await session.start({});
  return {root,fake,session,updates};
}

test("a pasted image reaches the real OpenCode 2 client's prompt as a file OpenCode takes, and the turn completes",{timeout:30_000},async t=>{
  const {root,fake,session}=await realSession(t,({body,sessionID,emit,reply})=>{if(body?.files?.length){reply("A red square.");answer(emit,sessionID,"A red square.")}});
  const shot=join(root,"shot.png");await writeFile(shot,PNG);
  const image={type:"image",mimeType:"image/png",data:PNG.toString("base64")};Object.defineProperty(image,IMAGE_PATH,{value:shot,enumerable:false});
  const result=await session.prompt([{type:"text",text:"What does this show?"},image]);
  assert.equal(result.stopReason,"end_turn");
  assert.equal(fake.prompts()[0].files.length,1,"OpenCode 2 took the file (it refuses a prompt whose file has no uri)");
});

test("an OpenCode 2 retry the real client delivers is told as the turn's retry, and the turn goes on",{timeout:30_000},async t=>{
  const {session,updates}=await realSession(t,async({sessionID,emit,reply})=>{
    const created=Date.now();
    emit({type:"session.retry.scheduled",created,data:{sessionID,assistantMessageID:"msg_a1",attempt:2,at:created+30_000,error:{type:"provider.rate-limit",message:"429 Too Many Requests"}}});
    await later(200);reply("Hello.");answer(emit,sessionID,"Hello.");
  });
  assert.equal((await session.prompt([{type:"text",text:"Hello"}])).stopReason,"end_turn");
  const notices=updates.filter(update=>update.sessionUpdate==="runtime_error");
  assert.equal(notices.length,1,"one retry notice");assert.equal(notices[0].willRetry,true);
  assert.match(notices[0].message,/^429 Too Many Requests\. OpenCode retries opencode\/big-pickle in \d+ s \(retry 1\)\.$/);
});

test("an OpenCode 2 question the real client delivers is asked, and its answer goes back to OpenCode",{timeout:30_000},async t=>{
  const asked=[];
  const {fake,session}=await realSession(t,async({fake:server,sessionID,emit,reply})=>{
    emit({type:"form.created",data:{form:{id:"frm_color",sessionID,title:"Questions",metadata:{kind:"question"},fields:[{key:"color",type:"string",title:"Color",description:"Which color?",options:[{value:"blue",label:"Blue"}],custom:true}]}}});
    for(let waited=0;!server.forms.get("frm_color")?.settled&&waited<300;waited++)await later(20);
    reply("Blue it is.");answer(emit,sessionID,"Blue it is.");
  },{onQuestion:async request=>{asked.push(request.input.questions);return {color:["blue"]}}});
  const turn=session.prompt([{type:"text",text:"Ask me"}]);
  await eventually(()=>asked.length===1,{message:"the question was never asked"});
  assert.equal((await turn).stopReason,"end_turn");
  assert.deepEqual(fake.called("POST /api/session/ses_main/form/frm_color/reply").map(call=>call.body),[{answer:{color:"blue"}}]);
});
