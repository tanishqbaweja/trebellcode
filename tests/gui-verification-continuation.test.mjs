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
// afterTurnStart(params): the notifications the fake sends once it has started a turn (the check turn's own items).
async function fakeCodexAppServer(port,{afterTurnStart=()=>[]}={}){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),requests=[];http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);if(message.method==="turn/start"){ws.send(JSON.stringify({id:message.id,result:{turn:{id:"verification-turn",status:"inProgress"}}}));for(const note of afterTurnStart(message.params))ws.send(JSON.stringify(note));return}ws.send(JSON.stringify({id:message.id,result:{}}))}));
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
  }finally{try{ws?.close()}catch{}await gui.close();await upstream.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// The server's own reading of a check turn (plan-turn's continuation branch), over HTTP: a behavioral step's check is kept from the
// command the check turn ran, and a check the person declined stops the chain, which then refuses an automatic check.
test("plan-turn keeps a behavioral check's result and stops the chain after a declined check",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-verification-check-turn-")),[port,appPort]=await Promise.all([freePort(),freePort()]),items=new Map();
  const upstream=await fakeCodexAppServer(appPort,{afterTurnStart:params=>[items.get(params.threadId)].flat().map(item=>({method:"item/completed",params:{threadId:params.threadId,turnId:"verification-turn",item}}))});
  const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});let ws;
  const post=(path,body)=>fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(response=>response.json());
  const plan={risk:"low",steps:[{id:"focused_behavior",kind:"behavioral",scope:"changed-behavior",cost:"medium",required:true,evidence:["stated-acceptance-behavior"],reason:"Run a focused executable check."}]};
  try{
    ws=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");const rpc=rpcClient(ws);
    const checkTurn=async(threadId,item)=>{
      items.set(threadId,item);await post("/api/thread-meta",{threadId,patch:{runtime:"codex",runtimeInstanceId:"codex-default",cwd:home,active:false}});
      await post("/api/verification-records",{id:threadId+"-record",threadId,turnId:"user-turn",projectPath:home,plan,evidence:[]});
      const continued=await rpc("thread/verification/continue",{threadId,recordId:threadId+"-record",auto:true});assert.equal(continued.turn.id,"verification-turn");
      for(let tries=0;tries<50;tries++){const traces=await fetch(gui.url+"/api/traces?"+new URLSearchParams({threadId,limit:"50"})).then(response=>response.json());if(traces.items.filter(trace=>trace.name==="item/completed").length>=[item].flat().length)break;await new Promise(resolve=>setTimeout(resolve,40))}
      return post("/api/verification/plan-turn",{threadId,turnId:"verification-turn"});
    };
    const passed=await checkTurn("check-passed",{type:"commandExecution",id:"check-run",command:["node","check.js"],status:"completed",exitCode:0});
    assert.equal(passed.continuation,true);assert.equal(passed.stopped,undefined);assert.equal(passed.record.assessment.status,"verified");assert.equal(passed.nextAction.action,"complete");
    assert.deepEqual(passed.record.evidence.map(item=>[item.stepId,item.status,item.toolCallId]),[["focused_behavior","passed","check-run"]]);
    const failed=await checkTurn("check-failed",{type:"commandExecution",id:"check-run",command:["node","check.js"],status:"failed",exitCode:3});
    assert.equal(failed.record.assessment.status,"failed");assert.equal(failed.nextAction.action,"repair");
    // A check that could not start (no exit code) after a look that exited 0 is no result: the record is not verified, nor the chain stopped.
    const unstarted=await checkTurn("check-unstarted",[{type:"commandExecution",id:"look",command:["git","status"],status:"completed",exitCode:0},{type:"commandExecution",id:"check-run",command:["node","check.js"],status:"failed",exitCode:null}]);
    assert.equal(unstarted.stopped,undefined);assert.equal(unstarted.record.assessment.status,"incomplete");assert.deepEqual(unstarted.record.evidence,[]);
    const declined=await checkTurn("check-declined",{type:"commandExecution",id:"check-run",command:["node","check.js"],status:"declined",exitCode:null});
    assert.equal(declined.stopped,"not-approved");assert.equal(declined.record.assessment.status,"incomplete");assert.deepEqual(declined.record.evidence,[]);
    await assert.rejects(rpc("thread/verification/continue",{threadId:"check-declined",auto:true}),/The last check was not allowed to run./);
  }finally{try{ws?.close()}catch{}await gui.close();await upstream.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});
