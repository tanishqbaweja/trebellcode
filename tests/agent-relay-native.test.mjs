import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp,mkdir,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { NATIVE_REPLY_STREAM } from "../src/native-agent-session.mjs";
import { ContextEngine } from "../src/context-engine.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { RETIRED_MODEL_PROVIDERS } from "../src/legacy-provider-migration.mjs";

async function listen(server){
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port;
}

// How long a test waits for a relay notification it expects when it names no bound of its own. A turn that runs git (Git status) or
// indexes the project takes seconds on a host that benchmarks load, where the old 5 s ran out though the turn went on to finish (on one
// CPU at idle priority the Git status turn did); a generous bound still ends a turn that never finishes.
const NOTIFICATION_BOUND_MS=60_000;

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
    waitFor(predicate,timeoutMs=NOTIFICATION_BOUND_MS){const found=notifications.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error("Timed out waiting for relay notification"))},timeoutMs)};waiters.push(waiter)})},
  };
}

const nativeMcpFixture=resolve(fileURLToPath(new URL("fixtures/native-mcp-server.mjs",import.meta.url)));
const execFileAsync=promisify(execFile);

test("Trebell Native relay executes repository tools and switches inference provider without changing thread identity",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await writeFile(join(repo,"session.js"),"export class SessionManager { refresh(){ return true; } }\n","utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),providers=[],contextLookups=[];let modelTurns=0;
  const nativeProviderTurn=async request=>{
    providers.push(request.provider);modelTurns++;
    assert.equal(request.messages[0]?.role,"system");assert.match(String(request.messages[0]?.content||""),/You are Trebell Native/);assert.match(String(request.messages[0]?.content||""),/Use the exposed repository tools/i);
    assert.equal(request.messages[1]?.role,"developer");assert.match(String(request.messages[1]?.content||""),/Use repository intelligence when useful/);
    if(modelTurns===1)return {id:"native-first",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"repo-call",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"SessionManager"}'}],finishReason:"tool_calls",usage:{inputTokens:4,outputTokens:1,totalTokens:5,reasoningOutputTokens:1}};
    if(modelTurns===2){assert.equal(request.messages.at(-1).role,"tool");assert.match(request.messages.at(-1).content,/SessionManager/);return {id:"native-answer",provider:request.provider,model:request.model,text:"Found SessionManager.",toolCalls:[],finishReason:"stop",usage:{inputTokens:8,outputTokens:3,totalTokens:11,reasoningOutputTokens:2}}}
    return {id:"native-second-provider",provider:request.provider,model:request.model,text:"Still the same Trebell thread.",toolCalls:[],finishReason:"stop",usage:{inputTokens:6,outputTokens:4,totalTokens:10}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,nativeModelContextWindow:({provider,model})=>{contextLookups.push([provider,model]);return provider==="agentrouter"?128000:64000},version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const started=await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,approvalPolicy:"never",sandbox:"read-only",dynamicTools:[],developerInstructions:"Use repository intelligence when useful."});
    const threadId=started.thread.id;assert.equal(started.thread.runtime,"native");assert.equal(started.thread.providerMeta.modelProvider,"agentrouter");assert.equal(started.thread.providerSessionId.startsWith("native_"),true);
    const first=await rpc.request("turn/start",{threadId,model:"model-a",modelProvider:"agentrouter",approvalPolicy:"never",sandboxPolicy:{type:"readOnly"},input:[{type:"text",text:"Find SessionManager"}]});
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===first.turn.id);
    const firstTelemetry=await rpc.waitFor(message=>message.method==="thread/tokenUsage/updated"&&message.params?.turnId===first.turn.id);assert.equal(firstTelemetry.params.tokenUsage.modelContextWindow,128000);assert.equal(firstTelemetry.params.tokenUsage.last.inputTokens,12);assert.equal(firstTelemetry.params.tokenUsage.last.reasoningOutputTokens,3);
    const firstUsage=state.threadUsage(threadId);assert.equal(firstUsage.totalTokens,16);assert.equal(firstUsage.inputTokens,12);assert.equal(firstUsage.outputTokens,4);assert.equal(firstUsage.reasoningOutputTokens,3);
    const firstUsageRecord=state.usage({days:1,limit:20}).records.find(record=>record.turnId===first.turn.id);assert.equal(firstUsageRecord.provider,"agentrouter");
    const afterFirst=(await rpc.request("thread/read",{threadId})).thread;assert.equal(afterFirst.id,threadId);assert.equal(afterFirst.turns.length,1);
    const items=afterFirst.turns[0].items;assert.ok(items.some(item=>item.type==="dynamicToolCall"&&item.namespace==="trebell_repo"&&item.tool==="search_symbols"));assert.ok(items.some(item=>item.type==="agentMessage"&&/Found SessionManager/.test(item.text)));

    const second=await rpc.request("turn/start",{threadId,model:"model-b",modelProvider:"hcnsec",approvalPolicy:"never",sandboxPolicy:{type:"readOnly"},input:[{type:"text",text:"Continue on the same thread"}]});
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===second.turn.id);
    const secondTelemetry=await rpc.waitFor(message=>message.method==="thread/tokenUsage/updated"&&message.params?.turnId===second.turn.id);assert.equal(secondTelemetry.params.tokenUsage.modelContextWindow,64000);assert.equal(secondTelemetry.params.tokenUsage.last.inputTokens,6);
    const afterSecond=(await rpc.request("thread/read",{threadId})).thread;assert.equal(afterSecond.id,threadId);assert.equal(afterSecond.turns.length,2);assert.equal(afterSecond.model,"model-b");assert.equal(afterSecond.providerMeta.modelProvider,"hcnsec");
    assert.deepEqual(providers,["agentrouter","agentrouter","hcnsec"]);assert.deepEqual(contextLookups,[["agentrouter","model-a"],["hcnsec","model-b"]]);
  }finally{
    try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});

