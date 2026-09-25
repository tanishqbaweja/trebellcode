import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteAuthStore } from "../src/remote-auth-store.mjs";
import { createRemoteControlServer } from "../src/remote-control.mjs";
import { createServer } from "node:http";
import { WebSocket,WebSocketServer } from "ws";

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function rpc(ws,id,method,params={}){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.off("message",onMessage);reject(new Error(method+" timed out"))},5000);
    const onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==id)return;clearTimeout(timer);ws.off("message",onMessage);resolve(message)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id,method,params}));
  });
}

test("remote pairing is one-time, hashed at rest, and revocable", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-remote-auth-"));
  try{
    const store=new RemoteAuthStore({...process.env,TREBELL_HOME:home});
    const pairing=store.createPairing({ttlMs:60_000,scopes:["status","threads:read","unknown:future"]});
    const paired=store.exchangePairing(pairing.token,{name:"Test phone",userAgent:"test"});
    assert.equal(store.authenticate(paired.token)?.name,"Test phone");
    assert.deepEqual(store.authenticate(paired.token)?.scopes,["status","threads:read"]);
    await assert.rejects(async()=>store.exchangePairing(pairing.token,{name:"Replay"}),/invalid or expired/i);
    const raw=await readFile(join(home,"remote-auth.json"),"utf8");
    assert.doesNotMatch(raw,new RegExp(pairing.token.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
    assert.doesNotMatch(raw,new RegExp(paired.token.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
    assert.equal(store.revokeDevice(paired.device.id),true);
    assert.equal(store.authenticate(paired.token),null);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("remote control enforces scoped device sessions on HTTP capabilities", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-remote-scopes-"));
  const store=new RemoteAuthStore({...process.env,TREBELL_HOME:home});
  const environments={discover:async()=>({profiles:[{id:"env"}]}),probe:async()=>({ok:true}),execute:async()=>({ok:true,stdout:"ran"})};
  const remote=await createRemoteControlServer({port:0,token:"admin-recovery-token",version:"test",authStore:store,environments,enabled:()=>false,getStatus:async()=>({providerReady:true})});
  try{
    const pairing=remote.createPairing({scopes:["status","threads:read"]}),base=`http://127.0.0.1:${remote.port}`;
    const session=await fetch(base+"/api/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:pairing.token,name:"Read only phone"})}).then(response=>response.json());
    const headers={authorization:`Bearer ${session.token}`};
    const status=await fetch(base+"/api/status",{headers});assert.equal(status.status,200);assert.deepEqual((await status.json()).remoteScopes,["status","threads:read"]);
    assert.equal((await fetch(base+"/api/environments",{headers})).status,403);
    assert.equal((await fetch(base+"/api/environment/execute",{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({id:"env",command:"echo hi"})})).status,403);
    const admin=await fetch(base+"/api/environments",{headers:{authorization:"Bearer admin-recovery-token"}});assert.equal(admin.status,200);
  }finally{await remote.close();await rm(home,{recursive:true,force:true})}
});

test("remote control exchanges a pairing link for a device session and honors revocation", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-remote-http-"));
  const store=new RemoteAuthStore({...process.env,TREBELL_HOME:home});
  const environments={discover:async()=>({profiles:[]}),probe:async()=>({ok:true}),execute:async()=>({ok:true,stdout:""})};
  const remote=await createRemoteControlServer({port:0,token:"admin-recovery-token",version:"test",authStore:store,environments,enabled:()=>false,getStatus:async()=>({providerReady:true})});
  try{
    const pairing=remote.createPairing();
    const base=`http://127.0.0.1:${remote.port}`;
    const exchange=await fetch(base+"/api/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:pairing.token,name:"Browser"})});
    assert.equal(exchange.status,200);
    const session=await exchange.json();
    const status=await fetch(base+"/api/status",{headers:{authorization:`Bearer ${session.token}`}});
    assert.equal(status.status,200);
    assert.equal((await status.json()).providerReady,true);
    const replay=await fetch(base+"/api/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:pairing.token,name:"Replay"})});
    assert.equal(replay.status,401);
    assert.equal(remote.revokeDevice(session.device.id),true);
    const revoked=await fetch(base+"/api/status",{headers:{authorization:`Bearer ${session.token}`}});
    assert.equal(revoked.status,401);
  }finally{await remote.close();await rm(home,{recursive:true,force:true})}
});

test("remote WebSocket scope blocks writes and auto-declines approvals for read-only devices",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-remote-ws-scope-")),targetPort=await freePort(),upstreamHttp=createServer(),upstreamWss=new WebSocketServer({noServer:true});
  let forwardedWrites=0,approvalReply=null,upstreamSocket=null;
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    upstreamSocket=ws;
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));
      if(message.id==="approval-1"&&!message.method){approvalReply=message.result;return}
      if(message.method==="initialize")ws.send(JSON.stringify({id:message.id,result:{userAgent:"remote-scope-fixture"}}));
      else if(message.method==="thread/list")ws.send(JSON.stringify({id:message.id,result:{data:[],nextCursor:null}}));
      else if(message.method==="turn/start"){forwardedWrites++;ws.send(JSON.stringify({id:message.id,result:{turn:{id:"should-not-run"}}}))}
      else if(message.method==="initialized")setTimeout(()=>ws.send(JSON.stringify({id:"approval-1",method:"item/tool/requestApproval",params:{threadId:"t1",reason:"Dangerous write"}})),10);
    });
  });
  await new Promise((resolve,reject)=>upstreamHttp.listen(targetPort,"127.0.0.1",resolve).once("error",reject));
  const store=new RemoteAuthStore({...process.env,TREBELL_HOME:home}),environments={discover:async()=>({profiles:[]}),probe:async()=>({ok:true}),execute:async()=>({ok:true})};
  const remote=await createRemoteControlServer({port:0,token:"admin-token",version:"test",targetUrl:"ws://127.0.0.1:"+targetPort,authStore:store,environments,enabled:()=>true});
  let ws;
  try{
    const pairing=remote.createPairing({scopes:["threads:read"]}),base=`http://127.0.0.1:${remote.port}`;
    const session=await fetch(base+"/api/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:pairing.token,name:"Read only"})}).then(response=>response.json());
    ws=new WebSocket(`ws://127.0.0.1:${remote.port}/api/codex/ws?token=${encodeURIComponent(session.token)}`);
    await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
    assert.equal((await rpc(ws,1,"initialize",{clientInfo:{name:"scope-test"}})).error,undefined);
    ws.send(JSON.stringify({method:"initialized",params:{}}));
    const listed=await rpc(ws,2,"thread/list",{limit:10});assert.equal(listed.error,undefined);assert.deepEqual(listed.result.data,[]);
    const denied=await rpc(ws,3,"turn/start",{threadId:"t1",input:[{type:"text",text:"write"}]});assert.equal(denied.error.code,-32003);assert.match(denied.error.message,/threads:write/);assert.equal(forwardedWrites,0);
    for(let attempt=0;attempt<50&&approvalReply==null;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(approvalReply,{decision:"decline"});
  }finally{
    try{ws?.close()}catch{}await remote.close();try{upstreamSocket?.terminate()}catch{}upstreamWss.close();await new Promise(resolve=>upstreamHttp.close(resolve));await rm(home,{recursive:true,force:true});
  }
});
