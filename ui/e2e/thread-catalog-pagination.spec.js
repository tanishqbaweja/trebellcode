import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir+"polish/history",{recursive:true});

function meta(id,name,updatedAt){
  return {__catalogOnly:true,runtime:"claude",runtimeInstanceId:"claude-default",projectless:true,updatedAt,threadSnapshot:{id,name,preview:name+" preview",cwd:process.cwd(),model:"claude-test",updatedAt,createdAt:updatedAt-10,status:{type:"idle"},runtime:"claude",provider:"claude"}};
}
async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
// control.listed is what thread/list answers, control.older, when set, the older page its next cursor reads, control.oldest, when set,
// the page after that, control.listError, when set, fails it, and control.hold, when set, holds the next one until it resolves;
// control.lists counts the lists asked for and control.cursors keeps the cursor each was asked with (null for the first page).
// control.pages(cursor), when set, answers each list in their place: a page ({data, nextCursor}), or {error} for a cursor the runtime
// refuses. control.holdInitialize, when set, holds the next initialize until it resolves (a transport that takes a while to
// connect). pause() stops reading what the sockets open now send until resume(), so a socket the page closes meanwhile stays
// closing, its requests unanswered and not yet failed, until then.
async function startRuntimeHarness(thread){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),control={listed:[thread],older:null,oldest:null,listError:null,hold:null,holdInitialize:null,pages:null,lists:0,cursors:[]},sockets=new Set(),paused=new Set();
  http.on("upgrade",(req,socket,head)=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req))});
  wss.on("connection",ws=>ws.on("message",async raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
    let result={};
    if(message.method==="initialize"&&control.holdInitialize){const held=control.holdInitialize;control.holdInitialize=null;await held}
    if(message.method==="thread/list"){control.lists++;control.cursors.push(message.params?.cursor||null);if(control.hold){const held=control.hold;control.hold=null;await held}}
    if(message.method==="thread/list"&&control.listError)return ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:control.listError}}));
    const page=message.method==="thread/list"&&control.pages?control.pages(message.params?.cursor||null):null;
    if(page?.error)return ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:page.error}}));
    if(message.method==="initialize")result={userAgent:"catalog-pagination-connected-fixture"};
    else if(page)result=page;
    else if(message.method==="thread/list")result=message.params?.cursor==="oldest-page"?{data:control.oldest||[],nextCursor:null}:message.params?.cursor==="older-page"?{data:control.older||[],nextCursor:control.oldest?"oldest-page":null}:{data:control.listed,nextCursor:control.older?"older-page":null};
    else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
    ws.send(JSON.stringify({id:message.id,result}));
  }));
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {control,wsUrl:"ws://127.0.0.1:"+port+"/rpc",
    pause(){for(const socket of sockets){socket.pause();paused.add(socket)}},
    resume(){for(const socket of paused)socket.resume();paused.clear()},
    async close(){for(const socket of paused)socket.resume();for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

test("History pages older Trebell catalog rows even without a connected runtime",async({page})=>{
  const now=Date.now()/1000,settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const recent={"recent-a":meta("recent-a","Recent A",now),"recent-b":meta("recent-b","Recent B",now-1)},older={"older-c":meta("older-c","Older C",now-100)};
  let catalogReads=0;
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:true,provider:"openai",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:false,wsUrl:"",cwd:process.cwd(),platform:process.platform,version:"catalog-page-fixture",runtimeCapabilities:{},activeEnvironmentId:null,activeEnvironment:null})}));
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
  await page.screenshot({animations:"disabled",path:auditDir+"history-catalog-pagination-1280x800.png",fullPage:true});
});

// A failed Load older threads is said by the button, at the bottom of a long History where the person clicked it; it was said at the
// top of the page, out of view, and only the button coming back showed anything had happened. Pressed with the keyboard, the button
// keeps the keyboard while it loads and after it fails, so Enter tries again; trying again loads the page.
test("a failed Load older threads says so by the button",async({page})=>{
  test.setTimeout(45_000);
  const now=Date.now()/1000;
  let settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const recent=Object.fromEntries(Array.from({length:30},(_,index)=>["recent-"+index,meta("recent-"+index,"Recent thread "+(index+1),now-index)])),older={"older-c":meta("older-c","Older C",now-1000)};
  let catalogReads=0;
  const json=body=>({status:200,contentType:"application/json",body:JSON.stringify(body)});
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill(json({mock:true,provider:"openai",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:false,wsUrl:"",cwd:process.cwd(),platform:process.platform,version:"catalog-page-failure-fixture",runtimeCapabilities:{},activeEnvironmentId:null,activeEnvironment:null})));
  await page.route(/\/api\/state$/,route=>route.fulfill(json({settings,projects:[],threadMeta:recent,threadMetaNextCursor:"older-page-1"})));
  // The header's mode button saves the mode here, so the page keeps this fixture's settings.
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")settings={...settings,...route.request().postDataJSON()};return route.fulfill(json(settings))});
  await page.route(/\/api\/models$/,route=>route.fulfill(json({agentRuntime:"claude",ready:true,models:["claude-test"],metadata:{agentRuntime:"claude",models:[{id:"claude-test",name:"Claude Test",agent:"Claude Code"}]}})));
  await page.route(/\/api\/projects$/,route=>route.fulfill(json({projects:[]})));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill(json({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})));
  await page.route(/\/api\/recovery$/,route=>route.fulfill(json({enabled:false,items:[]})));
  // The first older page is held until its loading state has been shown; the second fails too, after a moment.
  let releaseFirst=null;const firstHeld=new Promise(resolve=>{releaseFirst=resolve});
  await page.route(/\/api\/thread-meta\?/,async route=>{catalogReads++;await (catalogReads===1?firstHeld:new Promise(resolve=>setTimeout(resolve,150)));return catalogReads<=2?route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate catalog page failure"})}):route.fulfill(json({threadMeta:older,nextCursor:null}))});
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"History",exact:true}).click();
  const history=page.locator(".history-page"),load=page.getByRole("button",{name:"Load older threads"});
  await expect(history.getByRole("button",{name:/Recent thread 30/})).toHaveCount(1);
  // The person turns the mouse wheel over the list until the button at its bottom shows.
  await page.mouse.move(800,400);
  for(let notch=0;notch<60&&!await load.evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight);notch++){await page.mouse.wheel(0,200);await page.waitForTimeout(40)}
  await expect(load).toBeInViewport({ratio:1});
  await load.click();
  // While it loads the button keeps focus, says so and looks unavailable, in both modes.
  const loading=page.getByRole("button",{name:"Loading older threads…"});
  await expect(loading).toBeFocused();
  await expect(loading).toHaveAttribute("aria-disabled","true");
  for(const mode of ["dark","light"]){
    await page.setViewportSize({width:1280,height:800});
    if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await loading.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`polish/history/older-threads-loading-${mode}-${width}.png`})}
  }
  await page.setViewportSize({width:1280,height:800});await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
  releaseFirst();
  const failure=history.getByRole("alert").filter({hasText:"Deliberate catalog page failure"});
  await expect(failure).toBeInViewport({ratio:1});
  await expect(failure).toHaveText("Could not load older threads: Trebell catalog: Deliberate catalog page failure");
  await expect(load).toBeEnabled();await expect(load).toBeInViewport({ratio:1});
  await expect(history.getByRole("alert")).toHaveCount(1);
  for(const mode of ["dark","light"]){
    await page.setViewportSize({width:1280,height:800});
    if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await failure.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`polish/history/older-threads-failed-${mode}-${width}.png`})}
  }
  await page.setViewportSize({width:1280,height:800});
  // Leaving History and coming back starts it over: the old failure is not left by the button.
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:"History",exact:true}).click();
  await expect(load).toBeVisible();await expect(history.getByRole("alert")).toHaveCount(0);
  // The keyboard way: the person has tabbed to the button and presses Enter; it fails again, and the keyboard is still on it.
  await load.focus();await page.keyboard.press("Enter");
  await expect(page.getByRole("button",{name:"Loading older threads…"})).toBeFocused();
  await expect(failure).toBeVisible();
  await expect(load).toBeFocused();
  // Trying again, with Enter, loads the older page.
  await page.keyboard.press("Enter");
  await expect(history.getByRole("button",{name:/Older C/})).toBeVisible();
  await expect(history.getByRole("alert")).toHaveCount(0);await expect(load).toHaveCount(0);
  expect(catalogReads).toBe(3);
});

