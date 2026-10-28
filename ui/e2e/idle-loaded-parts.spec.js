import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";
import { auditDir } from "./native-stream-fixture.js";

// What App draws only once the person opens it comes in the script App loads at idle right after the first paint (idle-parts.js,
// B11): the right panel's Runtime tab and History's list. Each opened before that idle load asks for the script at once (here with
// the idle callback held, so nothing else would load it) and says it is loading in its place until the script has come; once the
// script is in, each draws at once, as before; and where the script cannot load, each says so in its place, in loadFailed's words,
// with Reload, the rest of the app staying: the panel's other tabs, and History's heading where the loading line put it. The card of
// an approval a harness waits on is not one of them: it stays in the app's first script, so one a harness asks again as the page
// connects shows at once, the conversation never empty meanwhile.

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// A Codex app-server stand-in behind the real Codex relay, as lazy-chunks.spec.js builds it: one thread; send() pushes a message
// from the harness to the page, and answered(id) is the answer the page gave the harness's request of that id. askOnInitialized: the
// harness asks its waiting approval again of a page that has just connected, as the agent relay does on "initialized" (askAgain).
async function codexFixture(page,{askOnInitialized=false}={}){
  const thread={id:"idle-parts-fixture",name:"Idle parts fixture",preview:"Idle parts",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  let socket=null,askedAgain=0;const messages=[];
  const upstreamHttp=createServer(),upstreamWss=new WebSocketServer({noServer:true}),sockets=new Set();
  upstreamHttp.on("upgrade",(req,raw,head)=>upstreamWss.handleUpgrade(req,raw,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);socket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));messages.push(message);
      if(message.method==="initialized"&&askOnInitialized){askedAgain++;ws.send(JSON.stringify(approvalRequest({thread},"approval-again-"+askedAgain,["npm","test"],"Run the fixture's tests")))}
      if(message.id==null||!message.method)return;let result={};
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
// The script App loads at idle after the first paint (idle-parts.js), held from the page's first request for it until release() (or
// abort(), which fails it then), or refused at every request (refuse).
async function idleParts(page,{refuse=false}={}){
  const held=[];let asked=0;
  await page.route(/\/assets\/idle-parts-[^/]*\.js$/,route=>{asked++;if(refuse)return route.abort("failed");held.push(route)});
  return {
    asked:()=>expect.poll(()=>asked,{message:"the script asked for"}).toBeGreaterThan(0),
    async release(){for(const route of held.splice(0))await route.continue()},
    async abort(){for(const route of held.splice(0))await route.abort("failed")},
  };
}
// The app's idle callbacks (requestIdleCallback), held from the page's start until release(): nothing loads at idle meanwhile, so
// what loads before then was asked for by what the person opened.
async function holdIdle(page){
  await page.addInitScript(()=>{
    const held=[];
    window.requestIdleCallback=callback=>{held.push(callback);return held.length};
    window.__idleHeld=()=>held.length;
    window.__releaseIdle=()=>{for(const callback of held.splice(0))callback({didTimeout:false,timeRemaining:()=>50})};
  });
  return {
    asked:()=>expect.poll(()=>page.evaluate(()=>window.__idleHeld()),{message:"the idle callbacks the app asked for, held"}).toBeGreaterThan(0),
    release:()=>page.evaluate(()=>window.__releaseIdle()),
  };
}
// How many times the page asked for a script whose path matches pattern.
function requestsFor(page,pattern){
  let count=0;page.on("request",request=>{if(pattern.test(new URL(request.url()).pathname))count++});
  return ()=>count;
}
// Watches, in the page, an approval a harness asks: when its message came over the socket, when its card was in the conversation,
// and how many frames were drawn in between with neither the new task's welcome nor the card in the conversation column.
const watchApproval=()=>{
  const now=()=>performance.now();
  const log=window.__approvalWatch={arrived:null,shown:null,frames:0,blankFrames:0};
  const Native=window.WebSocket;
  const Watched=function(...args){const socket=new Native(...args);socket.addEventListener("message",event=>{if(log.arrived==null&&typeof event.data==="string"&&event.data.includes("requestApproval"))log.arrived=now()});return socket};
  Watched.prototype=Native.prototype;for(const key of ["CONNECTING","OPEN","CLOSING","CLOSED"])Watched[key]=Native[key];
  window.WebSocket=Watched;
  new MutationObserver(()=>{if(log.shown==null&&document.querySelector(".conversation-column .approval-card"))log.shown=now()}).observe(document,{childList:true,subtree:true});
  const frame=()=>{
    if(log.arrived!=null&&log.shown==null){log.frames++;const column=document.querySelector(".conversation-column");if(column&&!column.querySelector(".welcome")&&!column.querySelector(".approval-card"))log.blankFrames++}
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};
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
// Where a secondary page's heading sits and how big its title and line are.
const headingPlace=page=>page.locator(".secondary-page > .page-header").evaluate(header=>{
  const title=header.querySelector("h1"),line=header.querySelector("p"),at=node=>{const box=node.getBoundingClientRect();return [Math.round(box.x),Math.round(box.y),Math.round(box.width),Math.round(box.height)]};
  return {header:at(header),title:at(title),line:at(line),titleSize:getComputedStyle(title).fontSize,lineSize:getComputedStyle(line).fontSize};
});
function approvalRequest(fixture,id,command,reason){return {id,method:"item/commandExecution/requestApproval",params:{threadId:fixture.thread.id,turnId:"turn-"+id,itemId:"cmd-"+id,command,reason}}}
const nav=(page,label)=>page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:label,exact:true});

