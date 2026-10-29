import test from "node:test";
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
import { ContextEngine, planContextBudget } from "../src/context-engine.mjs";
import { createGuiServer } from "../src/gui-server.mjs";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import * as nativeConfiguration from "../src/native-configuration.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { providerTurnToResponses } from "../src/provider-turn.mjs";
import { RepositoryKnowledgeService } from "../src/repository-knowledge-service.mjs";
import { sharedRuntimeCapabilities } from "../src/runtime-capabilities.mjs";
import { sharedDynamicToolNamespaces } from "../src/shared-tool-catalog.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { autoCompactionDecision } from "../ui/src/auto-compaction.js";
import { specializedToolSelection } from "../ui/src/lazy-tool-exposure.js";
import { createHarborNativeRun } from "../benchmarks/harbor/native-harbor-run.mjs";

// What the review of native-one-config (2026-10-29) found, each checked where a person or a benchmark run meets it. New exports are
// read through their modules' namespaces, so each case fails on its own assertion where the export is missing.

const SAFE_ENV=()=>{const env={};for(const key of ["PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","ComSpec","COMSPEC","WINDIR","TEMP","TMP","HOME","USERPROFILE"])if(process.env[key])env[key]=process.env[key];return env};
const GIT_ENV=()=>({...SAFE_ENV(),GIT_AUTHOR_NAME:"fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"});
const git=(cwd,...args)=>execFileSync("git",args,{cwd,windowsHide:true,stdio:["ignore","pipe","ignore"],env:GIT_ENV()}).toString().trim();
const readCall=(id,path="src/a.mjs")=>({id,namespace:"trebell_workspace",name:"read_file",arguments:JSON.stringify({path})});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The app's relay with a scripted provider (no network), a gpt-6-luna thread in a fresh project, and the person's settings.
async function relayHarness(t,{model="gpt-6-luna",settings={},script}){
  const root=await mkdtemp(join(tmpdir(),"trebell-one-config-repairs-")),home=join(root,"home"),repo=join(root,"repo");
  await mkdir(join(repo,"src"),{recursive:true});await writeFile(join(repo,"src","a.mjs"),"export const a=1;\n","utf8");
  execFileSync("git",["init","-q"],{cwd:repo,windowsHide:true,stdio:"ignore",env:SAFE_ENV()});
  const env={...SAFE_ENV(),TREBELL_HOME:home},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",activeEnvironmentId:null,...settings});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),requests=[];
  const nativeProviderTurn=async request=>{requests.push(request);return script(request,requests.length)};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  // OpenAI's catalog gives no window, as in the app: the measured row's applies.
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),repositoryKnowledge:new RepositoryKnowledgeService({state}),nativeProviderTurn,nativeModelContextWindow:()=>null,version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  let id=0;const pending=new Map(),notifications=[];
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!=null&&pending.has(message.id)){const target=pending.get(message.id);pending.delete(message.id);message.error?target.reject(new Error(message.error.message)):target.resolve(message.result);return}if(message.method)notifications.push(message)});
  const request=(method,params={})=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}))});
  const waitFor=async predicate=>{const until=Date.now()+60_000;while(Date.now()<until){const found=notifications.find(predicate);if(found)return found;await new Promise(resolve=>setTimeout(resolve,20))}throw new Error("Timed out waiting for a relay notification")};
  t.after(async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));state.close?.();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  const thread=(await request("thread/start",{model,modelProvider:"openai",cwd:repo,projectless:false,approvalPolicy:"never",sandbox:"danger-full-access",dynamicTools:[]})).thread;
  const send=async(text,extra={})=>{
    const turn=(await request("turn/start",{threadId:thread.id,model,modelProvider:"openai",approvalPolicy:"never",sandboxPolicy:{type:"dangerFullAccess"},input:[{type:"text",text}],...extra})).turn;
    await waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);
    const usage=notifications.filter(message=>message.method==="thread/tokenUsage/updated"&&message.params?.turnId===turn.id).at(-1)?.params?.tokenUsage||null;
    return {turn,usage};
  };
  return {state,thread,requests,notifications,send,request,repo};
}
// What the window does with a turn's usage before the next message (App.jsx maybeAutoCompactBeforeTurn with the default settings, and
// turn-support.js prepareTurnContext's context budget).
const windowReads=usage=>({
  autoCompaction:autoCompactionDecision(usage,{enabled:true,thresholdPercent:85}),
  budget:planContextBudget({task:"Now summarize it in one line",tokensUsed:usage?.last?.inputTokens??null,contextWindow:usage?.modelContextWindow??null}),
});

