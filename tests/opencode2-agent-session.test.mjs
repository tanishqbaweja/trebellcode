import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileUri } from "../src/file-uri.mjs";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";

// The OpenCode 2 session against a stand-in for @opencode/client (the loadClient option): the calls it makes, and an event stream the
// test writes to, shaped as @opencode/client 2.0.24 delivers OpenCode 2.0.24's events.
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check,{timeoutMs=5000,message="condition was not met in time"}={}){
  const startedAt=Date.now();
  for(;;){let value=null;try{value=await check()}catch{}if(value)return value;if(Date.now()-startedAt>timeoutMs)throw new Error(message);await delay(10)}
}
const IMAGE_PATH=Symbol.for("trebell.prompt.image-path");
const MODELS=[{providerID:"opencode",id:"big-pickle",name:"Big Pickle",enabled:true,limit:{context:200000},variants:[]}];

function fakeOpenCode2({sessions={},overrides={}}={}){
  const calls=[],queue=[],makes=[];let wake=null;
  const known={ses_main:{id:"ses_main",agent:"build"},...sessions};
  const call=(name,answer)=>async input=>{calls.push({name,input});if(overrides[name])return overrides[name](input);return typeof answer==="function"?answer(input):answer};
  const client={
    server:{info:call("server.info",{version:"2.0.24"})},
    model:{list:call("model.list",{data:MODELS}),default:call("model.default",{data:MODELS[0]})},
    command:{list:call("command.list",{data:[]})},skill:{list:call("skill.list",{data:[]})},agent:{list:call("agent.list",{data:[]})},
    session:{
      create:call("session.create",known.ses_main),
      get:call("session.get",({sessionID})=>{if(known[sessionID])return known[sessionID];throw Object.assign(new Error(`Session not found: ${sessionID}`),{name:"SessionNotFoundError"})}),
      update:call("session.update",undefined),switchModel:call("session.switchModel",undefined),switchAgent:call("session.switchAgent",undefined),
      instructions:{entry:{put:call("session.instructions.entry.put",undefined)}},
      prompt:call("session.prompt",({delivery})=>({id:delivery==="steer"?"msg_steer":"msg_user"})),
      interrupt:call("session.interrupt",{}),synthetic:call("session.synthetic",{}),
      form:{reply:call("session.form.reply",undefined),cancel:call("session.form.cancel",undefined)},
    },
    message:{list:call("message.list",{data:[]})},
    permission:{reply:call("permission.reply",undefined)},
    event:{subscribe:({signal}={})=>({async*[Symbol.asyncIterator](){
      while(!signal?.aborted){
        if(queue.length){yield queue.shift();continue}
        await new Promise(resolve=>{wake=resolve;signal?.addEventListener("abort",resolve,{once:true})});
      }
    }})},
  };
  return {
    client,calls,makes,
    loadClient:async()=>({OpenCode:{make:options=>{makes.push(options);return client}}}),
    called:name=>calls.filter(entry=>entry.name===name).map(entry=>entry.input),
    emit(event){queue.push({id:`evt_${queue.length+1}`,created:Date.now(),...event});const next=wake;wake=null;next?.()},
  };
}
async function startedSession(fake,options={}){
  const updates=[],session=new OpenCode2AgentSession({cwd:"/repo",serverUrl:"http://127.0.0.1:9",loadClient:fake.loadClient,onUpdate:params=>updates.push(params.update),...options});
  await session.start({});
  return {session,updates};
}
const ended=(fake,sessionID="ses_main")=>fake.emit({type:"session.execution.succeeded",data:{sessionID}});
const notices=updates=>updates.filter(update=>update.sessionUpdate==="runtime_error");

