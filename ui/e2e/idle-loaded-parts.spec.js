import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";
import { auditDir } from "./native-stream-fixture.js";

// What App draws only once a harness asks or the person opens it comes in the script App loads at idle right after the first paint
// (idle-parts.js, B11): the card of an approval a harness asks for, the right panel's Runtime tab and History's list. Each shows
// when it is first needed, also when that comes right after the page opens, while that script is still on its way (held here a
// moment); once the script is in each draws at once, as before; and where the script cannot load, each says so in its place, in
// loadFailed's words, with Reload, the rest of the app staying.

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// A Codex app-server stand-in behind the real Codex relay, as lazy-chunks.spec.js builds it: one thread; send() pushes a message
// from the harness to the page, and answered(id) is the answer the page gave the harness's request of that id.
async function codexFixture(page){
  const thread={id:"idle-parts-fixture",name:"Idle parts fixture",preview:"Idle parts",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  let socket=null;const messages=[];
  const upstreamHttp=createServer(),upstreamWss=new WebSocketServer({noServer:true}),sockets=new Set();
  upstreamHttp.on("upgrade",(req,raw,head)=>upstreamWss.handleUpgrade(req,raw,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);socket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));messages.push(message);if(message.id==null||!message.method)return;let result={};
      if(message.method==="initialize")result={userAgent:"idle-parts-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:process.platform,version:"idle-parts-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,route.request().method()==="POST"?{ok:true}:{enabled:false,items:[]}));
  return {
    thread,send:message=>socket.send(JSON.stringify(message)),
    answered:id=>messages.find(message=>message.id===id&&!message.method)?.result??null,
    async close(){relay.close();for(const item of sockets)try{item.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}
// The script App loads at idle after the first paint (idle-parts.js), held from the page's first request for it until release(), or
// refused at every request (refuse).
async function idleParts(page,{refuse=false}={}){
  const held=[];let asked=0;
  await page.route(/\/assets\/idle-parts-[^/]*\.js$/,route=>{asked++;if(refuse)return route.abort("failed");held.push(route)});
  return {
    asked:()=>expect.poll(()=>asked,{message:"the script asked for at idle"}).toBeGreaterThan(0),
    async release(){for(const route of held.splice(0))await route.continue()},
  };
}
// The page opened on the new task, its thread listed in the sidebar.
async function openApp(page){
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await expect(page.locator(".thread-row")).toHaveCount(1,{timeout:10_000});
  await expect(page.getByTestId("composer")).toBeVisible();
}
const appStays=async page=>{
  await expect(page.locator(".sidebar"),"the sidebar").toBeVisible();
  await expect(page.getByTestId("composer"),"the composer").toBeVisible();
};
const CANNOT_LOAD=/^This part of Trebell could not be shown: Part of Trebell could not load\. Reload Trebell to get it back\.\s*Reload$/;
// Each part as a person sees it, in dark and in light.
async function shoot(page,name){
  for(const mode of ["dark","light"]){
    await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
    await page.screenshot({animations:"disabled",path:auditDir+`${name}-${mode}-1280x800.png`});
  }
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
}
// Counts the loading lines ("Loading panel…", "Loading thread history…") drawn from now on, each as React puts it on the page.
async function countLoadingLines(page){
  await page.evaluate(()=>{
    window.__loadingLines=0;
    new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1&&(node.matches(".surface-loading")||node.querySelector(".surface-loading")))window.__loadingLines++}).observe(document.body,{childList:true,subtree:true});
  });
  return ()=>page.evaluate(()=>window.__loadingLines);
}
const approvalRequest=(fixture,id,command,reason)=>({id,method:"item/commandExecution/requestApproval",params:{threadId:fixture.thread.id,turnId:"turn-"+id,itemId:"cmd-"+id,command,reason}});