test("connected runtime history refresh preserves the independent Trebell catalog cursor",async({page})=>{
  const now=Date.now()/1000,runtimeThread={id:"runtime-recent",name:"Runtime recent",preview:"Runtime recent preview",cwd:process.cwd(),model:"claude-test",runtime:"claude",status:{type:"idle"},createdAt:now-20,updatedAt:now-2,turns:[]};
  const harness=await startRuntimeHarness(runtimeThread),settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const recent={"catalog-recent":meta("catalog-recent","Catalog recent",now-1)},older={"catalog-older":meta("catalog-older","Catalog older",now-100)};let catalogReads=0;
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"openai",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"catalog-page-connected-fixture",runtimeCapabilities:{},activeEnvironmentId:null,activeEnvironment:null})}));
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

// History's first page, which the runtime fails to list, says so with Retry, and nothing claims there is no history: the failure
// sat on "No thread history yet" with Start a new task. Retry pressed from the keyboard keeps the keyboard, and a second failure is
// said as a new message; a Retry the runtime answers lists the thread.
test("a History the runtime could not list says so with Retry, not that there is no thread history",async({page})=>{
  test.setTimeout(45_000);
  const now=Date.now()/1000,runtimeThread={id:"runtime-retried",name:"Runtime retried",preview:"Runtime retried preview",cwd:process.cwd(),model:"claude-test",runtime:"claude",status:{type:"idle"},createdAt:now-20,updatedAt:now-2,turns:[]};
  const harness=await startRuntimeHarness(runtimeThread);harness.control.listed=[];
  let settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const json=body=>({status:200,contentType:"application/json",body:JSON.stringify(body)});
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill(json({mock:false,provider:"openai",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"history-load-failure-fixture",runtimeCapabilities:{},activeEnvironmentId:null,activeEnvironment:null})));
    await page.route(/\/api\/state$/,route=>route.fulfill(json({settings,projects:[],threadMeta:{}})));
    // The header's mode button saves the mode here, so the page keeps this fixture's settings.
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")settings={...settings,...route.request().postDataJSON()};return route.fulfill(json(settings))});
    await page.route(/\/api\/models$/,route=>route.fulfill(json({agentRuntime:"claude",ready:true,models:["claude-test"],metadata:{agentRuntime:"claude",models:[{id:"claude-test",name:"Claude Test",agent:"Claude Code"}]}})));
    await page.route(/\/api\/projects$/,route=>route.fulfill(json({projects:[]})));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill(json({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})));
    await page.route(/\/api\/recovery$/,route=>route.fulfill(json({enabled:false,items:[]})));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>route.fulfill(json(route.request().method()==="POST"?route.request().postDataJSON()?.patch||{}:{threadMeta:{},nextCursor:null})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(0);
    harness.control.listError="Deliberate thread list failure";
    await page.getByRole("button",{name:"History",exact:true}).click();
    const history=page.locator(".history-page"),alert=history.getByRole("alert"),retry=alert.getByRole("button",{name:"Retry",exact:true});
    await expect(alert).toContainText("Could not load thread history: Deliberate thread list failure");
    await expect(history.getByText("No thread history yet")).toHaveCount(0);
    await expect(history.getByRole("button",{name:"Start a new task"})).toHaveCount(0);
    await expect(retry).toBeEnabled();
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});
      if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      // The message is the banner's own text, red at its size and on as many lines as it needs, not a grey one-line row caption.
      expect(await alert.locator("span").first().evaluate(node=>{const own=getComputedStyle(node),banner=getComputedStyle(node.parentElement);return {size:own.fontSize===banner.fontSize,color:own.color===banner.color,wraps:own.whiteSpace!=="nowrap"}}),mode).toEqual({size:true,color:true,wraps:true});
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+`polish/history/history-load-failed-${mode}-${width}.png`})}
    }
    await page.setViewportSize({width:1280,height:800});await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
    // The person tabs to Retry and presses Enter, the mouse resting on it. While the list is read the failure stays, Retry says it is
    // retrying, with the default arrow under the mouse rather than the hand it kept on 86c4fdb8, and keeps the keyboard; it fails
    // again: a new message says it still could not, and the keyboard is still on Retry.
    const message=await alert.locator("span").first().elementHandle(),lists=harness.control.lists;
    let release;harness.control.hold=new Promise(resolve=>{release=resolve});
    await retry.hover();expect(await retry.evaluate(node=>getComputedStyle(node).cursor),"Retry, which works").toBe("pointer");
    await retry.focus();await page.keyboard.press("Enter");
    const retrying=alert.getByRole("button",{name:"Retrying…",exact:true});
    await expect(retrying).toBeFocused();await expect(retrying).toHaveAttribute("aria-disabled","true");
    expect(await retrying.evaluate(node=>getComputedStyle(node).cursor),"Retrying… under the mouse").toBe("default");
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);
    await expect(alert).toHaveText(/^Could not load thread history: Deliberate thread list failure/);
    await expect(history.getByText("No thread history yet")).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"polish/history/history-load-retrying-dark-1280.png"});
    release();
    await expect(alert).toHaveText(/^Still could not load thread history: Deliberate thread list failure/);
    expect(await message.evaluate(node=>node.isConnected),"the message is a new one, so it is said again").toBe(false);
    await expect(retry).toBeFocused();
    await expect(history.getByText("No thread history yet")).toHaveCount(0);
    // The runtime answers now: Retry, with Enter, lists its thread.
    harness.control.listError=null;harness.control.listed=[runtimeThread];
    await page.keyboard.press("Enter");
    await expect(history.getByRole("button",{name:/Runtime retried/})).toBeVisible();
    await expect(history.getByRole("alert")).toHaveCount(0);
  }finally{await harness.close()}
});