// A managed `opencode serve` (`node serve --hostname=... --port=...` in the session's folder): it says it listens and stays up; the
// stand-in client never connects to it, but the session treats it as its own server, whose files it can be sent.
async function managedFolder(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode2-session-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  await writeFile(join(root,"serve"),"process.stdout.write('server listening on http://127.0.0.1:9 \\n');setInterval(()=>{},1<<30);","utf8");
  const shot=join(root,"1793083630000-ab12cd34-shot.png");await writeFile(shot,Buffer.from("89504e470d0a1a0a","hex"));
  const notes=join(root,"notes.md");await writeFile(notes,"# Notes\n","utf8");
  const photo=join(root,"photo.jpg");await writeFile(photo,Buffer.from("ffd8ffe0","hex"));
  return {root,shot,notes,photo,missing:join(root,"gone.png")};
}
const image=(path,data="iVBORw0KGgo=")=>{const part={type:"image",mimeType:"image/png",data};Object.defineProperty(part,IMAGE_PATH,{value:path,enumerable:false});return part};
const link=(path,name)=>({type:"resource_link",uri:fileUri(path),name});

test("an OpenCode 2 prompt and a steered message send a pasted image as a file OpenCode reads itself, and name every attachment by its saved path",async t=>{
  const folder=await managedFolder(t),fake=fakeOpenCode2();
  const {session}=await startedSession(fake,{serverUrl:null,command:process.execPath,cwd:folder.root});
  try{
    const turn=session.prompt([{type:"text",text:"What does the screenshot show?"},image(folder.shot),link(folder.notes,"notes.md"),link(folder.photo,"photo.jpg")]);
    await eventually(()=>fake.called("session.prompt").length===1);
    const steered=await session.steer([{type:"text",text:"And this one?"},image(folder.shot)]);
    assert.equal(steered.accepted,true);
    ended(fake);assert.equal((await turn).stopReason,"end_turn");
    const [prompted,steer]=fake.called("session.prompt");
    // @opencode/client 2.0.24 posts files as PromptInput.FileAttachment {uri, name}; OpenCode stores the file it reads. A linked image
    // file goes the same way; any other file is named only.
    assert.deepEqual(prompted,{sessionID:"ses_main",text:`What does the screenshot show?\n[Attached image "1793083630000-ab12cd34-shot.png" is saved at: ${folder.shot}]\n[Attached file "notes.md" is saved at: ${folder.notes}]\n[Attached image "photo.jpg" is saved at: ${folder.photo}]`,files:[{uri:fileUri(folder.shot),name:"1793083630000-ab12cd34-shot.png"},{uri:fileUri(folder.photo),name:"photo.jpg"}]});
    assert.match(prompted.files[0].uri,/^file:\/\/\//);
    assert.deepEqual(steer,{sessionID:"ses_main",text:`And this one?\n[Attached image "1793083630000-ab12cd34-shot.png" is saved at: ${folder.shot}]`,files:[{uri:fileUri(folder.shot),name:"1793083630000-ab12cd34-shot.png"}],delivery:"steer"});
  }finally{await session.close()}
});

test("an OpenCode 2 attachment whose file is gone, or one for a server of the profile's own, is named and not sent, so OpenCode takes the prompt",async t=>{
  const folder=await managedFolder(t);
  const managed=fakeOpenCode2(),{session}=await startedSession(managed,{serverUrl:null,command:process.execPath,cwd:folder.root});
  try{
    const turn=session.prompt([{type:"text",text:"Look"},image(folder.missing),image(folder.shot)]);
    await eventually(()=>managed.called("session.prompt").length===1);ended(managed);await turn;
    assert.deepEqual(managed.called("session.prompt")[0],{sessionID:"ses_main",text:`Look\n[Attached image "gone.png" is saved at: ${folder.missing}]\n[Attached image "1793083630000-ab12cd34-shot.png" is saved at: ${folder.shot}]`,files:[{uri:fileUri(folder.shot),name:"1793083630000-ab12cd34-shot.png"}]});
  }finally{await session.close()}
  // A server of the profile's own (its server URL) may not see this machine's files: every attachment goes by its path only.
  const external=fakeOpenCode2(),remote=await startedSession(external);
  try{
    const turn=remote.session.prompt([{type:"text",text:"Look"},image(folder.shot),link(folder.notes,"notes.md")]);
    await eventually(()=>external.called("session.prompt").length===1);ended(external);await turn;
    assert.deepEqual(external.called("session.prompt")[0],{sessionID:"ses_main",text:`Look\n[Attached image "1793083630000-ab12cd34-shot.png" is saved at: ${folder.shot}]\n[Attached file "notes.md" is saved at: ${folder.notes}]`});
    // Text alone goes as before.
    const plain=remote.session.prompt([{type:"text",text:"Only words"}]);
    await eventually(()=>external.called("session.prompt").length===2);ended(external);await plain;
    assert.deepEqual(external.called("session.prompt")[1],{sessionID:"ses_main",text:"Only words"});
  }finally{await remote.session.close()}
});

test("an OpenCode 2 retry shows as the turn's retry row, with the model, the retry, the wait and the provider's reason, and the turn goes on",async()=>{
  const fake=fakeOpenCode2(),{session,updates}=await startedSession(fake);
  try{
    const turn=session.prompt([{type:"text",text:"Hello"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    // OpenCode counts the first request as attempt 1: attempt 2 is the first retry, 30 s after OpenCode scheduled it.
    const created=Date.now()-5_000;
    fake.emit({type:"session.retry.scheduled",created,data:{sessionID:"ses_main",assistantMessageID:"msg_a1",attempt:2,at:created+30_000,error:{type:"provider.rate-limit",message:"429 Too Many Requests"}}});
    await eventually(()=>notices(updates).length===1);
    assert.deepEqual(notices(updates),[{sessionUpdate:"runtime_error",willRetry:true,message:"429 Too Many Requests. OpenCode retries opencode/big-pickle in 30 s (retry 1)."}]);
    fake.emit({type:"session.text.started",data:{sessionID:"ses_main",assistantMessageID:"msg_a1",ordinal:0}});
    fake.emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a1",delta:"Hello there."}});
    ended(fake);
    const result=await turn;
    assert.equal(result.stopReason,"end_turn");assert.equal(fake.called("session.interrupt").length,0,"a retry that comes soon is waited for");
    assert.equal(notices(updates).length,1);
  }finally{await session.close()}
});

test("an OpenCode 2 retry hours away, or a subagent's, ends the turn with the provider's reason and stops the run",async()=>{
  const fake=fakeOpenCode2({sessions:{ses_child:{id:"ses_child",parentID:"ses_main"}}}),{session,updates}=await startedSession(fake);
  try{
    const turn=session.prompt([{type:"text",text:"Hello"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    const created=Date.now();
    fake.emit({type:"session.retry.scheduled",created,data:{sessionID:"ses_main",assistantMessageID:"msg_a1",attempt:2,at:created+3*3_600_000,error:{type:"provider.quota",message:"Usage limit reached."}}});
    await assert.rejects(turn,{message:"Usage limit reached. OpenCode would retry opencode/big-pickle only in about 3 hours, so Trebell stopped the turn. Try again later or choose another model."});
    await eventually(()=>fake.called("session.interrupt").length===1);
    assert.deepEqual(fake.called("session.interrupt"),[{sessionID:"ses_main"}]);
    assert.equal(notices(updates).length,0,"a retry Trebell does not wait for is not shown as one");

    // A subagent's retry that comes soon shows too; one past the retry limit stops both runs.
    const second=session.prompt([{type:"text",text:"Delegate it"}]);
    await eventually(()=>fake.called("session.prompt").length===2);
    const soon=Date.now();
    fake.emit({type:"session.retry.scheduled",created:soon,data:{sessionID:"ses_child",assistantMessageID:"msg_c1",attempt:3,at:soon+8_000,error:{type:"provider.overloaded",message:"Provider is overloaded"}}});
    await eventually(()=>notices(updates).length===1);
    assert.equal(notices(updates)[0].message,"A subagent's model request failed: Provider is overloaded. OpenCode retries it in 8 s (retry 2).");
    fake.emit({type:"session.retry.scheduled",created:soon,data:{sessionID:"ses_child",assistantMessageID:"msg_c1",attempt:7,at:soon+8_000,error:{type:"provider.overloaded",message:"Provider is overloaded"}}});
    await assert.rejects(second,{message:"A subagent's model request failed: Provider is overloaded. OpenCode kept retrying (attempt 6), so Trebell stopped the turn. Try again later or choose another model."});
    await eventually(()=>fake.called("session.interrupt").length===3);
    assert.deepEqual(fake.called("session.interrupt").slice(1).map(input=>input.sessionID).sort(),["ses_child","ses_main"]);
  }finally{await session.close()}
});
