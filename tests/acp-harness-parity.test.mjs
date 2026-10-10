// Cursor, Grok Build, Antigravity and remote OpenCode over ACP, driven the way T3 Code drives them. A scripted ACP agent
// (SCENARIO_AGENT) plays the harness: it answers from a JSON scenario and logs every message it receives.
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { AcpAgentSession, acpApprovalOptions, acpClientCapabilities, acpCommandsFromAvailable, acpDecisionOption, acpFileSlice, acpModeAgents, acpPermissionChoice, acpSlashCommandPrompt, grokCompletionFailure, grokPromptError, grokQuestionResponse, GROK_PLAN_FEEDBACK, GROK_USAGE_LIMIT_MESSAGE } from "../src/acp-agent-session.mjs";
import { acpRequestError } from "../src/acp-client.mjs";
import { acpApplyValue, acpConfigSelect, acpReadOnlyMode } from "../src/acp-session-config.mjs";
import { acpToolFrame, mergeAcpToolUpdate } from "../src/acp-tool-state.mjs";
import { acpRuntimeTempRoot, createRunTemp, sweepRunTemps } from "../src/acp-runtime-temp.mjs";
import { CursorTransportFailure } from "../src/cursor-transport-failure.mjs";
import { antigravityModelCatalog, antigravitySeedCatalog, cursorEffortOption, cursorFastOption, cursorModelCatalog, cursorModelOptions, cursorSwitchValue, grokModelCatalog } from "../src/acp-model-catalog.mjs";
import { grokUsageResponseToLimits, readCursorUsageLimits, readGrokUsageLimits } from "../src/agent-usage-limits.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { attachAgentRelay, contextualAgentPrompt } from "../src/agent-relay.mjs";
import { supportedModelServiceTiers } from "../src/model-service-tier.mjs";
import { configuredModelOptions, modelOptionSettingsWith, supportedModelOptions } from "../src/model-options.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

const SCENARIO_AGENT=String.raw`
import readline from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
const config=JSON.parse(readFileSync(process.env.TREBELL_ACP_SCENARIO,"utf8"));
const log=process.env.TREBELL_ACP_LOG;
const record=entry=>{if(log)appendFileSync(log,JSON.stringify(entry)+"\n")};
record({launch:process.argv.slice(2)});
const send=message=>process.stdout.write(JSON.stringify(message)+"\n");
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let next=1,promptIndex=0,cancelled=false,wakeCancel=null;const pending=new Map();
let options=Array.isArray(config.sessionNew?.configOptions)?config.sessionNew.configOptions:null;
const fill=(value,vars)=>JSON.parse(JSON.stringify(value).replaceAll("$promptId",vars.promptId||"").replaceAll("$sessionId",vars.sessionId||""));
function request(method,params){const id="agent-"+(next++);send({jsonrpc:"2.0",id,method,params});return new Promise(resolve=>pending.set(id,resolve))}
async function runSteps(steps,vars,m){
  for(const raw of steps||[]){
    const step=fill(raw,vars);
    if(step.delay)await sleep(step.delay);
    if(step.update)send({jsonrpc:"2.0",method:"session/update",params:{sessionId:vars.sessionId,...(step.meta?{_meta:step.meta}:{}),update:step.update}});
    if(step.notify)send({jsonrpc:"2.0",method:step.notify.method,params:step.notify.params});
    if(step.request){const reply=await request(step.request.method,step.request.params);record({reply:step.request.method,message:reply})}
    if(step.hang){if(!cancelled)await new Promise(resolve=>{wakeCancel=resolve});send({jsonrpc:"2.0",id:m.id,result:{stopReason:"cancelled"}});return false}
    if(step.exit!==undefined)process.exit(step.exit);
  }
  return true;
}
// Prompts are numbered across the scenario's processes (a relaunched harness continues the script), by the prompts logged so far.
function promptNumber(){
  try{return readFileSync(log,"utf8").split("\n").filter(line=>line.startsWith('{"method":"session/prompt"')).length-1}catch{return promptIndex++}
}
async function runPrompt(m){
  cancelled=false;
  const script=(config.prompts||[])[promptNumber()]||{};
  const vars={promptId:m.params?._meta?.promptId||"",sessionId:m.params.sessionId};
  if(!await runSteps(script.steps,vars,m))return;
  if(script.error)send({jsonrpc:"2.0",id:m.id,error:fill(script.error,vars)});
  else send({jsonrpc:"2.0",id:m.id,result:{stopReason:script.stopReason||"end_turn"}});
  if(script.after)await runSteps(script.after,vars,m);
}
function handle(m){
  record({method:m.method??null,id:m.id??null,params:m.params??null});
  if(m.id!=null&&!m.method){const resolve=pending.get(m.id);pending.delete(m.id);resolve?.(m.error?{error:m.error}:m.result);return}
  if(m.method==="session/cancel"){cancelled=true;wakeCancel?.();wakeCancel=null;return}
  if(m.id==null)return;
  const reply=result=>send({jsonrpc:"2.0",id:m.id,result});
  if(config.errors?.[m.method])return send({jsonrpc:"2.0",id:m.id,error:config.errors[m.method]});
  if(m.method==="initialize")return reply(config.initialize||{protocolVersion:1,agentCapabilities:{}});
  if(m.method==="session/new")return reply({...(config.sessionNew||{sessionId:"fixture-session"}),...(options?{configOptions:options}:{})});
  if(m.method==="session/load"||m.method==="session/resume"){
    for(const update of config.replay||[])send({jsonrpc:"2.0",method:"session/update",params:{sessionId:m.params.sessionId,update}});
    return reply({...(config.resumed||{}),...(options?{configOptions:options}:{})});
  }
  if(m.method==="session/set_config_option"){
    if(options){
      options=options.map(option=>option.id===m.params.configId?{...option,currentValue:m.params.value}:option);
      if(m.params.configId==="model"&&config.modelOptions)options=[...options.filter(option=>option.category==="mode"||option.category==="model"),...(config.modelOptions[m.params.value]||[])];
    }
    return reply({configOptions:options||[]});
  }
  if(m.method==="session/prompt")return void runPrompt(m);
  return reply({});
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{let m;try{m=JSON.parse(line)}catch{return}handle(m)});
`;

// Cleanups run newest first, so a harness stops before its folder goes (Windows keeps a running process's folder busy).
const cleanups=new WeakMap();
function onCleanup(t,step){
  let stack=cleanups.get(t);
  if(!stack){
    stack=[];cleanups.set(t,stack);
    t.after(async()=>{let failure=null;for(const next of stack.reverse()){try{await next()}catch(error){failure??=error}}if(failure)throw failure});
  }
  stack.push(step);
}

// A scripted harness in its own folder; config may be a function of that folder.
async function scenario(t,config){
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-parity-")),fixture=join(root,"agent.mjs"),scenarioPath=join(root,"scenario.json"),logPath=join(root,"log.jsonl");
  await writeFile(fixture,SCENARIO_AGENT,"utf8");
  await writeFile(scenarioPath,JSON.stringify(typeof config==="function"?config(root):config),"utf8");
  onCleanup(t,()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  return {
    root,args:[fixture],env:{...process.env,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TREBELL_ACP_SCENARIO:scenarioPath,TREBELL_ACP_LOG:logPath},
    async log(){try{return (await readFile(logPath,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))}catch{return []}},
  };
}
function harness(t,fx,options){
  const updates=[],session=new AcpAgentSession({command:process.execPath,args:fx.args,cwd:fx.root,env:fx.env,onUpdate:params=>updates.push(params.update),...options});
  onCleanup(t,()=>session.close().catch(()=>{}));
  return {session,updates};
}
const requested=(log,method)=>log.filter(entry=>entry.method===method&&entry.id!=null);
const reply=(log,method)=>log.find(entry=>entry.reply===method)?.message;
async function until(check,ms=8000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return true;await new Promise(resolve=>setTimeout(resolve,25))}return false}

const select=(id,category,currentValue,values)=>({id,name:id,category,type:"select",currentValue,options:values.map(value=>Array.isArray(value)?{value:value[0],name:value[1]}:{value,name:value})});
const GROK_MODELS={currentModelId:"grok-4.7",availableModels:[{modelId:"grok-4.7",name:"Grok 4.7",_meta:{reasoningEffort:"high",reasoningEfforts:[{value:"xhigh"},{value:"high",default:true},{value:"low"}],totalContextTokens:256000}}]};
const GROK={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}}},sessionNew:{sessionId:"grok-session",models:GROK_MODELS}};
const CURSOR_SETUP={sessionId:"cursor-session",models:{currentModelId:"default",availableModels:[{modelId:"default",name:"Auto"},{modelId:"claude-opus-5",name:"Claude Opus 5"}]},configOptions:[select("mode","mode","agent",["agent","plan","ask"]),select("model","model","default",[["default","Auto"],["claude-opus-5","Claude Opus 5"]])]};
const CURSOR={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:CURSOR_SETUP};
const ANTIGRAVITY={initialize:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}}},sessionNew:{sessionId:"agy-session",models:{currentModelId:"gemini-3.8-flash-high",availableModels:[{modelId:"gemini-3.8-flash-high",name:"Gemini 3.8 Flash (High)"},{modelId:"gemini-3.1-pro-high",name:"Gemini 3.1 Pro (High)"}]},configOptions:[select("mode","mode","default",["default","auto_edit","yolo"]),select("model","model","gemini-3.8-flash-high",[["gemini-3.8-flash-high","Gemini 3.8 Flash (High)"],["gemini-3.1-pro-high","Gemini 3.1 Pro (High)"]])]}};

