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
// reset credit ("quota"), with the window reset and the credit spent ("spent"), with no limits ("none"), or fails it ("fail");
// `control.rateReads` counts those reads. Using the reset credit fails, or with `control.consume` "drop" the harness drops its
// connection on it without an answer, once, and then resets the window; with "apply-drop" it uses the credit and resets the window,
// then drops its connection before it answers; with "reset" it resets the window. `control.consumes` counts the tries. With
// `control.holdInit` the handshake waits in `control.heldInit`, so the app stays connecting until those answers are sent. drop()
// closes the harness's connections, as an app-server restart does.
async function startUsageFixture(control){
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      const send=payload=>ws.send(JSON.stringify({id:message.id,...payload})),fail=reason=>send({error:{code:-32000,message:reason}});
      if(message.method==="account/rateLimits/read"){
        control.rateReads=(control.rateReads||0)+1;
        if(control.rateLimits==="fail")return fail("Deliberate rate-limit read failure");
        const spent=control.rateLimits==="spent";
        return send({result:control.rateLimits==="none"?{rateLimits:null}:{rateLimits:{limitId:"main",limitName:"Coding quota",primary:{usedPercent:spent?0:30,resetsAt:Math.floor(Date.now()/1000)+3600}},rateLimitResetCredits:{availableCount:spent?0:1,credits:spent?[]:[{id:"credit-1",status:"available"}]}}});
      }
      if(message.method==="account/rateLimitResetCredit/consume"){
        control.consumes=(control.consumes||0)+1;
        if(control.consume==="drop"){control.consume="reset";return ws.terminate()}
        if(control.consume==="apply-drop"){control.consume="reset";control.rateLimits="spent";return ws.terminate()}
        if(control.consume==="reset"){control.rateLimits="spent";return send({result:{outcome:"reset"}})}
        return fail("Deliberate reset credit failure");
      }
      if(message.method==="initialize"&&control.holdInit)return control.heldInit.push(()=>send({result:{userAgent:"usage-fixture"}}));
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
  return {wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",drop(){for(const socket of sockets)try{socket.terminate()}catch{}},async close(){relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}};
}
// Opens the Usage page on Codex (or on `runtime`), answering /api/usage with `usage(route)` and, when given, the subscription
// limits read with `runtimeUsage(route)`.
async function openUsage(page,wsUrl,usage,{runtime="codex",runtimeUsage=null}={}){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:runtime,agentRuntimeReady:true,appServerReady:true,wsUrl,cwd:process.cwd(),platform:"win32",version:"usage-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}}));
  if(runtimeUsage)await page.route(/\/api\/agent-runtime-usage(?:\?.*)?$/,runtimeUsage);
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/environments$/,route=>json(route,{profiles:[],activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/usage(?:\?.*)?$/,usage);
  // The header's theme button: its setting stays in the page.
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
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
    const claims=["No recorded usage in this period.","No model usage in this period.","No turns recorded in this period."];
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

    // A refresh of that empty period then fails: its claims and zero totals spoke for the answer that is no longer the latest, so
    // none stays beside the alert. The Codex card's limits read fails too, and it drops its no-limits claim the same way.
    usageMode="fail";control.rateLimits="fail";
    await page.locator(".usage-toolbar").getByRole("button",{name:"Refresh",exact:true}).click();
    await expect(page.locator(".usage-page>.inline-error")).toHaveText("Could not load usage: Deliberate usage load failure");
    await expect(page.locator(".usage-toolbar").getByRole("button",{name:"Refresh",exact:true})).toBeEnabled();
    await expectNoClaims();
    await expect(usagePage.getByText(/^Loading /)).toHaveCount(0);
    await expect(codexCard).not.toContainText("did not return Codex account limits");
    await expect(codexCard.getByText("Unavailable Codex account data",{exact:true})).toBeVisible();
    await page.screenshot({animations:"disabled",path:auditDir+"usage-refresh-failed-after-empty-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"usage-refresh-failed-after-empty-light-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
  }finally{for(const route of held.splice(0))await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(emptyUsage)}).catch(()=>{});await fixture.close()}
});

