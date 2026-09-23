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
  const calls=[];let queue=[];let nextQueueId=1;let nextTurnId=1;let slowNextQueueAdd=false;let rejectNextQueueAdd=false;
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
      else if(message.method==="thread/queue/list")result={data:queue.map(item=>({...item,input:item.input.map(input=>({...input}))})),nextCursor:null};
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
      }else if(message.method==="turn/steer")result={turnId:message.params.expectedTurnId};
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
    await page.goto("/");await page.getByRole("button",{name:/Codex queue fixture/}).click();
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