test("approval answers keep to the request: allow-once first, reject-once only, and T3's choices per harness",()=>{
  const grokOptions=[{kind:"allow_once",optionId:"allow-once",name:"Allow once"},{kind:"allow_always",optionId:"allow-edits-session",name:"Allow edits"},{kind:"allow_always",optionId:"allow-always",name:"Always"},{kind:"reject_once",optionId:"reject-once",name:"Reject"}];
  assert.equal(acpPermissionChoice(grokOptions,"full",null),"allow-once");
  assert.equal(acpPermissionChoice([{kind:"reject_always",optionId:"never"}],"read-only","edit"),null,"a reject-always answer would be saved, so nothing is chosen");
  assert.equal(acpDecisionOption("grok",grokOptions,"acceptForSession"),"allow-edits-session","Grok's only session-scoped answer");
  assert.equal(acpDecisionOption("grok",grokOptions.filter(option=>option.optionId!=="allow-edits-session"),"acceptForSession"),"allow-once","a project-wide always answer is never sent for a session answer");
  assert.equal(acpDecisionOption("cursor",grokOptions,"acceptForSession"),"allow-edits-session");
  assert.equal(acpDecisionOption("cursor",grokOptions,"decline"),"reject-once");assert.equal(acpDecisionOption("cursor",grokOptions,"cancel"),null);
  assert.deepEqual(acpApprovalOptions("grok",grokOptions).map(option=>option.label),["Cancel","Decline","Allow all edits this session","Approve"]);
  const agy=acpApprovalOptions("antigravity",[{kind:"allow_once",optionId:"once"},{kind:"allow_always",optionId:"always",_meta:{"agy.security.warning":{title:"Careful",message:"This allows every command in this thread."}}},{kind:"reject_once",optionId:"deny"}]);
  assert.deepEqual(agy.map(option=>[option.decision,option.label]),[["accept","Allow once"],["acceptForSession","Allow for this thread"],["decline","Deny"],["cancel","Cancel"]]);
  assert.equal(agy[1].warning,"This allows every command in this thread.");
  assert.deepEqual(acpApprovalOptions("antigravity",[{kind:"allow_once",optionId:"once"},{kind:"reject_once",optionId:"deny"}]).map(option=>option.label),["Allow once","Deny","Cancel"],"Allow for this thread only when Antigravity offers it");
});

test("file reads keep Windows line endings and commands, modes and Grok answers map like T3",()=>{
  assert.equal(acpFileSlice("a\r\nb\r\nc\r\n"),"a\r\nb\r\nc\r\n");
  assert.equal(acpFileSlice("a\r\nb\r\nc\r\n",2,1),"b\r");assert.equal(acpFileSlice("a\nb\nc",2,null),"b\nc");
  assert.deepEqual(acpCommandsFromAvailable([{name:"compact",description:"Compact"},{name:"always-approve",description:"x"},{name:"context"},{name:"/deep-research",description:"Research",input:{hint:"topic"}}],"grok"),
    [{name:"compact",description:"Compact"},{name:"deep-research",description:"Research",input:{hint:"topic"}}]);
  assert.deepEqual(acpCommandsFromAvailable([{name:"context",description:"Show context"}],"cursor"),[{name:"context",description:"Show context"}]);
  assert.deepEqual(acpModeAgents({configOptions:[select("mode","mode","build",[["build","Build"],["plan","Plan"],["trebell-git-text","trebell-git-text"]])]}),[{name:"build",description:"Build"},{name:"plan",description:"Plan"},{name:"trebell-git-text"}]);
  assert.deepEqual(grokQuestionResponse([{question:"Proceed?",options:[{label:"Yes"},{label:"No"}]},{question:"Why?",options:[{label:"A"}]}],{"Proceed?":["Yes"],"Why?":["free text"]}),
    {outcome:"accepted",answers:{"Proceed?":["Yes"],"Why?":["Other"]},annotations:{"Why?":{notes:"free text"}}});
});

test("Grok's usage limit and errors read as Grok's own words",()=>{
  const limit=grokPromptError(acpRequestError({code:-32003,message:"Rate limited",data:"API error (status 429): You've used all the included free usage."}),{stopReason:"rate_limit",agentResult:null});
  assert.equal(limit.message,GROK_USAGE_LIMIT_MESSAGE+"\nAPI error (status 429): You've used all the included free usage.");assert.equal(limit.usageLimit,true);
  assert.equal(grokCompletionFailure({stopReason:"rate_limit",agentResult:null}).message,GROK_USAGE_LIMIT_MESSAGE);
  assert.equal(grokCompletionFailure({stopReason:"error",agentResult:"Tool crashed"}).message,"Tool crashed");
  assert.equal(grokCompletionFailure({stopReason:"end_turn"}),null);
  assert.equal(acpRequestError({code:-32603,message:"Internal error",data:{message:"Session not found"}}).message,"Session not found");
});

test("mode and model changes use the agent's config options, and read-only modes come from either shape",async()=>{
  const configOnly={configOptions:[select("mode","mode","build",["build","plan"]),select("model","model","opencode/big-pickle",["opencode/big-pickle","opencode/muse"])]};
  assert.equal(acpReadOnlyMode("opencode",configOnly),"plan","OpenCode lists its agents only as a config option");
  assert.equal(acpReadOnlyMode("cursor",configOnly),null,"Cursor's read-only mode is ask only");
  const calls=[],client={setConfigOption:async(sessionId,configId,value)=>{calls.push(["option",configId,value]);return {configOptions:configOnly.configOptions.map(option=>option.id===configId?{...option,currentValue:value}:option)}},setMode:async(...args)=>{calls.push(["mode",...args])},setModel:async(...args)=>{calls.push(["model",...args])}};
  const next=await acpApplyValue(client,"s",configOnly,"model","opencode/muse");
  assert.equal(acpConfigSelect(next,"model").current,"opencode/muse");
  await acpApplyValue(client,"s",{modes:{currentModeId:"default",availableModes:[{id:"default"},{id:"plan"}]}},"mode","plan");
  assert.deepEqual(calls,[["option","model","opencode/muse"],["mode","s","plan"]]);
});

test("tool updates merge into the tool's state and carry each harness's output, exit code and diff",()=>{
  const first=mergeAcpToolUpdate(undefined,{toolCallId:"t",title:"Run tests",kind:"execute",rawInput:{command:"npm test"}});
  const merged=mergeAcpToolUpdate(first,{toolCallId:"t",status:"completed",title:null,rawOutput:{combinedOutput:"ok\r\n",exitCode:0},content:[{type:"diff",path:"a.js",oldText:"x",newText:"y"},{type:"diff",path:"b.js",newText:"new"}]});
  const frame=acpToolFrame(merged);
  assert.equal(frame.title,"Run tests");assert.equal(frame.kind,"execute");assert.deepEqual(frame.rawInput,{command:"npm test"});
  assert.equal(frame.aggregatedOutput,"ok\r\n");assert.equal(frame.exitCode,0);
  assert.deepEqual(frame.changes,[{path:"a.js",kind:"update",oldText:"x",newText:"y"},{path:"b.js",kind:"add",newText:"new"}]);
  assert.equal(acpToolFrame({rawOutput:{output:[104,105],exit_code:2}}).aggregatedOutput,"hi");
});

test("Antigravity unpacks into a Trebell-owned run folder that is removed, and dead runs are swept",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-runtemp-"));t.after(()=>rm(root,{recursive:true,force:true}));
  assert.equal(acpRuntimeTempRoot({TEMP:root},"antigravity"),join(root,"trebell-antigravity"));
  const runRoot=join(root,"trebell-antigravity");await mkdir(join(runRoot,"run-999999-dead"),{recursive:true});await mkdir(join(runRoot,"run-1-alive"),{recursive:true});
  assert.deepEqual(await sweepRunTemps(runRoot,{isAlive:pid=>pid===1,ownPid:2}),["run-999999-dead"]);
  const run=await createRunTemp(join(root,"other"),{platform:"win32"});
  assert.deepEqual(run.env,{TEMP:run.dir,TMP:run.dir});
  await run.remove();assert.deepEqual(await readdir(join(root,"other")),[]);
});

test("a Cursor reply made only of a lost-connection diagnostic is a failure, a quoted one is not",()=>{
  const failure=new CursorTransportFailure();failure.push("Error: ConnectError: [unavailable] backend gone\n    at x (y.js:1:1)\n");
  assert.equal(failure.failure,"Error: ConnectError: [unavailable] backend gone");
  const quoted=new CursorTransportFailure();quoted.push("The log said:\nError: ConnectError: [unavailable] backend gone\n");
  assert.equal(quoted.failure,undefined);
});

test("model lists keep each harness's names, defaults and effort levels",()=>{
  const grok=grokModelCatalog({_meta:{modelState:GROK_MODELS}});
  assert.deepEqual(grok.models,["grok-4.7"]);assert.equal(grok.preferred,"grok-4.7");
  assert.deepEqual(grok.metadata[0],{id:"grok-4.7",name:"Grok 4.7",provider:"grok",agent:"Grok Build",contextWindow:256000,reasoningEfforts:["xhigh","high","low"],defaultReasoningEffort:"high",isDefault:true});
  assert.deepEqual(grokModelCatalog({}).models,[]);
  const thinking=select("thinking","thought_level","true",[["false","Off"],["true","On"]]),effort={...select("effort","thought_level","high",[["low","Low"],["high","High"],["xhigh","Extra High"],["max","Max"]]),name:"Effort"};
  assert.equal(cursorEffortOption([thinking,effort]).id,"effort","Cursor's thinking switch shares the thought_level category but is not its effort");
  assert.equal(cursorEffortOption([{...select("reasoning_effort","thought_level","high",["low","high"]),name:"Reasoning Effort"}]).id,"reasoning_effort");
  const cursor=cursorModelCatalog({models:[{value:"default",name:"Auto",configOptions:[]},{value:"claude-opus-5",name:"Claude Opus 5",configOptions:[thinking,effort]},{value:"",name:"broken"}]});
  assert.deepEqual(cursor.models,["default","claude-opus-5"]);assert.equal(cursor.preferred,"default");
  assert.deepEqual(cursor.metadata[1],{id:"claude-opus-5",name:"Claude Opus 5",provider:"cursor",agent:"Cursor",reasoningEfforts:["low","high","xhigh","max"],defaultReasoningEffort:"high",modelOptions:[{id:"thinking",label:"thinking",type:"boolean",defaultValue:"true"}]});
  const agy=antigravityModelCatalog(ANTIGRAVITY.sessionNew);
  assert.deepEqual(agy.models,["gemini-3.8-flash-high","gemini-3.1-pro-high"]);assert.equal(agy.preferred,"gemini-3.8-flash-high");
  assert.deepEqual(agy.metadata[0].aliases,["antigravity-default"]);assert.equal(agy.metadata[1].name,"Gemini 3.1 Pro (High)");
  assert.deepEqual(antigravitySeedCatalog().models,["gemini-3.8-flash-high","gemini-3.8-flash-medium","gemini-3.8-flash-low"]);
});

