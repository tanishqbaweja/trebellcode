import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws}
function request(ws){let id=0;return (method,params={})=>new Promise((resolve,reject)=>{const requestId=++id;const onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);if(message.error){const error=Object.assign(new Error(message.error.message),{code:message.error.code});reject(error)}else resolve(message.result)};ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}))})}

test("Codex relay owns durable goal RPCs and blocks exhausted direct or queued work before upstream",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-goal-")),[port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});const threadId="codex-goal-thread";let ws;
  try{
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,patch:{runtime:"codex",runtimeInstanceId:"codex-default",environmentId:null,cwd:home}})});
    ws=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");const rpc=request(ws);
    const set=await rpc("thread/goal/set",{threadId,objective:"Finish the Codex fixture",completionConditions:["Budget gate works"],constraints:["Do not forward exhausted work"],validationExpectations:["Trace the block"],tokenBudget:1000,timeBudgetMinutes:1,unexpected:"ignored"});
    assert.equal(set.goal.objective,"Finish the Codex fixture");assert.equal(set.goal.timeBudgetMinutes,1);assert.equal(set.goal.timeUsedSeconds,0);assert.equal(Object.prototype.hasOwnProperty.call(set.goal,"unexpected"),false);
    const startedAt=Date.now()-61_000;
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,patch:{goal:{...set.goal,createdAt:startedAt-1_000},active:true,restartRecovery:{runtime:"codex",bootId:"fixture-boot",threadId,turnId:"turn-1",status:"active",startedAt}}})});
    const recovery=await fetch(gui.url+"/api/recovery",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,action:"completed"})});assert.equal(recovery.status,200);
    const exhausted=(await rpc("thread/goal/get",{threadId})).goal;assert.ok(exhausted.timeUsedSeconds>=60);assert.equal(exhausted.budgetExhausted,true);assert.equal(exhausted.timeBudgetRemainingMinutes,0);
    await assert.rejects(rpc("turn/start",{threadId,input:[{type:"text",text:"must not reach Codex"}]}),error=>error.code===-32001&&/Goal budget exhausted/i.test(error.message));
    await assert.rejects(rpc("thread/queue/start",{threadId,queuedSubmissionId:"queued-1"}),error=>error.code===-32001&&/Goal budget exhausted/i.test(error.message));
    const traces=await fetch(gui.url+"/api/traces?threadId="+encodeURIComponent(threadId)+"&limit=20").then(response=>response.json());
    assert.ok(traces.items.filter(item=>item.name==="goal.budget_blocked").length>=2);assert.ok(traces.items.filter(item=>item.name==="goal.budget_blocked").every(item=>item.data?.timeExhausted===true));
    const raised=(await rpc("thread/goal/set",{threadId,timeBudgetMinutes:2})).goal;assert.equal(raised.budgetExhausted,false);assert.ok(raised.timeBudgetRemainingMinutes>0);
    await assert.rejects(rpc("turn/start",{threadId,input:[{type:"text",text:"gate now allows forwarding"}]}),error=>error.code!==-32001&&!/Goal budget exhausted/i.test(error.message));
    const paused=(await rpc("thread/goal/set",{threadId,status:"paused",timeBudgetMinutes:1})).goal;assert.equal(paused.status,"paused");assert.equal(paused.budgetExhausted,true);
    await assert.rejects(rpc("turn/start",{threadId,input:[{type:"text",text:"paused goal does not enforce budget"}]}),error=>error.code!==-32001&&!/Goal budget exhausted/i.test(error.message));
    assert.equal((await rpc("thread/goal/clear",{threadId})).ok,true);assert.equal((await rpc("thread/goal/get",{threadId})).goal,null);
  }finally{
    try{ws?.close()}catch{}await gui.close();await rm(home,{recursive:true,force:true});
  }
});