// History fails, the person presses Retry and goes to Settings before it answers, then comes back to History: it starts over. It
// says it is loading, with no old failure and no Retrying they did not press on this visit, and a failure then is a first one again.
test("a Retry left before it answers starts History over when it is shown again",async({page})=>{
  test.setTimeout(45_000);
  const now=Date.now()/1000,runtimeThread={id:"runtime-later",name:"Runtime later",preview:"Runtime later preview",cwd:process.cwd(),model:"claude-test",runtime:"claude",status:{type:"idle"},createdAt:now-20,updatedAt:now-2,turns:[]};
  const harness=await startRuntimeHarness(runtimeThread);harness.control.listed=[];
  let settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const json=body=>({status:200,contentType:"application/json",body:JSON.stringify(body)});
  const releases=[];const holdNext=()=>{harness.control.hold=new Promise(resolve=>releases.push(resolve))};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill(json({mock:false,provider:"openai",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"history-retry-left-fixture",runtimeCapabilities:{},activeEnvironmentId:null,activeEnvironment:null})));
    await page.route(/\/api\/state$/,route=>route.fulfill(json({settings,projects:[],threadMeta:{}})));
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")settings={...settings,...route.request().postDataJSON()};return route.fulfill(json(settings))});
    await page.route(/\/api\/models$/,route=>route.fulfill(json({agentRuntime:"claude",ready:true,models:["claude-test"],metadata:{agentRuntime:"claude",models:[{id:"claude-test",name:"Claude Test",agent:"Claude Code"}]}})));
    await page.route(/\/api\/projects$/,route=>route.fulfill(json({projects:[]})));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill(json({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})));
    await page.route(/\/api\/recovery$/,route=>route.fulfill(json({enabled:false,items:[]})));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>route.fulfill(json(route.request().method()==="POST"?route.request().postDataJSON()?.patch||{}:{threadMeta:{},nextCursor:null})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(0);
    harness.control.listError="Deliberate thread list failure";
    const historyButton=page.getByRole("button",{name:"History",exact:true});
    await historyButton.click();
    const history=page.locator(".history-page"),alert=history.getByRole("alert");
    await expect(alert).toHaveText(/^Could not load thread history: Deliberate thread list failure/);
    // Retry, held, and Settings before it answers.
    let lists=harness.control.lists;holdNext();
    await alert.getByRole("button",{name:"Retry",exact:true}).click();
    await expect(alert.getByRole("button",{name:"Retrying…",exact:true})).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);
    await page.getByRole("button",{name:"Settings",exact:true}).click();await expect(page.getByRole("heading",{name:"Settings",level:1})).toBeVisible();
    // History again, its first page held: it says it is loading, and nothing of the visit before.
    lists=harness.control.lists;holdNext();
    await historyButton.click();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);
    await expect(history.getByText("Loading thread history…",{exact:true}),"History shown again says it is loading").toBeVisible();
    await expect(alert,"no failure from the visit before").toHaveCount(0);
    await expect(history.getByRole("button",{name:"Retrying…"}),"no Retrying the person did not press on this visit").toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"polish/history/history-retry-left-loading-dark-1280.png"});
    // That read fails too: the failure is a first one, not a second, with Retry ready.
    for(const release of releases.splice(0))release();
    await expect(alert).toHaveText(/^Could not load thread history: Deliberate thread list failure/);
    await expect(alert.getByRole("button",{name:"Retry",exact:true})).toBeVisible();
    // And Retry, answered now, lists the thread.
    harness.control.listError=null;harness.control.listed=[runtimeThread];
    await alert.getByRole("button",{name:"Retry",exact:true}).click();
    await expect(history.getByRole("button",{name:/Runtime later/})).toBeVisible();
    await expect(history.getByRole("alert")).toHaveCount(0);
  }finally{for(const release of releases.splice(0))release();await harness.close()}
});

// The runtime lists no threads when History first opens, and later six with a next page: History offers Load older threads for
// that page. An answer with no next page was taken for every page read, so Load older threads never came back that session and
// the older threads could not be reached until a reload. Once the older pages are read to their end, it stays away.
test("Load older threads comes back once the runtime lists a next page after an answer with none",async({page})=>{
  test.setTimeout(45_000);
  const now=Date.now()/1000,runtimeThread=(id,name,ago)=>({id,name,preview:name+" preview",cwd:process.cwd(),model:"claude-test",runtime:"claude",status:{type:"idle"},createdAt:now-ago-60,updatedAt:now-ago,turns:[]});
  const recent=Array.from({length:6},(_,index)=>runtimeThread("runtime-recent-"+index,"Recent thread "+(index+1),index*600)),older=Array.from({length:4},(_,index)=>runtimeThread("runtime-older-"+index,"Older thread "+(index+1),86400*3+index*600));
  const harness=await startRuntimeHarness(recent[0]);harness.control.listed=[];
  let settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const json=body=>({status:200,contentType:"application/json",body:JSON.stringify(body)});
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill(json({mock:false,provider:"openai",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"history-next-page-fixture",runtimeCapabilities:{},activeEnvironmentId:null,activeEnvironment:null})));
    await page.route(/\/api\/state$/,route=>route.fulfill(json({settings,projects:[],threadMeta:{}})));
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")settings={...settings,...route.request().postDataJSON()};return route.fulfill(json(settings))});
    await page.route(/\/api\/models$/,route=>route.fulfill(json({agentRuntime:"claude",ready:true,models:["claude-test"],metadata:{agentRuntime:"claude",models:[{id:"claude-test",name:"Claude Test",agent:"Claude Code"}]}})));
    await page.route(/\/api\/projects$/,route=>route.fulfill(json({projects:[]})));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill(json({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})));
    await page.route(/\/api\/recovery$/,route=>route.fulfill(json({enabled:false,items:[]})));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>route.fulfill(json(route.request().method()==="POST"?route.request().postDataJSON()?.patch||{}:{threadMeta:{},nextCursor:null})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(0);
    const historyButton=page.getByRole("button",{name:"History",exact:true}),newTask=page.getByRole("button",{name:"New task",exact:true});
    const history=page.locator(".history-page"),rows=history.locator(".history-thread-row"),load=history.getByRole("button",{name:"Load older threads"});
    let lists=harness.control.lists;
    await historyButton.click();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);
    await expect(history.getByText("No thread history yet",{exact:true})).toBeVisible();await expect(load).toHaveCount(0);
    // A new task, and the runtime now has six threads on its first page and four older ones behind its next page.
    await newTask.click();
    harness.control.listed=recent;harness.control.older=older;
    lists=harness.control.lists;
    await historyButton.click();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);
    await expect(rows).toHaveCount(6);
    await expect(load,"the runtime's answer has a next page").toBeVisible();
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});
      if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await load.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`polish/history/older-threads-after-empty-answer-${mode}-${width}.png`})}
    }
    await page.setViewportSize({width:1280,height:800});await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
    await load.click();
    await expect(rows).toHaveCount(10);await expect(history.getByRole("button",{name:/Older thread 4/})).toBeVisible();await expect(load).toHaveCount(0);
    // History again, with a thread started since: the first page still has its next page, and every page of it is listed already.
    await newTask.click();
    harness.control.listed=[runtimeThread("runtime-newest","Newest thread",0),...recent];
    lists=harness.control.lists;
    await historyButton.click();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);
    await expect(history.getByRole("button",{name:/Newest thread/})).toBeVisible();
    await expect(rows).toHaveCount(11);await expect(load).toHaveCount(0);
  }finally{await harness.close()}
});