test("Trebell Native relay forwards an explicit reasoning effort and resets to provider default when the model changes",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-effort-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),seen=[];
  const nativeProviderTurn=async request=>{seen.push({provider:request.provider,model:request.model,reasoningEffort:request.reasoningEffort??null});return{id:"effort-"+seen.length,provider:request.provider,model:request.model,text:"done",toolCalls:[],finishReason:"stop",usage:{}}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"gpt-6-luna",modelProvider:"openai",cwd:repo,projectless:false,approvalPolicy:"never",sandbox:"read-only",dynamicTools:[]})).thread;
    const first=(await rpc.request("turn/start",{threadId:thread.id,model:"gpt-6-luna",modelProvider:"openai",reasoningEffort:"high",approvalPolicy:"never",sandboxPolicy:{type:"readOnly"},input:[{type:"text",text:"first"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===first.id);
    const second=(await rpc.request("turn/start",{threadId:thread.id,model:"model-b",modelProvider:"hcnsec",approvalPolicy:"never",sandboxPolicy:{type:"readOnly"},input:[{type:"text",text:"second"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===second.id);
    assert.deepEqual(seen,[{provider:"openai",model:"gpt-6-luna",reasoningEffort:"high"},{provider:"hcnsec",model:"model-b",reasoningEffort:null}]);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native relay persists a direct verifier-status turn with zero provider inference",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-direct-status-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await writeFile(join(repo,"verify.mjs"),'console.error("DIRECT_STATUS_EXPECTED strict but received legacy");\nprocess.exit(1);\n',"utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let providerCalls=0;
  const nativeProviderTurn=async()=>{providerCalls++;throw new Error("Direct verifier status turn must not call the inference provider.")};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"Run node verify.mjs and report the result."}]})).turn;
    const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(completed.params.turn.status,"completed",JSON.stringify(completed.params.turn.error||null));assert.equal(providerCalls,0);
    const persisted=threadStore.get(thread.id),saved=persisted.turns.find(item=>item.id===turn.id);assert.ok(saved);assert.equal(saved.modelTurns,0);assert.equal(saved.providerMessageId??null,null);
    const terminal=saved.items.find(item=>item.type==="dynamicToolCall"&&item.namespace==="trebell_terminal"&&item.tool==="run");assert.ok(terminal);assert.equal(terminal.arguments?.command,"node");assert.deepEqual(terminal.arguments?.args,["verify.mjs"]);assert.equal(terminal.status,"completed");
    const assistant=saved.items.find(item=>item.type==="agentMessage");assert.ok(assistant);assert.match(assistant.text,/failed \(exit code 1\)/i);assert.match(assistant.text,/DIRECT_STATUS_EXPECTED strict but received legacy/i);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native relay executes an explicit verifier status command in a workspace subdirectory with zero provider inference",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-direct-status-cwd-relay-")),home=join(root,"home"),repo=join(root,"repo"),api=join(repo,"packages","api");await mkdir(api,{recursive:true});
  await writeFile(join(api,"verify.mjs"),'console.log("DIRECT_CWD_PASS");\n',"utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let providerCalls=0;
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn:async()=>{providerCalls++;throw new Error("Explicit cwd status turn must not call the inference provider.")},version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"In ./packages/api/, run node verify.mjs and report the result."}]})).turn;
    const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(completed.params.turn.status,"completed");assert.equal(providerCalls,0);
    const saved=threadStore.get(thread.id).turns.find(item=>item.id===turn.id),terminal=saved.items.find(item=>item.type==="dynamicToolCall"&&item.namespace==="trebell_terminal"&&item.tool==="run");assert.ok(terminal);assert.deepEqual(terminal.arguments,{command:"node",args:["verify.mjs"],cwd:"packages/api"});
    const assistant=saved.items.find(item=>item.type==="agentMessage");assert.match(assistant?.text||"",/completed successfully/i);assert.match(assistant?.text||"",/DIRECT_CWD_PASS/);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native relay persists an exact replacement plus verifier turn with zero provider inference",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-direct-replace-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(join(repo,"src"),{recursive:true});
  await writeFile(join(repo,"src","config.mjs"),'export const mode="legacy";\n',"utf8");
  await writeFile(join(repo,"verify.mjs"),'import { mode } from "./src/config.mjs";\nif(mode!=="strict") process.exit(1);\nconsole.log("DIRECT_REPLACE_PASS");\n',"utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let providerCalls=0;
  const nativeProviderTurn=async()=>{providerCalls++;throw new Error("Direct exact replacement turn must not call the inference provider.")};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"full",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"full",input:[{type:"text",text:"Replace exactly legacy with strict in src/config.mjs, then run node verify.mjs and report the result."}]})).turn;
    const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(completed.params.turn.status,"completed",JSON.stringify(completed.params.turn.error||null));assert.equal(providerCalls,0);
    assert.equal(await readFile(join(repo,"src","config.mjs"),"utf8"),'export const mode="strict";\n');
    const persisted=threadStore.get(thread.id),saved=persisted.turns.find(item=>item.id===turn.id);assert.ok(saved);assert.equal(saved.modelTurns,0);assert.equal(saved.providerMessageId??null,null);
    const calls=saved.items.filter(item=>item.type==="dynamicToolCall");assert.deepEqual(calls.map(item=>item.namespace+"/"+item.tool),["trebell_workspace/replace_text","trebell_terminal/run"]);assert.equal(calls[0].arguments?.path,"src/config.mjs");assert.equal(calls[1].arguments?.command,"node");assert.deepEqual(calls[1].arguments?.args,["verify.mjs"]);
    const assistant=saved.items.find(item=>item.type==="agentMessage");assert.ok(assistant);assert.match(assistant.text,/Exact replacement completed in src\/config\.mjs/i);assert.match(assistant.text,/completed successfully \(exit code 0\)/i);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native relay persists an exact replacement-only turn with zero provider inference",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-direct-replace-only-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(join(repo,"src"),{recursive:true});
  await writeFile(join(repo,"src","config.mjs"),'export const mode="legacy";\n',"utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let providerCalls=0;
  const nativeProviderTurn=async()=>{providerCalls++;throw new Error("Direct exact replacement-only turn must not call the inference provider.")};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"full",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"full",input:[{type:"text",text:"Replace exactly legacy with strict in src/config.mjs and report the result."}]})).turn;
    const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(completed.params.turn.status,"completed",JSON.stringify(completed.params.turn.error||null));assert.equal(providerCalls,0);
    assert.equal(await readFile(join(repo,"src","config.mjs"),"utf8"),'export const mode="strict";\n');
    const saved=threadStore.get(thread.id).turns.find(item=>item.id===turn.id);assert.ok(saved);assert.equal(saved.modelTurns,0);assert.equal(saved.providerMessageId??null,null);
    const calls=saved.items.filter(item=>item.type==="dynamicToolCall");assert.deepEqual(calls.map(item=>item.namespace+"/"+item.tool),["trebell_workspace/replace_text"]);assert.equal(calls[0].arguments?.path,"src/config.mjs");
    const assistant=saved.items.find(item=>item.type==="agentMessage");assert.equal(assistant?.text,"Exact replacement completed in src/config.mjs.");
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native relay runs an exact replacement verifier from one explicit workspace cwd with zero provider inference",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-direct-replace-cwd-relay-")),home=join(root,"home"),repo=join(root,"repo"),api=join(repo,"packages","api");await mkdir(join(api,"src"),{recursive:true});
  await writeFile(join(api,"src","config.mjs"),'export const mode="legacy";\n',"utf8");
  await writeFile(join(api,"verify.mjs"),'import { mode } from "./src/config.mjs";\nif(mode!=="strict") process.exit(1);\nconsole.log("DIRECT_REPLACE_CWD_PASS");\n',"utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let providerCalls=0;
  const nativeProviderTurn=async()=>{providerCalls++;throw new Error("Direct exact replacement cwd turn must not call the inference provider.")};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"full",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"full",input:[{type:"text",text:"Replace exactly legacy with strict in packages/api/src/config.mjs, then run node verify.mjs in packages/api and report the result."}]})).turn;
    const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(completed.params.turn.status,"completed",JSON.stringify(completed.params.turn.error||null));assert.equal(providerCalls,0);
    assert.equal(await readFile(join(api,"src","config.mjs"),"utf8"),'export const mode="strict";\n');
    const saved=threadStore.get(thread.id).turns.find(item=>item.id===turn.id),calls=saved.items.filter(item=>item.type==="dynamicToolCall");assert.deepEqual(calls.map(item=>item.namespace+"/"+item.tool),["trebell_workspace/replace_text","trebell_terminal/run"]);
    assert.deepEqual(calls[1].arguments,{command:"node",args:["verify.mjs"],cwd:"packages/api"});const assistant=saved.items.find(item=>item.type==="agentMessage");assert.match(assistant?.text||"",/completed successfully/i);assert.match(assistant?.text||"",/DIRECT_REPLACE_CWD_PASS/);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native browser evidence RPC journals only sanitized bounded facts",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-browser-evidence-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),events=[],journal={record:event=>events.push(structuredClone(event)),recordProtocol:()=>{}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn:async()=>({id:"unused",provider:"agentrouter",model:"model-a",text:"",toolCalls:[],finishReason:"stop",usage:{}}),version:"test",journal});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const result=await rpc.request("thread/verification/evidence/record",{threadId:thread.id,turnId:"browser-turn",evidence:{namespace:"trebell_browser",tool:"screenshot",success:true,callId:"shot-1",screenshot:true,width:390,height:844,dataUrl:"TOP_SECRET_IMAGE",url:"https://private.invalid/?token=SECRET",unknown:"PRIVATE_FIELD"}});assert.equal(result.ok,true);
    const recorded=events.find(event=>event.name==="verification.browser_evidence"&&event.turnId==="browser-turn");assert.ok(recorded);assert.equal(recorded.status,"completed");assert.deepEqual(recorded.data,{namespace:"trebell_browser",tool:"screenshot",success:true,callId:"shot-1",screenshot:true,width:390,height:844});assert.doesNotMatch(JSON.stringify(recorded),/TOP_SECRET_IMAGE|private\.invalid|SECRET|PRIVATE_FIELD/);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native expands specialized tools on a later turn without replacing the thread",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-tool-expansion-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),events=[];let calls=0;
  const nativeProviderTurn=async request=>{
    calls++;const browser=(request.tools||[]).find(item=>item.name==="trebell_browser");
    if(calls===1){assert.equal(browser,undefined);return{id:"plain-done",provider:request.provider,model:request.model,text:"Parser inspection complete.",toolCalls:[],finishReason:"stop",usage:{}}}
    assert.ok(browser);assert.ok(browser.tools.some(tool=>tool.name==="screenshot"));assert.ok(request.messages.some(message=>message.role==="assistant"&&/Parser inspection complete/.test(String(message.content||""))));
    return{id:"browser-done",provider:request.provider,model:request.model,text:"Browser capability available on the same thread.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const journal={record:event=>events.push(event),recordProtocol:()=>{}},server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test",journal});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"read-only",dynamicTools:[]})).thread;
    threadStore.update(thread.id,{providerMeta:{...threadStore.get(thread.id).providerMeta,dynamicToolNamespaces:["trebell_device"]}});
    const first=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"read-only",input:[{type:"text",text:"Inspect the parser"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===first.id);
    assert.deepEqual(threadStore.get(thread.id).providerMeta.dynamicToolNamespaces,[],"retired mobile-device tool metadata should be scrubbed when an old Native thread resumes");
    const second=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"read-only",dynamicToolNamespaces:["trebell_browser"],input:[{type:"text",text:"Now verify it in the browser"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===second.id);
    const persisted=threadStore.get(thread.id);assert.equal(persisted.id,thread.id);assert.equal(persisted.turns.length,2);assert.deepEqual(persisted.providerMeta.dynamicToolNamespaces,["trebell_browser"]);assert.equal(calls,2);
    const repeated=await rpc.request("thread/tools/ensure",{threadId:thread.id,namespaces:["trebell_browser"]});assert.deepEqual(repeated.added,[]);assert.equal(repeated.thread.id,thread.id);
    assert.equal(events.filter(event=>event.name==="native.tools.expanded").length,1);assert.ok(events.some(event=>event.name==="native.tools.expanded"&&event.threadId===thread.id&&event.data?.added?.[0]==="trebell_browser"));
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native exposes Trebell semantic language intelligence directly to the model loop",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-language-relay-")),home=join(root,"home"),repo=join(root,"repo");
  await mkdir(join(repo,"src"),{recursive:true});await mkdir(join(repo,"node_modules","typescript","lib"),{recursive:true});
  await writeFile(join(repo,"src","typed.ts"),"export const typed: string = 'ok';\n","utf8");await writeFile(join(repo,"tsconfig.json"),"{}\n","utf8");
  await writeFile(join(repo,"node_modules","typescript","lib","typescript.js"),`const fs=require("fs"),path=require("path");let base=process.cwd();
const fileName=()=>path.join(base,"src","typed.ts"),file=()=>({fileName:fileName(),getPositionOfLineAndCharacter:(_line,column)=>column,getLineAndCharacterOfPosition:position=>({line:0,character:position})});
module.exports={version:"fixture-ts-native",sys:{fileExists:fs.existsSync,readFile:p=>fs.readFileSync(p,"utf8"),readDirectory:()=>[],directoryExists:fs.existsSync,getDirectories:()=>[],useCaseSensitiveFileNames:true,newLine:"\\n"},ScriptSnapshot:{fromString:text=>({text})},findConfigFile:root=>{base=root;return path.join(root,"tsconfig.json")},readConfigFile:()=>({config:{}}),parseJsonConfigFileContent:(_config,_sys,nextBase)=>{base=nextBase;return{fileNames:[fileName()],options:{},errors:[],projectReferences:[]}},getDefaultLibFilePath:()=>"",createDocumentRegistry:()=>({}),createLanguageService:()=>{const source=file(),program={getSourceFile:value=>path.resolve(value)===path.resolve(source.fileName)?source:undefined};return{getProgram:()=>program,getDefinitionAtPosition:()=>[{fileName:source.fileName,textSpan:{start:13,length:5},name:"typed",kind:"const",containerName:""}]}}};\n`,"utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0,stableManifest=null;
  const nativeProviderTurn=async request=>{
    calls++;const repoTools=(request.tools||[]).find(item=>item.name==="trebell_repo");assert.ok(repoTools);
    const manifest=JSON.stringify(request.tools||[]);if(stableManifest==null)stableManifest=manifest;else assert.equal(manifest,stableManifest,"repository discovery must not mutate the provider-visible tool manifest");
    if(calls===1){
      assert.ok(repoTools.tools.some(tool=>tool.name==="discover"));assert.ok(repoTools.tools.some(tool=>tool.name==="invoke"));assert.equal(repoTools.tools.some(tool=>tool.name==="language_symbol"),false);
      return{id:"language-discover",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"language-discovery-1",namespace:"trebell_repo",name:"discover",arguments:JSON.stringify({query:"semantic definition rename typescript code action",limit:6})}],finishReason:"tool_calls",usage:{}};
    }
    assert.equal(repoTools.tools.some(tool=>tool.name==="language_symbol"),false);assert.ok(repoTools.tools.some(tool=>tool.name==="invoke"));
    if(calls===2){
      const discoveryObservation=request.messages.at(-1);assert.equal(discoveryObservation.role,"tool");assert.match(String(discoveryObservation.content||""),/language_symbol/);assert.match(String(discoveryObservation.content||""),/inputSchema/);
      return{id:"language-call",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"language-1",namespace:"trebell_repo",name:"invoke",arguments:JSON.stringify({name:"language_symbol",arguments:{path:"src/typed.ts",line:1,column:14,operation:"definition"}})}],finishReason:"tool_calls",usage:{}};
    }
    const observation=request.messages.at(-1);assert.equal(observation.role,"tool");assert.match(observation.content,/\"supported\":true/);assert.match(observation.content,/\"semantic\":true/);assert.match(observation.content,/\"name\":\"typed\"/);
    return{id:"language-done",provider:request.provider,model:request.model,text:"Semantic definition resolved.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"read-only",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"read-only",input:[{type:"text",text:"Resolve the semantic definition of typed"}]})).turn;
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(calls,3);
    const persisted=threadStore.get(thread.id);assert.ok(persisted.turns[0].items.some(item=>item.type==="dynamicToolCall"&&item.namespace==="trebell_repo"&&item.tool==="discover"));assert.ok(persisted.turns[0].items.some(item=>item.type==="dynamicToolCall"&&item.namespace==="trebell_repo"&&item.tool==="invoke"&&item.arguments?.name==="language_symbol"));
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native progressively discovers configured MCP tools inside the same model turn",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-mcp-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({
    agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null,
    mcpServers:[{id:"relay-native",name:"Relay Native MCP",runtime:"native",enabled:true,type:"stdio",command:process.execPath,args:[nativeMcpFixture],env:[{name:"FIXTURE_VISIBLE",value:"relay"},{name:"API_KEY",value:"must-not-leak"}]}],
  });
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0,seenNamespace="mcp_relay-native",stableManifest=null;
  const nativeProviderTurn=async request=>{
    calls++;const discovery=(request.tools||[]).find(item=>item.name==="trebell_mcp"),namespace=(request.tools||[]).find(item=>item.name?.startsWith("mcp_"));assert.ok(discovery);assert.ok(discovery.tools.some(tool=>tool.name==="discover"));assert.ok(discovery.tools.some(tool=>tool.name==="call"));assert.equal(namespace,undefined);
    const manifest=JSON.stringify(request.tools||[]);if(stableManifest==null)stableManifest=manifest;else assert.equal(manifest,stableManifest,"MCP discovery must not mutate provider-visible tools");
    if(calls===1)return {id:"mcp-discover",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"mcp-discovery-1",namespace:"trebell_mcp",name:"discover",arguments:'{"query":"echo read"}'}],finishReason:"tool_calls",usage:{}};
    if(calls===2){const discoveryObservation=request.messages.at(-1);assert.equal(discoveryObservation.role,"tool");const text=JSON.stringify(discoveryObservation.content);assert.match(text,/echo-read/);assert.match(text,/inputSchema/);assert.match(text,/mcp_relay-native/);return {id:"mcp-call",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"mcp-1",namespace:"trebell_mcp",name:"call",arguments:JSON.stringify({namespace:seenNamespace,name:"echo-read",arguments:{text:"from-model"}})}],finishReason:"tool_calls",usage:{}}}
    const observation=request.messages.at(-1);assert.equal(observation.role,"tool");assert.match(JSON.stringify(observation.content),/echo:from-model:env=relay:secret=\[redacted\]/);
    return {id:"mcp-done",provider:request.provider,model:request.model,text:"MCP completed.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"read-only",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"read-only",input:[{type:"text",text:"Use the configured MCP echo tool"}]})).turn;
    const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(completed.params.turn.status,"completed",JSON.stringify(completed.params.turn.error||null));assert.equal(calls,3);
    const persisted=(await rpc.request("thread/read",{threadId:thread.id})).thread;assert.deepEqual(persisted.providerMeta.nativeMcp.failures,[]);assert.deepEqual(persisted.providerMeta.nativeMcp.namespaces,[seenNamespace]);assert.ok(persisted.turns[0].items.some(item=>item.type==="dynamicToolCall"&&item.namespace==="trebell_mcp"&&item.tool==="call"&&item.arguments?.name==="echo-read"&&item.success===true));
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Trebell Native reloads changed MCP settings on the next turn of the same thread",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-mcp-reload-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const serverConfig=value=>[{id:"reload-native",name:"Reload Native MCP",runtime:"native",enabled:true,type:"stdio",command:process.execPath,args:[nativeMcpFixture],env:[{name:"FIXTURE_VISIBLE",value}]}];
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null,mcpServers:serverConfig("before")});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let call=0,namespaceName="mcp_reload-native";
  const nativeProviderTurn=async request=>{
    call++;const discovery=(request.tools||[]).find(item=>item.name==="trebell_mcp"),namespace=(request.tools||[]).find(item=>item.name?.startsWith("mcp_"));assert.ok(discovery);assert.equal(namespace,undefined);
    if(call===1||call===4)return{id:`reload-discover-${call}`,provider:request.provider,model:request.model,text:"",toolCalls:[{id:`reload-discover-tool-${call}`,namespace:"trebell_mcp",name:"discover",arguments:JSON.stringify({query:"echo read"})}],finishReason:"tool_calls",usage:{}};
    if(call===2||call===5)return{id:`reload-call-${call}`,provider:request.provider,model:request.model,text:"",toolCalls:[{id:`reload-tool-${call}`,namespace:"trebell_mcp",name:"call",arguments:JSON.stringify({namespace:namespaceName,name:"echo-read",arguments:{text:call===2?"first":"second"}})}],finishReason:"tool_calls",usage:{}};
    const observation=String(request.messages.at(-1)?.content||"");
    if(call===3){assert.match(observation,/echo:first:env=before/);return{id:"reload-done-before",provider:request.provider,model:request.model,text:"First MCP config used.",toolCalls:[],finishReason:"stop",usage:{}}}
    assert.equal(call,6);assert.match(observation,/echo:second:env=after/);return{id:"reload-done-after",provider:request.provider,model:request.model,text:"Reloaded MCP config used.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const events=[],journal={record:event=>events.push(event),recordProtocol:()=>{}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test",journal});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"read-only",dynamicTools:[]})).thread;
    const first=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"read-only",input:[{type:"text",text:"Use MCP before reload"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===first.id);
    state.updateSettings({mcpServers:serverConfig("after")});
    const second=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"read-only",input:[{type:"text",text:"Use MCP after reload"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===second.id);
    assert.equal(call,6);assert.ok(events.some(event=>event.name==="native.mcp.reloaded"&&event.threadId===thread.id));const persisted=threadStore.get(thread.id);assert.equal(persisted.id,thread.id);assert.deepEqual(persisted.providerMeta.nativeMcp.namespaces,[namespaceName]);assert.equal(persisted.turns.length,2);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native enforces the remaining goal tool budget inside an active turn",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-budget-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let seenMaxOutputTokens=null;
  const nativeProviderTurn=async request=>{
    seenMaxOutputTokens=request.maxOutputTokens;
    return {id:"budget-tools",provider:request.provider,model:request.model,text:"",toolCalls:[
      {id:"write-one",namespace:"trebell_workspace",name:"write_file",arguments:JSON.stringify({path:"one.txt",content:"one"})},
      {id:"write-two",namespace:"trebell_workspace",name:"write_file",arguments:JSON.stringify({path:"two.txt",content:"two"})},
    ],finishReason:"tool_calls",usage:{inputTokens:5,outputTokens:2,totalTokens:7}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    await rpc.request("thread/goal/set",{threadId:thread.id,objective:"Make one bounded edit",toolCallBudget:1,tokenBudget:50});
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"Create the bounded file"}]})).turn;
    const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(completed.params.turn.status,"failed");assert.match(completed.params.turn.error?.message||"",/tool-call budget exhausted/i);
    assert.equal(await (await import("node:fs/promises")).readFile(join(repo,"one.txt"),"utf8"),"one");
    await assert.rejects((await import("node:fs/promises")).readFile(join(repo,"two.txt"),"utf8"),error=>error?.code==="ENOENT");
    assert.equal(seenMaxOutputTokens,50);
    const goal=(await rpc.request("thread/goal/get",{threadId:thread.id})).goal;assert.equal(goal.toolCallsUsed,1);assert.equal(goal.toolCallBudgetRemaining,0);assert.equal(goal.tokensUsed,7);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Trebell Native applies permission-profile changes to an already cached session",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-permission-refresh-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let call=0;
  const nativeProviderTurn=async request=>{
    call++;
    if(call===1)return{id:"permission-write-1",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"permission-tool-1",namespace:"trebell_workspace",name:"write_file",arguments:JSON.stringify({path:"allowed.txt",content:"allowed"})}],finishReason:"tool_calls",usage:{}};
    if(call===2){assert.match(request.messages.at(-1).content,/\"written\":true/);return{id:"permission-done-1",provider:request.provider,model:request.model,text:"First write completed.",toolCalls:[],finishReason:"stop",usage:{}}}
    if(call===3)return{id:"permission-write-2",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"permission-tool-2",namespace:"trebell_workspace",name:"write_file",arguments:JSON.stringify({path:"blocked.txt",content:"blocked"})}],finishReason:"tool_calls",usage:{}};
    assert.equal(call,4);assert.match(request.messages.at(-1).content,/read-only|rejected|blocked|not permitted/i);return{id:"permission-done-2",provider:request.provider,model:request.model,text:"Read-only mode blocked the write.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const first=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"Write the allowed file"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===first.id);
    assert.equal(await (await import("node:fs/promises")).readFile(join(repo,"allowed.txt"),"utf8"),"allowed");
    const second=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"read-only",input:[{type:"text",text:"Try the blocked write"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===second.id);
    await assert.rejects((await import("node:fs/promises")).readFile(join(repo,"blocked.txt"),"utf8"),error=>error?.code==="ENOENT");
    const persisted=threadStore.get(thread.id);assert.equal(persisted.providerMeta.permissionProfile,"read-only");const blocked=persisted.turns[1].items.find(item=>item.type==="dynamicToolCall"&&item.tool==="write_file");assert.equal(blocked.success,false);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native relay can edit workspace files and run bounded terminal commands through the same agent loop",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-coding-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await writeFile(join(repo,"app.js"),"export const answer = 1;\n","utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let step=0;
  const nativeProviderTurn=async request=>{
    step++;
    if(step===4){
      assert.equal(request.toolChoice,"none");assert.deepEqual(request.tools,[]);
      assert.ok(request.messages.some(message=>message.role==="developer"&&/semantic completion gate/i.test(String(message.content||""))));
      return {id:"coding-gate",provider:request.provider,model:request.model,text:'{"status":"complete","unresolved":[],"reason":"The requested edit is present and the terminal verification observed 42."}',toolCalls:[],finishReason:"stop",usage:{}};
    }
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
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Trebell Native verification repair reuses the same thread and persisted failed evidence",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-repair-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);const providerRequests=[];
  const nativeProviderTurn=async request=>{
    providerRequests.push(structuredClone({...request,signal:undefined}));
    if(request.metadata?.completionGate)return {id:"repair-gate",provider:request.provider,model:request.model,text:'{"status":"complete","unresolved":[],"reason":"The requested repair response is supported by the verification context."}',toolCalls:[],finishReason:"stop",usage:{}};
    return {id:"repair-answer",provider:request.provider,model:request.model,text:"Repaired and rechecked.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const plan={risk:"medium",steps:[{id:"tests",kind:"tests",scope:"affected",required:true,cost:"low",reason:"Changed code has related tests."}]};
    state.recordVerification({id:"native-repair-record",threadId:thread.id,projectPath:repo,plan,evidence:[{stepId:"tests",exitCode:1,status:"failed",reason:"Parser regression failed",stdout:"SHOULD_NOT_BE_IN_REPAIR_CONTEXT"}]});
    const current=await rpc.request("thread/verification/get",{threadId:thread.id});assert.equal(current.record.id,"native-repair-record");assert.equal(current.nextAction.action,"repair");
    const repaired=await rpc.request("thread/verification/repair",{threadId:thread.id});assert.equal(repaired.record.id,"native-repair-record");assert.equal(repaired.nextAction.action,"repair");assert.ok(repaired.turn?.id);
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===repaired.turn.id);
    assert.equal(providerRequests.length,2);const prompt=JSON.stringify(providerRequests[0].messages.at(-1)?.content||"");assert.match(prompt,/Repair the failed verification/i);assert.match(prompt,/Parser regression failed/);assert.doesNotMatch(prompt,/SHOULD_NOT_BE_IN_REPAIR_CONTEXT/);assert.equal(providerRequests[1].metadata?.completionGate,true);
    const persisted=(await rpc.request("thread/read",{threadId:thread.id})).thread;assert.equal(persisted.id,thread.id);assert.equal(persisted.turns.length,1);assert.ok(persisted.turns[0].items.some(item=>item.type==="agentMessage"&&/Repaired and rechecked/.test(item.text)));
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("a verification repair's checkpoint is journaled under the selected runtime when the thread names none",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-relay-runtime-fallback-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),store=new AgentThreadStore(env),records=[];
  // The thread's metadata as a store that kept no runtime would give it.
  const threadStore=new Proxy(store,{get(target,key){if(key==="getMetadata")return id=>{const thread=target.getMetadata(id);if(thread)delete thread.runtime;return thread};const value=target[key];return typeof value==="function"?value.bind(target):value}});
  const checkpoints={create:async({cwd,label})=>({id:"checkpoint-1",root:cwd,label}),link:(id,{turnId})=>({id,turnId})};
  const nativeProviderTurn=async request=>request.metadata?.completionGate
    ?{id:"gate",provider:request.provider,model:request.model,text:'{"status":"complete","unresolved":[],"reason":"Supported."}',toolCalls:[],finishReason:"stop",usage:{}}
    :{id:"answer",provider:request.provider,model:request.model,text:"Repaired.",toolCalls:[],finishReason:"stop",usage:{}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,journal:{record:event=>records.push(event)},checkpoints,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const plan={risk:"medium",steps:[{id:"tests",kind:"tests",scope:"affected",required:true,cost:"low",reason:"Changed code has related tests."}]};
    state.recordVerification({id:"fallback-record",threadId:thread.id,projectPath:repo,plan,evidence:[{stepId:"tests",exitCode:1,status:"failed",reason:"Parser regression failed"}]});
    const repaired=await rpc.request("thread/verification/repair",{threadId:thread.id});assert.ok(repaired.turn?.id);
    const created=records.find(event=>event.name==="checkpoint.created"),linked=records.find(event=>event.name==="checkpoint.linked");
    assert.equal(created?.runtime,"native");assert.equal(linked?.runtime,"native");assert.equal(linked?.turnId,repaired.turn.id);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Trebell Native verification continuation reuses the same thread and only the next missing check",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-verify-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);const providerRequests=[];
  const nativeProviderTurn=async request=>{
    providerRequests.push(structuredClone({...request,signal:undefined}));
    if(request.metadata?.completionGate)return {id:"verify-gate",provider:request.provider,model:request.model,text:'{"status":"complete","unresolved":[],"reason":"The requested verification continuation was completed."}',toolCalls:[],finishReason:"stop",usage:{}};
    return {id:"verify-answer",provider:request.provider,model:request.model,text:"Ran the requested test only.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const plan={risk:"medium",steps:[{id:"diagnostics",kind:"diagnostics",scope:"changed",required:true,cost:"low",reason:"Check syntax"},{id:"tests",kind:"tests",scope:"affected",required:true,cost:"medium",command:"npm test",reason:"Run tests"}]};
    state.recordVerification({id:"native-verify-record",threadId:thread.id,turnId:"user-turn",projectPath:repo,plan,evidence:[{stepId:"diagnostics",status:"passed",rawOutput:"SHOULD_NOT_BE_IN_VERIFY_CONTEXT"}]});
    const current=await rpc.request("thread/verification/get",{threadId:thread.id});assert.equal(current.record.id,"native-verify-record");assert.equal(current.nextAction.action,"verify");assert.equal(current.nextAction.nextStep.id,"tests");
    const continued=await rpc.request("thread/verification/continue",{threadId:thread.id,recordId:"native-verify-record",auto:true});assert.equal(continued.record.id,"native-verify-record");assert.equal(continued.nextAction.nextStep.id,"tests");assert.ok(continued.turn?.id);
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===continued.turn.id);
    assert.equal(providerRequests.length,2);const prompt=JSON.stringify(providerRequests[0].messages.at(-1)?.content||"");assert.match(prompt,/Continue verification/i);assert.match(prompt,/npm test/);assert.match(prompt,/single next required verification step/i);assert.doesNotMatch(prompt,/SHOULD_NOT_BE_IN_VERIFY_CONTEXT/);assert.equal(providerRequests[1].metadata?.completionGate,true);
    const meta=state.threadMeta(thread.id);assert.equal(meta.verificationContinuationChain?.lastContinuationTurnId,continued.turn.id);assert.equal(meta.verificationAutomationChain?.lastAutomaticTurnId,continued.turn.id);assert.equal(meta.verificationAutomationChain?.lastAction,"verify");
    const persisted=(await rpc.request("thread/read",{threadId:thread.id})).thread;assert.equal(persisted.id,thread.id);assert.equal(persisted.turns.length,1);assert.ok(persisted.turns[0].items.some(item=>item.type==="agentMessage"&&/requested test only/.test(item.text)));
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Trebell Native compaction keeps full transcript but restarts from the durable brief boundary",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-compact-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let phase="initial",requests=[];
  const nativeProviderTurn=async request=>{
    requests.push(structuredClone({...request,signal:undefined}));
    if(phase==="initial")return {id:"initial-answer",provider:request.provider,model:request.model,text:"OLD ANSWER: parser lives in src/parser.js",toolCalls:[],finishReason:"stop",usage:{inputTokens:10,outputTokens:4,totalTokens:14}};
    if(phase==="compact")return {id:"compact-summary",provider:request.provider,model:request.model,text:"Goal: keep the parser fix. Important file: src/parser.js. Next: verify parser tests.",toolCalls:[],finishReason:"stop",usage:{inputTokens:20,outputTokens:8,totalTokens:28}};
    assert.equal(request.messages.some(message=>String(message.content||"").includes("OLD REQUEST: locate parser")),false);
    assert.equal(request.messages.some(message=>String(message.content||"").includes("OLD ANSWER: parser lives")),false);
    assert.ok(request.messages.some(message=>message.trebellCompaction&&String(message.content||"").includes("src/parser.js")));
    assert.match(JSON.stringify(request.messages.at(-1).content),/POST COMPACT REQUEST/);
    return {id:"post-compact-answer",provider:request.provider,model:request.model,text:"continued from compacted memory",toolCalls:[],finishReason:"stop",usage:{inputTokens:5,outputTokens:3,totalTokens:8}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});let relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});let rpc=client(ws);
  let threadId;
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;threadId=thread.id;
    const first=(await rpc.request("turn/start",{threadId,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"OLD REQUEST: locate parser"}]})).turn;
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===first.id);
    phase="compact";const compacted=await rpc.request("thread/compact/start",{threadId,maxOutputTokens:1024});assert.equal(compacted.ok,true);assert.equal(compacted.compaction.throughTurnId,first.id);assert.match(compacted.compaction.summary,/src\/parser\.js/);
    const persisted=(await rpc.request("thread/read",{threadId})).thread;assert.equal(persisted.turns.length,1);assert.ok(persisted.turns[0].items.some(item=>item.type==="userMessage"&&JSON.stringify(item.content).includes("OLD REQUEST")));assert.equal(persisted.providerMeta.nativeCompaction.throughTurnId,first.id);
    assert.equal(state.threadUsage(threadId).totalTokens,42);const compactUsage=state.usage({days:1,limit:20}).records.find(record=>String(record.turnId||"").startsWith("compaction:"));assert.equal(compactUsage.provider,"agentrouter");

    ws.close();await relay.close();await new Promise(resolve=>server.close(()=>resolve()));
    const restartedServer=createServer((_req,res)=>{res.writeHead(404);res.end()});phase="restart";requests=[];relay=attachAgentRelay(restartedServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
    const restartedPort=await listen(restartedServer),ws2=new WebSocket(`ws://127.0.0.1:${restartedPort}/api/agent/ws`);await new Promise((resolve,reject)=>{ws2.once("open",resolve);ws2.once("error",reject)});rpc=client(ws2);
    const second=(await rpc.request("turn/start",{threadId,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"POST COMPACT REQUEST"}]})).turn;
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===second.id);ws2.close();await relay.close();await new Promise(resolve=>restartedServer.close(()=>resolve()));relay=null;
    const finalThread=threadStore.get(threadId);assert.equal(finalThread.turns.length,2);assert.ok(finalThread.turns[1].items.some(item=>item.type==="agentMessage"&&/continued from compacted memory/.test(item.text)));
  }finally{
    try{ws.close()}catch{}if(relay)await relay.close().catch(()=>{});if(server.listening)await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});

