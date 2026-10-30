import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ContextEngine } from "../src/context-engine.mjs";
import { repositoryContextDeliveryPacket, repositoryContextEntries } from "../src/context-provenance.mjs";
import { RepositoryKnowledgeService } from "../src/repository-knowledge-service.mjs";
import { configuredReasoningEffort } from "../src/model-reasoning-effort.mjs";
import { configuredModelServiceTier } from "../src/model-service-tier.mjs";
import { NATIVE_REPLY_STREAM, NativeAgentSession } from "../src/native-agent-session.mjs";
import * as nativeConfiguration from "../src/native-configuration.mjs";
import { NATIVE_CONTAINER_ONLY, NATIVE_RUN_SWITCHES, nativeHarborRunConfiguration, nativeTurnContextOptions, trebellDeveloperInstructions } from "../src/native-configuration.mjs";
import { nativeProviderTurn } from "../src/native-provider-turn.mjs";
import { NATIVE_PROMPT_PROVENANCE } from "../src/native-request-metrics.mjs";
import { OpenAiResponsesWebSocket } from "../src/openai-responses-websocket.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { sharedDynamicToolNamespaces } from "../src/shared-tool-catalog.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { contextTaskText } from "../ui/src/context-task.js";
import { specializedToolNamespaceNames, specializedToolSelection } from "../ui/src/lazy-tool-exposure.js";
import { createHarborNativeRun } from "../benchmarks/harbor/native-harbor-run.mjs";
import { functionCallItem, messageItem, reasoningItem, reply, scriptedTransport, usage } from "./fixtures/native-benchmark-path-harness.mjs";

// The owner's rule (2026-10-29): the Native the benchmark runner runs and the Native a person runs in the app are one program with
// one configuration (src/native-configuration.mjs). This builds both for the same task in the same repository, with the same scripted
// OpenAI replies under the real ProviderManager and OpenAiResponsesWebSocket (a fake key, no network), and compares what they hold and
// send: the session's settings, the loop's budgets, the tools, the system and developer text, the first user message with its
// provenance, every provider request and every byte on the wire. Only session identity (the thread's session id against the runner's
// "trebell-harbor") is normalized; the container-only differences (NATIVE_CONTAINER_ONLY) are the ones named below.

const MODEL="gpt-6-luna";
const PLAIN_TASK="Fix the off-by-one bug in src/range.mjs so range(1,3) includes 3.";
const SOURCE_CONTROL_TASK="Fix the off-by-one bug in src/range.mjs so range(1,3) includes 3, then commit the fix on a new branch for a pull request.";
const RANGE_SOURCE="export function range(start,end){\n  const out=[];\n  for(let i=start;i<end;i++)out.push(i);\n  return out;\n}\n";
const FINAL=["The loop in `src/range.mjs` stops before `end`, so `range(1,3)` returns `[1, 2]`.\n\n","Changing `i<end` to `i<=end` makes the end value inclusive."];
// A read, then an answer; spare answers so a controller turn on either side shows as a difference instead of a script error.
const SCRIPT=()=>({replies:[
  reply("ws","resp_p1",[reasoningItem(0,"rs_p1"),functionCallItem(1,"fc_p1","call_p1","trebell_workspace__read_file",'{"path":"src/range.mjs"}')],usage(2100,40,0,16)),
  reply("ws","resp_p2",[reasoningItem(0,"rs_p2"),messageItem(1,"msg_p2","final_answer",FINAL)],usage(2300,60,2048,16)),
  ...[3,4,5,6].map(n=>reply("ws","resp_p"+n,[reasoningItem(0,"rs_p"+n),messageItem(1,"msg_p"+n,"final_answer",FINAL)],usage(2400,60,2048,16))),
]});
const SAFE_ENV=()=>{const env={};for(const key of ["PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","ComSpec","COMSPEC","WINDIR","TEMP","TMP","HOME","USERPROFILE"])if(process.env[key])env[key]=process.env[key];return env};

