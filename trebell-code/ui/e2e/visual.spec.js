import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

async function prepare(page,request){
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Visual Audit Workspace",activate:true}});
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("model-picker")).toBeEnabled({timeout:10_000});
}

async function box(locator){
  const value=await locator.boundingBox();
  expect(value).not.toBeNull();
  return value;
}

async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

test("chat workspace is visually bounded and panes resize",async({page,request})=>{
  test.setTimeout(45_000);
  await prepare(page,request);
  await expect(page.locator(".window-controls")).toHaveCount(0);
  await expect(page.locator(".window-bar")).toBeHidden();
  expect((await box(page.locator(".chat-workspace"))).y).toBeLessThanOrEqual(1);

  const shell=page.locator(".app-shell");
  const sidebar=page.locator(".sidebar");
  const main=page.locator(".main-frame");
  const composer=page.locator(".composer-wrap");
  const composerBar=page.locator(".composer-bar");
  const sidebarBefore=await box(sidebar);
  expect(sidebarBefore.width).toBeGreaterThanOrEqual(210);
  expect(sidebarBefore.width).toBeLessThanOrEqual(420);
  const mainBefore=await box(main),composerBefore=await box(composer);
  expect(composerBefore.x).toBeGreaterThanOrEqual(mainBefore.x);
  expect(composerBefore.x+composerBefore.width).toBeLessThanOrEqual(mainBefore.x+mainBefore.width+1);
  const overflow=await composerBar.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client+1);
  await expect(composer.getByRole("button",{name:"Web",exact:true})).toHaveCount(0);
  await expect(composer.getByRole("button",{name:"Files",exact:true})).toHaveCount(0);
  await expect(composer.getByRole("button",{name:"Skills",exact:true})).toHaveCount(0);
  await page.screenshot({path:auditDir+"chat-1600x980.png",fullPage:true});
  const modelPicker=page.getByTestId("model-picker");
  await modelPicker.click();
  await expect(page.locator(".model-picker-menu")).toBeVisible();
  await page.screenshot({path:auditDir+"chat-model-picker-open-1600x980.png",fullPage:true});
  await page.keyboard.press("Escape");
  await expect(page.locator(".model-picker-menu")).toBeHidden();
  await modelPicker.click();
  await expect(page.locator(".model-picker-menu")).toBeVisible();
  await page.locator(".conversation-scroll").click({position:{x:20,y:20}});
  await expect(page.locator(".model-picker-menu")).toBeHidden();
  const composerInput=page.getByTestId("composer");
  const shortHeight=(await box(composerInput)).height;
  await composerInput.fill("First line\nSecond line\nThird line\nFourth line");
  const multilineHeight=(await box(composerInput)).height;
  expect(multilineHeight).toBeGreaterThan(shortHeight+15);
  expect(multilineHeight).toBeLessThanOrEqual(160);
  await page.screenshot({path:auditDir+"chat-composer-multiline-1600x980.png",fullPage:true});
  await composerInput.fill(Array.from({length:40},(_,index)=>`Long draft line ${index+1} with enough content to exercise bounded composer growth.`).join("\n"));
  const cappedHeight=(await box(composerInput)).height;
  expect(cappedHeight).toBeGreaterThanOrEqual(158);
  expect(cappedHeight).toBeLessThanOrEqual(160);
  expect(await composerInput.evaluate(node=>getComputedStyle(node).overflowY)).toBe("auto");
  await page.screenshot({path:auditDir+"chat-composer-capped-1600x980.png",fullPage:true});
  await composerInput.fill("");
  expect((await box(composerInput)).height).toBeLessThanOrEqual(shortHeight+1);

  const sidebarResizer=page.getByTestId("sidebar-resizer");
  const sidebarHandle=await box(sidebarResizer);
  await page.mouse.move(sidebarHandle.x+3,sidebarHandle.y+200);
  await page.mouse.down();
  await page.mouse.move(sidebarHandle.x+73,sidebarHandle.y+200,{steps:5});
  await page.mouse.up();
  const sidebarAfter=await box(sidebar);
  expect(sidebarAfter.width).toBeGreaterThan(sidebarBefore.width+45);
  const sidebarDelta=sidebarAfter.width-sidebarBefore.width;

  await page.getByTestId("right-panel-toggle").click();
  const rightPanel=page.getByTestId("right-panel");
  await expect(rightPanel).toBeVisible();
  const rightBefore=await box(rightPanel);
  expect(rightBefore.width).toBeGreaterThanOrEqual(340);
  expect(rightBefore.width).toBeLessThanOrEqual(820);
  const rightResizer=page.getByTestId("right-panel-resizer");
  const rightHandle=await box(rightResizer);
  await page.mouse.move(rightHandle.x+3,rightHandle.y+200);
  await page.mouse.down();
  await page.mouse.move(rightHandle.x-75,rightHandle.y+200,{steps:5});
  await page.mouse.up();
  const rightAfter=await box(rightPanel);
  expect(rightAfter.width).toBeGreaterThan(rightBefore.width+45);

  await page.getByTestId("terminal-toggle").click();
  const terminal=page.getByTestId("drawer");
  await expect(terminal).toBeVisible();
  const terminalBefore=await box(terminal);
  const terminalResizer=page.getByTestId("terminal-resizer");
  const terminalHandle=await box(terminalResizer);
  await page.mouse.move(terminalHandle.x+200,terminalHandle.y+4);
  await page.mouse.down();
  await page.mouse.move(terminalHandle.x+200,terminalHandle.y-70,{steps:5});
  await page.mouse.up();
  const terminalAfter=await box(terminal);
  expect(terminalAfter.height).toBeGreaterThan(terminalBefore.height+45);
  await page.screenshot({path:auditDir+"chat-resized-panels-1600x980.png",fullPage:true});

  await page.getByTestId("terminal-toggle").click();
  await page.getByTestId("right-panel-toggle").click();
  const resetHandle=await box(sidebarResizer);
  await page.mouse.move(resetHandle.x+3,resetHandle.y+200);
  await page.mouse.down();
  await page.mouse.move(resetHandle.x+3-sidebarDelta,resetHandle.y+200,{steps:5});
  await page.mouse.up();
  expect(Math.abs((await box(sidebar)).width-sidebarBefore.width)).toBeLessThanOrEqual(2);
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"chat-1280x800.png",fullPage:true});
  await expect(page.locator(".workspace-mode")).toHaveValue("current");
  await expect(modelPicker).not.toContainText("deepseek/deepseek");
  const compactOverflow=await composerBar.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(compactOverflow.scroll).toBeLessThanOrEqual(compactOverflow.client+1);
  const compactMain=await box(main),compactComposer=await box(composer);
  expect(compactComposer.x).toBeGreaterThanOrEqual(compactMain.x);
  expect(compactComposer.x+compactComposer.width).toBeLessThanOrEqual(compactMain.x+compactMain.width+1);
  await expect(shell).toBeVisible();
});

test("composer file mentions search the workspace and attach the selected file",async({page,request})=>{
  test.setTimeout(30_000);
  await prepare(page,request);
  const composer=page.getByTestId("composer");
  await composer.fill("Review @pack");
  const menu=page.getByTestId("file-mention-menu");
  await expect(menu).toBeVisible();
  const packageFile=menu.getByRole("button").filter({hasText:"package.json"}).first();
  await expect(packageFile).toBeVisible();
  await page.screenshot({path:auditDir+"chat-file-mention-menu-1600x980.png",fullPage:true});
  await packageFile.click();
  await expect(menu).toBeHidden();
  await expect(page.getByTestId("context-chips")).toContainText("package.json");
  await expect(composer).toHaveValue(/Review @package\.json /);
  await page.screenshot({path:auditDir+"chat-file-mention-attached-1600x980.png",fullPage:true});

  await page.getByTestId("context-chip").filter({hasText:"package.json"}).getByTitle("Remove context").click();
  await composer.fill("Open @pack");
  await expect(menu).toBeVisible();
  await composer.press("ArrowDown");
  await composer.press("ArrowUp");
  await composer.press("Enter");
  await expect(page.getByTestId("context-chips")).toContainText("package.json");

  await request.post("/api/settings",{data:{appearance:"light",appearanceMode:"light"}});
  await page.reload();
  const lightComposer=page.getByTestId("composer");await expect(lightComposer).toBeVisible();
  await lightComposer.fill("Inspect @pack");
  await expect(page.getByTestId("file-mention-menu")).toBeVisible();
  await page.setViewportSize({width:1280,height:800});
  const mentionBox=await box(page.getByTestId("file-mention-menu")),mainBox=await box(page.locator(".main-frame"));
  expect(mentionBox.x).toBeGreaterThanOrEqual(mainBox.x);
  expect(mentionBox.x+mentionBox.width).toBeLessThanOrEqual(mainBox.x+mainBox.width+1);
  await page.screenshot({path:auditDir+"light-chat-file-mention-menu-1280x800.png",fullPage:true});
});

test("composer file mention failures stay visible and keep the mention retryable",async({page,request})=>{
  test.setTimeout(30_000);
  await prepare(page,request);
  await page.route(/\/api\/attachments\/import$/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate file mention attachment failure"})}));
  const composer=page.getByTestId("composer");
  await composer.fill("Review @pack");
  const menu=page.getByTestId("file-mention-menu");
  await expect(menu).toBeVisible();
  const packageFile=menu.getByRole("button").filter({hasText:"package.json"}).first();
  await packageFile.click();
  const alert=page.getByTestId("app-action-error");
  await expect(alert).toContainText("Could not attach file mention: Deliberate file mention attachment failure");
  await expect(alert).toBeInViewport();
  await expect(menu).toBeVisible();
  await expect(composer).toHaveValue("Review @pack");
  await expect(page.getByTestId("context-chips")).toHaveCount(0);
  await page.setViewportSize({width:1280,height:800});
  const alertBox=await box(alert),menuBox=await box(menu);
  expect(alertBox.y+alertBox.height).toBeLessThanOrEqual(menuBox.y-4);
  await page.screenshot({path:auditDir+"chat-file-mention-error-1280x800.png",fullPage:true});
});

test("composer file mentions use fuzzy shared workspace search",async({page,request})=>{
  test.setTimeout(30_000);
  const dir=await mkdtemp(join(tmpdir(),"trebell-fuzzy-mention-"));
  try{
    const components=join(dir,"src","components"),utils=join(dir,"src","utils");
    await Promise.all([mkdir(components,{recursive:true}),mkdir(utils,{recursive:true})]);
    await Promise.all([
      writeFile(join(components,"UserCard.jsx"),"export const UserCard=()=>null;\n","utf8"),
      writeFile(join(utils,"compareUsers.js"),"export function compareUsers(){}\n","utf8"),
    ]);
    await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"}});
    await request.post("/api/projects",{data:{path:dir,name:"Fuzzy Mention Workspace",activate:true}});
    await page.goto("/");
    const composer=page.getByTestId("composer");await expect(composer).toBeVisible();await composer.fill("Inspect @ucard");
    const menu=page.getByTestId("file-mention-menu");await expect(menu).toBeVisible();
    const match=menu.getByRole("button").filter({hasText:"UserCard.jsx"}).first();await expect(match).toBeVisible();
    await expect(menu).not.toContainText("compareUsers.js");
    await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"chat-fuzzy-file-mention-1280x800.png",fullPage:true});
    await match.click();await expect(page.getByTestId("context-chips")).toContainText("UserCard.jsx");await expect(composer).toHaveValue(/Inspect @src[\\/]components[\\/]UserCard\.jsx /);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test("workspace panel refreshes from live RPC file-change notifications",async({page,request})=>{
  test.setTimeout(30_000);
  const dir=await mkdtemp(join(tmpdir(),"trebell-live-workspace-"));
  try{
    await writeFile(join(dir,"initial.txt"),"initial\n","utf8");
    await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"}});
    await request.post("/api/projects",{data:{path:dir,name:"Live Workspace",activate:true}});
    await page.goto("/");
    await page.getByTestId("right-panel-toggle").click();
    const panel=page.getByTestId("right-panel");await expect(panel).toBeVisible();await expect(panel).toContainText("initial.txt");
    await writeFile(join(dir,"agent-created.txt"),"created by agent\n","utf8");
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent("trebell:rpc-notification",{detail:{method:"item/fileChange/patchUpdated",params:{}}})));
    await expect(panel).toContainText("agent-created.txt");
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({path:auditDir+"workspace-live-file-refresh-1280x800.png",fullPage:true});
    await request.post("/api/settings",{data:{appearance:"light",appearanceMode:"light"}});
    await page.reload();await page.getByTestId("right-panel-toggle").click();await expect(page.getByTestId("right-panel")).toContainText("agent-created.txt");
    await page.screenshot({path:auditDir+"workspace-live-file-refresh-light-1280x800.png",fullPage:true});
  }finally{await rm(dir,{recursive:true,force:true})}
});

test("navigation history shortcuts visibly restore prior app surfaces",async({page,request})=>{
  test.setTimeout(35_000);
  await prepare(page,request);
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Settings",level:1})).toBeVisible();

  await page.keyboard.press("Control+[");
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  await page.screenshot({path:auditDir+"navigation-back-projects-1600x980.png",fullPage:true});

  await page.keyboard.press("Control+]");
  await expect(page.getByRole("heading",{name:"Settings",level:1})).toBeVisible();
  await page.screenshot({path:auditDir+"navigation-forward-settings-1600x980.png",fullPage:true});
});

test("browser attach button uploads files without the desktop bridge",async({page,request})=>{
  test.setTimeout(30_000);
  await prepare(page,request);
  await expect(page.locator(".window-controls")).toHaveCount(0);
  const [chooser]=await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button",{name:"Attach files"}).click(),
  ]);
  await chooser.setFiles({name:"browser-attachment.txt",mimeType:"text/plain",buffer:Buffer.from("browser attachment fixture\n")});
  await expect(page.locator(".attachment-shelf span")).toHaveText(/browser-attachment\.txt/);
  await expect(page.locator(".attachment-shelf span")).not.toContainText(/^\d{10,}-/);
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"browser-file-attachment-1280x800.png",fullPage:true});
});

test("browser file attachment failures stay visible without fake attachments",async({page,request})=>{
  test.setTimeout(30_000);
  await prepare(page,request);
  await page.route(/\/api\/attachments\/blob$/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate composer attachment failure"})}));
  const [chooser]=await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button",{name:"Attach files"}).click(),
  ]);
  await chooser.setFiles({name:"retry-me.txt",mimeType:"text/plain",buffer:Buffer.from("retryable attachment fixture\n")});
  const alert=page.getByTestId("app-action-error");
  await expect(alert).toContainText("Could not attach files: Deliberate composer attachment failure");
  await expect(alert).toBeInViewport();
  await expect(page.locator(".attachment-shelf span")).toHaveCount(0);
  await page.setViewportSize({width:1280,height:800});
  const metrics=await page.locator(".composer-wrap").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"composer-attachment-error-1280x800.png",fullPage:true});
});

test("oversized pasted text stays in the draft when attachment creation fails",async({page,request})=>{
  test.setTimeout(30_000);
  await prepare(page,request);
  await page.route(/\/api\/attachments\/text$/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate pasted text attachment failure"})}));
  const composer=page.getByTestId("composer");
  const prefix="Keep this draft: ",pasted="P".repeat(33_000);
  await composer.fill(prefix);
  await composer.evaluate((node,text)=>{
    const data=new DataTransfer();data.setData("text/plain",text);
    node.dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data}));
  },pasted);
  const alert=page.getByTestId("app-action-error");
  await expect(alert).toContainText("Could not attach pasted text; kept it in the draft: Deliberate pasted text attachment failure");
  await expect(composer).toHaveValue(prefix+pasted);
  await expect(page.locator(".attachment-shelf span")).toHaveCount(0);
  await page.setViewportSize({width:1280,height:800});
  await expect(alert).toBeInViewport();
  const metrics=await page.locator(".composer-wrap").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  const alertBox=await box(alert),composerBox=await box(page.locator(".composer-wrap"));
  expect(alertBox.y+alertBox.height).toBeLessThanOrEqual(composerBox.y-4);
  await page.screenshot({path:auditDir+"composer-pasted-text-error-1280x800.png",fullPage:true});
});

test("agent question file attachment failures stay inside the retryable modal",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"question-attachment-thread",name:"Question attachment fixture",preview:"Question attachment coverage",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  let notificationSocket=null;
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);notificationSocket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      let result={};
      if(message.method==="initialize")result={userAgent:"question-attachment-fixture"};
      else if(message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:process.platform,version:"question-attachment-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.route(/\/api\/attachments\/blob$/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate question attachment failure"})}));
    await page.goto("/");
    await page.getByRole("button",{name:/Question attachment fixture/}).click();
    notificationSocket.send(JSON.stringify({id:72,method:"item/tool/requestUserInput",params:{threadId:thread.id,questions:[{id:"evidence",header:"Need evidence",question:"Attach the retryable file?",options:[],allowMultiple:false}]}}));
    const modal=page.locator(".question-modal");
    await expect(page.getByText("Attach the retryable file?",{exact:true})).toBeVisible();
    const [chooser]=await Promise.all([
      page.waitForEvent("filechooser"),
      modal.getByRole("button",{name:"Attach files"}).click(),
    ]);
    await chooser.setFiles({name:"retry-question.txt",mimeType:"text/plain",buffer:Buffer.from("question attachment retry fixture\n")});
    const alert=page.getByRole("alert");
    await expect(alert).toContainText("Could not attach files: Deliberate question attachment failure");
    await expect(page.getByText("Attach the retryable file?",{exact:true})).toBeVisible();
    await expect(page.locator(".question-files span")).toHaveCount(0);
    await page.setViewportSize({width:1280,height:800});
    const bounds=await modal.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
    await page.screenshot({path:auditDir+"question-attachment-error-1280x800.png",fullPage:true});
  }finally{
    relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();
    await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))]);
  }
});

