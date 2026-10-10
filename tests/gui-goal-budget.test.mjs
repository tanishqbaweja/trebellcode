import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws}
function request(ws){let id=0;return (method,params={})=>new Promise((resolve,reject)=>{const requestId=++id;const onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);if(message.error){const error=Object.assign(new Error(message.error.message),{code:message.error.code});reject(error)}else resolve(message.result)};ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}))})}
async function until(check,attempts=100){for(let attempt=0;attempt<attempts&&!check();attempt++)await new Promise(resolve=>setTimeout(resolve,10));return check()}

// Codex's native goal API (thread/goal/get, set, clear) as the installed CLI answers it: times in seconds, a
// thread/goal/updated or thread/goal/cleared notification after each change.
async function fakeCodexGoals(port){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),requests=[],goals=new Map();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  const notify=(method,params)=>{for(const client of wss.clients)client.send(JSON.stringify({method,params}))};
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);
    const params=message.params||{},reply=result=>ws.send(JSON.stringify({id:message.id,result})),now=Math.floor(Date.now()/1000);
    if(message.method==="thread/goal/get")return reply({goal:goals.get(params.threadId)||null});
    if(message.method==="thread/goal/set"){
      const previous=goals.get(params.threadId)||null;
      if(!previous&&!params.objective)return ws.send(JSON.stringify({id:message.id,error:{code:-32600,message:"goal objective is required"}}));
      const goal={threadId:params.threadId,objective:params.objective??previous.objective,status:params.status??previous?.status??"active",tokenBudget:Object.prototype.hasOwnProperty.call(params,"tokenBudget")?params.tokenBudget:(previous?.tokenBudget??null),tokensUsed:previous?.tokensUsed??0,timeUsedSeconds:previous?.timeUsedSeconds??0,createdAt:previous?.createdAt??now,updatedAt:now};
      goals.set(params.threadId,goal);reply({goal});notify("thread/goal/updated",{threadId:params.threadId,goal});return;
    }
    if(message.method==="thread/goal/clear"){const cleared=goals.delete(params.threadId);reply({cleared});if(cleared)notify("thread/goal/cleared",{threadId:params.threadId});return}
    if(message.method==="turn/start")return reply({turn:{id:"fixture-turn-"+requests.length,status:"inProgress",items:[]}});
    reply({});
  }));
  await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {requests,goals,notify,calls:method=>requests.filter(item=>item.method===method),async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

test("Codex goal RPCs run Codex's own goal, with Trebell's guidance and budget gates added",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-goal-")),[port,appPort]=await Promise.all([freePort(),freePort()]),upstream=await fakeCodexGoals(appPort);
  const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});const threadId="codex-goal-thread";let ws,observer;const observerMessages=[],rendererMessages=[];
  try{
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,patch:{runtime:"codex",runtimeInstanceId:"codex-default",environmentId:null,cwd:home}})});
    ws=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");observer=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");
    observer.on("message",raw=>{const message=JSON.parse(String(raw));if(message.method&&message.id==null)observerMessages.push(message)});
    ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.method&&message.id==null)rendererMessages.push(message)});
    const rpc=request(ws);
    const set=await rpc("thread/goal/set",{threadId,objective:"Finish the Codex fixture",completionConditions:["Budget gate works"],constraints:["Do not forward exhausted work"],validationExpectations:["Trace the block"],tokenBudget:1000,timeBudgetMinutes:1,turnBudget:2,toolCallBudget:2,childAgentBudget:1,costBudgetUsd:10,unexpected:"ignored"});
    assert.deepEqual(upstream.calls("thread/goal/set").map(call=>call.params),[{threadId,objective:"Finish the Codex fixture",status:"active",tokenBudget:1000}],"Codex gets its own fields only");
    assert.equal(set.goal.objective,"Finish the Codex fixture");assert.equal(set.goal.status,"active");assert.equal(set.goal.tokenBudget,1000);assert.equal(set.goal.timeBudgetMinutes,1);assert.equal(set.goal.turnBudget,2);assert.equal(set.goal.toolCallBudget,2);assert.equal(set.goal.childAgentBudget,1);assert.equal(set.goal.toolCallsUsed,0);assert.equal(set.goal.toolCallTelemetryComplete,true);assert.equal(set.goal.childAgentsUsed,0);assert.equal(set.goal.childAgentTelemetryComplete,true);assert.equal(set.goal.costBudgetUsd,10);assert.equal(set.goal.timeUsedSeconds,0);assert.equal(Object.prototype.hasOwnProperty.call(set.goal,"unexpected"),false);
    assert.deepEqual(set.goal.completionConditions,["Budget gate works"]);
    assert.ok(await until(()=>observerMessages.some(message=>message.method==="thread/goal/updated"&&message.params?.threadId===threadId&&message.params?.goal?.objective==="Finish the Codex fixture")));
    assert.ok(await until(()=>rendererMessages.some(message=>message.method==="thread/goal/updated"&&message.params?.goal?.constraints?.includes("Do not forward exhausted work"))),"Codex's own notification reaches the renderer with Trebell's guidance");
    const continuitySet=await rpc("thread/continuity/set",{threadId,completedWork:["Added durable goal RPCs"],unresolvedFailures:["Need final browser check"],importantDecisions:["Keep provider-neutral state"],pendingNextActions:["Run smoke tests"]});
    assert.ok(continuitySet.continuity.completedWork.includes("Added durable goal RPCs"));assert.ok(continuitySet.continuity.unresolvedFailures.includes("Need final browser check"));
    assert.ok(await until(()=>observerMessages.some(message=>message.method==="thread/continuity/updated"&&message.params?.threadId===threadId&&message.params?.continuity?.pendingNextActions?.includes("Run smoke tests"))));
    const startedAt=Date.now()-61_000;upstream.goals.get(threadId).createdAt=Math.floor((startedAt-1_000)/1000);
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,patch:{codexToolCallCount:2,codexChildAgentCount:1,active:true,restartRecovery:{runtime:"codex",bootId:"fixture-boot",threadId,turnId:"turn-1",status:"active",startedAt}}})});
    const recovery=await fetch(gui.url+"/api/recovery",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,action:"completed"})});assert.equal(recovery.status,200);
    const exhausted=(await rpc("thread/goal/get",{threadId})).goal;assert.ok(exhausted.timeUsedSeconds>=60);assert.equal(exhausted.turnsUsed,1);assert.equal(exhausted.turnBudgetRemaining,1);assert.equal(exhausted.toolCallsUsed,2);assert.equal(exhausted.toolCallBudgetRemaining,0);assert.equal(exhausted.childAgentsUsed,1);assert.equal(exhausted.childAgentBudgetRemaining,0);assert.equal(exhausted.costUsedUsd,null);assert.equal(exhausted.costTelemetryComplete,false);assert.equal(exhausted.budgetExhausted,true);assert.equal(exhausted.timeBudgetRemainingMinutes,0);
    assert.deepEqual(exhausted.validationExpectations,["Trace the block"],"a read keeps Trebell's guidance next to Codex's goal");
    const continuityAfterTurn=(await rpc("thread/continuity/get",{threadId})).continuity;assert.deepEqual(continuityAfterTurn.completedTurnIds,["turn-1"]);assert.equal(continuityAfterTurn.workspace.runtime,"codex");
    await assert.rejects(rpc("thread/delegate",{threadId,task:"Must not create a child",isolation:"shared"}),error=>error.code===-32001&&/child-agent budget exhausted/i.test(error.message));
    await rpc("turn/start",{threadId,turnTrigger:"trebell-restart-continuation",input:[{type:"text",text:"continue interrupted work"}]});
    const continued=upstream.calls("turn/start").at(-1);assert.equal(continued.params.input[0].text,"continue interrupted work");
    assert.ok(continued.params.additionalContext?.["trebell.goal"],"restart continuation must receive the durable goal as application context");
    assert.ok(continued.params.additionalContext?.["trebell.continuity"],"restart continuation must receive durable continuity state");
    await assert.rejects(rpc("turn/start",{threadId,input:[{type:"text",text:"must not reach Codex"}]}),error=>error.code===-32001&&/Goal budget exhausted/i.test(error.message));
    await assert.rejects(rpc("thread/queue/start",{threadId,queuedSubmissionId:"queued-1"}),error=>error.code===-32001&&/Goal budget exhausted/i.test(error.message));
    assert.equal(upstream.calls("turn/start").length,1,"exhausted work never reaches Codex");
    const traces=await fetch(gui.url+"/api/traces?threadId="+encodeURIComponent(threadId)+"&limit=20").then(response=>response.json());
    assert.ok(traces.items.filter(item=>item.name==="goal.budget_blocked").length>=2);assert.ok(traces.items.filter(item=>item.name==="goal.budget_blocked").every(item=>item.data?.timeExhausted===true&&item.data?.toolCallExhausted===true&&item.data?.childAgentExhausted===true));
    const filteredTraces=await fetch(gui.url+"/api/traces?threadId="+encodeURIComponent(threadId)+"&runtime=codex&category=budget&after="+(Date.now()-60_000)+"&limit=20").then(response=>response.json());
    assert.ok(filteredTraces.items.length>=2);assert.ok(filteredTraces.items.every(item=>item.runtime==="codex"&&item.category==="budget"));
    const futureTraces=await fetch(gui.url+"/api/traces?threadId="+encodeURIComponent(threadId)+"&after="+(Date.now()+60_000)+"&limit=20").then(response=>response.json());
    assert.equal(futureTraces.items.length,0);
    const setsBeforeRaise=upstream.calls("thread/goal/set").length;
    const raised=(await rpc("thread/goal/set",{threadId,timeBudgetMinutes:2,toolCallBudget:3,childAgentBudget:2})).goal;assert.equal(raised.budgetExhausted,false);assert.ok(raised.timeBudgetRemainingMinutes>0);assert.equal(raised.toolCallBudgetRemaining,1);assert.equal(raised.childAgentBudgetRemaining,1);
    assert.equal(upstream.calls("thread/goal/set").length,setsBeforeRaise,"Trebell-only budgets do not touch Codex's goal");
    await rpc("turn/start",{threadId,input:[{type:"text",text:"gate now allows forwarding"}]});assert.equal(upstream.calls("turn/start").at(-1).params.input[0].text,"gate now allows forwarding");
    const paused=(await rpc("thread/goal/set",{threadId,status:"paused",timeBudgetMinutes:1})).goal;assert.equal(paused.status,"paused");assert.equal(paused.budgetExhausted,true);
    assert.deepEqual(upstream.calls("thread/goal/set").at(-1).params,{threadId,status:"paused"});assert.equal(upstream.goals.get(threadId).status,"paused");
    await rpc("turn/start",{threadId,input:[{type:"text",text:"paused goal does not enforce budget"}]});
    const pausedStart=upstream.calls("turn/start").at(-1);assert.equal(pausedStart.params.input[0].text,"paused goal does not enforce budget");
    assert.equal(Boolean(pausedStart.params.additionalContext?.["trebell.goal"]),false,"paused goals must not steer new work");
    assert.equal(Boolean(pausedStart.params.additionalContext?.["trebell.continuity"]),true,"continuity remains available even when the goal is paused");
    const cleared=await rpc("thread/goal/clear",{threadId});assert.equal(cleared.ok,true);assert.equal(cleared.cleared,true);assert.equal(upstream.goals.has(threadId),false);
    assert.equal((await rpc("thread/goal/get",{threadId})).goal,null);
    assert.ok(await until(()=>observerMessages.some(message=>message.method==="thread/goal/updated"&&message.params?.threadId===threadId&&message.params?.goal===null)));
    assert.ok(await until(()=>rendererMessages.some(message=>message.method==="thread/goal/cleared"&&message.params?.threadId===threadId)));
    const continuityClear=await rpc("thread/continuity/clear",{threadId});assert.equal(continuityClear.ok,true);assert.equal(continuityClear.continuity.completedWork.length,0);
  }finally{
    try{ws?.close()}catch{}try{observer?.close()}catch{}await gui.close();await upstream.close();await rm(home,{recursive:true,force:true});
  }
});