async function fixtureRepo(){
  const root=await mkdtemp(join(tmpdir(),"trebell-one-config-")),repo=join(root,"repo");
  await mkdir(join(repo,"src"),{recursive:true});
  await writeFile(join(repo,"src","range.mjs"),RANGE_SOURCE,"utf8");
  await writeFile(join(repo,"package.json"),JSON.stringify({name:"range-fixture",type:"module",scripts:{test:"node --test"}},null,2)+"\n","utf8");
  const git=args=>execFileSync("git",args,{cwd:repo,windowsHide:true,stdio:"ignore",env:{...SAFE_ENV(),GIT_AUTHOR_NAME:"fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}});
  git(["init","-q"]);git(["add","-A"]);git(["commit","-qm","fixture"]);
  return {root,repo};
}

// Every NativeAgentSession that starts a message here is recorded with what it holds then.
const prompted=[];
const realPrompt=NativeAgentSession.prototype.prompt;
NativeAgentSession.prototype.prompt=function(prompt,options={}){prompted.push({session:this,prompt,options,messages:[...this.messages]});return realPrompt.call(this,prompt,options)};

function scriptedManager(record,env={}){
  const scripted=scriptedTransport(SCRIPT(),record);
  const manager=new ProviderManager({env:{OPENAI_API_KEY:"one-config-fixture-key",...env},fetchFn:scripted.fetchFn,openAiResponsesWebSocketFactory:options=>new OpenAiResponsesWebSocket({...options,WebSocketClass:scripted.RecordingSocket})});
  const turn=manager.turn.bind(manager);
  manager.turn=(provider,request,options={})=>{record.turns.push({provider,request,options});return turn(provider,request,options)};
  record.remaining=()=>scripted.remaining();
  return manager;
}
const newRecord=()=>({requestOrder:[],wsConnections:[],wsPayloads:[],fetches:[],turns:[]});

function rpcClient(ws){
  let id=0;const pending=new Map(),notifications=[],waiters=[];
  ws.on("message",raw=>{
    const message=JSON.parse(String(raw));
    if(message.id!=null&&pending.has(message.id)){const target=pending.get(message.id);pending.delete(message.id);message.error?target.reject(new Error(message.error.message)):target.resolve(message.result);return}
    if(message.method){notifications.push(message);for(let index=waiters.length-1;index>=0;index--){const waiter=waiters[index];if(waiter.predicate(message)){waiters.splice(index,1);clearTimeout(waiter.timer);waiter.resolve(message)}}}
  });
  return {
    request(method,params={}){return new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}))})},
    waitFor(predicate,timeoutMs=60_000){const found=notifications.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error("Timed out waiting for a relay notification"))},timeoutMs)};waiters.push(waiter)})},
  };
}

