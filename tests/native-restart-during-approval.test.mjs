// Trebell restarting while a Supervised Native turn waits on a command's approval (tour L10-F-3, L10-7). The provider had already
// answered the turn's first request, with its usage, but the turn's usage record was never written: the relay's close took the
// session out of its list before the session's last usage update came, so the update was dropped. And the command that never got
// its answer read "node count-lines.js failed" when the thread was opened again, as if it had run and failed.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ContextEngine } from "../src/context-engine.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { nativeMessagesFromThread } from "../src/native-agent-session.mjs";
import { activityRow, storedRow } from "../ui/src/activity-item.js";

// kill: Trebell is killed instead (a crash, a power cut): nothing closes the relay, and the next start's store reconciles the thread.
async function closeWhileApprovalWaits({kill=false}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-close-approval-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0;
  const nativeProviderTurn=async request=>{
    calls++;
    // The second request, after the command's answer, waits until the close stops it, as a real one would.
    if(calls>1)return new Promise((_resolve,reject)=>{const stop=()=>reject(Object.assign(new Error("This operation was aborted"),{name:"AbortError"}));if(request.signal?.aborted)stop();else request.signal?.addEventListener("abort",stop,{once:true})});
    return {id:"first",provider:request.provider,model:request.model,text:"",finishReason:"tool_calls",usage:{inputTokens:5797,outputTokens:102,totalTokens:5899,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:11},
      toolCalls:[{id:"run-1",namespace:"trebell_terminal",name:"run",arguments:JSON.stringify({command:process.execPath,args:["count-lines.js"],cwd:"."})}]};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  let id=0;const pending=new Map(),seen=[],waiters=[];
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!=null&&pending.has(message.id)&&!message.method){pending.get(message.id)(message.result);pending.delete(message.id);return}seen.push(message);for(const waiter of [...waiters])if(waiter.match(message)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message)}});
  const rpc=(method,params)=>new Promise(resolve=>{const requestId=++id;pending.set(requestId,resolve);ws.send(JSON.stringify({id:requestId,method,params}))});
  const waitFor=match=>new Promise(resolve=>{const found=seen.find(match);if(found)return resolve(found);waiters.push({match,resolve})});
  try{
    const thread=(await rpc("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"supervised",dynamicTools:[]})).thread;
    const turn=(await rpc("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"supervised",input:[{type:"text",text:"Run node count-lines.js and tell me what it printed."}]})).turn;
    await waitFor(message=>message.method==="item/tool/requestApproval");
    if(kill){
      const restarted=new AgentThreadStore(env);restarted.reconcileRestart();
      return {threadStore:restarted,threadId:thread.id,turnId:turn.id,cleanup:async()=>{try{ws.close()}catch{}await relay.close().catch(()=>{});await new Promise(resolve=>server.close(()=>resolve()));state.close?.();restarted.close?.();threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}};
    }
    // Trebell restarts: the server closes the relay while the card waits.
    await relay.close();
    return {state,threadStore,threadId:thread.id,turnId:turn.id,cleanup:async()=>{try{ws.close()}catch{}await new Promise(resolve=>server.close(()=>resolve()));state.close?.();threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}};
  }catch(error){try{ws.close()}catch{}await relay.close().catch(()=>{});throw error}
}

test("a turn Trebell's close ends keeps the usage of the request its provider had answered",{timeout:60000},async()=>{
  const run=await closeWhileApprovalWaits();
  try{
    const record=run.state.usage({days:1}).records.find(item=>item.turnId===run.turnId);
    assert.ok(record,"the turn has its usage record");
    assert.equal(record.runtime,"native");assert.equal(record.threadId,run.threadId);
    assert.equal(record.usage.inputTokens,5797);assert.equal(record.usage.outputTokens,102);
  }finally{await run.cleanup()}
});

test("a command whose approval waited when Trebell closed reads not run, and says why",{timeout:60000},async()=>{
  const run=await closeWhileApprovalWaits();
  try{
    const thread=run.threadStore.get(run.threadId),turn=thread.turns.find(item=>item.id===run.turnId),item=turn.items.find(entry=>entry.id==="run-1");
    assert.equal(item.status,"notRun","the call did not run");
    const row=storedRow(activityRow(item,{turnId:run.turnId}));
    assert.equal(row.status,"notRun","its row reads not run, not failed");
    assert.equal(row.output,"Trebell closed before this was approved, so it did not run.","its row says why, in plain words");
    const told=nativeMessagesFromThread(thread).find(message=>message.role==="tool"&&message.toolCallId==="run-1");
    assert.match(String(told.content),/Trebell closed before this was approved, so it did not run\./,"the model reads the same when the thread goes on");
  }finally{await run.cleanup()}
});

test("a command whose approval waited when Trebell was killed reads not run after the restart, and says why",{timeout:60000},async()=>{
  const run=await closeWhileApprovalWaits({kill:true});
  try{
    const thread=run.threadStore.get(run.threadId),turn=thread.turns.find(item=>item.id===run.turnId),item=turn.items.find(entry=>entry.id==="run-1");
    assert.equal(turn.status,"failed","the restart ends the turn");
    assert.equal(item.status,"notRun","the call did not run");
    const row=storedRow(activityRow(item,{turnId:run.turnId}));
    assert.equal(row.status,"notRun","its row reads not run, not stopped");
    assert.equal(row.output,"Trebell closed before this was approved, so it did not run.","its row says why, in plain words");
    const told=nativeMessagesFromThread(thread).find(message=>message.role==="tool"&&message.toolCallId==="run-1");
    assert.match(String(told.content),/Trebell closed before this was approved, so it did not run./,"the model reads the same when the thread goes on");
  }finally{await run.cleanup()}
});

test("a command whose card was answered is not marked as waiting, so a later kill does not call it not run",{timeout:60000},async()=>{
  const {AgentThreadStore:Store}=await import("../src/agent-thread-store.mjs");
  const root=await mkdtemp(join(tmpdir(),"trebell-native-answered-approval-")),env={...process.env,TREBELL_HOME:join(root,"home")};
  const store=new Store(env);
  try{
    const thread=store.create({runtime:"native",cwd:root}),turn=store.addTurn(thread.id,{inputText:"run it"});
    store.addItem(thread.id,turn.id,{type:"dynamicToolCall",id:"run-2",namespace:"trebell_terminal",tool:"run",arguments:{command:"node"},status:"inProgress",awaitingApproval:false});
    store.update(thread.id,{status:{type:"active"}});
    const restarted=new Store(env);restarted.reconcileRestart();
    const item=restarted.get(thread.id).turns[0].items.find(entry=>entry.id==="run-2");
    assert.notEqual(item.status,"notRun","a call that went past its card may have run");
    restarted.close?.();
  }finally{store.close?.();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
