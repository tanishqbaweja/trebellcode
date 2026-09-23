import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function expectModelCatalog(page,labels){
  const picker=page.getByTestId("model-picker");await expect(picker).toBeVisible();await expect(picker).toBeEnabled({timeout:15_000});await picker.click();
  const menu=page.locator(".model-picker-menu");await expect(menu).toBeVisible();
  await expect(menu.locator("> button strong")).toHaveText(labels);
  await picker.click();await expect(menu).toBeHidden();
}
async function selectProvider(page,value){
  const selector=page.getByTestId("provider-selector");
  await selector.selectOption(value);
  await expect(page.getByTestId("provider-settings-card")).toHaveAttribute("aria-busy","false",{timeout:15_000});
  await expect(selector).toHaveValue(value);
}

test("Trebell Code renders the harness and scopes models to the selected provider", async ({ page,request }) => {
  test.setTimeout(45_000);
  const publishedThemes=join(process.env.TREBELL_E2E_HOME||join(tmpdir(),"trebell-code-e2e-home"),"themes");
  await mkdir(publishedThemes,{recursive:true});
  await writeFile(join(publishedThemes,"e2e-published.json"),JSON.stringify({name:"E2E Published",appearance:"dark",canvas:"#111827",accent:"#35c98b"}));
  await page.addInitScript(()=>{
    const snapshot={url:"http://fixture.local",title:"Preview fixture",text:"Checkout",elements:[{ref:"e7",tag:"button",text:"Submit order",href:""}]};
    window.__trebellZoomFactor=1;
    window.__updateState={supported:true,status:"available",currentVersion:"1.2.0",availableVersion:"1.3.0",percent:null,error:null};
    window.__updateListeners=[];window.__updateInstalled=false;
    const publishUpdate=patch=>{window.__updateState={...window.__updateState,...patch};for(const listener of window.__updateListeners)listener(window.__updateState);return window.__updateState};
    Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{
      zoom:{
        get:async()=>({factor:window.__trebellZoomFactor}),
        set:async factor=>({factor:window.__trebellZoomFactor=Number(factor)}),
        reset:async()=>({factor:window.__trebellZoomFactor=1}),
      },
      updates:{
        get:async()=>window.__updateState,
        check:async()=>publishUpdate({status:"available",error:null}),
        download:async()=>{publishUpdate({status:"downloading",percent:42});setTimeout(()=>publishUpdate({status:"downloaded",percent:100}),20);return window.__updateState},
        install:async()=>{window.__updateInstalled=true;publishUpdate({status:"installing"});return {ok:true}},
        onState:handler=>{window.__updateListeners.push(handler);return()=>{window.__updateListeners=window.__updateListeners.filter(item=>item!==handler)}},
      },
      browser:{navigate:async()=>({ok:true}),show:async()=>({ok:true}),snapshot:async()=>snapshot,screenshot:async()=>({dataUrl:"data:image/png;base64,iVBORw0KGgo="}),importCookies:async()=>({ok:true,imported:2,failed:0}),importSources:async()=>({platform:"win32",sources:[{id:"firefox",name:"Firefox",installed:true,running:false,profiles:[{id:"C:/Profiles/Test",name:"Test profile"}]},{id:"helium",name:"Helium",installed:true,running:false,profiles:[{id:"C:/Helium/Default",name:"Default"}]}]}),importProfile:async(sourceId,profileId)=>sourceId==="helium"?({ok:true,sourceId,profileId,profileName:"Default",imported:5,failed:0,skipped:1}):({ok:true,sourceId,profileId,profileName:"Test profile",imported:7,failed:0}),close:async()=>({ok:true})}
    }});
  });
  await request.post("/api/settings",{data:{onboardingComplete:true}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"E2E Project",worktreeSubmodules:"top-level",icon:{kind:"monogram",value:"E2",color:"#4f8cff"}}});
  await request.post("/api/environments",{data:{id:"ssh-palette",name:"E2E SSH",type:"ssh",host:"example.invalid",cwd:"/srv/app"}});
  await request.post("/api/projects",{data:{path:"/srv/app",environmentId:"ssh-palette",name:"Remote App"}});
  await page.goto("/");
  await page.evaluate(()=>{
    window.__copiedText=[];
    Object.defineProperty(navigator.clipboard,"writeText",{configurable:true,value:async text=>{window.__copiedText.push(String(text))}});
  });
  const onboarding=page.getByTestId("onboarding");
  if(await onboarding.isVisible().catch(()=>false))await onboarding.getByRole("button",{name:"Finish setup"}).click();
  await expect(page.getByText("Trebell Code").first()).toBeVisible();
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.keyboard.press("Control+b");
  await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
  await expect(page.getByRole("button",{name:"Open sidebar"})).toBeVisible();
  await page.keyboard.press("Control+b");
  await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-collapsed/);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.mode)).toBe("dark");
  const initialShell=await page.evaluate(()=>({
    sidebar:getComputedStyle(document.querySelector(".sidebar")).backgroundColor,
    main:getComputedStyle(document.querySelector(".main-frame")).backgroundColor,
    header:getComputedStyle(document.querySelector(".workspace-header")).backgroundColor,
    composer:getComputedStyle(document.querySelector(".composer-wrap")).backgroundColor,
  }));
  expect(initialShell.sidebar).toBe("rgb(17, 18, 20)");
  expect(initialShell.main).toBe("rgb(11, 12, 14)");
  expect(initialShell.header).toMatch(/^rgba?\(11, 12, 14/);
  expect(initialShell.composer).toMatch(/^rgba?\(20, 22, 25/);
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await expect(page.getByTestId("command-palette")).toContainText("Open workspace folder");
  await expect(page.getByTestId("command-palette")).toContainText("E2E Project");
  await expect(page.getByTestId("command-palette")).toContainText("Remote App");
  await expect(page.getByTestId("command-palette")).toContainText("E2E SSH · /srv/app");
  const paletteSearch=page.getByPlaceholder("Search commands, threads, and messages…");
  await paletteSearch.fill(">settings");
  await expect(page.getByTestId("command-palette")).toContainText("Settings");
  await expect(page.getByTestId("command-palette")).not.toContainText("E2E Project");
  await paletteSearch.fill("");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toBeHidden();
  await page.getByRole("button",{name:"Environments"}).click();
  const remoteEnvironmentRow=page.locator(".environment-list > div").filter({hasText:"E2E SSH"});
  await remoteEnvironmentRow.getByRole("button",{name:"Switch off"}).click();
  await expect(remoteEnvironmentRow).toContainText("switched off");
  await expect(remoteEnvironmentRow.getByRole("button",{name:"Use for agent"})).toBeDisabled();
  await expect.poll(async()=>{
    const environments=await (await request.get("/api/environments")).json();
    return environments.profiles.find(item=>item.id==="ssh-palette")?.enabled;
  }).toBe(false);
  await remoteEnvironmentRow.getByRole("button",{name:"Switch on"}).click();
  await expect.poll(async()=>{
    const environments=await (await request.get("/api/environments")).json();
    return environments.profiles.find(item=>item.id==="ssh-palette")?.enabled;
  }).toBe(true);
  await page.getByRole("button",{name:"Threads"}).click();
  await expect(page.getByTestId("model-picker")).toBeVisible();
  await expectModelCatalog(page,["deepseek/deepseek-v4-flash · 10 FB/h off-peak","test/coding-large","test/coding-fast"]);
  await expect(page.getByRole("button",{name:"New thread"})).toBeVisible();
  await expect(page.getByTestId("right-panel-toggle")).toBeVisible();
  await expect(page.getByTestId("terminal-toggle")).toBeVisible();

  await page.mouse.move(500,500);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0,-600);
  await page.keyboard.up("Control");
  await expect.poll(()=>page.evaluate(()=>window.__trebellZoomFactor)).toBeGreaterThan(1);
  await page.evaluate(()=>window.trebellDesktop.zoom.reset());

  const composer=page.getByTestId("composer");
  await composer.fill("x".repeat(120001));
  await expect(page.getByTestId("send")).toBeDisabled();
  await expect(page.getByText(/maximum 120,000/)).toBeVisible();
  await composer.fill("Build and validate a private local converter.");
  await page.getByTestId("send").click();

  await expect(page.getByText("Mock Freebuff reply: Build and validate a private local converter.")).toBeVisible({timeout:10000});
  await expect(page.getByRole("group").getByText("Freebuff direct response")).toBeVisible();

  await page.getByRole("button",{name:"Cite response"}).click();
  await expect(page.getByTestId("context-chips")).toContainText("Assistant citation");

  await page.getByTestId("right-panel-toggle").click();
  await expect(page.getByTestId("right-panel")).toBeVisible();
  const stackLayers=[
    {position:1,number:1,title:"Layer one",state:"OPEN",isDraft:false,url:"https://github.com/acme/widget/pull/1",headRefName:"layer-one",headSha:"old1",baseRefName:"main",baseSha:"base0"},
    {position:2,number:2,title:"Layer two",state:"OPEN",isDraft:false,url:"https://github.com/acme/widget/pull/2",headRefName:"layer-two",headSha:"old2",baseRefName:"layer-one",baseSha:"old1"},
  ];
  const stackSummary={number:42,size:2,position:2,baseRefName:"main",baseSha:"base0"};
  const prItems=stackLayers.map(layer=>({provider:"github",number:layer.number,title:layer.title,state:layer.state,isDraft:false,url:layer.url,headRefName:layer.headRefName,baseRefName:layer.baseRefName,stack:{...stackSummary,position:layer.position}}));
  const stackActions=[];
  await page.route("**/api/source-control/diagnostics?**",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({selectedProvider:"github",detectedProvider:"github",git:{version:"git version test"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{create:true,edit:true,comment:true,editComments:true,review:true,merge:true,autoMerge:true,updateBranch:true,checkout:true,reviewers:true,viewedFiles:"host",approveWorkflows:true,revert:true,stacks:true}}})}));
  await page.route("**/api/source-control/prs?**",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,provider:"github",capabilities:{create:true,edit:true,comment:true,editComments:true,review:true,merge:true,autoMerge:true,updateBranch:true,checkout:true,reviewers:true,viewedFiles:"host",approveWorkflows:true,revert:true,stacks:true},items:prItems})}));
  await page.route("**/api/source-control/pr-detail?**",route=>{
    const url=new URL(route.request().url());const number=Number(url.searchParams.get("number"))||2;const layer=stackLayers.find(item=>item.number===number)||stackLayers[1];
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,provider:"github",capabilities:{create:true,edit:true,comment:true,editComments:true,review:true,merge:true,autoMerge:true,updateBranch:true,checkout:true,reviewers:true,viewedFiles:"host",approveWorkflows:true,revert:true,stacks:true},item:{...layer,body:"Stacked change",comments:[],reviews:[],files:[],statusCheckRollup:[],stack:{...stackSummary,position:layer.position,layers:stackLayers,selectedNumber:number}}})});
  });
  await page.route("**/api/source-control/pr-viewed?**",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,provider:"github",store:"host",files:[],headSha:"old2"})}));
  await page.route("**/api/source-control/pr-action",async route=>{stackActions.push(route.request().postDataJSON());await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,provider:"github"})})});
  await page.getByTestId("right-panel").locator('.context-panel-tab-scroll button[aria-label="Git"]').click();
  await expect(page.getByText("stack 2/2",{exact:false})).toBeVisible();
  await page.getByRole("button",{name:/#2 Layer two/}).click();
  await expect(page.getByText("GitHub stack #42")).toBeVisible();
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"c",ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})));
  await expect.poll(()=>page.evaluate(()=>window.__copiedText.at(-1))).toBe("https://github.com/acme/widget/pull/2");
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})));
  await expect.poll(()=>page.evaluate(()=>window.__copiedText.at(-1))).toBe("#2");
  await expect(page.getByLabel("Stack merge method")).toHaveValue("squash");
  await page.getByLabel("Stack merge method").selectOption("rebase");
  page.once("dialog",dialog=>dialog.accept());
  await page.getByRole("button",{name:"Merge through #2"}).click();
  await expect.poll(()=>stackActions.length).toBe(1);
  expect(stackActions[0].action).toBe("merge");
  expect(stackActions[0].number).toBe(2);
  expect(stackActions[0].method).toBe("rebase");
  await page.getByRole("button",{name:"Maximize right panel"}).click();
  await expect(page.locator(".workspace-shell")).toHaveClass(/right-maximized/);
  await page.getByRole("button",{name:"Restore right panel"}).click();
  await expect(page.locator(".workspace-shell")).not.toHaveClass(/right-maximized/);
  await page.getByTestId("right-panel").getByRole("button",{name:"Diff"}).click();
  await expect(page.getByText("Changes",{exact:true}).first()).toBeVisible();
  await page.getByRole("button",{name:"Close right panel"}).click();
  await expect(page.getByTestId("right-panel")).toBeHidden();

  await page.getByTestId("terminal-toggle").click();
  await expect(page.getByTestId("drawer")).toBeVisible();
  const createTerminal=page.getByRole("button",{name:"Create terminal"});
  if(await createTerminal.isVisible().catch(()=>false))await createTerminal.click();
  await expect(page.locator(".terminal-pane")).toHaveCount(1);
  await page.locator(".terminal-command-line input").first().click();
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"d",ctrlKey:true,bubbles:true,cancelable:true})));
  await expect(page.locator(".terminal-pane")).toHaveCount(2);
  await expect(page.locator(".terminal-panes")).toHaveClass(/horizontal/);
  await page.locator(".terminal-command-line input").last().click();
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"d",ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})));
  await expect(page.locator(".terminal-pane")).toHaveCount(3);
  await expect(page.locator(".terminal-panes")).toHaveClass(/vertical/);
  await page.locator(".terminal-command-line input").last().click();
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"w",ctrlKey:true,bubbles:true,cancelable:true})));
  await expect(page.locator(".terminal-pane")).toHaveCount(2);
  await page.getByRole("button",{name:"Close terminal",exact:true}).click();
  await expect(page.getByTestId("drawer")).toBeHidden();

  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Projects"})).toBeVisible();
  await expect(page.getByText("Clone repository")).toBeVisible();
  await page.getByLabel("Clone environment").selectOption("ssh-palette");
  await expect(page.getByLabel("Clone parent directory")).toHaveValue("/srv/app");
  await page.getByLabel("Clone environment").selectOption("local");
  await expect(page.getByLabel("Clone parent directory")).toHaveCount(0);
  const e2eProject=page.locator(".project-card").filter({hasText:"E2E Project"});
  await expect(e2eProject.locator(".project-icon")).toHaveText("E2");
  await expect(e2eProject.getByLabel("Submodules")).toHaveValue("top-level");
  await expect(e2eProject.getByLabel("Automatic worktree cleanup")).toHaveValue("inherit");
  await page.getByRole("button",{name:/No project · General chat/}).click();
  await expect(page.getByRole("heading",{name:"What do you want to think through?"})).toBeVisible();
  await expect(page.getByRole("button",{name:"No project",exact:true})).toBeVisible();
  await expect(page.getByText("This is a General chat with no attached project.")).toBeVisible();
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await page.locator(".project-card").filter({hasText:"E2E Project"}).locator(".project-open").click();
  await expect(page.getByRole("heading",{name:"What do you want to build?"})).toBeVisible();

  await page.getByRole("button",{name:"Browser"}).click();
  await expect(page.getByTestId("right-panel")).toBeVisible();
  const previewUrl=page.locator(".preview-bar input");
  await expect(previewUrl).toHaveAttribute("title","Preview zoom 100%");
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"=",ctrlKey:true,bubbles:true,cancelable:true})));
  await expect(previewUrl).toHaveAttribute("title","Preview zoom 110%");
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"0",ctrlKey:true,bubbles:true,cancelable:true})));
  await expect(previewUrl).toHaveAttribute("title","Preview zoom 100%");
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"l",ctrlKey:true,bubbles:true,cancelable:true})));
  await expect.poll(()=>page.evaluate(()=>document.activeElement?.matches?.(".preview-bar input"))).toBe(true);
  await page.getByRole("button",{name:"Open agent browser"}).click();
  await page.getByRole("button",{name:"Import profile"}).click();
  await expect(page.getByTestId("browser-profile-import")).toContainText("Test profile");
  await expect(page.getByTestId("browser-profile-import")).toContainText("Helium");
  await page.getByTestId("browser-profile-import").getByRole("button",{name:/Test profile/}).click();
  await expect(page.getByTestId("browser-cookie-status")).toHaveText("Imported 7 cookies from Test profile");
  await page.getByRole("button",{name:"Import cookie JSON"}).click();
  await expect(page.getByTestId("browser-cookie-status")).toHaveText("Imported 2 cookies");
  await page.getByRole("button",{name:/Submit order/}).click();
  await page.getByTestId("preview-annotation").locator("textarea").fill("Use this button to submit the checkout flow.");
  await page.getByRole("button",{name:"Attach annotation"}).click();
  await expect(page.getByTestId("preview-annotation")).toContainText("Annotation attached");

  await page.getByRole("button",{name:"Freebuff"}).click();
  await expect(page.getByRole("heading",{name:"Freebuff"})).toBeVisible();
  await expect(page.getByText("Freebucks balance")).toBeVisible();

  await page.getByRole("button",{name:"Settings"}).click();
  await expect(page.getByRole("heading",{name:"Settings"})).toBeVisible();
  await expect(page.getByText("Follow-up behavior")).toBeVisible();
  await expect(page.getByText("Update available",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Download update"}).click();
  await expect(page.getByRole("button",{name:"Restart & install"})).toBeVisible();
  page.once("dialog",dialog=>dialog.accept());
  await page.getByRole("button",{name:"Restart & install"}).click();
  await expect.poll(()=>page.evaluate(()=>window.__updateInstalled)).toBe(true);
  await page.getByRole("button",{name:/Appearance/}).click();
  await page.getByLabel("Panel animations").fill("200");
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--panel-animation-ms").trim())).toBe("200ms");
  await page.getByRole("button",{name:"light",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.mode)).toBe("light");
  await page.getByRole("button",{name:/Workspace/}).click();
  await expect(page.getByTestId("scoped-settings-card").getByLabel("Automatic worktree cleanup")).toHaveValue("off");
  await page.getByRole("button",{name:"Threads"}).click();
  await expect(page.locator(".workspace-header")).toBeVisible();
  const lightShell=await page.evaluate(()=>({
    sidebar:getComputedStyle(document.querySelector(".sidebar")).backgroundColor,
    main:getComputedStyle(document.querySelector(".main-frame")).backgroundColor,
    header:getComputedStyle(document.querySelector(".workspace-header")).backgroundColor,
    provider:getComputedStyle(document.querySelector(".sidebar-provider")).backgroundColor,
    composer:getComputedStyle(document.querySelector(".composer-wrap")).backgroundColor,
  }));
  expect(lightShell.sidebar).toBe("rgb(238, 241, 244)");
  expect(lightShell.main).toBe("rgb(246, 247, 249)");
  expect(lightShell.header).toMatch(/^rgba?\(246, 247, 249/);
  expect(lightShell.provider).not.toBe("rgb(255, 255, 255)");
  expect(lightShell.composer).toMatch(/^rgba?\(255, 255, 255/);
  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("button",{name:/Appearance/}).click();
  await page.getByRole("button",{name:"Midnight",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.theme)).toBe("midnight");
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toContainText("Appearance: System");
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"dark",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.mode)).toBe("dark");
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.theme)).toBe("midnight");
  await page.getByRole("button",{name:"Threads"}).click();
  await expect(page.locator(".workspace-header")).toBeVisible();
  const darkShell=await page.evaluate(()=>({
    sidebar:getComputedStyle(document.querySelector(".sidebar")).backgroundColor,
    main:getComputedStyle(document.querySelector(".main-frame")).backgroundColor,
    composer:getComputedStyle(document.querySelector(".composer-wrap")).backgroundColor,
  }));
  expect(darkShell.sidebar).toBe("rgb(17, 18, 20)");
  expect(darkShell.main).toBe("rgb(11, 12, 14)");
  expect(darkShell.composer).toMatch(/^rgba?\(20, 22, 25/);
  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("button",{name:/Appearance/}).click();
  await expect(page.getByRole("button",{name:"E2E Published",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"E2E Published",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.theme)).toBe("environment-local-e2e-published");
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--purple").trim())).toBe("#35c98b");
  await page.getByRole("button",{name:"Midnight",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.theme)).toBe("midnight");
  await page.getByRole("button",{name:"Create theme"}).click();
  await page.locator(".theme-editor").getByLabel("Name").fill("E2E Theme");
  await page.locator(".theme-editor").getByLabel("Accent").fill("#4f8cff");
  await page.getByRole("button",{name:"Save & apply"}).click();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.customTheme)).toBe("true");
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--purple").trim())).toBe("#4f8cff");
  await page.getByRole("button",{name:/General/}).click();
  await page.getByRole("button",{name:"View licenses"}).click();
  await expect(page.getByRole("heading",{name:"Open source licenses"})).toBeVisible();
  await expect(page.getByPlaceholder("Search package, version or license")).toBeVisible();
  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("button",{name:/Workspace/}).click();
  const scopedSettings=page.getByTestId("scoped-settings-card");
  const scopedTargets=scopedSettings.locator(".scoped-settings-targets select");
  await scopedTargets.nth(0).selectOption("ssh-palette");
  await scopedSettings.getByLabel("Permissions").selectOption("full");
  await scopedSettings.getByLabel("Automatic pull").selectOption("true");
  await scopedSettings.getByLabel("Default PR merge").selectOption("rebase");
  await scopedSettings.getByLabel("Git text style").selectOption("custom");
  await scopedSettings.getByLabel("Git text model").selectOption("freebuff/test/coding-fast");
  await scopedSettings.getByLabel("Follow PR templates").selectOption("false");
  await scopedSettings.getByLabel("Custom Git instructions").fill("Prefix titles with the ticket ID.");
  await scopedSettings.getByLabel("Custom Git instructions").blur();
  await expect.poll(async()=>{
    const remoteDefaults=await (await request.get("/api/scoped-settings?environmentId=ssh-palette")).json();
    return {permission:remoteDefaults.effective.defaultPermissionMode,autoPull:remoteDefaults.effective.autoPull,merge:remoteDefaults.effective.sourceControlMergeMethod,style:remoteDefaults.effective.sourceControlTextStyle,textModel:remoteDefaults.effective.sourceControlTextModel,instructions:remoteDefaults.effective.sourceControlCustomInstructions,templates:remoteDefaults.effective.sourceControlFollowTemplates};
  }).toEqual({permission:"full",autoPull:true,merge:"rebase",style:"custom",textModel:"freebuff/test/coding-fast",instructions:"Prefix titles with the ticket ID.",templates:false});
  await scopedTargets.nth(1).selectOption({label:"Remote App · /srv/app"});
  await expect(scopedSettings.getByLabel("Permissions")).toHaveValue("__inherit__");
  await expect(scopedSettings.getByLabel("Automatic pull")).toHaveValue("__inherit__");
  await expect(scopedSettings.getByLabel("Default PR merge")).toHaveValue("__inherit__");
  await expect(scopedSettings.getByLabel("Git text style")).toHaveValue("__inherit__");
  await expect(scopedSettings.getByLabel("Git text model")).toHaveValue("__inherit__");
  await expect(scopedSettings.getByLabel("Follow PR templates")).toHaveValue("__inherit__");
  await expect(scopedSettings.getByLabel("Custom Git instructions")).toHaveValue("Prefix titles with the ticket ID.");
  await scopedSettings.getByLabel("Permissions").selectOption("edits");
  const projectListing=await (await request.get("/api/projects")).json();
  const remoteProject=projectListing.projects.find(item=>item.environmentId==="ssh-palette"&&item.path==="/srv/app");
  await expect.poll(async()=>{
    const remoteProjectScope=await (await request.get("/api/scoped-settings?environmentId=ssh-palette&projectId="+encodeURIComponent(remoteProject.id))).json();
    return {override:remoteProjectScope.overrides.defaultPermissionMode,effective:remoteProjectScope.effective.defaultPermissionMode};
  }).toEqual({override:"edits",effective:"edits"});
  await expect(scopedSettings).toHaveAttribute("aria-busy","false");
  await page.getByRole("button",{name:"Usage"}).click();
  await expect(page.getByRole("heading",{name:"Usage",exact:true})).toBeVisible();
  await expect(page.getByText("Total tokens",{exact:true})).toBeVisible();
  await page.locator(".usage-environment-filter summary").click();
  await expect(page.locator(".usage-environment-filter")).toContainText("E2E SSH");
  await page.getByLabel("E2E SSH").check();
  await expect(page.locator(".usage-environment-filter summary")).toContainText("E2E SSH");
  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();

  const providerSelector=page.getByTestId("provider-selector");

  await selectProvider(page,"justworker");
  await page.getByRole("button",{name:"Threads"}).click();
  await expectModelCatalog(page,["claude-opus-4-8"]);
  await expect(page.getByTestId("model-picker")).toContainText("claude-opus-4-8");

  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  await selectProvider(page,"hcnsec");
  await page.getByRole("button",{name:"Threads"}).click();
  await expectModelCatalog(page,["glm-5.3"]);
  await expect(page.getByTestId("model-picker")).toContainText("glm-5.3");

  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  await selectProvider(page,"vyceai");
  await page.getByRole("button",{name:"Threads"}).click();
  await expectModelCatalog(page,[
    "claude-sonnet-4-6",
    "gpt-astra",
    "deepseek-v4.1",
    "auto",
  ]);

  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  await selectProvider(page,"agentrouter");
  await expect.poll(async()=>{
    const providerState=await (await request.get("/api/providers")).json();
    return providerState.selected;
  }).toBe("agentrouter");
  await page.getByRole("button",{name:"Threads"}).click();
  await expectModelCatalog(page,[
    "gpt-5.6-sol",
    "gpt-6-astra",
    "claude-opus-4-8",
    "claude-opus-5",
    "deepseek-v4-flash",
  ]);

  await page.getByRole("button",{name:"Settings"}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  await selectProvider(page,"freebuff");
  await page.getByRole("button",{name:"Threads"}).click();
  await expectModelCatalog(page,["deepseek/deepseek-v4-flash · 10 FB/h off-peak","test/coding-large","test/coding-fast"]);
  await expect(page.getByRole("button",{name:"Freebuff"})).toBeVisible();

  await page.screenshot({path:"test-results/trebell-code-ui.png",fullPage:true});
});