test("a new Codex goal objective replaces the goal, Codex's own statuses stay, and a Trebell-only goal is not sent",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-goal-replace-")),[port,appPort]=await Promise.all([freePort(),freePort()]),upstream=await fakeCodexGoals(appPort);
  const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});const threadId="codex-goal-replace",childId="codex-delegated-child";let ws;
  try{
    for(const id of [threadId,childId])await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:id,patch:{runtime:"codex",runtimeInstanceId:"codex-default",environmentId:null,cwd:home}})});
    ws=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");const rpc=request(ws);
    await rpc("thread/goal/set",{threadId,objective:"First objective",status:"paused",constraints:["Old guidance"]});
    const replaced=(await rpc("thread/goal/set",{threadId,objective:"Second objective",status:"paused"})).goal;
    assert.equal(replaced.objective,"Second objective");assert.deepEqual(replaced.constraints,[],"a replaced goal starts without the old guidance");
    assert.deepEqual(upstream.requests.filter(item=>/^thread\/goal\/(set|clear)$/.test(item.method)).map(item=>item.method),["thread/goal/set","thread/goal/clear","thread/goal/set"]);
    upstream.goals.get(threadId).status="budgetLimited";
    const limited=(await rpc("thread/goal/get",{threadId})).goal;assert.equal(limited.status,"budgetLimited","Codex's own status is kept, not mapped to active");
    await rpc("thread/goal/set",{threadId,objective:"Second objective",status:"budgetLimited",tokenBudget:5000});
    assert.deepEqual(upstream.calls("thread/goal/set").at(-1).params,{threadId,tokenBudget:5000},"a status Codex set itself is left to Codex");
    await assert.rejects(rpc("thread/goal/set",{threadId,status:"finished"}),error=>error.code===-32602);
    // A delegated child's goal is Trebell's own budget record: reads keep it and Codex is not asked to run it.
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:childId,patch:{goal:{threadId:childId,objective:"Delegated task",status:"active",childAgentBudget:0,createdAt:Date.now(),updatedAt:Date.now()},goalBudgetBaselines:{toolCalls:0,childAgents:0,toolCallTelemetryComplete:true,childAgentTelemetryComplete:true}}})});
    const child=(await rpc("thread/goal/get",{threadId:childId})).goal;assert.equal(child.objective,"Delegated task");assert.equal(child.status,"active");
    assert.equal(upstream.calls("thread/goal/set").filter(call=>call.params.threadId===childId).length,0);
  }finally{
    try{ws?.close()}catch{}await gui.close();await upstream.close();await rm(home,{recursive:true,force:true});
  }
});