// Turns recorded 10, 12 and 40 days ago: 30 days lists two, and 7 days, which has none, says so in every card, the Models card in
// the words of the other two rather than that no model usage was ever recorded.
test("Usage says a chosen period with no turns has none in that period, in every card",async({page})=>{
  test.setTimeout(40_000);
  const fixture=await startUsageFixture({rateLimits:"none"});
  const DAY=86_400_000,turn=(id,daysAgo,model,totalTokens)=>({id,at:new Date(Date.now()-daysAgo*DAY).toISOString(),environmentId:null,runtime:"codex",provider:"openai",model,usage:{inputTokens:totalTokens*.7,outputTokens:totalTokens*.3,totalTokens},cost:null});
  const turns=[turn("usage-ten-days",10,"test/coding-fast",120_000),turn("usage-twelve-days",12,"test/coding-deep",300_000),turn("usage-forty-days",40,"test/coding-fast",80_000)];
  try{
    await page.setViewportSize({width:1280,height:800});
    // Each period is answered with the turns recorded in it, as /api/usage does.
    await openUsage(page,fixture.wsUrl,route=>{
      const days=Number(new URL(route.request().url()).searchParams.get("days")),records=turns.filter(item=>Date.now()-Date.parse(item.at)<=days*DAY);
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({records,total:{totalTokens:records.reduce((sum,item)=>sum+item.usage.totalTokens,0)},models:{},runtimes:{},daily:{}})});
    });
    const usagePage=page.locator(".usage-page"),summary=page.locator(".usage-summary"),models=page.locator(".usage-models"),period=page.getByRole("combobox",{name:"Period"});
    await expect(summary).toContainText("2 recorded turns");await expect(models.locator(":scope>div")).toHaveCount(2);
    await period.selectOption("7");
    await expect(summary).toContainText("0 recorded turns");
    await expect(models).toHaveText("No model usage in this period.");
    await expect(usagePage.getByText("No recorded usage in this period.",{exact:true})).toBeVisible();
    await expect(usagePage.getByText("No turns recorded in this period.",{exact:true})).toBeVisible();
    await expect(usagePage.getByText("No model usage recorded yet.",{exact:true})).toHaveCount(0);
    await models.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"usage-period-empty-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"usage-period-empty-light-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    // 90 days lists the three turns and their two models again.
    await period.selectOption("90");
    await expect(summary).toContainText("3 recorded turns");await expect(models.locator(":scope>div")).toHaveCount(2);
    await expect(usagePage.getByText("No model usage in this period.",{exact:true})).toHaveCount(0);
  }finally{await fixture.close()}
});

// Turns recorded 10, 20 and 200 days ago. Clear local history clears every turn Trebell holds, as its question says, so 7 days,
// which lists none, still offers it: it was greyed out in any period or environment that listed no turns, so the person had to
// find one that did. Cleared from 30 days, 1 year lists none either, and with nothing left to clear it is greyed out.
test("Clear local history is offered in a period with no turns while older turns are recorded, and clears them all",async({page})=>{
  test.setTimeout(40_000);
  const fixture=await startUsageFixture({rateLimits:"none"});
  const DAY=86_400_000,turn=(id,daysAgo,totalTokens)=>({id,at:new Date(Date.now()-daysAgo*DAY).toISOString(),environmentId:null,runtime:"codex",provider:"openai",model:"test/coding-fast",usage:{inputTokens:totalTokens*.7,outputTokens:totalTokens*.3,totalTokens},cost:null});
  let turns=[turn("usage-ten-days",10,120_000),turn("usage-twenty-days",20,80_000),turn("usage-two-hundred-days",200,2_000_000)],deletes=0;
  try{
    await page.setViewportSize({width:1280,height:800});
    // As /api/usage does: each period is answered with the turns recorded in it and how many turns Trebell holds in all, and a
    // clear deletes every turn.
    await openUsage(page,fixture.wsUrl,route=>{
      const reply=value=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
      if(route.request().method()==="DELETE"){deletes++;const cleared=turns.length;turns=[];return reply({ok:true,cleared})}
      const days=Number(new URL(route.request().url()).searchParams.get("days")),records=turns.filter(item=>Date.now()-Date.parse(item.at)<=days*DAY);
      return reply({records,total:{totalTokens:records.reduce((sum,item)=>sum+item.usage.totalTokens,0)},models:{},runtimes:{},daily:{},storedTurns:turns.length});
    });
    const summary=page.locator(".usage-summary"),period=page.getByRole("combobox",{name:"Period"}),clear=page.getByRole("button",{name:"Clear local history",exact:true});
    const question=page.locator("dialog.inspector-text-prompt");
    await expect(summary).toContainText("2 recorded turns");await expect(clear).toBeEnabled();
    // 7 days, chosen from the keyboard: Up from 30 days.
    await period.focus();await page.keyboard.press("ArrowUp");await expect(period).toHaveValue("7");
    await expect(summary).toContainText("0 recorded turns");
    await expect(clear,"Trebell holds three turns to clear").toBeEnabled();
    for(const mode of ["dark","light"]){
      if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").first().click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+"usage-clear-offered-empty-period-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
    }
    await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
    // Cleared from 30 days: every period's turns go, the one 200 days old too.
    await period.selectOption("30");await expect(summary).toContainText("2 recorded turns");
    await clear.click();
    await expect(question.locator("p")).toHaveText("Clear Trebell's locally recorded usage history? Provider account usage is not affected.");
    await question.getByRole("button",{name:"Clear history",exact:true}).click();
    await expect(summary).toContainText("0 recorded turns");await expect(clear,"nothing is left to clear").toBeDisabled();
    expect(deletes).toBe(1);
    await period.selectOption("365");
    await expect(summary).toContainText("0 recorded turns");await expect(clear).toBeDisabled();
  }finally{await fixture.close()}
});