test("command palette keeps failed actions visible with useful feedback",async({page,request})=>{
  test.setTimeout(30_000);
  await prepare(page,request);
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Visual Audit Workspace",activate:true,scripts:[{id:"broken-action",name:"Broken action",command:"echo should-not-run"}],preferredScriptId:"broken-action"}});
  await page.reload();
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.route("**/api/project-script/run",route=>route.fulfill({status:400,contentType:"application/json",body:JSON.stringify({error:"Deliberate project action failure"})}));
  await page.keyboard.press("Control+k");
  const palette=page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  const action=palette.getByRole("button",{name:/Run Broken action/});
  await expect(action).toBeVisible();
  await action.click();
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("alert")).toContainText("Deliberate project action failure");
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"command-palette-action-error-1280x800.png",fullPage:true});
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  const headerAction=page.locator(".workspace-header").getByRole("button",{name:"Broken action",exact:true});
  await expect(headerAction).toBeVisible();
  await headerAction.click();
  await expect(page.getByTestId("app-action-error")).toContainText("Project action failed: Deliberate project action failure");
  await page.screenshot({path:auditDir+"header-project-action-error-1280x800.png",fullPage:true});
});

test("terminal failures keep backend and visible session state in sync",async({page,request})=>{
  test.setTimeout(30_000);
  await page.addInitScript(()=>{
    const NativeWebSocket=window.WebSocket;
    function WrappedWebSocket(url,protocols){
      if(!String(url).includes("/api/terminal/ws"))return protocols===undefined?new NativeWebSocket(url):new NativeWebSocket(url,protocols);
      const socket={
        readyState:NativeWebSocket.OPEN,
        onmessage:null,
        onclose:null,
        send(){},
        close(){this.readyState=NativeWebSocket.CLOSED;this.onclose?.({})},
      };
      setTimeout(()=>socket.onmessage?.({data:JSON.stringify({type:"snapshot",session:{buffer:"terminal fixture output\n"}})}),20);
      return socket;
    }
    for(const key of ["CONNECTING","OPEN","CLOSING","CLOSED"])WrappedWebSocket[key]=NativeWebSocket[key];
    WrappedWebSocket.prototype=NativeWebSocket.prototype;
    window.WebSocket=WrappedWebSocket;
  });
  await prepare(page,request);
  await page.getByTestId("terminal-toggle").click();
  const drawer=page.getByTestId("drawer");
  await expect(drawer).toBeVisible();
  const newButton=drawer.locator(".terminal-new");
  await expect(newButton).toBeVisible();
  await newButton.click();
  await expect(drawer.locator(".terminal-pane")).toHaveCount(1);
  const pane=drawer.locator(".terminal-pane").first();
  await expect(pane.locator(".terminal-screen")).toContainText("terminal fixture output",{timeout:10_000});
  await page.route(/\/api\/attachments\/text$/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate terminal attachment failure"})}));
  await pane.getByRole("button",{name:"Attach recent output",exact:true}).click();
  await expect(drawer.getByRole("alert")).toContainText("Deliberate terminal attachment failure");
  await expect(drawer).toBeVisible();
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"terminal-attach-error-1280x800.png",fullPage:true});
  await page.unroute(/\/api\/attachments\/text$/);

  await page.route("**/api/terminal/sessions*",route=>{
    if(route.request().method()==="DELETE")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate terminal close failure"})});
    return route.continue();
  });
  await drawer.locator(".terminal-tabs button.active span").click();
  await expect(drawer.getByRole("alert")).toContainText("Deliberate terminal close failure");
  await expect(drawer.locator(".terminal-pane")).toHaveCount(1);
  await page.unroute("**/api/terminal/sessions*");

  await page.route("**/api/terminal/sessions",route=>{
    if(route.request().method()==="POST")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate terminal create failure"})});
    return route.continue();
  });
  await newButton.click();
  await expect(drawer.getByRole("alert")).toContainText("Deliberate terminal create failure");
  await expect(drawer.locator(".terminal-pane")).toHaveCount(1);
  await page.unroute("**/api/terminal/sessions");
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"terminal-action-error-1280x800.png",fullPage:true});
});

test("slash menu only advertises commands that can run in the current context",async({page,request})=>{
  test.setTimeout(30_000);
  await prepare(page,request);
  const composer=page.getByTestId("composer");
  await composer.fill("/");
  const menu=page.locator(".slash-menu");
  await expect(menu).toBeVisible();
  for(const command of ["/compact","/ps","/stop","/feedback","/goal","/review"]){
    await expect(menu.getByText(command,{exact:true})).toHaveCount(0);
  }
  for(const command of ["/terminal","/diff","/git","/preview","/model","/plan"]){
    await expect(menu.getByText(command,{exact:true})).toBeVisible();
  }
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"slash-menu-new-task-1280x800.png",fullPage:true});

  await composer.fill("");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await page.getByRole("button",{name:/No project · General chat/}).click();
  await expect(page.getByText("This is a General chat with no attached project.")).toBeVisible();
  const generalComposer=page.getByTestId("composer");
  await generalComposer.fill("/");
  const generalMenu=page.locator(".slash-menu");
  await expect(generalMenu).toBeVisible();
  for(const command of ["/compact","/ps","/stop","/feedback","/goal","/review","/diff","/git"]){
    await expect(generalMenu.getByText(command,{exact:true})).toHaveCount(0);
  }
  await expect(generalMenu.getByText("/terminal",{exact:true})).toBeVisible();
  await expect(generalMenu.getByText("/preview",{exact:true})).toBeVisible();
  await page.screenshot({path:auditDir+"slash-menu-general-chat-1280x800.png",fullPage:true});
});

test("settings page visual audit",async({page,request})=>{
  test.setTimeout(45_000);
  await page.addInitScript(()=>{
    Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{
      browser:{
        importSources:async()=>({platform:"win32",sources:[{id:"firefox",name:"Firefox",running:false,profiles:[{id:"fixture-profile",name:"Fixture profile"}]}]}),
        importProfile:async()=>({ok:true,imported:3,failed:0,skipped:0}),
      },
      snapshots:{
        get:async()=>({enabled:false,shortcut:"CommandOrControl+Shift+S",includeText:false,playSound:true,sound:"soft-pop",flash:true,animations:true,registered:false,pending:0}),
        configure:async value=>value,
        capture:async()=>({ok:true}),
        pending:async()=>[],
        onCaptured:()=>()=>{},
      },
      background:{set:async()=>({ok:true})},
    }});
  });
  await prepare(page,request);
  await page.getByRole("button",{name:"Settings"}).click();
  await expect(page.getByRole("heading",{name:"Settings"})).toBeVisible();
  const pageShell=page.locator(".secondary-page.full");
  const settings=page.locator(".settings-page");
  await expect(settings).toBeVisible();
  const metrics=await settings.evaluate(node=>({
    clientWidth:node.clientWidth,
    scrollWidth:node.scrollWidth,
    clientHeight:node.clientHeight,
    scrollHeight:node.scrollHeight,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth+1);
  await expect(page.getByRole("button",{name:/General/})).toHaveAttribute("aria-current","page");
  await expect(page.getByRole("heading",{name:"Follow-up behavior"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Agent harness"})).toBeHidden();
  await expect(page.getByRole("heading",{name:"Browser profiles"})).toBeHidden();
  await expect(page.getByRole("heading",{name:"SnapShots"})).toBeHidden();
  await page.screenshot({path:auditDir+"settings-general-1600x980.png",fullPage:true});

  const settingsSearch=page.getByLabel("Search settings");
  await settingsSearch.fill("command palette");
  const settingsSearchResults=page.getByTestId("settings-search-results");
  const commandPaletteResult=settingsSearchResults.getByRole("button",{name:/Command palette/});
  await expect(commandPaletteResult).toBeVisible();
  await page.screenshot({path:auditDir+"settings-search-command-1600x980.png",fullPage:true});
  await commandPaletteResult.click();
  await expect(page.getByRole("heading",{name:"Keyboard shortcuts"})).toBeVisible();
  const commandPaletteRow=page.locator(".keybinding-row").filter({hasText:"Command palette"}).first();
  await expect(commandPaletteRow).toBeInViewport();
  await expect(commandPaletteRow).toHaveClass(/settings-search-hit/);
  await page.screenshot({path:auditDir+"settings-search-command-target-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:/Agents & models/}).click();
  await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Model provider"})).toBeVisible();
  await expect(page.getByLabel("Model ID")).toHaveCount(0);
  await page.screenshot({path:auditDir+"settings-agents-1600x980.png",fullPage:true});
  await page.getByRole("button",{name:"Add custom model",exact:true}).click();
  await expect(page.getByLabel("Model ID")).toBeVisible();
  await page.screenshot({path:auditDir+"settings-agents-add-model-1600x980.png",fullPage:true});
  await page.getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(page.getByLabel("Model ID")).toHaveCount(0);

  await page.getByRole("button",{name:/Workspace/}).click();
  await expect(page.getByRole("heading",{name:"Storage cleanup"})).toBeVisible();
  const scopeSentence=page.getByTestId("settings-scope-sentence");
  await expect(scopeSentence).toBeVisible();
  await expect(scopeSentence).toContainText("Applying settings for");
  await expect(scopeSentence.getByLabel("Project scope")).toHaveValue("");
  await expect(page.locator(".scoped-settings-targets")).toHaveCount(0);
  await page.screenshot({path:auditDir+"settings-workspace-1600x980.png",fullPage:true});
  await scopeSentence.getByLabel("Project scope").selectOption({label:"Visual Audit Workspace"});
  await expect(page.getByTestId("scoped-settings-card").getByLabel("Permissions")).toHaveValue("__inherit__");
  await expect(scopeSentence).toContainText("Visual Audit Workspace");
  await page.screenshot({path:auditDir+"settings-workspace-project-scope-1600x980.png",fullPage:true});
  await scopeSentence.getByLabel("Project scope").selectOption("");

  await page.getByRole("button",{name:/Appearance/}).click();
  await expect(page.getByRole("heading",{name:"Appearance",level:3})).toBeVisible();
  await page.screenshot({path:auditDir+"settings-appearance-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:/Desktop/}).click();
  await expect(page.getByRole("heading",{name:"Background mode"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Browser profiles"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"SnapShots"})).toBeVisible();
  await page.screenshot({path:auditDir+"settings-desktop-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:/Shortcuts/}).click();
  await expect(page.getByRole("heading",{name:"Keyboard shortcuts"})).toBeVisible();
  await page.screenshot({path:auditDir+"settings-shortcuts-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:/Diagnostics/}).click();
  await expect(page.getByRole("heading",{name:"Diagnostics",level:3})).toBeVisible();
  await expect(page.getByText("Runtime log",{exact:true})).toBeVisible();
  await expect(page.getByText("No runtime activity yet",{exact:true})).toBeVisible();
  await page.screenshot({path:auditDir+"settings-diagnostics-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:/General/}).click();
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"settings-general-1280x800.png",fullPage:true});
  const compact=await pageShell.evaluate(node=>({clientWidth:node.clientWidth,scrollWidth:node.scrollWidth}));
  expect(compact.scrollWidth).toBeLessThanOrEqual(compact.clientWidth+1);
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.getByRole("button",{name:/Workspace/}).click();
  await expect(page.getByRole("heading",{name:"Storage cleanup"})).toBeVisible();
  await page.screenshot({path:auditDir+"settings-workspace-light-1280x800.png",fullPage:true});
  await page.getByRole("button",{name:/Diagnostics/}).click();
  await expect(page.getByText("No runtime activity yet",{exact:true})).toBeVisible();
  await page.screenshot({path:auditDir+"settings-diagnostics-light-1280x800.png",fullPage:true});
  const compactLight=await pageShell.evaluate(node=>({clientWidth:node.clientWidth,scrollWidth:node.scrollWidth}));
  expect(compactLight.scrollWidth).toBeLessThanOrEqual(compactLight.clientWidth+1);
});

test("desktop background mode rolls back when settings persistence fails",async({page,request})=>{
  test.setTimeout(30_000);
  await page.addInitScript(()=>{
    window.__backgroundCalls=[];
    Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{
      background:{set:async value=>{window.__backgroundCalls.push(Boolean(value));return{ok:true}}},
    }});
  });
  await prepare(page,request);
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Desktop/}).click();
  await expect(page.getByRole("heading",{name:"Background mode"})).toBeVisible();
  await page.route(/\/api\/settings$/,route=>{
    if(route.request().method()==="POST")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate background settings failure"})});
    return route.continue();
  });
  const toggle=page.getByLabel("Keep Trebell running in background");
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(page.getByRole("alert")).toContainText("Deliberate background settings failure");
  await expect(toggle).not.toBeChecked();
  await expect.poll(()=>page.evaluate(()=>window.__backgroundCalls.slice(-2))).toEqual([true,false]);
  await page.setViewportSize({width:1280,height:800});
  const settings=page.locator(".settings-page");
  const metrics=await settings.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"settings-background-error-1280x800.png",fullPage:true});
});

test("published theme refresh failures keep the last valid catalog visible",async({page,request})=>{
  test.setTimeout(30_000);
  let failRefresh=false;
  const catalog={environmentKey:"local",environmentName:"Local machine",directory:"C:/Trebell/themes",themes:[{id:"fixture-published",name:"Fixture published theme",appearance:"dark",canvas:"#11131a",accent:"#8f6bd8"}]};
  await page.route(/\/api\/environment\/themes$/,route=>failRefresh
    ?route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate published theme refresh failure"})})
    :route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(catalog)}));
  await prepare(page,request);
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Appearance/}).click();
  const publishedTheme=page.getByRole("button",{name:"Fixture published theme",exact:true});
  await expect(publishedTheme).toBeVisible();
  failRefresh=true;
  await page.setViewportSize({width:1280,height:800});
  await page.getByRole("button",{name:"Refresh published themes",exact:true}).click();
  const alert=page.getByRole("alert");
  await expect(alert).toContainText("Could not refresh published themes: Deliberate published theme refresh failure");
  await expect(alert).toBeInViewport();
  await expect(publishedTheme).toBeVisible();
  await expect(page.getByText("No valid published themes found.",{exact:false})).toHaveCount(0);
  const metrics=await page.locator(".settings-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"settings-theme-refresh-error-1280x800.png",fullPage:true});
});

test("Freebuff sign-in failures surface immediately without starting a useless poll",async({page,request})=>{
  test.setTimeout(30_000);
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  let bootstrapCalls=0;
  await page.route(/\/api\/bootstrap$/,route=>{
    bootstrapCalls++;
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({...boot,mock:false,loggedIn:false,providerReady:false,appServerReady:false,wsUrl:null})});
  });
  await page.route("**/api/login/start",route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate Freebuff sign-in failure"})}));
  await page.goto("/");
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  const signIn=page.getByRole("button",{name:"Sign in to Freebuff",exact:true});
  await expect(signIn).toBeVisible();
  const callsBefore=bootstrapCalls;
  await signIn.click();
  const status=page.getByTestId("provider-status");
  await expect(status).toContainText("Deliberate Freebuff sign-in failure");
  await expect(status).toHaveClass(/provider-status-error/);
  await expect(signIn).toBeEnabled();
  await page.waitForTimeout(1700);
  expect(bootstrapCalls).toBe(callsBefore);
  await page.setViewportSize({width:1280,height:800});
  await status.scrollIntoViewIfNeeded();
  await page.screenshot({path:auditDir+"freebuff-signin-error-1280x800.png",fullPage:true});
});

test("Claude runtime profile editor exposes real auto-compaction settings",async({page,request})=>{
  test.setTimeout(35_000);
  await prepare(page,request);
  const baseSettings=await (await request.get("/api/settings")).json();
  const baseAgentInfo=await (await request.get("/api/agent-runtimes")).json();
  let selectedRuntime="codex";
  const runtimeFixture=()=>{
    const instances=[...(baseAgentInfo.instances||[])];
    if(!instances.some(item=>item.id==="claude-default"))instances.push({id:"claude-default",kind:"claude",displayName:"Claude Code"});
    const statuses=(baseAgentInfo.statuses||[]).filter(item=>item.id!=="claude-default");
    statuses.push({id:"claude-default",kind:"claude",name:"Claude Code",available:true,installed:true,authenticated:true,version:"fixture"});
    const selectedInstanceId=selectedRuntime+"-default";
    return {...baseAgentInfo,instances,statuses,selectedRuntime,selectedInstanceId};
  };
  await page.route("**/api/agent-runtimes",async route=>{
    if(route.request().method()==="GET")return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(runtimeFixture())});
    const body=route.request().postDataJSON?.()||{};
    if(body.action==="select"){
      selectedRuntime=body.runtime||selectedRuntime;
      const snapshot=runtimeFixture();
      const instance=snapshot.instances.find(item=>item.id===(body.instanceId||snapshot.selectedInstanceId))||snapshot.instances.find(item=>item.kind===selectedRuntime);
      const status=snapshot.statuses.find(item=>item.id===instance?.id)||{id:instance?.id,kind:selectedRuntime,available:true};
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({...snapshot,selected:{runtime:selectedRuntime,instance,status}})});
    }
    return route.continue();
  });
  await page.route("**/api/settings",async route=>{
    if(route.request().method()==="GET")return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({...baseSettings,agentRuntime:selectedRuntime,agentRuntimeInstanceId:selectedRuntime+"-default"})});
    return route.continue();
  });
  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
  await page.locator(".agent-runtime-option").filter({hasText:"Claude Code"}).locator("button").first().click();
  await expect(page.locator(".agent-runtime-option").filter({hasText:"Claude Code"}).getByText("Active",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Add profile",exact:true}).click();
  const editor=page.locator(".runtime-profile-editor");
  await expect(editor).toBeVisible();
  const threshold=editor.getByLabel("Auto-compact after");
  await expect(threshold).toBeVisible();
  await threshold.fill("300000");
  await expect(threshold).toHaveValue("300000");
  const metrics=await editor.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"settings-claude-profile-1600x980.png",fullPage:true});
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"settings-claude-profile-1280x800.png",fullPage:true});
  await page.getByRole("button",{name:"Threads",exact:true}).click();
  await page.getByTestId("right-panel-toggle").click();
  await expect(page.getByTestId("right-panel").getByRole("button",{name:"Agents",exact:true})).toHaveCount(0);
  await page.screenshot({path:auditDir+"claude-right-panel-no-agents-1280x800.png",fullPage:true});
});