test("an approval a harness asks as the page opens waits for its card's script, shows once it has come, and is answered by a click and by a key",async({page})=>{
  test.setTimeout(60_000);
  const parts=await idleParts(page),fixture=await codexFixture(page);
  try{
    await openApp(page);
    const welcome=page.locator(".conversation-column .welcome"),card=page.locator(".conversation-column .approval-card");
    await expect(welcome).toBeVisible();
    // The harness asks before the script has come: the request is in (the new task's welcome makes way for it), and its card waits for
    // its code, nothing drawn in its place meanwhile, neither an empty card nor a failure.
    fixture.send(approvalRequest(fixture,"approval-early",["npm","test"],"Run the fixture's tests"));
    await expect(welcome).toHaveCount(0);
    await expect(card).toHaveCount(0);await expect(page.locator(".conversation-column .inline-approval")).toHaveCount(0);await expect(page.locator(".lazy-slot-error")).toHaveCount(0);
    await parts.asked();
    await parts.release();
    await expect(card).toBeVisible();
    await expect(card.locator(".card-title")).toHaveText("Command needs approval");
    await expect(card.getByTestId("approval-thread")).toHaveText("Waiting in Idle parts fixture");
    await expect(card.getByText("Run the fixture's tests",{exact:true})).toBeVisible();
    await expect(card.getByTestId("approval-command")).toHaveText("npm test");
    await expect(card.getByRole("button")).toHaveText(["Deny","Allow session","Allow once"]);
    await shoot(page,"idle-approval-card");
    await card.getByRole("button",{name:"Allow once",exact:true}).click();
    await expect.poll(()=>fixture.answered("approval-early"),{message:"the answer the harness got"}).toEqual({decision:"accept"});
    await expect(card).toHaveCount(0);await expect(welcome).toBeVisible();
    // With the script in, the next approval shows the moment it is asked, and Enter on its Deny answers it.
    fixture.send(approvalRequest(fixture,"approval-next",["git","push"],"Push the fixture's branch"));
    await expect(card.getByTestId("approval-command")).toHaveText("git push",{timeout:1500});
    await card.getByRole("button",{name:"Deny",exact:true}).focus();await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.answered("approval-next"),{message:"the answer the harness got"}).toEqual({decision:"decline"});
    await expect(card).toHaveCount(0);
    await appStays(page);
  }finally{await parts.release().catch(()=>{});await fixture.close()}
});

test("an approval whose card's script cannot load says so in the card's place, with Reload, and the rest of the app stays",async({page})=>{
  test.setTimeout(60_000);
  const parts=await idleParts(page,{refuse:true}),fixture=await codexFixture(page);
  try{
    await openApp(page);
    await parts.asked();
    fixture.send(approvalRequest(fixture,"approval-refused",["npm","test"],"Run the fixture's tests"));
    const failed=page.locator(".conversation-column .lazy-slot-error");
    await expect(failed).toHaveText(CANNOT_LOAD);await expect(failed).toHaveAttribute("role","alert");
    await expect(page.locator(".conversation-column .approval-card")).toHaveCount(0);await expect(page.locator(".conversation-column .welcome")).toHaveCount(0);
    await appStays(page);
    await shoot(page,"idle-approval-card-cannot-load");
    // Reload loads Trebell again, which is what loads a script the browser keeps as failed.
    await Promise.all([page.waitForEvent("load"),failed.getByRole("button",{name:"Reload",exact:true}).click()]);
    await expect(page.locator(".thread-row")).toHaveCount(1,{timeout:10_000});
  }finally{await fixture.close()}
});

test("the Runtime tab opened as the page opens says Loading panel… until its script has come, then draws, with the keyboard still on its tab, and at once from then on",async({page})=>{
  test.setTimeout(60_000);
  const parts=await idleParts(page),fixture=await codexFixture(page);
  try{
    await openApp(page);
    await page.getByTestId("right-panel-toggle").click();
    const panel=page.getByTestId("right-panel"),tab=panel.getByRole("button",{name:"Runtime",exact:true}),surface=panel.locator(".runtime-surface");
    await tab.focus();await page.keyboard.press("Enter");
    await expect(tab).toHaveClass(/\bactive\b/);
    const loading=panel.locator(".surface-loading");
    await expect(loading).toHaveText("Loading panel…");await expect(loading).toHaveAttribute("role","status");
    await expect(surface).toHaveCount(0);
    await parts.asked();
    await parts.release();
    await expect(surface).toBeVisible();await expect(loading).toHaveCount(0);
    await expect(surface.locator(".runtime-summary strong")).toHaveText("Codex harness");
    await expect(surface.locator(".runtime-summary span").last()).toHaveText("Connected locally");
    await expect(surface.getByTestId("runtime-activity-steps")).toHaveText("No activity yet");
    await expect(surface.getByText("Agent harness",{exact:true})).toBeVisible();
    await expect(surface.locator(".runtime-capability-grid > div")).toHaveCount(14);
    await expect(surface.locator(".runtime-activity p")).toHaveText("Waiting for a task");
    await expect(tab).toBeFocused();
    await shoot(page,"idle-runtime-tab");
    // Closed and opened again, the tab draws at once: no loading line comes in between.
    await panel.getByRole("button",{name:"Close right panel"}).click();await expect(panel).toHaveCount(0);
    const loadingLines=await countLoadingLines(page);
    await page.getByTestId("right-panel-toggle").click();
    await expect(page.getByTestId("right-panel").locator(".runtime-surface")).toBeVisible();
    expect(await loadingLines(),"loading lines drawn as the tab opened again").toBe(0);
    await appStays(page);
  }finally{await parts.release().catch(()=>{});await fixture.close()}
});