test("Usage opened while Codex connects never claims the route returned no limits before it answers",async({page})=>{
  test.setTimeout(40_000);
  const control={rateLimits:"quota",holdInit:true,heldInit:[]};const fixture=await startUsageFixture(control);
  // Every claim the page ever puts in its text is recorded from the first script on, so one shown for a single frame while
  // Codex connects is caught too. A text changed in place leaves its old value in the mutation record.
  const claim="This inference route did not return Codex account limits.";
  await page.addInitScript(claim=>{
    const seen=window.__claimsSeen=[];const note=text=>{if(text&&text.includes(claim)&&!seen.length)seen.push(claim)};
    new MutationObserver(records=>{for(const record of records){
      if(record.type==="characterData"){note(record.oldValue);note(record.target.data)}
      else for(const node of [...record.addedNodes,...record.removedNodes])note(node.textContent);
    }}).observe(document,{subtree:true,childList:true,characterData:true,characterDataOldValue:true});
  },claim);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openUsage(page,fixture.wsUrl,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(emptyUsage)}));
    // Not connected yet: the page shows recorded usage only, and no Codex card.
    const codexCard=page.getByTestId("codex-account-usage");
    await expect(page.getByText("No turns recorded in this period.",{exact:true})).toBeVisible();
    await expect.poll(()=>control.heldInit.length).toBe(1);
    await expect(codexCard).toHaveCount(0);
    for(const answer of control.heldInit.splice(0))answer();
    await expect(codexCard).toContainText("1 reset credit available");
    expect(await page.evaluate(()=>window.__claimsSeen)).toEqual([]);
  }finally{await fixture.close()}
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
    // Both actions ask first in the app's own dialog, never the browser's, with Cancel focused: Escape does nothing.
    const nativeDialogs=[];page.on("dialog",dialog=>{nativeDialogs.push(dialog.type()+": "+dialog.message());dialog.dismiss().catch(()=>{})});
    const question=page.locator("dialog.inspector-text-prompt"),cancel=question.getByRole("button",{name:"Cancel",exact:true}),clear=page.getByRole("button",{name:"Clear local history",exact:true});
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await clear.click();
      await expect(question.locator("p")).toHaveText("Clear Trebell's locally recorded usage history? Provider account usage is not affected.");await expect(cancel).toBeFocused();
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+"usage-clear-question-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
      await page.keyboard.press("Escape");await expect(question).toHaveCount(0);await expect(clear).toBeFocused();
    }
    await expect(page.locator(".usage-page>.inline-error")).toHaveCount(0);
    // From the keyboard: Enter on Clear local history, Tab from Cancel to Clear history, Enter.
    await page.keyboard.press("Enter");await expect(cancel).toBeFocused();
    await page.keyboard.press("Tab");await expect(question.getByRole("button",{name:"Clear history",exact:true})).toBeFocused();await page.keyboard.press("Enter");
    await expect(page.locator(".usage-page>.inline-error")).toHaveText("Could not clear local usage history: the usage file is read-only");
    await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
    // Using a reset credit fails with a bare reason: the card's alert names the action first.
    const codexCard=page.getByTestId("codex-account-usage");
    await expect(codexCard).toContainText("1 reset credit available");
    await codexCard.getByRole("button",{name:"Use reset credit"}).click();
    await expect(question.locator("p")).toHaveText("Use one earned Codex reset credit now? This can reset an eligible rate-limit window.");
    await question.getByRole("button",{name:"Use reset credit",exact:true}).click();
    await expect(codexCard.getByRole("alert")).toHaveText("Could not use the reset credit: Deliberate reset credit failure");
    expect(nativeDialogs).toEqual([]);
    await expect(codexCard.getByRole("button",{name:"Use reset credit"})).toBeEnabled();
    await codexCard.getByRole("alert").scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"usage-action-failures-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"usage-action-failures-light-1280x800.png",fullPage:false});
  }finally{await fixture.close()}
});