test("major workspace surfaces render their real destinations without horizontal overflow",async({page,request})=>{
  test.setTimeout(55_000);
  await prepare(page,request);
  const assertNoHorizontalOverflow=async selector=>{
    const target=page.locator(selector);
    await expect(target).toBeVisible();
    const metrics=await target.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  };

  const projectCrumb=page.locator(".workspace-breadcrumb .project-crumb").first();
  await expect(projectCrumb).toHaveAttribute("title","Projects and workspaces");
  await projectCrumb.click();
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  await expect(page.getByRole("button",{name:"Add local project",exact:true})).toHaveCount(0);
  await expect(page.locator(".clone-card")).toHaveCount(0);
  const generalChatCard=page.locator(".general-chat-card");
  await expect(generalChatCard).toBeVisible();
  expect(await generalChatCard.evaluate(node=>getComputedStyle(node).display)).toBe("grid");
  await assertNoHorizontalOverflow(".secondary-page");
  await page.screenshot({path:auditDir+"projects-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:"History",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Thread history",level:1})).toBeVisible();
  await expect(page.locator(".history-empty")).toBeVisible();
  await assertNoHorizontalOverflow(".secondary-page");
  await page.screenshot({path:auditDir+"history-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:"Usage",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();
  await assertNoHorizontalOverflow(".secondary-page");
  await page.screenshot({path:auditDir+"usage-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:"Tools",exact:true}).click();
  await expect(page.locator("main")).toContainText(/Harness capabilities|Codex harness is not connected/);
  const toolsEmpty=page.locator(".capabilities-empty-state");
  if(await toolsEmpty.count())expect((await toolsEmpty.boundingBox()).height).toBeLessThan(230);
  await assertNoHorizontalOverflow(".secondary-page");
  await page.screenshot({path:auditDir+"tools-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:"Environments",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Environments & remote access",level:2})).toBeVisible();
  await expect(page.locator(".environments-page")).toContainText("Run the active coding-agent runtime");
  const addEnvironment=page.locator(".environment-create .primary");
  await expect(addEnvironment).toBeVisible();
  expect(await addEnvironment.evaluate(node=>getComputedStyle(node).backgroundColor)).not.toBe("rgb(221, 223, 226)");
  await assertNoHorizontalOverflow(".secondary-page");
  await page.screenshot({path:auditDir+"environments-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:"Agents",exact:true}).click();
  await expect(page.getByTestId("right-panel")).toBeVisible();
  await expect(page.getByRole("button",{name:"Agents",exact:true}).last()).toHaveClass(/active/);
  const agentEmpty=page.locator(".agent-empty-state");
  await expect(agentEmpty).toBeVisible();
  expect((await agentEmpty.boundingBox()).height).toBeLessThan(230);
  await page.screenshot({path:auditDir+"agents-panel-1600x980.png",fullPage:true});

  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"agents-panel-1280x800.png",fullPage:true});
});

test("project and environment configuration forms stay readable when expanded",async({page,request})=>{
  test.setTimeout(50_000);
  await prepare(page,request);
  await request.post("/api/environments",{data:{id:"visual-ssh",name:"Visual SSH",type:"ssh",host:"example.invalid",user:"dev",cwd:"/srv/app",port:22}});

  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  const cloneCard=page.locator(".clone-card");
  await expect(cloneCard).toBeVisible();
  await expect(cloneCard.getByLabel("Clone environment").locator('option[value="local"]')).toHaveCount(0);
  await cloneCard.getByLabel("Clone environment").selectOption("visual-ssh");
  await expect(cloneCard.getByLabel("Clone parent directory")).toBeVisible();
  await cloneCard.getByLabel("Clone URL").fill("https://github.com/example/visual-audit.git");
  await cloneCard.getByLabel("Clone parent directory").fill("/srv/projects");
  const cloneMetrics=await cloneCard.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(cloneMetrics.scroll).toBeLessThanOrEqual(cloneMetrics.client+1);

  const projectCard=page.locator(".project-card").first();
  await expect(projectCard).toBeVisible();
  await projectCard.getByRole("button",{name:"Project identity"}).click();
  await expect(projectCard.locator(".project-identity-editor")).toBeVisible();
  await projectCard.getByRole("button",{name:"Add action"}).click();
  await expect(projectCard.locator(".project-action-editor")).toBeVisible();
  const projectMetrics=await projectCard.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(projectMetrics.scroll).toBeLessThanOrEqual(projectMetrics.client+1);
  await page.screenshot({path:auditDir+"projects-expanded-1600x980.png",fullPage:true});

  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"projects-expanded-1280x800.png",fullPage:true});

  await page.route(/\/api\/environments$/,async route=>{
    if(route.request().method()!=="GET")return route.continue();
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      profiles:[],activeEnvironmentId:null,activeEnvironment:null,
      capabilities:{local:{available:true},wsl:{available:true,distros:["Ubuntu-24.04"]},ssh:{available:true,version:"OpenSSH_for_Windows_9.5"}},
    })});
  });
  await page.route(/\/api\/remote-access$/,async route=>{
    if(route.request().method()!=="GET")return route.continue();
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,running:false,port:3211,urls:[],devices:[]})});
  });
  await page.getByRole("button",{name:"Environments",exact:true}).click();
  const addCard=page.locator(".environment-create");
  await expect(addCard).toBeVisible();
  await addCard.getByLabel("Type").selectOption("ssh");
  await expect(addCard.getByLabel("Host")).toBeVisible();
  await addCard.getByLabel("Name").fill("Production sandbox");
  await addCard.getByLabel("Working directory").fill("/srv/trebell");
  await addCard.getByLabel("Host").fill("dev.example.com");
  await addCard.getByLabel("User").fill("trebell");
  const envMetrics=await addCard.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(envMetrics.scroll).toBeLessThanOrEqual(envMetrics.client+1);
  await page.screenshot({path:auditDir+"environments-ssh-form-1280x800.png",fullPage:true});
});

test("project refresh and removal failures preserve the existing project card",async({page,request})=>{
  test.setTimeout(30_000);
  await prepare(page,request);
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  const projectCard=page.locator(".project-card").first();
  await expect(projectCard).toBeVisible();
  const projectName=(await projectCard.locator(".project-open strong").first().textContent())?.trim()||"project";

  await page.route(/\/api\/projects(?:\?.*)?$/,route=>{
    if(route.request().method()==="GET")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate project refresh failure"})});
    if(route.request().method()==="DELETE")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate project removal failure"})});
    return route.continue();
  });

  await page.getByRole("button",{name:"Refresh projects",exact:true}).click();
  const alert=page.getByRole("alert");
  await expect(alert).toContainText("Deliberate project refresh failure");
  await expect(projectCard.locator(".project-open strong").first()).toHaveText(projectName);

  await projectCard.locator(".project-remove").click();
  await expect(alert).toContainText("Deliberate project removal failure");
  await expect(projectCard).toBeVisible();
  await page.setViewportSize({width:1280,height:800});
  const metrics=await page.locator(".projects-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"projects-action-error-1280x800.png",fullPage:true});
});

test("General chat start failures stay on Projects with visible feedback",async({page,request})=>{
  test.setTimeout(30_000);
  await prepare(page,request);
  await page.route(/\/api\/general-workspace$/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate General chat workspace failure"})}));
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  const general=page.getByRole("button",{name:/No project · General chat/});
  await expect(general).toBeVisible();
  await general.click();
  await expect(page.getByRole("alert")).toContainText("Could not start General chat: Deliberate General chat workspace failure");
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  await expect(general).toBeVisible();
  await expect(general).toContainText("Start chat");
  await page.setViewportSize({width:1280,height:800});
  const metrics=await page.locator(".projects-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"general-chat-start-error-1280x800.png",fullPage:true});
});

test("cross-environment project activation rolls back when project activation fails",async({page,request})=>{
  test.setTimeout(35_000);
  await prepare(page,request);
  const baseBootstrap=await (await request.get("/api/bootstrap")).json();
  const projectData=await (await request.get("/api/projects")).json();
  const currentProject=(projectData.projects||[]).find(item=>item.path===baseBootstrap.cwd)||(projectData.projects||[])[0];
  expect(currentProject).toBeTruthy();
  const remoteEnvironment={id:"env-rollback-fixture",name:"Rollback SSH",type:"ssh",enabled:true};
  const remoteProject={id:"remote-rollback-project",name:"Remote Rollback Project",path:"/srv/rollback-fixture",environmentId:remoteEnvironment.id,environment:remoteEnvironment,effectiveSettings:{},lastOpenedAt:new Date().toISOString()};
  let activeEnvironmentId=null;
  const activationCalls=[];
  await page.route(/\/api\/environment\/activate$/,route=>{
    const body=route.request().postDataJSON()||{};
    activeEnvironmentId=body.id||null;activationCalls.push(activeEnvironmentId);
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({activeEnvironmentId,activeEnvironment:activeEnvironmentId?remoteEnvironment:null,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,error:null})});
  });
  await page.route(/\/api\/settings$/,route=>{
    if(route.request().method()!=="GET")return route.continue();
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",activeEnvironmentId})});
  });
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({...baseBootstrap,activeEnvironmentId,activeEnvironment:activeEnvironmentId?remoteEnvironment:null})}));
  await page.route(/\/api\/environment\/themes(?:\?|$)/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:activeEnvironmentId||"local",environmentName:activeEnvironmentId?remoteEnvironment.name:"Local machine",directory:"",themes:[]})}));
  await page.route(/\/api\/projects$/,route=>{
    if(route.request().method()==="POST"&&route.request().postDataJSON()?.path===remoteProject.path){
      return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate remote project activation failure"})});
    }
    if(route.request().method()==="GET")return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[currentProject,remoteProject]})});
    return route.continue();
  });
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  const currentCard=page.locator(".project-card").filter({hasText:currentProject.name}).first();
  const remoteCard=page.locator(".project-card").filter({hasText:"Remote Rollback Project"});
  await expect(currentCard).toHaveClass(/active/);
  await expect(remoteCard).toBeVisible();
  await remoteCard.locator(".project-open").click();
  await expect(page.getByRole("alert")).toContainText("Deliberate remote project activation failure");
  await expect.poll(()=>activationCalls).toEqual([remoteEnvironment.id,null]);
  expect(activeEnvironmentId).toBeNull();
  await expect(currentCard).toHaveClass(/active/);
  await expect(remoteCard).not.toHaveClass(/active/);
  await page.setViewportSize({width:1280,height:800});
  const projects=page.locator(".projects-page");
  const metrics=await projects.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"projects-environment-rollback-error-1280x800.png",fullPage:true});
});

test("environment refresh and removal failures preserve the existing environment",async({page,request})=>{
  test.setTimeout(30_000);
  await prepare(page,request);
  await request.post("/api/environments",{data:{id:"failure-ssh",name:"Failure SSH",type:"ssh",host:"failure.example.invalid",user:"dev",cwd:"/srv/failure",port:22}});
  await page.getByRole("button",{name:"Environments",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Environments & remote access",level:2})).toBeVisible();
  const environmentRow=page.locator(".environment-list>div").filter({hasText:"Failure SSH"});
  await expect(environmentRow).toBeVisible();

  await page.route(/\/api\/environments(?:\?.*)?$/,route=>{
    if(route.request().method()==="GET")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate environment refresh failure"})});
    if(route.request().method()==="DELETE")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate environment removal failure"})});
    return route.continue();
  });

  await page.locator(".capabilities-toolbar").getByRole("button",{name:"Refresh",exact:true}).click();
  const status=page.getByRole("status");
  await expect(status).toContainText("Deliberate environment refresh failure");
  await expect(environmentRow).toBeVisible();

  await environmentRow.getByRole("button",{name:"Remove Failure SSH",exact:true}).click();
  await expect(status).toContainText("Deliberate environment removal failure");
  await expect(environmentRow).toBeVisible();
  await page.setViewportSize({width:1280,height:800});
  const metrics=await page.locator(".environments-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"environments-action-error-1280x800.png",fullPage:true});
});

test("workspace file refresh and save failures stay visible without lying about state",async({page,request})=>{
  test.setTimeout(35_000);
  await prepare(page,request);
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  await expect(panel).toBeVisible();
  const search=panel.getByPlaceholder("Search files…");
  await search.fill("package.json");
  const packageFile=panel.locator(".tree-list button").filter({hasText:"package.json"}).first();
  await expect(packageFile).toBeVisible();
  await packageFile.click();
  await expect(panel.locator(".file-head strong")).toContainText("package.json");
  await expect(panel.locator(".syntax-view")).toBeVisible();

  let failTree=false;
  await page.route(/\/api\/workspace\/tree\?/,route=>{
    if(failTree)return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate workspace tree refresh failure"})});
    return route.continue();
  });
  failTree=true;
  await panel.getByRole("button",{name:"Refresh workspace files",exact:true}).click();
  await expect(panel.locator(".workspace-tree-error")).toContainText("Deliberate workspace tree refresh failure");
  await expect(packageFile).toBeVisible();

  await panel.getByRole("button",{name:"Edit",exact:true}).click();
  const editor=panel.locator(".file-editor");
  await expect(editor).toBeVisible();
  const original=await editor.inputValue();
  await editor.fill(original+"\n");
  await page.route(/\/api\/workspace\/file$/,route=>{
    if(route.request().method()==="PUT")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate workspace save failure"})});
    return route.continue();
  });
  await panel.getByRole("button",{name:"Save",exact:true}).click();
  await expect(panel.locator(".workspace-file-error")).toContainText("Deliberate workspace save failure");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(original+"\n");
  await page.setViewportSize({width:1280,height:800});
  const metrics=await panel.locator(".context-panel-body").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"workspace-file-action-error-1280x800.png",fullPage:true});
});

test("Diff review actions roll back and stay visible when persistence fails",async({page})=>{
  test.setTimeout(40_000);
  const thread={
    id:"diff-review-thread",
    name:"Diff review fixture",
    preview:"Review persistence coverage",
    cwd:process.cwd(),
    createdAt:Date.now()/1000-20,
    updatedAt:Date.now()/1000,
    turns:[],
  };
  const project={id:"diff-review-project",name:"Diff Review Project",path:process.cwd(),environmentId:null,effectiveSettings:{},scripts:[]};
  const wsHttp=createServer();const wss=new WebSocketServer({noServer:true});const sockets=new Set();
  wsHttp.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      let result={};
      if(message.method==="initialize")result={userAgent:"diff-review-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result={thread};
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/turns/list")result={data:[],nextCursor:null};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const wsPort=await freePort();await new Promise((resolve,reject)=>wsHttp.listen(wsPort,"127.0.0.1",resolve).once("error",reject));
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"opencode",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",activeProjectId:project.id};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"opencode",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${wsPort}`,cwd:process.cwd(),platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[project],threadMeta:{[thread.id]:{projectless:false,environmentId:null,reviewedFiles:[]}}})}));
    await page.route(/\/api\/settings$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(settings)}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["opencode/test-model"],metadata:{provider:"opencode",models:[{id:"opencode/test-model",name:"Test model",provider:"opencode"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[project],project})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({checkpoints:[]})}));
    await page.route(/\/api\/git\/info\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,root:process.cwd(),branch:"main",branches:["main"],upstream:"origin/main",status:[{code:" M",path:"ui/src/App.jsx"}],remotes:[],worktrees:[]})}));
    await page.route(/\/api\/workspace\/tree\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({entries:[]})}));
    await page.route(/\/api\/workspace\/diff\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      status:" M ui/src/App.jsx",
      diff:"diff --git a/ui/src/App.jsx b/ui/src/App.jsx\n--- a/ui/src/App.jsx\n+++ b/ui/src/App.jsx\n@@ -1 +1 @@\n-old\n+new",
    })}));
    await page.route(/\/api\/thread-meta$/,route=>{
      if(route.request().method()==="POST")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate reviewed metadata failure"})});
      return route.continue();
    });
    await page.route(/\/api\/attachments\/text$/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate review comment attachment failure"})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    await page.locator('.thread-main[title="Diff review fixture"]').click();
    await expect(page.locator(".thread-row.active .thread-main")).toHaveAttribute("title","Diff review fixture");

    await page.getByTestId("right-panel-toggle").click();
    const panel=page.getByTestId("right-panel");
    await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Diff",exact:true}).click();
    const row=panel.locator(".changed-file-row").filter({hasText:"ui/src/App.jsx"});
    await expect(row).toBeVisible();
    await expect(row).not.toHaveClass(/reviewed/);
    await row.locator("button").first().click();
    const alert=panel.getByRole("alert");
    await expect(alert).toContainText("Could not update reviewed state: Deliberate reviewed metadata failure");
    await expect(row).not.toHaveClass(/reviewed/);

    page.once("dialog",dialog=>dialog.accept("Retry this review note"));
    await row.locator(".review-comment").click();
    await expect(alert).toContainText("Could not attach review comment: Deliberate review comment attachment failure");
    await expect(panel.locator(".git-diff")).toContainText("+new");
    await page.setViewportSize({width:1280,height:800});
    const metrics=await panel.locator(".context-panel-body").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await page.screenshot({path:auditDir+"workspace-diff-action-error-1280x800.png",fullPage:true});
  }finally{
    for(const ws of sockets)try{ws.terminate()}catch{}
    wss.close();await new Promise(resolve=>wsHttp.close(resolve));
  }
});

