import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

// A Codex-protocol harness whose transport can drop and refuse new connections for a while, like an app-server restart, or whose
// server answers initialize with why it cannot reach the harness (refuse). dropAt(method) closes the connection when a request of
// that method comes, unanswered.
async function startHarness(){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set(),requests=[];let accepting=true,connections=0,refusal=null,dropMethod=null;
  http.on("upgrade",(req,socket,head)=>{if(!accepting){socket.destroy();return}wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req))});
  wss.on("connection",ws=>{
    connections++;sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);
      if(message.method===dropMethod){ws.close();return}
      if(message.method==="initialize"&&refusal){ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:refusal}}));return}
      let result={};
      if(message.method==="initialize")result={userAgent:"harness-reconnect-fixture"};
      else if(message.method==="thread/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/start")result={thread:{id:"reconnect-thread",name:"Reconnect fixture",cwd:process.cwd(),createdAt:Date.now()/1000,updatedAt:Date.now()/1000,turns:[]}};
      else if(message.method==="turn/start")result={turn:{id:"reconnect-turn",status:"inProgress",items:[]}};
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+port,requests,connections:()=>connections,
    drop(){accepting=false;for(const ws of sockets)ws.terminate()},
    accept(){accepting=true},
    refuse(message){refusal=message},
    allow(){refusal=null},
    dropAt(method){dropMethod=method},
    async close(){accepting=false;for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
}

test("a send while the harness transport is down keeps the draft, never falls back to the Native provider and works once reconnected",async({page})=>{
  test.setTimeout(45_000);
  const harness=await startHarness();let directCalls=0;
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  try{
    await keepThreadMeta(page);
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"harness-reconnect-fixture"}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
    await page.route(/\/api\/settings$/,route=>json(route,settings));
    await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/general-workspace$/,route=>json(route,{path:process.cwd(),environmentId:null}));
    await page.route(/\/api\/stashes$/,route=>json(route,{stashes:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.route(/\/api\/chat\/direct$/,route=>{directCalls++;return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"The direct route must not be used outside mock mode"})})});
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    await page.getByRole("button",{name:"Projects",exact:true}).click();
    await page.locator(".general-chat-card").click();
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),transport=page.getByTestId("composer-transport");
    await expect(page.locator(".composer-status")).toContainText("Ctrl/Cmd+Enter background");
    await expect(transport).toHaveCount(0);
    expect(harness.connections()).toBe(1);

    harness.drop();
    await expect(transport).toContainText("Reconnecting to Codex");
    const draft="Keep this draft while Codex reconnects.";
    await composer.fill(draft);
    await expect(composer).toBeEditable();
    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute("title","Reconnecting to Codex…");
    // Enter does what the disabled Send does: nothing. No failed card says again what the line under the composer says.
    await composer.press("Enter");await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
    await expect(transport).toHaveText("Reconnecting to Codex… · your draft stays here until it connects.");
    await expect(page.getByText("Codex is reconnecting. Your draft was kept; send it again once Codex is connected.")).toHaveCount(0);await expect(page.locator(".activity-card-failed")).toHaveCount(0);
    await expect(composer).toHaveValue(draft);
    expect(directCalls).toBe(0);
    expect(harness.requests.some(message=>message.method==="thread/start"||message.method==="turn/start")).toBe(false);
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({animations:"disabled",path:auditDir+"harness-reconnecting-keeps-draft-1280x800.png",fullPage:true});

    harness.accept();
    await expect(transport).toHaveCount(0,{timeout:15_000});
    expect(harness.connections()).toBe(2);
    await expect(composer).toHaveValue(draft);
    await expect(send).toBeEnabled();
    await send.click();
    await expect.poll(()=>harness.requests.filter(message=>message.method==="turn/start").length).toBe(1);
    expect(JSON.stringify(harness.requests.find(message=>message.method==="turn/start").params)).toContain(draft);
    await expect(composer).toHaveValue("");
    expect(directCalls).toBe(0);
  }finally{await harness.close()}
});

// The page routes a fixture with its own settings (which the header's light and dark toggle saves into), on the harness at wsUrl.
async function routeCodexFixture(page,wsUrl){
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl,cwd:process.cwd(),platform:process.platform,version:"harness-reconnect-fixture"}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
}
// Dark and light screenshots at 1280x800 and 900 wide, each mode switched with the header toggle, ending where it began.
async function shootModes(page,name){
  for(const width of [1280,900]){
    await page.setViewportSize({width,height:800});
    for(let pass=0;pass<2;pass++){
      const mode=await page.locator("html").getAttribute("data-mode");
      await page.screenshot({animations:"disabled",path:auditDir+`${name}-${mode}-${width}x800.png`});
      const direct=page.locator("[data-testid=appearance-toggle]:visible").first();
      if(await direct.count())await direct.click();else{await page.getByRole("button",{name:/More actions/}).first().click();await page.getByTestId("header-overflow-menu").getByRole("button",{name:/^Switch to (light|dark) mode$/}).click()}
      await expect(page.locator("html")).not.toHaveAttribute("data-mode",mode||"");
    }
  }
  await page.setViewportSize({width:1280,height:800});
}