test("Cursor usage reads the login in %APPDATA%\\Cursor, and a Grok account with nothing metered is listed with its email",async()=>{
  const reads=[];
  const cursor=await readCursorUsageLimits({environment:{APPDATA:"C:\\Users\\me\\AppData\\Roaming"},platform:"win32",home:"C:\\Users\\me",joinPath:(...parts)=>parts.join("\\"),
    readText:async path=>{reads.push(path);return path.endsWith("Cursor\\auth.json")?JSON.stringify({accessToken:"cursor-token"}):null},
    fetchImpl:async(_url,options)=>({ok:true,status:200,json:async()=>({planUsage:{totalPercentUsed:12.5},billingCycleEnd:"1790000000000",auth:options.headers.authorization})})});
  assert.deepEqual(reads,["C:\\Users\\me\\AppData\\Roaming\\Cursor\\auth.json"]);assert.equal(cursor.windows[0].usedPercent,12.5);
  assert.deepEqual(grokUsageResponseToLimits({config:{currentPeriod:{type:"USAGE_PERIOD_TYPE_WEEKLY"}}},"2026-10-10T00:00:00.000Z"),{checkedAt:"2026-10-10T00:00:00.000Z",windows:[]});
  const credential={"https://accounts.x.ai/sign-in":{key:"grok-secret",email:"dev@example.test"}};
  const grok=await readGrokUsageLimits({environment:{GROK_AUTH:JSON.stringify(credential)},home:"/home/me",joinPath:(...parts)=>parts.join("/"),readText:async()=>null,fetchImpl:async()=>({ok:true,status:200,json:async()=>({config:{}})})});
  assert.deepEqual(grok.windows,[]);assert.equal(grok.unavailable,undefined);assert.deepEqual(grok.account,{email:"dev@example.test"});
  const failed=await readGrokUsageLimits({environment:{GROK_AUTH:JSON.stringify(credential)},home:"/home/me",joinPath:(...parts)=>parts.join("/"),readText:async()=>null,fetchImpl:async()=>({ok:false,status:500})});
  assert.equal(failed.unavailable.reason,"probeFailed");assert.deepEqual(failed.account,{email:"dev@example.test"},"a failed read still names the account it asked about");
});

test("Grok and Antigravity resume the thread's conversation with session/resume, keep its id and drop replayed history",async t=>{
  for(const runtime of ["grok","antigravity"]){
    const fx=await scenario(t,{...(runtime==="grok"?GROK:ANTIGRAVITY),replay:[{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"OLD HISTORY"}}],resumed:runtime==="grok"?{models:GROK_MODELS}:{models:ANTIGRAVITY.sessionNew.models}});
    const {session,updates}=harness(t,fx,{runtime});
    const started=await session.start({providerSessionId:"thread-conversation"});
    assert.equal(started.session.sessionId,"thread-conversation");assert.equal(session.sessionId,"thread-conversation");
    const log=await fx.log();
    assert.equal(requested(log,"session/resume")[0]?.params.sessionId,"thread-conversation");assert.equal(requested(log,"session/new").length,0);
    assert.equal(updates.some(update=>update?.content?.text==="OLD HISTORY"),false,"a resumed conversation is not replayed into the thread");
    await session.close();
  }
});

test("Cursor loads its conversation, and a conversation that cannot be resumed fails instead of starting over",async t=>{
  const cursor=await scenario(t,{...CURSOR,resumed:{models:CURSOR_SETUP.models}});
  const loaded=harness(t,cursor,{runtime:"cursor"});
  await loaded.session.start({providerSessionId:"cursor-thread"});
  assert.equal(requested(await cursor.log(),"session/load")[0]?.params.sessionId,"cursor-thread");
  const missing=await scenario(t,{...GROK,errors:{"session/resume":{code:-32603,message:"Internal error",data:{message:"Session not found"}}}});
  const {session}=harness(t,missing,{runtime:"grok"});
  await assert.rejects(session.start({providerSessionId:"gone"}),/Grok Build could not resume this conversation: Session not found/);
  assert.equal(requested(await missing.log(),"session/new").length,0,"no silent new conversation");
});

test("Cursor pins the thread's model in every session and sets effort with the model's own effort option",async t=>{
  const fx=await scenario(t,{...CURSOR,modelOptions:{"claude-opus-5":[select("thinking","thought_level","true",[["false","Off"],["true","On"]]),{...select("effort","thought_level","high",[["low","Low"],["high","High"],["xhigh","Extra High"]]),name:"Effort"}]}});
  const {session}=harness(t,fx,{runtime:"cursor"});
  session.setReasoningEffort("xhigh");
  await session.start({model:"claude-opus-5"});
  assert.equal(session.model,"claude-opus-5");
  const log=await fx.log(),options=requested(log,"session/set_config_option").map(entry=>[entry.params.configId,entry.params.value]);
  assert.deepEqual(options,[["model","claude-opus-5"],["effort","xhigh"]]);
  assert.deepEqual(requested(log,"initialize")[0].params.clientCapabilities._meta,{parameterizedModelPicker:true});
  const auto=await scenario(t,CURSOR),plain=harness(t,auto,{runtime:"cursor"});
  await plain.session.start({model:"cursor-default"});
  assert.deepEqual(requested(await auto.log(),"session/set_config_option").map(entry=>[entry.params.configId,entry.params.value]),[["model","default"]],"Cursor saves its model globally, so a thread without one runs on Auto explicitly");
  const other=harness(t,await scenario(t,CURSOR),{runtime:"cursor"});
  await assert.rejects(other.session.start({model:"gpt-9"}),/Cursor model 'gpt-9' is not available for this account/);
});

test("Grok gets Trebell's client type, lists its commands and runs the chosen effort through set_model",async t=>{
  const fx=await scenario(t,{...GROK,initialize:{...GROK.initialize,_meta:{availableCommands:[{name:"compact",description:"Compact"},{name:"always-approve",description:"x"},{name:"deep-research",description:"Research"}]}},prompts:[{},{},{}]});
  const {session,updates}=harness(t,fx,{runtime:"grok"});
  await session.start();
  assert.deepEqual(updates.find(update=>update.sessionUpdate==="available_commands_update").commands.map(command=>command.name),["compact","deep-research"]);
  session.setReasoningEffort("low");await session.prompt([{type:"text",text:"one"}]);
  session.setReasoningEffort(null);await session.prompt([{type:"text",text:"two"}]);
  await session.prompt([{type:"text",text:"/compact"}]);
  const log=await fx.log();
  assert.deepEqual(requested(log,"initialize")[0].params._meta,{clientType:"extension"});
  assert.deepEqual(requested(log,"session/set_model").map(entry=>[entry.params.modelId,entry.params._meta?.reasoningEffort]),[["grok-4.7","low"],["grok-4.7","high"]],"clearing the effort returns to the model's default once Trebell changed it");
  const prompts=requested(log,"session/prompt");
  assert.ok(prompts[0].params._meta.promptId);assert.equal(prompts[0].params.prompt.length,2,"the first turn carries Trebell's runtime notes");
  assert.deepEqual(prompts[2].params.prompt,[{type:"text",text:"/compact"}],"a slash command goes alone");
});

test("Antigravity runs each turn in its access level's mode and never sends the alias as a model",async t=>{
  const fx=await scenario(t,{...ANTIGRAVITY,prompts:[{},{}]});
  const {session}=harness(t,fx,{runtime:"antigravity",permissionMode:"full"});
  await session.start({model:"antigravity-default"});
  assert.equal(session.model,"gemini-3.8-flash-high");
  await session.prompt([{type:"text",text:"one"}]);
  session.setPermissionMode("supervised");await session.prompt([{type:"text",text:"two"}]);
  const log=await fx.log();
  assert.deepEqual(requested(log,"session/set_config_option").map(entry=>[entry.params.configId,entry.params.value]),[["mode","yolo"],["mode","default"]]);
  const other=harness(t,await scenario(t,ANTIGRAVITY),{runtime:"antigravity"});
  await assert.rejects(other.session.start({model:"gemini-9-ultra"}),/Antigravity model 'gemini-9-ultra' is unavailable for this Google account\. Select an available model\./);
});

test("Read only runs in the harness's read-only mode, and a harness without one gets no prompt",async t=>{
  const cursor=await scenario(t,{...CURSOR,prompts:[{}]});
  const {session}=harness(t,cursor,{runtime:"cursor",permissionMode:"read-only"});
  await session.start();await session.prompt([{type:"text",text:"look"}]);
  const log=await cursor.log(),modeChange=log.findIndex(entry=>entry.method==="session/set_config_option"&&entry.params.configId==="mode");
  assert.equal(log[modeChange].params.value,"ask");assert.ok(modeChange<log.findIndex(entry=>entry.method==="session/prompt"));
  const plain=await scenario(t,{sessionNew:{sessionId:"oc",configOptions:[select("mode","mode","build",["build"])]}});
  const other=harness(t,plain,{runtime:"opencode",permissionMode:"read-only"});
  await other.session.start();
  await assert.rejects(other.session.prompt([{type:"text",text:"look"}]),/does not offer a read-only mode, so the turn was not sent/);
  assert.equal(requested(await plain.log(),"session/prompt").length,0);
});

test("Cursor's questions, plans and todos reach the user and get Cursor's answers",async t=>{
  const fx=await scenario(t,{...CURSOR,prompts:[{steps:[
    {request:{method:"cursor/ask_question",params:{toolCallId:"q",title:"Setup",questions:[{id:"lang",prompt:"Which language?",options:[{id:"js",label:"JavaScript"},{id:"py",label:"Python"}],allowMultiple:false}]}}},
    {request:{method:"cursor/create_plan",params:{toolCallId:"p",name:"Plan",plan:"# Plan\n\n1. Port it",todos:[{id:"t1",content:"Port it",status:"pending"}]}}},
    {request:{method:"cursor/update_todos",params:{toolCallId:"u",todos:[{id:"t1",status:"completed"}],merge:true}}},
    {notify:{method:"cursor/update_todos",params:{toolCallId:"n",todos:[{id:"t2",content:"Test it",status:"in_progress"}],merge:true}}},
  ]}]});
  const asked=[];const {session,updates}=harness(t,fx,{runtime:"cursor",onQuestion:async({input})=>{asked.push(input.questions);return {lang:["Python"]}}});
  await session.start();await session.prompt([{type:"text",text:"plan it"}]);
  const log=await fx.log();
  assert.equal(asked[0][0].question,"Which language?");
  assert.deepEqual(reply(log,"cursor/ask_question"),{outcome:{outcome:"answered",answers:[{questionId:"lang",selectedOptionIds:["py"]}]}});
  assert.deepEqual(reply(log,"cursor/create_plan"),{outcome:{outcome:"accepted"}});
  assert.ok(updates.some(update=>update.sessionUpdate==="agent_message_chunk"&&update.content.text.includes("# Plan")));
  assert.deepEqual(updates.filter(update=>update.sessionUpdate==="plan").map(update=>update.entries),[
    [{content:"Port it",status:"pending"}],
    [{content:"Port it",status:"completed"}],
    [{content:"Port it",status:"completed"},{content:"Test it",status:"in_progress"}],
  ]);
});

