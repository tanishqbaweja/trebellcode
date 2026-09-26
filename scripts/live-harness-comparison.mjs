import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { AcpAgentSession } from "../src/acp-agent-session.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { contextualAgentPrompt } from "../src/agent-relay.mjs";
import { ContextEngine } from "../src/context-engine.mjs";
import { createGuiServer } from "../src/gui-server.mjs";
import { createNativeBuiltins } from "../src/native-builtins.mjs";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { NativeToolOutputStore } from "../src/native-tool-output-store.mjs";
import { createNativeToolExecutor } from "../src/native-tool-executor.mjs";
import { OpenCodeAgentSession } from "../src/opencode-agent-session.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { repositoryDynamicToolNamespace, searchRepositoryToolDefinitions } from "../src/repository-tool-catalog.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { TerminalManager } from "../src/terminal-manager.mjs";
import { repositoryContextEntries } from "../ui/src/context-provenance.js";

if(!process.argv.includes("--live"))throw new Error("Refusing to run paid/live harness comparison without --live");

const execFileAsync=promisify(execFile);
const requested=new Set(String(process.env.TREBELL_HARNESS_COMPARE_ONLY||"").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean));
const wants=kind=>!requested.size||requested.has(kind);
const TASK=[
  "Fix the coding task in TASK.md.",
  "Inspect the relevant files, make the smallest correct edit, and run node verify.mjs.",
  "Do not edit verify.mjs. Do not merely explain the fix.",
  "When verification passes, give a concise summary.",
].join("\n");