test("when the Codex app-server dies behind the relay the composer says so at once, keeps the draft and is ready again once it is back",async({page})=>{
  test.setTimeout(45_000);
  // The real Codex relay between the app and the harness: an app-server that dies leaves the relay's connection closed with 1006.
  const harness=await startHarness(),relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachCodexRelay(relayHttp,{targetUrl:harness.wsUrl});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await routeCodexFixture(page,"ws://127.0.0.1:"+relayPort+"/api/codex/ws");
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),transport=page.getByTestId("composer-transport");
    await expect(composer).toHaveAttribute("placeholder","Ask Trebell Code anything…");
    await expect(transport).toHaveCount(0);
    await composer.click();await page.keyboard.type("Keep this while Codex restarts.",{delay:8});
    harness.drop();
    await expect(transport).toContainText("Reconnecting to Codex",{timeout:3000});
    await expect(send).toBeDisabled();
    await expect(composer).toHaveValue("Keep this while Codex restarts.");
    await shootModes(page,"harness-relay-app-server-died");
    harness.accept();
    await expect(transport).toHaveCount(0,{timeout:15_000});
    await expect(send).toBeEnabled();
    await expect(composer).toHaveValue("Keep this while Codex restarts.");
  }finally{relay.close();await harness.close();await new Promise(resolve=>relayHttp.close(resolve))}
});

test("a server that cannot reach Codex says why in the composer instead of connecting forever, and Retry connects once it can",async({page})=>{
  test.setTimeout(45_000);
  const harness=await startHarness(),reason="The Codex app-server port 23456 (TREBELL_APP_SERVER_PORT or --app-port) is in use by another program";
  harness.refuse(reason);
  try{
    await routeCodexFixture(page,harness.wsUrl);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),transport=page.getByTestId("composer-transport");
    await composer.click();await page.keyboard.type("Start the release checklist.",{delay:8});
    await expect(transport).toContainText("Could not connect to Codex: "+reason+". Your draft is kept.",{timeout:10_000});
    await expect(send).toBeDisabled();
    const tries=harness.requests.filter(message=>message.method==="initialize").length;
    await page.waitForTimeout(1500);
    expect(harness.requests.filter(message=>message.method==="initialize").length,"it stops asking once it has said why").toBe(tries);
    await shootModes(page,"harness-refused-says-why");
    harness.allow();
    await transport.getByRole("button",{name:"Retry",exact:true}).click();
    await expect(transport).toHaveCount(0,{timeout:15_000});
    await expect(send).toBeEnabled();
    await expect(composer).toHaveValue("Start the release checklist.");
  }finally{await harness.close()}
});

test("before the harness has ever connected the thread list says it is waiting for it, not that there are no threads",async({page})=>{
  test.setTimeout(45_000);
  const harness=await startHarness();harness.drop();
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  try{
    await keepThreadMeta(page);
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"harness-reconnect-fixture"}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
    await page.route(/\/api\/settings$/,route=>json(route,settings));
    await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const sidebar=page.locator(".sidebar"),empty=sidebar.locator(".sidebar-empty");
    await expect(page.getByTestId("composer-transport")).toContainText("Connecting to Codex");
    await expect(empty).toHaveText("Loading threads…Waiting for Codex to connect.");await expect(empty).toHaveAttribute("role","status");
    await expect(sidebar).not.toContainText("No threads yet");
    await page.screenshot({animations:"disabled",path:auditDir+"sidebar-harness-never-connected-1280x800.png"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({animations:"disabled",path:auditDir+"sidebar-harness-never-connected-light-1280x800.png"});await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    // Once it connects and lists nothing, the list is empty indeed.
    harness.accept();
    await expect(empty).toHaveText("No threads yet.Start a task to create one.",{timeout:15_000});
    await expect(empty).not.toHaveAttribute("role","status");
  }finally{await harness.close()}
});

// A background send whose connection drops once its turn was asked for may be running already. Its row opens to plain lines,
// opened with a click or from the keyboard: what could not be told, the thread and folder to check, the model and where the draft
// went, never the event's data, and they wrap in a narrow window.
test("a background send cut off at turn/start opens to the thread to check and where its draft went, not to the event's data",async({page})=>{
  test.setTimeout(45_000);
  const harness=await startHarness();harness.dropAt("turn/start");let stashed=null;
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  try{
    await routeCodexFixture(page,harness.wsUrl);
    await page.route(/\/api\/general-workspace$/,route=>json(route,{path:process.cwd(),environmentId:null}));
    await page.route(/\/api\/stashes$/,route=>{if(route.request().method()!=="POST")return json(route,{stashes:[]});stashed=route.request().postDataJSON();return json(route,{stash:{id:"reconnect-stash"}})});
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await page.getByRole("button",{name:"Projects",exact:true}).click();await page.locator(".general-chat-card").click();
    await expect(page.locator(".composer-status")).toContainText("Ctrl/Cmd+Enter background");
    const draft="Run the release checks in the background.";
    await page.getByTestId("composer").click();await page.keyboard.type(draft,{delay:8});await page.keyboard.press("Control+Enter");
    const row=page.locator(".tool-event").filter({hasText:"may already be running"}),summary=row.locator("summary"),body=row.locator(".tool-event-body");
    await expect(summary).toContainText("Background may already be running. Possible thread: reconnect-thread.");
    await expect.poll(()=>stashed?.text).toBe("[CHECK EXISTING THREAD BEFORE RETRY] "+draft);
    const detail=["Could not tell whether the task's turn started: Codex disconnected","Possible thread: reconnect-thread","Folder: "+process.cwd(),"Model: test/coding-fast","The draft was saved to Trebell stash, marked [CHECK EXISTING THREAD BEFORE RETRY]."].join("\n");
    await summary.click();
    await expect(body.locator("pre")).toHaveCount(1);expect(await body.locator("pre").textContent()).toBe(detail);
    await expect(body.locator(".tool-json")).toHaveCount(0);
    await summary.click();await expect(body).toHaveCount(0);
    await summary.focus();await page.keyboard.press("Enter");
    await expect.poll(()=>body.locator("pre").textContent()).toBe(detail);
    await page.setViewportSize({width:900,height:800});
    const metrics=await page.locator(".chat-workspace").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await shootModes(page,"background-uncertain-row-opened");
  }finally{await harness.close()}
});