test("ACP tool cards keep their title and kind to the end, with the command's output and the edit's diff",async t=>{
  const fx=await scenario(t,{...CURSOR,prompts:[{steps:[
    {update:{sessionUpdate:"tool_call",toolCallId:"cmd",title:"`echo trebell-probe`",kind:"execute",status:"pending",rawInput:{command:"echo trebell-probe"}}},
    {update:{sessionUpdate:"tool_call_update",toolCallId:"cmd",status:"in_progress"}},
    {update:{sessionUpdate:"tool_call_update",toolCallId:"cmd",status:"completed",rawOutput:{exitCode:0,stdout:"trebell-probe\n",stderr:""}}},
    {update:{sessionUpdate:"tool_call",toolCallId:"agy",title:"echo PARITY",kind:"execute",status:"pending"}},
    {update:{sessionUpdate:"tool_call_update",toolCallId:"agy",status:"completed",rawOutput:{commandLine:"echo PARITY",exitCode:0,combinedOutput:"PARITY\r\n"}}},
    {update:{sessionUpdate:"tool_call",toolCallId:"edit",title:"Edit File",kind:"edit",status:"pending"}},
    {update:{sessionUpdate:"tool_call_update",toolCallId:"edit",status:"completed",content:[{type:"diff",path:"notes.txt",oldText:"alpha\n",newText:"alpha\nbeta\n"}]}},
  ]}]});
  const {rpc,next,threadStore}=await relayHarness(t,"cursor",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"});
  const completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"go"}]});await completed;
  const items=threadStore.get(started.thread.id).turns.at(-1).items,item=id=>items.find(entry=>entry.id===id);
  assert.deepEqual([item("cmd").type,item("cmd").command,item("cmd").status,item("cmd").aggregatedOutput,item("cmd").exitCode],["commandExecution","`echo trebell-probe`","completed","trebell-probe\n",0]);
  assert.deepEqual([item("agy").type,item("agy").command,item("agy").aggregatedOutput,item("agy").exitCode],["commandExecution","echo PARITY","PARITY\r\n",0],"Antigravity's completion carries only status and rawOutput");
  assert.equal(item("edit").type,"fileChange");assert.deepEqual(item("edit").changes,[{path:"notes.txt",kind:"update",oldText:"alpha\n",newText:"alpha\nbeta\n"}]);
});

test("Grok's questions and plan exits get T3's answers, and Antigravity's choices are questions, never approvals",async t=>{
  const grok=await scenario(t,{...GROK,prompts:[{steps:[
    {request:{method:"_x.ai/ask_user_question",params:{method:"x.ai/ask_user_question",params:{questions:[{question:"Proceed?",options:[{label:"Yes"},{label:"No"}]}]}}}},
    {request:{method:"_x.ai/exit_plan_mode",params:{planContent:"# Plan\nShip it"}}},
  ]}]});
  const g=harness(t,grok,{runtime:"grok",onQuestion:async()=>({"Proceed?":["Yes"]})});
  await g.session.start();await g.session.prompt([{type:"text",text:"go"}]);
  const log=await grok.log();
  assert.deepEqual(reply(log,"_x.ai/ask_user_question"),{outcome:"accepted",answers:{"Proceed?":["Yes"]}});
  assert.deepEqual(reply(log,"_x.ai/exit_plan_mode"),{outcome:"abandoned",feedback:GROK_PLAN_FEEDBACK});
  assert.ok(g.updates.some(update=>update.sessionUpdate==="agent_message_chunk"&&update.content.text.includes("Ship it")));
  const agy=await scenario(t,{...ANTIGRAVITY,prompts:[{steps:[{request:{method:"session/request_permission",params:{sessionId:"$sessionId",toolCall:{toolCallId:"interaction_1",title:"Which database?"},options:[{optionId:"pg",name:"Postgres",kind:"allow_once"},{optionId:"sqlite",name:"SQLite",kind:"allow_once"}]}}}]}]});
  let permissions=0;
  const a=harness(t,agy,{runtime:"antigravity",permissionMode:"full",onPermission:async()=>{permissions++;return "accept"},onQuestion:async({input})=>({[input.questions[0].id]:["SQLite"]})});
  await a.session.start();await a.session.prompt([{type:"text",text:"set up"}]);
  assert.deepEqual(reply(await agy.log(),"session/request_permission"),{outcome:{outcome:"selected",optionId:"sqlite"}});
  assert.equal(permissions,0,"even full access never answers Antigravity's question for the user");
});

test("Grok Auto sends what Grok asks about to the user with Grok's choices",async t=>{
  const options=[{optionId:"allow-once",kind:"allow_once",name:"Allow once"},{optionId:"allow-edits-session",kind:"allow_always",name:"Allow edits"},{optionId:"always",kind:"allow_always",name:"Always"},{optionId:"reject-once",kind:"reject_once",name:"Reject"}];
  const fx=await scenario(t,{...GROK,prompts:[{steps:[{request:{method:"session/request_permission",params:{sessionId:"$sessionId",toolCall:{toolCallId:"t1",title:"Edit a.js",kind:"edit"},options}}}]}]});
  const seen=[];const {session}=harness(t,fx,{runtime:"grok",permissionMode:"auto",onPermission:async request=>{seen.push(request);return "acceptForSession"}});
  await session.start();await session.prompt([{type:"text",text:"edit"}]);
  assert.equal(seen[0].askUser,true);assert.deepEqual(seen[0].approvalOptions.map(option=>option.decision),["cancel","decline","acceptForSession","accept"]);
  assert.deepEqual(reply(await fx.log(),"session/request_permission"),{outcome:{outcome:"selected",optionId:"allow-edits-session"}});
});

test("a Grok usage limit fails the turn with the limit message and Grok's detail",async t=>{
  const fx=await scenario(t,{...GROK,prompts:[{steps:[{notify:{method:"_x.ai/session/prompt_complete",params:{sessionId:"$sessionId",promptId:"$promptId",stopReason:"rate_limit",agentResult:null}}}],error:{code:-32003,message:"Rate limited",data:"API error (status 429): You've used all the included free usage."}}]});
  const {session}=harness(t,fx,{runtime:"grok"});
  await session.start();
  await assert.rejects(session.prompt([{type:"text",text:"hi"}]),error=>error.usageLimit===true&&error.message===GROK_USAGE_LIMIT_MESSAGE+"\nAPI error (status 429): You've used all the included free usage.");
});

