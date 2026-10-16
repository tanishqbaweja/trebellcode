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
// control.listed is what thread/list answers, control.listError, when set, fails it, and control.hold, when set, holds the next one
// until it resolves; control.lists counts the lists asked for.
async function startRuntimeHarness(thread){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),control={listed:[thread],listError:null,hold:null,lists:0};
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",async raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
    let result={};
    if(message.method==="thread/list"){control.lists++;if(control.hold){const held=control.hold;control.hold=null;await held}}
    if(message.method==="thread/list"&&control.listError)return ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:control.listError}}));
    if(message.method==="initialize")result={userAgent:"catalog-pagination-connected-fixture"};
    else if(message.method==="thread/list")result={data:control.listed,nextCursor:null};
    else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
    ws.send(JSON.stringify({id:message.id,result}));
  }));
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {control,wsUrl:"ws://127.0.0.1:"+port+"/rpc",async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
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
    // The person tabs to Retry and presses Enter. While the list is read the failure stays, Retry says it is retrying and keeps the
    // keyboard; it fails again: a new message says it still could not, and the keyboard is still on Retry.
    const message=await alert.locator("span").first().elementHandle(),lists=harness.control.lists;
    let release;harness.control.hold=new Promise(resolve=>{release=resolve});
    await retry.focus();await page.keyboard.press("Enter");
    const retrying=alert.getByRole("button",{name:"Retrying…",exact:true});
    await expect(retrying).toBeFocused();await expect(retrying).toHaveAttribute("aria-disabled","true");
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