test("Trebell Native compaction keeps the last two turns hot across restart",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-hot-compact-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let phase="turns",turnNumber=0,compactionRequest=null,restartRequest=null;
  const nativeProviderTurn=async request=>{
    if(phase==="turns"){turnNumber++;return{id:"answer-"+turnNumber,provider:request.provider,model:request.model,text:"ANSWER_"+turnNumber,toolCalls:[],finishReason:"stop",usage:{inputTokens:4,outputTokens:2,totalTokens:6}}}
    if(phase==="compact"){compactionRequest=structuredClone({...request,signal:undefined});return{id:"compact-hot",provider:request.provider,model:request.model,text:"Summary of the oldest turn only.",toolCalls:[],finishReason:"stop",usage:{inputTokens:9,outputTokens:4,totalTokens:13}}}
    restartRequest=structuredClone({...request,signal:undefined});return{id:"after-restart",provider:request.provider,model:request.model,text:"resumed",toolCalls:[],finishReason:"stop",usage:{inputTokens:5,outputTokens:2,totalTokens:7}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});let relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});let rpc=client(ws),threadId=null,turnIds=[];
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;threadId=thread.id;
    await rpc.request("thread/goal/set",{threadId,objective:"PRESERVE THIS EXACT ACTIVE GOAL"});
    for(let index=1;index<=3;index++){const turn=(await rpc.request("turn/start",{threadId,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"REQUEST_"+index}]})).turn;turnIds.push(turn.id);await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id)}
    phase="compact";const compacted=await rpc.request("thread/compact/start",{threadId,maxOutputTokens:1024});
    assert.equal(compacted.compaction.throughTurnId,turnIds[0]);assert.deepEqual(compacted.compaction.retainedTurnIds,turnIds.slice(1));assert.match(compacted.compaction.summary,/PRESERVE THIS EXACT ACTIVE GOAL/);
    assert.match(JSON.stringify(compactionRequest.messages),/REQUEST_1/);assert.doesNotMatch(JSON.stringify(compactionRequest.messages),/REQUEST_2|REQUEST_3/);
    ws.close();await relay.close();await new Promise(resolve=>server.close(()=>resolve()));

    const restarted=createServer((_req,res)=>{res.writeHead(404);res.end()});phase="restart";relay=attachAgentRelay(restarted,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
    const restartedPort=await listen(restarted),ws2=new WebSocket(`ws://127.0.0.1:${restartedPort}/api/agent/ws`);await new Promise((resolve,reject)=>{ws2.once("open",resolve);ws2.once("error",reject)});rpc=client(ws2);
    const next=(await rpc.request("turn/start",{threadId,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"REQUEST_4"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===next.id);
    const serialized=JSON.stringify(restartRequest.messages);assert.doesNotMatch(serialized,/REQUEST_1/);assert.match(serialized,/PRESERVE THIS EXACT ACTIVE GOAL/);assert.match(serialized,/REQUEST_2/);assert.match(serialized,/ANSWER_2/);assert.match(serialized,/REQUEST_3/);assert.match(serialized,/ANSWER_3/);assert.match(serialized,/REQUEST_4/);
    ws2.close();await relay.close();await new Promise(resolve=>restarted.close(()=>resolve()));relay=null;
  }finally{try{ws.close()}catch{}if(relay)await relay.close().catch(()=>{});if(server.listening)await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Trebell Native turn steering interrupts inference and persists the redirect inside the active turn",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-steer-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0,firstStartedResolve;const firstStarted=new Promise(resolve=>{firstStartedResolve=resolve});
  const nativeProviderTurn=async request=>{
    calls++;
    if(calls===1){firstStartedResolve();await new Promise((resolve,reject)=>{request.signal.addEventListener("abort",()=>{const error=new Error("provider request aborted by steering");error.name="AbortError";reject(error)},{once:true})});return{text:"obsolete",toolCalls:[],usage:{}}}
    assert.match(JSON.stringify(request.messages.at(-1).content),/Work on parser\.ts instead/);return{id:"steered-answer",provider:request.provider,model:request.model,text:"Now working on parser.ts.",toolCalls:[],finishReason:"stop",usage:{inputTokens:6,outputTokens:3,totalTokens:9}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"Work on auth.ts"}]})).turn;await firstStarted;
    await assert.rejects(()=>rpc.request("thread/fork",{threadId:thread.id,excludeTurns:true}),/Stop the running Native turn before forking/i);
    await assert.rejects(()=>rpc.request("thread/revert",{threadId:thread.id,beforeTurnId:turn.id}),/Stop the running Native turn before rewinding/i);
    const steered=await rpc.request("turn/steer",{threadId:thread.id,expectedTurnId:turn.id,input:[{type:"text",text:"Work on parser.ts instead"}]});assert.equal(steered.turnId,turn.id);assert.equal(steered.accepted,true);
    const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(completed.params.turn.status,"completed");assert.equal(calls,2);
    const persisted=(await rpc.request("thread/read",{threadId:thread.id})).thread.turns[0];const userItems=persisted.items.filter(item=>item.type==="userMessage");assert.equal(userItems.length,2);assert.match(JSON.stringify(userItems[1].content),/Work on parser\.ts instead/);assert.ok(persisted.items.some(item=>item.type==="agentMessage"&&/parser\.ts/.test(item.text)));
    await assert.rejects(()=>rpc.request("turn/steer",{threadId:thread.id,expectedTurnId:turn.id,input:[{type:"text",text:"too late"}]}),/no active turn/i);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// A message sent with files keeps them in its stored message, after its text, as Codex keeps a message's input, and so does a steer:
