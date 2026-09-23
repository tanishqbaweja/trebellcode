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
  await page.locator(".workspace-header").click({position:{x:20,y:20}});
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

  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
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
      await expect(panel).toContainText("active coding agent DOM-aware browser control");
    }
    if(label==="Git"){
      await expect(panel.locator(".source-provider-field")).toBeVisible();
      await expect(panel.locator(".pr-empty-state")).toBeVisible();
    }
    if(label==="Goal"){
      await expect(panel).toContainText("No active thread");
      await expect(panel).not.toContainText("Codex");
    }
    await assertPanelBounded();
    await page.screenshot({path:auditDir+"panel-"+slug+"-1600x980.png",fullPage:true});
  }
  await page.setViewportSize({width:1280,height:800});
  await tabStrip.getByRole("button",{name:"Browser",exact:true}).click();
  await assertPanelBounded();
  await page.screenshot({path:auditDir+"panel-browser-1280x800.png",fullPage:true});
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
  await page.screenshot({path:auditDir+"chat-populated-1280x800.png",fullPage:true});
});

test("onboarding and license surfaces are visually intentional",async({page,request})=>{
  test.setTimeout(45_000);
  await request.post("/api/settings",{data:{onboardingComplete:false,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"}});
  await page.goto("/");
  const onboarding=page.getByTestId("onboarding");
  await expect(onboarding).toBeVisible();
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
  await page.screenshot({path:auditDir+"licenses-1280x800.png",fullPage:true});
  const firstLicense=page.locator(".licenses-list > button").first();
  await expect(firstLicense).toBeVisible();
  await firstLicense.click();
  await expect(page.locator(".license-detail pre")).toBeVisible();
  await page.screenshot({path:auditDir+"licenses-detail-1280x800.png",fullPage:true});
});

test("light mode stays visually coherent across workspace and panels",async({page,request})=>{
  test.setTimeout(40_000);
  await prepare(page,request);
  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("button",{name:/Appearance/}).click();
  await page.getByRole("button",{name:"light",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.mode)).toBe("light");
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
  const projectLight=await page.evaluate(()=>({
    general:getComputedStyle(document.querySelector(".general-chat-card")).backgroundColor,
    clone:getComputedStyle(document.querySelector(".clone-card")).backgroundColor,
  }));
  expect(projectLight.general).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  expect(projectLight.clone).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  await page.screenshot({path:auditDir+"light-projects-1600x980.png",fullPage:true});
  await page.getByRole("button",{name:"Environments",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Environments & remote access",level:2})).toBeVisible();
  const environmentLight=await page.locator(".environment-grid .capability-card").first().evaluate(node=>getComputedStyle(node).backgroundColor);
  expect(environmentLight).not.toMatch(/rgb\((?:1[0-9]|2[0-5]),/);
  await page.screenshot({path:auditDir+"light-environments-1600x980.png",fullPage:true});
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
