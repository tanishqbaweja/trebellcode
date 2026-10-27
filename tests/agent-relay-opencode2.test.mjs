import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { attachAgentRelay, contextualAgentPrompt } from "../src/agent-relay.mjs";
import { fileUri } from "../src/file-uri.mjs";
import { startFakeOpenCode2, writeFakeOpenCode2Serve } from "./fixtures/fake-opencode2-server.mjs";

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check,{timeoutMs=8000,message="condition was not met in time"}={}){
  const startedAt=Date.now();
  for(;;){let value=null;try{value=await check()}catch{}if(value)return value;if(Date.now()-startedAt>timeoutMs)throw new Error(message);await delay(20)}
}
const PNG=Buffer.from("89504e470d0a1a0a0000000d49484452","hex");

test("a pasted image keeps its saved file on its prompt part for OpenCode 2, and the other harnesses are sent the same prompt as before",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-relay-image-path-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  const shot=join(root,"shot.png");await writeFile(shot,PNG);
  const prompt=await contextualAgentPrompt([{type:"text",text:"What is this?"},{type:"localImage",path:shot},{type:"mention",name:"notes.md",path:join(root,"notes.md")}],{});
  // Cursor, Grok, Antigravity, Claude Code, Muse Code and Trebell Native read the parts as JSON or by their fields: unchanged.
  assert.equal(JSON.stringify(prompt),JSON.stringify([{type:"text",text:"What is this?"},{type:"image",mimeType:"image/png",data:PNG.toString("base64")},{type:"resource_link",uri:fileUri(join(root,"notes.md")),name:"notes.md"}]));
  assert.deepEqual(Object.keys(prompt[1]),["type","mimeType","data"]);
  assert.equal(prompt[1][Symbol.for("trebell.prompt.image-path")],shot,"the image part names its saved file");
});

// The relay with a profile of OpenCode 2 behind it: the real OpenCode 2 session and @opencode/client against the fake server, its
// `opencode serve` the folder's `serve` stand-in (so the server is the session's own) or, with serverUrl, the fake server itself.
async function openCode2Relay(t,{serverUrl=false,onPrompt=null,sessions={}}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-relay-opencode2-"));
  const fake=await startFakeOpenCode2({onPrompt,sessions});
  await writeFakeOpenCode2Serve(root);
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,...(serverUrl?{serverUrl:fake.url}:{})};
  const runtimeManager={
    instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>"opencode",compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:"OpenCode",available:true,authenticated:true,version:"2.0.24"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env,FAKE_OPENCODE2_URL:fake.url}),executable:()=>process.execPath,
  };
  const meta=new Map(),state={settings:()=>({activeEnvironmentId:null}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},recordUsage:()=>{}};
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"home")});
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  const messages=[];let nextId=0;ws.on("message",raw=>messages.push(JSON.parse(String(raw))));
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++nextId,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==id||message.method)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id,method,params}));
  });
  // The relay closes the session first, which stops the `serve` stand-in that runs in the folder.
  t.after(async()=>{
    try{ws.close()}catch{}
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await fake.close();threadStore.close();
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  });
  const started=await rpc("thread/start",{cwd:root,approvalPolicy:"on-request",sandbox:"workspace-write"});
  return {root,fake,ws,rpc,messages,threadStore,threadId:started.thread.id,completed:()=>eventually(()=>messages.find(message=>message.method==="turn/completed")?.params)};
}
const text=(emit,sessionID,words)=>{emit({type:"session.text.started",data:{sessionID,assistantMessageID:"msg_a1",ordinal:0}});emit({type:"session.text.delta",data:{sessionID,assistantMessageID:"msg_a1",delta:words}})};
const succeeded=(emit,sessionID)=>emit({type:"session.execution.succeeded",data:{sessionID}});

test("an image sent to OpenCode 2 through the relay reaches it as a file it reads itself, and the turn completes",async t=>{
  const relay=await openCode2Relay(t,{onPrompt:({sessionID,emit,reply})=>{reply("A red square.");text(emit,sessionID,"A red square.");succeeded(emit,sessionID)}});
  const shot=join(relay.root,"shot.png");await writeFile(shot,PNG);
  await relay.rpc("turn/start",{threadId:relay.threadId,input:[{type:"text",text:"What does this show?"},{type:"localImage",path:shot}]});
  const completed=await relay.completed();
  assert.equal(completed.turn.status,"completed",completed.turn.error?.message);
  const [prompted]=relay.fake.prompts();
  assert.deepEqual(prompted.files,[{uri:fileUri(shot),name:"shot.png"}]);
  assert.ok(prompted.text.endsWith(`What does this show?\n[Attached image "shot.png" is saved at: ${shot}]`),prompted.text);
});