// The app's Native for a new thread in a project, built as the window builds it (ui/src/App.jsx createThreadFor and its send) over
// the real relay, with the person at Full access and no saved Thinking or Speed pick (settings can add some).
async function appSide({repo,home,task,settings={}}){
  const env={...SAFE_ENV(),TREBELL_HOME:home};
  const state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",activeEnvironmentId:null,...settings});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),contextEngine=new ContextEngine(),record=newRecord(),manager=scriptedManager(record);
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  // gui-server's nativeProviderTurn: the shared provider turn over the app's ProviderManager; OpenAI's catalog gives no window.
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine,repositoryKnowledge:new RepositoryKnowledgeService({state}),nativeProviderTurn:request=>nativeProviderTurn(manager,request,{provider:request.provider||"openai"}),nativeModelContextWindow:()=>null,version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  const rpc=rpcClient(ws),before=prompted.length;
  try{
    // createThreadFor: the tools the first message selects where the window has them (a project, Native's capabilities, no desktop
    // bridge in this process), and the developer text (Native's: webResearch is agentRuntime!=="native").
    const availability={browser:false,computer:false,sourceControl:true,delegation:true};
    const specialized=specializedToolSelection(task,availability);
    const started=await rpc.request("thread/start",{model:MODEL,modelProvider:"openai",cwd:repo,projectless:false,agent:null,approvalPolicy:"never",sandbox:"danger-full-access",ephemeral:false,threadSource:"trebell-code",dynamicTools:sharedDynamicToolNamespaces(specialized),developerInstructions:trebellDeveloperInstructions({projectless:false,dynamicTools:true,browser:specialized.browser,delegation:specialized.delegation,webResearch:false})});
    const threadId=started.thread.id;
    // The send: the window's file checkpoint before turn/start (linked to the turn only after it answers), the context packet as
    // /api/context/packet projects it and the window projects it again, the effort and tier the composer sends.
    state.addCheckpoint({id:"checkpoint-1",threadId,root:repo,commit:"0123456789abcdef0123456789abcdef01234567",ref:"refs/trebell/checkpoints/checkpoint-1",label:task.slice(0,80),environmentId:null});
    const built=await contextEngine.buildPacket({root:repo,task:contextTaskText(task,""),focusPaths:[],maxTokens:undefined,maxFiles:undefined,tokensUsed:null,contextWindow:null,io:null});
    const served=JSON.parse(JSON.stringify(repositoryContextDeliveryPacket(built,{seedOnly:true,currentTask:task})));
    const packet=repositoryContextDeliveryPacket(served,{seedOnly:true});
    const turnContext={...repositoryContextEntries(packet,nativeTurnContextOptions(task))};
    const current=state.settings(),reasoningEffort=configuredReasoningEffort(current,"native","openai",MODEL,{}),serviceTier=configuredModelServiceTier(current,"native","openai",MODEL);
    const dynamicToolNamespaces=specializedToolNamespaceNames(task,availability);
    const turn=await rpc.request("turn/start",{threadId,model:MODEL,modelProvider:"openai",...(reasoningEffort?{reasoningEffort}:{}),...(serviceTier?{serviceTier}:{}),cwd:repo,agent:null,approvalPolicy:"never",sandboxPolicy:{type:"dangerFullAccess"},input:[{type:"text",text:task,textElements:[]}],...(dynamicToolNamespaces.length?{dynamicToolNamespaces}:{}),...(Object.keys(turnContext).length?{additionalContext:turnContext}:{})});
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.turn.id);
    const thread=(await rpc.request("thread/read",{threadId})).thread;
    return {record,prompted:prompted.slice(before),sessionId:thread.providerSessionId,remaining:record.remaining(),turnStatus:thread.turns.at(-1)?.status};
  }finally{
    try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));state.close?.();
  }
}

// The benchmark runner's Native for the same task (benchmarks/harbor/native-harbor-run.mjs), with its logs in the temp folder.
async function runnerSide({repo,logs,task,env={}}){
  const record=newRecord(),manager=scriptedManager(record),before=prompted.length;
  await mkdir(logs,{recursive:true});
  const run=await createHarborNativeRun({root:repo,instruction:task,manager,env:{...SAFE_ENV(),TREBELL_HOME:join(logs,"home"),TREBELL_METRICS_PATH:join(logs,"metrics.json"),TREBELL_EVENTS_PATH:join(logs,"events.jsonl"),TREBELL_TOOL_CALLS_PATH:join(logs,"tool-calls.jsonl"),TREBELL_FINAL_DIFF_PATH:join(logs,"final.diff"),TREBELL_TOOL_OUTPUT_DIR:join(logs,"tool-output"),...env}});
  // A run that ends in an error (a flipped switch the script was not written for) still wrote its metrics.
  let metrics;try{metrics=await run.run()}catch{metrics=JSON.parse(await readFile(join(logs,"metrics.json"),"utf8"))}
  return {record,prompted:prompted.slice(before),sessionId:"trebell-harbor",remaining:record.remaining(),metrics,run};
}