test("a gpt-6-luna turn of six 45K requests reads as 45K of context, so the window neither compacts nor drops the next message's seed",async t=>{
  const harness=await relayHarness(t,{script:(request,count)=>count<6
    ?{id:"read-"+count,provider:"openai",model:request.model,text:"",toolCalls:[readCall("read-"+count)],usage:{inputTokens:45_000,cachedInputTokens:40_000,outputTokens:10,totalTokens:45_010,reasoningOutputTokens:4}}
    :{id:"answer",provider:"openai",model:request.model,text:"src/a.mjs exports a = 1.",toolCalls:[],usage:{inputTokens:45_000,cachedInputTokens:44_000,outputTokens:12,totalTokens:45_012,reasoningOutputTokens:5}}});
  const {usage}=await harness.send("Explain src/a.mjs");
  assert.equal(harness.requests.length,6);
  assert.equal(usage.modelContextWindow,272_000);
  // The turn keeps its summed usage as its total; the context reading is the last request's.
  assert.equal(usage.total.inputTokens,270_000);
  assert.deepEqual(usage.last,{totalTokens:45_012,inputTokens:45_000,cachedInputTokens:44_000,cacheWriteInputTokens:0,outputTokens:12,reasoningOutputTokens:5});
  const {autoCompaction,budget}=windowReads(usage);
  assert.equal(autoCompaction.shouldCompact,false,"no compaction model call before the next message");
  assert.equal(autoCompaction.utilizationPercent,16.54);
  assert.equal(budget.skip,false,"the next message keeps its repository seed");
  // The thread's recorded usage is still the whole turn's.
  assert.equal(harness.state.threadUsage(harness.thread.id).inputTokens,270_000);
});

test("a gpt-6-luna turn whose last request holds 240K still compacts before the next message at the default 85%",async t=>{
  const harness=await relayHarness(t,{script:(request,count)=>count===1
    ?{id:"read",provider:"openai",model:request.model,text:"",toolCalls:[readCall("read-1")],usage:{inputTokens:20_000,outputTokens:10,totalTokens:20_010}}
    :{id:"answer",provider:"openai",model:request.model,text:"Done.",toolCalls:[],usage:{inputTokens:240_000,outputTokens:12,totalTokens:240_012}}});
  const {usage}=await harness.send("Explain src/a.mjs");
  assert.equal(usage.last.inputTokens,240_000);
  const {autoCompaction,budget}=windowReads(usage);
  assert.equal(autoCompaction.shouldCompact,true);assert.equal(autoCompaction.utilizationPercent,88.24);
  assert.equal(budget.pressure,"critical");
});

test("a failed Native turn's usage carries the last answered request as its context reading",async()=>{
  const updates=[];let calls=0;
  const tools=platformDynamicToolNamespaces({repository:false,output:false,workspaceTools:true,terminal:true,process:false,browser:false,computer:false,sourceControl:false,delegation:false});
  const session=new NativeAgentSession({
    provider:"fixture",model:"model-a",tools,onUpdate:params=>updates.push(params.update),
    providerTurn:async()=>{
      calls++;
      if(calls<=2)return {id:"read-"+calls,text:"",toolCalls:[readCall("read-"+calls,`notes/${calls}.txt`)],usage:{inputTokens:calls*1_000,outputTokens:7,totalTokens:calls*1_000+7}};
      throw Object.assign(new Error("fixture provider refused the request"),{retryable:false,status:400});
    },
    executeTool:async call=>({path:JSON.parse(call.arguments).path,content:"note\n",size:5}),
  });
  await session.start({providerSessionId:"failed-turn",model:"model-a"});
  await assert.rejects(session.prompt([{type:"text",text:"Read the notes and summarize them."}]),/refused/);
  const usage=updates.filter(update=>update.sessionUpdate==="usage_update").at(-1);
  assert.ok(usage,"the failed turn reports its usage");
  assert.equal(usage.usage.input_tokens,3_000,"the turn's summed input");
  assert.deepEqual(usage.context,{totalTokens:2_007,inputTokens:2_000,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:7,reasoningOutputTokens:0});
});

