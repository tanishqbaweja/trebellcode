// A message Stop ends while Claude Code still connects the thread's MCP servers never reaches Claude Code, so no transcript holds it:
// the relay keeps no ids of it on the turn. A new conversation whose only message was stopped so is no conversation Claude Code has,
// and after a restart its next message starts it, instead of being told the conversation was lost and handed the history over.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay, claudePersistedTurns } from "../src/agent-relay.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { claudeResult, scriptedClaudeSdk } from "./fixtures/scripted-claude-sdk.mjs";

const CLAUDE={id:"claude-default",kind:"claude",displayName:"Claude Code",enabled:true};
const runtimeManager={
  instances:()=>[{...CLAUDE}],activeInstance:()=>({...CLAUDE}),activeRuntime:()=>"claude",compatibleInstanceIds:()=>[CLAUDE.id],
  probe:async()=>({id:CLAUDE.id,name:"Claude Code",available:true,authenticated:true,version:"fixture"}),
  runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),executable:()=>"claude",
};
// The thread's MCP server, set in Settings for Claude Code.
const settings={activeEnvironmentId:null,mcpServers:[{name:"Workspace tools",runtime:"claude",command:"workspace-mcp",args:["--stdio"],enabled:true}]};
const state={settings:()=>settings,threadMeta:()=>({}),updateThreadMeta:(_id,patch)=>patch};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let round=0;round<400&&!check();round++)await tick();assert.ok(check(),"the relay got there")}

async function startRelay({threadStore,sdk,journal}){
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,state,journal,terminals:{},version:"test",claudeSdk:sdk});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  let id=0;const waiters=[];
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(!message.method)return;for(const waiter of [...waiters])if(waiter.match(message)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message)}});
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
  const next=match=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("timed out waiting for a relay notification")),20_000);waiters.push({match,resolve:value=>{clearTimeout(timer);resolve(value)}})});
  let closing=null;
  return {rpc,next,close:()=>closing??=(async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()))})()};
}

test("a new Claude Code conversation whose only message was stopped while Claude Code connected its MCP servers starts with the next message after a restart, not as a lost conversation",async t=>{
  // The relays close before their folder goes, whatever fails first (Windows keeps a folder in use busy).
  const root=await mkdtemp(join(tmpdir(),"trebell-claude-stopped-before-send-")),relays=[];
  t.after(async()=>{for(const relay of relays.reverse())await relay.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
  const env={...process.env,TREBELL_HOME:join(root,"home")},entries=[],journal={record:entry=>{entries.push(entry)},list:()=>[]};
  // The sessions Claude Code has a transcript for: one a query started with a message. The first Claude Code never finishes connecting
  // the servers.
  const transcripts=new Set();
  const {sdk:scripted,calls}=scriptedClaudeSdk({
    turn:({message,options,emit})=>{transcripts.add(options.sessionId||options.resume);emit(claudeResult(message))},
    control:{setMcpServers:(servers,call)=>call.index===0?new Promise(()=>{}):{added:Object.keys(servers),removed:[],errors:{}}},
  });
  const sdk={...scripted,getSessionInfo:async id=>transcripts.has(id)?{sessionId:id}:undefined};
  const first=new AgentThreadStore(env);
  const thread=first.create({runtime:"claude",cwd:root,providerSessionId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",model:"claude-test",providerMeta:{runtimeInstanceId:CLAUDE.id,permissionProfile:"supervised"}});
  first.update(thread.id,{runtimeInstanceId:CLAUDE.id});
  const before=await startRelay({threadStore:first,sdk,journal});relays.push(before);
  const stopped=before.next(message=>message.method==="turn/completed");
  await before.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Run the linter"}]});
  await until(()=>calls[0]?.log.length===1);
  await before.rpc("turn/interrupt",{threadId:thread.id});
  assert.equal((await stopped).params.turn.status,"cancelled");
  assert.equal(calls[0].inputs.length,0,"the message never reached Claude Code");
  await before.close();
  // A restart: a new store over the same folder and a new relay. The next message starts the conversation.
  const threadStore=new AgentThreadStore(env),relay=await startRelay({threadStore,sdk,journal});relays.push(relay);
  const completed=relay.next(message=>message.method==="turn/completed");
  await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Run the tests"}]});
  assert.equal((await completed).params.turn.status,"completed");
  const after=threadStore.get(thread.id);
  assert.equal(after.providerSessionId,thread.providerSessionId,"the conversation is the thread's own");
  assert.deepEqual([calls.at(-1).options.sessionId??null,calls.at(-1).options.resume??null],[thread.providerSessionId,null],"created by its first message, not resumed");
  assert.deepEqual(after.turns.at(-1).items.filter(item=>item.type==="sessionHandoff"),[],"no conversation said lost, and no history handed over");
  assert.deepEqual(entries.filter(entry=>entry.name==="agent.session.resume_fallback"),[],"no lost session");
  // Since the stopped turn keeps no ids of its message.
  const [turn]=after.turns;
  assert.deepEqual([turn.status,turn.providerMessageId??null,turn.providerUserMessageId??null],["cancelled",null,null],"no ids of a message no transcript holds");
  assert.equal(claudePersistedTurns({...after,turns:[turn]}),false,"so it is no turn Claude Code recorded");
});
