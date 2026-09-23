import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";

async function listen(server){
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  return server.address().port;
}

function rpc(ws){
  let id=0;const pending=new Map();
  ws.on("message",raw=>{
    const message=JSON.parse(String(raw));
    if(message.id==null||!pending.has(message.id))return;
    const target=pending.get(message.id);pending.delete(message.id);
    message.error?target.reject(new Error(message.error.message)):target.resolve(message.result);
  });
  return (method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}));
  });
}

test("agent relay switches an idle Claude thread only between compatible profiles",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-agent-profile-"));
  const env={...process.env,TREBELL_HOME:join(root,"home")};
  const threadStore=new AgentThreadStore(env);
  const instances=[
    {id:"claude-work",kind:"claude",displayName:"Claude Work",homePath:"/srv/.claude",enabled:true},
    {id:"claude-router",kind:"claude",displayName:"Claude Router",homePath:"/srv/.claude",enabled:true},
    {id:"claude-signed-out",kind:"claude",displayName:"Claude Signed Out",homePath:"/srv/.claude",enabled:true},
    {id:"claude-personal",kind:"claude",displayName:"Claude Personal",homePath:"/srv/.claude-personal",enabled:true},
  ];
  const runtimeManager={
    instances:()=>instances.map(item=>({...item})),
    activeRuntime:()=>"claude",
    activeInstance:()=>instances[0],
    compatibleInstanceIds:instanceId=>{
      const selected=instances.find(item=>item.id===instanceId)||instances[0];
      return instances.filter(item=>item.kind===selected.kind&&item.homePath===selected.homePath).map(item=>item.id);
    },
    probe:async instance=>({id:instance.id,name:instance.displayName,available:true,authenticated:instance.id!=="claude-signed-out",version:"fixture"}),
  };
  const state={settings:()=>({activeEnvironmentId:null})};
  const seed=threadStore.create({runtime:"claude",cwd:root,providerSessionId:"claude-session",model:"sonnet",providerMeta:{runtimeInstanceId:"claude-router",environmentId:null}});
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"test"});
  const port=await listen(server);const ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  const request=rpc(ws);
  try{
    const listed=await request("thread/runtimeInstances/list",{threadId:seed.id});
    assert.equal(listed.supported,true);
    assert.deepEqual(listed.items.map(item=>item.id),["claude-work","claude-router","claude-signed-out"]);
    assert.equal(listed.currentInstanceId,"claude-router");
    assert.equal(listed.items.find(item=>item.id==="claude-signed-out").authenticated,false);

    const switched=await request("thread/runtimeInstance/set",{threadId:seed.id,instanceId:"claude-work"});
    assert.equal(switched.thread.runtimeInstanceId,"claude-work");
    assert.equal(switched.thread.providerMeta.runtimeInstanceId,"claude-work");
    assert.equal(threadStore.get(seed.id).providerSessionId,"claude-session");

    await assert.rejects(()=>request("thread/runtimeInstance/set",{threadId:seed.id,instanceId:"claude-signed-out"}),/sign in/i);
    await assert.rejects(()=>request("thread/runtimeInstance/set",{threadId:seed.id,instanceId:"claude-personal"}),/different config directory/i);
    threadStore.update(seed.id,{status:{type:"active",activeFlags:[]}});
    await assert.rejects(()=>request("thread/runtimeInstance/set",{threadId:seed.id,instanceId:"claude-router"}),/stop the running turn/i);
  }finally{
    try{ws.close()}catch{}
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
  }
});