test("the Runtime tab whose script cannot load says so in the panel, with Reload, and the panel and the app stay",async({page})=>{
  test.setTimeout(60_000);
  const parts=await idleParts(page,{refuse:true}),fixture=await codexFixture(page);
  try{
    await openApp(page);
    await parts.asked();
    await page.getByTestId("right-panel-toggle").click();
    const panel=page.getByTestId("right-panel");
    await panel.getByRole("button",{name:"Runtime",exact:true}).click();
    const failed=panel.locator(".lazy-slot-error");
    await expect(failed).toHaveText(CANNOT_LOAD);await expect(failed).toHaveAttribute("role","alert");
    await expect(panel.locator(".runtime-surface")).toHaveCount(0);
    await expect(panel.getByRole("button",{name:"Files",exact:true})).toBeVisible();
    await appStays(page);
    await shoot(page,"idle-runtime-tab-cannot-load");
  }finally{await fixture.close()}
});

test("History opened as the page opens says Loading thread history… under its heading until its script has come, then lists the threads, which open with a click, and draws at once from then on",async({page})=>{
  test.setTimeout(60_000);
  const parts=await idleParts(page),fixture=await codexFixture(page);
  try{
    await openApp(page);
    const nav=label=>page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:label,exact:true});
    const heading=page.getByRole("heading",{name:"Thread history",level:1}),loading=page.locator(".secondary-page .surface-loading"),row=page.locator(".history-thread-row").filter({hasText:"Idle parts fixture"});
    await nav("History").click();
    await expect(heading).toBeVisible();
    await expect(loading).toHaveText("Loading thread history…");await expect(loading).toHaveAttribute("role","status");
    await expect(page.locator(".history-page")).toHaveCount(0);
    await parts.asked();
    await parts.release();
    await expect(row).toBeVisible();await expect(loading).toHaveCount(0);
    await expect(row.locator(".history-runtime-chip")).toHaveText("Codex");await expect(row.locator(".history-runtime-chip")).toHaveAttribute("title","Owned by Codex");
    await expect(nav("History")).toBeFocused();
    await shoot(page,"idle-history-page");
    await row.click();
    await expect(page.locator(".thread-title-button strong")).toHaveText("Idle parts fixture");
    await expect(page.getByRole("heading",{name:"What do you want to think through?"})).toBeVisible();
    // Back on History, its list draws at once: no loading line comes in between.
    const loadingLines=await countLoadingLines(page);
    await nav("History").click();
    await expect(row).toBeVisible();
    expect(await loadingLines(),"loading lines drawn as History opened again").toBe(0);
    await nav("New task").click();
    await appStays(page);
  }finally{await parts.release().catch(()=>{});await fixture.close()}
});

test("History whose script cannot load says so under its heading, with Reload, and the way back to the chat stays",async({page})=>{
  test.setTimeout(60_000);
  const parts=await idleParts(page,{refuse:true}),fixture=await codexFixture(page);
  try{
    await openApp(page);
    await parts.asked();
    const nav=label=>page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:label,exact:true});
    await nav("History").click();
    await expect(page.getByRole("heading",{name:"Thread history",level:1})).toBeVisible();
    const failed=page.locator(".secondary-page .lazy-slot-error");
    await expect(failed).toHaveText(CANNOT_LOAD);await expect(failed).toHaveAttribute("role","alert");
    await expect(page.locator(".history-page")).toHaveCount(0);
    await shoot(page,"idle-history-page-cannot-load");
    await nav("New task").click();
    await appStays(page);
  }finally{await fixture.close()}
});
