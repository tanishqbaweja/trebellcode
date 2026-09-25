import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp,mkdir,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ContextEngine } from "../src/context-engine.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

async function listen(server){
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port;
}

function client(ws){
  let id=0;const pending=new Map(),notifications=[],waiters=[];
  ws.on("message",raw=>{
    const message=JSON.parse(String(raw));
    if(message.id!=null&&pending.has(message.id)){
      const target=pending.get(message.id);pending.delete(message.id);message.error?target.reject(new Error(message.error.message)):target.resolve(message.result);return;
    }
    if(message.method){notifications.push(message);for(let index=waiters.length-1;index>=0;index--){const waiter=waiters[index];if(waiter.predicate(message)){waiters.splice(index,1);clearTimeout(waiter.timer);waiter.resolve(message)}}}
  });
  return {
    request(method,params={}){return new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}))})},
    waitFor(predicate,timeoutMs=5000){const found=notifications.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error("Timed out waiting for relay notification"))},timeoutMs)};waiters.push(waiter)})},
  };
}

test("Trebell Native relay executes repository tools and switches inference provider without changing thread identity",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await writeFile(join(repo,"session.js"),"export class SessionManager { refresh(){ return true; } }\n","utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),providers=[];let modelTurns=0;
  const nativeProviderTurn=async request=>{
    providers.push(request.provider);modelTurns++;
    if(modelTurns===1)return {id:"native-first",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"repo-call",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"SessionManager"}'}],finishReason:"tool_calls",usage:{inputTokens:4,outputTokens:1,totalTokens:5}};
    if(modelTurns===2){assert.equal(request.messages.at(-1).role,"tool");assert.match(request.messages.at(-1).content,/SessionManager/);return {id:"native-answer",provider:request.provider,model:request.model,text:"Found SessionManager.",toolCalls:[],finishReason:"stop",usage:{inputTokens:8,outputTokens:3,totalTokens:11}}}
    return {id:"native-second-provider",provider:request.provider,model:request.model,text:"Still the same Trebell thread.",toolCalls:[],finishReason:"stop",usage:{inputTokens:6,outputTokens:4,totalTokens:10}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const started=await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,approvalPolicy:"never",sandbox:"read-only",dynamicTools:[],developerInstructions:"Use repository intelligence when useful."});
    const threadId=started.thread.id;assert.equal(started.thread.runtime,"native");assert.equal(started.thread.providerMeta.modelProvider,"agentrouter");assert.equal(started.thread.providerSessionId.startsWith("native_"),true);
    const first=await rpc.request("turn/start",{threadId,model:"model-a",modelProvider:"agentrouter",approvalPolicy:"never",sandboxPolicy:{type:"readOnly"},input:[{type:"text",text:"Find SessionManager"}]});
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===first.turn.id);
    const afterFirst=(await rpc.request("thread/read",{threadId})).thread;assert.equal(afterFirst.id,threadId);assert.equal(afterFirst.turns.length,1);
    const items=afterFirst.turns[0].items;assert.ok(items.some(item=>item.type==="dynamicToolCall"&&item.namespace==="trebell_repo"&&item.tool==="search_symbols"));assert.ok(items.some(item=>item.type==="agentMessage"&&/Found SessionManager/.test(item.text)));

    const second=await rpc.request("turn/start",{threadId,model:"model-b",modelProvider:"hcnsec",approvalPolicy:"never",sandboxPolicy:{type:"readOnly"},input:[{type:"text",text:"Continue on the same thread"}]});
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===second.turn.id);
    const afterSecond=(await rpc.request("thread/read",{threadId})).thread;assert.equal(afterSecond.id,threadId);assert.equal(afterSecond.turns.length,2);assert.equal(afterSecond.model,"model-b");assert.equal(afterSecond.providerMeta.modelProvider,"hcnsec");
    assert.deepEqual(providers,["agentrouter","agentrouter","hcnsec"]);
  }finally{
    try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
  }
});