// a thread opened again names the files that went with each (ui/src/thread-history.js). A skill picked is no file the person sent.
test("Trebell Native keeps the files a message or a steer was sent with in its stored message, after its text",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-files-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const shot=join(repo,"screenshot.png"),log=join(repo,"pasted-context.txt"),notes=join(repo,"notes.txt");
  await writeFile(shot,Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==","base64"));await writeFile(log,"GET /login 500 after the token refresh\n","utf8");await writeFile(notes,"Look at the parser.\n","utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0,firstStartedResolve;const firstStarted=new Promise(resolve=>{firstStartedResolve=resolve});
  const nativeProviderTurn=async request=>{
    calls++;
    if(calls===1){firstStartedResolve();await new Promise((resolve,reject)=>{request.signal.addEventListener("abort",()=>reject(Object.assign(new Error("provider request aborted by steering"),{name:"AbortError"})),{once:true})});return{text:"obsolete",toolCalls:[],usage:{}}}
    return{id:"files-answer",provider:request.provider,model:request.model,text:"I see the screenshot, the log and the notes.",toolCalls:[],finishReason:"stop",usage:{inputTokens:6,outputTokens:3,totalTokens:9}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"Here is what I see"},{type:"localImage",path:shot},{type:"mention",name:"pasted-context.txt",path:log},{type:"skill",name:"review",path:join(repo,"skills","review")}]})).turn;await firstStarted;
    await rpc.request("turn/steer",{threadId:thread.id,expectedTurnId:turn.id,input:[{type:"text",text:"Look at my notes too"},{type:"mention",name:"notes.txt",path:notes}]});
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);
    const stored=(await rpc.request("thread/read",{threadId:thread.id})).thread.turns[0].items.filter(item=>item.type==="userMessage").map(item=>item.content);
    assert.deepEqual(stored,[
      [{type:"text",text:"Here is what I see"},{type:"localImage",path:shot},{type:"mention",name:"pasted-context.txt",path:log}],
      [{type:"text",text:"Look at my notes too"},{type:"mention",name:"notes.txt",path:notes}],
    ]);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Trebell Native delegation preserves parent inference provider, tools, permissions and child budget",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-delegate-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),requests=[];
  const nativeProviderTurn=async request=>{requests.push(structuredClone({...request,signal:undefined}));return{id:"child-answer",provider:request.provider,model:request.model,text:"Delegated parser inspection complete.",toolCalls:[],finishReason:"stop",usage:{inputTokens:5,outputTokens:3,totalTokens:8}}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const parent=(await rpc.request("thread/start",{model:"model-child",modelProvider:"hcnsec",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[{type:"namespace",name:"trebell_browser"},{type:"namespace",name:"trebell_delegate"}]})).thread;
    await rpc.request("thread/goal/set",{threadId:parent.id,objective:"Finish parser work",childAgentBudget:1});
    const delegated=await rpc.request("thread/delegate",{threadId:parent.id,task:"Inspect parser behavior and report findings",permissions:"read-only",isolation:"inherit",budget:{turnBudget:2},label:"Parser inspector"});
    assert.equal(delegated.parentThreadId,parent.id);assert.ok(delegated.thread?.id);assert.ok(delegated.turn?.id);
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.threadId===delegated.thread.id&&message.params?.turn?.id===delegated.turn.id);
    const child=(await rpc.request("thread/read",{threadId:delegated.thread.id})).thread;assert.equal(child.parentThreadId,parent.id);assert.equal(child.providerMeta.modelProvider,"hcnsec");assert.equal(child.providerMeta.permissionProfile,"read-only");assert.deepEqual(child.providerMeta.dynamicToolNamespaces,["trebell_browser"]);assert.equal(child.model,"model-child");
    assert.equal(requests.length,1);assert.equal(requests[0].provider,"hcnsec");assert.ok((requests[0].tools||[]).some(tool=>tool.name==="trebell_browser"));assert.match(JSON.stringify(requests[0].messages.at(-1).content),/Inspect parser behavior and report findings/);
    const parentGoal=(await rpc.request("thread/goal/get",{threadId:parent.id})).goal;assert.equal(parentGoal.childAgentsUsed,1);assert.equal(parentGoal.childAgentBudgetRemaining,0);
    const childGoal=(await rpc.request("thread/goal/get",{threadId:child.id})).goal;assert.equal(childGoal.objective,"Inspect parser behavior and report findings");assert.equal(childGoal.turnBudget,2);
    await assert.rejects(()=>rpc.request("thread/delegate",{threadId:parent.id,task:"Second child must be blocked",permissions:"read-only",isolation:"inherit"}),/child-agent budget exhausted/i);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Trebell Native fork clones Trebell history and rewind invalidates crossed compaction memory",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-fork-rewind-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let phase="turn1";
  const nativeProviderTurn=async request=>{
    if(phase==="turn1")return{id:"first-answer",provider:request.provider,model:request.model,text:"FIRST ANSWER",toolCalls:[],finishReason:"stop",usage:{}};
    if(phase==="compact")return{id:"compact-answer",provider:request.provider,model:request.model,text:"Keep parser decision from turn one.",toolCalls:[],finishReason:"stop",usage:{}};
    if(phase==="turn2"){
      assert.ok(request.messages.some(message=>message.trebellCompaction&&String(message.content||"").includes("parser decision")));assert.equal(request.messages.some(message=>String(message.content||"").includes("FIRST REQUEST")),false);
      return{id:"second-answer",provider:request.provider,model:request.model,text:"SECOND ANSWER",toolCalls:[],finishReason:"stop",usage:{}};
    }
    if(phase==="after-retained-rewind"){
      assert.ok(request.messages.some(message=>message.trebellCompaction&&String(message.content||"").includes("parser decision")));assert.equal(request.messages.some(message=>String(message.content||"").includes("SECOND REQUEST")),false);
      return{id:"retained-answer",provider:request.provider,model:request.model,text:"RETAINED ANSWER",toolCalls:[],finishReason:"stop",usage:{}};
    }
    assert.equal(phase,"after-empty-rewind");assert.equal(request.messages.some(message=>message.trebellCompaction),false);assert.equal(request.messages.some(message=>/FIRST REQUEST|SECOND REQUEST|AFTER RETAINED/.test(String(message.content||""))),false);
    return{id:"empty-answer",provider:request.provider,model:request.model,text:"EMPTY ANSWER",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const source=(await rpc.request("thread/start",{model:"model-a",modelProvider:"hcnsec",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[{type:"namespace",name:"trebell_browser"}]})).thread;
    const first=(await rpc.request("turn/start",{threadId:source.id,model:"model-a",modelProvider:"hcnsec",permissionProfile:"auto",input:[{type:"text",text:"FIRST REQUEST"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===first.id);
    phase="compact";await rpc.request("thread/compact/start",{threadId:source.id});
    phase="turn2";const second=(await rpc.request("turn/start",{threadId:source.id,model:"model-a",modelProvider:"hcnsec",permissionProfile:"auto",input:[{type:"text",text:"SECOND REQUEST"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===second.id);

    const forkedResponse=await rpc.request("thread/fork",{threadId:source.id,excludeTurns:true});assert.notEqual(forkedResponse.thread.id,source.id);assert.equal(forkedResponse.thread.turns.length,0);assert.notEqual(forkedResponse.thread.providerSessionId,source.providerSessionId);
    const forked=threadStore.get(forkedResponse.thread.id);assert.equal(forked.forkedFromId,source.id);assert.equal(forked.turns.length,2);assert.equal(forked.providerMeta.modelProvider,"hcnsec");assert.deepEqual(forked.providerMeta.dynamicToolNamespaces,["trebell_browser"]);assert.equal(forked.providerMeta.nativeCompaction.throughTurnId,first.id);assert.equal(forked.providerMeta.nativeFork.sourceThreadId,source.id);

    const retained=(await rpc.request("thread/revert",{threadId:source.id,beforeTurnId:second.id})).thread;assert.equal(retained.turns.length,1);assert.equal(retained.turns[0].id,first.id);assert.equal(retained.providerMeta.nativeCompaction.throughTurnId,first.id);
    phase="after-retained-rewind";const retainedTurn=(await rpc.request("turn/start",{threadId:source.id,model:"model-a",modelProvider:"hcnsec",permissionProfile:"auto",input:[{type:"text",text:"AFTER RETAINED"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===retainedTurn.id);
    const emptied=(await rpc.request("thread/revert",{threadId:source.id,beforeTurnId:first.id})).thread;assert.equal(emptied.turns.length,0);assert.equal(Object.prototype.hasOwnProperty.call(emptied.providerMeta||{},"nativeCompaction"),false);
    phase="after-empty-rewind";const emptyTurn=(await rpc.request("turn/start",{threadId:source.id,model:"model-a",modelProvider:"hcnsec",permissionProfile:"auto",input:[{type:"text",text:"AFTER EMPTY"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===emptyTurn.id);
    const forkStillIntact=threadStore.get(forked.id);assert.equal(forkStillIntact.turns.length,2);assert.equal(forkStillIntact.providerMeta.nativeCompaction.throughTurnId,first.id);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Trebell Native durable queue edits, reorders and auto-starts after a successful turn",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-queue-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),prompts=[];let firstStartedResolve,releaseFirstResolve;const firstStarted=new Promise(resolve=>{firstStartedResolve=resolve}),releaseFirst=new Promise(resolve=>{releaseFirstResolve=resolve});
  const nativeProviderTurn=async request=>{
    const visible=JSON.stringify(request.messages.at(-1)?.content||"");prompts.push(visible);
    if(prompts.length===1){firstStartedResolve();await releaseFirst;return{id:"initial-done",provider:request.provider,model:request.model,text:"Initial done",toolCalls:[],finishReason:"stop",usage:{}}}
    if(/SECOND QUEUED/.test(visible))assert.ok((request.tools||[]).some(item=>item.name==="trebell_browser"));
    return{id:"queued-done-"+prompts.length,provider:request.provider,model:request.model,text:"Queued done",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:true,permissionProfile:"auto",dynamicTools:[]})).thread;
    const initial=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"INITIAL TURN"}]})).turn;await firstStarted;
    const q1=(await rpc.request("thread/queue/add",{threadId:thread.id,input:[{type:"text",text:"FIRST QUEUED"}],clientUserMessageId:"client-q1"})).queuedSubmission;
    const q2=(await rpc.request("thread/queue/add",{threadId:thread.id,input:[{type:"text",text:"SECOND QUEUED"}],clientUserMessageId:"client-q2",dynamicToolNamespaces:["trebell_browser"]})).queuedSubmission;
    await rpc.request("thread/queue/update",{threadId:thread.id,queuedSubmissionId:q1.id,input:[{type:"text",text:"FIRST QUEUED EDITED"}]});
    await rpc.request("thread/queue/reorder",{threadId:thread.id,queuedSubmissionIds:[q2.id,q1.id]});
    let queued=(await rpc.request("thread/queue/list",{threadId:thread.id,limit:10})).data;assert.deepEqual(queued.map(item=>item.id),[q2.id,q1.id]);assert.deepEqual(queued[0].dynamicToolNamespaces,["trebell_browser"]);assert.match(JSON.stringify(queued[1].input),/FIRST QUEUED EDITED/);
    releaseFirstResolve();await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===initial.id);
    for(let attempt=0;attempt<100;attempt++){
      const current=threadStore.get(thread.id),remaining=(state.threadMeta(thread.id)?.queuedSubmissions||[]).length;
      if(current.turns.length===3&&current.turns.every(turn=>turn.status==="completed")&&remaining===0)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const final=threadStore.get(thread.id);assert.equal(final.turns.length,3);assert.ok(final.turns.every(turn=>turn.status==="completed"));assert.deepEqual(final.providerMeta.dynamicToolNamespaces,["trebell_browser"]);assert.equal((state.threadMeta(thread.id)?.queuedSubmissions||[]).length,0);assert.equal(prompts.length,3);
    assert.match(prompts[0],/INITIAL TURN/);assert.match(prompts[1],/SECOND QUEUED/);assert.match(prompts[2],/FIRST QUEUED EDITED/);
    assert.equal((await rpc.request("thread/queue/list",{threadId:thread.id,limit:10})).data.length,0);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Trebell Native resumes an idle durable queue after restart only when restart continuation is enabled",async()=>{
  for(const continueThreadsAfterRestart of [true,false]){
    const root=await mkdtemp(join(tmpdir(),`trebell-native-queue-restart-${continueThreadsAfterRestart?"on":"off"}-`)),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
    const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null,continueThreadsAfterRestart});
    const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),requests=[];
    const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-restart-queue",model:"model-a",providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"auto",projectless:false,environmentId:null}});
    state.updateThreadMeta(thread.id,{queuedSubmissions:[{id:"restart-q1",input:[{type:"text",text:"QUEUED AFTER RESTART"}],clientUserMessageId:"restart-client"}]});
    const nativeProviderTurn=async request=>{requests.push(structuredClone({...request,signal:undefined}));return{id:"restart-queue-answer",provider:request.provider,model:request.model,text:"Restarted queue completed.",toolCalls:[],finishReason:"stop",usage:{}}};
    const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
    const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
    try{
      ws.send(JSON.stringify({method:"initialized"}));
      if(continueThreadsAfterRestart){
        const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.threadId===thread.id,5000);assert.equal(completed.params.turn.status,"completed");
        assert.equal(requests.length,1);assert.match(JSON.stringify(requests[0].messages.at(-1)?.content||""),/QUEUED AFTER RESTART/);assert.equal((state.threadMeta(thread.id).queuedSubmissions||[]).length,0);assert.equal(threadStore.get(thread.id).turns.length,1);
      }else{
        await new Promise(resolve=>setTimeout(resolve,100));assert.equal(requests.length,0);assert.equal((state.threadMeta(thread.id).queuedSubmissions||[]).length,1);assert.equal(threadStore.get(thread.id).turns.length,0);
      }
    }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
  }
});

test("Trebell Native background processes outlive the turn and stay thread-owned",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-background-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home,NATIVE_BACKGROUND_RELAY_SECRET:"must-stay-hidden"},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0;
  const nativeProviderTurn=async request=>{
    calls++;
    const processTools=request.tools.find(item=>item.name==="trebell_process");assert.ok(processTools);assert.ok(processTools.tools.some(item=>item.name==="start"));
    if(calls===1)return{id:"background-tool",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"background-1",namespace:"trebell_process",name:"start",arguments:JSON.stringify({command:process.execPath,args:["-e","process.stdout.write(process.env.NATIVE_BACKGROUND_RELAY_SECRET||'SAFE');setInterval(()=>{},1000)"],cwd:".",max_output_bytes:8192})}],finishReason:"tool_calls",usage:{}};
    assert.equal(request.messages.at(-1).role,"tool");assert.match(request.messages.at(-1).content,/processId/);return{id:"background-answer",provider:request.provider,model:request.model,text:"Server is running in the background.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",dynamicToolNamespaces:["trebell_process"],input:[{type:"text",text:"Start the dev server in the background"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);
    const listed=await rpc.request("thread/backgroundTerminals/list",{threadId:thread.id,limit:10});assert.equal(listed.data.length,1);const processItem=listed.data[0];assert.equal(processItem.running,true);assert.match(processItem.command,/node|electron/i);assert.equal(processItem.cwd,repo);
    const sibling=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    assert.equal((await rpc.request("thread/backgroundTerminals/list",{threadId:sibling.id,limit:10})).data.length,0);await assert.rejects(()=>rpc.request("thread/backgroundTerminals/terminate",{threadId:sibling.id,processId:processItem.processId}),/not found/i);
    const stopped=await rpc.request("thread/backgroundTerminals/terminate",{threadId:thread.id,processId:processItem.processId});assert.equal(stopped.process.running,false);assert.doesNotMatch(stopped.process.stdout,/must-stay-hidden/);assert.equal((await rpc.request("thread/backgroundTerminals/list",{threadId:thread.id,limit:10})).data.length,0);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("a Native thread restored after a restart gives its new background processes handles its history has not used",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-background-restart-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),receipts=[];
  const nativeProviderTurn=async request=>{
    const last=request.messages.at(-1);
    if(last.role==="tool"){receipts.push(String(last.content));return{id:"started-"+receipts.length,provider:request.provider,model:request.model,text:"Started in the background.",toolCalls:[],finishReason:"stop",usage:{}}}
    return{id:"start-"+receipts.length,provider:request.provider,model:request.model,text:"",toolCalls:[{id:"start-call-"+receipts.length,namespace:"trebell_process",name:"start",arguments:JSON.stringify({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],cwd:"."})}],finishReason:"tool_calls",usage:{}};
  };
  // One app run: a relay (and its background-process manager) over the same stored threads.
  const appRun=async()=>{
    const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
    const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
    return {rpc:client(ws),close:async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()))}};
  };
  const startProcess=async(rpc,threadId)=>{
    const turn=(await rpc.request("turn/start",{threadId,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",dynamicToolNamespaces:["trebell_process"],input:[{type:"text",text:"Start the dev server in the background"}]})).turn;
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);
  };
  try{
    let run=await appRun();
    const thread=(await run.rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    await startProcess(run.rpc,thread.id);await run.close();
    run=await appRun();
    try{await startProcess(run.rpc,thread.id)}finally{await run.close()}
    assert.equal(receipts.length,2);
    assert.match(receipts[0],/"process_id":"p1"/);
    assert.match(receipts[1],/"process_id":"p2"/,"the restored thread's history already names p1, so the new process is p2");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Trebell Native exposes first-class Git status directly to the model loop",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-source-control-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await execFileAsync("git",["init"],{cwd:repo,windowsHide:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0;
  const nativeProviderTurn=async request=>{
    calls++;
    const sourceControl=request.tools.find(item=>item.name==="trebell_source_control");assert.ok(sourceControl);assert.ok(sourceControl.tools.some(item=>item.name==="status"));assert.ok(sourceControl.tools.some(item=>item.name==="push"));
    if(calls===1)return{id:"source-status-tool",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"source-status-1",namespace:"trebell_source_control",name:"status",arguments:"{}"}],finishReason:"tool_calls",usage:{}};
    assert.equal(request.messages.at(-1).role,"tool");assert.match(request.messages.at(-1).content,/\"isGit\":true/);return{id:"source-status-answer",provider:request.provider,model:request.model,text:"Git status checked through Trebell.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"read-only",dynamicTools:[{type:"namespace",name:"trebell_source_control"}]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"read-only",input:[{type:"text",text:"Check Git status"}]})).turn;
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(calls,2);
    const persisted=threadStore.get(thread.id);assert.ok(persisted.turns[0].items.some(item=>item.type==="dynamicToolCall"&&item.namespace==="trebell_source_control"&&item.tool==="status"));
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

async function nativeRelayFixture(prefix,settings={},nativeProviderTurn=async()=>{throw new Error("unexpected provider call")}){
  const root=await mkdtemp(join(tmpdir(),prefix)),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",activeEnvironmentId:null,...settings});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  return {root,repo,state,threadStore,ws,rpc:client(ws),close:async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}};
}

test("Trebell Native thread/start stores a normalized provider and defaults to the selected Native provider",async()=>{
  const fixture=await nativeRelayFixture("trebell-native-provider-default-"),{rpc,repo,state}=fixture,retired=RETIRED_MODEL_PROVIDERS[0];
  try{
    const start=params=>rpc.request("thread/start",{cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[],...params}).then(result=>result.thread);
    assert.equal(state.settings().modelProvider,"openai");
    assert.equal((await start({model:"model-a"})).providerMeta.modelProvider,"openai");
    state.updateSettings({modelProvider:"agentrouter"});
    assert.equal((await start({model:"model-a"})).providerMeta.modelProvider,"agentrouter");
    assert.equal((await start({model:"model-b",modelProvider:" HCNSec "})).providerMeta.modelProvider,"hcnsec");
    const stale=await start({model:retired+"/test/coding-fast",modelProvider:retired});
    assert.equal(stale.providerMeta.modelProvider,"openai");assert.equal(stale.model,null);
    const staleModel=await start({model:retired+"/test/coding-large",modelProvider:"agentrouter"});
    assert.equal(staleModel.providerMeta.modelProvider,"agentrouter");assert.equal(staleModel.model,null);
  }finally{await fixture.close()}
});

test("Trebell Native re-points a retired-provider thread and fails fast before any provider call until a model is chosen",async()=>{
  const requests=[],retired=RETIRED_MODEL_PROVIDERS[0];
  const fixture=await nativeRelayFixture("trebell-native-retired-provider-",{modelProvider:"agentrouter"},async request=>{requests.push({provider:request.provider,model:request.model});return{id:"retired-provider-answer",provider:request.provider,model:request.model,text:"Continued with the chosen model.",toolCalls:[],finishReason:"stop",usage:{}}});
  const {rpc,repo,threadStore}=fixture;
  try{
    const legacy=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-retired-provider",model:retired+"/deepseek/deepseek-v4-flash",providerMeta:{runtimeInstanceId:"native-default",modelProvider:retired,permissionProfile:"auto",projectless:false,environmentId:null}});
    const turnOf=async params=>{const turn=(await rpc.request("turn/start",{threadId:legacy.id,permissionProfile:"auto",...params})).turn;return (await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id)).params.turn};
    const resumed=await turnOf({input:[{type:"text",text:"Continue the old conversation."}]});
    assert.equal(resumed.status,"failed");assert.match(resumed.error?.message||"",/Trebell Native requires a model/);assert.equal(requests.length,0);
    let stored=threadStore.get(legacy.id);assert.equal(stored.providerMeta.modelProvider,"agentrouter");assert.equal(stored.model,null);
    const stale=await turnOf({model:retired+"/test/coding-fast",modelProvider:retired,input:[{type:"text",text:"A stale client still names the retired provider."}]});
    assert.equal(stale.status,"failed");assert.match(stale.error?.message||"",/Trebell Native requires a model/);assert.equal(requests.length,0);
    stored=threadStore.get(legacy.id);assert.equal(stored.providerMeta.modelProvider,"openai");assert.equal(stored.model,null);
    const chosen=await turnOf({model:"model-a",modelProvider:"agentrouter",input:[{type:"text",text:"Continue with the model I picked."}]});
    assert.equal(chosen.status,"completed");assert.deepEqual(requests,[{provider:"agentrouter",model:"model-a"}]);
    stored=threadStore.get(legacy.id);assert.equal(stored.providerMeta.modelProvider,"agentrouter");assert.equal(stored.model,"model-a");assert.equal(stored.turns.length,3);
  }finally{await fixture.close()}
});

test("Trebell Native keeps a retired-provider thread's queued follow-up queued until the user continues with a model",async()=>{
  const requests=[],retired=RETIRED_MODEL_PROVIDERS[0];
  const fixture=await nativeRelayFixture("trebell-native-retired-queue-",{modelProvider:"openai",continueThreadsAfterRestart:true},async request=>{
    requests.push({provider:request.provider,model:request.model,messages:JSON.stringify(request.messages||[]),tools:(request.tools||[]).map(item=>item.name)});
    return{id:"retired-queue-answer-"+requests.length,provider:request.provider,model:request.model,text:"Continued with the chosen model.",toolCalls:[],finishReason:"stop",usage:{}};
  });
  const {rpc,ws,repo,state,threadStore}=fixture;
  try{
    const png=Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082","hex"),image=join(repo,"before-upgrade.png");await writeFile(image,png);
    const legacy=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-retired-queue",model:"deepseek/deepseek-v4-flash",providerMeta:{runtimeInstanceId:"native-default",modelProvider:retired,permissionProfile:"auto",projectless:false,environmentId:null}});
    const queued={id:"retired-q1",input:[{type:"text",text:"QUEUED FOLLOW-UP: what does the attached screenshot show?"},{type:"localImage",path:image}],clientUserMessageId:"retired-client",dynamicToolNamespaces:["trebell_browser"]};
    state.updateThreadMeta(legacy.id,{queuedSubmissions:[queued]});
    const queue=()=>state.threadMeta(legacy.id)?.queuedSubmissions||[];
    ws.send(JSON.stringify({method:"initialized"}));
    const notice=await rpc.waitFor(message=>message.method==="error"&&message.params?.threadId===legacy.id,5000);
    assert.match(notice.params.message,/Choose a model for this thread before its queued follow-up can run/);
    assert.doesNotMatch(notice.params.message,new RegExp(retired,"i"),"the notice never names the removed provider");
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.deepEqual(requests,[],"no provider call is made for the old transcript");
    assert.equal(threadStore.get(legacy.id).turns.length,0,"no turn is started, so none fails");
    assert.deepEqual(queue(),[queued],"the follow-up keeps its text, attachment and tool scope");
    let stored=threadStore.get(legacy.id);assert.equal(stored.providerMeta.modelProvider,"openai");assert.equal(stored.model,null);
    await assert.rejects(()=>rpc.request("thread/queue/start",{threadId:legacy.id,queuedSubmissionId:queued.id}),/Choose a model for this thread before its queued follow-up can run/);
    assert.deepEqual(queue(),[queued],"a manual start is refused without consuming the follow-up");assert.equal(threadStore.get(legacy.id).turns.length,0);assert.deepEqual(requests,[]);
    const chosen=(await rpc.request("turn/start",{threadId:legacy.id,model:"model-a",modelProvider:"openai",permissionProfile:"auto",input:[{type:"text",text:"Continue with the model I picked."}]})).turn;
    assert.equal((await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===chosen.id)).params.turn.status,"completed");
    const drained=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.threadId===legacy.id&&message.params?.turn?.id!==chosen.id,5000);
    assert.equal(drained.params.turn.status,"completed",JSON.stringify(drained.params.turn.error||null));
    assert.deepEqual(requests.map(item=>[item.provider,item.model]),[["openai","model-a"],["openai","model-a"]],"the queued follow-up runs with the model the user chose");
    assert.ok(requests[1].messages.includes("QUEUED FOLLOW-UP: what does the attached screenshot show?"),"the queued text is sent");assert.ok(requests[1].messages.includes(png.toString("base64")),"the queued image attachment is sent with it");
    assert.ok(requests[1].tools.includes("trebell_browser"),"the queued tool scope is restored");
    assert.deepEqual(queue(),[]);
    stored=threadStore.get(legacy.id);assert.equal(stored.model,"model-a");assert.equal(stored.turns.length,2);
  }finally{await fixture.close()}
});

test("Trebell Native runs a Supervised command after Allow session and runs it again in that session without asking",async()=>{
  // The live tour: "Allow session" answered acceptForSession, which Native read as a refusal ("Tool execution was not approved.").
  const root=await mkdtemp(join(tmpdir(),"trebell-native-session-grant-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0;
  const nativeProviderTurn=async request=>{
    calls++;
    const reply=(text,toolCalls=[])=>({id:"grant-"+calls,provider:request.provider,model:request.model,text,toolCalls,finishReason:toolCalls.length?"tool_calls":"stop",usage:{}});
    if(request.toolChoice==="none")return reply('{"status":"complete","unresolved":[],"reason":"The command ran."}');
    const last=request.messages.at(-1);if(last?.role==="tool")return reply("Ran it.");
    const asked=JSON.stringify(last?.content||""),code=/Run B/.test(asked)?"process.stdout.write('B')":"process.stdout.write('A')";
    // The same command asks for other output and time bounds the second time: the grant still covers it.
    return reply("",[{id:"run-"+calls,namespace:"trebell_terminal",name:"run",arguments:JSON.stringify({command:process.execPath,args:["-e",code],cwd:".",timeout_ms:/again/.test(asked)?60000:30000})}]);
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  const approvals=[];ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.method==="item/tool/requestApproval")approvals.push(message)});
  const answer=(message,decision)=>ws.send(JSON.stringify({id:message.id,result:{decision}}));
  const runTurn=async text=>{const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"supervised",input:[{type:"text",text}]})).turn;return turn};
  const finished=turn=>rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id,15000);
  const runItem=index=>threadStore.get(thread.id).turns[index].items.find(item=>item.type==="dynamicToolCall"&&item.tool==="run");
  let thread=null;
  try{
    thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"supervised",dynamicTools:[]})).thread;
    const first=await runTurn("Run A");
    const asked=await rpc.waitFor(message=>message.method==="item/tool/requestApproval",15000);
    assert.match(asked.params.reason,/^trebell_terminal\/run: .+ -e process\.stdout\.write\('A'\) \(Supervised profile requires confirmation\.\)$/,"the card says what it approves");
    answer(asked,"acceptForSession");await finished(first);
    assert.equal(runItem(0).success,true,"Allow session runs the command");
    const second=await runTurn("Run A again");await finished(second);
    assert.equal(approvals.length,1,"the same command does not ask again in this session");
    assert.equal(runItem(1).success,true);
    const third=await runTurn("Run B");
    const askedAgain=await rpc.waitFor(message=>message.method==="item/tool/requestApproval"&&message.id!==asked.id,15000);
    assert.match(askedAgain.params.reason,/-e process\.stdout\.write\('B'\)/,"another command asks");
    answer(askedAgain,"decline");await finished(third);
    assert.equal(runItem(2).success,false,"a declined command does not run");
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Stop ends a Supervised Trebell Native turn whose approval waits, takes the card away, and no window that opens later is asked it",async()=>{
  // Stop answered the other harnesses' waiting approvals but not Native's: the turn, waiting on that answer, ran on until the card was
  // answered, and a reload asked the stopped turn's approval again of the next window.
  const root=await mkdtemp(join(tmpdir(),"trebell-native-stop-approval-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0;
  const nativeProviderTurn=async request=>{
    calls++;
    const reply=(text,toolCalls=[])=>({id:"stop-approval-"+calls,provider:request.provider,model:request.model,text,toolCalls,finishReason:toolCalls.length?"tool_calls":"stop",usage:{}});
    if(request.toolChoice==="none")return reply('{"status":"complete","unresolved":[],"reason":"The command ran."}');
    if(request.messages.at(-1)?.role==="tool")return reply("Ran it.");
    return reply("",[{id:"run-"+calls,namespace:"trebell_terminal",name:"run",arguments:JSON.stringify({command:process.execPath,args:["-e","require('fs').writeFileSync('ran.txt','A')"],cwd:".",timeout_ms:30000})}]);
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),url=`ws://127.0.0.1:${port}/api/agent/ws`;
  const open=async()=>{const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws};
  let first=null,second=null;
  try{
    first=await open();const rpc=client(first);
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"supervised",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"supervised",input:[{type:"text",text:"Write ran.txt"}]})).turn;
    const asked=await rpc.waitFor(message=>message.method==="item/tool/requestApproval",15000);
    await rpc.request("turn/interrupt",{threadId:thread.id,turnId:turn.id});
    assert.deepEqual((await rpc.waitFor(message=>message.method==="serverRequest/resolved",5000)).params,{requestId:asked.id,threadId:thread.id},"Stop takes the card away");
    const ended=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id,5000);
    assert.equal(ended.params.turn.status,"cancelled","Stop ends the turn without waiting for an answer");
    // The window reloads.
    await new Promise(resolve=>{first.once("close",resolve);first.close()});
    second=await open();const seen=[];second.on("message",raw=>seen.push(JSON.parse(String(raw))));second.send(JSON.stringify({method:"initialized",params:{}}));
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.deepEqual(seen.filter(message=>message.method==="item/tool/requestApproval").map(message=>message.id),[],"the stopped turn's approval is not asked of the next window");
    assert.equal(await readFile(join(repo,"ran.txt"),"utf8").then(()=>true,()=>false),false,"the command did not run");
    assert.equal(threadStore.get(thread.id).turns.at(-1).status,"cancelled");
  }finally{
    for(const ws of [first,second])try{ws?.close()}catch{}
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});

