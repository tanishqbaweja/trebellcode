// The agent relay with an OpenCode 1.x profile whose own server (serverUrl) is the fake OpenCode 1.x server: the real relay drives the
// real OpenCodeAgentSession and @opencode-ai/sdk against it, and a WebSocket client stands in for the window. rpc(method, params) is a
// window request; messages are everything the relay sent the window; completed() is the first turn's turn/completed.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { eventuallyReal, startFakeOpenCode1 } from "./fake-opencode1-server.mjs";

export { eventuallyReal };

export async function openCode1Relay(t,{onPrompt=null}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-relay-opencode1-"));
  const fake=await startFakeOpenCode1({onPrompt});
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,serverUrl:fake.url};
  const runtimeManager={
    instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>"opencode",compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:"OpenCode",available:true,authenticated:true,version:"1.18.32"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),executable:()=>"opencode",
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
  t.after(async()=>{
    try{ws.close()}catch{}
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await fake.close();threadStore.close();
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  });
  // The relay has no context engine here, so the session gets no repository MCP.
  const started=await rpc("thread/start",{cwd:root,approvalPolicy:"on-request",sandbox:"workspace-write"});
  return {root,fake,ws,rpc,messages,threadStore,threadId:started.thread.id,completed:()=>eventuallyReal(()=>messages.find(message=>message.method==="turn/completed")?.params,{timeoutMs:20_000})};
}
