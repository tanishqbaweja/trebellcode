// A Trebell server of a test's own (mock mode) whose Codex relay reaches a fake Codex app-server, and a window's socket to it. The
// fake answers what it is asked (goals as Codex keeps them, a turn for turn/start) and sends server requests and notifications as
// Codex does; every answer it gets back is kept by request id.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createGuiServer } from "../../src/gui-server.mjs";

export async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
// The real setTimeout, taken before a test fakes the clock: the waits below keep real time while it is faked.
const realSetTimeout=globalThis.setTimeout;
export const sleep=ms=>new Promise(resolve=>realSetTimeout(resolve,ms));
export async function until(check,ms=3000){const end=Date.now()+ms;while(!check()&&Date.now()<end)await sleep(10);return check()}

async function fakeCodex(port){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),requests=[],answers=new Map(),goals=new Map(),sockets=new Set(),holds=new Map(),fixed=new Map();let nextId=9000,turns=0;
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  const send=value=>{for(const ws of sockets)if(ws.readyState===1)ws.send(JSON.stringify(value))};
  const notify=(method,params)=>send({method,params});
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));
      if(message.id!=null&&!message.method){const id=String(message.id);answers.set(id,[...(answers.get(id)||[]),message]);return}
      if(message.id==null||!message.method)return;requests.push(message);
      const held=holds.get(message.method);if(held){holds.delete(message.method);held.then(()=>answer(ws,message));return}
      answer(ws,message);
    });
  });
  function answer(ws,message){
    const params=message.params||{},reply=result=>{if(ws.readyState===1)ws.send(JSON.stringify({id:message.id,result}))},now=Math.floor(Date.now()/1000);
    if(fixed.has(message.method))return reply(fixed.get(message.method));
    if(message.method==="thread/goal/get")return reply({goal:goals.get(params.threadId)||null});
    if(message.method==="thread/goal/set"){
      const previous=goals.get(params.threadId)||null;
      const goal={threadId:params.threadId,objective:params.objective??previous?.objective,status:params.status??previous?.status??"active",tokenBudget:previous?.tokenBudget??null,tokensUsed:previous?.tokensUsed??0,timeUsedSeconds:previous?.timeUsedSeconds??0,createdAt:previous?.createdAt??now,updatedAt:now};
      goals.set(params.threadId,goal);notify("thread/goal/updated",{threadId:params.threadId,goal});return reply({goal});
    }
    if(message.method==="thread/goal/clear"){const cleared=goals.delete(params.threadId);if(cleared)notify("thread/goal/cleared",{threadId:params.threadId});return reply({cleared})}
    if(message.method==="turn/start")return reply({turn:{id:"fake-turn-"+(++turns),status:"inProgress",items:[],startedAt:now}});
    if(message.method==="thread/unsubscribe")return reply({status:"unsubscribed"});
    reply({});
  }
  await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    requests,goals,notify,calls:method=>requests.filter(item=>item.method===method),
    connected:()=>sockets.size>0,connections:()=>sockets.size,
    // The next request of the method waits for release() before it is answered.
    hold(method){let release=()=>{};holds.set(method,new Promise(resolve=>{release=resolve}));return ()=>release()},
    // Every request of the method is answered with result from now on.
    answerWith(method,result){fixed.set(method,result)},
    // A server request as Codex sends it; answers() gives what came back for it.
    ask(method,params){const id=nextId++;send({id,method,params});return {id,answers:()=>answers.get(String(id))||[]}},
    async close(){for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
}

// A window's socket to the Trebell server: every message it gets is kept; request() sends a request and waits for its answer.
async function windowSocket(url){
  const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  const received=[];let nextId=1;ws.on("message",raw=>received.push(JSON.parse(String(raw))));
  return {
    ws,received,
    requests:method=>received.filter(item=>item.method===method&&item.id!=null),
    notifications:method=>received.filter(item=>item.method===method&&item.id==null),
    request(method,params={}){
      const id=nextId++;ws.send(JSON.stringify({id,method,params}));
      return (async()=>{await until(()=>received.some(item=>item.id===id&&!item.method),5000);const answer=received.find(item=>item.id===id&&!item.method);if(!answer)throw new Error(method+" was not answered");if(answer.error)throw Object.assign(new Error(answer.error.message),{code:answer.error.code});return answer.result})();
    },
    answer(request,result){ws.send(JSON.stringify({id:request.id,result}))},
    close(){try{ws.close()}catch{}},
  };
}

export async function startCodexGui(prefix){
  const home=await mkdtemp(join(tmpdir(),prefix)),[port,appPort]=await Promise.all([freePort(),freePort()]),upstream=await fakeCodex(appPort);
  const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});
  const windows=[];
  return {
    home,gui,upstream,
    async thread(threadId,patch={}){await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,patch:{runtime:"codex",runtimeInstanceId:"codex-default",environmentId:null,cwd:home,...patch}})})},
    async window(){const socket=await windowSocket(gui.url.replace(/^http/,"ws")+"/api/codex/ws");windows.push(socket);return socket},
    traces:async threadId=>(await fetch(gui.url+"/api/traces?threadId="+encodeURIComponent(threadId)+"&limit=200").then(response=>response.json())).items||[],
    async close(){for(const socket of windows)socket.close();await gui.close();await upstream.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})},
  };
}
