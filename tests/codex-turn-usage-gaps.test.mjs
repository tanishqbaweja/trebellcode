// The Usage record of a Codex turn when the server missed some of its thread's updates. Trebell's server reads a thread's
// thread/tokenUsage/updated only while a window shows the thread (each window has its own connection to the thread's app-server), and
// Codex runs a turn on after every window closes: it unloads a thread only once it has had no subscriber and no activity for a while.
// A window that comes back resumes the thread with excludeTurns, and Codex sends no usage replay to a resume of a thread it still has
// loaded (thread_lifecycle.rs handle_pending_thread_resume_request at rust-v0.155.1: a replay only for a cold resume or with turns).
// So the server's last total of the thread can be from before such a gap, and a turn's record must hold its own requests only:
// - a turn that starts after the gap counts from its own request, never the requests of turns that ran and ended in the gap;
// - a turn that started in the gap (a goal's next turn Codex starts by itself) is counted from the update after a window resumes it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket,WebSocketServer } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";

const FIELDS=["totalTokens","inputTokens","cachedInputTokens","cacheWriteInputTokens","outputTokens","reasoningOutputTokens"];
const request=(input,output,{cached=0,write=0,reasoning=0}={})=>({totalTokens:input+output,inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:write,outputTokens:output,reasoningOutputTokens:reasoning});
const add=(...items)=>Object.fromEntries(FIELDS.map(key=>[key,items.reduce((sum,item)=>sum+(item[key]||0),0)]));

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws}
function rpcClient(ws){
  let id=0;
  return (method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);if(message.error)reject(Object.assign(new Error(message.error.message),{code:message.error.code}));else resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
}
const until=async(check,what)=>{for(let tries=0;tries<200;tries++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25))}throw new Error("timed out waiting until "+what)};

// A Codex app-server that keeps each thread's running total as Codex does (each model request adds its own usage, last, to it) and
// sends a thread's events to the connections open at the time, so a request made while no window is connected reaches no one. A
// resume answers with the thread's status (and its turns unless excludeTurns), and replays the last usage only with its turns.
async function fakeCodexAppServer(port){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set(),threads=new Map();let turns=0;
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  const thread=id=>{if(!threads.has(id))threads.set(id,{total:request(0,0),last:null,lastTurnId:null,status:"idle",turns:[]});return threads.get(id)};
  const send=(ws,method,params)=>ws.send(JSON.stringify({method,params}));
  const fake={
    connections:()=>sockets.size,
    notify(method,params){for(const ws of sockets)send(ws,method,params)},
    // A model request of the turn: the thread's total grows by its usage, and the windows connected now are told.
    request(threadId,turnId,usage){
      const state=thread(threadId);state.total=add(state.total,usage);state.last=usage;state.lastTurnId=turnId;
      fake.notify("thread/tokenUsage/updated",{threadId,turnId,tokenUsage:{total:state.total,last:usage,modelContextWindow:200_000}});
    },
    startTurn(threadId,turnId){const state=thread(threadId);state.status="active";state.turns.push({id:turnId,status:"inProgress",items:[]});fake.notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress",items:[]}})},
    endTurn(threadId,turnId){
      const state=thread(threadId),turn=state.turns.find(item=>item.id===turnId);if(turn)turn.status="completed";state.status="idle";
      fake.notify("turn/completed",{threadId,turn:{id:turnId,status:"completed",items:[]}});fake.notify("thread/status/changed",{threadId,status:{type:"idle"}});
    },
    async close(){for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
      const params=message.params||{},reply=result=>ws.send(JSON.stringify({id:message.id,result}));
      if(message.method==="turn/start"){const turnId="gap-turn-"+(++turns);reply({turn:{id:turnId,status:"inProgress",items:[]}});fake.startTurn(params.threadId,turnId);return}
      if(message.method==="thread/resume"||message.method==="thread/read"){
        const state=thread(params.threadId),withTurns=message.method==="thread/resume"?params.excludeTurns===false:params.includeTurns===true;
        reply({thread:{id:params.threadId,status:{type:state.status},turns:withTurns?state.turns.map(turn=>({...turn})):[]}});
        if(message.method==="thread/resume"&&withTurns&&state.last)send(ws,"thread/tokenUsage/updated",{threadId:params.threadId,turnId:state.lastTurnId,tokenUsage:{total:state.total,last:state.last,modelContextWindow:200_000}});
        return;
      }
      reply({});
    });
  });
  await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return fake;
}

async function usageServer(t){
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-usage-gaps-")),[port,appPort]=await Promise.all([freePort(),freePort()]),codex=await fakeCodexAppServer(appPort);
  const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});
  const windows=new Set();
  t.after(async()=>{for(const ws of windows)try{ws.close()}catch{}await gui.close();await codex.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  const shown=async threadId=>fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,patch:{runtime:"codex",runtimeInstanceId:"codex-default",environmentId:null,cwd:home,active:false}})});
  // A window: its own connection to the thread's app-server, as the app's Codex socket is; settle() makes sure the server has read
  // every update Codex sent that window before (a request Codex answers after them).
  const open=async()=>{
    const before=codex.connections(),ws=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");windows.add(ws);const rpc=rpcClient(ws);
    await rpc("config/read",{});await until(()=>codex.connections()>before,"the window reached Codex");
    return {rpc,settle:()=>rpc("config/read",{}),close:async()=>{windows.delete(ws);ws.close();await until(()=>codex.connections()===0,"Codex saw the window go")}};
  };
  const record=async(threadId,turnId)=>(await fetch(gui.url+"/api/usage?days=1").then(response=>response.json())).records.find(item=>item.threadId===threadId&&item.turnId===turnId)?.usage||null;
  return {codex,open,shown,record};
}

test("a Codex turn after every window was closed and the thread resumed counts only its own requests, not those of a turn that ended meanwhile",async t=>{
  const {codex,open,shown,record}=await usageServer(t),threadId="codex-gap-thread";await shown(threadId);
  const earlier=request(60_000,7_000,{cached:50_000}),r1=request(12_000,500,{cached:11_000}),r2=request(12_600,900,{cached:12_000}),r3=request(13_000,600,{cached:12_400}),r4=request(13_500,800,{cached:12_900,reasoning:200}),q1=request(14_000,700,{cached:13_200});
  codex.request(threadId,"gap-turn-0",earlier);
  const first=await open();
  const t1=(await first.rpc("turn/start",{threadId,input:[{type:"text",text:"Fix the parser"}]})).turn.id;
  codex.request(threadId,t1,r1);await first.settle();
  assert.deepEqual(await record(threadId,t1),r1);
  // The window closes (or loses its connection) while the turn runs on: its last three requests and its end reach no window.
  await first.close();
  codex.request(threadId,t1,r2);codex.request(threadId,t1,r3);codex.request(threadId,t1,r4);codex.endTurn(threadId,t1);
  // A window opens the thread again while Codex still has it loaded: a resume with excludeTurns, which gets no usage replay.
  const second=await open();
  await second.rpc("thread/resume",{threadId,excludeTurns:true});
  const t2=(await second.rpc("turn/start",{threadId,input:[{type:"text",text:"Now the tests"}]})).turn.id;
  codex.request(threadId,t2,q1);codex.endTurn(threadId,t2);await second.settle();
  assert.deepEqual(await record(threadId,t2),q1,"the new turn's record is its one request, not the requests the ended turn made with no window open");
  assert.deepEqual(await record(threadId,t1),r1,"and the turn the server lost sight of keeps what it saw");
});