test("a finished Codex goal turn pauses the goal once a budget only Trebell tracks runs out",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-goal-pause-")),[port,appPort]=await Promise.all([freePort(),freePort()]),upstream=await fakeCodexGoals(appPort);
  const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});const threadId="codex-goal-turns",quietId="codex-goal-quiet";let ws;
  const budgetPaused=async id=>{for(let attempt=0;attempt<50;attempt++){const traces=await fetch(gui.url+"/api/traces?threadId="+encodeURIComponent(id)+"&category=budget&limit=20").then(response=>response.json());const hit=traces.items.find(item=>item.name==="goal.budget_paused");if(hit)return hit;await new Promise(resolve=>setTimeout(resolve,10))}return null};
  try{
    for(const id of [threadId,quietId])await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:id,patch:{runtime:"codex",runtimeInstanceId:"codex-default",environmentId:null,cwd:home}})});
    ws=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");const rpc=request(ws);
    await rpc("thread/goal/set",{threadId,objective:"Keep going until the turn budget is used",turnBudget:1});
    assert.equal(upstream.goals.get(threadId).status,"active");
    // Codex runs the goal turn itself; the relay sees only its notifications. As live, Codex starts its next goal turn
    // the moment one ends, before the pause reaches it.
    upstream.notify("turn/started",{threadId,turn:{id:"goal-turn-1",status:"inProgress",startedAt:Math.floor(Date.now()/1000)}});
    await new Promise(resolve=>setTimeout(resolve,50));
    upstream.notify("turn/completed",{threadId,turn:{id:"goal-turn-1",status:"completed"}});
    upstream.notify("turn/started",{threadId,turn:{id:"goal-turn-2",status:"inProgress",startedAt:Math.floor(Date.now()/1000)}});
    assert.ok(await until(()=>upstream.goals.get(threadId)?.status==="paused",200),"the relay paused Codex's goal");
    assert.deepEqual(upstream.calls("thread/goal/set").at(-1).params,{threadId,status:"paused"});
    assert.ok(await until(()=>upstream.calls("turn/interrupt").length>0,200),"the goal turn Codex started past the budget is stopped");
    assert.deepEqual(upstream.calls("turn/interrupt").map(call=>call.params),[{threadId,turnId:"goal-turn-2"}]);
    const paused=await budgetPaused(threadId);assert.equal(paused?.data?.turnExhausted,true);assert.equal(paused?.data?.interruptedTurnId,"goal-turn-2");
    // A goal whose last turn ends with nothing after it is only paused.
    await rpc("thread/goal/set",{threadId:quietId,objective:"One turn only",turnBudget:1});
    upstream.notify("turn/started",{threadId:quietId,turn:{id:"quiet-turn-1",status:"inProgress"}});
    await new Promise(resolve=>setTimeout(resolve,50));
    upstream.notify("turn/completed",{threadId:quietId,turn:{id:"quiet-turn-1",status:"completed"}});
    const quiet=await budgetPaused(quietId);assert.equal(upstream.goals.get(quietId)?.status,"paused");assert.equal(quiet?.data?.interruptedTurnId,null);
    assert.equal(upstream.calls("turn/interrupt").filter(call=>call.params.threadId===quietId).length,0);
  }finally{
    try{ws?.close()}catch{}await gui.close();await upstream.close();await rm(home,{recursive:true,force:true});
  }
});