// What one side holds and sends, as plain data: functions by name, Symbols and abort signals left out, its session id replaced.
function plain(value,sessionId){
  const text=JSON.stringify(value,(key,child)=>key==="signal"?undefined:typeof child==="function"?"[function "+(child.name||"anonymous")+"]":child);
  return text===undefined?null:JSON.parse(text.split(sessionId).join("<session>"));
}
const PROMPT_KEYS=["maxModelTurns","maxToolCalls","maxOutputTokens","maxWallTimeMs","toolAllowlist"];
function capture(side){
  const first=side.prompted[0];assert.ok(first,"the side started a message");
  const session=first.session;
  const promptMessage=side.record.turns[0]?.request?.messages?.findLast?.(message=>message?.role==="user")||null;
  return {
    session:plain({
      provider:session.provider,model:session.model,reasoningEffort:session.reasoningEffort,serviceTier:session.serviceTier,
      semanticCompletionGate:session.semanticCompletionGate,contextWindow:session.contextWindow,openAiServerCompactionThreshold:session.openAiServerCompactionThreshold,
      permissionMode:session.permissionMode,cwd:session.cwd,sessionId:session.sessionId,toolOutputStore:Boolean(session.toolOutputStore),
    },side.sessionId),
    // The loop's options are NATIVE_LOOP_OPTIONS with the session's gate (one call site, native-agent-session.mjs) and these budgets.
    budgets:Object.fromEntries(PROMPT_KEYS.map(key=>[key,first.options?.[key]??null])),
    tools:plain(session.tools,side.sessionId),
    initialMessages:plain(first.messages,side.sessionId),
    userMessage:plain(promptMessage?.content??null,side.sessionId),
    userProvenance:plain(promptMessage?.[NATIVE_PROMPT_PROVENANCE]??null,side.sessionId),
    requests:side.record.turns.map(turn=>plain({provider:turn.provider,request:turn.request,options:{...turn.options,onStream:undefined}},side.sessionId)),
    wire:{
      requestOrder:side.record.requestOrder,
      wsConnections:plain(side.record.wsConnections,side.sessionId),
      wsPayloads:side.record.wsPayloads.map(payload=>payload.split(side.sessionId).join("<session>")),
      fetches:plain(side.record.fetches,side.sessionId),
    },
    remaining:side.remaining,
  };
}
// Every part that differs, by name (empty when the two are one Native).
function differences(app,runner){
  const out=[];
  for(const key of Object.keys(app)){
    if(key==="wire"){for(const part of Object.keys(app.wire))try{assert.deepEqual(runner.wire[part],app.wire[part])}catch{out.push("wire."+part)}continue}
    try{assert.deepEqual(runner[key],app[key])}catch{out.push(key)}
  }
  return out;
}

const fixtures=new Map(),roots=[];
after(()=>Promise.all(roots.map(root=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}))));
async function both(name,task){
  if(fixtures.has(name))return fixtures.get(name);
  // The temp folder goes once every case that reads it has run (after()).
  const {root,repo}=await fixtureRepo();roots.push(root);
  const app=await appSide({repo,home:join(root,"app-home"),task});
  const runner=await runnerSide({repo,logs:join(root,"runner-logs"),task});
  const result={app,runner,appCapture:capture(app),runnerCapture:capture(runner),root,repo};
  fixtures.set(name,result);return result;
}

