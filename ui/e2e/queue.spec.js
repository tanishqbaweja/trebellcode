import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test("Codex follow-ups use the native persistent queue",async({page})=>{
  test.setTimeout(45_000);
  const thread={id:"codex-queue-fixture",name:"Codex queue fixture",preview:"Persistent native follow-ups",cwd:process.cwd(),createdAt:Date.now()-1000,updatedAt:Date.now(),turns:[]};
  const calls=[];let queue=[];let nextQueueId=1;let nextTurnId=1;let slowNextQueueAdd=false;let rejectNextQueueAdd=false;let rejectQueueLists=0;let rejectNextSteer=false;
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  const notify=(ws,method,params)=>ws.readyState===ws.OPEN&&ws.send(JSON.stringify({method,params}));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      const respond=value=>ws.send(JSON.stringify({id:message.id,result:value}));
      if(message.method==="initialize")result={userAgent:"queue-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume"||message.method==="thread/read")result={thread};
      else if(message.method==="thread/items/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list")result={data:[],nextCursor:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/queue/list"){
        if(rejectQueueLists>0){rejectQueueLists--;ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"fixture queue refresh rejection"}}));return}
        result={data:queue.map(item=>({...item,input:item.input.map(input=>({...input}))})),nextCursor:null};
      }
      else if(message.method==="thread/queue/add"){
        if(rejectNextQueueAdd){rejectNextQueueAdd=false;ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"fixture queue rejection"}}));return}
        const finish=()=>{const item={id:"q"+(nextQueueId++),input:message.params.input,clientUserMessageId:message.params.clientUserMessageId};queue.push(item);respond({queuedSubmission:item});setTimeout(()=>notify(ws,"thread/queue/changed",{threadId:thread.id}),0)};
        if(slowNextQueueAdd){slowNextQueueAdd=false;setTimeout(finish,250)}else finish();return;
      }else if(message.method==="thread/queue/update"){
        const index=queue.findIndex(item=>item.id===message.params.queuedSubmissionId);if(index>=0)queue[index]={...queue[index],input:message.params.input};result={queuedSubmission:queue[index]};
        respond(result);setTimeout(()=>notify(ws,"thread/queue/changed",{threadId:thread.id}),0);return;
      }else if(message.method==="thread/queue/reorder"){
        const byId=new Map(queue.map(item=>[item.id,item]));queue=message.params.queuedSubmissionIds.map(id=>byId.get(id)).filter(Boolean);result={};
        respond(result);setTimeout(()=>notify(ws,"thread/queue/changed",{threadId:thread.id}),0);return;
      }else if(message.method==="thread/queue/delete"){
        const before=queue.length;queue=queue.filter(item=>item.id!==message.params.queuedSubmissionId);result={deleted:queue.length!==before};
        respond(result);setTimeout(()=>notify(ws,"thread/queue/changed",{threadId:thread.id}),0);return;
      }else if(message.method==="thread/queue/start"){
        const index=queue.findIndex(item=>item.id===message.params.queuedSubmissionId);const item=queue[index];if(index>=0)queue.splice(index,1);const turn={id:"turn-"+(nextTurnId++),status:"inProgress",items:[]};result={turn};
        respond(result);setTimeout(()=>{notify(ws,"thread/queue/changed",{threadId:thread.id});notify(ws,"turn/started",{threadId:thread.id,turn})},0);return;
      }else if(message.method==="turn/start"){
        const turn={id:"turn-"+(nextTurnId++),status:"inProgress",items:[]};result={turn};respond(result);setTimeout(()=>notify(ws,"turn/started",{threadId:thread.id,turn}),0);return;
      }else if(message.method==="turn/steer"){
        if(rejectNextSteer){rejectNextSteer=false;ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"fixture steer rejection"}}));return}
        result={turnId:message.params.expectedTurnId};
      }
      else if(message.method==="turn/interrupt")result={};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      respond(result);
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamPort}`});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/codex/ws`,cwd:process.cwd(),platform:process.platform,version:"queue-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");
    const queueRow=page.locator(".thread-row").filter({hasText:"Codex queue fixture"});
    await queueRow.locator(".thread-main").click();
    await expect(queueRow).toHaveClass(/active/);
    const composer=page.getByTestId("composer");await composer.fill("Initial active turn");await page.getByTestId("send").click();
    await expect.poll(()=>calls.some(call=>call.method==="turn/start")).toBe(true);

    const send=page.getByTestId("send");slowNextQueueAdd=true;
    await composer.fill("First queued follow-up");await send.click();
    await expect(composer).toBeDisabled();await expect(send).toBeDisabled();
    await expect(page.locator(".queued-message")).toHaveCount(1);await expect(composer).toBeEnabled();
    await composer.fill("Second queued follow-up");await expect(composer).toHaveValue("Second queued follow-up");await expect(send).toBeEnabled();await send.click();
    await expect(page.locator(".queued-message")).toHaveCount(2);await expect(page.locator(".queued-message").nth(0)).toContainText("First queued follow-up");
    rejectNextQueueAdd=true;
    await composer.fill("Rejected queued draft");await send.click();
    await expect(composer).toBeEnabled();await expect(composer).toHaveValue("Rejected queued draft");await expect(page.locator(".queued-message")).toHaveCount(2);
    await composer.fill("");
    await page.locator(".queued-message").nth(1).getByRole("button",{name:"Move queued follow-up up"}).click();
    await expect(page.locator(".queued-message").nth(0)).toContainText("Second queued follow-up");
    await page.locator(".queued-message").nth(0).getByRole("button",{name:"Edit"}).click();await expect(composer).toHaveValue("Second queued follow-up");
    await composer.fill("Second queued follow-up edited");await page.getByTestId("send").click();await expect(page.locator(".queued-message").nth(0)).toContainText("Second queued follow-up edited");
    await composer.fill("Keep backend queue identity fresh");await send.click();await expect(page.locator(".queued-message")).toHaveCount(3);
    rejectNextSteer=true;rejectQueueLists=2;
    const refreshRecovery=page.locator(".queued-message").filter({hasText:"Keep backend queue identity fresh"});
    await refreshRecovery.getByRole("button",{name:"Send now"}).click();
    await expect(page.getByTestId("app-action-error")).toContainText("Could not send queued follow-up: fixture steer rejection · Queue was restored, but refresh failed: fixture queue refresh rejection.");
    await expect(refreshRecovery).toBeVisible();
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({path:auditDir+"chat-native-queue-refresh-error-1280x800.png",fullPage:true});
    await refreshRecovery.getByRole("button",{name:"Send now"}).click();
    await expect(refreshRecovery).toHaveCount(0);
    expect(queue.some(entry=>JSON.stringify(entry.input).includes("Keep backend queue identity fresh"))).toBe(false);
    await composer.fill("Recover me if send-now restore fails");await send.click();await expect(page.locator(".queued-message")).toHaveCount(3);
    rejectNextSteer=true;rejectNextQueueAdd=true;
    await page.locator(".queued-message").nth(2).getByRole("button",{name:"Send now"}).click();
    await expect(page.getByTestId("app-action-error")).toContainText("Could not send queued follow-up: fixture steer rejection · Native queue restore also failed: fixture queue rejection. The queued draft was restored to the composer.");
    await expect(composer).toHaveValue("Recover me if send-now restore fails");
    await expect(page.locator(".queued-message")).toHaveCount(2);
    await expect(page.locator(".queued-message").filter({hasText:"Recover me if send-now restore fails"})).toHaveCount(0);
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({path:auditDir+"chat-native-queue-restore-error-1280x800.png",fullPage:true});
    await composer.fill("");
    await page.screenshot({path:auditDir+"chat-native-queue-1600x980.png",fullPage:true});
    await page.setViewportSize({width:1280,height:800});
    const queueCardOverflow=await page.locator(".queued-message").nth(0).evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(queueCardOverflow.scroll).toBeLessThanOrEqual(queueCardOverflow.client+1);
    await page.screenshot({path:auditDir+"chat-native-queue-1280x800.png",fullPage:true});
    await page.locator(".queued-message").nth(0).getByRole("button",{name:"Send now"}).click();
    await expect(page.locator(".queued-message")).toHaveCount(1);await expect.poll(()=>calls.some(call=>call.method==="turn/steer")).toBe(true);

    await page.reload();await page.getByRole("button",{name:/Codex queue fixture/}).click();await expect(page.locator(".queued-message")).toHaveCount(1);await expect(page.locator(".queued-message")).toContainText("First queued follow-up");
    await page.locator(".queued-message").getByRole("button",{name:"Send now"}).click();await expect(page.locator(".queued-message")).toHaveCount(0);
    await expect.poll(()=>calls.some(call=>call.method==="thread/queue/start")).toBe(true);await expect(page.locator(".user-bubble")).toContainText("First queued follow-up");
    await page.screenshot({path:auditDir+"chat-native-queue-started-1280x800.png",fullPage:true});
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});

