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
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:"win32",version:"usage-live",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}})}));
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
    // Each unavailable read names what could not be loaded, not the request's internal key.
    await expect(card.locator(".capability-details pre")).toHaveText("Could not load Codex rate limits: Deliberate rate-limit refresh failure");
    await expect(page.locator(".usage-toolbar").getByRole("button",{name:"Refresh",exact:true})).toBeEnabled();
    await page.setViewportSize({width:1280,height:800});await card.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+"usage-live-codex-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({animations:"disabled",path:auditDir+"usage-live-codex-light-1280x800.png",fullPage:false});
  }finally{
    relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))]);
  }
});

// A Codex app-server behind the real relay for the Usage page. `control.rateLimits` answers the limits read with a quota and a
// reset credit ("quota"), with no limits ("none"), or fails it ("fail"); using the reset credit always fails.
async function startUsageFixture(control){
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      const send=payload=>ws.send(JSON.stringify({id:message.id,...payload})),fail=reason=>send({error:{code:-32000,message:reason}});
      if(message.method==="account/rateLimits/read"){
        if(control.rateLimits==="fail")return fail("Deliberate rate-limit read failure");
        return send({result:control.rateLimits==="none"?{rateLimits:null}:{rateLimits:{limitId:"main",limitName:"Coding quota",primary:{usedPercent:30,resetsAt:Math.floor(Date.now()/1000)+3600}},rateLimitResetCredits:{availableCount:1,credits:[{id:"credit-1",status:"available"}]}}});
      }
      if(message.method==="account/rateLimitResetCredit/consume")return fail("Deliberate reset credit failure");
      let result={};
      if(message.method==="initialize")result={userAgent:"usage-fixture"};
      else if(message.method==="thread/list"||message.method==="threadSection/list"||message.method==="skills/list")result={data:[],nextCursor:null};
      else if(message.method==="account/read")result={account:{type:"chatgpt",email:"usage@example.com",planType:"plus"},requiresOpenaiAuth:false};
      else if(message.method==="account/usage/read")result={summary:{lifetimeTokens:1000,currentStreakDays:1,peakDailyTokens:1000,longestRunningTurnSec:30},threadUsage:null};
      else if(message.method==="account/workspaceMessages/read")result={featureEnabled:false,messages:[]};
      send({result});
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",async close(){relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}};
}
// Opens the Usage page on Codex, answering /api/usage with `usage(route)`.
async function openUsage(page,wsUrl,usage){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl,cwd:process.cwd(),platform:"win32",version:"usage-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/environments$/,route=>json(route,{profiles:[],activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/usage(?:\?.*)?$/,usage);
  await page.goto("/");await page.getByRole("button",{name:"Usage",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();
}
const emptyUsage={records:[],total:{},models:{},runtimes:{},daily:{}};

test("Usage says a period or account limit is empty only once that answer has loaded",async({page})=>{
  test.setTimeout(40_000);
  const control={rateLimits:"fail"};const fixture=await startUsageFixture(control);
  let usageMode="hold";const held=[];
  try{
    await page.setViewportSize({width:1280,height:800});
    await openUsage(page,fixture.wsUrl,route=>{
      if(usageMode==="hold"){held.push(route);return}
      if(usageMode==="fail")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate usage load failure"})});
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(emptyUsage)});
    });
    const usagePage=page.locator(".usage-page"),summary=page.locator(".usage-summary"),codexCard=page.getByTestId("codex-account-usage");
    const claims=["No recorded usage in this period.","No model usage recorded yet.","No turns recorded in this period."];
    const expectNoClaims=async()=>{
      for(const claim of claims)await expect(usagePage.getByText(claim,{exact:true}),claim).toHaveCount(0);
      // The totals do not read as zero either: no "0 recorded turns" and no "$0.00" for usage that has not loaded.
      await expect(summary).not.toContainText("recorded turn");await expect(summary).not.toContainText("$0.00");
      await expect(summary.locator("strong")).toHaveText(["—","—","—","—"]);
      await expect(page.locator(".usage-recent .capability-card-head em")).toHaveCount(0);
    };
    // The first usage read is still in flight: the cards say they are loading and claim nothing about the period.
    await expect.poll(()=>held.length).toBe(1);
    await expectNoClaims();
    await expect(usagePage.getByText("Loading recorded turns…",{exact:true})).toBeVisible();
    await expect(usagePage.getByText("Loading daily usage…",{exact:true})).toBeVisible();
    await expect(usagePage.getByText("Loading model usage…",{exact:true})).toBeVisible();
    // The two cards side by side keep their titles level although only one has a badge yet.
    const headHeights=()=>page.locator(".usage-grid .capability-card-head").evaluateAll(nodes=>nodes.map(node=>Math.round(node.getBoundingClientRect().height*10)/10));
    expect(new Set(await headHeights()).size,JSON.stringify(await headHeights())).toBe(1);
    // The limits read failed: the Codex card does not claim the route has no limits, it lists the failure instead.
    await expect(codexCard.getByText("Unavailable Codex account data",{exact:true})).toBeVisible();
    await expect(codexCard).not.toContainText("did not return Codex account limits");
    await page.screenshot({animations:"disabled",path:auditDir+"usage-first-load-pending-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"usage-first-load-pending-light-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});

    // The read fails: the alert says so, and nothing claims the period is empty.
    usageMode="fail";
    for(const route of held.splice(0))await route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate usage load failure"})});
    await expect(page.locator(".usage-page>.inline-error")).toHaveText("Could not load usage: Deliberate usage load failure");
    await expect(usagePage.getByText(/^Loading /)).toHaveCount(0);
    await expectNoClaims();
    await page.screenshot({animations:"disabled",path:auditDir+"usage-load-failed-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"usage-load-failed-light-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});

    // A refresh that loads an empty period and no account limits says both, as before.
    usageMode="empty";control.rateLimits="none";
    await page.locator(".usage-toolbar").getByRole("button",{name:"Refresh",exact:true}).click();
    for(const claim of claims)await expect(usagePage.getByText(claim,{exact:true}),claim).toBeVisible();
    await expect(summary).toContainText("0 recorded turns");await expect(summary).toContainText("$0.00");
    await expect(page.locator(".usage-recent .capability-card-head em")).toHaveText("0");
    await expect(codexCard).toContainText("This inference route did not return Codex account limits.");
    await expect(page.locator(".usage-page>.inline-error")).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"usage-loaded-empty-1280x800.png",fullPage:false});
  }finally{for(const route of held.splice(0))await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(emptyUsage)}).catch(()=>{});await fixture.close()}
});