// The app's requests around the runtime harness, routed as the tests above route them; the header's mode button saves the mode here,
// so the page keeps this fixture's settings.
async function routeRuntimeHistory(page,harness,version){
  let settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const json=body=>({status:200,contentType:"application/json",body:JSON.stringify(body)});
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill(json({mock:false,provider:"openai",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version,runtimeCapabilities:{},activeEnvironmentId:null,activeEnvironment:null})));
  await page.route(/\/api\/state$/,route=>route.fulfill(json({settings,projects:[],threadMeta:{}})));
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")settings={...settings,...route.request().postDataJSON()};return route.fulfill(json(settings))});
  await page.route(/\/api\/models$/,route=>route.fulfill(json({agentRuntime:"claude",ready:true,models:["claude-test"],metadata:{agentRuntime:"claude",models:[{id:"claude-test",name:"Claude Test",agent:"Claude Code"}]}})));
  await page.route(/\/api\/projects$/,route=>route.fulfill(json({projects:[]})));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill(json({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})));
  await page.route(/\/api\/recovery$/,route=>route.fulfill(json({enabled:false,items:[]})));
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>route.fulfill(json(route.request().method()==="POST"?route.request().postDataJSON()?.patch||{}:{threadMeta:{},nextCursor:null})));
}
// Shots of History in dark and light, at 1280 and 900, with shown in view; the page is left dark at 1280.
async function shootHistoryModes(page,shown,name){
  for(const mode of ["dark","light"]){
    await page.setViewportSize({width:1280,height:800});
    if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await shown.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`polish/history/${name}-${mode}-${width}.png`})}
  }
  await page.setViewportSize({width:1280,height:800});await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
}
const runtimeThreadAt=(now,id,name,ago)=>({id,name,preview:name+" preview",cwd:process.cwd(),model:"claude-test",runtime:"claude",status:{type:"idle"},createdAt:now-ago-60,updatedAt:now-ago,turns:[]});

// History shown again reads its newest threads again, which a slow runtime takes a while to answer. Load older threads is offered all
// the while and reads the older page when pressed; only while that page is read does it say it is loading and refuse a press. It said
// "Loading older threads…" through the whole re-read, and a click on it read nothing.
test("Load older threads reads the older page while History reads its newest threads again",async({page})=>{
  test.setTimeout(60_000);
  const now=Date.now()/1000,recent=Array.from({length:6},(_,index)=>runtimeThreadAt(now,"runtime-recent-"+index,"Recent thread "+(index+1),index*600)),older=Array.from({length:4},(_,index)=>runtimeThreadAt(now,"runtime-older-"+index,"Older thread "+(index+1),86400*3+index*600));
  const harness=await startRuntimeHarness(recent[0]);harness.control.listed=recent;harness.control.older=older;
  const releases=[];const holdNext=()=>{let release;harness.control.hold=new Promise(resolve=>{release=resolve});releases.push(release);return release};
  try{
    await routeRuntimeHistory(page,harness,"history-reread-older-fixture");
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(0);
    const historyButton=page.getByRole("button",{name:"History",exact:true}),newTask=page.getByRole("button",{name:"New task",exact:true});
    const history=page.locator(".history-page"),rows=history.locator(".history-thread-row"),load=history.getByRole("button",{name:"Load older threads"}),loading=history.getByRole("button",{name:"Loading older threads…"});
    const olderReads=()=>harness.control.cursors.filter(cursor=>cursor==="older-page").length;
    let lists=harness.control.lists;
    await historyButton.click();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);
    await expect(rows).toHaveCount(6);await expect(load).toBeVisible();
    // A new task, and History again: the runtime holds its answer for the newest threads. History starts that read after it shows,
    // so the person looks once two frames are painted, by when the page shows what the read set.
    await newTask.click();
    lists=harness.control.lists;const firstPage=holdNext();
    await historyButton.click();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(rows).toHaveCount(6);
    await expect(loading,"nothing says older threads are loading while the newest threads are read again").toHaveCount(0);
    await expect(load,"Load older threads is offered while the newest threads are read again").toBeVisible();
    await expect(load).not.toHaveAttribute("aria-disabled","true");
    await shootHistoryModes(page,load,"older-threads-offered-during-reread");
    // The person double-clicks it, and the runtime holds that page too: it says it is loading, keeps the keyboard and refuses a press.
    const olderPage=holdNext();
    await load.dblclick();
    await expect(loading).toBeFocused();await expect(loading).toHaveAttribute("aria-disabled","true");
    await expect.poll(olderReads).toBe(1);
    await page.screenshot({animations:"disabled",path:auditDir+"polish/history/older-threads-loading-during-reread-dark-1280.png"});
    await page.keyboard.press("Enter");
    // The older page comes in while the newest threads are still read: four rows more, and no next page.
    olderPage();
    await expect(history.getByRole("button",{name:/Older thread 4/})).toBeVisible();await expect(rows).toHaveCount(10);
    await expect(load).toHaveCount(0);await expect(loading).toHaveCount(0);
    expect(olderReads(),"the second click and the Enter while it loaded read nothing more").toBe(1);
    // The newest threads answer, with one started since: it is listed, and every page is read.
    harness.control.listed=[runtimeThreadAt(now,"runtime-newest","Newest thread",0),...recent];
    firstPage();
    await expect(history.getByRole("button",{name:/Newest thread/})).toBeVisible();await expect(rows).toHaveCount(11);
    await expect(load).toHaveCount(0);
    expect(olderReads()).toBe(1);
  }finally{for(const release of releases.splice(0))release();await harness.close()}
});

// Older pages read before History was left stay read when it is shown again: the next Load older threads reads the page after them.
// The first page read again took History back to its own next page, the one already shown, so the next press read that page again
// and added nothing, and only a second press reached the older threads.
test("Load older threads goes on from the pages already shown when History is shown again",async({page})=>{
  test.setTimeout(60_000);
  const now=Date.now()/1000,recent=Array.from({length:6},(_,index)=>runtimeThreadAt(now,"runtime-recent-"+index,"Recent thread "+(index+1),index*600));
  const older=Array.from({length:4},(_,index)=>runtimeThreadAt(now,"runtime-older-"+index,"Older thread "+(index+1),86400*3+index*600)),oldest=Array.from({length:3},(_,index)=>runtimeThreadAt(now,"runtime-oldest-"+index,"Oldest thread "+(index+1),86400*9+index*600));
  const harness=await startRuntimeHarness(recent[0]);harness.control.listed=recent;harness.control.older=older;harness.control.oldest=oldest;
  try{
    await routeRuntimeHistory(page,harness,"history-return-older-fixture");
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(0);
    const historyButton=page.getByRole("button",{name:"History",exact:true}),newTask=page.getByRole("button",{name:"New task",exact:true});
    const history=page.locator(".history-page"),rows=history.locator(".history-thread-row"),load=history.getByRole("button",{name:"Load older threads"});
    let lists=harness.control.lists;
    await historyButton.click();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);
    await expect(rows).toHaveCount(6);
    await load.click();
    await expect(history.getByRole("button",{name:/Older thread 4/})).toBeVisible();await expect(rows).toHaveCount(10);
    await expect(load,"a page of older threads is left").toBeVisible();
    // A new task, and History again: the runtime's newest threads now start with it.
    await newTask.click();
    harness.control.listed=[runtimeThreadAt(now,"runtime-newest","Newest thread",0),...recent];
    lists=harness.control.lists;
    await historyButton.click();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);
    await expect(history.getByRole("button",{name:/Newest thread/})).toBeVisible();await expect(rows).toHaveCount(11);
    await expect(load).toBeVisible();
    // The person has tabbed to Load older threads and presses Enter: the oldest page comes in at once, and there is none after it.
    const read=harness.control.cursors.length;
    await load.focus();await page.keyboard.press("Enter");
    await expect(rows,"the press adds the page after the ones shown").toHaveCount(14);
    await expect(history.getByRole("button",{name:/Oldest thread 3/})).toBeVisible();await expect(load).toHaveCount(0);
    expect(harness.control.cursors.slice(read),"the press read the page after the ones shown, once").toEqual(["oldest-page"]);
    await shootHistoryModes(page,history.getByRole("button",{name:/Oldest thread 3/}),"older-threads-after-return");
  }finally{await harness.close()}
});