for(const [name,task] of [["a plain coding task",PLAIN_TASK],["a task naming a commit, branch and pull request",SOURCE_CONTROL_TASK]]){
  test("the app's Native and the benchmark runner's are one program for "+name,async()=>{
    const {app,runner,appCapture,runnerCapture}=await both(name,task);
    assert.equal(app.turnStatus,"completed");assert.equal(runner.metrics.error,null);
    assert.deepEqual(differences(appCapture,runnerCapture),[],"every part the same");
    // The same requests went out, byte for byte, and both read the same script.
    assert.ok(appCapture.wire.wsPayloads.length>=2,"the read and the answer");
    assert.deepEqual(runnerCapture.wire.wsPayloads,appCapture.wire.wsPayloads);
    assert.equal(app.remaining,runner.remaining);
    // The shared values themselves, not only their agreement.
    const first=JSON.parse(appCapture.wire.wsPayloads[0]);
    assert.equal(first.service_tier,undefined,"no tier unless the person picks Fast");
    assert.deepEqual(first.reasoning,{effort:"max",context:"current_turn"});
    assert.equal(appCapture.session.semanticCompletionGate,false);assert.equal(appCapture.session.contextWindow,272_000);assert.equal(appCapture.session.openAiServerCompactionThreshold,245_000);
    assert.deepEqual(appCapture.budgets,{maxModelTurns:500,maxToolCalls:5000,maxOutputTokens:null,maxWallTimeMs:null,toolAllowlist:null});
    const namespaces=appCapture.tools.map(item=>item.name);
    assert.ok(namespaces.includes("trebell_process"),"background processes always");
    assert.equal(namespaces.includes("trebell_source_control"),task===SOURCE_CONTROL_TASK,"source control as the message selects it");
    for(const containerOnly of ["trebell_browser","trebell_computer","trebell_delegate"])assert.equal(namespaces.includes(containerOnly),false);
    assert.deepEqual(appCapture.initialMessages.map(message=>message.role),["system","developer"]);
    // Native's developer text: the repository-lookup sentence, with no web-research sentence (dropped for the app and the runner on
    // 2026-10-29; other harnesses' threads keep it).
    assert.equal(appCapture.initialMessages[1].content,"Use trebell_repo for deterministic symbol and structural repository lookups when that is faster than manual exploration.");
    assert.doesNotMatch(JSON.stringify(appCapture.userMessage),/trebell\.continuity|Artifacts created/,"no continuity block restating the pre-turn checkpoint");
    assert.match(JSON.stringify(appCapture.userMessage),/trebell\.repo_evidence/);
    // Container-only: the app shows drafts and the runner does not, and the wire is the same (above).
    assert.equal(app.prompted[0].session.streamDrafts,true);assert.equal(runner.prompted[0].session.streamDrafts,false);
    assert.equal(typeof app.record.turns[0].options.onStream,"function","the app's first request streamed into a draft");
    assert.equal(runner.record.turns.some(turn=>typeof turn.options.onStream==="function"),false);
    assert.equal(runner.metrics.configurationHash.length,64);assert.deepEqual(runner.metrics.experimentSwitches,{});
  });
}

// Flip one shared value on one side only: each flip shows as a difference, so the comparison above can fail.
test("the parity comparison catches a setting changed on one side only",async()=>{
  const {appCapture,root,repo}=await both("a plain coding task",PLAIN_TASK);
  const flips=[
    [{TREBELL_SERVICE_TIER:"fast"},["session","requests","wire.wsPayloads"]],
    [{TREBELL_HARBOR_SEMANTIC_GATE:"1"},["session"]],
    [{TREBELL_HARBOR_MAX_MODEL_TURNS:"24"},["budgets"]],
    [{TREBELL_HARBOR_COMPACT_THRESHOLD:"200000"},["session"]],
    [{TREBELL_OPENAI_REASONING_CONTEXT:"all_turns"},["requests","wire.wsPayloads"]],
    [{TREBELL_REASONING_EFFORT:"high"},["session","requests","wire.wsPayloads"]],
  ];
  for(const [env,expected] of flips){
    const runner=await runnerSide({repo,logs:join(root,"flip-"+Object.keys(env)[0]),task:PLAIN_TASK,env});
    const found=differences(appCapture,capture(runner));
    for(const part of expected)assert.ok(found.includes(part),JSON.stringify(env)+" shows in "+part+" (found "+found.join(", ")+")");
    assert.deepEqual(runner.metrics.experimentSwitches,Object.fromEntries(Object.entries(env).filter(([key])=>NATIVE_RUN_SWITCHES.find(item=>item.name===key)?.kind!=="pick")),"a set switch is in the metrics");
  }
  // And on the app's side: the person's Speed pick of Fast.
  const fast=await appSide({repo,home:join(root,"app-fast-home"),task:PLAIN_TASK,settings:{modelServiceTiers:{"native:openai:gpt-6-luna":"fast"}}});
  const found=differences(capture(fast),capture((await both("a plain coding task",PLAIN_TASK)).runner));
  assert.ok(found.includes("session")&&found.includes("wire.wsPayloads"),found.join(", "));
});

