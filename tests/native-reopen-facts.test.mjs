// What a reopened thread shows of a turn is what the live window showed (tour L10-F-2, L10-10): its time to a tenth of a second (the
// store kept whole seconds, so a turn shown live as "done · 3.3s" came back as "done · 4.0s"), the heading over its reply with the
// model and the permission mode it was sent with (a reload named the harness alone), and the composer's context reading ("Context —"
// after a reload).
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
import { assistantRowDecorations, mergeTurnOutcomes, turnInfoKey, turnOutcomePill } from "../ui/src/turn-outcome.js";

test("a stored turn keeps its time to the millisecond, and its pill reads as it did live",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-turn-time-")),store=new AgentThreadStore({...process.env,TREBELL_HOME:root}),realNow=Date.now;
  try{
    const thread=store.create({runtime:"native",cwd:root,providerSessionId:"native-times",model:"model-a"});
    let now=1_793_617_946_700;Date.now=()=>now;
    const turn=store.addTurn(thread.id,{inputText:"Reply with PONG."});
    now+=3304;const finished=store.finishTurn(thread.id,turn.id,{status:"completed"});
    Date.now=realNow;
    assert.equal(finished.durationMs,3304,"the turn ran 3,304 ms (the store said 4,000: whole seconds, 46.7 s to 50.0 s)");
    assert.equal(store.get(thread.id).turns[0].durationMs,3304,"and the thread read again says the same");
    const info=mergeTurnOutcomes({},thread.id,store.get(thread.id).turns)[turnInfoKey(thread.id,turn.id)];
    assert.equal(turnOutcomePill(info).label,"done · 3.3s");
  }finally{Date.now=realNow;store.close();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("a Native turn reopened from the thread names its model and mode, and the thread keeps its context reading",{timeout:60000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-reopen-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const nativeProviderTurn=async request=>({id:"pong",provider:request.provider,model:request.model,text:"PONG",toolCalls:[],finishReason:"stop",usage:{inputTokens:8422,outputTokens:20,totalTokens:8442,cachedInputTokens:8177,cacheWriteInputTokens:0,reasoningOutputTokens:6}});
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  let id=0;const pending=new Map(),seen=[],waiters=[];
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!=null&&pending.has(message.id)&&!message.method){pending.get(message.id)(message.result);pending.delete(message.id);return}seen.push(message);for(const waiter of [...waiters])if(waiter.match(message)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message)}});
  const rpc=(method,params)=>new Promise(resolve=>{const requestId=++id;pending.set(requestId,resolve);ws.send(JSON.stringify({id:requestId,method,params}))});
  const waitFor=match=>new Promise(resolve=>{const found=seen.find(match);if(found)return resolve(found);waiters.push({match,resolve})});
  try{
    const thread=(await rpc("thread/start",{model:"muse-spark-1.3-contributor",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile:"supervised",dynamicTools:[]})).thread;
    const turn=(await rpc("turn/start",{threadId:thread.id,model:"muse-spark-1.3-contributor",modelProvider:"agentrouter",permissionProfile:"supervised",input:[{type:"text",text:"Reply with exactly the word PONG."}]})).turn;
    const live=(await waitFor(message=>message.method==="thread/tokenUsage/updated")).params.tokenUsage;
    await waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===turn.id);
    const resumed=(await rpc("thread/resume",{threadId:thread.id})).thread,stored=resumed.turns.find(item=>item.id===turn.id);
    assert.equal(stored.model,"muse-spark-1.3-contributor");assert.equal(stored.permissionProfile,"supervised");
    assert.ok(Number.isFinite(stored.startedAtMs)&&stored.durationMs>=0,"the turn's time is kept to the millisecond");
    assert.deepEqual(resumed.tokenUsage,live,"the reopened thread has the context reading the composer showed live");
    assert.equal(resumed.tokenUsage.last.inputTokens,8422);
    // The window reloads: its turn facts come from the thread alone.
    const turnInfo=mergeTurnOutcomes({},thread.id,resumed.turns),reply={id:"assistant-"+turn.id,role:"assistant",turnId:turn.id,content:"PONG"};
    assert.equal(assistantRowDecorations([reply],{harnessLabel:"Trebell Native",turnInfo,threadId:thread.id}).get(reply.id).heading,"Trebell Native · muse-spark-1.3-contributor · Supervised");
    // What this window sent it with stays over the thread's copy.
    const sent={[turnInfoKey(thread.id,turn.id)]:{model:"Muse Spark 1.3 Contributor",mode:"Supervised"}};
    assert.equal(mergeTurnOutcomes(sent,thread.id,resumed.turns)[turnInfoKey(thread.id,turn.id)].model,"Muse Spark 1.3 Contributor");
  }finally{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));state.close?.();threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
