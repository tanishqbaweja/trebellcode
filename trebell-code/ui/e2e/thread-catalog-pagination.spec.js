import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

function meta(id,name,updatedAt){
  return {__catalogOnly:true,runtime:"claude",runtimeInstanceId:"claude-default",projectless:true,updatedAt,threadSnapshot:{id,name,preview:name+" preview",cwd:process.cwd(),model:"claude-test",updatedAt,createdAt:updatedAt-10,status:{type:"idle"},runtime:"claude",provider:"claude"}};
}
async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function startRuntimeHarness(thread){
  const http=createServer(),wss=new WebSocketServer({noServer:true});
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
    let result={};
    if(message.method==="initialize")result={userAgent:"catalog-pagination-connected-fixture"};
    else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
    else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
    ws.send(JSON.stringify({id:message.id,result}));
  }));
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {wsUrl:"ws://127.0.0.1:"+port+"/rpc",async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

test("History pages older Trebell catalog rows even without a connected runtime",async({page})=>{
  const now=Date.now()/1000,settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const recent={"recent-a":meta("recent-a","Recent A",now),"recent-b":meta("recent-b","Recent B",now-1)},older={"older-c":meta("older-c","Older C",now-100)};
  let catalogReads=0;
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:true,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:false,wsUrl:"",cwd:process.cwd(),platform:process.platform,version:"catalog-page-fixture",runtimeCapabilities:{},activeEnvironmentId:null,activeEnvironment:null})}));
  await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:recent,threadMetaNextCursor:"older-page-1"})}));
  await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({agentRuntime:"claude",ready:true,models:["claude-test"],metadata:{agentRuntime:"claude",models:[{id:"claude-test",name:"Claude Test",agent:"Claude Code"}]}})}));
  await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
  await page.route(/\/api\/thread-meta\?/,route=>{catalogReads++;return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({threadMeta:older,nextCursor:null})})});

  await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"History",exact:true}).click();
  const history=page.locator(".history-page");
  await expect(history.getByRole("button",{name:/Recent A/})).toBeVisible();await expect(history.getByRole("button",{name:/Older C/})).toHaveCount(0);
  const load=page.getByRole("button",{name:"Load older threads"});await expect(load).toBeVisible();await load.click();
  await expect.poll(()=>catalogReads).toBe(1);await expect(history.getByRole("button",{name:/Older C/})).toBeVisible();await expect(load).toHaveCount(0);
  await page.setViewportSize({width:1280,height:800});const metrics=await page.locator(".history-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"history-catalog-pagination-1280x800.png",fullPage:true});
});

test("connected runtime history refresh preserves the independent Trebell catalog cursor",async({page})=>{
  const now=Date.now()/1000,runtimeThread={id:"runtime-recent",name:"Runtime recent",preview:"Runtime recent preview",cwd:process.cwd(),model:"claude-test",runtime:"claude",status:{type:"idle"},createdAt:now-20,updatedAt:now-2,turns:[]};
  const harness=await startRuntimeHarness(runtimeThread),settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const recent={"catalog-recent":meta("catalog-recent","Catalog recent",now-1)},older={"catalog-older":meta("catalog-older","Catalog older",now-100)};let catalogReads=0;
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"catalog-page-connected-fixture",runtimeCapabilities:{},activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:recent,threadMetaNextCursor:"catalog-connected-older"})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({agentRuntime:"claude",ready:true,models:["claude-test"],metadata:{agentRuntime:"claude",models:[{id:"claude-test",name:"Claude Test",agent:"Claude Code"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.route(/\/api\/thread-meta\?/,route=>{catalogReads++;return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({threadMeta:older,nextCursor:null})})});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();await page.getByRole("button",{name:"History",exact:true}).click();
    const history=page.locator(".history-page");await expect(history.getByRole("button",{name:/Runtime recent/})).toBeVisible();
    const load=page.getByRole("button",{name:"Load older threads"});await expect(load).toBeVisible();await load.click();
    await expect.poll(()=>catalogReads).toBe(1);await expect(history.getByRole("button",{name:/Catalog older/})).toBeVisible();await expect(load).toHaveCount(0);
  }finally{await harness.close()}
});
