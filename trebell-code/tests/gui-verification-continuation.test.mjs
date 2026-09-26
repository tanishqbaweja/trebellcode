import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket,WebSocketServer } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws}
function rpcClient(ws){let id=0;return (method,params={})=>new Promise((resolve,reject)=>{const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);if(message.error)reject(Object.assign(new Error(message.error.message),{code:message.error.code}));else resolve(message.result)};ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}))})}
async function fakeCodexAppServer(port){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),requests=[];http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);if(message.method==="turn/start")return ws.send(JSON.stringify({id:message.id,result:{turn:{id:"verification-turn",status:"inProgress"}}}));ws.send(JSON.stringify({id:message.id,result:{}}))}));
  await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));return{requests,async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

test("Codex verification continuation starts the same thread with only sanitized next-step context",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-verification-continue-")),[port,appPort]=await Promise.all([freePort(),freePort()]),upstream=await fakeCodexAppServer(appPort),gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}}),threadId="verification-continue-thread";let ws;
  try{
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,patch:{runtime:"codex",runtimeInstanceId:"codex-default",cwd:home,active:false}})});
    const plan={risk:"medium",steps:[{id:"diagnostics",kind:"diagnostics",scope:"changed",cost:"low",required:true,reason:"Check syntax"},{id:"tests",kind:"tests",scope:"affected",cost:"medium",required:true,command:"npm test",reason:"Run affected tests"}]};
    await fetch(gui.url+"/api/verification-records",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"verification-continue-record",threadId,turnId:"user-turn",projectPath:home,plan,evidence:[{stepId:"diagnostics",status:"passed",rawOutput:"TOP_SECRET_OUTPUT"}]})});
    ws=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");const rpc=rpcClient(ws),current=await rpc("thread/verification/get",{threadId});assert.equal(current.nextAction.action,"verify");assert.equal(current.nextAction.nextStep.id,"tests");
    const continued=await rpc("thread/verification/continue",{threadId,recordId:"verification-continue-record",auto:true});assert.equal(continued.turn.id,"verification-turn");assert.equal(continued.nextAction.nextStep.id,"tests");
    const forwarded=upstream.requests.find(message=>message.method==="turn/start");assert.ok(forwarded);assert.equal(forwarded.params.threadId,threadId);assert.match(forwarded.params.input?.[0]?.text||"",/Continue verification/i);
    const context=forwarded.params.additionalContext?.["trebell.verification_continue"]?.value||"";assert.match(context,/npm test/);assert.match(context,/Run affected tests/);assert.doesNotMatch(context,/TOP_SECRET_OUTPUT/);assert.ok(forwarded.params.additionalContext?.["trebell.continuity"]);
    const meta=await fetch(gui.url+"/api/thread-meta?"+new URLSearchParams({threadId})).then(response=>response.json());assert.equal(meta.verificationContinuationChain?.lastContinuationTurnId,"verification-turn");assert.equal(meta.verificationAutomationChain?.lastAutomaticTurnId,"verification-turn");assert.equal(meta.verificationAutomationChain?.lastAction,"verify");
    const traces=await fetch(gui.url+"/api/traces?threadId="+encodeURIComponent(threadId)+"&category=verification&limit=20").then(response=>response.json());assert.ok(traces.items.some(item=>item.name==="verification.continuation_started"&&item.data?.recordId==="verification-continue-record"&&item.data?.nextStepId==="tests"));
  }finally{try{ws?.close()}catch{}await gui.close();await upstream.close();await rm(home,{recursive:true,force:true})}
});