test("Usage failures name the action before the reason, and only once",async({page})=>{
  test.setTimeout(40_000);
  const control={rateLimits:"quota"};const fixture=await startUsageFixture(control);
  const record={id:"usage-failure-record",at:new Date().toISOString(),environmentId:null,runtime:"codex",provider:"openai",model:"test/coding-fast",usage:{inputTokens:1200,outputTokens:300,totalTokens:1500},cost:{currency:"USD",amount:0.0123}};
  try{
    await page.setViewportSize({width:1280,height:800});
    await openUsage(page,fixture.wsUrl,route=>{
      // This server words its own failure with the action already: the alert shows it once, not after a second copy.
      if(route.request().method()==="DELETE")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Could not clear local usage history: the usage file is read-only"})});
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({records:[record],total:{inputTokens:1200,outputTokens:300,totalTokens:1500},models:{},runtimes:{},daily:{}})});
    });
    await expect(page.locator(".usage-recent")).toContainText("test/coding-fast");
    page.once("dialog",dialog=>dialog.accept());
    await page.getByRole("button",{name:"Clear local history",exact:true}).click();
    await expect(page.locator(".usage-page>.inline-error")).toHaveText("Could not clear local usage history: the usage file is read-only");
    // Using a reset credit fails with a bare reason: the card's alert names the action first.
    const codexCard=page.getByTestId("codex-account-usage");
    await expect(codexCard).toContainText("1 reset credit available");
    page.once("dialog",dialog=>dialog.accept());
    await codexCard.getByRole("button",{name:"Use reset credit"}).click();
    await expect(codexCard.getByRole("alert")).toHaveText("Could not use the reset credit: Deliberate reset credit failure");
    await expect(codexCard.getByRole("button",{name:"Use reset credit"})).toBeEnabled();
    await codexCard.getByRole("alert").scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"usage-action-failures-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"usage-action-failures-light-1280x800.png",fullPage:false});
  }finally{await fixture.close()}
});