test("Grok's answer after a finished turn opens a wake turn that its turn_completed ends",async t=>{
  const fx=await scenario(t,{...GROK,prompts:[{after:[
    {delay:150,meta:{promptId:"task-completed-7"},update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Background task finished."}}},
    {delay:50,notify:{method:"_x.ai/session_notification",params:{sessionId:"$sessionId",update:{sessionUpdate:"turn_completed",prompt_id:"task-completed-7",stop_reason:"end_turn"}}}},
  ]}]});
  const wakes=[];const {session}=harness(t,fx,{runtime:"grok",onWakeTurn:promise=>wakes.push(promise)});
  await session.start();await session.prompt([{type:"text",text:"start a background task"}]);
  assert.ok(await until(()=>wakes.length===1));
  assert.deepEqual(await wakes[0],{stopReason:"end_turn"});assert.equal(session.busy,false);
});

test("Stop answers a waiting approval as cancelled with Grok's Ctrl+C marker and stops Grok once the turn settles",async t=>{
  const fx=await scenario(t,{...GROK,prompts:[{steps:[{request:{method:"session/request_permission",params:{sessionId:"$sessionId",toolCall:{toolCallId:"t1",title:"Run tests",kind:"execute"},options:[{optionId:"once",kind:"allow_once"},{optionId:"no",kind:"reject_once"}]}}},{hang:true}]}]});
  let asked;const waiting=new Promise(resolve=>{asked=resolve});
  const {session}=harness(t,fx,{runtime:"grok",onPermission:()=>{asked();return new Promise(()=>{})}});
  await session.start();
  const running=session.prompt([{type:"text",text:"test"}]);
  await waiting;session.cancel();
  assert.deepEqual(await running,{stopReason:"cancelled"});
  assert.ok(await until(()=>session.dead&&session.client.closed),"Grok's process is stopped so its background tasks end too");
  const log=await fx.log();
  assert.deepEqual(reply(log,"session/request_permission"),{outcome:{outcome:"cancelled"}});
  assert.deepEqual(log.find(entry=>entry.method==="session/cancel").params._meta,{cancelTrigger:"ctrl_c"});
});

test("a harness that exits mid-turn fails the turn and leaves a dead session behind",async t=>{
  const fx=await scenario(t,{prompts:[{steps:[{exit:3}]}]});
  const {session,updates}=harness(t,fx,{runtime:"opencode"});
  await session.start();
  await assert.rejects(session.prompt([{type:"text",text:"hi"}]));
  assert.equal(session.dead,true);assert.ok(updates.some(update=>update.sessionUpdate==="runtime_error"));
});

test("file writes create missing folders, Antigravity writes without a second approval and Read only refuses",async t=>{
  const fx=await scenario(t,root=>({...ANTIGRAVITY,prompts:[{steps:[
    {request:{method:"fs/write_text_file",params:{sessionId:"$sessionId",path:join(root,"new","dir","a.txt"),content:"hello"}}},
    {request:{method:"fs/read_text_file",params:{sessionId:"$sessionId",path:join(root,"crlf.txt"),line:2,limit:1}}},
  ]}]}));
  await writeFile(join(fx.root,"crlf.txt"),"one\r\ntwo\r\nthree\r\n","utf8");
  let permissions=0;const {session}=harness(t,fx,{runtime:"antigravity",onPermission:async()=>{permissions++;return "accept"}});
  await session.start();await session.prompt([{type:"text",text:"write"}]);
  assert.equal(await readFile(join(fx.root,"new","dir","a.txt"),"utf8"),"hello");assert.equal(permissions,0);
  assert.deepEqual(reply(await fx.log(),"fs/read_text_file"),{content:"two\r"});
  const readOnly=await scenario(t,root=>({...ANTIGRAVITY,prompts:[{steps:[{request:{method:"fs/write_text_file",params:{sessionId:"$sessionId",path:join(root,"blocked.txt"),content:"x"}}}]}]}));
  const other=harness(t,readOnly,{runtime:"antigravity",permissionMode:"read-only"});
  await other.session.start();await other.session.prompt([{type:"text",text:"write"}]);
  assert.match(reply(await readOnly.log(),"fs/write_text_file").error.message,/denied/);
  await assert.rejects(access(join(readOnly.root,"blocked.txt")));
});

test("only Antigravity is offered the client's files and no harness its terminal; other requests are refused without a second approval",async t=>{
  assert.deepEqual(acpClientCapabilities("antigravity").fs,{readTextFile:true,writeTextFile:true});
  for(const runtime of ["antigravity","grok","cursor","opencode"])assert.equal(acpClientCapabilities(runtime).terminal,false,runtime);
  for(const runtime of ["grok","cursor","opencode"])assert.deepEqual(acpClientCapabilities(runtime).fs,{readTextFile:false,writeTextFile:false},runtime);
  assert.deepEqual(acpClientCapabilities("cursor")._meta,{parameterizedModelPicker:true});
  // OpenCode's ACP server writes an approved edit through the client as well as itself; supervised, that was a second card.
  const fx=await scenario(t,root=>({initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:{sessionId:"ses_remote"},prompts:[{steps:[
    {request:{method:"fs/write_text_file",params:{sessionId:"$sessionId",path:join(root,"edit.txt"),content:"proposed"}}},
    {request:{method:"fs/read_text_file",params:{sessionId:"$sessionId",path:join(root,"README.md")}}},
    {request:{method:"terminal/create",params:{sessionId:"$sessionId",command:"echo hi",args:[]}}},
  ]}]}));
  let permissions=0;const {session}=harness(t,fx,{runtime:"opencode",permissionMode:"supervised",onPermission:async()=>{permissions++;return "accept"}});
  await session.start();await session.prompt([{type:"text",text:"edit"}]);
  const log=await fx.log();
  assert.deepEqual(requested(log,"initialize")[0].params.clientCapabilities.fs,{readTextFile:false,writeTextFile:false});
  assert.equal(requested(log,"initialize")[0].params.clientCapabilities.terminal,false);
  for(const method of ["fs/write_text_file","fs/read_text_file","terminal/create"])assert.equal(reply(log,method).error?.code,-32601,method);
  assert.equal(permissions,0,"no approval card for a write the harness makes itself");
  await assert.rejects(access(join(fx.root,"edit.txt")));
});

test("Antigravity is granted Trebell's attachments folder, its client files stay inside the roots through links, and text attachments are embedded",async t=>{
  const fx=await scenario(t,root=>({...ANTIGRAVITY,prompts:[{steps:[
    {request:{method:"fs/read_text_file",params:{sessionId:"$sessionId",path:join(root,"attachments","1-ab-pasted-context.txt")}}},
    {request:{method:"fs/read_text_file",params:{sessionId:"$sessionId",path:join(root,"outside","secret.txt")}}},
    {request:{method:"fs/read_text_file",params:{sessionId:"$sessionId",path:join(root,"work","link","secret.txt")}}},
    {request:{method:"fs/write_text_file",params:{sessionId:"$sessionId",path:join(root,"work","link","planted.txt"),content:"x"}}},
  ]}]}));
  const work=join(fx.root,"work"),attachments=join(fx.root,"attachments"),outside=join(fx.root,"outside");
  await mkdir(work,{recursive:true});await mkdir(outside,{recursive:true});
  await writeFile(join(outside,"secret.txt"),"outside","utf8");
  // A junction needs no privilege on Windows; elsewhere the type is ignored and a folder link is made.
  await symlink(outside,join(work,"link"),"junction");
  const {session}=harness(t,fx,{runtime:"antigravity",cwd:work,attachmentsDir:attachments,permissionMode:"full"});
  await session.start();
  await writeFile(join(attachments,"1-ab-pasted-context.txt"),"The secret word is PERIWINKLE.\n","utf8");
  await writeFile(join(attachments,"2-cd-report.pdf"),"%PDF-1.4","utf8");
  const pasted=join(attachments,"1-ab-pasted-context.txt"),pdf=join(attachments,"2-cd-report.pdf");
  await session.prompt([{type:"text",text:"what is the secret word?"},{type:"resource_link",uri:pathToFileURL(pasted).href,name:"1-ab-pasted-context.txt"},{type:"resource_link",uri:pathToFileURL(pdf).href,name:"2-cd-report.pdf"}]);
  const log=await fx.log();
  assert.deepEqual(requested(log,"session/new")[0].params.additionalDirectories,[attachments],"the attachments folder is granted, as T3 grants it");
  const sent=requested(log,"session/prompt")[0].params.prompt;
  assert.deepEqual(sent[1],{type:"resource",resource:{uri:pathToFileURL(pasted).href,mimeType:"text/plain",text:"The secret word is PERIWINKLE.\n"}},"the pasted text goes as embedded content");
  assert.deepEqual(sent[2],{type:"resource_link",uri:pathToFileURL(pdf).href,name:"2-cd-report.pdf"},"other files stay links");
  const replies=log.filter(entry=>entry.reply==="fs/read_text_file").map(entry=>entry.message);
  assert.deepEqual(replies[0],{content:"The secret word is PERIWINKLE.\n"},"a file in the attachments folder is served");
  assert.equal(replies[1].error?.code,-32602,"a file outside the workspace and the attachments folder is refused");
  assert.equal(replies[2].error?.code,-32602,"a link inside the workspace does not reach outside it");
  assert.equal(reply(log,"fs/write_text_file").error?.code,-32602,"nor does a write through it");
  await assert.rejects(access(join(outside,"planted.txt")));
  const resumed=harness(t,fx,{runtime:"antigravity",cwd:work,attachmentsDir:attachments});
  await resumed.session.start({providerSessionId:"agy-session"});
  assert.deepEqual(requested(await fx.log(),"session/resume")[0].params.additionalDirectories,[attachments],"a resumed session is granted it too");
  const grok=await scenario(t,GROK);const other=harness(t,grok,{runtime:"grok",attachmentsDir:attachments});
  await other.session.start();
  assert.equal("additionalDirectories" in requested(await grok.log(),"session/new")[0].params,false,"only Antigravity is granted it");
});

test("Grok and Cursor model lists come from the harness and Antigravity's from its sessions",{skip:process.platform!=="win32"&&"uses a Windows .cmd launcher"},async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-models-"));onCleanup(t,()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const fixture=join(root,"grok.mjs"),launcher=join(root,"grok.cmd");
  await writeFile(fixture,String.raw`
import readline from "node:readline";
const args=process.argv.slice(2),send=message=>process.stdout.write(JSON.stringify(message)+"\n");
if(args[0]==="--version")process.stdout.write("grok 1.0.0-fixture\n");
else if(args[0]==="models")process.stdout.write("You are logged in with grok.com.\n");
else readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);
  if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentCapabilities:{},_meta:{clientTypeSeen:m.params._meta?.clientType,modelState:${JSON.stringify(GROK_MODELS)},availableCommands:[{name:"compact",description:"Compact the context"},{name:"always-approve",description:"x"},{name:"deep-research",description:"Research",input:{hint:"topic"}}]}}});
  else if(m.id!=null)send({jsonrpc:"2.0",id:m.id,result:{}});
});
`,"utf8");
  await writeFile(launcher,["@echo off",`"${process.execPath}" "${fixture}" %*`,""].join("\r\n"),"utf8");
  const env={...process.env,TREBELL_HOME:join(root,"home")};delete env.XAI_API_KEY;
  const manager=new AgentRuntimeManager({state:new TrebellStateStore(env),env,platform:"win32"});
  const grok=manager.upsertInstance({id:"grok-fixture",kind:"grok",displayName:"Grok fixture",binaryPath:launcher});
  const listed=await manager.models(grok);
  assert.equal(listed.error,undefined);assert.deepEqual(listed.models,["grok-4.7"]);assert.equal(listed.preferred,"grok-4.7");
  assert.deepEqual(listed.metadata[0].reasoningEfforts,["xhigh","high","low"]);assert.equal(listed.metadata[0].contextWindow,256000);
  // The same initialize answer fills a new chat's slash menu before its thread exists (T3 grokSlashCommandsFromInitialize).
  assert.deepEqual(listed.inventory,{commands:[{name:"compact",description:"Compact the context"},{name:"deep-research",description:"Research",input:{hint:"topic"}}]});
  // Antigravity is built in (one profile); a launcher that only answers --version keeps the listing from starting anything.
  const agyLauncher=join(root,"agy.cmd");await writeFile(agyLauncher,["@echo off","echo 1.2.1",""].join("\r\n"),"utf8");
  const agy=manager.upsertInstance({id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",binaryPath:agyLauncher});
  manager.rememberAcpSessionModels(agy,ANTIGRAVITY.sessionNew);
  const agyModels=await manager.models(agy);
  assert.equal(agyModels.source,"session");assert.deepEqual(agyModels.models,["gemini-3.8-flash-high","gemini-3.1-pro-high"]);assert.equal(agyModels.preferred,"gemini-3.8-flash-high");
});

test("remote file writes create the parent folder first",async()=>{
  const calls=[],profile={id:"ssh-fixture",type:"ssh",cwd:"/srv/app"};
  const environments={get:id=>id===profile.id?profile:null,executeArgv:async(id,options)=>{calls.push(options);return {exitCode:0,stdout:"",stderr:""}}};
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:"ssh-fixture"})},environments});
  await manager.remoteIo("/srv/app","ssh-fixture").writeText("new/dir/a.txt","hi");
  assert.equal(calls[0].args[1],'mkdir -p "$(dirname "$2")" && printf %s "$1" | base64 -d > "$2"');
  assert.equal(calls[0].args.at(-1),"/srv/app/new/dir/a.txt");
});

