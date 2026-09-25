import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket,WebSocketServer } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";

async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function connect(url){
  const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws;
}
function rpcClient(ws){
  let id=0;
  return (method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id,onMessage=raw=>{
      const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);
      if(message.error)reject(Object.assign(new Error(message.error.message),{code:message.error.code}));else resolve(message.result);
    };
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
}
async function fakeCodexAppServer(port){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),requests=[];
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);
    if(message.method==="turn/start")return ws.send(JSON.stringify({id:message.id,result:{turn:{id:"repair-turn",status:"inProgress"}}}));
    ws.send(JSON.stringify({id:message.id,result:{}}));
  }));
  await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {requests,async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

test("Codex verification repair starts the same-thread repair turn with sanitized failed evidence",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-verification-repair-")),[port,appPort]=await Promise.all([freePort(),freePort()]);
  const upstream=await fakeCodexAppServer(appPort);const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});
  const threadId="verification-repair-thread";let ws;
  try{
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,patch:{runtime:"codex",runtimeInstanceId:"codex-default",cwd:home,active:false}})});
    const plan={risk:"medium",steps:[{id:"tests",kind:"tests",scope:"affected",required:true,cost:"low",reason:"Changed code has related tests."}]};
    const failed=await fetch(gui.url+"/api/verification-records",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      id:"verification-repair-record",threadId,projectPath:home,plan,
      evidence:[{stepId:"tests",exitCode:1,status:"failed",reason:"Parser regression failed",stdout:"TOP_SECRET_OUTPUT"}],
    })}).then(response=>response.json());
    assert.equal(failed.record.assessment.status,"failed");assert.equal(failed.nextAction.action,"repair");
    const prepared=await fetch(gui.url+"/api/verification-records/repair-context",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId})}).then(async response=>({status:response.status,body:await response.json()}));
    assert.equal(prepared.status,200);assert.equal(prepared.body.record.id,"verification-repair-record");assert.match(prepared.body.prompt,/Repair the failed verification/i);assert.match(prepared.body.context,/Parser regression failed/);assert.doesNotMatch(prepared.body.context,/TOP_SECRET_OUTPUT/);

    ws=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");const rpc=rpcClient(ws);
    const current=await rpc("thread/verification/get",{threadId});assert.equal(current.record.id,"verification-repair-record");assert.equal(current.nextAction.action,"repair");
    const repaired=await rpc("thread/verification/repair",{threadId});assert.equal(repaired.turn.id,"repair-turn");assert.equal(repaired.nextAction.action,"repair");

    const forwarded=upstream.requests.find(message=>message.method==="turn/start");assert.ok(forwarded);
    assert.equal(forwarded.params.threadId,threadId);assert.match(forwarded.params.input?.[0]?.text||"",/Repair the failed verification/i);
    const repairContext=forwarded.params.additionalContext?.["trebell.verification_repair"]?.value||"";
    assert.match(repairContext,/Parser regression failed/);assert.match(repairContext,/"exitCode": 1/);assert.doesNotMatch(repairContext,/TOP_SECRET_OUTPUT/);
    assert.ok(forwarded.params.additionalContext?.["trebell.continuity"],"repair turn should retain durable continuity context");

    const traces=await fetch(gui.url+"/api/traces?threadId="+encodeURIComponent(threadId)+"&category=verification&limit=20").then(response=>response.json());
    assert.ok(traces.items.some(item=>item.name==="verification.repair_started"&&item.data?.recordId==="verification-repair-record"));

    const passed=await fetch(gui.url+"/api/verification-records",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      id:"verification-repair-record",threadId,projectPath:home,plan,evidence:[{stepId:"tests",exitCode:0,status:"passed"}],
    })}).then(response=>response.json());
    assert.equal(passed.nextAction.action,"complete");
    const noRepair=await fetch(gui.url+"/api/verification-records/repair-context",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId})});assert.equal(noRepair.status,400);
    await assert.rejects(rpc("thread/verification/repair",{threadId}),/does not require repair/i);
  }finally{
    try{ws?.close()}catch{}await gui.close();await upstream.close();await rm(home,{recursive:true,force:true});
  }
});
