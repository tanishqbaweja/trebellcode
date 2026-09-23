import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("desktop Codex collaboration mode uses native Plan and Default settings",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"collaboration-fixture",name:"Plan mode fixture",preview:"Native collaboration mode",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  const modes=[
    {name:"Plan",mode:"plan",model:null,reasoning_effort:"medium"},
    {name:"Default",mode:"default",model:null,reasoning_effort:null},
  ];
  const calls=[];let notificationSocket=null;
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);notificationSocket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"collaboration-mode-fixture"};
      else if(message.method==="collaborationMode/list")result={data:modes};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null,collaborationMode:{mode:"plan",settings:{model:"freebuff/test/coding-fast",reasoning_effort:"medium",developer_instructions:null}}};
      else if(message.method==="thread/settings/update")result={};
      else if(message.method==="turn/start")result={turn:{id:"turn-plan",status:"inProgress"}};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:process.platform,version:"collaboration-mode-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.route(/\/api\/checkpoints$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({checkpoints:[]})}));
    await page.goto("/");
    const picker=page.getByTestId("collaboration-mode-picker");await expect(picker).toBeVisible();await expect(picker).toHaveValue("default");
    expect(calls.find(call=>call.method==="collaborationMode/list")?.params).toEqual({});
    await page.getByRole("button",{name:/Plan mode fixture/}).click();await expect(picker).toHaveValue("plan");

    await picker.selectOption("default");await expect(picker).toHaveValue("default");
    await expect.poll(()=>calls.filter(call=>call.method==="thread/settings/update").length).toBe(1);
    expect(calls.find(call=>call.method==="thread/settings/update")?.params).toEqual({
      threadId:thread.id,
      collaborationMode:{mode:"default",settings:{model:"freebuff/test/coding-fast",reasoning_effort:null,developer_instructions:null}},
    });

    notificationSocket.send(JSON.stringify({method:"thread/settings/updated",params:{threadId:thread.id,threadSettings:{collaborationMode:{mode:"plan",settings:{model:"freebuff/test/coding-fast",reasoning_effort:"medium",developer_instructions:null}}}}}));
    await expect(picker).toHaveValue("plan");
    await page.getByTestId("composer").fill("Use Plan mode for this task");await page.getByTestId("send").click();
    await expect.poll(()=>calls.filter(call=>call.method==="turn/start").length).toBe(1);
    expect(calls.find(call=>call.method==="turn/start")?.params?.collaborationMode).toEqual({mode:"plan",settings:{model:"freebuff/test/coding-fast",reasoning_effort:"medium",developer_instructions:null}});

    await page.setViewportSize({width:1600,height:980});await page.screenshot({path:auditDir+"chat-collaboration-plan-1600x980.png",fullPage:true});
    await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({path:auditDir+"chat-collaboration-plan-light-1280x800.png",fullPage:true});
    const bounds=await page.locator(".chat-workspace").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});
