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
  await expect(page.getByRole("heading",{name:"Browser profiles"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"SnapShots"})).toBeVisible();
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
  await page.getByTestId("right-panel-toggle").click();
  await expect(page.getByTestId("right-panel")).toBeVisible();
  await page.screenshot({path:auditDir+"light-chat-panel-1600x980.png",fullPage:true});
  await page.setViewportSize({width:1280,height:800});
  await page.screenshot({path:auditDir+"light-chat-panel-1280x800.png",fullPage:true});
});

test("populated source control and pull request detail stay usable",async({page,request})=>{
  test.setTimeout(45_000);
  await page.route(/\/api\/git\/info\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    isGit:true,root:"H:\\Github Repositories\\Trebell\\trebell-code",branch:"feature/ui-polish",branches:["main","feature/ui-polish"],upstream:"origin/feature/ui-polish",
    status:[{code:" M",path:"ui/src/App.jsx"},{code:"??",path:"ui/e2e/new-visual.spec.js"}],
    remotes:[{name:"origin",url:"https://github.com/example/trebellcode.git"}],
    worktrees:[{path:"H:\\Github Repositories\\Trebell\\trebell-code",branch:"feature/ui-polish"},{path:"H:\\Github Repositories\\Trebell\\trebell-code-review",branch:"review/pr-142"}],
  })}));
  await page.route(/\/api\/source-control\/diagnostics\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    selectedProvider:"github",detectedProvider:"github",git:{version:"git version 2.51.0.windows.1"},
    providers:{github:{label:"GitHub",installed:true,authenticated:true}},
    capabilities:{github:{create:true,comment:true,review:true,merge:true,updateBranch:true,edit:true,checkout:true,reviewers:true,approveWorkflows:true,autoMerge:true,revert:true,editComments:true}},
  })}));
  const listPr={number:142,title:"Polish Trebell desktop interaction states",state:"OPEN",headRefName:"feature/ui-polish",baseRefName:"main",provider:"github",url:"https://github.com/example/trebellcode/pull/142"};
  await page.route(/\/api\/source-control\/prs\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    items:[listPr,{number:139,title:"Add remote runtime diagnostics",state:"OPEN",headRefName:"runtime-diagnostics",baseRefName:"main",provider:"github",url:"https://github.com/example/trebellcode/pull/139"}],
    capabilities:{create:true,comment:true,review:true,merge:true,updateBranch:true,edit:true,checkout:true,reviewers:true,approveWorkflows:true,autoMerge:true,revert:true,editComments:true},
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
  const metrics=await panel.locator(".context-panel-body").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"source-control-pr-detail-1600x980.png",fullPage:true});
  await page.setViewportSize({width:1280,height:800});
  await panel.getByRole("button",{name:/#142 Polish Trebell desktop interaction states/}).click();
  await expect(panel.getByRole("heading",{name:/#142 Polish Trebell desktop interaction states/})).toBeInViewport();
  await page.screenshot({path:auditDir+"source-control-pr-detail-1280x800.png",fullPage:true});
});
