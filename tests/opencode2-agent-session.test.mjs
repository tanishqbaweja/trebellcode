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

const FORM={id:"frm_1",sessionID:"ses_main",title:"Questions",metadata:{kind:"question"},fields:[
  {key:"k1",type:"multiselect",title:"Colors",description:"Which colors should the theme use?",options:[{value:"a",label:"Amber",description:"Warm"},{value:"b",label:"Blue"}]},
  {key:"k2",type:"string",title:"Name",description:"What should the theme be called?"},
]};

test("an OpenCode 2 question (a form) goes to the question dialog, and the person's answers go back by field, a multiselect's as a list",async()=>{
  const asked=[],fake=fakeOpenCode2(),{session}=await startedSession(fake,{onQuestion:async request=>{asked.push(request);return {k1:["a","b"],k2:["text"]}}});
  try{
    const turn=session.prompt([{type:"text",text:"Make a theme"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.emit({type:"form.created",data:{form:FORM}});
    await eventually(()=>fake.called("session.form.reply").length===1);
    assert.equal(asked.length,1);assert.equal(asked[0].toolName,"question");assert.ok(asked[0].signal instanceof AbortSignal);
    assert.deepEqual(asked[0].input,{questions:[
      // Only the choices answer a field that takes no words of the person's own (field.custom).
      {id:"k1",header:"Colors",question:"Which colors should the theme use?",multiSelect:true,options:[{label:"Amber",description:"Warm",value:"a"},{label:"Blue",description:"",value:"b"}],allowCustomAnswer:false},
      {id:"k2",header:"Name",question:"What should the theme be called?",multiSelect:false,options:[]},
    ]});
    assert.deepEqual(fake.called("session.form.reply"),[{sessionID:"ses_main",formID:"frm_1",answer:{k1:["a","b"],k2:"text"}}]);
    assert.equal(fake.called("session.form.cancel").length,0);
    // The question held nothing: the turn goes on with the answers and ends as OpenCode ends it.
    fake.emit({type:"form.replied",data:{id:"frm_1",sessionID:"ses_main",answer:{k1:["a","b"],k2:"text"}}});
    ended(fake);assert.equal((await turn).stopReason,"end_turn");
  }finally{await session.close()}
});

// A question left unanswered ends the turn (tests/opencode2-question-unanswered.test.mjs).
test("a subagent's OpenCode 2 question is asked and answered as its own",async()=>{
  const fake=fakeOpenCode2({sessions:{ses_child:{id:"ses_child",parentID:"ses_main"}}});
  const {session}=await startedSession(fake,{onQuestion:async()=>({q0:["Blue"]})});
  try{
    const turn=session.prompt([{type:"text",text:"Ask me"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.emit({type:"form.created",data:{form:{id:"frm_3",sessionID:"ses_child",title:"Questions",fields:[{key:"q0",type:"string",title:"Color",options:[{value:"Blue",label:"Blue"}],custom:true}]}}});
    await eventually(()=>fake.called("session.form.reply").length===1);
    assert.deepEqual(fake.called("session.form.reply"),[{sessionID:"ses_child",formID:"frm_3",answer:{q0:"Blue"}}]);
    assert.equal(fake.called("session.form.cancel").length,0);
    ended(fake);assert.equal((await turn).stopReason,"end_turn");
  }finally{await session.close()}
});

test("an OpenCode 2 question the dialog cannot show (a yes or no field) is declined and the turn ends saying why, instead of waiting for good",async()=>{
  const asked=[],fake=fakeOpenCode2(),{session}=await startedSession(fake,{onQuestion:async request=>{asked.push(request);return {}}});
  try{
    const turn=session.prompt([{type:"text",text:"Deploy"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.emit({type:"form.created",data:{form:{id:"frm_4",sessionID:"ses_main",title:"Confirm",fields:[{key:"ok",type:"boolean",title:"Deploy now?"}]}}});
    await assert.rejects(turn,{message:"OpenCode asked for a yes or no answer, which Trebell Code's question dialog cannot show, so Trebell declined the question and stopped the turn."});
    assert.equal(asked.length,0);
    // Without a message the cancel stops the run, as OpenCode's own Stop does.
    assert.deepEqual(fake.called("session.form.cancel"),[{sessionID:"ses_main",formID:"frm_4"}]);
    // A link to open, a hidden field and one that depends on another are declined the same way.
    for(const [field,what] of [[{key:"x",type:"external",url:"https://example.com"},"a link to open"],[{key:"x",type:"string",hidden:true},"a hidden field"],[{key:"x",type:"string",when:[{key:"y",equals:"z"}]},"a field that depends on another"],[{key:"x",type:"number"},"a number"]]){
      const next=session.prompt([{type:"text",text:"Again"}]);
      await eventually(()=>session.activePrompt);
      fake.emit({type:"form.created",data:{form:{id:`frm_${what}`,sessionID:"ses_main",title:"Form",fields:[field]}}});
      await assert.rejects(next,{message:`OpenCode asked for ${what}, which Trebell Code's question dialog cannot show, so Trebell declined the question and stopped the turn.`});
    }
  }finally{await session.close()}
});

test("an OpenCode 2 question settled elsewhere leaves the dialog and sends nothing, and one open when the turn is stopped is cancelled with it",async()=>{
  const signals=[],release=[],fake=fakeOpenCode2();
  const {session}=await startedSession(fake,{onQuestion:request=>{signals.push(request.signal);return new Promise(resolve=>release.push(resolve))}});
  try{
    const turn=session.prompt([{type:"text",text:"Ask me"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.emit({type:"form.created",data:{form:FORM}});
    await eventually(()=>signals.length===1);
    // OpenCode's own app answered it: the card is withdrawn through its signal, and Trebell neither answers nor cancels it.
    fake.emit({type:"form.replied",data:{id:"frm_1",sessionID:"ses_main",answer:{k2:"elsewhere"}}});
    await eventually(()=>signals[0].aborted);
    release.shift()?.({k2:["late"]});await delay(30);
    assert.equal(fake.called("session.form.reply").length+fake.called("session.form.cancel").length,0);
    // Stop while a question is open: the run stops, and the question goes with it (cancelled without a message).
    fake.emit({type:"form.created",data:{form:{...FORM,id:"frm_5"}}});
    await eventually(()=>signals.length===2);
    await session.cancel();
    release.shift()?.({});
    await eventually(()=>fake.called("session.form.cancel").length===1);
    assert.deepEqual(fake.called("session.form.cancel"),[{sessionID:"ses_main",formID:"frm_5"}]);
    assert.equal((await turn).stopReason,"cancelled");
  }finally{await session.close()}
});

// The question tool fails with the reason, which its row shows; no error notice ends the window's turn (opencode2-question-refused).
test("an answer OpenCode 2 refuses is declined with OpenCode's reason, which the model is told",async()=>{
  const fake=fakeOpenCode2({overrides:{"session.form.reply":async()=>{throw Object.assign(new Error("Invalid option for form field: k1"),{name:"FormInvalidAnswerError"})}}});
  const {session,updates}=await startedSession(fake,{onQuestion:async()=>({k1:["zzz"],k2:["x"]})});
  try{
    const turn=session.prompt([{type:"text",text:"Make a theme"}]);
    await eventually(()=>fake.called("session.prompt").length===1);
    fake.emit({type:"form.created",data:{form:FORM}});
    await eventually(()=>fake.called("session.form.cancel").length===1);
    assert.deepEqual(fake.called("session.form.cancel")[0],{sessionID:"ses_main",formID:"frm_1",message:"The user's answer could not be given: Invalid option for form field: k1. Continue without it, and tell the user what you would need from them."});
    assert.deepEqual(notices(updates),[]);
    ended(fake);assert.equal((await turn).stopReason,"end_turn");
  }finally{await session.close()}
});
