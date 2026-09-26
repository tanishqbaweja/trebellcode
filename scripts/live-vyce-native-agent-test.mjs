import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ContextEngine } from "../src/context-engine.mjs";
import { EventJournal } from "../src/event-journal.mjs";
import { createLiveSmokeGuard } from "../src/live-smoke-policy.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { repositoryContextEntries } from "../ui/src/context-provenance.js";

const execFileAsync=promisify(execFile);
const requestedModel=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim();
const guard=createLiveSmokeGuard({provider:"vyceai",model:requestedModel,runtime:"native",maxTurns:2,timeoutMs:240_000});

function rpcClient(ws){
  let nextId=0;const pending=new Map(),notifications=[],waiters=[];
  ws.on("message",raw=>{
    let message;try{message=JSON.parse(String(raw))}catch{return}
    if(message.id!=null&&pending.has(message.id)){
      const target=pending.get(message.id);pending.delete(message.id);clearTimeout(target.timer);
      if(message.error)target.reject(new Error(message.error.message||JSON.stringify(message.error)));
      else target.resolve(message.result);
      return;
    }
    if(message.id!=null&&message.method){
      const method=String(message.method||"");
      let result=null;
      if(method.includes("requestApproval")||method==="applyPatchApproval"||method==="execCommandApproval")result={decision:"accept"};
      else if(method==="item/tool/requestUserInput")result={answers:{}};
      ws.send(JSON.stringify({id:message.id,result}));
      return;
    }
    if(message.method){
      notifications.push(message);
      for(let index=waiters.length-1;index>=0;index--){
        const waiter=waiters[index];
        if(!waiter.predicate(message))continue;
        waiters.splice(index,1);clearTimeout(waiter.timer);waiter.resolve(message);
      }
    }
  });
  return {
    request(method,params={}){
      return new Promise((resolve,reject)=>{
        const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+" timed out"))},180_000);
        pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
      });
    },
    waitFor(predicate,timeoutMs=180_000){
      const existing=notifications.find(predicate);if(existing)return Promise.resolve(existing);
      return new Promise((resolve,reject)=>{
        const waiter={predicate,resolve,reject,timer:setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error("Timed out waiting for relay notification"))},timeoutMs)};
        waiters.push(waiter);
      });
    },
  };
}

async function listen(server){
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  return server.address().port;
}

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the live Native Vyce validation.");

const root=await mkdtemp(join(tmpdir(),"trebell-native-vyce-live-")),home=join(root,"home"),workspace=join(root,"workspace");
await mkdir(workspace,{recursive:true});
await writeFile(join(workspace,"math.mjs"),"export function add(a,b){\n  return a-b;\n}\n","utf8");
await writeFile(join(workspace,"verify.mjs"),[
  'import { add } from "./math.mjs";',
  'if(add(2,3)!==5) throw new Error("add(2,3) failed");',
  'if(add(-2,5)!==3) throw new Error("add(-2,5) failed");',
  'console.log("LIVE_NATIVE_TEST_PASS");',
  "",
].join("\n"),"utf8");
await writeFile(join(workspace,"TASK.md"),[
  "# Validation task",
  "",
  "The add(a,b) implementation in math.mjs is wrong.",
  "Fix the implementation without changing its public API.",
  "Validate the fix by running: node verify.mjs",
  "",
].join("\n"),"utf8");

const env={...process.env,TREBELL_HOME:home,VYCEAI_API_KEY:apiKey};
const state=new TrebellStateStore(env);
state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"vyceai",activeEnvironmentId:null});
const providers=new ProviderManager({env}),catalog=await providers.models("vyceai");
const model=catalog.models.includes(requestedModel)?requestedModel:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the live Native validation.");

