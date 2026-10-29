import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ContextEngine } from "../src/context-engine.mjs";
import { configuredModelServiceTier } from "../src/model-service-tier.mjs";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { createNativeToolExecutor } from "../src/native-tool-executor.mjs";
import { nativePromptBudgets } from "../src/native-configuration.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { RepositoryKnowledgeService } from "../src/repository-knowledge-service.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { auditNativeEventsText, auditTrialDirectory, summarizeIntegrityFindings } from "../scripts/benchmark-integrity-audit.mjs";
import { createHarborNativeRun } from "../benchmarks/harbor/native-harbor-run.mjs";

// Each default the app took from the benchmarked Native on 2026-10-29 (src/native-configuration.mjs), checked where a person meets it.

const SAFE_ENV=()=>{const env={};for(const key of ["PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","ComSpec","COMSPEC","WINDIR","TEMP","TMP","HOME","USERPROFILE"])if(process.env[key])env[key]=process.env[key];return env};
const workspaceTools=platformDynamicToolNamespaces({repository:false,output:false,workspaceTools:true,terminal:true,process:false,browser:false,computer:false,sourceControl:false,delegation:false});
const call=(id,name,args)=>({id,namespace:"trebell_workspace",name,arguments:JSON.stringify(args)});

test("a Native message that asks for a change sends no completion-gate request unless an experiment turns the gate on",async()=>{
  const requests=[];
  const session=new NativeAgentSession({
    provider:"fixture",model:"model-a",tools:workspaceTools,
    providerTurn:async request=>{
      requests.push(request);
      if(requests.length===1)return {id:"edit",text:"",toolCalls:[call("edit","replace_text",{path:"src/a.mjs",old_text:"i<end",new_text:"i<=end"})],usage:{}};
      return {id:"answer-"+requests.length,text:"Changed the loop condition in src/a.mjs so the end value is included.",toolCalls:[],usage:{}};
    },
    executeTool:async()=>({success:true,path:"src/a.mjs",replacements:1}),
  });
  await session.start({providerSessionId:"no-gate",model:"model-a"});
  const result=await session.prompt([{type:"text",text:"Fix the off-by-one bug in src/a.mjs so range(1,3) includes 3."}]);
  assert.equal(session.semanticCompletionGate,false);
  assert.equal(result.stopReason,"end_turn");
  assert.equal(requests.filter(request=>request.metadata?.completionGate===true).length,0,"no gate request");
  assert.equal(requests.length,2,"the edit and the answer");
});

test("a Native message runs past 24 model turns and gets its turn-budget checkpoint at turn 36 of 500",async()=>{
  const events=[];let calls=0;
  const session=new NativeAgentSession({
    provider:"fixture",model:"model-a",tools:workspaceTools,onEvent:event=>events.push(event),
    providerTurn:async()=>{
      calls++;
      if(calls<=40)return {id:"read-"+calls,text:"",toolCalls:[call("read-"+calls,"read_file",{path:`notes/part-${calls}.txt`})],usage:{}};
      return {id:"answer",text:"Read all forty parts; the summary is in the last one.",toolCalls:[],usage:{}};
    },
    executeTool:async request=>({path:JSON.parse(request.arguments).path,content:"part "+request.id+"\n",size:12}),
  });
  await session.start({providerSessionId:"budgets",model:"model-a"});
  // No budget options: the session's defaults are the shared ceilings, as the relay's are (nativePromptBudgets).
  const result=await session.prompt([{type:"text",text:"Read every notes/part-N.txt file one by one and summarize them."}]);
  assert.equal(result.stopReason,"end_turn");
  assert.equal(result.raw.modelTurns,41);
  const checkpoint=events.find(event=>event.name==="native.progress.turn_budget_checkpoint");
  assert.ok(checkpoint,"the turn-budget checkpoint fires");assert.equal(checkpoint.data.modelTurn,36);assert.equal(checkpoint.data.maxModelTurns,500);
  // A goal's remaining budgets lower the ceilings and never raise them.
  assert.deepEqual(nativePromptBudgets(null),{maxModelTurns:500,maxToolCalls:5000,maxWallTimeMs:null});
  assert.deepEqual(nativePromptBudgets({turnBudgetRemaining:7,toolCallBudget:30,toolCallsUsed:12,timeBudgetRemainingMinutes:2,tokenBudgetRemaining:900}),{maxModelTurns:7,maxToolCalls:18,maxWallTimeMs:120_000,maxOutputTokens:900});
  assert.deepEqual(nativePromptBudgets({turnBudgetRemaining:9999,toolCallBudget:99999}),{maxModelTurns:500,maxToolCalls:5000,maxWallTimeMs:null});
});

