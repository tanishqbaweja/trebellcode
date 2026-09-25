import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

async function startHarness(thread,continuity){
  let socket=null,repairRequests=0;
  const upstreamHttp=createServer(),wss=new WebSocketServer({noServer:true});
  upstreamHttp.on("upgrade",(req,raw,head)=>wss.handleUpgrade(req,raw,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    socket=ws;ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
      let result={};
      if(message.method==="initialize")result={userAgent:"verification-repair-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/continuity/get")result={continuity};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      else if(message.method==="thread/verification/repair"){repairRequests++;result={record:{id:"verification-1"},nextAction:{action:"repair"},turn:{id:"repair-turn",status:"inProgress"}}}
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",
    repairRequests:()=>repairRequests,
    async close(){relay.close();try{socket?.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}

async function routeApp(page,harness,thread){
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"verification-repair-ui",activeEnvironmentId:null,activeEnvironment:null})}));
  await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
  await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
  await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
}

test("failed verification can start a same-thread repair turn from continuity",async({page})=>{
  test.setTimeout(30_000);
  const thread={id:"verification-repair-ui-thread",name:"Verification repair fixture",preview:"Repair loop",cwd:process.cwd(),model:"freebuff/test/coding-fast",createdAt:Date.now()/1000-20,updatedAt:Date.now()/1000,turns:[]};
  const continuity={
    threadId:thread.id,notes:{completedWork:[],unresolvedFailures:[],importantDecisions:[],artifactsCreated:[],pendingNextActions:[],updatedAt:0},
    workspace:{cwd:process.cwd(),branch:null,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default"},
    verification:{status:"failed",risk:"medium",verified:false,summary:"Affected parser tests failed.",updatedAt:Date.now()},
    completedTurnIds:["turn-1"],unresolvedFailures:[],recentFailures:[],artifactsCreated:[],pendingNextActions:[],completedWork:[],importantDecisions:[],meaningful:true,updatedAt:Date.now(),
  };
  const harness=await startHarness(thread,continuity);
  try{
    await routeApp(page,harness,thread);
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Verification repair fixture"]')});
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    await page.locator(".workspace-header").getByRole("button",{name:"Thread goal",exact:true}).click();
    const panel=page.getByTestId("goal-panel");await expect(panel).toBeVisible();
    await panel.locator(".goal-continuity-details>summary").click();
    const repair=panel.getByTestId("verification-repair-card");await expect(repair).toContainText("Verification needs repair");
    await expect(repair).toContainText("No second reviewer model is spawned");
    await repair.getByRole("button",{name:"Repair failed verification",exact:true}).click();
    await expect.poll(()=>harness.repairRequests()).toBe(1);
    await expect(panel.getByText("Repair turn started on this thread.")).toBeVisible();
    await page.setViewportSize({width:1280,height:800});
    await repair.scrollIntoViewIfNeeded();await page.screenshot({path:auditDir+"verification-repair-dark-1280x800.png",fullPage:true});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await expect.poll(()=>repair.evaluate(node=>getComputedStyle(node).backgroundColor)).toBe("rgb(255, 248, 240)");
    await page.screenshot({path:auditDir+"verification-repair-light-1280x800.png",fullPage:true});
  }finally{await harness.close()}
});