async function within(promise,ms,label){
  let timer;try{return await Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out after ${ms}ms`)),ms)})])}
  finally{if(timer)clearTimeout(timer)}
}
async function fixture(prefix){
  const root=await mkdtemp(join(tmpdir(),prefix));
  await mkdir(join(root,"src"),{recursive:true});
  await writeFile(join(root,"src","math.mjs"),'export function add(a,b){ return a-b; }\n',"utf8");
  await writeFile(join(root,"verify.mjs"),[
    'import { add } from "./src/math.mjs";',
    'if(add(2,3)!==5) throw new Error("add(2,3) failed");',
    'if(add(-2,5)!==3) throw new Error("add(-2,5) failed");',
    'console.log("TREBELL_HARNESS_COMPARE_PASS");',
    "",
  ].join("\n"),"utf8");
  await writeFile(join(root,"TASK.md"),[
    "# Bug fix",
    "",
    "The exported add(a,b) implementation in src/math.mjs is wrong.",
    "Fix only the implementation while preserving the public API.",
    "Do not modify verify.mjs.",
    "Run: node verify.mjs",
    "",
  ].join("\n"),"utf8");
  return root;
}
async function verify(root){
  const {stdout}=await execFileAsync(process.execPath,["verify.mjs"],{cwd:root,timeout:30_000,windowsHide:true,maxBuffer:1024*1024});
  assert.match(stdout,/TREBELL_HARNESS_COMPARE_PASS/);
  assert.match(await readFile(join(root,"src","math.mjs"),"utf8"),/return\s+a\s*\+\s*b/);
  return true;
}
function textCollector(updates){
  return payload=>{
    updates.push(payload);const update=payload?.update||payload;
    if(update?.sessionUpdate==="agent_message_chunk"&&update?.content?.text)return String(update.content.text);
    return "";
  };
}
function toolUpdateCount(updates){return updates.filter(payload=>/tool/i.test(String((payload?.update||payload)?.sessionUpdate||""))).length}

const baseState=new TrebellStateStore(process.env),runtimeManager=new AgentRuntimeManager({state:baseState,env:process.env});
const runtimeSnapshot=await runtimeManager.snapshot(),statusByKind=new Map(runtimeSnapshot.statuses.map(status=>[status.kind,status]));

async function runNative(){
  const provider="vyceai",manager=new ProviderManager({env:process.env});
  if(!manager.status(provider).hasKey)return {kind:"native",skipped:true,reason:"VyceAi API key is not configured"};
  const catalog=await within(manager.models(provider),30_000,"Native model discovery"),preferred=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(preferred)?preferred:catalog.models[0];
  if(!model)return {kind:"native",skipped:true,reason:"VyceAi exposed no model"};
  const root=await fixture("trebell-harness-native-"),updates=[],requests=[];
  try{
    const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,browser:false,computer:false,sourceControl:false,delegation:false});
    const outputStore=new NativeToolOutputStore({directory:join(root,".trebell-output"),environment:process.env});
    const contextEngine=new ContextEngine(),builtins=createNativeBuiltins({root,environment:process.env});
    const discoverRepositoryTools=({query,limit=8}={})=>{
      const exposed=(tools.find(item=>item?.name==="trebell_repo")?.tools||[]).map(item=>item.name),matches=searchRepositoryToolDefinitions({query,limit,exclude:exposed});
      const capabilities=matches.map(item=>{const [ns]=repositoryDynamicToolNamespace({names:[item.name],includeDiscovery:false}),tool=ns?.tools?.[0];return {name:item.name,description:item.description,inputSchema:tool?.inputSchema||{type:"object",properties:{}}}});
      return {success:true,query:String(query||""),capabilities,instruction:capabilities.length?"Call trebell_repo/invoke with one returned capability name and matching arguments.":"No matching advanced capability."};
    };
    const executor=createNativeToolExecutor({contextEngine,root,repository:true,discoverRepositoryTools,outputStore,environment:process.env,policyContext:{permissionProfile:"full",runtime:"native",workspace:root,projectAvailable:true},executeShared:call=>{
      if(["trebell_workspace","trebell_terminal"].includes(call.namespace))return builtins(call);throw new Error("Unsupported comparison tool: "+call.namespace+"/"+call.name);
    }});
    const session=new NativeAgentSession({cwd:root,provider,model,tools,toolOutputStore:outputStore,executeTool:executor,initialMessages:[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})}],providerTurn:async request=>{
      const response=await manager.turn(provider,{...request,provider,model},{signal:request.signal});requests.push({usage:response.usage||{},telemetry:response.telemetry||{}});return response;
    },onUpdate:update=>updates.push(update)});
    await session.start({providerSessionId:"harness-compare-native",model});
    const packet=await contextEngine.buildPacket({root,task:TASK,focusPaths:["TASK.md"]}),prompt=await contextualAgentPrompt([{type:"text",text:TASK}],repositoryContextEntries(packet,{seedOnly:true}));
    const started=performance.now(),result=await within(session.prompt(prompt,{maxModelTurns:10,maxToolCalls:40,maxWallTimeMs:180_000}),190_000,"Native comparison task"),elapsedMs=Math.round(performance.now()-started);
    await verify(root);
    const usage=requests.reduce((out,item)=>{out.inputTokens+=Number(item.usage.inputTokens||0);out.outputTokens+=Number(item.usage.outputTokens||0);out.cachedInputTokens+=Number(item.usage.cachedInputTokens||0);out.cacheWriteInputTokens+=Number(item.usage.cacheWriteInputTokens||0);return out},{inputTokens:0,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0});
    return {kind:"native",ok:true,provider,model,elapsedMs,modelTurns:requests.length,toolCalls:toolUpdateCount(updates),usage,stopReason:result?.stopReason||null,independentVerification:true};
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{})}
}

async function runAcp(kind){
  const status=statusByKind.get(kind);if(!status?.available)return {kind,skipped:true,reason:status?.message||"runtime unavailable"};
  const instance=runtimeManager.instances().find(item=>item.kind===kind),root=await fixture(`trebell-harness-${kind}-`),terminals=new TerminalManager({persist:false}),updates=[],chunks=[];
  const collect=textCollector(updates),command=runtimeManager.executable(instance),session=new AcpAgentSession({runtime:kind,command,args:runtimeManager.acpArgs(instance,"full",root),cwd:root,processCwd:kind==="antigravity"?dirname(command):null,env:runtimeManager.childEnv(instance),terminals,permissionMode:"full",onPermission:async()=>"acceptForSession",onElicitation:async()=>({action:"cancel"}),onUpdate:payload=>{const text=collect(payload);if(text)chunks.push(text)}});
  try{
    const setup=await within(session.start(),kind==="antigravity"?90_000:45_000,kind+" start"),started=performance.now();
    const result=await within(session.prompt([{type:"text",text:TASK}]),150_000,kind+" comparison task"),elapsedMs=Math.round(performance.now()-started);await verify(root);
    return {kind,ok:true,model:setup.session?.models?.currentModelId||null,modelCount:setup.session?.models?.availableModels?.length||0,version:setup.initialize?.agentInfo?.version||status.version||null,elapsedMs,toolUpdates:toolUpdateCount(updates),stopReason:result?.stopReason||null,reply:chunks.join("").trim().slice(-300),independentVerification:true};
  }finally{await session.close().catch(()=>{});await terminals.shutdown().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{})}
}

async function runOpenCode(){
  const kind="opencode",status=statusByKind.get(kind);if(!status?.available)return {kind,skipped:true,reason:status?.message||"runtime unavailable"};
  const instance=runtimeManager.instances().find(item=>item.kind===kind),catalog=await within(runtimeManager.models(instance),30_000,"OpenCode models"),requestedModel=String(process.env.TREBELL_OPENCODE_SMOKE_MODEL||"").trim(),preferredFree="opencode/muse-spark-1.3-contributor-free",free=catalog.models.find(id=>id.startsWith("opencode/")&&id.endsWith("-free")),model=requestedModel||(catalog.models.includes(preferredFree)?preferredFree:null)||free||catalog.preferred||catalog.models[0];
  if(!model)return {kind,skipped:true,reason:"OpenCode exposed no connected model"};
  const root=await fixture("trebell-harness-opencode-"),updates=[],chunks=[],collect=textCollector(updates),session=new OpenCodeAgentSession({command:runtimeManager.executable(instance),cwd:root,env:runtimeManager.childEnv(instance),permissionMode:"full",onPermission:async()=>"acceptForSession",onUpdate:payload=>{const text=collect(payload);if(text)chunks.push(text)}});
  try{
    const setup=await within(session.start({model}),30_000,"OpenCode start"),started=performance.now(),result=await within(session.prompt([{type:"text",text:TASK}]),150_000,"OpenCode comparison task"),elapsedMs=Math.round(performance.now()-started);await verify(root);
    return {kind,ok:true,model:setup.session?.models?.currentModelId||model,modelCount:setup.session?.models?.availableModels?.length||catalog.models.length,version:status.version||null,elapsedMs,toolUpdates:toolUpdateCount(updates),stopReason:result?.stopReason||null,reply:chunks.join("").trim().slice(-300),independentVerification:true};
  }finally{await session.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{})}
}

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
function relayRpc(ws){
  let nextId=0;const pending=new Map(),notifications=[];
  ws.on("message",raw=>{let message;try{message=JSON.parse(String(raw))}catch{return}
    if(message.id!=null&&pending.has(message.id)){const entry=pending.get(message.id);pending.delete(message.id);clearTimeout(entry.timer);return message.error?entry.reject(new Error(message.error.message||"RPC failed")):entry.resolve(message.result)}
    if(message.id!=null&&message.method){ws.send(JSON.stringify({id:message.id,error:{code:-32601,message:"Unsupported comparison client request: "+message.method}}));return}
    if(message.method)notifications.push(message);
  });
  return {
    request(method,params={}){return new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+" timed out"))},180_000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})},
    async waitFor(predicate,timeoutMs=180_000){const started=Date.now();for(;;){const hit=notifications.find(predicate);if(hit)return hit;if(Date.now()-started>timeoutMs)throw new Error("Timed out waiting for Codex completion");await new Promise(resolve=>setTimeout(resolve,50))}},
  };
}
async function runCodex(){
  const base=await mkdtemp(join(tmpdir(),"trebell-harness-codex-")),root=join(base,"workspace"),home=join(base,"trebell"),codexHome=join(base,"codex");let gui=null,ws=null;
  try{
    await Promise.all([mkdir(root,{recursive:true}),mkdir(home,{recursive:true}),mkdir(codexHome,{recursive:true})]);
    const sourceHome=String(process.env.CODEX_HOME||"").trim()||join(homedir(),".codex");try{await copyFile(join(sourceHome,"auth.json"),join(codexHome,"auth.json"))}catch{return {kind:"codex",skipped:true,reason:"Codex login is not available"}}
    await writeFile(join(root,"src-placeholder"),"", "utf8").catch(()=>{});await rm(join(root,"src-placeholder"),{force:true});await mkdir(join(root,"src"),{recursive:true});
    await writeFile(join(root,"src","math.mjs"),'export function add(a,b){ return a-b; }\n');await writeFile(join(root,"verify.mjs"),'import { add } from "./src/math.mjs";\nif(add(2,3)!==5) throw new Error("add(2,3) failed");\nif(add(-2,5)!==3) throw new Error("add(-2,5) failed");\nconsole.log("TREBELL_HARNESS_COMPARE_PASS");\n');await writeFile(join(root,"TASK.md"),'# Bug fix\n\nThe exported add(a,b) implementation in src/math.mjs is wrong.\nFix only the implementation while preserving the public API.\nDo not modify verify.mjs.\nRun: node verify.mjs\n');
    const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",agentRuntimeInstances:[{id:"codex-default",kind:"codex",displayName:"Codex",enabled:true,homePath:codexHome,shadowHomePath:"",environment:{}}]});
    const [port,appPort]=await Promise.all([freePort(),freePort()]);gui=await createGuiServer({port,appPort,mock:false,env});let boot=null;for(let i=0;i<100;i++){boot=await fetch(gui.url+"/api/bootstrap").then(response=>response.json());if(boot.appServerReady&&boot.agentRuntimeReady)break;await new Promise(resolve=>setTimeout(resolve,200))}if(!boot?.agentRuntimeReady)return {kind:"codex",skipped:true,reason:boot?.agentRuntimeStatus?.message||boot?.appServerError||"Codex unavailable"};
    const catalog=await fetch(gui.url+"/api/models").then(response=>response.json()),model=catalog.models?.[0];if(!model)throw new Error("Codex exposed no model");
    ws=new WebSocket(boot.wsUrl,{origin:gui.url});await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});const rpc=relayRpc(ws);await rpc.request("initialize",{clientInfo:{name:"trebell-harness-comparison",title:"Trebell Harness Comparison",version:"1.0.0"},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:"initialized",params:{}}));
    const thread=await rpc.request("thread/start",{cwd:root,model,approvalPolicy:"never",sandbox:"danger-full-access",ephemeral:true,threadSource:"trebell-harness-comparison"}),threadId=thread.thread?.id;if(!threadId)throw new Error("Codex did not create a comparison thread");const started=performance.now(),turn=await rpc.request("turn/start",{threadId,model,input:[{type:"text",text:TASK,textElements:[]}],turnTrigger:"trebell-harness-comparison"});const turnId=turn.turn?.id;if(!turnId)throw new Error("Codex did not start comparison turn");await rpc.waitFor(message=>message.method==="turn/completed"&&(message.params?.turn?.id===turnId||message.params?.turnId===turnId));const elapsedMs=Math.round(performance.now()-started);await verify(root);
    return {kind:"codex",ok:true,model,modelCount:catalog.models.length,elapsedMs,independentVerification:true};
  }finally{try{ws?.close()}catch{}await gui?.close?.().catch(()=>{});await rm(base,{recursive:true,force:true,maxRetries:20,retryDelay:100}).catch(()=>{})}
}

const runners={native:runNative,codex:runCodex,opencode:runOpenCode,antigravity:()=>runAcp("antigravity"),grok:()=>runAcp("grok")},results=[];
for(const kind of ["native","codex","opencode","antigravity","grok"]){
  if(!wants(kind))continue;try{results.push(await runners[kind]())}catch(error){results.push({kind,ok:false,error:error?.message||String(error)})}
}
for(const kind of ["claude","cursor"]){if(!wants(kind))continue;const status=statusByKind.get(kind);results.push({kind,skipped:true,reason:status?.message||"runtime unavailable"})}
const report={ok:results.filter(item=>!item.skipped).every(item=>item.ok),task:"fix-add-and-run-verification",results};
console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