async function relayHarness(t,{model="gpt-6-luna",script}){
  const root=await mkdtemp(join(tmpdir(),"trebell-shared-defaults-")),home=join(root,"home"),repo=join(root,"repo");
  await mkdir(join(repo,"src"),{recursive:true});await writeFile(join(repo,"src","a.mjs"),"export const a=1;\n","utf8");
  execFileSync("git",["init","-q"],{cwd:repo,windowsHide:true,stdio:"ignore",env:SAFE_ENV()});
  const env={...SAFE_ENV(),TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),requests=[];
  const nativeProviderTurn=async request=>{requests.push(request);return script(request,requests.length)};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),repositoryKnowledge:new RepositoryKnowledgeService({state}),nativeProviderTurn,nativeModelContextWindow:()=>null,version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  let id=0;const pending=new Map(),notifications=[];
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!=null&&pending.has(message.id)){const target=pending.get(message.id);pending.delete(message.id);message.error?target.reject(new Error(message.error.message)):target.resolve(message.result);return}if(message.method)notifications.push(message)});
  const request=(method,params={})=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}))});
  const waitFor=async predicate=>{const until=Date.now()+60_000;while(Date.now()<until){const found=notifications.find(predicate);if(found)return found;await new Promise(resolve=>setTimeout(resolve,20))}throw new Error("Timed out waiting for a relay notification")};
  t.after(async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  const thread=(await request("thread/start",{model,modelProvider:"openai",cwd:repo,projectless:false,approvalPolicy:"never",sandbox:"danger-full-access",dynamicTools:[]})).thread;
  const send=async text=>{const turn=(await request("turn/start",{threadId:thread.id,model,modelProvider:"openai",approvalPolicy:"never",sandboxPolicy:{type:"dangerFullAccess"},input:[{type:"text",text}]})).turn;await waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);return turn};
  return {state,thread,requests,notifications,send,repo};
}
const userText=request=>JSON.stringify(request.messages.findLast(message=>message.role==="user")?.content??"");

