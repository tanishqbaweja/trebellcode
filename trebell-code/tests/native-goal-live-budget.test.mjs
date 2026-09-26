import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir,mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ContextEngine } from "../src/context-engine.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}
function rpcClient(ws){
  let id=0;const pending=new Map(),notifications=[],waiters=[];
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!=null&&pending.has(message.id)){const target=pending.get(message.id);pending.delete(message.id);message.error?target.reject(Object.assign(new Error(message.error.message),{code:message.error.code})):target.resolve(message.result);return}if(message.method){notifications.push(message);for(let index=waiters.length-1;index>=0;index--){const waiter=waiters[index];if(waiter.predicate(message)){waiters.splice(index,1);clearTimeout(waiter.timer);waiter.resolve(message)}}}});
  return {request(method,params={}){return new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}))})},waitFor(predicate,timeoutMs=15_000){const found=notifications.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error("Timed out waiting for relay notification"))},timeoutMs)};waiters.push(waiter)})}};
}
async function harness(providerTurn){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-live-budget-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn:providerTurn,version:"test"});const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  return {root,repo,state,threadStore,relay,server,ws,rpc:rpcClient(ws),async close(){try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}};
}

test("Native goal model-turn budget stops the live loop and persists exact model-turn usage",async()=>{
  let providerCalls=0;const h=await harness(async()=>{providerCalls++;return {id:"budget-model-"+providerCalls,provider:"agentrouter",model:"model-a",text:"",toolCalls:[{id:"repo-"+providerCalls,namespace:"trebell_repo",name:"search_symbols",arguments:JSON.stringify({query:"nothing"})}],finishReason:"tool_calls",usage:{}}});
  try{
    const thread=(await h.rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:h.repo,projectless:false,permissionProfile:"full",dynamicTools:[]})).thread;await h.rpc.request("thread/goal/set",{threadId:thread.id,objective:"Use at most two model turns",turnBudget:2});
    const turn=(await h.rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",input:[{type:"text",text:"Keep searching"}]})).turn;const completed=await h.rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);
    assert.equal(completed.params.turn.status,"failed");assert.match(completed.params.turn.error?.message||"",/model-turn budget exhausted \(2\/2\)/i);assert.equal(providerCalls,2);
    const stored=h.threadStore.get(thread.id).turns.find(item=>item.id===turn.id);assert.equal(stored.modelTurns,2);
    const goal=(await h.rpc.request("thread/goal/get",{threadId:thread.id})).goal;assert.equal(goal.turnsUsed,2);assert.equal(goal.turnBudgetRemaining,0);assert.equal(goal.budgetExhausted,true);
    await assert.rejects(()=>h.rpc.request("turn/start",{threadId:thread.id,input:[{type:"text",text:"one more"}]}),/turn budget exhausted/i);assert.equal(providerCalls,2);
  }finally{await h.close()}
});

test("Native goal wall-time budget aborts an in-flight provider before the turn can overrun",async()=>{
  let providerAborted=false;const h=await harness(async({signal})=>new Promise((resolve,reject)=>{const aborted=()=>{providerAborted=true;const error=new Error("slow provider aborted");error.name="AbortError";reject(error)};if(signal.aborted)return aborted();signal.addEventListener("abort",aborted,{once:true});setTimeout(()=>resolve({id:"too-late",provider:"agentrouter",model:"model-a",text:"late",toolCalls:[],finishReason:"stop",usage:{}}),10_000)}));
  try{
    const thread=(await h.rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:h.repo,projectless:false,permissionProfile:"full",dynamicTools:[]})).thread;await h.rpc.request("thread/goal/set",{threadId:thread.id,objective:"Stop after one minute of agent work",timeBudgetMinutes:1});
    const now=Math.floor(Date.now()/1000),prior=h.threadStore.addTurn(thread.id,{id:"prior-work",inputText:"prior",status:"completed",startedAt:now});h.threadStore.updateTurn(thread.id,prior.id,{status:"completed",completedAt:now+59,durationMs:59_000,modelTurns:0});h.threadStore.update(thread.id,{status:{type:"idle"}});
    const before=(await h.rpc.request("thread/goal/get",{threadId:thread.id})).goal;assert.equal(before.timeUsedSeconds,59);assert.ok(before.timeBudgetRemainingMinutes>0&&before.timeBudgetRemainingMinutes<0.02);
    const turn=(await h.rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",input:[{type:"text",text:"slow work"}]})).turn;const completed=await h.rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);
    assert.equal(completed.params.turn.status,"failed");assert.match(completed.params.turn.error?.message||"",/wall-time budget exhausted/i);assert.equal(providerAborted,true);
    const stored=h.threadStore.get(thread.id).turns.find(item=>item.id===turn.id);assert.equal(stored.modelTurns,1);
    const goal=(await h.rpc.request("thread/goal/get",{threadId:thread.id})).goal;assert.ok(goal.timeUsedSeconds>=60);assert.equal(goal.timeBudgetRemainingMinutes,0);assert.equal(goal.budgetExhausted,true);
  }finally{await h.close()}
});

test("Native persists the requested model-turn count before provider completion for crash-safe budgeting",async()=>{
  let releaseProvider;const requested=new Promise(resolve=>{releaseProvider=resolve});let providerEntered=false;
  const h=await harness(async()=>{providerEntered=true;await requested;return {id:"done",provider:"agentrouter",model:"model-a",text:"done",toolCalls:[],finishReason:"stop",usage:{}}});
  try{
    const thread=(await h.rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:h.repo,projectless:false,permissionProfile:"full",dynamicTools:[]})).thread;await h.rpc.request("thread/goal/set",{threadId:thread.id,objective:"Persist in-flight model work",turnBudget:3});
    const turn=(await h.rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",input:[{type:"text",text:"wait"}]})).turn;
    for(let attempt=0;attempt<100&&!providerEntered;attempt++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(providerEntered,true);
    const inFlight=h.threadStore.get(thread.id).turns.find(item=>item.id===turn.id);assert.equal(inFlight.status,"inProgress");assert.equal(inFlight.modelTurns,1);
    const goal=(await h.rpc.request("thread/goal/get",{threadId:thread.id})).goal;assert.equal(goal.turnsUsed,1);assert.equal(goal.turnBudgetRemaining,2);
    releaseProvider();const completed=await h.rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(completed.params.turn.status,"completed");assert.equal(h.threadStore.get(thread.id).turns.find(item=>item.id===turn.id).modelTurns,1);
  }finally{releaseProvider?.();await h.close()}
});