test("Codex project follow-ups persist in Trebell and rebuild repository context before dispatch",async({page})=>{
  test.setTimeout(45_000);
  const project={id:"queue-context-project",name:"Queue Context Project",path:process.cwd(),environmentId:null};
  const thread={id:"codex-project-queue",name:"Codex project queue fixture",preview:"Fresh context for persisted follow-ups",cwd:project.path,projectId:"native-project",createdAt:Date.now()-1000,updatedAt:Date.now(),turns:[]};
  const calls=[];let nextTurnId=1,notificationSocket=null;
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  const notify=(method,params)=>notificationSocket?.readyState===notificationSocket?.OPEN&&notificationSocket.send(JSON.stringify({method,params}));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);notificationSocket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"project-queue-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/resume"||message.method==="thread/read")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/items/list"||message.method==="thread/attachment/list"||message.method==="thread/timeline/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="project/list")result={data:[{id:"native-project",name:project.name,roots:[{path:project.path}],metadata:{trebellProjectId:project.id}}],nextCursor:null};
      else if(message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="turn/start"){
        const turn={id:"project-turn-"+(nextTurnId++),status:"inProgress",items:[]};thread.status={type:"active",turnId:turn.id};result={turn};
        ws.send(JSON.stringify({id:message.id,result}));setTimeout(()=>notify("turn/started",{threadId:thread.id,turn}),0);return;
      }else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamPort}`});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  let meta={projectless:false,environmentId:null,cwd:project.path},contextCount=0,failQueuePersist=false;const contextBodies=[];
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/codex/ws`,cwd:project.path,platform:process.platform,version:"project-queue-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue",activeProjectId:project.id},projects:[project],threadMeta:{[thread.id]:meta}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[project],project})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/thread-meta$/,route=>{
      if(route.request().method()==="POST"){
        const body=route.request().postDataJSON();
        if(failQueuePersist&&Object.prototype.hasOwnProperty.call(body.patch||{},"trebellQueue"))return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate Trebell queue persistence failure"})});
        meta={...meta,...(body.patch||{})};return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(meta)})
      }
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(meta)});
    });
    await page.route(/\/api\/context\/packet$/,route=>{
      const body=route.request().postDataJSON();contextBodies.push(body);contextCount++;
      const injection=`FRESH_CONTEXT_${contextCount}\nTask: ${body.task}`;
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"ctx-"+contextCount,root:project.path,task:body.task,generatedAt:Date.now(),tokenEstimate:32,maxTokens:2800,items:[{path:"src/context.js",score:90,centrality:.2,reasons:["fixture"],symbols:[],tokenEstimate:20}],injection,budget:{mode:"focused",pressure:"normal",maxTokens:2800,maxFiles:12},stats:{filesIndexed:1,reparsed:0,reused:1,skipped:0,inspected:0,graphEdges:0,durationMs:1}})})});
    await page.route(/\/api\/git\/info\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,root:project.path,branch:"main",branches:["main"],upstream:"origin/main",status:[],remotes:[],worktrees:[{path:project.path,branch:"main"}]})}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="GET"?{checkpoints:[]}:{supported:false})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");
    const row=page.locator(".thread-row").filter({hasText:"Codex project queue fixture"});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    const composer=page.getByTestId("composer");await composer.fill("Initial project turn");await page.getByTestId("send").click();
    await expect.poll(()=>calls.filter(call=>call.method==="turn/start").length).toBe(1);
    expect(calls.find(call=>call.method==="turn/start")?.params?.additionalContext?.["trebell.repo_evidence"]?.value).toContain("FRESH_CONTEXT_1");
    failQueuePersist=true;await composer.fill("Do not lose this queued draft");await page.getByTestId("send").click();
    await expect(composer).toHaveValue("Do not lose this queued draft");
    await expect(page.locator(".tool-event.kind-error").filter({hasText:"Could not queue follow-up"})).toContainText("Deliberate Trebell queue persistence failure");
    await expect(page.locator(".queued-message")).toHaveCount(0);
    await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"chat-project-queue-persistence-error-1280x800.png",fullPage:true});
    failQueuePersist=false;
    await composer.fill("Queued project follow-up");await page.getByTestId("send").click();
    const queued=page.locator(".queued-message").filter({hasText:"Queued project follow-up"});await expect(queued).toBeVisible();
    expect(calls.some(call=>call.method==="thread/queue/add")).toBe(false);
    expect(meta.trebellQueue?.[0]?.text).toBe("Queued project follow-up");
    await page.reload();
    const reopenedRow=page.locator(".thread-row").filter({hasText:"Codex project queue fixture"});await reopenedRow.locator(".thread-main").click();await expect(reopenedRow).toHaveClass(/active/);
    const restoredQueue=page.locator(".queued-message").filter({hasText:"Queued project follow-up"});await expect(restoredQueue).toBeVisible();
    await page.waitForTimeout(350);expect(calls.filter(call=>call.method==="turn/start").length).toBe(1);
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeVisible();
    await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"chat-project-queue-restored-running-1280x800.png",fullPage:true});
    thread.status={type:"idle"};
    notify("turn/completed",{threadId:thread.id,turn:{id:"project-turn-1",status:"completed"}});
    await expect.poll(()=>calls.filter(call=>call.method==="turn/start").length).toBe(2);
    const secondTurn=calls.filter(call=>call.method==="turn/start")[1];
    expect(contextBodies.at(-1)?.task).toBe("Queued project follow-up");
    expect(secondTurn.params.additionalContext?.["trebell.repo_evidence"]?.value).toContain("FRESH_CONTEXT_2");
    await expect(restoredQueue).toHaveCount(0);await expect.poll(()=>meta.trebellQueue?.length||0).toBe(0);
    expect(calls.some(call=>call.method==="thread/queue/start")).toBe(false);
    await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"chat-project-persistent-context-queue-1280x800.png",fullPage:true});
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});
