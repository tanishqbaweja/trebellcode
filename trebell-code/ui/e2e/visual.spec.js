import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

test("settings page visual audit",async({page,request})=>{
  test.setTimeout(45_000);
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
  await page.screenshot({path:auditDir+"settings-general-1600x980.png",fullPage:true});

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
  await page.screenshot({path:auditDir+"settings-workspace-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:/Appearance/}).click();
  await expect(page.getByRole("heading",{name:"Appearance",level:3})).toBeVisible();
  await page.screenshot({path:auditDir+"settings-appearance-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:/Desktop/}).click();
  await expect(page.getByRole("heading",{name:"Background mode"})).toBeVisible();
  await page.screenshot({path:auditDir+"settings-desktop-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:/Shortcuts/}).click();
  await expect(page.getByRole("heading",{name:"Keyboard shortcuts"})).toBeVisible();
  await page.screenshot({path:auditDir+"settings-shortcuts-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:/Diagnostics/}).click();
  await expect(page.getByRole("heading",{name:"Diagnostics",level:3})).toBeVisible();
  await expect(page.getByText("Runtime log",{exact:true})).toBeVisible();
  await page.screenshot({path:auditDir+"settings-diagnostics-1600x980.png",fullPage:true});

  await page.getByRole("button",{name:/General/}).click();
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"settings-general-1280x800.png",fullPage:true});
  const compact=await pageShell.evaluate(node=>({clientWidth:node.clientWidth,scrollWidth:node.scrollWidth}));
  expect(compact.scrollWidth).toBeLessThanOrEqual(compact.clientWidth+1);
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
    if(label==="Diff")await expect(panel.locator(".changes-empty")).toBeVisible();
    if(label==="Browser")await expect(panel.locator(".preview-empty-state")).toBeVisible();
    if(label==="Git"){
      await expect(panel.locator(".source-provider-field")).toBeVisible();
      await expect(panel.locator(".pr-empty-state")).toBeVisible();
    }
    await assertPanelBounded();
    await page.screenshot({path:auditDir+"panel-"+slug+"-1600x980.png",fullPage:true});
  }
  await page.setViewportSize({width:1280,height:800});
  await tabStrip.getByRole("button",{name:"Browser",exact:true}).click();
  await assertPanelBounded();
  await page.screenshot({path:auditDir+"panel-browser-1280x800.png",fullPage:true});
});