// The harness drops its connection while Use reset credit is on its way, without answering. The card goes while Codex connects
// again; once it is back it says the credit could not be used, beside the credit that is still there, so the person knows to try
// again. The second try, made from the keyboard, uses it.
test("a reset credit whose harness dropped on the way says it could not be used once the card is back",async({page})=>{
  test.setTimeout(60_000);
  const control={rateLimits:"quota",consume:"drop"};const fixture=await startUsageFixture(control);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openUsage(page,fixture.wsUrl,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(emptyUsage)}));
    const codexCard=page.getByTestId("codex-account-usage"),question=page.locator("dialog.inspector-text-prompt"),use=codexCard.getByRole("button",{name:"Use reset credit"}),failure=codexCard.getByRole("alert");
    await expect(codexCard).toContainText("1 reset credit available");await expect(codexCard).toContainText("70% left");
    await use.click();
    await question.getByRole("button",{name:"Use reset credit",exact:true}).click();
    await expect.poll(()=>control.consumes).toBe(1);
    // Codex is connected again and the card has read the account again: the credit is still there, and the card says it was not used.
    await expect(failure).toHaveText("Could not use the reset credit: Codex disconnected",{timeout:15_000});
    await expect(codexCard).toContainText("1 reset credit available");await expect(codexCard).toContainText("70% left");
    await expect(use).toBeEnabled();
    await failure.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"usage-reset-credit-dropped-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"usage-reset-credit-dropped-light-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    // Tried again from the keyboard: Enter on Use reset credit, Tab from Cancel to the dialog's Use reset credit, Enter.
    await use.focus();await page.keyboard.press("Enter");
    await expect(question.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
    await page.keyboard.press("Tab");await expect(question.getByRole("button",{name:"Use reset credit",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(codexCard).toContainText("Rate-limit window reset.");await expect(codexCard).toContainText("100% left");
    await expect(failure).toHaveCount(0);await expect(codexCard).not.toContainText("reset credit available");
    expect(control.consumes).toBe(2);
  }finally{await fixture.close()}
});

// The harness uses the reset credit, then drops its connection before its answer reaches the app. Once Codex is connected again
// the card reads the limits: the window is reset and the credit gone, so it says the credit was used, and nothing beside
// "100% left" claims it could not be.
test("a reset credit used by a harness that dropped before answering is said to be used once the card is back, not refused",async({page})=>{
  test.setTimeout(60_000);
  const control={rateLimits:"quota",consume:"apply-drop"};const fixture=await startUsageFixture(control);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openUsage(page,fixture.wsUrl,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(emptyUsage)}));
    const codexCard=page.getByTestId("codex-account-usage"),question=page.locator("dialog.inspector-text-prompt"),use=codexCard.getByRole("button",{name:"Use reset credit"});
    await expect(codexCard).toContainText("1 reset credit available");await expect(codexCard).toContainText("70% left");
    await use.click();
    await question.getByRole("button",{name:"Use reset credit",exact:true}).click();
    await expect.poll(()=>control.consumes).toBe(1);
    await expect(codexCard,"the card back, with the limits read again").toContainText("100% left",{timeout:15_000});
    await expect(codexCard.getByRole("alert"),"a claim beside 100% left that the credit could not be used").toHaveCount(0);
    await expect(codexCard).not.toContainText("reset credit available");
    await expect(codexCard,"the card says the credit was used").toContainText("The reset credit was used.");
    await codexCard.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"usage-reset-credit-used-then-dropped-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"usage-reset-credit-used-then-dropped-light-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    expect(control.consumes).toBe(1);
  }finally{await fixture.close()}
});