test("an OpenCode 2 retry reaches the window as a retrying error of the turn, and the turn then completes",async t=>{
  let release=()=>{};const gate=new Promise(resolve=>{release=resolve});
  const relay=await openCode2Relay(t,{serverUrl:true,onPrompt:async({sessionID,emit,reply})=>{
    const created=Date.now();emit({type:"session.retry.scheduled",created,data:{sessionID,assistantMessageID:"msg_a1",attempt:2,at:created+30_000,error:{type:"provider.rate-limit",message:"429 Too Many Requests"}}});
    await gate;reply("Hello.");text(emit,sessionID,"Hello.");succeeded(emit,sessionID);
  }});
  await relay.rpc("turn/start",{threadId:relay.threadId,input:[{type:"text",text:"Say hello"}]});
  const error=await eventually(()=>relay.messages.find(message=>message.method==="error")?.params);
  const turnId=relay.threadStore.get(relay.threadId).turns.at(-1).id;
  assert.deepEqual(error,{threadId:relay.threadId,turnId,message:"429 Too Many Requests. OpenCode retries opencode/big-pickle in 30 s (retry 1).",willRetry:true});
  release();
  const completed=await relay.completed();
  assert.equal(completed.turn.status,"completed");
  assert.equal(relay.messages.filter(message=>message.method==="error").length,1);
});

test("an OpenCode 2 question reaches the window as a question card, the answer goes back to OpenCode, and one settled in OpenCode leaves the window",async t=>{
  const FIELDS=[{key:"k1",type:"multiselect",title:"Colors",description:"Which colors?",options:[{value:"a",label:"Amber"},{value:"b",label:"Blue"}]},{key:"k2",type:"string",title:"Name",description:"What name?"}];
  const relay=await openCode2Relay(t,{serverUrl:true,onPrompt:async({sessionID,emit})=>{
    emit({type:"form.created",data:{form:{id:"frm_ask",sessionID,title:"Questions",fields:FIELDS}}});
    await eventually(()=>relay.fake.forms.get("frm_ask")?.settled,{timeoutMs:20_000});
    // A second question the person never answers in Trebell: OpenCode's own app answers it.
    emit({type:"form.created",data:{form:{id:"frm_elsewhere",sessionID,title:"Questions",fields:[FIELDS[1]]}}});
    await eventually(()=>relay.messages.filter(message=>message.method==="item/tool/requestUserInput").length===2,{timeoutMs:20_000});
    emit({type:"form.replied",data:{id:"frm_elsewhere",sessionID,answer:{k2:"from the OpenCode app"}}});
    await delay(100);text(emit,sessionID,"Theme made.");succeeded(emit,sessionID);
  }});
  await relay.rpc("turn/start",{threadId:relay.threadId,input:[{type:"text",text:"Make a theme"}]});
  const asked=await eventually(()=>relay.messages.find(message=>message.method==="item/tool/requestUserInput"));
  assert.deepEqual(asked.params.questions,[
    {id:"k1",header:"Colors",question:"Which colors?",required:true,allowMultiple:true,allowCustomAnswer:false,options:[{label:"Amber",description:"",value:"a"},{label:"Blue",description:"",value:"b"}]},
    {id:"k2",header:"Name",question:"What name?",required:true,allowMultiple:false,options:[]},
  ]);
  relay.ws.send(JSON.stringify({id:asked.id,result:{answers:{k1:{answers:["a","b"]},k2:{answers:["Sunrise"]}}}}));
  await eventually(()=>relay.fake.called("POST /api/session/ses_main/form/frm_ask/reply").length===1);
  assert.deepEqual(relay.fake.called("POST /api/session/ses_main/form/frm_ask/reply")[0].body,{answer:{k1:["a","b"],k2:"Sunrise"}});
  const second=await eventually(()=>relay.messages.filter(message=>message.method==="item/tool/requestUserInput")[1]);
  const resolved=await eventually(()=>relay.messages.find(message=>message.method==="serverRequest/resolved"));
  assert.deepEqual(resolved.params,{requestId:second.id,threadId:relay.threadId},"the card of the question answered in OpenCode is withdrawn");
  const completed=await relay.completed();
  assert.equal(completed.turn.status,"completed");
  assert.equal(relay.fake.called("DELETE /api/session/ses_main/form/frm_elsewhere").length+relay.fake.called("POST /api/session/ses_main/form/frm_elsewhere/reply").length,0,"nothing is sent for a form settled elsewhere");
});