test("the runner reads no setting of its own: no literal defaults, and every environment name is registered",async()=>{
  const registered=new Set(NATIVE_RUN_SWITCHES.map(item=>item.name));
  for(const file of ["native-harbor-run.mjs","trebell-native-runner.mjs"]){
    const source=await readFile(new URL("../benchmarks/harbor/"+file,import.meta.url),"utf8");
    for(const literal of [/\b500\b/,/\b5_?000\b/,/\b272_?000\b/,/\b245_?000\b/,/"max"/,/"fast"/,/"current_turn"/,/semanticCompletionGate:(?:true|false)/,/maxModelTurns:\d/])assert.doesNotMatch(source,literal,file+" holds no literal setting");
    // Every environment read (env.NAME or env["NAME"]); the run's own log prefixes (TREBELL_HARBOR_METRICS ...) are no read.
    const reads=[...source.matchAll(/\benv\??\.?(?:\.|\[["'])(TREBELL_[A-Z0-9_]+)/g)].map(match=>match[1]);
    assert.ok(file!=="native-harbor-run.mjs"||reads.length>=5,"the run reads its paths from its environment");
    for(const name of reads)assert.ok(registered.has(name),file+" reads "+name+", which NATIVE_RUN_SWITCHES must list");
    assert.doesNotMatch(source,/process\.env\.TREBELL_/,file+" reads its environment only through the env it is given");
  }
  for(const item of NATIVE_RUN_SWITCHES)assert.ok(["experiment","diagnostic","pick","observation"].includes(item.kind),item.name);
  // The loop's options come from one call site for both, the shared ones with the session's gate (compared above) on top.
  const sessionSource=await readFile(new URL("../src/native-agent-session.mjs",import.meta.url),"utf8");
  assert.equal(sessionSource.split("await runNativeAgentTurn({").length-1,2,"a message's loop call and the compaction's");
  assert.match(sessionSource,/\.\.\.NATIVE_LOOP_OPTIONS,semanticCompletionGate:this\.semanticCompletionGate,changesRefused,priorTerminalRuns,/);
  // With nothing set, the runner runs the shared configuration and names no switch.
  const config=nativeHarborRunConfiguration({});
  assert.deepEqual(config.experimentSwitches,{});assert.equal(config.picksDifferFromShared,false);
  assert.deepEqual({effort:config.reasoningEffort,tier:config.serviceTier,gate:config.semanticCompletionGate,window:config.contextWindow,threshold:config.compactionThreshold,budgets:config.budgets},{effort:"max",tier:"default",gate:false,window:272_000,threshold:245_000,budgets:{maxModelTurns:500,maxToolCalls:5000,maxWallTimeMs:null}});
  // With no pick, the window's model (its OpenAI catalog listing a newer flagship) is the runner's.
  assert.equal(nativeConfiguration.nativeDefaultModel?.("openai",["gpt-6.1-sol","gpt-6-luna"],"gpt-6.1-sol"),config.model);
  // Each container-only difference says why.
  for(const item of NATIVE_CONTAINER_ONLY)assert.ok(item.what&&item.app&&item.runner&&item.reason.length>20,item.what);
});

test("a draft observer changes no request byte: the same script with drafts on and off sends the same payloads",async()=>{
  // One repository for both runs: its commit (named in the working context) is then the same.
  const sends=[],{root,repo}=await fixtureRepo();roots.push(root);
  for(const streamDrafts of [true,false]){
    const record=newRecord(),manager=scriptedManager(record),logs=join(root,"drafts-"+streamDrafts);await mkdir(logs,{recursive:true});
    const run=await createHarborNativeRun({root:repo,instruction:PLAIN_TASK,manager,env:{...SAFE_ENV(),TREBELL_HOME:join(logs,"home"),TREBELL_METRICS_PATH:join(logs,"m.json"),TREBELL_EVENTS_PATH:join(logs,"e.jsonl"),TREBELL_TOOL_CALLS_PATH:join(logs,"t.jsonl"),TREBELL_FINAL_DIFF_PATH:join(logs,"f.diff"),TREBELL_TOOL_OUTPUT_DIR:join(logs,"out")}});
    run.session.streamDrafts=streamDrafts;
    await run.run();
    sends.push({payloads:record.wsPayloads,hooked:record.turns.some(turn=>typeof turn.options.onStream==="function")});
  }
  assert.equal(sends[0].hooked,true);assert.equal(sends[1].hooked,false);
  assert.deepEqual(sends[0].payloads,sends[1].payloads);
});
