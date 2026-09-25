import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp,mkdir,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

const nativeMcpFixture=resolve(fileURLToPath(new URL("fixtures/native-mcp-server.mjs",import.meta.url)));
const execFileAsync=promisify(execFile);

test("Trebell Native relay executes repository tools and switches inference provider without changing thread identity",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await writeFile(join(repo,"session.js"),"export class SessionManager { refresh(){ return true; } }\n","utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),providers=[];let modelTurns=0;
  const nativeProviderTurn=async request=>{
    providers.push(request.provider);modelTurns++;
    assert.equal(request.messages[0]?.role,"developer");assert.match(String(request.messages[0]?.content||""),/Use repository intelligence when useful/);
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
    const firstUsage=state.threadUsage(threadId);assert.equal(firstUsage.totalTokens,16);assert.equal(firstUsage.inputTokens,12);assert.equal(firstUsage.outputTokens,4);
    const firstUsageRecord=state.usage({days:1,limit:20}).records.find(record=>record.turnId===first.turn.id);assert.equal(firstUsageRecord.provider,"agentrouter");
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

test("Trebell Native exposes Trebell semantic language intelligence directly to the model loop",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-language-relay-")),home=join(root,"home"),repo=join(root,"repo");
  await mkdir(join(repo,"src"),{recursive:true});await mkdir(join(repo,"node_modules","typescript","lib"),{recursive:true});
  await writeFile(join(repo,"src","typed.ts"),"export const typed: string = 'ok';\n","utf8");await writeFile(join(repo,"tsconfig.json"),"{}\n","utf8");
  await writeFile(join(repo,"node_modules","typescript","lib","typescript.js"),`const fs=require("fs"),path=require("path");let base=process.cwd();
const fileName=()=>path.join(base,"src","typed.ts"),file=()=>({fileName:fileName(),getPositionOfLineAndCharacter:(_line,column)=>column,getLineAndCharacterOfPosition:position=>({line:0,character:position})});
module.exports={version:"fixture-ts-native",sys:{fileExists:fs.existsSync,readFile:p=>fs.readFileSync(p,"utf8"),readDirectory:()=>[],directoryExists:fs.existsSync,getDirectories:()=>[],useCaseSensitiveFileNames:true,newLine:"\\n"},ScriptSnapshot:{fromString:text=>({text})},findConfigFile:root=>{base=root;return path.join(root,"tsconfig.json")},readConfigFile:()=>({config:{}}),parseJsonConfigFileContent:(_config,_sys,nextBase)=>{base=nextBase;return{fileNames:[fileName()],options:{},errors:[],projectReferences:[]}},getDefaultLibFilePath:()=>"",createDocumentRegistry:()=>({}),createLanguageService:()=>{const source=file(),program={getSourceFile:value=>path.resolve(value)===path.resolve(source.fileName)?source:undefined};return{getProgram:()=>program,getDefinitionAtPosition:()=>[{fileName:source.fileName,textSpan:{start:13,length:5},name:"typed",kind:"const",containerName:""}]}}};\n`,"utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0;
  const nativeProviderTurn=async request=>{
    calls++;const repoTools=(request.tools||[]).find(item=>item.name==="trebell_repo");assert.ok(repoTools);assert.ok(repoTools.tools.some(tool=>tool.name==="language_symbol"));assert.ok(repoTools.tools.some(tool=>tool.name==="code_actions"));assert.ok(repoTools.tools.some(tool=>tool.name==="rename_preview"));
    if(calls===1)return{id:"language-call",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"language-1",namespace:"trebell_repo",name:"language_symbol",arguments:JSON.stringify({path:"src/typed.ts",line:1,column:14,operation:"definition"})}],finishReason:"tool_calls",usage:{}};
    const observation=request.messages.at(-1);assert.equal(observation.role,"tool");assert.match(observation.content,/\"supported\":true/);assert.match(observation.content,/\"semantic\":true/);assert.match(observation.content,/\"name\":\"typed\"/);
    return{id:"language-done",provider:request.provider,model:request.model,text:"Semantic definition resolved.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"read-only",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"read-only",input:[{type:"text",text:"Resolve the semantic definition of typed"}]})).turn;
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(calls,2);
    const persisted=threadStore.get(thread.id);assert.ok(persisted.turns[0].items.some(item=>item.type==="dynamicToolCall"&&item.namespace==="trebell_repo"&&item.tool==="language_symbol"));
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Trebell Native exposes configured MCP tools directly to the model loop",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-mcp-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({
    agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null,
    mcpServers:[{id:"relay-native",name:"Relay Native MCP",runtime:"native",enabled:true,type:"stdio",command:process.execPath,args:[nativeMcpFixture],env:[{name:"FIXTURE_VISIBLE",value:"relay"},{name:"API_KEY",value:"must-not-leak"}]}],
  });
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0,seenNamespace=null;
  const nativeProviderTurn=async request=>{
    calls++;const namespace=(request.tools||[]).find(item=>item.name?.startsWith("mcp_"));assert.ok(namespace);assert.ok(namespace.tools.some(tool=>tool.name==="echo-read"));seenNamespace=namespace.name;
    if(calls===1)return {id:"mcp-call",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"mcp-1",namespace:namespace.name,name:"echo-read",arguments:'{"text":"from-model"}'}],finishReason:"tool_calls",usage:{}};
    const observation=request.messages.at(-1);assert.equal(observation.role,"tool");assert.match(JSON.stringify(observation.content),/echo:from-model:env=relay:secret=\[redacted\]/);
    return {id:"mcp-done",provider:request.provider,model:request.model,text:"MCP completed.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"read-only",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"read-only",input:[{type:"text",text:"Use the configured MCP echo tool"}]})).turn;
    const completed=await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);assert.equal(completed.params.turn.status,"completed",JSON.stringify(completed.params.turn.error||null));assert.equal(calls,2);
    const persisted=(await rpc.request("thread/read",{threadId:thread.id})).thread;assert.deepEqual(persisted.providerMeta.nativeMcp.failures,[]);assert.deepEqual(persisted.providerMeta.nativeMcp.namespaces,[seenNamespace]);assert.ok(persisted.turns[0].items.some(item=>item.type==="dynamicToolCall"&&item.namespace===seenNamespace&&item.tool==="echo-read"&&item.success===true));
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
});

test("Trebell Native reloads changed MCP settings on the next turn of the same thread",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-mcp-reload-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const serverConfig=value=>[{id:"reload-native",name:"Reload Native MCP",runtime:"native",enabled:true,type:"stdio",command:process.execPath,args:[nativeMcpFixture],env:[{name:"FIXTURE_VISIBLE",value}]}];
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null,mcpServers:serverConfig("before")});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let call=0,namespaceName=null;
  const nativeProviderTurn=async request=>{
    call++;const namespace=(request.tools||[]).find(item=>item.name?.startsWith("mcp_"));assert.ok(namespace);namespaceName=namespace.name;
    if(call===1||call===3)return{id:`reload-call-${call}`,provider:request.provider,model:request.model,text:"",toolCalls:[{id:`reload-tool-${call}`,namespace:namespace.name,name:"echo-read",arguments:JSON.stringify({text:call===1?"first":"second"})}],finishReason:"tool_calls",usage:{}};
    const observation=String(request.messages.at(-1)?.content||"");
    if(call===2){assert.match(observation,/echo:first:env=before/);return{id:"reload-done-before",provider:request.provider,model:request.model,text:"First MCP config used.",toolCalls:[],finishReason:"stop",usage:{}}}
    assert.equal(call,4);assert.match(observation,/echo:second:env=after/);return{id:"reload-done-after",provider:request.provider,model:request.model,text:"Reloaded MCP config used.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const events=[],journal={record:event=>events.push(event),recordProtocol:()=>{}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test",journal});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"read-only",dynamicTools:[]})).thread;
    const first=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"read-only",input:[{type:"text",text:"Use MCP before reload"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===first.id);
    state.updateSettings({mcpServers:serverConfig("after")});
    const second=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"read-only",input:[{type:"text",text:"Use MCP after reload"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===second.id);
    assert.equal(call,4);assert.ok(events.some(event=>event.name==="native.mcp.reloaded"&&event.threadId===thread.id));const persisted=threadStore.get(thread.id);assert.equal(persisted.id,thread.id);assert.deepEqual(persisted.providerMeta.nativeMcp.namespaces,[namespaceName]);assert.equal(persisted.turns.length,2);
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
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
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
    try{ws.close()}catch{}if(relay)await relay.close().catch(()=>{});if(server.listening)await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
  }
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
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
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
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
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
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
});