// A reset credit used: the card says the window was reset. The harness then drops its connection; once Codex is connected again and
// the card has read the account again on its own, it still says what that Use reset credit came to.
test("what Use reset credit came to stays once Codex has connected again and the card has read the account on its own",async({page})=>{
  test.setTimeout(60_000);
  const control={rateLimits:"quota",consume:"reset"};const fixture=await startUsageFixture(control);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openUsage(page,fixture.wsUrl,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(emptyUsage)}));
    const codexCard=page.getByTestId("codex-account-usage"),question=page.locator("dialog.inspector-text-prompt");
    await expect(codexCard).toContainText("1 reset credit available");
    await codexCard.getByRole("button",{name:"Use reset credit"}).click();
    await question.getByRole("button",{name:"Use reset credit",exact:true}).click();
    await expect(codexCard).toContainText("Rate-limit window reset.");await expect(codexCard).toContainText("100% left");
    const reads=control.rateReads;
    fixture.drop();
    await expect.poll(()=>control.rateReads,{message:"the card reads the limits again once Codex is connected again",timeout:15_000}).toBeGreaterThan(reads);
    await expect(codexCard).toContainText("100% left");await expect(codexCard.getByText("Loading live Codex account limits…")).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(codexCard,"the notice of the reset, after the card read the account on its own").toContainText("Rate-limit window reset.");
    await expect(codexCard.getByRole("alert")).toHaveCount(0);
    expect(control.consumes).toBe(1);
  }finally{await fixture.close()}
});

test("Usage takes cleared turns off the page even when the reload after the clear fails",async({page})=>{
  test.setTimeout(40_000);
  const control={rateLimits:"quota"};const fixture=await startUsageFixture(control);
  const record={id:"usage-cleared-record",at:new Date().toISOString(),environmentId:null,runtime:"codex",provider:"openai",model:"test/coding-fast",usage:{inputTokens:1200,outputTokens:300,totalTokens:1500},cost:{currency:"USD",amount:0.0123}};
  let deletes=0;
  try{
    await page.setViewportSize({width:1280,height:800});
    await openUsage(page,fixture.wsUrl,route=>{
      if(route.request().method()==="DELETE"){deletes++;return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})})}
      // The clear succeeds, and reading the usage back after it fails.
      if(deletes)return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate usage reload failure"})});
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({records:[record],total:{inputTokens:1200,outputTokens:300,totalTokens:1500},models:{},runtimes:{},daily:{}})});
    });
    const usagePage=page.locator(".usage-page"),summary=page.locator(".usage-summary"),recent=page.locator(".usage-recent");
    const rows=recent.locator(".usage-table>div:not(.usage-table-head)"),clear=page.getByRole("button",{name:"Clear local history",exact:true});
    await expect(rows).toHaveCount(1);await expect(rows).toContainText("test/coding-fast");
    await expect(summary).toContainText("1 recorded turn");
    await clear.click();
    await page.locator("dialog.inspector-text-prompt").getByRole("button",{name:"Clear history",exact:true}).click();
    await expect(page.locator(".usage-page>.inline-error")).toHaveText("Could not load usage: Deliberate usage reload failure");
    expect(deletes).toBe(1);
    // The turn was deleted, so it is not shown beside the failed reload's alert: no row, model, daily bar or total speaks for it,
    // and as that reload failed, nothing claims the period is empty either.
    await expect(rows).toHaveCount(0);
    await expect(page.locator(".usage-models>div")).toHaveCount(0);await expect(page.locator(".usage-bars>div")).toHaveCount(0);
    await expect(usagePage).not.toContainText("test/coding-fast");
    await expect(summary.locator("strong")).toHaveText(["—","—","—","—"]);
    for(const claim of ["No recorded usage in this period.","No model usage in this period.","No turns recorded in this period."])await expect(usagePage.getByText(claim,{exact:true}),claim).toHaveCount(0);
    await expect(recent.locator(".capability-card-head em")).toHaveCount(0);
    await expect(clear).toBeDisabled();await expect(clear).toHaveText("Clear local history");
    // The page scrolls inside its own column: one shot shows the alert and the totals, the next the cards and the table below.
    const shoot=async name=>{
      await page.screenshot({animations:"disabled",path:auditDir+name+"-1280x800.png",fullPage:false});
      await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
      await page.screenshot({animations:"disabled",path:auditDir+name+"-light-1280x800.png",fullPage:false});
      await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    };
    await shoot("usage-cleared-reload-failed");
    await recent.scrollIntoViewIfNeeded();
    await shoot("usage-cleared-reload-failed-cards");
  }finally{await fixture.close()}
});