test("Trebell Native relay can edit workspace files and run bounded terminal commands through the same agent loop",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-coding-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await writeFile(join(repo,"app.js"),"export const answer = 1;\n","utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let step=0;
  const nativeProviderTurn=async request=>{
    step++;
    const namespaces=(request.tools||[]).map(item=>item.name);assert.ok(namespaces.includes("trebell_workspace"));assert.ok(namespaces.includes("trebell_terminal"));
    if(step===1)return {id:"coding-edit",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"edit-1",namespace:"trebell_workspace",name:"replace_text",arguments:JSON.stringify({path:"app.js",old_text:"answer = 1",new_text:"answer = 42"})}],finishReason:"tool_calls",usage:{}};
    if(step===2){assert.equal(request.messages.at(-1).role,"tool");assert.match(request.messages.at(-1).content,/replacements.*1/);return {id:"coding-run",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"run-1",namespace:"trebell_terminal",name:"run",arguments:JSON.stringify({command:process.execPath,args:["-e","import('./app.js').then(m=>process.stdout.write(String(m.answer)))"],cwd:".",timeout_ms:5000})}],finishReason:"tool_calls",usage:{}}}
    assert.equal(request.messages.at(-1).role,"tool");assert.match(request.messages.at(-1).content,/42/);return {id:"coding-done",provider:request.provider,model:request.model,text:"Changed answer to 42 and verified it.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"Change answer to 42 and verify it"}]})).turn;
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);
    assert.equal(await (await import("node:fs/promises")).readFile(join(repo,"app.js"),"utf8"),"export const answer = 42;\n");
    const persisted=(await rpc.request("thread/read",{threadId:thread.id})).thread.turns[0].items;
    assert.ok(persisted.some(item=>item.type==="dynamicToolCall"&&item.namespace==="trebell_workspace"&&item.tool==="replace_text"&&item.success===true));
    assert.ok(persisted.some(item=>item.type==="dynamicToolCall"&&item.namespace==="trebell_terminal"&&item.tool==="run"&&item.success===true));
    assert.ok(persisted.some(item=>item.type==="agentMessage"&&/verified it/.test(item.text)));
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
});

test("Trebell Native verification repair reuses the same thread and persisted failed evidence",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-repair-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);const providerRequests=[];
  const nativeProviderTurn=async request=>{providerRequests.push(structuredClone({...request,signal:undefined}));return {id:"repair-answer",provider:request.provider,model:request.model,text:"Repaired and rechecked.",toolCalls:[],finishReason:"stop",usage:{}}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const plan={risk:"medium",steps:[{id:"tests",kind:"tests",scope:"affected",required:true,cost:"low",reason:"Changed code has related tests."}]};
    state.recordVerification({id:"native-repair-record",threadId:thread.id,projectPath:repo,plan,evidence:[{stepId:"tests",exitCode:1,status:"failed",reason:"Parser regression failed",stdout:"SHOULD_NOT_BE_IN_REPAIR_CONTEXT"}]});
    const current=await rpc.request("thread/verification/get",{threadId:thread.id});assert.equal(current.record.id,"native-repair-record");assert.equal(current.nextAction.action,"repair");
    const repaired=await rpc.request("thread/verification/repair",{threadId:thread.id});assert.equal(repaired.record.id,"native-repair-record");assert.equal(repaired.nextAction.action,"repair");assert.ok(repaired.turn?.id);
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===repaired.turn.id);
    assert.equal(providerRequests.length,1);const prompt=JSON.stringify(providerRequests[0].messages.at(-1)?.content||"");assert.match(prompt,/Repair the failed verification/i);assert.match(prompt,/Parser regression failed/);assert.doesNotMatch(prompt,/SHOULD_NOT_BE_IN_REPAIR_CONTEXT/);
    const persisted=(await rpc.request("thread/read",{threadId:thread.id})).thread;assert.equal(persisted.id,thread.id);assert.equal(persisted.turns.length,1);assert.ok(persisted.turns[0].items.some(item=>item.type==="agentMessage"&&/Repaired and rechecked/.test(item.text)));
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
});
