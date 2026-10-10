import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eHome } from "./test-home.js";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

const fixtureRuntimes={selectedRuntime:"codex",selectedInstanceId:"codex-default",definitions:[{id:"codex",name:"Codex",protocol:"codex",multipleInstances:true}],instances:[{id:"codex-default",kind:"codex",displayName:"Codex",enabled:true}],statuses:[{id:"codex-default",kind:"codex",name:"Codex",available:true,installed:true,authenticated:true,version:"fixture"}]};
// Opens Settings (General) the way a person does, with the harness probe kept off this host's real CLIs.
async function openSettings(page,request,name,settings={}){
  await page.route(/\/api\/agent-runtimes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(fixtureRuntimes)}));
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai",...settings}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name,activate:true}});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
}
async function savedSettings(request){return (await (await request.get("/api/state")).json()).settings}

test("manual diagnostics refresh failures preserve the last valid runtime log",async({page,request})=>{
  test.setTimeout(30_000);
  let failDiagnostics=false;
  const validDiagnostics={
    runtime:{provider:"openai",providerReady:true},
    logs:[{at:Date.now(),stream:"stdout",text:"known-good diagnostics\n"}],
  };
  await page.route(/\/api\/diagnostics(?:\?.*)?$/,route=>failDiagnostics
    ?route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate diagnostics refresh failure"})})
    :route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(validDiagnostics)}));
  await page.route(/\/api\/update\/check$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({current:true})}));
  // A manual refresh settles only after every check, the harness probe included; keep that probe off this host's real CLIs (the official Cursor launcher alone takes about 3.4 s).
  await page.route(/\/api\/agent-runtimes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({selectedRuntime:"codex",selectedInstanceId:"codex-default",definitions:[{id:"codex",name:"Codex",protocol:"codex",multipleInstances:true}],instances:[{id:"codex-default",kind:"codex",displayName:"Codex",enabled:true}],statuses:[{id:"codex-default",kind:"codex",name:"Codex",available:true,installed:true,authenticated:true,version:"fixture"}]})}));
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Settings Reliability Workspace",activate:true}});
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Diagnostics/}).click();
  const runtimeLog=page.locator(".diagnostics-log");
  await expect(runtimeLog).toContainText("known-good diagnostics");
  failDiagnostics=true;
  await page.setViewportSize({width:1280,height:800});
  const refresh=runtimeLog.getByRole("button",{name:"Refresh diagnostics",exact:true});
  await refresh.click();
  const alert=page.getByRole("alert");
  await expect(alert).toContainText("Could not refresh diagnostics: Deliberate diagnostics refresh failure");
  await expect(alert).toBeInViewport();
  await expect(runtimeLog).toContainText("known-good diagnostics");
  await expect(refresh).toBeEnabled();
  const metrics=await page.locator(".settings-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"settings-diagnostics-refresh-error-1280x800.png",fullPage:true});
});

test("Codex runtime diagnostics show unavailable state instead of assuming readiness",async({page,request})=>{
  test.setTimeout(30_000);
  await page.route(/\/api\/runtime(?:\?.*)?$/,route=>route.fulfill({
    status:200,contentType:"application/json",
    body:JSON.stringify({
      agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",
      agentRuntimeStatus:{id:"codex-default",kind:"codex",name:"Codex",available:false,message:"Codex fixture unavailable"},
      provider:"openai",providerReady:true,appServerReady:false,logs:[],
    }),
  }));
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Unavailable Runtime Workspace",activate:true}});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  const runtimeCard=page.locator('[data-setting-target="agents-runtime"]');
  await expect(runtimeCard).toContainText("Agent runtime: not ready");
  await expect(runtimeCard).not.toContainText("Inference:");
  await page.getByRole("button",{name:/Diagnostics/}).click();
  await expect(page.locator(".diag-badges span").first()).not.toHaveClass(/\bok\b/);
});