test("a slash command the harness lists goes alone, without Trebell's working context or runtime notes",async t=>{
  const evidence={"trebell.repo_evidence":{kind:"untrusted",value:"src/a.js: export const a=1;"}};
  const command=await contextualAgentPrompt([{type:"text",text:"/deep-research ACP slash commands"}],evidence,{runtime:"grok"});
  const ordinary=await contextualAgentPrompt([{type:"text",text:"/tmp is full, clean it"}],evidence,{runtime:"grok"});
  assert.equal(command.length,2,"the relay puts its fenced context before the user's text");
  const names=new Set(["deep-research"]);
  assert.deepEqual(acpSlashCommandPrompt(command,names),[{type:"text",text:"/deep-research ACP slash commands"}]);
  assert.equal(acpSlashCommandPrompt(ordinary,names),null,"text that only looks like a command keeps its context");
  assert.deepEqual(acpSlashCommandPrompt([{type:"text",text:"/compact"}],new Set()),[{type:"text",text:"/compact"}],"a lone slash text is a command");
  assert.equal(acpSlashCommandPrompt([{type:"text",text:"Run /deep-research later"}],names),null);
  const fx=await scenario(t,{...GROK,initialize:{...GROK.initialize,_meta:{availableCommands:[{name:"deep-research",description:"Research"}]}},prompts:[{},{}]});
  const {session}=harness(t,fx,{runtime:"grok"});
  await session.start();
  await session.prompt(command);await session.prompt(ordinary);
  const prompts=requested(await fx.log(),"session/prompt");
  assert.deepEqual(prompts[0].params.prompt,[{type:"text",text:"/deep-research ACP slash commands"}],"Grok runs a command only when the message starts with it");
  assert.equal(prompts[1].params.prompt.length,3,"the next ordinary turn keeps the context and gets the runtime notes the command skipped");
  assert.match(prompts[1].params.prompt[0].text,/src\/a\.js/);assert.equal(prompts[1].params.prompt[1].text,"/tmp is full, clean it");
});

test("Cursor's Fast switch follows the composer's speed after the model, and stays as it is until a turn names one",async t=>{
  const fastSelect=current=>({...select("fast","model_config",current,[["false","Off"],["true","On"]]),name:"Fast"});
  assert.equal(cursorFastOption([select("context","model_config","300k",["300k","1m"]),fastSelect("false")]).id,"fast");
  assert.equal(cursorFastOption([{...select("fast","thought_level","false",["false","true"]),name:"Fast"}]),null,"only Cursor's model_config switch is its Fast mode");
  assert.equal(cursorSwitchValue(fastSelect("false"),true),"true");assert.equal(cursorSwitchValue({id:"fast",type:"boolean"},false),false);
  const catalog=cursorModelCatalog({models:[{value:"default",name:"Auto",configOptions:[]},{value:"claude-opus-5",name:"Claude Opus 5",configOptions:[fastSelect("false")]}]});
  assert.deepEqual(supportedModelServiceTiers("cursor",null,"claude-opus-5",catalog.metadata[1]),["fast"],"the composer's Speed picker offers Fast for the model");
  assert.deepEqual(supportedModelServiceTiers("cursor",null,"default",catalog.metadata[0]),[]);
  const fx=await scenario(t,{...CURSOR,modelOptions:{"claude-opus-5":[fastSelect("false")]},prompts:[{},{}]});
  const {session}=harness(t,fx,{runtime:"cursor"});
  session.setServiceTier("fast");
  await session.start({model:"claude-opus-5"});
  await session.prompt([{type:"text",text:"one"}]);
  session.setServiceTier(null);await session.prompt([{type:"text",text:"two"}]);
  const changes=log=>requested(log,"session/set_config_option").map(entry=>[entry.params.configId,entry.params.value]);
  assert.deepEqual(changes(await fx.log()),[["model","claude-opus-5"],["fast","true"],["fast","false"]],"Standard turns Fast off again; an unchanged speed sends nothing");
  const untouched=await scenario(t,{...CURSOR,modelOptions:{"claude-opus-5":[fastSelect("true")]}});
  const other=harness(t,untouched,{runtime:"cursor"});
  await other.session.start({model:"claude-opus-5"});
  assert.deepEqual(changes(await untouched.log()),[["model","claude-opus-5"]]);
});

test("Cursor's other model settings (context, thinking) are listed per model, kept per model, and set after the model only once picked",async t=>{
  const opus=[
    {...select("effort","thought_level","high",["low","medium","high","max"]),name:"Effort"},
    {...select("fast","model_config","false",[["false","Off"],["true","On"]]),name:"Fast"},
    {...select("context","model_config","300k",[["300k","300K"],["1m","1M"]]),name:"Context"},
    {...select("thinking","thought_level","true",[["false","Off"],["true","On"]]),name:"Thinking"},
  ];
  assert.deepEqual(cursorModelOptions(opus),[
    {id:"context",label:"Context",type:"select",choices:[{value:"300k",label:"300K"},{value:"1m",label:"1M"}],defaultValue:"300k"},
    {id:"thinking",label:"Thinking",type:"boolean",defaultValue:"true"},
  ],"effort and Fast keep their own pickers; a true/false choice is a switch, as T3 shows it");
  assert.deepEqual(cursorModelOptions([select("model","model","default",["default"]),{id:"max",name:"Max",category:"model_config",type:"boolean",currentValue:false}]),[{id:"max",label:"Max",type:"boolean",defaultValue:"false"}]);
  const catalog=cursorModelCatalog({models:[{value:"default",name:"Auto",configOptions:[]},{value:"claude-opus-5",name:"Claude Opus 5",configOptions:opus}]});
  assert.equal(catalog.metadata[0].modelOptions,undefined);
  const offered=supportedModelOptions(catalog.metadata[1]);
  assert.deepEqual(offered.map(option=>[option.id,option.type,option.choices.map(choice=>choice.label),option.defaultValue]),[["context","select",["300K","1M"],"300k"],["thinking","boolean",["On","Off"],"true"]]);
  // The picks are kept per runtime, provider and model; a pick the model no longer offers is not sent.
  let settings={modelOptionValues:modelOptionSettingsWith({},"cursor","openai","claude-opus-5","context","1m")};
  settings={modelOptionValues:modelOptionSettingsWith(settings,"cursor","openai","claude-opus-5","thinking","false")};
  assert.deepEqual(settings.modelOptionValues,{"cursor:openai:claude-opus-5":{context:"1m",thinking:"false"}});
  assert.deepEqual(configuredModelOptions({modelOptionValues:{"cursor:openai:claude-opus-5":{context:"2m",thinking:"false",gone:"x"}}},"cursor","openai","claude-opus-5",catalog.metadata[1]),{thinking:"false"});
  assert.deepEqual(modelOptionSettingsWith(settings,"cursor","openai","claude-opus-5","thinking",""),{"cursor:openai:claude-opus-5":{context:"1m"}});
  const home=await mkdtemp(join(tmpdir(),"trebell-model-options-"));onCleanup(t,()=>rm(home,{recursive:true,force:true}));
  const store=new TrebellStateStore({...process.env,TREBELL_HOME:home});
  assert.deepEqual(store.settings().modelOptionValues,{});
  assert.deepEqual(store.updateSettings({modelOptionValues:{"cursor:openai:claude-opus-5":{context:" 1m ",thinking:false,"bad id":"x",empty:""},"cursor:openai:auto":"fast","cursor:openai:none":{}}}).modelOptionValues,{"cursor:openai:claude-opus-5":{context:"1m",thinking:"false"}});
  // A session sets the picked settings after the model, only where they differ, and leaves the others as Cursor has them.
  const fx=await scenario(t,{...CURSOR,modelOptions:{"claude-opus-5":opus},prompts:[{},{}]});
  const {session}=harness(t,fx,{runtime:"cursor"});
  session.setModelOptions({context:"1m",thinking:"false",unknown:"x"});
  await session.start({model:"claude-opus-5"});
  await session.prompt([{type:"text",text:"one"}]);
  session.setModelOptions({context:"1m"});await session.prompt([{type:"text",text:"two"}]);
  const changes=requested(await fx.log(),"session/set_config_option").map(entry=>[entry.params.configId,entry.params.value]);
  assert.deepEqual(changes,[["model","claude-opus-5"],["context","1m"],["thinking","false"]]);
});

test("remote OpenCode starts on the thread's model and runs each turn as the chosen agent through its config options",async t=>{
  const configOptions=[select("model","model","opencode/big-pickle",[["opencode/big-pickle","Big Pickle"],["opencode/muse","Muse"]]),select("mode","mode","build",[["build","build"],["plan","plan"]])];
  const fx=await scenario(t,{initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:{sessionId:"ses_remote",configOptions},prompts:[{steps:[{update:{sessionUpdate:"available_commands_update",availableCommands:[{name:"review",description:"Review changes"}]}}]},{}]});
  const {session,updates}=harness(t,fx,{runtime:"opencode"});
  const started=await session.start({model:"opencode/muse"});
  assert.equal(session.model,"opencode/muse","the model OpenCode reports back is the one Trebell records");
  assert.equal(started.session.models,undefined,"OpenCode over ACP sends only config options");
  assert.deepEqual(updates.find(update=>update.sessionUpdate==="config_option_update").agents,[{name:"build"},{name:"plan"}]);
  await session.prompt([{type:"text",text:"plan it"}],{agent:"plan"});
  await session.prompt([{type:"text",text:"build it"}],{agent:null});
  const log=await fx.log(),order=log.filter(entry=>entry.method==="session/set_config_option"||entry.method==="session/prompt").map(entry=>entry.method==="session/prompt"?"prompt":`${entry.params.configId}=${entry.params.value}`);
  assert.deepEqual(order,["model=opencode/muse","mode=plan","prompt","mode=build","prompt"]);
  assert.equal(requested(log,"session/set_model").length+requested(log,"session/set_mode").length,0,"OpenCode lists no models or modes objects");
  assert.deepEqual(updates.find(update=>update.sessionUpdate==="available_commands_update").commands,[{name:"review",description:"Review changes"}]);
});