test("a gpt-6-luna compaction brief runs at the provider's own effort under the 4,096-token cap, whatever the Thinking level",async t=>{
  for(const settings of [{},{modelReasoningEfforts:{"native:openai:gpt-6-luna":"max"}}]){
    const harness=await relayHarness(t,{settings,script:(request,count)=>request?.metadata?.compaction
      ?{id:"brief-"+count,provider:"openai",model:request.model,text:"Brief: src/a.mjs exports a = 1.",toolCalls:[],usage:{inputTokens:900,outputTokens:20,totalTokens:920}}
      :{id:"answer-"+count,provider:"openai",model:request.model,text:"src/a.mjs exports a = 1.",toolCalls:[],usage:{inputTokens:800,outputTokens:12,totalTokens:812}}});
    await harness.send("Explain src/a.mjs");await harness.send("And what does it export?");
    const result=await harness.request("thread/compact/start",{threadId:harness.thread.id});
    assert.equal(result.ok,true);
    const turns=harness.requests.filter(request=>!request?.metadata?.compaction),compaction=harness.requests.find(request=>request?.metadata?.compaction);
    assert.deepEqual(turns.map(request=>request.reasoningEffort),["max","max"],"the messages keep gpt-6-luna's measured level");
    assert.ok(compaction,"the compaction asked for a brief");
    assert.equal(compaction.reasoningEffort??null,null,"the brief sends no effort: the provider's own");
    assert.equal(compaction.maxOutputTokens,4096);
    const wire=providerTurnToResponses({...compaction,reasoningContext:"current_turn"},{flattenToolCallNames:true,preserveInstructionOrder:true});
    assert.deepEqual(wire.reasoning,{context:"current_turn"});assert.equal(wire.max_output_tokens,4096);
    assert.deepEqual(nativeConfiguration.NATIVE_COMPACTION,{reasoningEffort:null,maxOutputTokens:4096});
  }
});