test("Subscription limits say they are loading, name a failed read, and claim nothing beside it",async({page})=>{
  test.setTimeout(40_000);
  const fixture=await startUsageFixture({rateLimits:"none"});
  let limits="hold";const held=[];
  const answers={
    empty:{runtime:"claude",account:{email:"claude@example.com"},windows:[]},
    unsupported:{runtime:"claude",windows:[],unavailable:{reason:"unsupported"}},
    windows:{runtime:"claude",account:{email:"claude@example.com"},windows:[{id:"five-hour",label:"5-hour window",kind:"session",usedPercent:42,resetsAt:new Date(Date.now()+3_600_000).toISOString()}]},
  };
  const reply=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  try{
    await page.setViewportSize({width:1280,height:800});
    await openUsage(page,fixture.wsUrl,route=>reply(route,emptyUsage),{runtime:"claude",runtimeUsage:route=>{
      if(limits==="hold")return held.push(route);
      if(limits==="fail")return reply(route,{error:"Deliberate subscription limits failure"},400);
      return reply(route,answers[limits]);
    }});
    const card=page.getByTestId("runtime-account-usage"),warning=card.locator(".usage-warning"),refresh=page.locator(".usage-toolbar .usage-refresh");
    const claims=["Nothing is metered for this account in the current period yet.","This runtime/account does not expose subscription limits to Trebell."];
    const expectNoClaims=async()=>{for(const claim of claims)await expect(card.getByText(claim,{exact:true}),claim).toHaveCount(0)};
    const refreshAndWait=async()=>{await refresh.click();await expect(refresh).toHaveText("Refresh")};
    const failure="Could not load subscription limits: Deliberate subscription limits failure";
    // The first read is in flight: the card says it is loading and claims nothing.
    await expect.poll(()=>held.length).toBe(1);
    await expect(card).toContainText("Claude Code subscription limits");
    await expect(card.getByText("Loading live subscription limits…",{exact:true})).toBeVisible();
    await expectNoClaims();await expect(warning).toHaveCount(0);
    // It fails: the warning names the read before the reason, with no claim or loading line beside it.
    limits="fail";for(const route of held.splice(0))await reply(route,{error:"Deliberate subscription limits failure"},400);
    await expect(warning).toHaveText(failure);
    await expect(card.getByText(/^Loading /)).toHaveCount(0);
    await expectNoClaims();
    // A refresh that reads an account with nothing metered yet says so, and the warning goes.
    limits="empty";await refreshAndWait();
    await expect(card.getByText(claims[0],{exact:true})).toBeVisible();await expect(warning).toHaveCount(0);
    await expect(card).toContainText("claude@example.com");
    // A refresh after that answer fails: the warning shows, and the claim made for the earlier answer does not stay beside it.
    limits="fail";await refreshAndWait();
    await expect(warning).toHaveText(failure);
    await expectNoClaims();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"usage-subscription-limits-failed-after-loaded-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"usage-subscription-limits-failed-after-loaded-light-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    // A runtime that does not expose limits says so once it answers, and not beside a later failure either.
    limits="unsupported";await refreshAndWait();
    await expect(card.getByText(claims[1],{exact:true})).toBeVisible();await expect(warning).toHaveCount(0);
    limits="fail";await refreshAndWait();
    await expect(warning).toHaveText(failure);await expectNoClaims();
    // Metered windows are the last answer, not a claim of absence: they stay on screen beside a later failure.
    limits="windows";await refreshAndWait();
    await expect(card.locator(".codex-limit-card")).toContainText("5-hour window");await expect(card).toContainText("42% used");await expect(warning).toHaveCount(0);
    limits="fail";await refreshAndWait();
    await expect(warning).toHaveText(failure);
    await expect(card.locator(".codex-limit-card")).toContainText("42% used");
    await expectNoClaims();
  }finally{for(const route of held.splice(0))await reply(route,answers.empty).catch(()=>{});await fixture.close()}
});