test("Trebell Native durable queue edits, reorders and auto-starts after a successful turn",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-queue-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),prompts=[];let firstStartedResolve,releaseFirstResolve;const firstStarted=new Promise(resolve=>{firstStartedResolve=resolve}),releaseFirst=new Promise(resolve=>{releaseFirstResolve=resolve});
  const nativeProviderTurn=async request=>{
    const visible=JSON.stringify(request.messages.at(-1)?.content||"");prompts.push(visible);
    if(prompts.length===1){firstStartedResolve();await releaseFirst;return{id:"initial-done",provider:request.provider,model:request.model,text:"Initial done",toolCalls:[],finishReason:"stop",usage:{}}}
    return{id:"queued-done-"+prompts.length,provider:request.provider,model:request.model,text:"Queued done",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:true,permissionProfile:"auto",dynamicTools:[]})).thread;
    const initial=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"INITIAL TURN"}]})).turn;await firstStarted;
    const q1=(await rpc.request("thread/queue/add",{threadId:thread.id,input:[{type:"text",text:"FIRST QUEUED"}],clientUserMessageId:"client-q1"})).queuedSubmission;
    const q2=(await rpc.request("thread/queue/add",{threadId:thread.id,input:[{type:"text",text:"SECOND QUEUED"}],clientUserMessageId:"client-q2"})).queuedSubmission;
    await rpc.request("thread/queue/update",{threadId:thread.id,queuedSubmissionId:q1.id,input:[{type:"text",text:"FIRST QUEUED EDITED"}]});
    await rpc.request("thread/queue/reorder",{threadId:thread.id,queuedSubmissionIds:[q2.id,q1.id]});
    let queued=(await rpc.request("thread/queue/list",{threadId:thread.id,limit:10})).data;assert.deepEqual(queued.map(item=>item.id),[q2.id,q1.id]);assert.match(JSON.stringify(queued[1].input),/FIRST QUEUED EDITED/);
    releaseFirstResolve();await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===initial.id);
    for(let attempt=0;attempt<100;attempt++){
      const current=threadStore.get(thread.id),remaining=(state.threadMeta(thread.id)?.queuedSubmissions||[]).length;
      if(current.turns.length===3&&current.turns.every(turn=>turn.status==="completed")&&remaining===0)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const final=threadStore.get(thread.id);assert.equal(final.turns.length,3);assert.ok(final.turns.every(turn=>turn.status==="completed"));assert.equal((state.threadMeta(thread.id)?.queuedSubmissions||[]).length,0);assert.equal(prompts.length,3);
    assert.match(prompts[0],/INITIAL TURN/);assert.match(prompts[1],/SECOND QUEUED/);assert.match(prompts[2],/FIRST QUEUED EDITED/);
    assert.equal((await rpc.request("thread/queue/list",{threadId:thread.id,limit:10})).data.length,0);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
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
    }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
  }
});