test("a remote OpenCode model list is a throwaway session's model option, whose current value is OpenCode's default",async t=>{
  const fx=await scenario(t,{initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:{sessionId:"ses_probe",configOptions:[select("model","model","opencode/big-pickle",[["opencode/muse","Muse"],["opencode/big-pickle","Big Pickle"]]),select("mode","mode","build",["build","plan"])]}});
  const profile={id:"ssh-opencode",type:"ssh",cwd:"/srv/app"},executes=[],spawns=[];
  const environments={
    get:id=>id===profile.id?profile:null,
    executeArgv:async(_id,options)=>{executes.push(options.args);return options.args[0]==="--version"?{exitCode:0,stdout:"1.18.32\n",stderr:""}:{exitCode:options.args[0]==="session"?0:1,stdout:"",stderr:""}},
    // The remote shell is played by the local scenario agent.
    spawnArgv:(_id,options)=>{spawns.push(options.args);return spawn(process.execPath,fx.args,{env:fx.env,stdio:options.stdio,windowsHide:true})},
  };
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,env:{...process.env,TREBELL_HOME:join(fx.root,"home")}});
  const listed=await manager.models("opencode");
  assert.equal(listed.error,undefined);assert.equal(listed.source,"live");
  assert.deepEqual(listed.models,["opencode/muse","opencode/big-pickle"]);assert.equal(listed.preferred,"opencode/big-pickle","the composer starts on OpenCode's own default");
  assert.equal(listed.metadata.find(row=>row.id==="opencode/muse").name,"Muse");
  assert.deepEqual(spawns,[["acp"]]);
  assert.deepEqual(executes.find(args=>args[0]==="session"),["session","delete","ses_probe"],"the listing session is deleted afterwards");
});

// The relay with a scripted harness: approvals, Stop, Antigravity revert and Grok /compact.
function scenarioRuntimeManager(kind,fx){
  const instance={id:`${kind}-default`,kind,displayName:kind,enabled:true};
  return {
    instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>kind,compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:kind,available:true,authenticated:true,version:"fixture"}),
    // Like Cursor's and Grok's, the scripted harness takes its permission mode as a launch argument.
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...fx.env}),executable:()=>process.execPath,acpArgs:(_instance,mode)=>[...fx.args,"--trebell-mode",String(mode)],
    // Trebell's home (attachments, tool outputs) stays inside the scenario.
    env:{...process.env,TREBELL_HOME:join(fx.root,"home")},
  };
}
function memoryState(){
  const meta=new Map();
  return {settings:()=>({activeEnvironmentId:null}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
}
async function relayHarness(t,kind,fx,{runtimeManager=scenarioRuntimeManager(kind,fx)}={}){
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(fx.root,"home")});
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state:memoryState(),version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket("ws://127.0.0.1:"+server.address().port+"/api/agent/ws");await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  onCleanup(t,async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()))});
  let id=0;
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id;const onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
  const next=(predicate,ms=15_000)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.off("message",onMessage);reject(new Error("timed out waiting for a relay message"))},ms);
    const onMessage=raw=>{const message=JSON.parse(String(raw));if(!predicate(message))return;clearTimeout(timer);ws.off("message",onMessage);resolve(message)};
    ws.on("message",onMessage);
  });
  return {ws,rpc,next,threadStore};
}

test("Stop withdraws an ACP harness's waiting approval card and answers the harness as cancelled",async t=>{
  const fx=await scenario(t,{...GROK,prompts:[{steps:[{request:{method:"session/request_permission",params:{sessionId:"$sessionId",toolCall:{toolCallId:"t1",title:"Run tests",kind:"execute",rawInput:{command:"npm test"}},options:[{optionId:"once",kind:"allow_once"},{optionId:"no",kind:"reject_once"}]}}},{hang:true}]}]});
  const {rpc,next}=await relayHarness(t,"grok",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const approval=next(message=>message.method==="item/tool/requestApproval");
  await rpc("turn/start",{threadId,input:[{type:"text",text:"run the tests"}]});
  const request=await approval;
  assert.deepEqual(request.params.approvalOptions.map(option=>option.label),["Cancel","Decline","Approve"]);
  const resolved=next(message=>message.method==="serverRequest/resolved"),completed=next(message=>message.method==="turn/completed");
  await rpc("turn/interrupt",{threadId});
  assert.deepEqual((await resolved).params,{requestId:request.id,threadId});
  assert.equal((await completed).params.turn.status,"cancelled");
  assert.ok(await until(async()=>reply(await fx.log(),"session/request_permission")));
  assert.deepEqual(reply(await fx.log(),"session/request_permission"),{outcome:{outcome:"cancelled"}});
});

test("in Grok Auto the requests Grok asks about reach the user even when Trebell's policy would allow them",async t=>{
  const fx=await scenario(t,{...GROK,prompts:[{steps:[{request:{method:"session/request_permission",params:{sessionId:"$sessionId",toolCall:{toolCallId:"t1",title:"Read src/a.js",kind:"read"},options:[{optionId:"once",kind:"allow_once"},{optionId:"no",kind:"reject_once"}]}}}]}]});
  const {ws,rpc,next}=await relayHarness(t,"grok",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"never",sandbox:"workspace-write"});
  const approval=next(message=>message.method==="item/tool/requestApproval"),completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"read it"}]});
  const request=await approval;ws.send(JSON.stringify({id:request.id,result:{decision:"accept"}}));
  assert.equal((await completed).params.turn.status,"completed");
  assert.deepEqual(reply(await fx.log(),"session/request_permission"),{outcome:{outcome:"selected",optionId:"once"}});
});

test("a new access level relaunches Grok in that mode and resumes the same conversation; a dead process does the same",async t=>{
  const fx=await scenario(t,{...GROK,prompts:[{},{},{steps:[{exit:1}]},{}]});
  const {rpc,next,threadStore}=await relayHarness(t,"grok",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const turn=async(params,text)=>{const completed=next(message=>message.method==="turn/completed");await rpc("turn/start",{threadId,input:[{type:"text",text}],...params});return (await completed).params.turn.status};
  assert.equal(await turn({},"one"),"completed");
  assert.equal(await turn({approvalPolicy:"never",sandbox:"workspace-write"},"two"),"completed");
  assert.equal(await turn({},"three"),"failed","the process exits mid-turn");
  assert.equal(await turn({},"four"),"completed","the next turn starts Grok again");
  const log=await fx.log();
  assert.deepEqual(log.filter(entry=>entry.launch).map(entry=>entry.launch.at(-1)),["supervised","auto","auto"]);
  assert.deepEqual(requested(log,"session/resume").map(entry=>entry.params.sessionId),["grok-session","grok-session"]);
  assert.equal(requested(log,"session/new").length,1,"the conversation is never started over");
  assert.ok(requested(log,"session/prompt").every(entry=>entry.params.sessionId==="grok-session"));
  assert.equal(threadStore.get(threadId).providerSessionId,"grok-session");
});

test("an Antigravity revert cuts the thread and the next turn starts a fresh Antigravity session",async t=>{
  const fx=await scenario(t,{...ANTIGRAVITY,prompts:[{},{},{}]});
  const {rpc,next,threadStore}=await relayHarness(t,"antigravity",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const turns=[];
  for(const text of ["first","second"]){const completed=next(message=>message.method==="turn/completed");turns.push((await rpc("turn/start",{threadId,input:[{type:"text",text}]})).turn);await completed}
  const reverted=next(message=>message.method==="thread/reverted");
  const result=await rpc("thread/revert",{threadId,beforeTurnId:turns[1].id});await reverted;
  assert.deepEqual(result.thread.turns.map(turn=>turn.id),[turns[0].id]);assert.equal(threadStore.get(threadId).providerSessionId,"");
  const completed=next(message=>message.method==="turn/completed");await rpc("turn/start",{threadId,input:[{type:"text",text:"again"}]});await completed;
  const log=await fx.log();
  assert.equal(requested(log,"session/new").length,2,"the next turn runs in a new Antigravity session");assert.equal(requested(log,"session/resume").length,0);
});

test("an Antigravity turn's pasted text reaches it as embedded content, in a session granted Trebell's attachments folder",async t=>{
  const fx=await scenario(t,{...ANTIGRAVITY,prompts:[{}]});
  const {rpc,next}=await relayHarness(t,"antigravity",fx);
  const attachments=join(fx.root,"home","attachments"),pasted=join(attachments,"1-ab-pasted-context.txt");
  await mkdir(attachments,{recursive:true});await writeFile(pasted,"crash report line\n","utf8");
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId,input:[{type:"text",text:"what crashed?"},{type:"mention",name:"1-ab-pasted-context.txt",path:pasted}]});
  assert.equal((await completed).params.turn.status,"completed");
  const log=await fx.log();
  assert.deepEqual(requested(log,"session/new")[0].params.additionalDirectories,[attachments],"the relay grants Trebell's own attachments folder");
  const sent=requested(log,"session/prompt")[0].params.prompt;
  assert.ok(sent.some(part=>part.type==="resource"&&part.resource.uri===pathToFileURL(pasted).href&&part.resource.text==="crash report line\n"),"the pasted text is embedded");
  assert.equal(sent.some(part=>part.type==="resource_link"),false);
});

test("a Grok revert cuts the thread and the next turn starts a fresh Grok session, as T3's ACP rollback does",async t=>{
  const fx=await scenario(t,{...GROK,prompts:[{},{},{}]});
  const {rpc,next,threadStore}=await relayHarness(t,"grok",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const turns=[];
  for(const text of ["first","second"]){const completed=next(message=>message.method==="turn/completed");turns.push((await rpc("turn/start",{threadId,input:[{type:"text",text}]})).turn);await completed}
  const reverted=next(message=>message.method==="thread/reverted");
  const result=await rpc("thread/revert",{threadId,beforeTurnId:turns[1].id});await reverted;
  assert.deepEqual(result.thread.turns.map(turn=>turn.id),[turns[0].id]);assert.equal(threadStore.get(threadId).providerSessionId,"");
  assert.deepEqual(requested(await fx.log(),"session/close").map(entry=>entry.params.sessionId),["grok-session"],"the reverted conversation's session is closed");
  const completed=next(message=>message.method==="turn/completed");await rpc("turn/start",{threadId,input:[{type:"text",text:"again"}]});
  assert.equal((await completed).params.turn.status,"completed");
  const log=await fx.log();
  assert.equal(requested(log,"session/new").length,2,"the next turn runs in a new Grok session");assert.equal(requested(log,"session/resume").length,0,"the reverted conversation is not resumed");
  await assert.rejects(rpc("thread/revert",{threadId,beforeTurnId:"missing-turn"}),/Grok Build revert target turn was not found/);
});

test("a changed Antigravity model list is announced once to its listeners, which can stop listening",()=>{
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:null})},env:{...process.env}}),agy={id:"antigravity-default",kind:"antigravity"},heard=[];
  const stop=manager.onModelsChanged(change=>heard.push(change));
  manager.rememberAcpSessionModels(agy,ANTIGRAVITY.sessionNew);
  assert.deepEqual(heard,[{runtime:"antigravity",instanceId:"antigravity-default",environmentId:null}],"the account's list replaces the stand-in list");
  manager.rememberAcpSessionModels(agy,ANTIGRAVITY.sessionNew);
  assert.equal(heard.length,1,"the same list again changes nothing");
  manager.rememberAcpSessionModels({id:"grok-default",kind:"grok"},ANTIGRAVITY.sessionNew);
  assert.equal(heard.length,1,"only Antigravity reports its list from sessions");
  stop();
  manager.rememberAcpSessionModels(agy,{configOptions:[select("model","model","gemini-3.1-pro-high",[["gemini-3.1-pro-high","Gemini 3.1 Pro (High)"]])]});
  assert.equal(heard.length,1);
});

