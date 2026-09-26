import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access,mkdir,mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ContextEngine } from "../src/context-engine.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}
function client(ws){
  let id=0;const pending=new Map(),notifications=[],waiters=[];
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!=null&&pending.has(message.id)){const target=pending.get(message.id);pending.delete(message.id);message.error?target.reject(new Error(message.error.message)):target.resolve(message.result);return}if(message.method){notifications.push(message);for(let index=waiters.length-1;index>=0;index--){const waiter=waiters[index];if(waiter.predicate(message)){waiters.splice(index,1);clearTimeout(waiter.timer);waiter.resolve(message)}}}});
  return {request(method,params={}){return new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}))})},waitFor(predicate,timeoutMs=5000){const found=notifications.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error("Timed out waiting for relay notification"))},timeoutMs)};waiters.push(waiter)})}};
}

test("Native recipe tool allowlist blocks a disallowed tool before execution",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-recipe-policy-")),home=join(root,"home"),repo=join(root,"repo"),blocked=join(repo,"blocked.txt");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0;
  const nativeProviderTurn=async request=>{
    calls++;
    if(calls===1){assert.ok((request.tools||[]).some(namespace=>namespace.name==="trebell_terminal"));return {id:"recipe-disallowed-call",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"blocked-terminal",namespace:"trebell_terminal",name:"run",arguments:JSON.stringify({command:process.execPath,args:["-e",`require('fs').writeFileSync(${JSON.stringify(blocked)},'bad')`],cwd:repo})}],finishReason:"tool_calls",usage:{}}}
    const observation=request.messages.at(-1);assert.equal(observation.role,"tool");assert.match(String(observation.content),/not allowed by the active recipe/i);return {id:"recipe-policy-done",provider:request.provider,model:request.model,text:"The recipe policy blocked the terminal call.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"full",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"full",toolAllowlist:["repo"],input:[{type:"text",text:"Run the bounded recipe"}]})).turn;
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(calls,2);
    await assert.rejects(()=>access(blocked));
    const persisted=threadStore.get(thread.id).turns[0].items.find(item=>item.type==="dynamicToolCall"&&item.id==="blocked-terminal");assert.ok(persisted);assert.equal(persisted.status,"failed");assert.match(JSON.stringify(persisted),/not allowed by the active recipe/i);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