test("open externally failures stay visible beside the editor picker",async({page,request})=>{
  test.setTimeout(30_000);
  await page.addInitScript(()=>{
    Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{
      openIn:{
        list:async()=>({editors:[{id:"vscode",label:"Visual Studio Code"}]}),
        open:async()=>{throw new Error("Deliberate external editor launch failure")},
      },
    }});
  });
  await prepare(page,request);
  const picker=page.locator(".workspace-header .open-in-wrap");
  await expect(picker).toBeVisible();
  await picker.getByRole("button",{name:"Open",exact:true}).click();
  await expect(picker.getByRole("alert")).toContainText("Deliberate external editor launch failure");
  await expect(picker.getByLabel("Choose external editor")).toHaveValue("vscode");
  await page.setViewportSize({width:1280,height:800});
  const header=page.locator(".workspace-header");
  const metrics=await header.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"open-in-editor-error-1280x800.png",fullPage:true});
});

test("failed workspace activation leaves the current project untouched",async({page,request})=>{
  test.setTimeout(30_000);
  await page.addInitScript(()=>{
    Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{
      pickDirectory:async()=>"C:\\Rejected Workspace",
    }});
  });
  await prepare(page,request);
  const crumb=page.locator(".workspace-breadcrumb .project-crumb").filter({hasNot:page.locator(".sidebar-reopen")}).first();
  const beforeText=(await crumb.textContent())?.trim();
  const beforeTitle=await crumb.getAttribute("title");
  await page.route(/\/api\/projects$/,route=>{
    if(route.request().method()==="POST")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate project activation failure"})});
    return route.continue();
  });
  await crumb.click();
  await expect(page.getByTestId("app-action-error")).toContainText("Could not open workspace: Deliberate project activation failure");
  await expect(crumb).toHaveText(beforeText||"");
  await expect(crumb).toHaveAttribute("title",beforeTitle||"");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"workspace-activation-error-1280x800.png",fullPage:true});
});

test("usage clear failures keep recorded usage visible",async({page,request})=>{
  test.setTimeout(30_000);
  await prepare(page,request);
  const record={
    id:"usage-failure-record",
    at:new Date().toISOString(),
    environmentId:null,
    runtime:"codex",
    provider:"freebuff",
    model:"freebuff/test/coding-fast",
    usage:{inputTokens:1200,outputTokens:300,cachedInputTokens:200,reasoningOutputTokens:50,totalTokens:1500},
    cost:{currency:"USD",amount:0.0123},
  };
  await page.route(/\/api\/usage(?:\?|$)/,route=>{
    if(route.request().method()==="DELETE")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate usage clear failure"})});
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      records:[record],
      total:{inputTokens:1200,outputTokens:300,cachedInputTokens:200,reasoningOutputTokens:50,totalTokens:1500},
      models:{"freebuff/test/coding-fast":{totalTokens:1500,turns:1}},
      runtimes:{codex:{totalTokens:1500,turns:1}},
      daily:{[record.at.slice(0,10)]:{tokens:1500,turns:1}},
    })});
  });
  await page.getByRole("button",{name:"Usage",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();
  const recent=page.locator(".usage-recent");
  await expect(recent).toContainText("freebuff/test/coding-fast");
  await expect(page.getByRole("button",{name:"Clear local history",exact:true})).toBeEnabled();
  page.once("dialog",dialog=>dialog.accept());
  await page.getByRole("button",{name:"Clear local history",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("Deliberate usage clear failure");
  await expect(recent).toContainText("freebuff/test/coding-fast");
  await page.setViewportSize({width:1280,height:800});
  const metrics=await page.locator(".usage-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"usage-clear-error-1280x800.png",fullPage:true});
});

test("right panel tabs are functional and visually bounded",async({page,request})=>{
  test.setTimeout(60_000);
  await prepare(page,request);
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  const body=panel.locator(".context-panel-body");
  const tabStrip=panel.locator(".context-panel-tab-scroll");
  await expect(panel).toBeVisible();
  const assertPanelBounded=async()=>{
    const metrics=await body.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  };
  const tabs=[
    ["Files","files"],
    ["Diff","diff"],
    ["Browser","browser"],
    ["Git","git"],
    ["Device","device"],
    ["Agents","agents"],
    ["Goal","goal"],
    ["Runtime","runtime"],
  ];
  for(const [label,slug] of tabs){
    const tab=tabStrip.getByRole("button",{name:label,exact:true});
    await expect(tab).toBeEnabled();
    await tab.click();
    await expect(tab).toHaveClass(/active/);
    if(label==="Browser"||label==="Agents")await expect(page.locator(`.sidebar .sidebar-utility[aria-label="${label}"]`)).toHaveClass(/active/);
    if(label==="Files"){
      const search=panel.getByPlaceholder("Search files…");
      await search.fill("package.json");
      const packageFile=panel.locator(".tree-list button").filter({hasText:"package.json"}).first();
      await expect(packageFile).toBeVisible();
      await packageFile.click();
      await expect(panel.locator(".file-head strong")).toContainText("package.json");
      await expect(panel.locator(".syntax-view")).toBeVisible();
      await page.screenshot({path:auditDir+"panel-files-open-1600x980.png",fullPage:true});
      await panel.getByRole("button",{name:"Edit",exact:true}).click();
      await expect(panel.locator(".file-editor")).toBeVisible();
      await page.screenshot({path:auditDir+"panel-files-edit-1600x980.png",fullPage:true});
      await panel.getByRole("button",{name:"Cancel",exact:true}).click();
      await search.fill("");
    }
    if(label==="Diff")await expect(panel.locator(".changes-empty")).toBeVisible();
    if(label==="Browser"){
      await expect(panel.locator(".preview-empty-state")).toBeVisible();
      await expect(panel).toContainText("Desktop Agent Browser is unavailable here");
      await expect(panel.locator(".agent-browser-toolbar")).toHaveCount(0);
      await expect(panel.locator(".browser-device-toolbar")).toHaveCount(0);
      await expect(panel.locator(".browser-inspector")).toHaveCount(0);
      await expect(page.locator('.sidebar-utility[aria-label="Browser"]')).toHaveClass(/active/);
    }
    if(label==="Git"){
      await expect(panel.locator(".source-provider-field")).toBeVisible();
      await expect(panel.locator(".pr-empty-state")).toBeVisible();
    }
    if(label==="Device")await expect(panel.locator(".device-panel")).toBeVisible();
    if(label==="Goal"){
      await expect(panel).toContainText("No active thread");
      await expect(panel).not.toContainText("Codex");
    }
    if(label==="Agents"){
      await expect(panel.locator(".collaboration-card")).toBeVisible();
      await expect(panel.locator(".agent-empty-state")).toBeVisible();
      await expect(page.locator('.sidebar-utility[aria-label="Agents"]')).toHaveClass(/active/);
    }
    await assertPanelBounded();
    await page.screenshot({path:auditDir+"panel-"+slug+"-1600x980.png",fullPage:true});
  }
  await page.setViewportSize({width:1280,height:800});
  await tabStrip.getByRole("button",{name:"Browser",exact:true}).click();
  await assertPanelBounded();
  await page.screenshot({path:auditDir+"panel-browser-1280x800.png",fullPage:true});
  await page.setViewportSize({width:1600,height:980});
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await tabStrip.getByRole("button",{name:"Device",exact:true}).click();
  const deviceLight=await panel.evaluate(node=>({
    panel:getComputedStyle(node.querySelector(".device-panel")).backgroundColor,
    tooling:getComputedStyle(node.querySelector(".device-tooling")).backgroundColor,
    select:getComputedStyle(node.querySelector(".device-toolbar select")).backgroundColor,
    button:getComputedStyle(node.querySelector(".device-tooling button")).backgroundColor,
  }));
  for(const value of Object.values(deviceLight))expect(value).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  await page.screenshot({path:auditDir+"panel-device-light-1600x980.png",fullPage:true});
  await tabStrip.getByRole("button",{name:"Agents",exact:true}).click();
  const agentsLight=await panel.evaluate(node=>({
    collaboration:getComputedStyle(node.querySelector(".collaboration-card")).backgroundColor,
    empty:getComputedStyle(node.querySelector(".agent-empty-state")).backgroundColor,
    refresh:getComputedStyle(node.querySelector(".agent-refresh")).backgroundColor,
    fleet:getComputedStyle(node.querySelector(".agent-fleet-stats span")).backgroundColor,
  }));
  for(const value of Object.values(agentsLight))expect(value).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  await page.screenshot({path:auditDir+"panel-agents-light-1600x980.png",fullPage:true});
});

test("failed device typing keeps the text available for retry",async({page,request})=>{
  test.setTimeout(30_000);
  await page.route(/\/api\/devices$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    capabilities:{android:{available:true,sdkManagerAvailable:false,tools:[]},ios:{available:false}},
    devices:[{id:"emulator-5554",name:"Pixel Fixture",platform:"android",state:"device",running:true}],
    avds:[],
  })}));
  await page.route(/\/api\/device\/screenshot\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({width:1080,height:1920,dataUrl:null})}));
  await page.route(/\/api\/device\/action$/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate device typing failure"})}));
  await prepare(page,request);
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Device",exact:true}).click();
  const input=panel.getByPlaceholder("Type into focused emulator control");
  await expect(input).toBeVisible();
  await input.fill("retry this text");
  await panel.locator(".device-type").getByRole("button",{name:"Send",exact:true}).click();
  await expect(panel.locator(".inline-status")).toContainText("Deliberate device typing failure");
  await expect(input).toHaveValue("retry this text");
  await page.setViewportSize({width:1280,height:800});
  const metrics=await panel.locator(".context-panel-body").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"device-type-error-1280x800.png",fullPage:true});
});

test("Agent Browser action failures stay visible instead of disappearing",async({page,request})=>{
  test.setTimeout(30_000);
  await page.addInitScript(()=>{
    Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{
      browser:{
        state:async()=>({open:false,url:"",title:"",canGoBack:false,canGoForward:false,loading:false,width:1280,height:800}),
        onState:()=>()=>{},
        navigate:async()=>{throw new Error("Deliberate Agent Browser navigation failure")},
        snapshot:async()=>({url:"",title:"",elements:[]}),
      },
    }});
  });
  await prepare(page,request);
  await page.locator('.sidebar .sidebar-utility[aria-label="Browser"]').click();
  const panel=page.getByTestId("right-panel");
  await expect(panel).toBeVisible();
  const openAgentBrowser=panel.getByRole("button",{name:"Open agent browser",exact:true});
  await expect(openAgentBrowser).toBeVisible();
  await panel.locator(".preview-bar input").fill("http://fixture.invalid/");
  await openAgentBrowser.click();
  await expect(panel.getByRole("alert")).toContainText("Deliberate Agent Browser navigation failure");
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"agent-browser-action-error-1280x800.png",fullPage:true});
});

test("Agent Browser annotation attachment failures keep the note for retry",async({page,request})=>{
  test.setTimeout(30_000);
  await page.addInitScript(()=>{
    Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{
      browser:{
        state:async()=>({open:true,url:"https://fixture.invalid/",title:"Fixture page",canGoBack:false,canGoForward:false,loading:false,width:1280,height:800}),
        onState:()=>()=>{},
        snapshot:async()=>({url:"https://fixture.invalid/",title:"Fixture page",elements:[{ref:"e1",tag:"button",text:"Save profile",href:""}]}),
      },
    }});
  });
  await prepare(page,request);
  await page.route(/\/api\/attachments\/text$/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate browser annotation attachment failure"})}));
  await page.locator('.sidebar .sidebar-utility[aria-label="Browser"]').click();
  const panel=page.getByTestId("right-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("button",{name:"Inspect elements",exact:true}).click();
  const element=panel.locator(".browser-elements button").filter({hasText:"Save profile"});
  await expect(element).toBeVisible();
  await element.click();
  const annotation=panel.getByTestId("preview-annotation");
  const note="Do not lose this retry note";
  await annotation.locator("textarea").fill(note);
  await annotation.getByRole("button",{name:"Attach annotation",exact:true}).click();
  await expect(panel.getByRole("alert")).toContainText("Deliberate browser annotation attachment failure");
  await expect(annotation.locator("textarea")).toHaveValue(note);
  await expect(annotation).not.toContainText("Annotation attached");
  await page.setViewportSize({width:1280,height:800});
  const metrics=await panel.locator(".context-panel-body").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"agent-browser-annotation-error-1280x800.png",fullPage:true});
});