// History's next page belongs to the environment it was read in. After a project opened in another environment, whose runtime then
// answers History, Load older threads reads that runtime's own next page. Every environment's Codex has the one address, so the next
// page kept from the environment left went to the other runtime, which refused it or read from wherever it fell in its own list, and
// that runtime's older threads were never listed.
test("Load older threads after a project opened in another environment reads that environment's own next page",async({page})=>{
  test.setTimeout(60_000);
  const now=Date.now()/1000,threads=(id,name,count,from)=>Array.from({length:count},(_,index)=>runtimeThreadAt(now,id+"-"+index,name+" "+(index+1),from+index*600));
  const pages={
    local:{first:{data:threads("local-recent","Local thread",6,0),nextCursor:"local-2"},"local-2":{data:threads("local-older","Local older thread",4,86400*3),nextCursor:"local-3"},"local-3":{data:threads("local-oldest","Local oldest thread",3,86400*9),nextCursor:null}},
    remote:{first:{data:threads("remote-recent","Remote thread",5,300),nextCursor:"remote-2"},"remote-2":{data:threads("remote-older","Remote older thread",3,86400*4),nextCursor:null}},
  };
  let environment="local";
  const harness=await startRuntimeHarness(pages.local.first.data[0]);harness.control.pages=cursor=>pages[environment][cursor||"first"]||{error:"No thread list page at "+cursor};
  try{
    await routeRuntimeHistory(page,harness,"history-environment-switch-fixture");
    // A project in another environment, and the switch to that environment, as the GUI server answers them.
    const project={id:"remote-project",name:"Remote repo",path:"/srv/remote-repo",environmentId:"build-box",effectiveSettings:{}},json=body=>({status:200,contentType:"application/json",body:JSON.stringify(body)});
    let settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",activeEnvironmentId:null};
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill(json({mock:false,provider:"openai",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"history-environment-switch-fixture",runtimeCapabilities:{},activeEnvironmentId:settings.activeEnvironmentId,activeEnvironment:null})));
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")settings={...settings,...route.request().postDataJSON()};return route.fulfill(json(settings))});
    await page.route(/\/api\/projects$/,route=>route.fulfill(json(route.request().method()==="POST"?{project}:{projects:[project]})));
    await page.route(/\/api\/environments$/,route=>route.fulfill(json({profiles:[{id:"build-box",name:"Build box",type:"ssh",enabled:true}],activeEnvironmentId:settings.activeEnvironmentId})));
    await page.route(/\/api\/environment\/activate$/,route=>{environment="remote";settings={...settings,activeEnvironmentId:"build-box"};return route.fulfill(json({ok:true,activeEnvironmentId:"build-box",agentRuntime:"claude",agentRuntimeReady:true}))});
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill(json({isGit:false,root:project.path,branch:null,status:[],remotes:[],worktrees:[]})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(0);
    const historyButton=page.getByRole("button",{name:"History",exact:true}),newTask=page.getByRole("button",{name:"New task",exact:true});
    const history=page.locator(".history-page"),load=history.getByRole("button",{name:"Load older threads"}),failure=history.getByRole("alert");
    // On this machine: History, and Load older threads once, which leaves a page.
    await historyButton.click();await expect(history.getByRole("button",{name:/Local thread 6/})).toBeVisible();
    await load.click();await expect(history.getByRole("button",{name:/Local older thread 4/})).toBeVisible();await expect(load).toBeVisible();
    // A new task, and the remote project opened from the palette: its environment's runtime answers from then on.
    await newTask.click();
    await page.keyboard.press("Control+K");const palette=page.getByTestId("command-palette");await expect(palette).toBeVisible();
    await palette.getByRole("textbox").fill("Remote repo");await palette.locator(".command-palette-item").filter({hasText:"Remote repo"}).click();
    await expect.poll(()=>environment).toBe("remote");await expect(palette).toHaveCount(0);
    // History again: the remote runtime's newest threads, and Load older threads reads the remote's next page.
    const read=harness.control.cursors.length;
    await historyButton.click();await expect(history.getByRole("button",{name:/Remote thread 5/})).toBeVisible();
    await expect(load).toBeVisible();await load.click();
    await expect(history.getByRole("button",{name:/Remote older thread 3/}),"the remote runtime's older threads").toBeVisible();
    await expect(failure).toHaveCount(0);await expect(load).toHaveCount(0);
    expect(harness.control.cursors.slice(read).filter(Boolean),"the next pages asked of the remote runtime").toEqual(["remote-2"]);
    await shootHistoryModes(page,history.getByRole("button",{name:/Remote older thread 3/}),"older-threads-after-environment-switch");
  }finally{await harness.close()}
});