test("storage cleanup retention treats zero, negative and too-large days like the worktree field instead of one day",async({page,request})=>{
  await openSettings(page,request,"Storage Retention Workspace",{storageCleanup:{attachmentsAfterDays:7,terminalHistoryAfterDays:null}});
  await page.getByRole("button",{name:/Workspace/}).click();
  const attachments=page.getByLabel("Attachment cache retention"),terminals=page.getByLabel("Stopped terminal history");
  await expect(attachments).toHaveValue("7");
  // A 0 typed to mean "off" turns cleanup off, as the server and "After inactive days" read it, instead of the most aggressive 1 day.
  await attachments.fill("0");await attachments.press("Tab");
  await expect.poll(async()=>(await savedSettings(request)).storageCleanup).toEqual({attachmentsAfterDays:null,terminalHistoryAfterDays:null});
  await expect(attachments).toHaveValue("");
  await expect(attachments).toHaveAttribute("placeholder","Off");
  await terminals.fill("-5");await terminals.press("Tab");
  await expect(terminals).toHaveValue("");
  await page.locator(".storage-settings").screenshot({path:auditDir+"settings-storage-retention-zero-is-off.png"});
  expect((await savedSettings(request)).storageCleanup).toEqual({attachmentsAfterDays:null,terminalHistoryAfterDays:null});
  // Real day counts keep saving, and the server's 3650-day ceiling shows in the field.
  await attachments.fill("14");await attachments.press("Tab");
  await expect.poll(async()=>(await savedSettings(request)).storageCleanup.attachmentsAfterDays).toBe(14);
  await terminals.fill("99999");await terminals.press("Tab");
  await expect.poll(async()=>(await savedSettings(request)).storageCleanup.terminalHistoryAfterDays).toBe(3650);
  await expect(terminals).toHaveValue("3650");
  await expect(attachments).toHaveValue("14");
  // A failed save puts the saved 14 back instead of a blank "Off" that is not in effect.
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"
    ?route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate retention save failure"})})
    :route.continue());
  await attachments.fill("0");await attachments.press("Tab");
  await expect(page.locator(".settings-action-error")).toContainText("Deliberate retention save failure");
  await expect(attachments).toHaveValue("14");
  expect((await savedSettings(request)).storageCleanup.attachmentsAfterDays).toBe(14);
  await page.locator(".storage-settings").screenshot({path:auditDir+"settings-storage-retention-failed-save-keeps-value.png"});
});

test("failed saves from inline settings controls stay in the alert without unhandled rejections",async({page,request})=>{
  const pageErrors=[];
  page.on("pageerror",error=>pageErrors.push(String(error?.message||error)));
  page.on("console",message=>{if(message.type()==="error"&&/Uncaught|in promise/i.test(message.text()))pageErrors.push(message.text())});
  await openSettings(page,request,"Inline Save Failure Workspace",{continueThreadsAfterRestart:false,customModels:[]});
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"
    ?route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate inline save failure"})})
    :route.continue());
  const alert=page.locator(".settings-action-error");
  const restart=page.getByLabel("Continue supported active threads after restarts");
  await restart.click();
  await expect(alert).toContainText("Deliberate inline save failure");
  await expect(restart).not.toBeChecked();
  await page.getByRole("button",{name:/Appearance/}).click();
  await page.getByRole("button",{name:"light",exact:true}).click();
  await expect(alert).toContainText("Deliberate inline save failure");
  await expect(page.getByRole("button",{name:"dark",exact:true})).toHaveClass(/active/);
  // A harness caller still learns about the failure: the custom model editor stays open with its draft.
  await page.getByRole("button",{name:/Agents & models/}).click();
  await page.getByRole("button",{name:"Add custom model",exact:true}).click();
  await page.getByLabel("Model ID").fill("fixture-model-x");
  await page.getByRole("button",{name:"Save custom model",exact:true}).click();
  await expect(alert).toContainText("Deliberate inline save failure");
  await expect(page.getByLabel("Model ID")).toHaveValue("fixture-model-x");
  await page.waitForTimeout(300);
  await page.screenshot({path:auditDir+"settings-inline-save-failure-no-unhandled-rejection.png"});
  expect(pageErrors).toEqual([]);
});