test("an approval a harness asks again as the page connects shows at once while the idle script is on its way, the conversation never empty, and is answered by a click and by a key",async({page})=>{
  test.setTimeout(60_000);
  const parts=await idleParts(page),fixture=await codexFixture(page,{askOnInitialized:true});
  try{
    await page.addInitScript(watchApproval);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const card=page.locator(".conversation-column .approval-card");
    // The card is in the app's first script: it shows with the idle script still held, from the frame the request came in.
    await expect(card).toBeVisible({timeout:10_000});
    await expect(card.locator(".card-title")).toHaveText("Command needs approval");
    await expect(card.getByText("Run the fixture's tests",{exact:true})).toBeVisible();
    await expect(card.getByTestId("approval-command")).toHaveText("npm test");
    await expect(card.getByRole("button")).toHaveText(["Deny","Allow session","Allow once"]);
    const watched=await page.evaluate(()=>window.__approvalWatch);console.log("approval asked again as the page connects:",JSON.stringify(watched));
    expect(watched.arrived,"the approval's message").not.toBeNull();expect(watched.shown,"the card").not.toBeNull();
    expect(watched.blankFrames,"frames drawn with neither the welcome nor the card in the conversation").toBe(0);
    await expect(page.locator(".lazy-slot-error")).toHaveCount(0);
    await shoot(page,"first-script-approval-asked-again");
    await card.getByRole("button",{name:"Allow once",exact:true}).click();
    await expect.poll(()=>fixture.answered("approval-again-1"),{message:"the answer the harness got"}).toEqual({decision:"accept"});
    await expect(card).toHaveCount(0);await expect(page.locator(".conversation-column .welcome")).toBeVisible();
    // The next approval shows the moment it is asked, the idle script still held, and Enter on its Deny answers it.
    fixture.send(approvalRequest(fixture,"approval-next",["git","push"],"Push the fixture's branch"));
    await expect(card.getByTestId("approval-command")).toHaveText("git push",{timeout:1500});
    await card.getByRole("button",{name:"Deny",exact:true}).focus();await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.answered("approval-next"),{message:"the answer the harness got"}).toEqual({decision:"decline"});
    await expect(card).toHaveCount(0);
    await parts.release();
    await appStays(page);
  }finally{await parts.release().catch(()=>{});await fixture.close()}
});