test("Stop ends a Trebell Native turn whose browser tool call the app has not answered, and no window that opens later is asked to run it",async()=>{
  // The app runs Native's browser, desktop and delegation tools (item/tool/call). One still waiting held the stopped turn running until
  // the app answered, and a window that opened later was asked to run it again: a click, a keystroke or a delegated task of a turn that
  // had been stopped.
  const root=await mkdtemp(join(tmpdir(),"trebell-native-stop-app-tool-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0;
  const nativeProviderTurn=async request=>{
    calls++;
    const reply=(text,toolCalls=[])=>({id:"stop-app-tool-"+calls,provider:request.provider,model:request.model,text,toolCalls,finishReason:toolCalls.length?"tool_calls":"stop",usage:{}});
    if(request.toolChoice==="none")return reply('{"status":"complete","unresolved":[],"reason":"The page was read."}');
    if(request.messages.at(-1)?.role==="tool")return reply("Read the page.");
    return reply("",[{id:"snapshot-"+calls,namespace:"trebell_browser",name:"snapshot",arguments:"{}"}]);
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),url=`ws://127.0.0.1:${port}/api/agent/ws`;
  const open=async()=>{const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws};
  let first=null,second=null;
  try{
    first=await open();const rpc=client(first);
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"supervised",dynamicTools:[{type:"namespace",name:"trebell_browser"}]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"supervised",input:[{type:"text",text:"Read the open page"}]})).turn;
    const approval=await rpc.waitFor(message=>message.method==="item/tool/requestApproval",15000);
    first.send(JSON.stringify({id:approval.id,result:{decision:"accept"}}));
    const asked=await rpc.waitFor(message=>message.method==="item/tool/call",15000);
    assert.deepEqual([asked.params.namespace,asked.params.tool],["trebell_browser","snapshot"]);
    // The app has not answered when Stop is pressed.
    await rpc.request("turn/interrupt",{threadId:thread.id,turnId:turn.id});
    const ended=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id,5000);
    assert.equal(ended.params.turn.status,"cancelled","Stop ends the turn without waiting for the app");
    // The window reloads.
    await new Promise(resolve=>{first.once("close",resolve);first.close()});
    second=await open();const seen=[];second.on("message",raw=>seen.push(JSON.parse(String(raw))));second.send(JSON.stringify({method:"initialized",params:{}}));
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.deepEqual(seen.filter(message=>message.method==="item/tool/call").map(message=>message.id),[],"the next window is not asked to run the stopped turn's tool");
  }finally{
    for(const ws of [first,second])try{ws?.close()}catch{}
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});