test("populated chat and overlays remain visually usable",async({page,request})=>{
  test.setTimeout(45_000);
  await prepare(page,request);
  const composer=page.getByTestId("composer");
  const longToken="very-long-generated-path-"+"x".repeat(180);
  const prompt=[
    "Please inspect this sample output:",
    longToken,
    "",
    "function example(value) {",
    "  return value + 1;",
    "}",
  ].join("\n");
  await composer.fill(prompt);
  await page.getByTestId("send").click();
  await expect(page.locator(".user-bubble")).toContainText("Please inspect this sample output");
  await expect(page.locator(".assistant-message-text")).toContainText("Mock Freebuff reply:");
  const conversation=page.locator(".conversation-column");
  const chatMetrics=await conversation.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(chatMetrics.scroll).toBeLessThanOrEqual(chatMetrics.client+1);
  await page.screenshot({path:auditDir+"chat-populated-1600x980.png",fullPage:true});

  const assistantText=page.locator(".assistant-message-text").last();
  await page.setViewportSize({width:1280,height:800});
  await assistantText.evaluate(node=>{
    const selection=window.getSelection();
    selection.removeAllRanges();
    selection.selectAllChildren(node);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const citeSelection=page.getByTestId("assistant-selection-cite");
  await expect(citeSelection).toBeVisible();
  await expect(page.getByRole("button",{name:"Cite response",exact:true})).toHaveCount(0);
  await page.screenshot({path:auditDir+"chat-assistant-selection-cite-1600x980.png",fullPage:true});
  await citeSelection.click();
  const citationChip=page.getByTestId("context-chip").filter({hasText:"Assistant excerpt"});
  await expect(citationChip).toBeVisible();
  await expect(composer).toHaveValue(/cited assistant excerpt/i);
  await page.screenshot({path:auditDir+"chat-assistant-selection-context-1600x980.png",fullPage:true});
  await citationChip.getByTitle("Remove context").click();
  await composer.fill("");

  await page.keyboard.press("Control+k");
  const palette=page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await page.screenshot({path:auditDir+"chat-command-palette-1600x980.png",fullPage:true});
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.getByTestId("right-panel-toggle").click();
  await page.getByTestId("terminal-toggle").click();
  await expect(page.getByTestId("right-panel")).toBeVisible();
  await expect(page.getByTestId("drawer")).toBeVisible();
  const main=await box(page.locator(".main-frame"));
  const compose=await box(page.locator(".composer-wrap"));
  expect(compose.x).toBeGreaterThanOrEqual(main.x);
  expect(compose.x+compose.width).toBeLessThanOrEqual(main.x+main.width+1);
  await page.screenshot({path:auditDir+"chat-populated-panels-1600x980.png",fullPage:true});

  await page.setViewportSize({width:1280,height:800});
  const compactChat=await conversation.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(compactChat.scroll).toBeLessThanOrEqual(compactChat.client+1);
  const compactLeft=await box(page.locator(".composer-left")),compactRight=await box(page.locator(".composer-right"));
  expect(compactRight.y).toBeGreaterThan(compactLeft.y+10);
  expect((await box(page.locator(".permission-picker").first())).width).toBeGreaterThanOrEqual(100);
  expect((await box(page.locator(".workspace-mode"))).width).toBeGreaterThanOrEqual(125);
  await page.screenshot({path:auditDir+"chat-populated-1280x800.png",fullPage:true});
});

test("failed assistant citations keep the selected excerpt available for retry",async({page,request})=>{
  test.setTimeout(35_000);
  await prepare(page,request);
  const composer=page.getByTestId("composer");
  await composer.fill("Create a citation failure fixture.");
  await page.getByTestId("send").click();
  const assistantText=page.locator(".assistant-message-text").last();
  await expect(assistantText).toContainText("Mock Freebuff reply:");
  await composer.fill("Keep this draft");
  await page.route(/\/api\/attachments\/text$/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate assistant citation failure"})}));
  await assistantText.evaluate(node=>{
    const selection=window.getSelection();selection.removeAllRanges();
    const range=document.createRange();range.selectNodeContents(node);selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const cite=page.getByTestId("assistant-selection-cite");
  await expect(cite).toBeVisible();
  await cite.click();
  const alert=page.getByTestId("app-action-error");
  await expect(alert).toContainText("Could not cite assistant text: Deliberate assistant citation failure");
  await expect(cite).toBeVisible();
  await expect(cite).toHaveText("Cite");
  await expect(page.getByTestId("context-chips")).toHaveCount(0);
  await expect(composer).toHaveValue("Keep this draft");
  await expect(alert).toBeInViewport();
  await expect(cite).toBeInViewport();
  await page.screenshot({path:auditDir+"assistant-citation-error-1280x800.png",fullPage:true});
});

test("onboarding and license surfaces are visually intentional",async({page,request})=>{
  test.setTimeout(45_000);
  await request.post("/api/settings",{data:{onboardingComplete:false,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"}});
  await page.goto("/");
  const onboarding=page.getByTestId("onboarding");
  await expect(onboarding).toBeVisible();
  await expect(onboarding.getByRole("button",{name:/Choose folder|Change/})).toHaveCount(0);
  await expect(onboarding.locator(".onboarding-static-workspace")).toBeVisible();
  const dialog=onboarding.getByRole("dialog",{name:"Set up Trebell Code"});
  const onboardingBox=await box(dialog);
  expect(onboardingBox.width).toBeLessThanOrEqual(660);
  expect(onboardingBox.height).toBeLessThan(page.viewportSize().height-30);
  await page.screenshot({path:auditDir+"onboarding-1600x980.png",fullPage:true});
  await page.setViewportSize({width:1280,height:800});
  const compactOnboarding=await box(dialog);
  expect(compactOnboarding.width).toBeLessThanOrEqual(660);
  expect(compactOnboarding.height).toBeLessThanOrEqual(770);
  await page.screenshot({path:auditDir+"onboarding-1280x800.png",fullPage:true});
  await onboarding.getByRole("button",{name:"Finish setup"}).click();
  await expect(onboarding).toBeHidden();

  await page.route(/\/api\/licenses$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[
    {id:"react@19.1.1",name:"react",version:"19.1.1",license:"MIT",component:"UI runtime"},
    {id:"playwright@1.55.0",name:"playwright",version:"1.55.0",license:"Apache-2.0",component:"Testing"},
    {id:"electron@38.1.2",name:"electron",version:"38.1.2",license:"MIT",component:"Desktop runtime"},
  ]})}));
  await page.route(/\/api\/licenses\/detail\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    id:"react@19.1.1",name:"react",version:"19.1.1",license:"MIT",homepage:"https://react.dev",text:"MIT License\n\nCopyright fixture authors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy...",
  })}));
  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("button",{name:/General/}).click();
  await page.getByRole("button",{name:"View licenses"}).click();
  await expect(page.getByRole("heading",{name:"Open source licenses",level:1})).toBeVisible();
  const licenses=page.locator(".licenses-page");
  await expect(licenses).toBeVisible();
  const licenseMetrics=await licenses.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(licenseMetrics.scroll).toBeLessThanOrEqual(licenseMetrics.client+1);
  const toolbarBox=await box(page.locator(".licenses-toolbar")),licenseLayoutBox=await box(page.locator(".licenses-layout"));
  expect(licenseLayoutBox.y-(toolbarBox.y+toolbarBox.height)).toBeLessThanOrEqual(16);
  await page.screenshot({path:auditDir+"licenses-1280x800.png",fullPage:true});
  const firstLicense=page.locator(".licenses-list > button").first();
  await expect(firstLicense).toBeVisible();
  await firstLicense.click();
  await expect(page.locator(".license-detail pre")).toBeVisible();
  await page.screenshot({path:auditDir+"licenses-detail-1280x800.png",fullPage:true});
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  const lightLicenseSurfaces=await page.evaluate(()=>({
    search:getComputedStyle(document.querySelector(".licenses-search")).backgroundColor,
    list:getComputedStyle(document.querySelector(".licenses-list")).backgroundColor,
    detail:getComputedStyle(document.querySelector(".license-detail")).backgroundColor,
    text:getComputedStyle(document.querySelector(".license-detail pre")).backgroundColor,
  }));
  for(const value of Object.values(lightLicenseSurfaces))expect(value).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  await page.screenshot({path:auditDir+"licenses-detail-light-1280x800.png",fullPage:true});
});

test("onboarding finish failures stay visible and keep setup open",async({page,request})=>{
  test.setTimeout(30_000);
  await request.post("/api/settings",{data:{onboardingComplete:false,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"}});
  await page.goto("/");
  const onboarding=page.getByTestId("onboarding");
  await expect(onboarding).toBeVisible();
  await page.route(/\/api\/settings$/,route=>{
    if(route.request().method()==="POST")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate onboarding finish failure"})});
    return route.continue();
  });
  await onboarding.getByRole("button",{name:"Finish setup",exact:true}).click();
  await expect(onboarding.getByRole("alert")).toContainText("Deliberate onboarding finish failure");
  await expect(onboarding).toBeVisible();
  await expect(onboarding.getByRole("button",{name:"Finish setup",exact:true})).toBeEnabled();
  await page.setViewportSize({width:1280,height:800});
  const dialog=onboarding.getByRole("dialog",{name:"Set up Trebell Code"});
  const dimensions=await dialog.evaluate(node=>({client:node.clientHeight,scroll:node.scrollHeight,width:node.getBoundingClientRect().width}));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client+1);
  expect(dimensions.width).toBeLessThanOrEqual(660);
  await page.screenshot({path:auditDir+"onboarding-finish-error-1280x800.png",fullPage:true});
});

test("light mode stays visually coherent across workspace and panels",async({page,request})=>{
  test.setTimeout(40_000);
  await prepare(page,request);
  await page.getByRole("button",{name:"Settings"}).click();
  await expect(page.getByRole("button",{name:/Desktop/})).toHaveCount(0);
  await expect(page.getByRole("heading",{name:"Desktop notifications"})).toHaveCount(0);
  await page.getByLabel("Search settings").fill("browser profiles");
  await expect(page.getByTestId("settings-search-results")).toContainText(/No settings match.*browser profiles/i);
  await page.getByLabel("Search settings").press("Escape");
  await page.getByRole("button",{name:/Appearance/}).click();
  await page.getByRole("button",{name:"light",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.mode)).toBe("light");
  const appearanceButtons=await page.evaluate(()=>[...document.querySelectorAll(".theme-settings button,.environment-theme-settings button")].map(node=>getComputedStyle(node).backgroundColor));
  for(const value of appearanceButtons)expect(value).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  await page.getByLabel("Search settings").fill("command palette");
  await expect(page.getByTestId("settings-search-results").getByRole("button",{name:/Command palette/})).toBeVisible();
  await page.screenshot({path:auditDir+"light-settings-search-1600x980.png",fullPage:true});
  await page.getByLabel("Search settings").press("Escape");
  await page.getByRole("button",{name:/Workspace/}).click();
  await expect(page.getByTestId("settings-scope-sentence")).toBeVisible();
  const workspaceLight=await page.evaluate(()=>({
    heading:getComputedStyle(document.querySelector(".settings-section-head h2")).color,
    cleanup:getComputedStyle(document.querySelector(".scoped-cleanup")).backgroundColor,
    action:getComputedStyle(document.querySelector(".scoped-settings-card > .provider-key-actions button")).backgroundColor,
  }));
  expect(workspaceLight.heading).toBe("rgb(36, 42, 52)");
  expect(workspaceLight.cleanup).toBe("rgb(248, 249, 251)");
  expect(workspaceLight.action).toBe("rgb(255, 255, 255)");
  await page.screenshot({path:auditDir+"light-settings-workspace-scope-1600x980.png",fullPage:true});
  await page.getByRole("button",{name:"Threads"}).click();
  const shell=await page.evaluate(()=>({
    sidebar:getComputedStyle(document.querySelector(".sidebar")).backgroundColor,
    main:getComputedStyle(document.querySelector(".main-frame")).backgroundColor,
    composer:getComputedStyle(document.querySelector(".composer-wrap")).backgroundColor,
  }));
  expect(shell.sidebar).not.toBe("rgb(17, 18, 20)");
  expect(shell.main).not.toBe("rgb(11, 12, 14)");
  expect(shell.composer).toMatch(/^rgba?\(255, 255, 255/);
  await page.screenshot({path:auditDir+"light-chat-1600x980.png",fullPage:true});
  await page.getByTestId("composer").fill("Give me a short light-mode citation fixture.");
  await page.getByTestId("send").click();
  const lightAssistant=page.locator(".assistant-message-text").last();
  await expect(lightAssistant).toContainText("Mock Freebuff reply:");
  await lightAssistant.evaluate(node=>{
    const selection=window.getSelection();selection.removeAllRanges();selection.selectAllChildren(node);document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByTestId("assistant-selection-cite")).toBeVisible();
  await page.screenshot({path:auditDir+"light-chat-assistant-selection-cite-1600x980.png",fullPage:true});
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("assistant-selection-cite")).toBeHidden();
  await page.getByTestId("right-panel-toggle").click();
  await expect(page.getByTestId("right-panel")).toBeVisible();
  await page.screenshot({path:auditDir+"light-chat-panel-1600x980.png",fullPage:true});
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"light-chat-panel-1280x800.png",fullPage:true});
  await page.setViewportSize({width:1600,height:980});
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  await expect(page.locator(".general-chat-card")).toBeVisible();
  await expect(page.getByRole("button",{name:"Add local project",exact:true})).toHaveCount(0);
  const hostedClone=page.locator(".clone-card");
  if(await hostedClone.count())await expect(hostedClone.getByLabel("Clone environment").locator('option[value="local"]')).toHaveCount(0);
  const projectLight=await page.evaluate(()=>({
    general:getComputedStyle(document.querySelector(".general-chat-card")).backgroundColor,
  }));
  expect(projectLight.general).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  await page.screenshot({path:auditDir+"light-projects-1600x980.png",fullPage:true});
  await page.getByRole("button",{name:"Environments",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Environments & remote access",level:2})).toBeVisible();
  const environmentLight=await page.locator(".environment-grid .capability-card").first().evaluate(node=>getComputedStyle(node).backgroundColor);
  expect(environmentLight).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  await page.screenshot({path:auditDir+"light-environments-1600x980.png",fullPage:true});
  await page.getByRole("button",{name:"Threads",exact:true}).click();
  await page.getByRole("button",{name:"History",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Thread history",level:1})).toBeVisible();
  const historyButton=page.locator(".history-page > button").first();
  if(await historyButton.count())expect(await historyButton.evaluate(node=>getComputedStyle(node).backgroundColor)).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  const historyEmptyButton=page.locator(".history-empty button");
  if(await historyEmptyButton.count())expect(await historyEmptyButton.evaluate(node=>getComputedStyle(node).backgroundColor)).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  await page.screenshot({path:auditDir+"light-history-1600x980.png",fullPage:true});
});

test("Freebuff dashboard stays visually coherent in light mode",async({page,request})=>{
  test.setTimeout(30_000);
  await prepare(page,request);
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.locator(".sidebar-provider").click();
  await expect(page.getByRole("heading",{name:"Freebuff",level:1})).toBeVisible();
  await expect(page.locator(".fb-hero")).toBeVisible();
  const surfaces=await page.evaluate(()=>({
    hero:getComputedStyle(document.querySelector(".fb-hero")).backgroundColor,
    card:getComputedStyle(document.querySelector(".fb-dashboard-card")).backgroundColor,
    table:getComputedStyle(document.querySelector(".fb-model-table")).backgroundColor,
    raw:getComputedStyle(document.querySelector(".fb-raw")).backgroundColor,
  }));
  for(const value of Object.values(surfaces))expect(value).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  await page.screenshot({path:auditDir+"freebuff-light-1600x980.png",fullPage:true});
});

test("custom theme stays coherent across chat panel and command palette",async({page,request})=>{
  test.setTimeout(40_000);
  await prepare(page,request);
  const theme={
    id:"visual-aubergine",name:"Visual Aubergine",appearance:"dark",canvas:"#21182b",accent:"#d17aff",
    colors:{foreground:"#f5edf8",success:"#66d59b",error:"#ff8095",warning:"#f0c36a"},
  };
  await request.post("/api/settings",{data:{customThemes:[theme],appearance:theme.id,appearanceMode:"dark"}});
  await page.reload();
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.customTheme)).toBe("true");
  const variables=await page.evaluate(()=>({
    accent:document.documentElement.style.getPropertyValue("--purple").trim(),
    canvas:document.documentElement.style.getPropertyValue("--theme-canvas").trim(),
    foreground:document.documentElement.style.getPropertyValue("--theme-foreground").trim(),
  }));
  expect(variables.accent).toBe("#d17aff");
  expect(variables.foreground).toBe("#f5edf8");
  expect(variables.canvas).toBeTruthy();
  await page.getByTestId("right-panel-toggle").click();
  await expect(page.getByTestId("right-panel")).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await expect(page.getByTestId("command-palette").getByText("Open workspace folder",{exact:true})).toHaveCount(0);
  await expect(page.getByTestId("command-palette").getByText("Copy conversation",{exact:true})).toHaveCount(0);
  const themedSurfaces=await page.evaluate(()=>({
    composer:getComputedStyle(document.querySelector(".composer-wrap")).backgroundColor,
    panel:getComputedStyle(document.querySelector(".context-panel")).backgroundColor,
    palette:getComputedStyle(document.querySelector(".command-palette")).backgroundColor,
  }));
  for(const value of Object.values(themedSurfaces))expect(value).toBeTruthy();
  await page.screenshot({path:auditDir+"custom-theme-chat-panel-palette-1600x980.png",fullPage:true});
  await page.keyboard.press("Escape");
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"custom-theme-chat-panel-1280x800.png",fullPage:true});
});

test("switching Codex inference provider preserves the active chat and sidebar threads",async({page})=>{
  test.setTimeout(45_000);
  const turn={id:"provider-turn-1",status:"completed",items:[
    {id:"provider-user-1",type:"userMessage",text:"Keep this conversation open while I change inference providers."},
    {id:"provider-assistant-1",type:"agentMessage",text:"This message should still be here after the provider switch."},
  ]};
  const thread={id:"provider-independent-thread",name:"Provider independent thread",preview:"Same chat across inference providers",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[turn]};
  const rpcMessages=[];
  const wsHttp=createServer();const wss=new WebSocketServer({noServer:true});const sockets=new Set();
  wsHttp.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));rpcMessages.push(message);if(message.id==null||!message.method)return;
      let result={};
      if(message.method==="initialize")result={userAgent:"provider-thread-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result=message.params?.excludeTurns?{thread:{...thread,turns:[]},turnsBackwardsCursor:"turn-page-1"}:{thread};
      else if(message.method==="thread/turns/list")result={data:[turn],nextCursor:null};
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const wsPort=await freePort();await new Promise((resolve,reject)=>wsHttp.listen(wsPort,"127.0.0.1",resolve).once("error",reject));
  let provider="freebuff";
  const settings=()=>({onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:provider,defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"});
  const models=()=>provider==="agentrouter"
    ?{models:["agentrouter/test/coding-fast"],metadata:{provider,models:[{id:"agentrouter/test/coding-fast",name:"Coding Fast",provider}]}}
    :{models:["freebuff/test/coding-fast"],metadata:{provider,models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider}]}};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider,providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${wsPort}`,cwd:process.cwd(),platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:settings(),projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/settings$/,async route=>{
      if(route.request().method()==="POST"){const body=route.request().postDataJSON()||{};if(body.modelProvider)provider=body.modelProvider;return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(settings())})}
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(settings())});
    });
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(models())}));
    await page.route(/\/api\/providers$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({selected:provider,providers:[{id:"freebuff",name:"Freebuff",hasKey:true},{id:"agentrouter",name:"AgentRouter",hasKey:true}],status:{id:provider,hasKey:true},ready:true})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    const threadButton=page.getByRole("button",{name:/Provider independent thread/});
    await expect(threadButton).toBeVisible({timeout:10_000});
    await threadButton.click();
    await expect(page.getByText("Keep this conversation open while I change inference providers.")).toBeVisible();
    await expect(page.getByText("This message should still be here after the provider switch.")).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette").getByText("Copy conversation",{exact:true})).toBeVisible();
    await page.keyboard.press("Escape");
    const before=await page.locator(".thread-main").evaluateAll(nodes=>nodes.map(node=>node.getAttribute("title")||node.textContent.trim()));
    await page.screenshot({path:auditDir+"provider-switch-threads-before-1600x980.png",fullPage:true});

    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    const selector=page.getByTestId("provider-selector");
    await selector.selectOption("agentrouter");
    await expect(selector).toHaveValue("agentrouter");
    await expect(page.getByTestId("provider-settings-card")).toHaveAttribute("aria-busy","false");
    await expect(page.getByTestId("provider-status")).toContainText("AgentRouter");
    await expect(page.getByRole("heading",{name:"Settings",level:1})).toBeVisible();

    await page.getByRole("button",{name:"Threads",exact:true}).click();
    await expect(page.locator('.thread-main[title="Provider independent thread"]')).toBeVisible();
    await expect(page.getByText("Keep this conversation open while I change inference providers.")).toBeVisible();
    await expect(page.getByText("This message should still be here after the provider switch.")).toBeVisible();
    await expect(page.locator(".thread-row.active .thread-main")).toHaveAttribute("title","Provider independent thread");
    const after=await page.locator(".thread-main").evaluateAll(nodes=>nodes.map(node=>node.getAttribute("title")||node.textContent.trim()));
    expect(after).toEqual(before);
    await expect(page.locator(".sidebar-provider")).toContainText("AgentRouter");
    const listCalls=rpcMessages.filter(message=>message.method==="thread/list");
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
    for(const call of listCalls)expect(Object.prototype.hasOwnProperty.call(call.params||{},"modelProviders")).toBe(false);
    await page.screenshot({path:auditDir+"provider-switch-threads-after-1600x980.png",fullPage:true});
  }finally{
    for(const ws of sockets)try{ws.terminate()}catch{}
    wss.close();await new Promise(resolve=>wsHttp.close(resolve));
  }
});

test("sidebar thread action failures stay visible and keep the thread in place",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"sidebar-action-thread",name:"Sidebar failure fixture",preview:"Thread action error coverage",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  const wsHttp=createServer();const wss=new WebSocketServer({noServer:true});const sockets=new Set();
  wsHttp.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      if(message.method==="thread/section/move"){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate thread pin failure"}}));return;
      }
      if(message.method==="turn/interrupt"){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate interrupt failure"}}));return;
      }
      let result={};
      if(message.method==="initialize")result={userAgent:"sidebar-action-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result={thread};
      else if(message.method==="thread/turns/list")result={data:[],nextCursor:null};
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const wsPort=await freePort();await new Promise((resolve,reject)=>wsHttp.listen(wsPort,"127.0.0.1",resolve).once("error",reject));
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",keybindingRules:[{command:"threadPin",key:"Ctrl+Alt+P",when:"threadOpen && !modalOpen"}]};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${wsPort}`,cwd:process.cwd(),platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/settings$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(settings)}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Sidebar failure fixture"]')});
    await expect(row).toBeVisible({timeout:10_000});
    await row.hover();
    await row.locator("summary").click();
    await row.getByRole("button",{name:"Pin",exact:true}).click();
    const alert=page.locator(".sidebar-action-error");
    await expect(alert).toHaveRole("alert");
    await expect(alert).toContainText("Deliberate thread pin failure");
    await expect(row).toBeVisible();
    await expect(page.locator(".thread-sections section").filter({hasText:"General"}).locator('.thread-main[title="Sidebar failure fixture"]')).toBeVisible();
    await page.setViewportSize({width:1280,height:800});
    const sidebar=page.locator(".sidebar");const metrics=await sidebar.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await page.screenshot({path:auditDir+"thread-sidebar-action-error-1280x800.png",fullPage:true});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    const light=await alert.evaluate(node=>({background:getComputedStyle(node).backgroundColor,color:getComputedStyle(node).color}));
    expect(light.background).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
    await page.screenshot({path:auditDir+"thread-sidebar-action-error-light-1280x800.png",fullPage:true});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark";document.documentElement.dataset.customTheme="true"});
    const custom=await alert.evaluate(node=>({background:getComputedStyle(node).backgroundColor,color:getComputedStyle(node).color,border:getComputedStyle(node).borderColor}));
    expect(custom.background).toBeTruthy();expect(custom.color).toBeTruthy();expect(custom.border).toBeTruthy();
    await page.screenshot({path:auditDir+"thread-sidebar-action-error-custom-1280x800.png",fullPage:true});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark";document.documentElement.dataset.customTheme="false"});
    await row.locator("details").evaluate(node=>{node.open=false});
    await row.locator(".thread-main").click();
    await expect(row).toHaveClass(/active/);
    await page.keyboard.press("Control+Alt+P");
    const globalError=page.getByTestId("app-action-error");
    await expect(globalError).toContainText("Could not update thread: Deliberate thread pin failure");
    await page.screenshot({path:auditDir+"global-action-error-1280x800.png",fullPage:true});
    for(const ws of sockets)ws.send(JSON.stringify({method:"turn/started",params:{threadId:thread.id,turn:{id:"running-turn"}}}));
    const stopButton=page.getByRole("button",{name:"Stop",exact:true});
    await expect(stopButton).toBeVisible();
    await stopButton.click();
    await expect(globalError).toContainText("Could not stop turn: Deliberate interrupt failure");
    await expect(stopButton).toBeVisible();
    await page.screenshot({path:auditDir+"stop-action-error-1280x800.png",fullPage:true});
  }finally{
    for(const ws of sockets)try{ws.terminate()}catch{}
    wss.close();await new Promise(resolve=>wsHttp.close(resolve));
  }
});