test("Trebell Native background processes outlive the turn and stay thread-owned",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-background-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home,NATIVE_BACKGROUND_RELAY_SECRET:"must-stay-hidden"},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);let calls=0;
  const nativeProviderTurn=async request=>{
    calls++;
    if(calls===1)return{id:"background-tool",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"background-1",namespace:"trebell_terminal",name:"start_background",arguments:JSON.stringify({command:process.execPath,args:["-e","process.stdout.write(process.env.NATIVE_BACKGROUND_RELAY_SECRET||'SAFE');setInterval(()=>{},1000)"],cwd:".",max_output_bytes:8192})}],finishReason:"tool_calls",usage:{}};
    assert.equal(request.messages.at(-1).role,"tool");assert.match(request.messages.at(-1).content,/processId/);return{id:"background-answer",provider:request.provider,model:request.model,text:"Server is running in the background.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=client(ws);
  try{
    const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    const turn=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile:"auto",input:[{type:"text",text:"Start the dev server in the background"}]})).turn;await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);
    const listed=await rpc.request("thread/backgroundTerminals/list",{threadId:thread.id,limit:10});assert.equal(listed.data.length,1);const processItem=listed.data[0];assert.equal(processItem.running,true);assert.match(processItem.command,/node|electron/i);assert.equal(processItem.cwd,repo);
    const sibling=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"auto",dynamicTools:[]})).thread;
    assert.equal((await rpc.request("thread/backgroundTerminals/list",{threadId:sibling.id,limit:10})).data.length,0);await assert.rejects(()=>rpc.request("thread/backgroundTerminals/terminate",{threadId:sibling.id,processId:processItem.processId}),/not found/i);
    const stopped=await rpc.request("thread/backgroundTerminals/terminate",{threadId:thread.id,processId:processItem.processId});assert.equal(stopped.process.running,false);assert.doesNotMatch(stopped.process.stdout,/must-stay-hidden/);assert.equal((await rpc.request("thread/backgroundTerminals/list",{threadId:thread.id,limit:10})).data.length,0);
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
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
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
});