test("a Trebell Native browser click that a window was given when it reloaded is not run again by the next window, and the model is told",async()=>{
  // The app runs the click as soon as it is asked (the desktop bridge clicks the page) and answers afterwards. A window that reloads,
  // or loses its socket, before its answer is sent may have clicked already: asking the next window would click a second time, as it
  // would type a second time on the person's desktop or start a second delegated task.
  const root=await mkdtemp(join(tmpdir(),"trebell-native-app-tool-reload-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0;const toolResults=[];
  const nativeProviderTurn=async request=>{
    calls++;
    const reply=(text,toolCalls=[])=>({id:"app-tool-reload-"+calls,provider:request.provider,model:request.model,text,toolCalls,finishReason:toolCalls.length?"tool_calls":"stop",usage:{}});
    if(request.toolChoice==="none")return reply('{"status":"complete","unresolved":[],"reason":"The window closed."}');
    if(request.messages.at(-1)?.role==="tool"){toolResults.push(JSON.stringify(request.messages.at(-1).content));return reply("The window closed before the click was confirmed.")}
    return reply("",[{id:"click-"+calls,namespace:"trebell_browser",name:"click",arguments:JSON.stringify({ref:"e12"})}]);
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),url=`ws://127.0.0.1:${port}/api/agent/ws`;
  const open=async()=>{const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws};
  let first=null,second=null;
  try{
    first=await open();const rpc=client(first);
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"supervised",dynamicTools:[{type:"namespace",name:"trebell_browser"}]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"supervised",input:[{type:"text",text:"Press Submit on the open page"}]})).turn;
    const approval=await rpc.waitFor(message=>message.method==="item/tool/requestApproval",15000);
    first.send(JSON.stringify({id:approval.id,result:{decision:"accept"}}));
    const asked=await rpc.waitFor(message=>message.method==="item/tool/call",15000);
    assert.deepEqual([asked.params.namespace,asked.params.tool],["trebell_browser","click"]);
    // The window has the click (and runs it), and reloads before its answer is sent.
    await new Promise(resolve=>{first.once("close",resolve);first.close()});
    second=await open();const seen=[];second.on("message",raw=>seen.push(JSON.parse(String(raw))));second.send(JSON.stringify({method:"initialized",params:{}}));
    for(const deadline=Date.now()+15000;threadStore.get(thread.id).turns.find(item=>item.id===turn.id)?.status==="inProgress"&&Date.now()<deadline;)await new Promise(resolve=>setTimeout(resolve,25));
    assert.deepEqual(seen.filter(message=>message.method==="item/tool/call").map(message=>message.id),[],"the next window is not asked to click again");
    assert.equal(toolResults.length,1,"the model gets one answer for its click");
    assert.match(toolResults[0],/closed before it answered/,"the model is told the window closed before it answered");
    assert.equal(threadStore.get(thread.id).turns.find(item=>item.id===turn.id)?.status,"completed","the turn goes on and ends");
  }finally{
    for(const ws of [first,second])try{ws?.close()}catch{}
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});