test("Native's OpenAI default model is gpt-6-luna when the catalog lists it, else the catalog's own",async t=>{
  // Where a person meets it: the window's model catalog (/api/models), with OpenAI listing a newer flagship.
  const root=await mkdtemp(join(tmpdir(),"trebell-native-default-model-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  for(const [name,rows,expected] of [["luna listed",[{id:"gpt-6.1-sol",created:1_795_000_000},{id:"gpt-6-luna",created:1_793_000_000}],"gpt-6-luna"],["luna not listed",[{id:"gpt-6.1-sol",created:1_795_000_000}],"gpt-6.1-sol"]]){
    const home=join(root,name.replace(/\s+/g,"-")),env={...SAFE_ENV(),TREBELL_HOME:join(home,"trebell"),CODEX_HOME:join(home,"codex"),CLAUDE_CONFIG_DIR:join(home,"claude"),OPENAI_API_KEY:"sk-default-model-fixture",HARBOR_TELEMETRY:"0"};
    const state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",onboardingComplete:true});state.close?.();
    const fetchFn=async input=>{
      const url=String(input instanceof URL?input.href:input?.url||input);
      if(url.endsWith("/models"))return new Response(JSON.stringify({object:"list",data:rows.map(row=>({...row,object:"model",owned_by:"openai"}))}),{status:200,headers:{"content-type":"application/json"}});
      throw new Error("Unexpected external request: "+url);
    };
    const [port,appPort]=await Promise.all([freePort(),freePort()]);
    const gui=await createGuiServer({port,appPort,mock:false,env,fetchFn});
    try{
      const catalog=await fetch(gui.url+"/api/models").then(response=>response.json());
      assert.equal(catalog.provider,"openai");assert.equal(catalog.defaultModel,expected,name);
    }finally{await gui.close()}
  }
  assert.equal(nativeConfiguration.nativeDefaultModel("openai",["gpt-6.1-sol","gpt-6-luna"],"gpt-6.1-sol"),"gpt-6-luna");
  assert.equal(nativeConfiguration.nativeDefaultModel("openai",["gpt-6.1-sol"],"gpt-6.1-sol"),"gpt-6.1-sol");
  assert.equal(nativeConfiguration.nativeDefaultModel("anthropic",["claude-opus-5"],"claude-opus-5"),"claude-opus-5");
  // Every default is a model with measured rows.
  for(const [provider,model] of Object.entries(nativeConfiguration.NATIVE_DEFAULT_MODELS))assert.ok(nativeConfiguration.nativeMeasuredModel(provider,model),provider+":"+model);
});

test("source-control tools follow Git work the message asks for, not a link or the words' other senses",async t=>{
  const all={browser:true,computer:true,sourceControl:true,delegation:true};
  const asks=[
    "Fix the off-by-one bug in src/range.mjs so range(1,3) includes 3, then commit the fix on a new branch for a pull request.",
    "Create a git branch, commit the fix, and open a pull request",
    "Commit the fix and open a PR",
    "Create a proof branch",
    "Push the branch to origin",
    "Run git status and tell me what changed",
    "Rebase onto main and push",
    "Stage the changes and make a commit",
    // The everyday asks a person types, which the word rule also selected.
    "commit and push",
    "Commit this",
    "What branch am I on?",
    "Merge main into this branch",
    "Undo my last commit",
    "amend the last commit with the test fix",
    // The second review's (2026-10-29): asks the word rule selected and the narrowed rule dropped.
    "Fix the failing test and commit",
    "fix it then commit",
    "Fix the bug. Commit.",
    "commit",
    "push",
    "push it",
    "revert the last commit",
    "new branch",
    "can you PR this?",
    "what changed in the last commit?",
    // More of them, none of which selects a benchmark task.
    "commit please",
    "Please commit.",
    "commit with message 'fix bug'",
    "publish the branch",
    "rebase",
    "sync with upstream",
    "show me the last commit",
    "fix bug and push.",
    "New branch for this, please",
  ];
  // The review's examples, each of which the word rule selected, and the other senses of commit and merge.
  const not=[
    "See https://github.com/sympy/sympy/issues/20801 for the original report. The printer drops the sign of a negative exponent.",
    "This regression was introduced in commit 3f2a1b9 and breaks parsing of empty strings.",
    "Configure the nginx upstream so that requests are balanced across both servers.",
    "Commit the transaction only after both inserts succeed.",
    "The new predictor mispredicts every branch in the inner loop.",
    "Add push notifications to the mobile client.",
    "Commit this transaction before the connection closes.",
    "Merge the two branches of the conditional into one return.",
    "raw_hits.json must include every commit that contains a secret.",
    "I tried to commit it but the pre-commit hook failed.",
    // And the everyday asks' words in their other senses: a stack machine's push, a code path's branch, a log's last commit, SQL's
    // COMMIT, a DNS upstream.
    "The VM supports these opcodes:\npush\npop\nadd",
    "Each element is a new branch of the tree.",
    "Add a new branch to the match statement for None.",
    "The last commit of the transaction log must be durable.",
    "BEGIN;\nINSERT INTO t VALUES (1);\nCOMMIT;\nSELECT * FROM t;",
    "Sync with the upstream DNS server.",
  ];
  for(const text of asks){assert.equal(nativeConfiguration.nativeSpecializedSelection(text,all).sourceControl,true,text);assert.equal(specializedToolSelection(text,all).sourceControl,true,text)}
  for(const text of not){assert.equal(nativeConfiguration.nativeSpecializedSelection(text,all).sourceControl,false,text);assert.equal(specializedToolSelection(text,all).sourceControl,false,text)}
  // The benchmark runner's tools for an issue text that links GitHub and cites a commit: no source-control namespace, as before the
  // shared rule.
  const root=await mkdtemp(join(tmpdir(),"trebell-sc-runner-")),repo=join(root,"repo");t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  await mkdir(repo,{recursive:true});await writeFile(join(repo,"a.py"),"x=1\n","utf8");git(repo,"init","-q");git(repo,"add","-A");git(repo,"commit","-qm","base");
  const run=await createHarborNativeRun({root:repo,instruction:not[0]+"\n"+not[1],manager:{status:()=>({hasKey:true}),close(){}},env:{...SAFE_ENV(),TREBELL_HOME:join(root,"home"),TREBELL_TOOL_OUTPUT_DIR:join(root,"out"),TREBELL_METRICS_PATH:join(root,"m.json"),TREBELL_EVENTS_PATH:join(root,"e.jsonl"),TREBELL_TOOL_CALLS_PATH:join(root,"t.jsonl"),TREBELL_FINAL_DIFF_PATH:join(root,"f.diff")}});
  try{assert.equal(run.tools.some(namespace=>namespace.name==="trebell_source_control"),false)}finally{await run.session.close()}
});

test("a Codex thread whose first message asks for Git work starts with trebell_source_control, as the window picks every harness's first tools by the shared rule",()=>{
  // createThreadFor (ui/src/App.jsx) sends specializedToolSelection's pick as thread/start's dynamicTools for every harness. Codex takes
  // its tools there, once: it has no tool expansion, so its first message alone decides.
  assert.equal(sharedRuntimeCapabilities("codex").dynamicTools,true);assert.equal(sharedRuntimeCapabilities("codex").dynamicToolExpansion,false);
  const availability={browser:false,computer:false,sourceControl:true,delegation:true};
  const names=text=>sharedDynamicToolNamespaces(specializedToolSelection(text,availability)).map(namespace=>namespace.name);
  for(const text of ["Fix the failing test and commit","fix it then commit","Fix the bug. Commit.","push it","revert the last commit","new branch","can you PR this?","what changed in the last commit?"])assert.ok(names(text).includes("trebell_source_control"),text);
  assert.equal(names("Explain what src/a.mjs exports").includes("trebell_source_control"),false);
});

test("the source-control rule reads a message as long as the composer holds in linear time, with no spaces or with line after line",()=>{
  // 120,000 characters, the composer's most (App.jsx MAX_COMPOSER_CHARS): the window runs the rule on its main thread for every new
  // thread and every Native message. At 5ae45215 the link removal (\S*:\/\/\S*) and the sentence starts ([.!?;:\n]\s*) went back over
  // the rest of such a run from each of its characters: seconds each.
  const all={browser:true,computer:true,sourceControl:true,delegation:true};
  for(const [name,text] of [["no spaces","a".repeat(120_000)],["base64",Buffer.from("x".repeat(90_000)).toString("base64")],["line breaks","\n".repeat(120_000)+"x"],["CRLF line breaks","\r\n".repeat(60_000)+"x"],["dots, then spaces",".".repeat(60_000)+" ".repeat(60_000)+"x"]]){
    const started=performance.now(),selected=nativeConfiguration.nativeSpecializedSelection(text,all).sourceControl,ms=performance.now()-started;
    assert.equal(selected,false,name);assert.ok(ms<1_000,name+": "+ms.toFixed(0)+" ms");
  }
  // A link is still read without its address (the whole word that holds it), and an ask beside it still selects.
  assert.equal(nativeConfiguration.nativeSpecializedSelection("Details: (https://github.com/o/r/pull/1/commits/new-branch-push)",all).sourceControl,false);
  assert.equal(nativeConfiguration.nativeSpecializedSelection("Push the branch to origin, then reply on https://github.com/o/r/pull/1",all).sourceControl,true);
});

test("the settings evidence says what each value rests on: the ceilings and background processes on the readouts, the compactions as app defaults, the source-control rule as new",()=>{
  const rows=nativeConfiguration.NATIVE_SETTINGS_EVIDENCE,row=name=>rows.find(item=>item.setting===name);
  for(const item of rows){
    assert.ok(["fresh tasks","readouts","app default","new"].includes(item.basis),item.setting);
    assert.equal(item.measured,item.basis==="fresh tasks",item.setting+": measured only when compared on fresh tasks");
  }
  // The source-control rule is new and unmeasured, and it also decides a Codex thread's trebell_source_control from its first message
  // (second review of native-one-config, 2026-10-29).
  const sourceControl=row("Source control tools (trebell_source_control)");
  assert.equal(sourceControl.measured,false);assert.equal(sourceControl.basis,"new");
  assert.match(sourceControl.evidence,/new rule, narrowed from the product's word rule on 2026-10-29/);assert.match(sourceControl.evidence,/unmeasured/);
  assert.match(sourceControl.evidence,/Codex thread gets trebell_source_control[^.]*first message only/);
  const ceilings=row("Per-message ceilings");assert.equal(ceilings.measured,false);assert.equal(ceilings.basis,"readouts");assert.match(ceilings.evidence,/owner/);assert.match(ceilings.evidence,/not a fresh A\/B/);
  const processes=row("Background processes (trebell_process)");assert.equal(processes.basis,"readouts");assert.match(processes.evidence,/without prompt caching[^.]*unmeasured/);
  for(const name of ["Automatic between-turn compaction","Between-turn compaction brief"])assert.equal(row(name)?.basis,"app default",name);
  assert.equal(row("Default model")?.basis,"readouts");
  // The model is a person's pick with a shared default, not a container-only difference of its own.
  const model=nativeConfiguration.NATIVE_CONTAINER_ONLY.find(item=>/^Model/.test(item.what));
  assert.match(model.app,/nativeDefaultModel/);assert.match(model.runner,/shared default/);
});