test("the Runtime tab opened before the app's idle load asks for its script and its trace's at once, says Loading panel… until its script has come, then draws, with the keyboard still on its tab, and at once from then on",async({page})=>{
  test.setTimeout(60_000);
  const idle=await holdIdle(page),parts=await idleParts(page),traceAsked=requestsFor(page,/\/assets\/RuntimeTrace-[^/]*\.js$/),fixture=await codexFixture(page);
  try{
    await openApp(page);
    await idle.asked();
    await page.getByTestId("right-panel-toggle").click();
    const panel=page.getByTestId("right-panel"),tab=panel.getByRole("button",{name:"Runtime",exact:true}),surface=panel.locator(".runtime-surface");
    await tab.focus();await page.keyboard.press("Enter");
    await expect(tab).toHaveClass(/\bactive\b/);
    const loading=panel.locator(".surface-loading");
    await expect(loading).toHaveText("Loading panel…");await expect(loading).toHaveAttribute("role","status");
    await expect(surface).toHaveCount(0);
    // With the idle callback held, only the tab asks for its script, and for its trace's beside it, before the tab's has come.
    await parts.asked();
    await expect.poll(traceAsked,{message:"the trace's script asked for while the tab's is on its way"}).toBeGreaterThan(0);
    await shoot(page,"idle-runtime-tab-loading");
    await parts.release();
    await expect(surface).toBeVisible();await expect(loading).toHaveCount(0);
    await expect(surface.locator(".runtime-summary strong")).toHaveText("Codex harness");
    await expect(surface.locator(".runtime-summary span").last()).toHaveText("Connected locally");
    await expect(surface.getByTestId("runtime-activity-steps")).toHaveText("No activity yet");
    await expect(surface.getByText("Agent harness",{exact:true})).toBeVisible();
    await expect(surface.locator(".runtime-capability-grid > div")).toHaveCount(14);
    await expect(surface.getByTestId("runtime-trace")).toBeVisible();
    await expect(surface.locator(".runtime-activity p")).toHaveText("Waiting for a task");
    await expect(tab).toBeFocused();
    await shoot(page,"idle-runtime-tab");
    await idle.release();
    // Closed and opened again, the tab draws at once: no loading line comes in between.
    await panel.getByRole("button",{name:"Close right panel"}).click();await expect(panel).toHaveCount(0);
    const loadingLines=await countLoadingLines(page);
    await page.getByTestId("right-panel-toggle").click();
    await expect(page.getByTestId("right-panel").locator(".runtime-surface")).toBeVisible();
    expect(await loadingLines(),"loading lines drawn as the tab opened again").toBe(0);
    await appStays(page);
  }finally{await parts.release().catch(()=>{});await idle.release().catch(()=>{});await fixture.close()}
});

test("the Runtime tab whose script cannot load says so in its place, with Reload, and the panel's other tabs still draw, by mouse and by keyboard",async({page})=>{
  test.setTimeout(60_000);
  const parts=await idleParts(page,{refuse:true}),fixture=await codexFixture(page);
  try{
    await openApp(page);
    await parts.asked();
    await page.getByTestId("right-panel-toggle").click();
    const panel=page.getByTestId("right-panel"),tab=label=>panel.getByRole("button",{name:label,exact:true}),files=panel.locator(".workspace-panel"),failed=panel.locator(".lazy-slot-error");
    // The workspace's files, as the Files tab lists them once it has read them (the checkout's own).
    const listed=panel.locator(".tree-list .tree-row").first();
    await expect(tab("Files")).toHaveClass(/\bactive\b/);await expect(files).toBeVisible();await expect(listed).toBeVisible();
    await tab("Runtime").click();
    await expect(failed).toHaveText(CANNOT_LOAD);await expect(failed).toHaveAttribute("role","alert");
    await expect(panel.locator(".runtime-surface")).toHaveCount(0);
    await appStays(page);
    await shoot(page,"idle-runtime-tab-cannot-load");
    // Files draws its list again: the Runtime tab's failure takes only its own place with it.
    await tab("Files").click();
    await expect(files).toBeVisible();await expect(listed).toBeVisible();await expect(failed).toHaveCount(0);
    await shoot(page,"idle-runtime-tab-cannot-load-files");
    // By keyboard: Enter on Runtime says it could not load again, and Enter on Files brings the list back.
    await tab("Runtime").focus();await page.keyboard.press("Enter");
    await expect(failed).toHaveText(CANNOT_LOAD);await expect(files).toHaveCount(0);
    await tab("Files").focus();await page.keyboard.press("Enter");
    await expect(files).toBeVisible();await expect(listed).toBeVisible();await expect(failed).toHaveCount(0);
    await appStays(page);
    // Reload loads Trebell again, which is what loads a script the browser keeps as failed.
    await tab("Runtime").click();await expect(failed).toHaveText(CANNOT_LOAD);
    await Promise.all([page.waitForEvent("load"),failed.getByRole("button",{name:"Reload",exact:true}).click()]);
    await expect(page.locator(".thread-row")).toHaveCount(1,{timeout:10_000});
    await appStays(page);
  }finally{await fixture.close()}
});