// Native reply drafts through the relay. The fake provider drives the session's stream hook the way a provider stream does.
const DRAFT_REPLY="Trebell Native keeps one thread per conversation, and each reply comes from the model that thread names.\n\nThe session builds every request from the stored turns and sends it to the thread's provider, which streams the answer back as it is written.";
const SECOND_REPLY="The retried call answered on its own.\n\nNothing the first attempt streamed stays on screen: its draft was cleared before the second attempt began, and this text started again from the first character.";
const STEERED_REPLY="The steered call starts a new draft.\n\nThe draft of the call the steering stopped was cleared, so this reply streams from its first character and nothing of the stopped call is left in it.";
const OTHER_REPLY="The provider returned a different final text than it streamed, so the streamed draft was cleared and this reply replaced it whole.";

function nativeDraftFrames(ws){
  const frames=[];
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.method==="item/agentMessage/delta"||message.method==="item/agentMessage/reset")frames.push({method:message.method,...message.params})});
  return turnId=>frames.filter(frame=>frame.turnId===turnId);
}
// What a client shows once a turn's frames are applied: a delta continues at its offset and a reset clears the text.
function textAfterLastReset(frames){
  const last=frames.map(frame=>frame.method).lastIndexOf("item/agentMessage/reset");
  return frames.slice(last+1).filter(frame=>frame.method==="item/agentMessage/delta").map(frame=>frame.delta).join("");
}
function assertContiguousDraft(frames){
  let shown=0;
  for(const frame of frames){
    if(frame.method==="item/agentMessage/reset"){assert.equal(frame.chars,shown);assert.equal("delta" in frame,false);shown=0;continue}
    if(frame.offset==null)continue;
    assert.equal(frame.offset,shown);assert.equal(frame.itemId,"assistant-"+frame.turnId);shown+=frame.delta.length;
  }
}
let nativeReplyCount=0;
const nativeReply=(request,text,extra={})=>({id:"draft-reply-"+(++nativeReplyCount),provider:request.provider,model:request.model,text,toolCalls:[],finishReason:"stop",usage:{inputTokens:5,outputTokens:9,totalTokens:14},...extra});
const untilAborted=signal=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(Object.assign(new Error("provider request aborted"),{name:"AbortError"})),{once:true}));

