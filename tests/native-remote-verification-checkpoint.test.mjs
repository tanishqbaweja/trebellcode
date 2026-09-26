import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}
function rpcClient(ws){
  let id=0;const pending=new Map();
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id==null||!pending.has(message.id))return;const target=pending.get(message.id);pending.delete(message.id);message.error?target.reject(new Error(message.error.message)):target.resolve(message.result)});
  return {request(method,params={}){return new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}))})}};
}

test("Native verification repair creates a checkpoint in the pinned remote environment before repair execution",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-remote-verification-")),env={...process.env,TREBELL_HOME:join(root,"home")};
  const state=new TrebellStateStore(env),threadStore=new AgentThreadStore(env),created=[];
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const thread=threadStore.create({runtime:"native",cwd:"/srv/repo",providerSessionId:"native-remote-session",model:"model-a",providerMeta:{modelProvider:"agentrouter",runtimeInstanceId:"native-default",environmentId:"ssh-1",permissionProfile:"auto",projectless:false,dynamicToolNamespaces:[]}});
  state.updateThreadMeta(thread.id,{cwd:"/srv/repo",runtime:"native",runtimeInstanceId:"native-default",environmentId:"ssh-1"});
  state.recordVerification({id:"remote-repair-record",threadId:thread.id,turnId:"failed-turn",environmentId:"ssh-1",projectPath:"/srv/repo",plan:{risk:"medium",steps:[{id:"tests",kind:"tests",required:true,command:"npm test"}]},evidence:[{stepId:"tests",status:"failed",exitCode:1}]});
  const runtimeManager={
    env,platform:process.platform,activeRuntime:()=>"native",instances:()=>[{id:"native-default",kind:"native",name:"Native"}],activeInstance:()=>({id:"native-default",kind:"native",name:"Native"}),
    probe:async()=>({available:false,message:"deliberate runtime stop after checkpoint"}),
  };
  const checkpoints={create:async input=>{created.push(structuredClone(input));return {supported:true,id:"remote-checkpoint",threadId:input.threadId,root:input.cwd,environmentId:input.environmentId,label:input.label}},link:()=>null};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,checkpoints,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=rpcClient(ws);
  try{
    await assert.rejects(()=>rpc.request("thread/verification/repair",{threadId:thread.id,recordId:"remote-repair-record"}),/deliberate runtime stop after checkpoint/);
    assert.equal(created.length,1);assert.deepEqual(created[0],{cwd:"/srv/repo",threadId:thread.id,label:"Verification repair before remote-repair-record",environmentId:"ssh-1"});
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
