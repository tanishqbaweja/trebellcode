import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("Usage page refreshes native Codex account and quota updates live",async({page})=>{
  test.setTimeout(30_000);
  const calls=[];let account={type:"chatgpt",email:"before@example.com",planType:"plus"},usedPercent=20,lifetimeTokens=12345,notificationSocket=null,failRateLimits=false;
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);notificationSocket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"usage-live-fixture"};
      else if(message.method==="thread/list")result={data:[],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="account/read")result={account,requiresOpenaiAuth:false};
      else if(message.method==="account/rateLimits/read"){
        if(failRateLimits){ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate rate-limit refresh failure"}}));return}
        result={rateLimits:{limitId:"main",limitName:"Coding quota",primary:{usedPercent,resetsAt:Math.floor(Date.now()/1000)+3600}}};
      }
      else if(message.method==="account/usage/read")result={summary:{lifetimeTokens,currentStreakDays:2,peakDailyTokens:5000,longestRunningTurnSec:90},threadUsage:null};
      else if(message.method==="account/workspaceMessages/read")result={featureEnabled:false,messages:[]};
      else if(message.method==="experimentalFeature/list"||message.method==="permissionProfile/list"||message.method==="mcpServerStatus/list"||message.method==="app/list"||message.method==="hooks/list"||message.method==="plugin/share/list")result={data:[]};
      else if(message.method==="plugin/list")result={marketplaces:[],marketplaceLoadErrors:[],featuredPluginIds:[]};
      else if(message.method==="app/installed")result={apps:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      else if(message.method==="config/read")result={config:{},layers:[]};
      else if(message.method==="configRequirements/read")result={requirements:{}};
      else if(message.method==="memory/status")result={v2ConsolidatedThreads:20,v2Ready:true};
      else if(message.method==="server/diagnostics")result={process:{id:99,residentMemoryBytes:1},gauges:[]};
      else if(message.method==="thread/loaded/list")result={data:[],nextCursor:null};
      else if(message.method==="externalAgentConfig/detect")result={detected:[]};
      else if(message.method==="externalAgentConfig/import/history")result={data:[],nextCursor:null};
      else if(message.method==="windowsSandbox/readiness")result={status:"ready"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:"win32",version:"usage-live",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.route(/\/api\/usage(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({records:[],total:{},models:{},runtimes:{},daily:{}})}));
    await page.route(/\/api\/environments$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({profiles:[],activeEnvironmentId:null,activeEnvironment:null})}));
    await page.goto("/");await page.getByRole("button",{name:"Usage",exact:true}).click();
    const card=page.locator('[data-testid="codex-account-usage"]');await expect(card).toContainText("before@example.com");await expect(card).toContainText("80% left");
    const accountReadsBefore=calls.filter(call=>call.method==="account/read").length,rateReadsBefore=calls.filter(call=>call.method==="account/rateLimits/read").length,usageReadsBefore=calls.filter(call=>call.method==="account/usage/read").length;
    account={type:"chatgpt",email:"after@example.com",planType:"pro"};usedPercent=65;
    notificationSocket.send(JSON.stringify({method:"account/updated",params:{authMode:"chatgpt",planType:"pro"}}));
    notificationSocket.send(JSON.stringify({method:"account/rateLimits/updated",params:{rateLimits:{primary:{usedPercent:65}}}}));
    await expect(card).toContainText("after@example.com");await expect(card).toContainText("35% left");await expect(card).toContainText("Local / legacy · pro");
    await expect(card.getByText("Unavailable Codex account data")).toHaveCount(0);
    await expect.poll(()=>calls.filter(call=>call.method==="account/read").length).toBeGreaterThan(accountReadsBefore);
    await expect.poll(()=>calls.filter(call=>call.method==="account/rateLimits/read").length).toBeGreaterThan(rateReadsBefore);
    expect(calls.filter(call=>call.method==="account/usage/read").length).toBe(usageReadsBefore);
    lifetimeTokens=54321;
    notificationSocket.send(JSON.stringify({method:"thread/tokenUsage/updated",params:{threadId:"background-thread",tokenUsage:{totalTokens:54321}}}));
    await expect(card).toContainText("54.3K");
    await expect.poll(()=>calls.filter(call=>call.method==="account/usage/read").length).toBeGreaterThan(usageReadsBefore);
    const usageReadsAfterTokenUpdate=calls.filter(call=>call.method==="account/usage/read").length;
    notificationSocket.send(JSON.stringify({method:"account/rateLimits/updated",params:{rateLimits:{primary:{usedPercent:65}}}}));
    await new Promise(resolve=>setTimeout(resolve,350));
    expect(calls.filter(call=>call.method==="account/usage/read").length).toBe(usageReadsAfterTokenUpdate);
    failRateLimits=true;
    await page.locator(".usage-toolbar").getByRole("button",{name:"Refresh",exact:true}).click();
    await expect(card).toContainText("35% left");
    const unavailable=card.getByText("Unavailable Codex account data",{exact:true});
    await expect(unavailable).toBeVisible();
    await unavailable.click();
    await expect(card).toContainText("rateLimits: Deliberate rate-limit refresh failure");
    await expect(page.locator(".usage-toolbar").getByRole("button",{name:"Refresh",exact:true})).toBeEnabled();
    await page.setViewportSize({width:1280,height:800});await card.scrollIntoViewIfNeeded();await page.screenshot({path:auditDir+"usage-live-codex-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({path:auditDir+"usage-live-codex-light-1280x800.png",fullPage:false});
  }finally{
    relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))]);
  }
});