test("delegated agent open failures stay visible in the Agents panel",async({page})=>{
  test.setTimeout(35_000);
  const parent={id:"agent-parent-thread",name:"Agent parent fixture",preview:"Parent thread",cwd:process.cwd(),createdAt:Date.now()/1000-20,updatedAt:Date.now()/1000,turns:[]};
  const child={id:"agent-child-thread",parentThreadId:parent.id,name:"Failing delegated agent",agentRole:"researcher",status:{type:"idle"},model:"freebuff/test/coding-fast",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  const wsHttp=createServer();const wss=new WebSocketServer({noServer:true});const sockets=new Set();
  wsHttp.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      if(message.method==="thread/resume"&&message.params?.threadId===child.id){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate delegated agent open failure"}}));return;
      }
      let result={};
      if(message.method==="initialize")result={userAgent:"agent-open-fixture"};
      else if(message.method==="thread/list")result={data:[parent,child],nextCursor:null};
      else if(message.method==="thread/resume")result={thread:parent};
      else if(message.method==="thread/turns/list")result={data:[],nextCursor:null};
      else if(message.method==="threadSection/list"||message.method==="skills/list")result={data:[]};
      else if(message.method==="collaborationMode/list")result={data:[{name:"Default",mode:"default"}]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const wsPort=await freePort();await new Promise((resolve,reject)=>wsHttp.listen(wsPort,"127.0.0.1",resolve).once("error",reject));
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${wsPort}`,cwd:process.cwd(),platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:{[parent.id]:{projectless:true,environmentId:null},[child.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/settings$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(settings)}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    await page.locator('.thread-main[title="Agent parent fixture"]').click();
    await expect(page.locator(".thread-row.active .thread-main")).toHaveAttribute("title","Agent parent fixture");
    await page.locator('.sidebar .sidebar-utility[aria-label="Agents"]').click();
    const panel=page.getByTestId("right-panel");
    const agentButton=panel.locator(".agent-open").filter({hasText:"Failing delegated agent"});
    await expect(agentButton).toBeVisible();
    await agentButton.click();
    await expect(panel.getByRole("alert")).toContainText("Deliberate delegated agent open failure");
    await expect(agentButton).toBeVisible();
    await expect(page.locator(".thread-row.active .thread-main")).toHaveAttribute("title","Agent parent fixture");
    await page.setViewportSize({width:1280,height:800});
    const metrics=await panel.locator(".context-panel-body").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await page.screenshot({path:auditDir+"agents-open-error-1280x800.png",fullPage:true});
  }finally{
    for(const ws of sockets)try{ws.terminate()}catch{}
    wss.close();await new Promise(resolve=>wsHttp.close(resolve));
  }
});

test("failed background work restores the draft when stash saving also fails",async({page})=>{
  test.setTimeout(35_000);
  const wsHttp=createServer();const wss=new WebSocketServer({noServer:true});const sockets=new Set();
  wsHttp.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      if(message.method==="turn/start"){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate background turn failure"}}));return;
      }
      let result={};
      if(message.method==="initialize")result={userAgent:"background-stash-fixture"};
      else if(message.method==="thread/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/start")result={thread:{id:"background-stash-thread",name:"Background stash fixture",cwd:process.cwd(),createdAt:Date.now()/1000,updatedAt:Date.now()/1000,turns:[]}};
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const wsPort=await freePort();await new Promise((resolve,reject)=>wsHttp.listen(wsPort,"127.0.0.1",resolve).once("error",reject));
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${wsPort}`,cwd:process.cwd(),platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:{}})}));
    await page.route(/\/api\/settings$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(settings)}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/general-workspace$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({path:process.cwd(),environmentId:null})}));
    await page.route(/\/api\/stashes$/,route=>{
      if(route.request().method()==="POST")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate stash failure"})});
      return route.continue();
    });
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    await page.getByRole("button",{name:"Projects",exact:true}).click();
    const general=page.locator(".general-chat-card");
    await expect(general).toBeVisible();
    await general.click();
    const composer=page.getByTestId("composer");
    await expect(composer).toBeVisible();
    const draft="Keep this draft safe even when both background start and stash saving fail.";
    await composer.fill(draft);
    await composer.press("Control+Enter");
    await expect(page.locator(".tool-event").filter({hasText:"stash save also failed"})).toContainText("Deliberate stash failure");
    await expect(composer).toHaveValue(draft);
    await page.setViewportSize({width:1280,height:800});
    const metrics=await page.locator(".composer-wrap").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await page.screenshot({path:auditDir+"background-stash-failure-restored-1280x800.png",fullPage:true});
  }finally{
    for(const ws of sockets)try{ws.terminate()}catch{}
    wss.close();await new Promise(resolve=>wsHttp.close(resolve));
  }
});