const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),contextEngine=new ContextEngine(),journal=new EventJournal(env);
const providerRequests=[];
const nativeProviderTurn=async request=>{
  const messages=Array.isArray(request.messages)?request.messages:[];
  const tools=Array.isArray(request.tools)?request.tools:[],namespaces=tools.map(item=>String(item?.name||"")).filter(Boolean);
  const record={
    provider:String(request.provider||""),
    model:String(request.model||""),
    roles:messages.map(item=>item?.role||null),
    system:String(messages.find(item=>item?.role==="system")?.content||""),
    namespaces,
    repoToolNames:(tools.find(item=>item?.name==="trebell_repo")?.tools||[]).map(item=>String(item?.name||"")).filter(Boolean),
    messageChars:JSON.stringify(messages).length,
    toolSchemaChars:JSON.stringify(tools).length,
    functionCount:tools.reduce((sum,item)=>sum+(Array.isArray(item?.tools)?item.tools.length:1),0),
    requestMetrics:nativeRequestMetrics(messages,tools),
  };
  providerRequests.push(record);
  const response=await providers.turn("vyceai",{...request,provider:"vyceai",model},{signal:request.signal});
  record.usage=response?.usage||null;
  record.rawUsage=response?.raw?.usage||null;
  record.telemetry=response?.telemetry||null;
  record.returnedToolCalls=Array.isArray(response?.toolCalls)?response.toolCalls.map(call=>String(call?.namespace||"")+"/"+String(call?.name||"")):[];
  record.finishReason=response?.finishReason||null;
  return response;
};

const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine,nativeProviderTurn,journal,version:"live-native-vyce"});
const port=await listen(server),ws=new WebSocket("ws://127.0.0.1:"+port+"/api/agent/ws");
await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
const rpc=rpcClient(ws);