test("Trebell Native streams a reply as deltas of its turn's assistant item while the provider call runs, and ends on the same text",async()=>{
  const burst=Array.from({length:100},(_,index)=>" part"+index),reply=DRAFT_REPLY+burst.join("");let releaseCall,hookType=null;const released=new Promise(resolve=>{releaseCall=resolve});
  const fixture=await nativeRelayFixture("trebell-native-draft-stream-",{},async request=>{
    const hook=request[NATIVE_REPLY_STREAM];hookType=typeof hook;
    hook({type:"text",delta:DRAFT_REPLY});await released;
    // A hundred deltas in one burst, well inside the relay's 50 ms window.
    for(const piece of burst)hook({type:"text",delta:piece});
    await new Promise(resolve=>setTimeout(resolve,150));
    return nativeReply(request,reply);
  });
  const {rpc,repo,ws,threadStore}=fixture,framesOf=nativeDraftFrames(ws),readThread=threadStore.get.bind(threadStore);let draftReads=0;
  threadStore.get=id=>{const limit=Error.stackTraceLimit;Error.stackTraceLimit=80;const stack=String(new Error().stack||"");Error.stackTraceLimit=limit;if(/NativeDraft/.test(stack))draftReads++;return readThread(id)};
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",permissionProfile:"auto",input:[{type:"text",text:"Explain how a Native thread picks the model it answers with. Do not change any files."}]})).turn;
    const first=await rpc.waitFor(message=>message.method==="item/agentMessage/delta"&&message.params?.turnId===turn.id);
    assert.equal(hookType,"function");assert.deepEqual(first.params,{threadId:thread.id,turnId:turn.id,itemId:"assistant-"+turn.id,delta:DRAFT_REPLY,offset:0});
    releaseCall();
    const completed=await rpc.waitFor(message=>message.method==="item/completed"&&message.params?.turnId===turn.id&&message.params?.item?.type==="agentMessage");
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);
    const frames=framesOf(turn.id);
    assert.ok(frames.every(frame=>frame.method==="item/agentMessage/delta"&&frame.offset!=null),"only draft deltas, no reset and no second copy of the reply");
    assert.ok(frames.length>=2&&frames.length<=3,"the burst is coalesced: "+frames.length+" frames");
    assertContiguousDraft(frames);
    assert.equal(completed.params.item.id,"assistant-"+turn.id);assert.equal(completed.params.item.text,reply);assert.equal(textAfterLastReset(frames),completed.params.item.text);
    assert.deepEqual(threadStore.get(thread.id).turns.at(-1).items.filter(item=>item.type==="agentMessage").map(item=>item.text),[reply]);
    assert.equal(draftReads,0,"draft handling never reads the stored thread");
  }finally{threadStore.get=readThread;await fixture.close()}
});

test("Trebell Native clears a shown draft with a reset frame when its call goes another way, and never for a draft it did not show",async()=>{
  const script=[];let calls=0;
  const fixture=await nativeRelayFixture("trebell-native-draft-reset-",{},async request=>{calls++;const step=script.shift();assert.ok(step,"unexpected provider call "+calls);return step(request,request[NATIVE_REPLY_STREAM])});
  const {rpc,repo,ws}=fixture,framesOf=nativeDraftFrames(ws);
  await writeFile(join(repo,"session.js"),"export class SessionManager { refresh(){ return true; } }\n","utf8");
  const searchCall={id:"repo-call",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"SessionManager"}'};
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const run=async(text,during=null)=>{
      const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",permissionProfile:"auto",input:[{type:"text",text}]})).turn;
      if(during){await rpc.waitFor(message=>message.method==="item/agentMessage/delta"&&message.params?.turnId===turn.id);await during(turn)}
      const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id,10000);
      const frames=framesOf(turn.id);assertContiguousDraft(frames);
      return {turn,frames,status:completed.params.turn.status,resets:frames.filter(frame=>frame.method==="item/agentMessage/reset").map(frame=>frame.reason)};
    };
    const completedText=async turnId=>(await rpc.waitFor(message=>message.method==="item/completed"&&message.params?.turnId===turnId&&message.params?.item?.type==="agentMessage")).params.item.text;

    // A tool call: the draft goes as the call turns to tools, and text the call sends after that is never shown.
    script.push(async(request,hook)=>{hook({type:"text",delta:DRAFT_REPLY});hook({type:"tool_call"});hook({type:"text",delta:" late text"});return nativeReply(request,"",{toolCalls:[searchCall],finishReason:"tool_calls"})},
      async request=>nativeReply(request,"SessionManager is defined in session.js."));
    const tool=await run("Where is SessionManager defined? Do not change any files.");
    assert.deepEqual(tool.resets,["tool_call"]);assert.equal(tool.frames[0].delta,DRAFT_REPLY);assert.ok(tool.frames.every(frame=>!String(frame.delta||"").includes("late text")));
    assert.equal(textAfterLastReset(tool.frames),"SessionManager is defined in session.js.");assert.equal(await completedText(tool.turn.id),"SessionManager is defined in session.js.");

    // A failed attempt: cleared before the retry, whose own draft starts again at offset 0.
    script.push(async(request,hook)=>{hook({type:"text",delta:DRAFT_REPLY});throw Object.assign(new Error("HTTP 503: upstream unavailable"),{status:503,retryable:true})},
      async(request,hook)=>{hook({type:"text",delta:SECOND_REPLY});return nativeReply(request,SECOND_REPLY)});
    const retried=await run("Explain why the retry happened.");
    assert.deepEqual(retried.resets,["error"]);assert.deepEqual(retried.frames.filter(frame=>frame.offset===0).map(frame=>frame.delta),[DRAFT_REPLY,SECOND_REPLY]);
    assert.equal(textAfterLastReset(retried.frames),SECOND_REPLY);assert.equal(await completedText(retried.turn.id),SECOND_REPLY);

    // Steering mid-stream: the stopped call's draft is cleared and the steered call streams from offset 0.
    script.push(async(request,hook)=>{hook({type:"text",delta:DRAFT_REPLY});await untilAborted(request.signal)},
      async(request,hook)=>{assert.match(JSON.stringify(request.messages.at(-1).content),/provider part only/);hook({type:"text",delta:STEERED_REPLY});return nativeReply(request,STEERED_REPLY)});
    const steered=await run("Describe how a steered turn continues.",async turn=>{const result=await rpc.request("turn/steer",{threadId:thread.id,expectedTurnId:turn.id,input:[{type:"text",text:"Explain the provider part only."}]});assert.equal(result.accepted,true)});
    assert.deepEqual(steered.resets,["steered"]);assert.equal(steered.status,"completed");assert.equal(textAfterLastReset(steered.frames),STEERED_REPLY);assert.equal(await completedText(steered.turn.id),STEERED_REPLY);

    // Stop mid-stream: the draft is cleared and the turn keeps no reply.
    script.push(async(request,hook)=>{hook({type:"text",delta:DRAFT_REPLY});await untilAborted(request.signal)});
    const stopped=await run("Explain what happens when I press Stop.",async()=>{await rpc.request("turn/interrupt",{threadId:thread.id})});
    assert.deepEqual(stopped.resets,["cancelled"]);assert.equal(stopped.status,"cancelled");assert.equal(textAfterLastReset(stopped.frames),"");
    assert.equal((await rpc.request("thread/read",{threadId:thread.id})).thread.turns.find(turn=>turn.id===stopped.turn.id).items.some(item=>item.type==="agentMessage"),false);

    // A final reply that is not the streamed text replaces the draft whole.
    script.push(async(request,hook)=>{hook({type:"text",delta:DRAFT_REPLY});return nativeReply(request,OTHER_REPLY)});
    const replaced=await run("Summarize what session.js exports.");
    assert.deepEqual(replaced.resets,["mismatch"]);assert.equal(replaced.frames.at(-1).offset,undefined);assert.equal(textAfterLastReset(replaced.frames),OTHER_REPLY);assert.equal(await completedText(replaced.turn.id),OTHER_REPLY);

    // A short preamble before a tool call never shows, so nothing is reset and the reply arrives as today's single delta.
    script.push(async(request,hook)=>{hook({type:"text",delta:"Let me look at the session file first."});hook({type:"tool_call"});return nativeReply(request,"",{toolCalls:[{...searchCall,id:"repo-call-2"}],finishReason:"tool_calls"})},
      async request=>nativeReply(request,"session.js exports SessionManager."));
    const quiet=await run("Explain session.js in one paragraph.");
    assert.deepEqual(quiet.frames.map(frame=>({method:frame.method,offset:frame.offset,delta:frame.delta})),[{method:"item/agentMessage/delta",offset:undefined,delta:"session.js exports SessionManager."}]);
    assert.equal(script.length,0);
  }finally{await fixture.close()}
});

test("opening a Trebell Native thread keeps its place in the thread list: an open is not activity",async()=>{
  const fixture=await nativeRelayFixture("trebell-native-open-recency-",{modelProvider:"openai"}),{rpc,repo,threadStore}=fixture;
  try{
    const providerMeta={runtimeInstanceId:"native-default",modelProvider:"openai",permissionProfile:"auto",projectless:false,environmentId:null};
    const turns=[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Refactor the payment flow"}]},{type:"agentMessage",id:"assistant-1",text:"Done."}]}];
    const at=Math.floor(Date.now()/1000);
    const newer=threadStore.importHistory({runtime:"native",cwd:repo,providerSessionId:"recency-newer",model:"gpt-5.6",name:"Fix login redirect",providerMeta,turns,createdAt:at-600,updatedAt:at-300});
    const older=threadStore.importHistory({runtime:"native",cwd:repo,providerSessionId:"recency-older",model:"gpt-5.6",name:"Refactor payment flow",providerMeta,turns,createdAt:at-3600,updatedAt:at-1920});
    await rpc.request("thread/resume",{threadId:older.id});
    assert.equal(threadStore.get(older.id).updatedAt,at-1920,"opening it does not make it just active");
    const listed=await rpc.request("thread/list",{limit:10,sortKey:"updated_at",sortDirection:"desc"});
    assert.deepEqual(listed.data.map(thread=>thread.id),[newer.id,older.id]);
  }finally{await fixture.close()}
});