test("delegated agent open failures stay visible without leaving the parent thread",async({page})=>{
  test.setTimeout(35_000);
  const parent={id:"agent-parent-thread",name:"Parent thread",preview:"Parent fixture",cwd:process.cwd(),createdAt:Date.now()/1000-30,updatedAt:Date.now()/1000,turns:[]};
  const child={id:"agent-child-thread",parentThreadId:parent.id,name:"Delegated fixture",agentRole:"worker",status:{type:"idle"},cwd:"C:\\trebell-missing-worktree",createdAt:Date.now()/1000-20,updatedAt:Date.now()/1000,turns:[]};
  const wsHttp=createServer();const wss=new WebSocketServer({noServer:true});const sockets=new Set();
  wsHttp.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      let result={};
      if(message.method==="initialize")result={userAgent:"agents-open-error-fixture"};
      else if(message.method==="thread/list")result={data:[parent,child],nextCursor:null};
      else if(message.method==="thread/resume")result={thread:message.params?.threadId===parent.id?parent:child};
      else if(message.method==="thread/turns/list")result={data:[],nextCursor:null};
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/attachment/list")result={data:[]};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const wsPort=await freePort();await new Promise((resolve,reject)=>wsHttp.listen(wsPort,"127.0.0.1",resolve).once("error",reject));
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${wsPort}`,cwd:process.cwd(),platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:{[parent.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/settings$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(settings)}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate delegated worktree restore failure"})}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({checkpoints:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    const parentRow=page.locator('.thread-main[title="Parent thread"]');
    await expect(parentRow).toBeVisible({timeout:10_000});
    await parentRow.click();
    await expect(parentRow.locator("xpath=..")).toHaveClass(/active/);
    await page.getByTestId("right-panel-toggle").click();
    const panel=page.getByTestId("right-panel");
    await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Agents",exact:true}).click();
    const delegated=panel.locator(".agent-row").filter({hasText:"Delegated fixture"});
    await expect(delegated).toBeVisible();
    await delegated.locator(".agent-open").click();
    const alert=panel.getByRole("alert");
    await expect(alert).toContainText("Deliberate delegated worktree restore failure");
    await expect(parentRow.locator("xpath=..")).toHaveClass(/active/);
    await expect(delegated).toBeVisible();
    await page.setViewportSize({width:1280,height:800});
    const metrics=await panel.locator(".context-panel-body").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await page.screenshot({path:auditDir+"agents-open-error-1280x800.png",fullPage:true});
  }finally{
    for(const ws of sockets)try{ws.terminate()}catch{}
    wss.close();await new Promise(resolve=>wsHttp.close(resolve));
  }
});

test("non-Codex agent picker rolls back when the runtime rejects the change",async({page})=>{
  test.setTimeout(35_000);
  const thread={
    id:"provider-agent-thread",
    name:"Provider agent fixture",
    preview:"Agent picker rollback coverage",
    agent:"alpha",
    cwd:process.cwd(),
    createdAt:Date.now()/1000-20,
    updatedAt:Date.now()/1000,
    turns:[],
    providerMeta:{session_info_update:{agents:[{name:"alpha",mode:"default"},{name:"beta",mode:"specialist"}]}},
  };
  const wsHttp=createServer();const wss=new WebSocketServer({noServer:true});const sockets=new Set();
  wsHttp.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      if(message.method==="thread/settings/update"){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate provider agent change failure"}}));return;
      }
      let result={};
      if(message.method==="initialize")result={userAgent:"provider-agent-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result={thread};
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list")result={data:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const wsPort=await freePort();await new Promise((resolve,reject)=>wsHttp.listen(wsPort,"127.0.0.1",resolve).once("error",reject));
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"opencode",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"opencode",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${wsPort}`,cwd:process.cwd(),platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/settings$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(settings)}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["opencode/test-model"],metadata:{provider:"opencode",models:[{id:"opencode/test-model",name:"Test model",provider:"opencode"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({checkpoints:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    await page.locator('.thread-main[title="Provider agent fixture"]').click();
    const picker=page.locator(".agent-picker");
    await expect(picker).toBeVisible({timeout:10_000});
    await expect(picker).toHaveValue("alpha");
    await picker.selectOption("beta");
    await expect(page.getByTestId("app-action-error")).toContainText("Could not change provider agent: Deliberate provider agent change failure");
    await expect(picker).toHaveValue("alpha");
    await expect(page.locator(".thread-row.active .thread-main")).toHaveAttribute("title","Provider agent fixture");
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({path:auditDir+"provider-agent-change-error-1280x800.png",fullPage:true});
  }finally{
    for(const ws of sockets)try{ws.terminate()}catch{}
    wss.close();await new Promise(resolve=>wsHttp.close(resolve));
  }
});

test("populated source control and pull request detail stay usable",async({page,request})=>{
  test.setTimeout(45_000);
  const prActions=[];
  await page.route(/\/api\/git\/info\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    isGit:true,root:"H:\\Github Repositories\\Trebell\\trebell-code",branch:"feature/ui-polish",branches:["main","feature/ui-polish"],upstream:"origin/feature/ui-polish",
    status:[{code:" M",path:"ui/src/App.jsx"},{code:"??",path:"ui/e2e/new-visual.spec.js"}],
    remotes:[{name:"origin",url:"https://github.com/example/trebellcode.git"}],
    worktrees:[{path:"H:\\Github Repositories\\Trebell\\trebell-code",branch:"feature/ui-polish"},{path:"H:\\Github Repositories\\Trebell\\trebell-code-review",branch:"review/pr-142"}],
  })}));
  await page.route(/\/api\/source-control\/diagnostics\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    selectedProvider:"github",detectedProvider:"github",git:{version:"git version 2.51.0.windows.1"},
    providers:{github:{label:"GitHub",installed:true,authenticated:true}},
    capabilities:{github:{create:true,comment:true,review:true,requestChanges:true,merge:true,updateBranch:true,edit:true,checkout:true,reviewers:true,approveWorkflows:true,autoMerge:true,revert:true,editComments:true}},
  })}));
  const listPr={number:142,title:"Polish Trebell desktop interaction states",state:"OPEN",headRefName:"feature/ui-polish",baseRefName:"main",provider:"github",url:"https://github.com/example/trebellcode/pull/142"};
  await page.route(/\/api\/source-control\/prs\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    items:[listPr,{number:139,title:"Add remote runtime diagnostics",state:"OPEN",headRefName:"runtime-diagnostics",baseRefName:"main",provider:"github",url:"https://github.com/example/trebellcode/pull/139"}],
    capabilities:{create:true,comment:true,review:true,requestChanges:true,merge:true,updateBranch:true,edit:true,checkout:true,reviewers:true,approveWorkflows:true,autoMerge:true,revert:true,editComments:true},
  })}));
  await page.route(/\/api\/source-control\/pr-detail\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    provider:"github",
    item:{...listPr,body:"Improves visual regression coverage and makes dense desktop workflows easier to scan.",identity:{provider:"github",host:"github.com",repository:"example/trebellcode",number:142},
      files:[
        {path:"ui/src/App.jsx",additions:42,deletions:11,patch:"@@ -10,3 +10,7 @@\n+const polished = true;\n+function keepPanelsReadable() {}"},
        {path:"ui/src/styles.css",additions:68,deletions:9,patch:"@@ -200,3 +200,8 @@\n+.workspace { min-width: 0; }"},
      ],
      comments:[{id:"comment-1",author:{login:"reviewer-one"},body:"The new resize behavior feels much better."},{id:"comment-2",author:{login:"trebell-dev"},body:"Added compact empty states.",canEdit:true}],
      reviews:[{id:"review-1",author:{login:"reviewer-two"},state:"APPROVED",body:"Looks good after the visual pass."}],
      statusCheckRollup:[{name:"unit-tests",status:"COMPLETED",conclusion:"SUCCESS"},{name:"playwright",status:"COMPLETED",conclusion:"SUCCESS"}],
      awaitingWorkflowApproval:["build-windows"],
    },
  })}));
  await page.route(/\/api\/source-control\/thread-link\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({threads:[]})}));
  await page.route(/\/api\/source-control\/pr-viewed\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({store:"environment",files:[{path:"ui/src/App.jsx",state:"viewed"},{path:"ui/src/styles.css",state:"unviewed"}]})}));
  await page.route(/\/api\/source-control\/pr-action$/,route=>{
    prActions.push(route.request().postDataJSON());
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})});
  });

  await prepare(page,request);
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  const gitTab=panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true});
  await gitTab.click();
  await expect(gitTab).toHaveClass(/active/);
  await expect(panel.locator(".sc-toolbar select").first()).toHaveValue("feature/ui-polish");
  await expect(panel.getByRole("button",{name:"Add worktree",exact:true})).toHaveCount(0);
  await expect(panel.getByRole("button",{name:/#142 Polish Trebell desktop interaction states/})).toBeVisible();
  await page.screenshot({path:auditDir+"source-control-populated-1600x980.png",fullPage:true});

  await panel.getByRole("button",{name:/#142 Polish Trebell desktop interaction states/}).click();
  await expect(panel.getByRole("heading",{name:/#142 Polish Trebell desktop interaction states/})).toBeVisible();
  await expect(panel.getByText("The new resize behavior feels much better.")).toBeVisible();
  await expect(panel.getByRole("button",{name:"Approve",exact:true})).toHaveCount(0);
  await panel.getByRole("button",{name:"Comment / review",exact:true}).click();
  const composer=panel.getByTestId("pr-composer");
  await expect(composer).toBeVisible();
  const commentDraft=composer.getByLabel("Pull request comment");
  await commentDraft.fill("Looks good overall; leaving one note.");
  await composer.getByRole("tab",{name:"Review",exact:true}).click();
  await composer.getByLabel("Review verdict").selectOption("REQUEST_CHANGES");
  const reviewDraft=composer.getByLabel("Review summary");
  await reviewDraft.fill("Please address the remaining resize edge case.");
  await composer.getByRole("tab",{name:"Comment",exact:true}).click();
  await expect(commentDraft).toHaveValue("Looks good overall; leaving one note.");
  await page.screenshot({path:auditDir+"source-control-pr-composer-comment-1600x980.png",fullPage:true});
  await composer.locator(".pr-composer-submit button").click();
  await expect.poll(()=>prActions.length).toBe(1);
  expect(prActions[0]).toMatchObject({action:"comment",number:142,body:"Looks good overall; leaving one note."});

  await panel.getByRole("button",{name:"Comment / review",exact:true}).click();
  const reopened=panel.getByTestId("pr-composer");
  await reopened.getByRole("tab",{name:"Review",exact:true}).click();
  await expect(reopened.getByLabel("Review summary")).toHaveValue("Please address the remaining resize edge case.");
  await expect(reopened.getByLabel("Review verdict")).toHaveValue("REQUEST_CHANGES");
  await page.screenshot({path:auditDir+"source-control-pr-composer-review-1600x980.png",fullPage:true});
  await reopened.locator(".pr-composer-submit button").click();
  await expect.poll(()=>prActions.length).toBe(2);
  expect(prActions[1]).toMatchObject({action:"review",number:142,event:"REQUEST_CHANGES",body:"Please address the remaining resize edge case."});
  const metrics=await panel.locator(".context-panel-body").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"source-control-pr-detail-1600x980.png",fullPage:true});
  await page.setViewportSize({width:1280,height:800});
  await panel.getByRole("button",{name:/#142 Polish Trebell desktop interaction states/}).click();
  await expect(panel.getByRole("heading",{name:/#142 Polish Trebell desktop interaction states/})).toBeInViewport();
  await panel.getByRole("button",{name:"Comment / review",exact:true}).click();
  const compactComposer=panel.getByTestId("pr-composer");
  await compactComposer.getByRole("tab",{name:"Review",exact:true}).click();
  await compactComposer.getByLabel("Review summary").fill("Compact-width review draft.");
  const compactComposerBox=await box(compactComposer),panelBodyBox=await box(panel.locator(".context-panel-body"));
  expect(compactComposerBox.x).toBeGreaterThanOrEqual(panelBodyBox.x);
  expect(compactComposerBox.x+compactComposerBox.width).toBeLessThanOrEqual(panelBodyBox.x+panelBodyBox.width+1);
  await page.screenshot({path:auditDir+"source-control-pr-composer-1280x800.png",fullPage:true});
  await compactComposer.getByRole("button",{name:"Close pull request composer"}).click();
  await page.screenshot({path:auditDir+"source-control-pr-detail-1280x800.png",fullPage:true});
  await page.setViewportSize({width:1600,height:980});
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  const lightSurfaces=await panel.evaluate(node=>({
    panel:getComputedStyle(node).backgroundColor,
    source:getComputedStyle(node.querySelector(".source-control")).backgroundColor,
    detail:getComputedStyle(node.querySelector(".pr-detail")).backgroundColor,
    file:getComputedStyle(node.querySelector(".pr-file")).backgroundColor,
    conversation:getComputedStyle(node.querySelector(".review-list > div")).backgroundColor,
    action:getComputedStyle(node.querySelector(".pr-actions button")).backgroundColor,
  }));
  for(const value of Object.values(lightSurfaces))expect(value).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  await page.screenshot({path:auditDir+"source-control-pr-detail-light-1600x980.png",fullPage:true});
});

test("source control keeps the PR visible when loading full details fails",async({page,request})=>{
  test.setTimeout(30_000);
  let failPrRefresh=false;
  const listPr={number:142,title:"PR detail failure fixture",state:"OPEN",headRefName:"feature/pr-error",baseRefName:"main",provider:"github",url:"https://github.com/example/trebellcode/pull/142"};
  await page.route(/\/api\/git\/info\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    isGit:true,root:"H:\\Github Repositories\\Trebell\\trebell-code",branch:"feature/pr-error",branches:["main","feature/pr-error"],upstream:"origin/feature/pr-error",
    status:[],remotes:[{name:"origin",url:"https://github.com/example/trebellcode.git"}],worktrees:[],
  })}));
  await page.route(/\/api\/source-control\/diagnostics\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},
    capabilities:{github:{create:true,comment:true,review:true,merge:true}},
  })}));
  await page.route(/\/api\/source-control\/prs\?/,route=>{
    if(failPrRefresh)return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate PR list refresh failure"})});
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[listPr],capabilities:{create:true,comment:true,review:true,merge:true}})});
  });
  await page.route(/\/api\/source-control\/pr-detail\?/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate PR detail failure"})}));
  await page.route(/\/api\/source-control\/pr-viewed\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({store:"environment",files:[]})}));

  await prepare(page,request);
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
  const prButton=panel.getByRole("button",{name:/#142 PR detail failure fixture/});
  await expect(prButton).toBeVisible();
  const [,detailResponse]=await Promise.all([
    prButton.click(),
    page.waitForResponse(response=>response.url().includes("/api/source-control/pr-detail?")),
  ]);
  expect(detailResponse.status()).toBe(500);
  await expect(panel.getByRole("alert")).toContainText("Deliberate PR detail failure");
  await expect(panel.getByRole("heading",{name:"#142 PR detail failure fixture",exact:true})).toBeVisible();
  await expect(prButton).toHaveClass(/active/);
  await page.setViewportSize({width:1280,height:800});
  const metrics=await panel.locator(".context-panel-body").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"source-control-pr-detail-error-1280x800.png",fullPage:true});
  failPrRefresh=true;
  await panel.getByRole("button",{name:"Refresh pull requests",exact:true}).click();
  await expect(panel.getByRole("alert")).toContainText("Deliberate PR list refresh failure");
  await expect(prButton).toBeVisible();
  await expect(prButton).toHaveClass(/active/);
  await page.screenshot({path:auditDir+"source-control-refresh-error-1280x800.png",fullPage:true});
});

test("failed linked-thread unarchive keeps the PR and archived state intact",async({page})=>{
  test.setTimeout(40_000);
  const parent={
    id:"source-parent-thread",name:"Source parent fixture",preview:"Parent chat",cwd:process.cwd(),
    createdAt:Date.now()/1000-30,updatedAt:Date.now()/1000,turns:[],
  };
  const archivedId="archived-linked-thread";
  const project={id:"source-fixture-project",name:"Source Fixture",path:process.cwd(),environmentId:null,effectiveSettings:{}};
  const listPr={number:77,title:"Archived thread fixture",state:"OPEN",headRefName:"feature/archive-link",baseRefName:"main",provider:"github",url:"https://github.com/example/fixture/pull/77"};
  const wsHttp=createServer();const wss=new WebSocketServer({noServer:true});const sockets=new Set();
  wsHttp.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      if(message.method==="thread/unarchive"&&message.params?.threadId===archivedId){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate linked thread unarchive failure"}}));return;
      }
      let result={};
      if(message.method==="initialize")result={userAgent:"linked-thread-fixture"};
      else if(message.method==="thread/list")result={data:[parent],nextCursor:null};
      else if(message.method==="thread/resume")result={thread:parent};
      else if(message.method==="thread/read"&&message.params?.threadId===archivedId)result={thread:{id:archivedId,name:"Archived review thread",cwd:process.cwd(),archived:true,turns:[]}};
      else if(message.method==="threadSection/list"||message.method==="skills/list")result={data:[]};
      else if(message.method==="collaborationMode/list")result={data:[{name:"Default",mode:"default"}]};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list")result={data:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const wsPort=await freePort();await new Promise((resolve,reject)=>wsHttp.listen(wsPort,"127.0.0.1",resolve).once("error",reject));
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",activeProjectId:project.id};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${wsPort}`,cwd:process.cwd(),platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[project],threadMeta:{[parent.id]:{projectless:false,environmentId:null}}})}));
    await page.route(/\/api\/settings$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(settings)}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[project],project})}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({checkpoints:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.route(/\/api\/git\/info\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,root:process.cwd(),branch:"feature/archive-link",branches:["main","feature/archive-link"],upstream:"origin/feature/archive-link",status:[],remotes:[{name:"origin",url:"https://github.com/example/fixture.git"}],worktrees:[]})}));
    await page.route(/\/api\/source-control\/diagnostics\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{create:true,comment:true,review:true,merge:true}}})}));
    await page.route(/\/api\/source-control\/prs\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[listPr],capabilities:{create:true,comment:true,review:true,merge:true}})}));
    await page.route(/\/api\/source-control\/pr-detail\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({provider:"github",item:{...listPr,body:"Fixture PR",identity:{provider:"github",host:"github.com",repository:"example/fixture",number:77},files:[],comments:[],reviews:[],statusCheckRollup:[]}})}));
    await page.route(/\/api\/source-control\/pr-viewed\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({store:"environment",files:[]})}));
    await page.route(/\/api\/source-control\/thread-link\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({threads:[{threadId:archivedId,title:"Archived review thread",archived:true}]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    await page.locator('.thread-main[title="Source parent fixture"]').click();
    await page.getByTestId("right-panel-toggle").click();
    const panel=page.getByTestId("right-panel");
    await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
    await panel.getByRole("button",{name:/#77 Archived thread fixture/}).click();
    const linked=panel.getByRole("button",{name:/Archived review thread · archived/});
    await expect(linked).toBeVisible();
    await linked.click();
    const alert=panel.getByRole("alert");
    await expect(alert).toContainText("Deliberate linked thread unarchive failure");
    await expect(alert).toBeInViewport();
    await expect(linked).toContainText("archived");
    await expect(page.locator(".thread-row.active .thread-main")).toHaveAttribute("title","Source parent fixture");
    await page.setViewportSize({width:1280,height:800});
    const metrics=await panel.locator(".context-panel-body").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await page.screenshot({path:auditDir+"linked-thread-unarchive-error-1280x800.png",fullPage:true});
  }finally{
    for(const ws of sockets)try{ws.terminate()}catch{}
    wss.close();await new Promise(resolve=>wsHttp.close(resolve));
  }
});

test("failed worktree open stays in the current project and reports the error",async({page,request})=>{
  test.setTimeout(30_000);
  const root=process.cwd(),other=root+"-review-fixture";
  await page.route(/\/api\/git\/info\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    isGit:true,root,branch:"main",branches:["main","review/fixture"],upstream:"origin/main",status:[],
    remotes:[{name:"origin",url:"https://github.com/example/fixture.git"}],
    worktrees:[{path:root,branch:"main"},{path:other,branch:"review/fixture"}],
  })}));
  await page.route(/\/api\/source-control\/diagnostics\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},
    providers:{github:{label:"GitHub",installed:true,authenticated:true}},
    capabilities:{github:{create:true,comment:true,review:true,merge:true}},
  })}));
  await page.route(/\/api\/source-control\/prs\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[],capabilities:{create:true,comment:true,review:true,merge:true}})}));
  await prepare(page,request);
  const crumb=page.locator(".workspace-breadcrumb .project-crumb").filter({hasNot:page.locator(".sidebar-reopen")}).first();
  const beforeText=(await crumb.textContent())?.trim()||"";
  await page.route(/\/api\/projects$/,route=>{
    if(route.request().method()==="POST")return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate worktree activation failure"})});
    return route.continue();
  });
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
  const row=panel.locator(".worktree-row").filter({hasText:"review/fixture"});
  await expect(row).toBeVisible();
  await row.getByRole("button",{name:"Open",exact:true}).click();
  const alert=panel.getByRole("alert");
  await expect(alert).toContainText("Deliberate worktree activation failure");
  await expect(alert).toBeInViewport();
  await expect(crumb).toHaveText(beforeText);
  await page.setViewportSize({width:1280,height:800});
  const metrics=await panel.locator(".context-panel-body").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"worktree-open-error-1280x800.png",fullPage:true});
});

test("Add worktree reports native folder picker failures",async({page,request})=>{
  test.setTimeout(30_000);
  await page.addInitScript(()=>{
    Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{
      pickDirectory:async()=>{throw new Error("Deliberate worktree folder picker failure")},
    }});
  });
  await page.route(/\/api\/git\/info\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    isGit:true,root:process.cwd(),branch:"main",branches:["main"],upstream:"origin/main",status:[],
    remotes:[{name:"origin",url:"https://github.com/example/fixture.git"}],
    worktrees:[{path:process.cwd(),branch:"main"}],
  })}));
  await page.route(/\/api\/source-control\/diagnostics\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},
    providers:{github:{label:"GitHub",installed:true,authenticated:true}},
    capabilities:{github:{create:true,comment:true,review:true,merge:true}},
  })}));
  await page.route(/\/api\/source-control\/prs\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[],capabilities:{create:true,comment:true,review:true,merge:true}})}));
  await prepare(page,request);
  const crumb=page.locator(".workspace-breadcrumb .project-crumb").filter({hasNot:page.locator(".sidebar-reopen")}).first();
  const beforeText=(await crumb.textContent())?.trim()||"";
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
  const addWorktree=panel.getByRole("button",{name:"Add worktree",exact:true});
  await expect(addWorktree).toBeVisible();
  page.once("dialog",dialog=>dialog.accept("picker-failure"));
  await addWorktree.click();
  const alert=panel.getByRole("alert");
  await expect(alert).toContainText("Deliberate worktree folder picker failure");
  await expect(alert).toBeInViewport();
  await expect(crumb).toHaveText(beforeText);
  await expect(addWorktree).toBeEnabled();
  await page.setViewportSize({width:1280,height:800});
  const metrics=await panel.locator(".context-panel-body").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"worktree-picker-error-1280x800.png",fullPage:true});
});