// Each environment's pages of History stay read while another's are read: back in an environment, Load older threads reads the page
// after the ones of it shown, and one read to its end offers no more. Only the last environment's next page was kept, so back on this
// machine the first page read again took History to its own next page, shown already, and the first press read it again and added
// nothing.
test("Load older threads back in an environment left reads the page after the ones of it shown",async({page})=>{
  test.setTimeout(90_000);
  const now=Date.now()/1000,threads=(id,name,count,from)=>Array.from({length:count},(_,index)=>runtimeThreadAt(now,id+"-"+index,name+" "+(index+1),from+index*600));
  const pages={
    local:{first:{data:threads("local-recent","Local thread",6,0),nextCursor:"local-2"},"local-2":{data:threads("local-older","Local older thread",4,86400*3),nextCursor:"local-3"},"local-3":{data:threads("local-oldest","Local oldest thread",3,86400*9),nextCursor:null}},
    remote:{first:{data:threads("remote-recent","Remote thread",5,300),nextCursor:"remote-2"},"remote-2":{data:threads("remote-older","Remote older thread",3,86400*4),nextCursor:null}},
  };
  let environment="local";
  const harness=await startRuntimeHarness(pages.local.first.data[0]);harness.control.pages=cursor=>pages[environment][cursor||"first"]||{error:"No thread list page at "+cursor};
  try{
    await routeRuntimeHistory(page,harness,"history-environment-return-fixture");
    // A project on this machine and one in another environment, and the switches between them, as the GUI server answers them.
    const projects=[{id:"local-project",name:"Local repo",path:process.cwd(),environmentId:null,effectiveSettings:{}},{id:"remote-project",name:"Remote repo",path:"/srv/remote-repo",environmentId:"build-box",effectiveSettings:{}}],json=body=>({status:200,contentType:"application/json",body:JSON.stringify(body)});
    let settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",activeEnvironmentId:null};
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill(json({mock:false,provider:"openai",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"history-environment-return-fixture",runtimeCapabilities:{},activeEnvironmentId:settings.activeEnvironmentId,activeEnvironment:null})));
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")settings={...settings,...route.request().postDataJSON()};return route.fulfill(json(settings))});
    await page.route(/\/api\/projects$/,route=>route.fulfill(json(route.request().method()==="POST"?{project:projects.find(project=>project.path===route.request().postDataJSON()?.path)}:{projects})));
    await page.route(/\/api\/environments$/,route=>route.fulfill(json({profiles:[{id:"build-box",name:"Build box",type:"ssh",enabled:true}],activeEnvironmentId:settings.activeEnvironmentId})));
    await page.route(/\/api\/environment\/activate$/,route=>{const id=route.request().postDataJSON()?.id||null;environment=id?"remote":"local";settings={...settings,activeEnvironmentId:id};return route.fulfill(json({ok:true,activeEnvironmentId:id,agentRuntime:"claude",agentRuntimeReady:true}))});
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill(json({isGit:false,root:null,branch:null,status:[],remotes:[],worktrees:[]})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(0);
    const historyButton=page.getByRole("button",{name:"History",exact:true}),projectsButton=page.getByRole("button",{name:"Projects",exact:true}),openCard=name=>page.locator(".project-card").filter({hasText:name}).locator(".project-open");
    const history=page.locator(".history-page"),rows=history.locator(".history-thread-row"),load=history.getByRole("button",{name:"Load older threads"}),failure=history.getByRole("alert");
    // On this machine: History, and Load older threads once, which leaves a page.
    await historyButton.click();await expect(rows).toHaveCount(6);
    await load.click();await expect(history.getByRole("button",{name:/Local older thread 4/})).toBeVisible();await expect(rows).toHaveCount(10);await expect(load).toBeVisible();
    // From History, the remote project opened from the palette with the keys, so History is shown while the transport reconnects.
    await page.keyboard.press("Control+K");const palette=page.getByTestId("command-palette");await expect(palette).toBeVisible();
    await page.keyboard.type("Remote repo");await expect(palette.locator(".command-palette-item").filter({hasText:"Remote repo"})).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(()=>environment).toBe("remote");await expect(palette).toHaveCount(0);
    // History there: the remote runtime's newest threads, and Load older threads reads its next page, its last.
    await historyButton.click();await expect(history.getByRole("button",{name:/Remote thread 5/})).toBeVisible();
    await load.click();await expect(history.getByRole("button",{name:/Remote older thread 3/})).toBeVisible();await expect(rows).toHaveCount(18);await expect(load).toHaveCount(0);
    // Back on this machine, from its card in Projects; History reads its newest threads again, and one press reads the page after
    // the two of its pages shown.
    await projectsButton.click();await openCard("Local repo").click();
    await expect.poll(()=>environment).toBe("local");await expect(page.getByTestId("composer")).toBeVisible();
    let lists=harness.control.lists;
    await historyButton.click();await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);
    await expect(rows).toHaveCount(18);
    const read=harness.control.cursors.length;
    await load.click();
    await expect.soft(rows,"the press adds the page after the ones shown").toHaveCount(21);
    expect(harness.control.cursors.slice(read).filter(Boolean),"the next pages the press read").toEqual(["local-3"]);
    await expect(history.getByRole("button",{name:/Local oldest thread 3/})).toBeVisible();await expect(failure).toHaveCount(0);await expect(load).toHaveCount(0);
    await shootHistoryModes(page,history.getByRole("button",{name:/Local oldest thread 3/}),"older-threads-after-environment-return");
    // Back in the remote environment, whose pages are read to their end: once History has its newest threads again (with one started
    // since, which only that read lists), it offers no Load older threads. History is shown once the project has opened (the composer
    // shows): the open's last requests can come after the new transport has listed the threads, and the open ends on the thread view,
    // which would take History away again.
    lists=harness.control.lists;
    await projectsButton.click();await openCard("Remote repo").click();
    await expect.poll(()=>environment).toBe("remote");await expect.poll(()=>harness.control.lists,{message:"the new transport lists the threads"}).toBeGreaterThan(lists);
    await expect(page.getByTestId("composer")).toBeVisible();
    pages.remote.first={...pages.remote.first,data:[runtimeThreadAt(now,"remote-newest","Newest remote thread",-60),...pages.remote.first.data]};
    await historyButton.click();await expect(history.getByRole("button",{name:/Newest remote thread/})).toBeVisible();
    await expect(rows).toHaveCount(22);await expect(load).toHaveCount(0);await expect(failure).toHaveCount(0);
  }finally{await harness.close()}
});

// A press of Load older threads while the transport is not connected asks the runtime for nothing, so it reads no page and marks none
// read. On History, a project opened in another environment from the palette closes the transport an older read went on: as its
// socket closes, that read fails and puts Load older threads back, while the palette stays open over History as the project opens
// (Escape closes it). A press there, before the new transport connected, counted as a page read with none after it: the environment
// switched to was marked as read to its end, and its History offered no Load older threads again until a reload.
test("Load older threads pressed while the transport of an environment switched to connects reads nothing and marks no page of it read",async({page})=>{
  test.setTimeout(90_000);
  const now=Date.now()/1000,threads=(id,name,count,from)=>Array.from({length:count},(_,index)=>runtimeThreadAt(now,id+"-"+index,name+" "+(index+1),from+index*600));
  const pages={
    local:{first:{data:threads("local-recent","Local thread",6,0),nextCursor:"local-2"},"local-2":{data:threads("local-older","Local older thread",4,86400*3),nextCursor:null}},
    remote:{first:{data:threads("remote-recent","Remote thread",5,300),nextCursor:"remote-2"},"remote-2":{data:threads("remote-older","Remote older thread",3,86400*4),nextCursor:null}},
  };
  let environment="local";
  const gate=()=>{let open=()=>{};const promise=new Promise(resolve=>{open=resolve});return {promise,open}};
  const olderHeld=gate(),connectHeld=gate(),saveHeld=gate();
  const harness=await startRuntimeHarness(pages.local.first.data[0]);harness.control.pages=cursor=>pages[environment][cursor||"first"]||{error:"No thread list page at "+cursor};
  try{
    await routeRuntimeHistory(page,harness,"history-press-while-connecting-fixture");
    // A project in another environment, and the switch to it, as the GUI server answers them; the new transport's initialize waits
    // (connectHeld), and so does the project's save (saveHeld), so the open runs on with the palette over History.
    const project={id:"remote-project",name:"Remote repo",path:"/srv/remote-repo",environmentId:"build-box",effectiveSettings:{}},json=body=>({status:200,contentType:"application/json",body:JSON.stringify(body)});
    let settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",activeEnvironmentId:null};
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill(json({mock:false,provider:"openai",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"history-press-while-connecting-fixture",runtimeCapabilities:{},activeEnvironmentId:settings.activeEnvironmentId,activeEnvironment:null})));
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")settings={...settings,...route.request().postDataJSON()};return route.fulfill(json(settings))});
    await page.route(/\/api\/projects$/,async route=>{if(route.request().method()!=="POST")return route.fulfill(json({projects:[project]}));await saveHeld.promise;return route.fulfill(json({project}))});
    await page.route(/\/api\/environments$/,route=>route.fulfill(json({profiles:[{id:"build-box",name:"Build box",type:"ssh",enabled:true}],activeEnvironmentId:settings.activeEnvironmentId})));
    await page.route(/\/api\/environment\/activate$/,route=>{environment="remote";settings={...settings,activeEnvironmentId:"build-box"};harness.control.holdInitialize=connectHeld.promise;return route.fulfill(json({ok:true,activeEnvironmentId:"build-box",agentRuntime:"claude",agentRuntimeReady:true}))});
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill(json({isGit:false,root:project.path,branch:null,status:[],remotes:[],worktrees:[]})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(0);
    const historyButton=page.getByRole("button",{name:"History",exact:true}),palette=page.getByTestId("command-palette");
    const history=page.locator(".history-page"),rows=history.locator(".history-thread-row"),load=history.getByRole("button",{name:"Load older threads"}),failure=history.getByRole("alert");
    const loadOrLoading=history.getByRole("button",{name:/^Load(ing)? older threads/}),asked=()=>harness.control.cursors.filter(Boolean);
    // On this machine: History, and Load older threads, whose page the runtime holds.
    await historyButton.click();await expect(rows).toHaveCount(6);await expect(load).toBeVisible();
    harness.control.hold=olderHeld.promise;
    await load.click();await expect.poll(asked).toEqual(["local-2"]);
    // From History, the remote project opened from the palette with the keys. Its transport closes, and History, waiting for the new
    // one, drops the next page; then the socket's close goes through, which fails the read and puts its button back.
    harness.pause();
    await page.keyboard.press("Control+K");await expect(palette).toBeVisible();
    await page.keyboard.type("Remote repo");await expect(palette.locator(".command-palette-item").filter({hasText:"Remote repo"})).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(()=>environment).toBe("remote");await expect(loadOrLoading).toHaveCount(0);
    harness.resume();
    await expect(failure).toHaveText("Could not load older threads: runtime history: Claude Code disconnected");await expect(load).toBeVisible();
    await page.keyboard.press("Escape");await expect(palette).toHaveCount(0);
    // A press there while the new transport connects: the runtime is asked for nothing, the press says why, and the button stays.
    await load.click();
    await expect.soft(failure,"the press says why it read nothing").toHaveText("Could not load older threads: runtime history: Claude Code is not connected");
    await expect.soft(load,"the press leaves Load older threads").toBeVisible();
    expect.soft(asked(),"the press asks the runtime for nothing").toEqual(["local-2"]);
    await shootHistoryModes(page,rows.last(),"older-threads-pressed-while-connecting");
    // The new transport connects: History lists the remote runtime's newest threads and offers its older ones, which a press reads.
    connectHeld.open();
    await expect(history.getByRole("button",{name:/Remote thread 5/})).toBeVisible();await expect(failure).toHaveCount(0);
    await expect(load,"the environment switched to offers its older threads").toBeVisible();
    await load.click();
    await expect(history.getByRole("button",{name:/Remote older thread 3/})).toBeVisible();await expect(failure).toHaveCount(0);await expect(load).toHaveCount(0);
    expect(asked(),"the next pages asked for").toEqual(["local-2","remote-2"]);
    // The project's save answers, and the open ends on the thread view.
    saveHeld.open();await expect(page.getByTestId("composer")).toBeVisible();
  }finally{olderHeld.open();connectHeld.open();saveHeld.open();await harness.close()}
});