test("History opened before the app's idle load asks for its script at once, says Loading thread history… under its heading until it has come, then lists the threads, which open with a click, and draws at once from then on",async({page})=>{
  test.setTimeout(60_000);
  const idle=await holdIdle(page),parts=await idleParts(page),fixture=await codexFixture(page);
  try{
    await openApp(page);
    await idle.asked();
    const heading=page.getByRole("heading",{name:"Thread history",level:1}),loading=page.locator(".secondary-page .surface-loading"),row=page.locator(".history-thread-row").filter({hasText:"Idle parts fixture"});
    await nav(page,"History").click();
    await expect(heading).toBeVisible();
    await expect(loading).toHaveText("Loading thread history…");await expect(loading).toHaveAttribute("role","status");
    await expect(page.locator(".history-page")).toHaveCount(0);
    // With the idle callback held, History asks for its script itself.
    await parts.asked();
    await shoot(page,"idle-history-page-loading");
    await parts.release();
    await expect(row).toBeVisible();await expect(loading).toHaveCount(0);
    await expect(row.locator(".history-runtime-chip")).toHaveText("Codex");await expect(row.locator(".history-runtime-chip")).toHaveAttribute("title","Owned by Codex");
    await expect(nav(page,"History")).toBeFocused();
    await shoot(page,"idle-history-page");
    await idle.release();
    await row.click();
    await expect(page.locator(".thread-title-button strong")).toHaveText("Idle parts fixture");
    await expect(page.getByRole("heading",{name:"What do you want to think through?"})).toBeVisible();
    // Back on History, its list draws at once: no loading line comes in between.
    const loadingLines=await countLoadingLines(page);
    await nav(page,"History").click();
    await expect(row).toBeVisible();
    expect(await loadingLines(),"loading lines drawn as History opened again").toBe(0);
    await nav(page,"New task").click();
    await appStays(page);
  }finally{await parts.release().catch(()=>{});await idle.release().catch(()=>{});await fixture.close()}
});

test("History whose script cannot load says so under its heading, which stays where its loading line put it, with Reload, and the way back to the chat stays",async({page})=>{
  test.setTimeout(60_000);
  const parts=await idleParts(page),fixture=await codexFixture(page);
  try{
    await openApp(page);
    await parts.asked();
    const heading=page.getByRole("heading",{name:"Thread history",level:1}),loading=page.locator(".secondary-page .surface-loading"),failed=page.locator(".secondary-page .lazy-slot-error");
    await nav(page,"History").click();
    await expect(heading).toBeVisible();await expect(loading).toHaveText("Loading thread history…");
    const loadingPlace=await headingPlace(page);
    expect(loadingPlace.titleSize).toBe("26px");expect(loadingPlace.lineSize).toBe("13px");
    // The script fails as it comes: the loading line turns into the reason, with Reload, and the heading does not move or shrink.
    await parts.abort();
    await expect(failed).toHaveText(CANNOT_LOAD);await expect(failed).toHaveAttribute("role","alert");
    await expect(page.locator(".history-page")).toHaveCount(0);
    expect(await headingPlace(page),"the heading as History's script could not load").toEqual(loadingPlace);
    const failedBox=await failed.boundingBox();expect(Math.round(failedBox.x),"the reason under the heading's left edge").toBe(loadingPlace.header[0]);
    await shoot(page,"idle-history-page-cannot-load");
    await nav(page,"New task").click();
    await appStays(page);
  }finally{await parts.release().catch(()=>{});await fixture.close()}
});