test("an app Native thread on gpt-6-luna has its measured window and server compaction, background processes, and no first-message continuity block",async t=>{
  const harness=await relayHarness(t,{script:(request,count)=>{
    if(count===1)return {id:"read",provider:"openai",model:request.model,text:"",toolCalls:[{id:"read-1",namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"src/a.mjs"}'}],usage:{inputTokens:130_000,outputTokens:10,totalTokens:130_010}};
    return {id:"answer-"+count,provider:"openai",model:request.model,text:"src/a.mjs exports a = 1.",toolCalls:[],usage:{inputTokens:131_000,outputTokens:12,totalTokens:131_012}};
  }});
  const {state,thread,requests,notifications,send}=harness;
  // The window's file checkpoint before the message, not yet linked to a turn.
  state.addCheckpoint({id:"pre-turn-1",threadId:thread.id,root:harness.repo,commit:"0123456789abcdef0123456789abcdef01234567",ref:"refs/trebell/checkpoints/pre-turn-1",label:"Explain src/a.mjs",environmentId:null});
  const first=await send("Explain src/a.mjs");
  assert.ok(requests[0].tools.some(namespace=>namespace.name==="trebell_process"),"background processes on a plain message");
  assert.equal(requests[0].contextManagement,undefined,"not armed before any input was seen");
  assert.deepEqual(requests[1].contextManagement,[{type:"compaction",compactThreshold:245_000}],"armed once an input reached half the threshold");
  assert.equal(requests[0].reasoningEffort,"max","gpt-6-luna's measured effort with no Thinking pick");
  assert.equal(requests[0].serviceTier??null,null,"no tier with no Speed pick");
  assert.doesNotMatch(userText(requests[0]),/trebell\.continuity/,"the pre-turn checkpoint is not restated as an artifact");
  const usage=notifications.find(message=>message.method==="thread/tokenUsage/updated"&&message.params?.turnId===first.id);
  assert.equal(usage.params.tokenUsage.modelContextWindow,272_000);
  // Linked to its turn, the checkpoint is part of the next message's continuity.
  state.updateCheckpoint("pre-turn-1",{turnId:first.id});
  await send("Now summarize it in one line");
  assert.match(userText(requests.at(-1)),/trebell\.continuity[\s\S]*Artifacts created[\s\S]*Explain src\/a\.mjs/);
  assert.deepEqual(requests.at(-1).contextManagement,[{type:"compaction",compactThreshold:245_000}],"stays armed");
});

test("an app Native thread on an unmeasured model keeps the catalog window, client read cooling and the provider's effort",async t=>{
  const harness=await relayHarness(t,{model:"gpt-5",script:(request,count)=>count===1
    ?{id:"read",provider:"openai",model:request.model,text:"",toolCalls:[{id:"read-1",namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"src/a.mjs"}'}],usage:{inputTokens:130_000,outputTokens:10,totalTokens:130_010}}
    :{id:"answer",provider:"openai",model:request.model,text:"Done.",toolCalls:[],usage:{inputTokens:1,outputTokens:1,totalTokens:2}}});
  await harness.send("Explain src/a.mjs");
  assert.equal(harness.requests.some(request=>request.contextManagement),false);
  assert.equal(harness.requests[0].reasoningEffort??null,null);
  assert.ok(harness.requests[0].tools.some(namespace=>namespace.name==="trebell_process"));
  assert.equal(configuredModelServiceTier({},"native","openai","gpt-5"),null);
});

test("a switch to a model without a measured threshold disarms server compaction, and switching back arms it again",async()=>{
  const requests=[];
  const session=new NativeAgentSession({
    provider:"openai",model:"gpt-6-luna",contextWindow:272_000,openAiServerCompactionThreshold:245_000,tools:workspaceTools,
    providerTurn:async request=>{requests.push(request);return {id:"r"+requests.length,text:"Done.",toolCalls:[],usage:{inputTokens:130_000,outputTokens:5,totalTokens:130_005}}},
    executeTool:async()=>({}),
  });
  await session.start({providerSessionId:"threshold",model:"gpt-6-luna"});
  const ask=()=>session.prompt([{type:"text",text:"Explain the loop. Do not change any files."}]);
  await ask();assert.equal(requests.at(-1).contextManagement,undefined,"not armed before an input was seen");
  await ask();assert.deepEqual(requests.at(-1).contextManagement,[{type:"compaction",compactThreshold:245_000}]);
  assert.deepEqual(session.setServerCompactionThreshold(null),{openAiServerCompactionThreshold:null});
  await ask();assert.equal(requests.at(-1).contextManagement,undefined,"disarmed with no threshold");
  session.setServerCompactionThreshold(245_000);
  await ask();assert.deepEqual(requests.at(-1).contextManagement,[{type:"compaction",compactThreshold:245_000}],"the largest input seen arms it again");
});

test("the runner's repository knowledge answers as the app's does for a fresh project",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-knowledge-")),repo=join(root,"repo");t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  await mkdir(repo,{recursive:true});await writeFile(join(repo,"a.mjs"),"export const a=1;\n","utf8");
  const run=await createHarborNativeRun({root:repo,instruction:"Explain a.mjs",manager:{status:()=>({hasKey:true}),close(){}},env:{...SAFE_ENV(),TREBELL_HOME:join(root,"home"),TREBELL_TOOL_OUTPUT_DIR:join(root,"out"),TREBELL_METRICS_PATH:join(root,"m.json"),TREBELL_EVENTS_PATH:join(root,"e.jsonl"),TREBELL_TOOL_CALLS_PATH:join(root,"t.jsonl"),TREBELL_FINAL_DIFF_PATH:join(root,"f.diff")}});
  const appExecutor=createNativeToolExecutor({contextEngine:new ContextEngine(),root:repo,repository:true,knowledgeService:new RepositoryKnowledgeService({state:new TrebellStateStore({...SAFE_ENV(),TREBELL_HOME:join(root,"app-home")})}),policyContext:{permissionProfile:"full",runtime:"native",workspace:repo,projectAvailable:true}});
  for(const name of ["knowledge_list","knowledge_context"]){
    const invoke={id:name,namespace:"trebell_repo",name:"invoke",arguments:{name,arguments:{}}};
    const runner=await run.executor(invoke),app=await appExecutor(invoke);
    assert.deepEqual(runner,app,name);
    assert.doesNotMatch(JSON.stringify(runner),/unavailable for this runtime/,name);
  }
  await run.session.close();
});

test("the integrity audit fails a lane that ran a benchmark switch and reviews source-control calls that reach a remote",async t=>{
  const events=[
    {name:"native.tool.requested",data:{toolCall:1,callId:"c1",namespace:"trebell_source_control",name:"status",arguments:{}}},
    {name:"native.tool.requested",data:{toolCall:2,callId:"c2",namespace:"trebell_source_control",name:"fetch",arguments:{remote:"origin"}}},
  ].map(row=>JSON.stringify(row)).join("\n");
  const findings=auditNativeEventsText(events,{file:"events.jsonl"});
  assert.deepEqual(findings.map(finding=>finding.kind),["source-control-network"]);
  assert.equal(summarizeIntegrityFindings(findings).status,"review");
  const trial=await mkdtemp(join(tmpdir(),"trebell-audit-trial-"));t.after(()=>rm(trial,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  await mkdir(join(trial,"agent"),{recursive:true});
  await writeFile(join(trial,"agent","trebell-native-events.jsonl"),"","utf8");
  await writeFile(join(trial,"agent","trebell-native-metrics.json"),JSON.stringify({experimentSwitches:{TREBELL_HARBOR_SEMANTIC_GATE:"1"},picksDifferFromShared:false,toolCalls:0}),"utf8");
  const audited=await auditTrialDirectory(trial);
  assert.equal(audited.summary.status,"invalid");assert.deepEqual(audited.summary.experimentSwitches,["TREBELL_HARBOR_SEMANTIC_GATE"]);
  await writeFile(join(trial,"agent","trebell-native-metrics.json"),JSON.stringify({experimentSwitches:{},picksDifferFromShared:false,toolCalls:0}),"utf8");
  assert.notEqual((await auditTrialDirectory(trial)).summary.status,"invalid","a lane with the shared configuration is not failed for it");
});