test("the panel animation slider follows a drag and saves once with the final value",async({page,request})=>{
  await openSettings(page,request,"Slider Workspace",{panelAnimationMs:0});
  await page.getByRole("button",{name:/Appearance/}).click();
  const saves=[];
  page.on("request",item=>{if(item.method()==="POST"&&/\/api\/settings$/.test(item.url())){const body=item.postDataJSON();if(body&&"panelAnimationMs" in body)saves.push(body.panelAnimationMs)}});
  const slider=page.getByLabel("Panel animations",{exact:true});
  const label=page.locator(".theme-settings label").filter({has:slider});
  const box=await slider.boundingBox();const y=box.y+box.height/2;
  await page.mouse.move(box.x+3,y);await page.mouse.down();
  for(let step=1;step<=10;step++)await page.mouse.move(box.x+box.width*0.7*step/10,y,{steps:2});
  // Mid-drag the thumb and its label have moved, and nothing has been saved yet.
  const dragged=Number(await slider.inputValue());
  expect(dragged).toBeGreaterThan(0);
  await expect(label).toContainText(dragged+" ms");
  await page.locator(".theme-settings").screenshot({path:auditDir+"settings-panel-animation-mid-drag.png"});
  expect(saves).toEqual([]);
  await page.mouse.up();
  await expect.poll(()=>saves.length).toBe(1);
  await page.waitForTimeout(600);
  expect(saves).toEqual([dragged]);
  await expect.poll(async()=>(await savedSettings(request)).panelAnimationMs).toBe(dragged);
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--panel-animation-ms").trim())).toBe(dragged+"ms");
  // Keyboard steps settle into one save too.
  await slider.press("ArrowLeft");await slider.press("ArrowLeft");
  await expect(label).toContainText((dragged-50)+" ms");
  await expect.poll(()=>saves.length).toBe(2);
  await page.waitForTimeout(600);
  expect(saves).toEqual([dragged,dragged-50]);
  await expect(slider).toHaveValue(String(dragged-50));
  await page.locator(".theme-settings").screenshot({path:auditDir+"settings-panel-animation-saved-once.png"});
  // Leaving Settings before the slider settles still saves the last value.
  await slider.press("ArrowRight");await slider.press("ArrowRight");await slider.press("ArrowRight");await slider.press("ArrowRight");
  await page.getByRole("button",{name:"History",exact:true}).click();
  await expect.poll(async()=>(await savedSettings(request)).panelAnimationMs).toBe(dragged+50);
  expect(saves).toEqual([dragged,dragged-50,dragged+50]);
});

test("deleting a custom theme offers the app's undo toast and Undo puts it back",async({page,request})=>{
  const warm={id:"custom-reliability-warm",name:"Warm paper",appearance:"light",canvas:"#f4efe6",accent:"#b0582f",colors:{}};
  const slate={id:"custom-reliability-slate",name:"Slate night",appearance:"dark",canvas:"#141820",accent:"#5b8cff",colors:{}};
  await openSettings(page,request,"Theme Undo Workspace",{customThemes:[warm,slate],appearance:warm.id,environmentThemeSelections:{}});
  await page.getByRole("button",{name:/Appearance/}).click();
  const themes=page.getByRole("group",{name:"Theme"});
  await expect(themes.getByRole("button",{name:"Warm paper",exact:true})).toHaveClass(/active/);
  await page.getByRole("button",{name:"Delete selected",exact:true}).click();
  const toast=page.getByTestId("thread-undo-toast");
  await expect(toast).toContainText("Theme “Warm paper” deleted");
  await expect(themes.getByRole("button",{name:"Warm paper",exact:true})).toHaveCount(0);
  await expect(page.locator(".theme-settings")).not.toContainText("Theme removed.");
  await expect.poll(async()=>(await savedSettings(request)).customThemes.map(item=>item.id)).toEqual([slate.id]);
  await page.screenshot({path:auditDir+"settings-theme-delete-undo-toast.png"});
  await toast.getByRole("button",{name:"Undo",exact:true}).click();
  await expect(toast).toHaveCount(0);
  await expect(themes.getByRole("button",{name:"Warm paper",exact:true})).toHaveClass(/active/);
  await expect(themes.getByRole("button")).toHaveText(["Trebell","Midnight","Black","Warm paper","Slate night"]);
  await expect.poll(async()=>{const saved=await savedSettings(request);return {ids:saved.customThemes.map(item=>item.id),appearance:saved.appearance}}).toEqual({ids:[warm.id,slate.id],appearance:warm.id});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.customTheme)).toBe("true");
  await page.screenshot({path:auditDir+"settings-theme-delete-undone.png"});
});