// Refresh said it was refreshing by being disabled, which dropped the keyboard on the page: its focus ring went, a second Enter read
// nothing and Tab started over from the top of the page (lane F, FR13-1). It only says it is off now (aria-disabled), so the keyboard
// stays on it; a press meanwhile reads nothing, nor do the second click of a double click and the repeats of Enter held.
test("Enter on Refresh keeps the keyboard on it while the page reads and after, and a press meanwhile, a double click or Enter held reads once",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startUsageFixture({rateLimits:"none"});
  // One turn is recorded, so Clear local history is offered after Refresh. Once the page has loaded, each usage read waits in held
  // until the test answers it.
  const turn={id:"usage-refresh-turn",at:new Date().toISOString(),environmentId:null,runtime:"claude",provider:"anthropic",model:"claude-sonnet",usage:{inputTokens:700,outputTokens:300,totalTokens:1000},cost:null};
  const reply=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
  const usage=route=>reply(route,{records:[turn],total:{totalTokens:1000},models:{},runtimes:{},daily:{},storedTurns:1});
  const windows={runtime:"claude",account:{email:"claude@example.com"},windows:[{id:"five-hour",label:"5-hour window",kind:"session",usedPercent:42,resetsAt:new Date(Date.now()+3_600_000).toISOString()}]};
  const held=[];let reads=0,hold=false;
  try{
    await page.setViewportSize({width:1280,height:800});
    await openUsage(page,fixture.wsUrl,route=>{reads++;return hold?held.push(route):usage(route)},{runtime:"claude",runtimeUsage:route=>reply(route,windows)});
    const refresh=page.locator(".usage-toolbar .usage-refresh"),period=page.getByRole("combobox",{name:"Period"}),clear=page.getByRole("button",{name:"Clear local history",exact:true});
    const answer=async()=>{await expect.poll(()=>held.length,{message:"one usage read waits"}).toBe(1);await usage(held.shift())};
    const ring=()=>refresh.evaluate(button=>button.matches(":focus-visible"));
    // Two frames drawn and the task after them: the browser takes the keyboard off a button that can no longer have it (disabled) only
    // once it draws the page again.
    const drawn=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve)))));
    await expect(page.locator(".usage-summary")).toContainText("1 recorded turn");await expect(refresh).toHaveText("Refresh");await expect(clear).toBeEnabled();
    hold=true;
    // Tab from the period to Refresh, as a person moves along the toolbar, and Enter.
    await period.focus();await page.keyboard.press("Tab");await expect(refresh).toBeFocused();
    let before=reads;
    await page.keyboard.press("Enter");
    await expect(refresh).toHaveText("Refreshing…");await drawn();
    await expect(refresh,"the keyboard stays on Refresh while the page reads").toBeFocused();
    expect(await ring(),"with its focus ring").toBe(true);
    await expect(refresh).toHaveAttribute("aria-disabled","true");
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+`usage-refresh-reading-from-keyboard-${mode}-${width}x800.png`,fullPage:false})}
    }
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await page.setViewportSize({width:1280,height:800});
    // Enter meanwhile reads nothing.
    await page.keyboard.press("Enter");
    await answer();
    await expect(refresh).toHaveText("Refresh");
    await expect(refresh,"the keyboard is still on Refresh once the page has read").toBeFocused();
    expect(await ring(),"with its focus ring").toBe(true);
    await page.waitForTimeout(300);expect(reads-before,"one read for the press, none for Enter while it read").toBe(1);
    // A second Enter reads again, and Tab goes on from Refresh to Clear local history.
    await page.keyboard.press("Enter");await expect(refresh).toHaveText("Refreshing…");await answer();await expect(refresh).toHaveText("Refresh");
    expect(reads-before).toBe(2);
    await page.keyboard.press("Tab");await expect(clear).toBeFocused();
    // A double click reads once, and a click while it reads reads nothing; Enter held on it reads once (a press, and five repeats 33 ms
    // apart).
    before=reads;await refresh.dblclick();await expect(refresh).toHaveText("Refreshing…");
    const box=await refresh.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    await answer();await expect(refresh).toHaveText("Refresh");
    await page.waitForTimeout(300);expect(reads-before,"a double click and a click while it reads read once").toBe(1);
    before=reads;await page.keyboard.down("Enter");for(let repeat=0;repeat<5;repeat++){await page.waitForTimeout(33);await page.keyboard.down("Enter")}await page.keyboard.up("Enter");
    await answer();await expect(refresh).toHaveText("Refresh");
    await page.waitForTimeout(300);expect(reads-before,"Enter held reads once").toBe(1);
  }finally{for(const route of held.splice(0))await usage(route);await fixture.close()}
});