test("onboarding can import matching local conversation history",async({page,request})=>{
  await request.post("/api/settings",{data:{onboardingComplete:false}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"History Workspace",activate:true}});
  let imported=false;let importBody=null;
  await page.route("**/api/history-import",async route=>{
    if(route.request().method()==="POST"){
      importBody=route.request().postDataJSON();imported=true;
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,results:[{id:"history-1",source:"claude",status:"imported",threadId:"imported-thread"}]})});
    }
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      codexImportAvailable:true,
      sessions:[{id:"history-1",source:"claude",providerSessionId:"claude-history-1",cwd:boot.cwd,title:"Fix the onboarding importer",preview:"Fix the onboarding importer",alreadyImported:imported}],
    })});
  });
  await page.goto("/");
  const onboarding=page.getByTestId("onboarding");
  await expect(onboarding).toBeVisible();
  await expect(onboarding.getByText("4. Conversation history")).toBeVisible();
  await expect(onboarding.getByText(/1 recent conversation can be copied into Trebell/)).toBeVisible();
  await onboarding.getByRole("button",{name:"Import history"}).click();
  await expect.poll(()=>importBody?.sessionIds).toEqual(["history-1"]);
  await expect(onboarding.getByText(/already imported/)).toBeVisible();
  await onboarding.getByRole("button",{name:"Finish setup"}).click();
  await expect(onboarding).toBeHidden();
});