test("a failed theme Undo is reported by the app's error toast once Settings is closed, and by the Settings alert while open",async({page,request})=>{
  const pageErrors=[];
  page.on("pageerror",error=>pageErrors.push(String(error?.message||error)));
  const warm={id:"custom-reliability-undo-failure",name:"Warm paper",appearance:"light",canvas:"#f4efe6",accent:"#b0582f",colors:{}};
  const toast=page.getByTestId("thread-undo-toast"),appError=page.getByTestId("app-action-error");
  const failSaves=()=>page.route(/\/api\/settings$/,route=>route.request().method()==="POST"
    ?route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate theme undo failure"})})
    :route.continue());
  await openSettings(page,request,"Theme Undo Failure Workspace",{customThemes:[warm],appearance:warm.id,environmentThemeSelections:{}});
  await page.getByRole("button",{name:/Appearance/}).click();
  await page.getByRole("button",{name:"Delete selected",exact:true}).click();
  await expect(toast).toContainText("Theme “Warm paper” deleted");
  // Undo from another page: the Settings alert is gone with Settings, so the app's error toast says so.
  await page.getByRole("button",{name:"History",exact:true}).click();
  await failSaves();
  await toast.getByRole("button",{name:"Undo",exact:true}).click();
  await expect(appError).toContainText("Undo failed: Deliberate theme undo failure");
  expect((await savedSettings(request)).customThemes).toEqual([]);
  await page.screenshot({path:auditDir+"settings-theme-undo-failed-after-leaving.png"});
  await page.unroute(/\/api\/settings$/);
  // Undo on Settings: the Settings alert reports it, without a second app toast.
  await openSettings(page,request,"Theme Undo Failure Workspace",{customThemes:[warm],appearance:warm.id,environmentThemeSelections:{}});
  await page.getByRole("button",{name:/Appearance/}).click();
  await page.getByRole("button",{name:"Delete selected",exact:true}).click();
  await expect(toast).toContainText("Theme “Warm paper” deleted");
  await failSaves();
  await toast.getByRole("button",{name:"Undo",exact:true}).click();
  await expect(page.locator(".settings-action-error")).toContainText("Deliberate theme undo failure");
  await page.waitForTimeout(300);
  await expect(appError).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("a theme note clears once another theme is chosen",async({page,request})=>{
  const published=join(e2eHome(),"themes");
  await mkdir(published,{recursive:true});
  await writeFile(join(published,"reliability-published.json"),JSON.stringify({name:"Reliability Published",appearance:"dark",canvas:"#101820",accent:"#2fb6a0"}));
  await openSettings(page,request,"Theme Note Workspace",{customThemes:[],appearance:"dark",environmentThemeSelections:{}});
  await page.getByRole("button",{name:/Appearance/}).click();
  await page.getByRole("button",{name:"Create theme",exact:true}).click();
  await page.locator(".theme-editor").getByLabel("Name").fill("Note theme");
  await page.getByRole("button",{name:"Save & apply",exact:true}).click();
  const card=page.locator(".theme-settings");
  await expect(card).toContainText("Theme saved and applied.");
  await page.locator(".environment-theme-settings").getByRole("button",{name:"Reliability Published",exact:true}).click();
  await expect(page.locator(".environment-theme-settings").getByRole("button",{name:"Reliability Published",exact:true})).toHaveClass(/active/);
  await expect(card).not.toContainText("Theme saved and applied.");
  await page.locator(".settings-grid").screenshot({path:auditDir+"settings-theme-note-cleared.png"});
});

test("a failed release check in General can be retried on its own",async({page,request})=>{
  let releaseChecks=0;
  await page.route(/\/api\/update\/check$/,route=>{releaseChecks++;return releaseChecks===1
    ?route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({current:"1.6.0",error:"GitHub release check failed (403): API rate limit exceeded"})})
    :route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({current:"1.6.0",latest:"v1.6.1",url:"https://example.invalid/releases/v1.6.1"})})});
  const otherChecks=[];
  page.on("request",item=>{if(/\/api\/(diagnostics|storage-cleanup)/.test(item.url()))otherChecks.push(item.url())});
  await openSettings(page,request,"Release Retry Workspace");
  const updates=page.locator(".update-settings");
  await expect(updates).toContainText("GitHub release check failed (403)");
  const retry=updates.getByRole("button",{name:"Check again",exact:true});
  await expect(retry).toBeVisible();
  await updates.screenshot({path:auditDir+"settings-release-check-failed-retry.png"});
  await retry.click();
  await expect(updates).toContainText("Latest: 1.6.1");
  await expect(retry).toHaveCount(0);
  expect(releaseChecks).toBe(2);
  expect(otherChecks).toEqual([]);
  await updates.screenshot({path:auditDir+"settings-release-check-retried.png"});
});

test("the Runtime card refresh does not report a failing release check as a diagnostics failure",async({page,request})=>{
  let releaseChecks=0;
  await page.route(/\/api\/update\/check$/,route=>{releaseChecks++;return route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({current:"1.6.0",error:"GitHub release check failed (403): API rate limit exceeded"})})});
  await openSettings(page,request,"Runtime Refresh Workspace");
  await page.getByRole("button",{name:/Agents & models/}).click();
  const runtimeCard=page.locator('[data-setting-target="agents-runtime"]');
  const refresh=runtimeCard.getByRole("button",{name:/Refresh/});
  const checksBefore=releaseChecks;
  await refresh.click();
  await expect(refresh).toHaveText("Refresh diagnostics");
  await expect(refresh).toBeEnabled();
  await page.waitForTimeout(300);
  await expect(page.locator(".settings-action-error")).toHaveCount(0);
  expect(releaseChecks).toBe(checksBefore);
  await runtimeCard.screenshot({path:auditDir+"settings-runtime-card-refresh-ignores-release-check.png"});
});