// A next page the runtime refuses (the thread it starts from was archived since) gives way to the first page's own next page once
// History is shown again, so Load older threads reads the older threads again from there. The page refused stayed kept, and every
// press said again that it could not load older threads, until a reload.
test("Load older threads works again after History is shown again once the runtime refused its next page",async({page})=>{
  test.setTimeout(60_000);
  const now=Date.now()/1000,recent=Array.from({length:6},(_,index)=>runtimeThreadAt(now,"runtime-recent-"+index,"Recent thread "+(index+1),index*600));
  const older=Array.from({length:4},(_,index)=>runtimeThreadAt(now,"runtime-older-"+index,"Older thread "+(index+1),86400*3+index*600)),oldest=Array.from({length:3},(_,index)=>runtimeThreadAt(now,"runtime-oldest-"+index,"Oldest thread "+(index+1),86400*9+index*600));
  // The cursor of the oldest page names the thread it starts from: archived elsewhere, that thread takes its cursor with it. newest:
  // threads started since, first on the newest page.
  let oldestCursor="oldest-page",newest=[];
  const harness=await startRuntimeHarness(recent[0]);
  harness.control.pages=cursor=>!cursor?{data:[...newest,...recent],nextCursor:"older-page"}:cursor==="older-page"?{data:older,nextCursor:oldestCursor}:cursor===oldestCursor?{data:oldest,nextCursor:null}:{error:"Thread list cursor no longer exists"};
  try{
    await routeRuntimeHistory(page,harness,"history-refused-cursor-fixture");
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(0);
    const historyButton=page.getByRole("button",{name:"History",exact:true}),newTask=page.getByRole("button",{name:"New task",exact:true});
    const history=page.locator(".history-page"),rows=history.locator(".history-thread-row"),load=history.getByRole("button",{name:"Load older threads"}),failure=history.getByRole("alert");
    let lists=harness.control.lists;
    await historyButton.click();await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);await expect(rows).toHaveCount(6);
    await load.click();await expect(rows).toHaveCount(10);await expect(load).toBeVisible();
    // The thread the next page starts from is archived elsewhere: the press is refused, and says so.
    oldestCursor="oldest-page-2";
    await load.click();
    await expect(failure).toHaveText("Could not load older threads: runtime history: Thread list cursor no longer exists");
    // Leaving History and showing it again (a thread started meanwhile, which its newest page lists, says that page has answered), the
    // next press reads the first page's own next page, and the one after it is good.
    await newTask.click();lists=harness.control.lists;newest=[runtimeThreadAt(now,"runtime-newest","Newest thread",-60)];
    await historyButton.click();await expect.poll(()=>harness.control.lists).toBeGreaterThan(lists);
    await expect(history.getByRole("button",{name:/Newest thread/})).toBeVisible();await expect(rows).toHaveCount(11);
    const read=harness.control.cursors.length;
    await load.focus();await page.keyboard.press("Enter");
    const pagesRead=()=>harness.control.cursors.slice(read).filter(Boolean);
    await expect.poll(pagesRead,{message:"the next page the press after History was shown again read"}).toEqual(["older-page"]);
    await expect(failure).toHaveCount(0);await expect(load).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(history.getByRole("button",{name:/Oldest thread 3/})).toBeVisible();await expect(rows).toHaveCount(14);await expect(load).toHaveCount(0);
    expect(pagesRead()).toEqual(["older-page","oldest-page-2"]);
    await shootHistoryModes(page,history.getByRole("button",{name:/Oldest thread 3/}),"older-threads-after-refused-page");
  }finally{await harness.close()}
});

// Two frames painted, about the time a held key takes to repeat.
const frames=page=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));

// The person tabs to Load older threads and holds Enter a moment. The button keeps the keyboard and says Load older threads again once
// its page is in, so each repeat of the key after that read the next page: one held press read every page there was. It reads one,
// and the keyboard stays on the button for the next. A double click's second click, which comes once the first click's page is in,
// on a row that page put under the pointer, opens nothing and reads nothing; a press of its own reads the page after.
test("Enter held on Load older threads, or a double click on it, reads one older page",async({page})=>{
  test.setTimeout(60_000);
  const now=Date.now()/1000,threads=(id,name,count,from)=>Array.from({length:count},(_,index)=>runtimeThreadAt(now,id+"-"+index,name+" "+(index+1),from+index*600));
  const pages={first:{data:threads("recent","Recent thread",6,0),nextCursor:"page-2"},"page-2":{data:threads("older","Older thread",4,86400*3),nextCursor:"page-3"},"page-3":{data:threads("oldest","Oldest thread",3,86400*9),nextCursor:"page-4"},"page-4":{data:threads("eldest","Eldest thread",2,86400*20),nextCursor:null}};
  const harness=await startRuntimeHarness(pages.first.data[0]);harness.control.pages=cursor=>pages[cursor||"first"]||{error:"No thread list page at "+cursor};
  try{
    await routeRuntimeHistory(page,harness,"history-held-older-fixture");
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(0);
    const history=page.locator(".history-page"),rows=history.locator(".history-thread-row"),load=history.getByRole("button",{name:"Load older threads"}),loading=history.getByRole("button",{name:"Loading older threads…"});
    const asked=()=>harness.control.cursors.filter(Boolean);
    await page.getByRole("button",{name:"History",exact:true}).click();await expect(rows).toHaveCount(6);
    // Enter goes down on the button and stays down: its page comes in, and the key goes on repeating on the button.
    await load.focus();await page.keyboard.down("Enter");
    await expect(rows).toHaveCount(10);await expect(load).toBeFocused();
    for(let repeat=0;repeat<6;repeat++){await page.keyboard.down("Enter");await frames(page)}
    await page.keyboard.up("Enter");
    await expect(loading,"no older page is being read").toHaveCount(0);
    expect(asked(),"one held press reads one older page").toEqual(["page-2"]);
    await expect(rows).toHaveCount(10);await expect(load,"the keyboard stays on Load older threads").toBeFocused();
    await shootHistoryModes(page,load,"older-threads-held-enter");
    // A double click: its second click comes once the first click's page is in.
    await load.scrollIntoViewIfNeeded();
    const box=await load.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.down();await page.mouse.up();
    await expect(rows).toHaveCount(13);await expect(load).toBeFocused();
    await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});
    await frames(page);await expect(loading).toHaveCount(0);
    expect(asked(),"a double click reads one older page").toEqual(["page-2","page-3"]);
    await expect(history,"the second click opens no thread").toBeVisible();await expect(rows).toHaveCount(13);await expect(load).toBeFocused();
    // A press of its own reads the page after, the last one.
    await page.keyboard.press("Enter");
    await expect(history.getByRole("button",{name:/Eldest thread 2/})).toBeVisible();await expect(rows).toHaveCount(15);await expect(load).toHaveCount(0);
    expect(asked()).toEqual(["page-2","page-3","page-4"]);
  }finally{await harness.close()}
});