test("failed PR attachment stays in source control with visible feedback",async({page,request})=>{
  test.setTimeout(30_000);
  const pr={number:88,title:"Attachment failure fixture",state:"OPEN",headRefName:"feature/attach-error",baseRefName:"main",provider:"github",url:"https://github.com/example/fixture/pull/88"};
  await page.route(/\/api\/git\/info\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    isGit:true,root:process.cwd(),branch:"feature/attach-error",branches:["main","feature/attach-error"],upstream:"origin/feature/attach-error",status:[],
    remotes:[{name:"origin",url:"https://github.com/example/fixture.git"}],worktrees:[],
  })}));
  await page.route(/\/api\/source-control\/diagnostics\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},
    providers:{github:{label:"GitHub",installed:true,authenticated:true}},
    capabilities:{github:{create:true,comment:true,review:true,merge:true}},
  })}));
  await page.route(/\/api\/source-control\/prs\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[pr],capabilities:{create:true,comment:true,review:true,merge:true}})}));
  await page.route(/\/api\/source-control\/pr-detail\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    provider:"github",item:{...pr,body:"Fixture PR body",identity:{provider:"github",host:"github.com",repository:"example/fixture",number:88},files:[],comments:[],reviews:[],statusCheckRollup:[]},
  })}));
  await page.route(/\/api\/source-control\/pr-viewed\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({store:"environment",files:[]})}));
  await page.route(/\/api\/source-control\/thread-link\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({threads:[]})}));
  await prepare(page,request);
  await page.route(/\/api\/attachments\/text$/,route=>route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate PR attachment failure"})}));
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
  await panel.getByRole("button",{name:/#88 Attachment failure fixture/}).click();
  await panel.getByRole("button",{name:"Attach",exact:true}).click();
  const alert=panel.getByRole("alert");
  await expect(alert).toContainText("Deliberate PR attachment failure");
  await expect(alert).toBeInViewport();
  await expect(panel.getByRole("heading",{name:/#88 Attachment failure fixture/})).toBeVisible();
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"source-control-attach-error-1280x800.png",fullPage:true});
});

test("Claude thread can switch compatible account profiles from the model picker",async({page})=>{
  test.setTimeout(45_000);
  const home=await mkdtemp(join(tmpdir(),"trebell-claude-switch-"));
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:home});
  const sharedHome=join(home,"claude-shared");
  const profiles=[
    {id:"claude-work",kind:"claude",displayName:"Claude Work",homePath:sharedHome,enabled:true},
    {id:"claude-router",kind:"claude",displayName:"Claude Router",homePath:sharedHome,enabled:true},
    {id:"claude-signed-out",kind:"claude",displayName:"Claude Signed Out",homePath:sharedHome,enabled:true},
    {id:"claude-personal",kind:"claude",displayName:"Claude Personal",homePath:join(home,"claude-personal"),enabled:true},
  ];
  const thread=threadStore.create({
    runtime:"claude",
    cwd:process.cwd(),
    providerSessionId:"",
    model:"sonnet",
    name:"Claude profile switch fixture",
    preview:"Compatible account switching",
    providerMeta:{runtimeInstanceId:"claude-work",environmentId:null},
  });
  threadStore.update(thread.id,{runtimeInstanceId:"claude-work"});
  const meta=new Map([[thread.id,{projectless:true,environmentId:null}]]);
  const runtimeManager={
    instances:()=>profiles.map(item=>({...item})),
    activeRuntime:()=>"claude",
    activeInstance:()=>profiles[0],
    compatibleInstanceIds:id=>id==="claude-personal"?["claude-personal"]:["claude-work","claude-router","claude-signed-out"],
    probe:async instance=>({id:instance.id,name:instance.displayName,available:true,installed:true,authenticated:instance.id!=="claude-signed-out",version:"fixture-1.0"}),
    runtimeCwd:value=>value,
    processSpawner:()=>null,
    remoteIo:()=>null,
    childEnv:()=>({...process.env,CLAUDE_CONFIG_DIR:sharedHome}),
    executable:()=>"claude-fixture",
  };
  const state={
    settings:()=>({activeEnvironmentId:null}),
    threadMeta:id=>meta.get(id)||{},
    updateThreadMeta(id,patch){const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},
    recordUsage:()=>{},
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,version:"visual-fixture"});
  const relayPort=await freePort();
  await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,
      wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:process.cwd(),platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null,
    })}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-work",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},
      projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}},
    })}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      models:["sonnet","opus","haiku"],metadata:{provider:"claude",models:[
        {id:"sonnet",name:"Sonnet",provider:"claude",agent:"Claude Code"},
        {id:"opus",name:"Opus",provider:"claude",agent:"Claude Code"},
        {id:"haiku",name:"Haiku",provider:"claude",agent:"Claude Code"},
      ]},
    })}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    await expect(page.getByRole("button",{name:/Claude profile switch fixture/})).toBeVisible({timeout:10_000});
    await page.getByRole("button",{name:/Claude profile switch fixture/}).click();
    const picker=page.getByTestId("model-picker");
    await expect(picker).toBeEnabled();
    await expect(picker).toContainText("Claude Work");
    await expect(page.getByRole("button",{name:"Compact",exact:true})).toBeVisible();
    await page.screenshot({path:auditDir+"chat-claude-compact-context-1600x980.png",fullPage:true});
    await picker.click();
    const profilesMenu=page.locator(".model-runtime-profiles");
    await expect(profilesMenu).toBeVisible();
    await expect(profilesMenu.getByRole("button",{name:/Claude Work/})).toHaveClass(/selected/);
    await expect(profilesMenu.getByRole("button",{name:/Claude Router/})).toBeVisible();
    const signedOut=profilesMenu.getByRole("button",{name:/Claude Signed Out/});
    await expect(signedOut).toBeVisible();
    await expect(signedOut).toBeDisabled();
    await expect(signedOut).toContainText("Sign-in required");
    await expect(profilesMenu.getByRole("button",{name:/Claude Personal/})).toHaveCount(0);
    await page.screenshot({path:auditDir+"chat-claude-profile-picker-1600x980.png",fullPage:true});

    await profilesMenu.getByRole("button",{name:/Claude Router/}).click();
    await expect(picker).toContainText("Claude Router");
    await picker.click();
    await expect(profilesMenu.getByRole("button",{name:/Claude Router/})).toHaveClass(/selected/);
    await page.screenshot({path:auditDir+"chat-claude-profile-switched-1600x980.png",fullPage:true});
    await page.setViewportSize({width:1280,height:800});
    await expect(page.locator(".composer-bar")).toBeVisible();
    const compact=await page.locator(".composer-bar").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(compact.scroll).toBeLessThanOrEqual(compact.client+1);
    await page.screenshot({path:auditDir+"chat-claude-profile-switched-1280x800.png",fullPage:true});
  }finally{
    await relay.close();
    await new Promise(resolve=>relayServer.close(()=>resolve()));
    await rm(home,{recursive:true,force:true});
  }
});

test("Codex thread can switch compatible account profiles from the model picker",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"codex-profile-fixture",name:"Codex profile switch fixture",preview:"Shared CODEX_HOME account switching",cwd:process.cwd(),createdAt:Date.now()-1000,updatedAt:Date.now(),turns:[]};
  const upstreamMessages=[],clientMessages=[];
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const upstreamSockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    upstreamSockets.add(ws);ws.on("close",()=>upstreamSockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));upstreamMessages.push(message);if(message.id==null||!message.method)return;
      let result={};
      if(message.method==="initialize")result={userAgent:"codex-profile-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/resume"||message.method==="thread/read")result={thread};
      else if(message.method==="thread/items/list")result={data:[],nextCursor:null};
      else if(message.method==="memory/status")result={v2ConsolidatedThreads:23,v2Ready:true};
      else if(message.method==="permissionProfile/list"||message.method==="mcpServerStatus/list"||message.method==="app/list"||message.method==="hooks/list"||message.method==="experimentalFeature/list"||message.method==="plugin/share/list")result={data:[]};
      else if(message.method==="plugin/list")result={marketplaces:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      else if(message.method==="account/read")result={account:{type:"chatgpt",email:"fixture@example.com",planType:"plus"},requiresOpenaiAuth:false};
      else if(message.method==="config/read")result={config:{},layers:[]};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  let currentInstanceId="codex-work";
  const profiles=[
    {id:"codex-work",displayName:"Codex Work",available:true,authenticated:true,version:"fixture-1.0"},
    {id:"codex-personal",displayName:"Codex Personal",available:true,authenticated:true,version:"fixture-1.0"},
    {id:"codex-broken",displayName:"Codex Broken",available:true,authenticated:true,version:"fixture-1.0"},
    {id:"codex-signed-out",displayName:"Codex Signed Out",available:true,authenticated:false,version:"fixture-1.0"},
  ];
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachCodexRelay(relayServer,{
    targetUrl:`ws://127.0.0.1:${upstreamPort}`,
    onClientMessage:message=>clientMessages.push(message),
    handleRequest:async message=>{
      if(message.method==="thread/runtimeInstances/list")return {handled:true,result:{supported:true,label:"Codex profile",currentInstanceId,items:profiles}};
      if(message.method==="thread/runtimeInstance/set"){
        if(message.params?.instanceId==="codex-signed-out")throw new Error("Sign-in required");
        if(message.params?.instanceId==="codex-broken")throw new Error("Deliberate runtime profile failure");
        currentInstanceId=message.params?.instanceId||currentInstanceId;return {handled:true,result:{threadId:thread.id,runtimeInstanceId:currentInstanceId}};
      }
      return null;
    },
  });
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,
      wsUrl:`ws://127.0.0.1:${relayPort}/api/codex/ws`,cwd:process.cwd(),platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null,
    })}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-work",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},
      projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null,runtimeInstanceId:"codex-work"}},
    })}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    await expect(page.getByRole("button",{name:/Codex profile switch fixture/})).toBeVisible({timeout:10_000});
    await page.getByRole("button",{name:/Codex profile switch fixture/}).click();
    const picker=page.getByTestId("model-picker");await expect(picker).toBeEnabled();await expect(picker).toContainText("Codex Work");
    await picker.click();
    const profilesMenu=page.locator(".model-runtime-profiles");await expect(profilesMenu).toBeVisible();await expect(profilesMenu).toContainText("Codex profile");
    await expect(profilesMenu.getByRole("button",{name:/Codex Work/})).toHaveClass(/selected/);
    await expect(profilesMenu.getByRole("button",{name:/Codex Personal/})).toBeEnabled();
    const signedOut=profilesMenu.getByRole("button",{name:/Codex Signed Out/});await expect(signedOut).toBeDisabled();await expect(signedOut).toContainText("Sign-in required");
    await page.screenshot({path:auditDir+"chat-codex-profile-picker-1600x980.png",fullPage:true});
    await profilesMenu.getByRole("button",{name:/Codex Personal/}).click();await expect(picker).toContainText("Codex Personal");
    await picker.click();await expect(profilesMenu.getByRole("button",{name:/Codex Personal/})).toHaveClass(/selected/);
    await page.screenshot({path:auditDir+"chat-codex-profile-switched-1600x980.png",fullPage:true});
    await profilesMenu.getByRole("button",{name:/Codex Broken/}).click();
    const profileError=page.getByTestId("app-action-error");
    await expect(profileError).toContainText("Could not switch Codex profile: Deliberate runtime profile failure");
    await expect(profileError).toBeInViewport();
    await expect(profilesMenu).toBeVisible();
    await expect(picker).toContainText("Codex Personal");
    await expect(profilesMenu.getByRole("button",{name:/Codex Personal/})).toHaveClass(/selected/);
    await expect(profilesMenu.getByRole("button",{name:/Codex Broken/})).not.toHaveClass(/selected/);
    await page.setViewportSize({width:1280,height:800});
    const errorLayout=await page.locator(".composer-bar").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(errorLayout.scroll).toBeLessThanOrEqual(errorLayout.client+1);
    await page.screenshot({path:auditDir+"chat-codex-profile-error-1280x800.png",fullPage:true});
    await page.setViewportSize({width:1600,height:980});
    await picker.click();
    await page.setViewportSize({width:1280,height:800});const compact=await page.locator(".composer-bar").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(compact.scroll).toBeLessThanOrEqual(compact.client+1);
    await page.screenshot({path:auditDir+"chat-codex-profile-switched-1280x800.png",fullPage:true});

    await page.setViewportSize({width:1600,height:980});
    await page.getByRole("button",{name:"Tools",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Harness capabilities",level:2})).toBeVisible();
    const memoryCard=page.locator(".capability-card").filter({hasText:"Codex memory"});
    await expect(memoryCard).toContainText("23");
    await expect(memoryCard).toContainText("Ready");
    await expect.poll(()=>clientMessages.some(message=>message.method==="memory/status"&&message.params?._trebellThreadId===thread.id)).toBe(true);
    await expect.poll(()=>clientMessages.some(message=>message.method==="account/read"&&message.params?._trebellThreadId===thread.id)).toBe(true);
    const upstreamMemoryStatus=upstreamMessages.find(message=>message.method==="memory/status");
    const upstreamAccountRead=upstreamMessages.find(message=>message.method==="account/read");
    expect(upstreamMemoryStatus?.params).toEqual({minConsolidatedThreads:20});
    expect(upstreamAccountRead?.params).toEqual({refreshToken:false});
    await memoryCard.getByRole("button",{name:"Disable for this thread"}).click();
    await expect(memoryCard).toContainText("Memory disabled for this thread.");
    await expect.poll(()=>upstreamMessages.some(message=>message.method==="thread/memoryMode/set"&&message.params?.threadId===thread.id&&message.params?.mode==="disabled"&&!Object.prototype.hasOwnProperty.call(message.params,"_trebellThreadId"))).toBe(true);
    await memoryCard.getByRole("button",{name:"Enable for this thread"}).click();
    await expect(memoryCard).toContainText("Memory enabled for this thread.");
    await expect.poll(()=>upstreamMessages.some(message=>message.method==="thread/memoryMode/set"&&message.params?.mode==="enabled")).toBe(true);
    await memoryCard.getByRole("button",{name:"Reset memory"}).click();
    await expect(memoryCard.getByRole("button",{name:"Confirm reset"})).toBeVisible();
    await expect(memoryCard).toContainText("Click Confirm reset");
    expect(upstreamMessages.some(message=>message.method==="memory/reset")).toBe(false);
    await page.screenshot({path:auditDir+"tools-codex-memory-confirm-1600x980.png",fullPage:true});
    await memoryCard.getByRole("button",{name:"Confirm reset"}).click();
    await expect(memoryCard).toContainText("Codex memory was reset.");
    await expect.poll(()=>clientMessages.some(message=>message.method==="memory/reset"&&message.params?._trebellThreadId===thread.id)).toBe(true);
    await expect.poll(()=>upstreamMessages.some(message=>message.method==="memory/reset")).toBe(true);
    const upstreamReset=upstreamMessages.find(message=>message.method==="memory/reset");
    expect(Object.prototype.hasOwnProperty.call(upstreamReset||{},"params")).toBe(false);
    await page.setViewportSize({width:1280,height:800});
    const toolsMetrics=await page.locator(".secondary-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(toolsMetrics.scroll).toBeLessThanOrEqual(toolsMetrics.client+1);
    await page.screenshot({path:auditDir+"tools-codex-memory-1280x800.png",fullPage:true});

    await page.getByRole("button",{name:"Threads",exact:true}).click();
    await expect(picker).toBeVisible();
    await picker.click();
    await page.getByRole("button",{name:"New thread"}).click();
    await expect.poll(()=>upstreamMessages.some(message=>message.method==="thread/unsubscribe"&&message.params?.threadId===thread.id)).toBe(true);
  }finally{
    relay.close();for(const ws of upstreamSockets)try{ws.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayServer.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))]);
  }
});

test("app navigation history moves across pages and right-panel tabs",async({page,request})=>{
  test.setTimeout(40_000);
  await prepare(page,request);

  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Settings",level:1})).toBeVisible();

  await page.keyboard.down("Control");
  await page.keyboard.press("[");
  await page.keyboard.up("Control");
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  await page.screenshot({path:auditDir+"navigation-back-projects-1600x980.png",fullPage:true});

  await page.keyboard.down("Control");
  await page.keyboard.press("]");
  await page.keyboard.up("Control");
  await expect(page.getByRole("heading",{name:"Settings",level:1})).toBeVisible();

  await page.getByRole("button",{name:"Threads",exact:true}).click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  const tabs=panel.locator(".context-panel-tab-scroll");
  await expect(tabs.getByRole("button",{name:"Files",exact:true})).toHaveClass(/active/);
  await tabs.getByRole("button",{name:"Git",exact:true}).click();
  await expect(tabs.getByRole("button",{name:"Git",exact:true})).toHaveClass(/active/);

  await page.keyboard.down("Control");
  await page.keyboard.press("[");
  await page.keyboard.up("Control");
  await expect(tabs.getByRole("button",{name:"Files",exact:true})).toHaveClass(/active/);
  await page.screenshot({path:auditDir+"navigation-back-files-panel-1600x980.png",fullPage:true});

  await page.keyboard.down("Control");
  await page.keyboard.press("]");
  await page.keyboard.up("Control");
  await expect(tabs.getByRole("button",{name:"Git",exact:true})).toHaveClass(/active/);
});