try{
  const started=await rpc.request("thread/start",{
    model,modelProvider:"vyceai",cwd:workspace,projectless:false,
    permissionProfile:"full",approvalPolicy:"never",sandbox:"danger-full-access",dynamicTools:[],
  });
  const threadId=started.thread?.id;
  assert.ok(threadId,"thread/start must return a Native thread id");
  assert.equal(started.thread.runtime,"native");
  assert.match(String(started.thread.providerSessionId||""),/^native_/);

  const prompt=[
    "Complete the coding task in TASK.md.",
    "Use the Trebell Native tools as needed to inspect the relevant files, fix the bug, and run the requested verification command.",
    "Do not merely explain the fix.",
    "When the command passes, reply with LIVE_NATIVE_DONE and a concise summary of what you changed.",
  ].join("\n");
  const contextPacket=await contextEngine.buildPacket({root:workspace,task:prompt,focusPaths:["TASK.md"]});
  const additionalContext=repositoryContextEntries(contextPacket,{seedOnly:true});
  guard.consumeTurn("Trebell Native real-provider coding turn");
  const turn=await guard.withTimeout(rpc.request("turn/start",{
    threadId,model,modelProvider:"vyceai",permissionProfile:"full",
    approvalPolicy:"never",sandboxPolicy:{type:"dangerFullAccess"},
    input:[{type:"text",text:prompt}],
    additionalContext,
  }),"Trebell Native turn/start");
  const turnId=turn.turn?.id;assert.ok(turnId,"turn/start must return a turn id");
  await guard.withTimeout(rpc.waitFor(message=>message.method==="turn/completed"&&(message.params?.turn?.id===turnId||message.params?.turnId===turnId),180_000),"Trebell Native turn completion");

  assert.ok(providerRequests.length>=2,"expected a real multi-step Native provider/tool loop");
  const first=providerRequests[0];
  assert.equal(first.provider,"vyceai");
  assert.equal(first.roles[0],"system");
  assert.match(first.system,/You are Trebell Native/);
  assert.match(first.system,/autonomous software-engineering agent/i);
  assert.ok(first.namespaces.includes("trebell_workspace"),"Native provider request must expose workspace tools");
  assert.ok(first.namespaces.includes("trebell_terminal"),"Native provider request must expose terminal tools");
  assert.ok(first.namespaces.includes("trebell_repo"),"Native provider request must expose repository tools");
  assert.ok(first.repoToolNames.includes("discover"),"Native provider request must expose progressive repository discovery");

  const thread=threadStore.get(threadId),items=(thread?.turns||[]).flatMap(item=>item.items||[]);
  const dynamicItems=items.filter(item=>item.type==="dynamicToolCall");
  const toolCalls=dynamicItems.map(item=>String(item.namespace||"")+"/"+String(item.tool||""));
  const toolDetails=dynamicItems.map(item=>({
    tool:String(item.namespace||"")+"/"+String(item.tool||""),
    arguments:item.arguments&&typeof item.arguments==="object"?item.arguments:{},
    status:item.status||null,
    success:item.success??null,
  }));
  const {stdout}=await execFileAsync(process.execPath,["verify.mjs"],{cwd:workspace,timeout:30_000,windowsHide:true});
  assert.match(stdout,/LIVE_NATIVE_TEST_PASS/);
  const math=await readFile(join(workspace,"math.mjs"),"utf8");
  assert.match(math,/return\s+a\s*\+\s*b/);
  const assistant=items.filter(item=>item.type==="agentMessage").map(item=>String(item.text||"")).join("\n");
  const aggregateUsage=providerRequests.reduce((total,request)=>{
    const usage=request.usage||{};
    total.inputTokens+=Number(usage.inputTokens||0);
    total.outputTokens+=Number(usage.outputTokens||0);
    total.totalTokens+=Number(usage.totalTokens||0);
    total.cachedInputTokens+=Number(usage.cachedInputTokens||0);
    total.cacheWriteInputTokens+=Number(usage.cacheWriteInputTokens||0);
    total.reasoningOutputTokens+=Number(usage.reasoningOutputTokens||0);
    return total;
  },{inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0});
  const trace=journal.list({threadId,limit:500}).reverse(),modelTrace=trace.filter(event=>event.name==="native.model.requested"||event.name==="native.model.completed");
  const completedTrace=modelTrace.filter(event=>event.name==="native.model.completed");
  const distinctStablePrefixes=[...new Set(completedTrace.map(event=>event.data?.requestMetrics?.stablePrefixHash).filter(Boolean))];
  const distinctToolSchemas=[...new Set(completedTrace.map(event=>event.data?.requestMetrics?.toolSchemaHash).filter(Boolean))];
  const report={
    ok:true,
    runtime:"native",
    provider:"vyceai",
    model,
    codexAppServerStarted:false,
    providerTransport:"ProviderManager.turn -> Vyce /v1/chat/completions",
    providerRequests:providerRequests.length,
    modelTurns:thread?.turns?.find(item=>item.id===turnId)?.modelTurns||providerRequests.length,
    firstRequestSystemChars:first.system.length,
    firstRequestMessageChars:first.messageChars,
    firstRequestToolSchemaChars:first.toolSchemaChars,
    firstRequestFunctionCount:first.functionCount,
    aggregateUsage,
    cacheHitPercent:aggregateUsage.inputTokens>0?Number(((aggregateUsage.cachedInputTokens/aggregateUsage.inputTokens)*100).toFixed(2)):0,
    stablePrefixVariants:distinctStablePrefixes.length,
    toolSchemaVariants:distinctToolSchemas.length,
    liveInferenceTrace:completedTrace.map(event=>({
      inferenceId:event.data?.inferenceId||null,
      modelTurn:event.data?.modelTurn||null,
      stablePrefixHash:event.data?.requestMetrics?.stablePrefixHash||null,
      toolSchemaHash:event.data?.requestMetrics?.toolSchemaHash||null,
      systemEstimatedTokens:event.data?.requestMetrics?.system?.estimatedTokens||0,
      developerEstimatedTokens:event.data?.requestMetrics?.developer?.estimatedTokens||0,
      currentUserEstimatedTokens:event.data?.requestMetrics?.currentUser?.estimatedTokens||0,
      workingContextEstimatedTokens:event.data?.requestMetrics?.workingContext?.estimatedTokens||0,
      conversationHistoryEstimatedTokens:event.data?.requestMetrics?.conversationHistory?.estimatedTokens||0,
      toolResultEstimatedTokens:event.data?.requestMetrics?.toolResults?.estimatedTokens||0,
      compactedContextEstimatedTokens:event.data?.requestMetrics?.compactedContext?.estimatedTokens||0,
      toolSchemaEstimatedTokens:event.data?.requestMetrics?.toolSchemas?.estimatedTokens||0,
      logicalEstimatedTokens:event.data?.requestMetrics?.totalLogical?.estimatedTokens||0,
      requestBytes:event.data?.providerTelemetry?.requestBytes||0,
      responseBytes:event.data?.providerTelemetry?.responseBytes||0,
      totalLatencyMs:event.data?.providerTelemetry?.totalLatencyMs??null,
      cacheHitPercent:event.data?.cacheHitPercent??0,
      usage:event.data?.usage||null,
      providerEndpoint:event.data?.providerTelemetry?.endpoint||null,
      wireApi:event.data?.providerTelemetry?.wireApi||null,
    })),
    providerRequestSummary:providerRequests.map((request,index)=>({
      index:index+1,
      messageChars:request.messageChars,
      toolSchemaChars:request.toolSchemaChars,
      functionCount:request.functionCount,
      stablePrefixHash:request.requestMetrics?.stablePrefixHash||null,
      toolSchemaHash:request.requestMetrics?.toolSchemaHash||null,
      systemEstimatedTokens:request.requestMetrics?.system?.estimatedTokens||0,
      toolSchemaEstimatedTokens:request.requestMetrics?.toolSchemas?.estimatedTokens||0,
      historyEstimatedTokens:request.requestMetrics?.conversationHistory?.estimatedTokens||0,
      currentUserEstimatedTokens:request.requestMetrics?.currentUser?.estimatedTokens||0,
      workingContextEstimatedTokens:request.requestMetrics?.workingContext?.estimatedTokens||0,
      toolResultEstimatedTokens:request.requestMetrics?.toolResults?.estimatedTokens||0,
      compactedContextEstimatedTokens:request.requestMetrics?.compactedContext?.estimatedTokens||0,
      logicalEstimatedTokens:request.requestMetrics?.totalLogical?.estimatedTokens||0,
      requestBytes:request.telemetry?.requestBytes||0,
      responseBytes:request.telemetry?.responseBytes||0,
      totalLatencyMs:request.telemetry?.totalLatencyMs??null,
      providerRequestId:request.telemetry?.providerRequestId||null,
      providerResponseId:request.telemetry?.providerResponseId||null,
      returnedToolCalls:request.returnedToolCalls,
      finishReason:request.finishReason,
      usage:request.usage,
      rawUsage:request.rawUsage,
    })),
    firstRequestRoles:first.roles,
    firstRequestNamespaces:first.namespaces,
    firstRequestRepoTools:first.repoToolNames,
    nativeToolCalls:toolCalls,
    nativeToolDetails:toolDetails,
    independentVerification:"LIVE_NATIVE_TEST_PASS",
    finalAssistantChars:assistant.length,
    finalAssistantIncludedDoneMarker:/LIVE_NATIVE_DONE/.test(assistant),
    usedRepositoryIntelligence:toolCalls.some(name=>name.startsWith("trebell_repo/")),
    usedWorkspaceEdit:toolCalls.some(name=>name==="trebell_workspace/replace_text"||name==="trebell_workspace/write_file"),
    usedTerminalVerification:toolCalls.includes("trebell_terminal/run"),
    fingerprint:guard.fingerprint(),
  };
  console.log(JSON.stringify(report,null,2));
  assert.ok(toolCalls.some(name=>name==="trebell_workspace/read_file"||name==="trebell_repo/read_source"||name==="trebell_repo/search_code"),"real model must inspect source through Native tools");
  assert.equal(report.usedWorkspaceEdit,true,"real model must edit the file through Native workspace tools");
  assert.equal(report.usedTerminalVerification,true,"real model must execute verification through the Native terminal tool");
  assert.match(assistant,/LIVE_NATIVE_DONE/,"real Native run completed the coding work but did not persist the requested final assistant response");
}finally{
  try{ws.close()}catch{}
  await relay.close().catch(()=>{});
  await new Promise(resolve=>server.close(()=>resolve()));
  await journal.close().catch(()=>{});
  await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
}
