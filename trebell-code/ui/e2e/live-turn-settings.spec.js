import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("changing models during a running Codex turn updates the live turn",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"live-model-fixture",name:"Live model fixture",preview:"Switch the running model",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  const calls=[];let notificationSocket=null,featureEnabled=true;
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);notificationSocket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"live-model-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="experimentalFeature/list")result={data:[{name:"step_model_switching",stage:"underDevelopment",displayName:null,description:null,announcement:null,enabled:featureEnabled,defaultEnabled:false}],nextCursor:null};
      else if(message.method==="turn/settings/update")result={status:"applied"};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:process.platform,version:"live-model-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"steer"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/model-a","freebuff/model-b"],metadata:{provider:"freebuff",models:[{id:"freebuff/model-a",name:"Model A",provider:"freebuff",agent:"Codex"},{id:"freebuff/model-b",name:"Model B",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");await page.getByRole("button",{name:/Live model fixture/}).click();
    await expect(page.getByTestId("model-picker")).toContainText("Model A");
    notificationSocket.send(JSON.stringify({method:"turn/started",params:{threadId:thread.id,turn:{id:"turn-live",status:"inProgress",startedAt:Date.now()/1000}}}));
    await expect(page.getByTestId("composer")).toHaveAttribute("placeholder","Steer the running agent…");
    const picker=page.getByTestId("model-picker");await expect(picker).toHaveAttribute("title","Select model · applies live when Codex step model switching is enabled");await picker.click();
    await page.locator(".model-picker-menu").getByRole("button",{name:/Model B/}).click();
    await expect(picker).toContainText("Model B");
    await expect.poll(()=>calls.filter(call=>call.method==="turn/settings/update").length).toBe(1);
    expect(calls.find(call=>call.method==="experimentalFeature/list")?.params).toEqual({limit:200,threadId:thread.id});
    const update=calls.find(call=>call.method==="turn/settings/update");expect(update?.params).toEqual({threadId:thread.id,turnId:"turn-live",model:"freebuff/model-b"});
    await expect(page.getByText("Running turn switched to Model B",{exact:true})).toBeVisible();
    await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"chat-live-model-switch-1280x800.png",fullPage:true});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({path:auditDir+"chat-live-model-switch-light-1280x800.png",fullPage:true});
    const bounds=await page.locator(".chat-workspace").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});featureEnabled=false;
    notificationSocket.send(JSON.stringify({method:"turn/completed",params:{threadId:thread.id,turn:{id:"turn-live",status:"completed",completedAt:Date.now()/1000}}}));
    notificationSocket.send(JSON.stringify({method:"turn/started",params:{threadId:thread.id,turn:{id:"turn-next",status:"inProgress",startedAt:Date.now()/1000}}}));
    await expect(page.getByTestId("composer")).toHaveAttribute("placeholder","Steer the running agent…");
    await picker.click();await page.locator(".model-picker-menu").getByRole("button",{name:/Model A/}).click();await expect(picker).toContainText("Model A");
    await expect(page.getByText("Model changed for the next turn. Live model switching is disabled in Codex experimental features.",{exact:true})).toBeVisible();
    expect(calls.filter(call=>call.method==="experimentalFeature/list")).toHaveLength(2);
    expect(calls.filter(call=>call.method==="turn/settings/update")).toHaveLength(1);
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});