test("an Antigravity session's model list reaches the open app as a models update, also when its model option changes",async t=>{
  const changed=[select("mode","mode","default",["default","auto_edit","yolo"]),select("model","model","gemini-3.8-flash-high",[["gemini-3.8-flash-high","Gemini 3.8 Flash (High)"],["gemini-3.1-pro-high","Gemini 3.1 Pro (High)"],["gemini-4-pro","Gemini 4 Pro"]])];
  const fx=await scenario(t,{...ANTIGRAVITY,prompts:[{steps:[{update:{sessionUpdate:"config_option_update",configOptions:changed}}]}]});
  const models=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:null})},env:{...process.env,TREBELL_HOME:join(fx.root,"home")}});
  const runtimeManager={...scenarioRuntimeManager("antigravity",fx),onModelsChanged:listener=>models.onModelsChanged(listener),rememberAcpSessionModels:(...args)=>models.rememberAcpSessionModels(...args)};
  const {rpc,next}=await relayHarness(t,"antigravity",fx,{runtimeManager});
  const listed=next(message=>message.method==="agentRuntime/models/updated");
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"});
  assert.deepEqual((await listed).params,{runtime:"antigravity",instanceId:"antigravity-default",environmentId:null});
  const relisted=next(message=>message.method==="agentRuntime/models/updated"),completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"hi"}]});
  assert.deepEqual((await relisted).params,{runtime:"antigravity",instanceId:"antigravity-default",environmentId:null});
  await completed;
});

test("Grok compacts with its own /compact command, run as a turn that records the compaction",async t=>{
  const fx=await scenario(t,{...GROK,prompts:[{steps:[{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Context compacted."}}}]}]});
  const {rpc,next,threadStore}=await relayHarness(t,"grok",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const compacted=next(message=>message.method==="thread/compacted"),completed=next(message=>message.method==="turn/completed");
  const result=await rpc("thread/compact/start",{threadId});
  assert.equal(result.ok,true);await compacted;assert.equal((await completed).params.turn.status,"completed");
  assert.deepEqual(requested(await fx.log(),"session/prompt")[0].params.prompt,[{type:"text",text:"/compact"}]);
  assert.ok(threadStore.get(threadId).turns.at(-1).items.some(item=>item.type==="contextCompaction"));
});

test("a remote OpenCode thread compacts with OpenCode's /compact and reverts into a fresh session on its ACP server",async t=>{
  const configOptions=[select("model","model","opencode/big-pickle",[["opencode/big-pickle","Big Pickle"]]),select("mode","mode","build",[["build","build"],["plan","plan"]])];
  const fx=await scenario(t,{initialize:{protocolVersion:1,agentCapabilities:{loadSession:true}},sessionNew:{sessionId:"ses_remote",configOptions},prompts:[{},{},{},{}]});
  // OpenCode in a remote environment runs `opencode acp` through the remote shell, played here by the scenario agent.
  const runtimeManager={...scenarioRuntimeManager("opencode",fx),
    processSpawner:()=>options=>spawn(process.execPath,fx.args,{env:fx.env,stdio:options.stdio,windowsHide:true}),
    remoteIo:cwd=>({root:String(cwd||"/srv/app"),readText:async()=>"",writeText:async()=>{},spawn:()=>{throw new Error("no remote terminals here")}}),
  };
  const {rpc,next,threadStore}=await relayHarness(t,"opencode",fx,{runtimeManager});
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  assert.equal(started.thread.providerSessionId,"ses_remote");
  const turns=[];
  for(const text of ["first","second"]){const completed=next(message=>message.method==="turn/completed");turns.push((await rpc("turn/start",{threadId,input:[{type:"text",text}]})).turn);await completed}
  const compacted=next(message=>message.method==="thread/compacted"),compactDone=next(message=>message.method==="turn/completed");
  assert.equal((await rpc("thread/compact/start",{threadId})).ok,true);
  await compacted;assert.equal((await compactDone).params.turn.status,"completed");
  assert.deepEqual(requested(await fx.log(),"session/prompt").at(-1).params.prompt,[{type:"text",text:"/compact"}],"OpenCode's ACP server runs /compact as its session summary");
  assert.ok(threadStore.get(threadId).turns.at(-1).items.some(item=>item.type==="contextCompaction"));
  const reverted=next(message=>message.method==="thread/reverted");
  const result=await rpc("thread/revert",{threadId,beforeTurnId:turns[1].id});await reverted;
  assert.deepEqual(result.thread.turns.map(turn=>turn.id),[turns[0].id]);assert.equal(threadStore.get(threadId).providerSessionId,"");
  const completed=next(message=>message.method==="turn/completed");await rpc("turn/start",{threadId,input:[{type:"text",text:"again"}]});
  assert.equal((await completed).params.turn.status,"completed");
  const log=await fx.log();
  assert.equal(requested(log,"session/new").length,2,"the next turn runs in a new OpenCode session");assert.equal(requested(log,"session/load").length,0);
});

test("turn/start brings the composer's effort, speed and Cursor model settings to Cursor after the thread's model",async t=>{
  const opus=[
    {...select("effort","thought_level","medium",["low","medium","high"]),name:"Effort"},
    {...select("fast","model_config","false",[["false","Off"],["true","On"]]),name:"Fast"},
    {...select("context","model_config","300k",[["300k","300K"],["1m","1M"]]),name:"Context"},
    {...select("thinking","thought_level","true",[["false","Off"],["true","On"]]),name:"Thinking"},
  ];
  const fx=await scenario(t,{...CURSOR,modelOptions:{"claude-opus-5":opus},prompts:[{},{}]});
  const {rpc,next}=await relayHarness(t,"cursor",fx);
  const started=await rpc("thread/start",{cwd:fx.root,model:"claude-opus-5",approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const turn=async params=>{const completed=next(message=>message.method==="turn/completed");await rpc("turn/start",{threadId,model:"claude-opus-5",input:[{type:"text",text:"go"}],...params});return (await completed).params.turn.status};
  assert.equal(await turn({reasoningEffort:"high",serviceTier:"fast",modelOptions:{context:"1m",thinking:"false"}}),"completed");
  assert.equal(await turn({reasoningEffort:null,serviceTier:null,modelOptions:{}}),"completed");
  const log=await fx.log(),order=log.filter(entry=>entry.method==="session/set_config_option"||entry.method==="session/prompt").map(entry=>entry.method==="session/prompt"?"prompt":`${entry.params.configId}=${entry.params.value}`);
  assert.deepEqual(order,["model=claude-opus-5","effort=high","fast=true","context=1m","thinking=false","prompt","fast=false","prompt"],"a setting the next turn does not pick stays as it is, and Standard turns Fast off");
});

test("Cursor runs a Plan turn in its plan mode and any other turn in its agent mode, with Read only in its ask mode",async t=>{
  const fx=await scenario(t,{...CURSOR,prompts:[{},{},{}]});
  const {session,updates}=harness(t,fx,{runtime:"cursor"});
  await session.start();
  session.setCollaborationMode("plan");await session.prompt([{type:"text",text:"plan it"}],{agent:"ask"});
  session.setCollaborationMode("default");await session.prompt([{type:"text",text:"build it"}]);
  session.setCollaborationMode("plan");session.setPermissionMode("read-only");await session.prompt([{type:"text",text:"look"}]);
  const log=await fx.log(),order=log.filter(entry=>entry.method==="session/set_config_option"||entry.method==="session/prompt").map(entry=>entry.method==="session/prompt"?"prompt":`${entry.params.configId}=${entry.params.value}`);
  assert.deepEqual(order,["model=default","mode=plan","prompt","mode=agent","prompt","mode=ask","prompt"],"T3's plan or agent; an agent name is not a Cursor mode");
  assert.equal(updates.some(update=>Array.isArray(update.agents)),false,"Cursor's modes are not offered as agents");
  const planless=await scenario(t,{...CURSOR,sessionNew:{...CURSOR_SETUP,configOptions:[select("mode","mode","agent",["agent","ask"]),CURSOR_SETUP.configOptions[1]]}});
  const other=harness(t,planless,{runtime:"cursor"});
  await other.session.start();other.session.setCollaborationMode("plan");
  await assert.rejects(other.session.prompt([{type:"text",text:"plan it"}]),/does not offer a plan mode, so the turn was not sent/);
  assert.equal(requested(await planless.log(),"session/prompt").length,0);
});

test("Cursor threads offer the composer's Plan mode, remember it per thread and run it in Cursor's plan mode",async t=>{
  const fx=await scenario(t,{...CURSOR,prompts:[{},{},{}]});
  const {rpc,next,threadStore}=await relayHarness(t,"cursor",fx);
  assert.deepEqual((await rpc("collaborationMode/list",{})).data.map(item=>item.mode),["default","plan"]);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const turn=async params=>{const completed=next(message=>message.method==="turn/completed");await rpc("turn/start",{threadId,input:[{type:"text",text:"go"}],...params});return (await completed).params.turn.status};
  assert.equal(await turn({collaborationMode:{mode:"plan",settings:{model:"default"}}}),"completed");
  assert.equal(threadStore.get(threadId).settings.collaborationMode.mode,"plan");
  assert.equal(await turn({}),"completed","a turn that names no mode keeps the thread's");
  assert.equal((await rpc("thread/resume",{threadId})).collaborationMode.mode,"plan","reopening the thread shows its Plan mode");
  assert.equal(await turn({collaborationMode:{mode:"default",settings:{model:"default"}}}),"completed");
  const modes=requested(await fx.log(),"session/set_config_option").filter(entry=>entry.params.configId==="mode").map(entry=>entry.params.value);
  assert.deepEqual(modes,["plan","agent"],"the second Plan turn is already in plan mode");
});
