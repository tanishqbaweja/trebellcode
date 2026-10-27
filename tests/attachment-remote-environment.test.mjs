// An image attached on a thread that runs in a remote environment (an SSH or WSL profile). The composer copies every attachment to the
// remote host and keeps the copy's path there (environment-manager prepareAttachment), which this machine cannot read, so a relay
// harness's prompt could never carry the image, and the send was refused as "could not be read (ENOENT). Attach it again.": the file is
// not gone, and attaching it again copies it to the same place and fails the same way. Now the refusal says what is so. Trebell reads a
// thread's images on this machine only (reading them through the environment is a fix of its own).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay, contextualAgentPrompt } from "../src/agent-relay.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { onCleanup, scriptedAcp } from "./fixtures/scripted-acp.mjs";

const REMOTE='The attached image "shot.png" is in this thread\'s remote environment, and Trebell Code sends images to the agent only from this machine. Remove the image to send the message.';
const GROK={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}}},sessionNew:{sessionId:"grok-session"}};

test("an image of a thread in a remote environment is refused saying where it is, and one gone from this machine still says to attach it again",async()=>{
  const remote=[{type:"text",text:"What is this?"},{type:"localImage",path:"/home/dev/.trebell/attachments/1761500000000-ab12cd34-shot.png"}];
  await assert.rejects(contextualAgentPrompt(remote,{},{remote:true}),{message:REMOTE});
  await assert.rejects(contextualAgentPrompt([{type:"localImage",path:join(process.cwd(),"no-such-folder","1761500000000-ab12cd34-shot.png")}],{}),{message:'The attached image "shot.png" could not be read (ENOENT). Attach it again.'});
  // Text and files of a remote thread go as before.
  const parts=await contextualAgentPrompt([{type:"text",text:"Read it"},{type:"mention",name:"notes.md",path:"/home/dev/notes.md"}],{},{remote:true});
  assert.deepEqual(parts.map(part=>part.type),["text","resource_link"]);
});

// The agent relay with a scripted Grok behind it, whose thread folder is in a remote environment: runtimeManager.remoteIo answers for it
// (the harness itself runs here, as the scripted agent does).
async function remoteRelay(t,fx){
  const instance={id:"grok-default",kind:"grok",displayName:"grok",enabled:true},meta=new Map();
  const runtimeManager={
    instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>"grok",compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:"grok",available:true,authenticated:true,version:"fixture"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>({remote:true}),childEnv:()=>({...fx.env}),executable:()=>process.execPath,acpArgs:()=>[...fx.args],
    env:{...process.env,TREBELL_HOME:join(fx.root,"home")},
  };
  const state={settings:()=>({activeEnvironmentId:null}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(fx.root,"home")});
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket("ws://127.0.0.1:"+server.address().port+"/api/agent/ws");await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  onCleanup(t,async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));threadStore.close?.()});
  let id=0;
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
  return {rpc,threadStore};
}

test("a send with an image on a thread in a remote environment is refused saying so before its turn exists, and the harness is sent nothing",async t=>{
  const fx=await scriptedAcp(t,{...GROK,prompts:[{}]});
  // The thread's folder is in a remote environment (runtimeManager.remoteIo answers for it).
  const {rpc,threadStore}=await remoteRelay(t,fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  await assert.rejects(rpc("turn/start",{threadId,input:[{type:"text",text:"What is this?"},{type:"localImage",path:"/home/dev/.trebell/attachments/1761500000000-ab12cd34-shot.png"}]}),{message:REMOTE});
  assert.deepEqual(threadStore.get(threadId).turns,[],"no turn is left running behind the refusal");
  const log=await fx.log();
  assert.equal(log.filter(entry=>entry.method==="session/prompt").length,0,"Grok was sent nothing");
});