// The person tabs to History's Retry and holds Enter a moment while the runtime still fails at once. Retry refused a press only while
// its read ran, so each repeat of the key after a failure asked again, and each failure said it still could not as a new message, read
// out again. The press asks once and says so once; a double click's second click, which comes once the first click's read has failed,
// asks nothing either; a press of its own asks again, and lists the thread once the runtime answers.
test("Enter held on History's Retry, or a double click on it, asks the runtime again once",async({page})=>{
  test.setTimeout(60_000);
  const now=Date.now()/1000,runtimeThread=runtimeThreadAt(now,"runtime-held-retry","Runtime held retry",2);
  const harness=await startRuntimeHarness(runtimeThread);harness.control.listed=[];
  try{
    await routeRuntimeHistory(page,harness,"history-held-retry-fixture");
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(0);
    harness.control.listError="Deliberate thread list failure";
    await page.getByRole("button",{name:"History",exact:true}).click();
    const history=page.locator(".history-page"),alert=history.getByRole("alert"),retry=alert.getByRole("button",{name:"Retry",exact:true}),retrying=alert.getByRole("button",{name:"Retrying…",exact:true});
    await expect(alert).toHaveText(/^Could not load thread history: Deliberate thread list failure/);
    // Enter goes down on Retry and stays down: the runtime fails again, and the key goes on repeating on Retry.
    let lists=harness.control.lists;
    await retry.focus();await page.keyboard.down("Enter");
    await expect(alert).toHaveText(/^Still could not load thread history: Deliberate thread list failure/);await expect(retry).toBeFocused();
    const said=await alert.locator("span").first().elementHandle();
    for(let repeat=0;repeat<6;repeat++){await page.keyboard.down("Enter");await frames(page)}
    await page.keyboard.up("Enter");
    await expect(retrying,"no read is running").toHaveCount(0);
    expect(harness.control.lists-lists,"one held press asks the runtime once").toBe(1);
    expect(await said.evaluate(node=>node.isConnected),"its failure is said once").toBe(true);
    await expect(retry).toBeFocused();
    await shootHistoryModes(page,alert,"history-retry-held-enter");
    // A double click: its second click comes once the first click's read has failed.
    lists=harness.control.lists;
    const box=await retry.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.down();await page.mouse.up();
    await expect.poll(()=>said.evaluate(node=>node.isConnected),{message:"the first click's failure is said"}).toBe(false);
    await expect(retry).toBeFocused();
    await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});
    await frames(page);await expect(retrying).toHaveCount(0);
    expect(harness.control.lists-lists,"a double click asks the runtime once").toBe(1);
    // A press of its own, the runtime answering now, lists the thread.
    harness.control.listError=null;harness.control.listed=[runtimeThread];
    await page.keyboard.press("Enter");
    await expect(history.getByRole("button",{name:/Runtime held retry/})).toBeVisible();
    await expect(history.getByRole("alert")).toHaveCount(0);
  }finally{await harness.close()}
});

// History has listed six threads, with older ones to load, and a later read of its first page fails: the failure is said in a band
// above the threads it keeps, which stands 12 px clear of them, as Load older threads stands below them, in dark and light, wide and
// narrow, and still after a Retry from the keyboard that fails again. On 86c4fdb8 the band sat flush on the list, its rounded corners
// on the list's.
test("History's first-page failure stands 12 px clear of the threads it keeps below it, as Load older threads does",async({page})=>{
  test.setTimeout(60_000);
  const now=Date.now()/1000,threads=(id,name,count,from)=>Array.from({length:count},(_,index)=>runtimeThreadAt(now,id+"-"+index,name+" "+(index+1),from+index*600));
  const listed=threads("recent","Recent thread",6,0),harness=await startRuntimeHarness(listed[0]);
  harness.control.listed=listed;harness.control.older=threads("older","Older thread",4,86400*3);
  try{
    await routeRuntimeHistory(page,harness,"history-kept-threads-failure-fixture");
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await expect.poll(()=>harness.control.lists).toBeGreaterThan(0);
    const history=page.locator(".history-page"),rows=history.locator(".history-thread-row"),alert=history.getByRole("alert"),load=history.getByRole("button",{name:"Load older threads",exact:true});
    const historyButton=page.getByRole("button",{name:"History",exact:true});
    await historyButton.click();await expect(rows).toHaveCount(6);await expect(load).toBeVisible();
    // Settings, then History again, whose first page the runtime now fails to list: the six threads stay, below the failure.
    harness.control.listError="Deliberate thread list failure";
    await page.getByRole("button",{name:"Settings",exact:true}).click();await expect(page.getByRole("heading",{name:"Settings",level:1})).toBeVisible();
    await historyButton.click();
    await expect(alert).toHaveText(/^Could not load thread history: Deliberate thread list failure/);
    await expect(rows).toHaveCount(6);await expect(load).toBeVisible();
    // The space from the band down to the first thread, and from the last thread down to Load older threads.
    const gaps=()=>history.evaluate(node=>{
      const box=selector=>node.querySelector(selector).getBoundingClientRect(),listed=[...node.querySelectorAll(":scope>.history-thread-row")];
      return {band:Math.round(listed[0].getBoundingClientRect().top-box(":scope>.history-load-error").bottom),load:Math.round(box(":scope>.history-load-more").top-listed.at(-1).getBoundingClientRect().bottom)};
    });
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});
      if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      for(const width of [1280,700]){
        await page.setViewportSize({width,height:800});
        expect(await gaps(),`${mode} ${width}`).toEqual({band:12,load:12});
        await page.screenshot({animations:"disabled",path:auditDir+`polish/history/history-failed-above-kept-threads-${mode}-${width}.png`});
      }
    }
    await page.setViewportSize({width:1280,height:800});await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
    // Retry, pressed from the keyboard, fails again: the band says it still could not, as clear of the threads.
    await alert.getByRole("button",{name:"Retry",exact:true}).focus();await page.keyboard.press("Enter");
    await expect(alert).toHaveText(/^Still could not load thread history: Deliberate thread list failure/);
    await expect(rows).toHaveCount(6);
    expect(await gaps(),"after a Retry that failed again").toEqual({band:12,load:12});
  }finally{await harness.close()}
});
