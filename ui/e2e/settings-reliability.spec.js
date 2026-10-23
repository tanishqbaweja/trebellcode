import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,rm,writeFile } from "node:fs/promises";
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
const shots=fileURLToPath(new URL("../../visual-audit/polish/settings-reliability/",import.meta.url));mkdirSync(shots,{recursive:true});
// The header's mode button, clicked as a person switches between dark and light.
async function switchMode(page,mode){
  if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
}
// Screenshots of what is on screen in dark and light, at 1280 and 900 wide, with show (a locator) brought into view at each width;
// the page is left dark at 1280.
async function shootModes(page,name,{height=800,show=null}={}){
  for(const mode of ["dark","light"]){
    await page.setViewportSize({width:1280,height});await switchMode(page,mode);
    for(const width of [1280,900]){await page.setViewportSize({width,height});await show?.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:shots+`${name}-${mode}-${width}.png`})}
  }
  await page.setViewportSize({width:1280,height});await switchMode(page,"dark");
}
// Replaces what a field holds the way a person does: click into it, select all, type.
async function typeInto(page,field,text){await field.click();await page.keyboard.press("Control+A");await page.keyboard.type(text,{delay:5})}
// The person turns the mouse wheel over the settings list, a notch at a time: back up until target is under the bottom of the window
// (or the page is at its top), then down only until all of it shows.
async function wheelUntilShown(page,target){
  const nav=await page.locator(".settings-nav").boundingBox(),height=page.viewportSize().height;
  await page.mouse.move(nav.x+nav.width/2,nav.y+nav.height-6);
  const top=async()=>(await target.boundingBox()).y;
  for(let notch=0,last=null;notch<200;notch++){const y=await top();if(y>=height||y===last)break;last=y;await page.mouse.wheel(0,-40);await page.waitForTimeout(60)}
  for(let notch=0;notch<200;notch++){const box=await target.boundingBox();if(box.y+box.height<=height)return;await page.mouse.wheel(0,25);await page.waitForTimeout(60)}
  throw new Error("The wheel never brought the control into view");
}

// The mock server keeps settings and published themes for the whole run: leave the theme state, and storage cleanup off, as the specs
// after this one expect them.
test.afterEach(async({request})=>{
  await rm(join(e2eHome(),"themes","reliability-published.json"),{force:true});
  await request.post("/api/settings",{data:{appearance:"dark",appearanceMode:"dark",customThemes:[],environmentThemeSelections:{},storageCleanup:{attachmentsAfterDays:null,terminalHistoryAfterDays:null}}});
});

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
  await page.screenshot({animations:"disabled",path:auditDir+"settings-diagnostics-refresh-error-1280x800.png",fullPage:true});
});

test("Codex runtime diagnostics show unavailable state instead of assuming readiness",async({page,request})=>{
  test.setTimeout(30_000);
  // The harness list says Codex is ready and the runtime poll says it is not. The runtime card and the Diagnostics chip take the
  // poll's answer first (harnessCheck), so they say "not ready" only when Settings hands them the poll. The list is answered here
  // because the offline E2E server's own list finds no harness CLI (offline-e2e-host.mjs) and would say "not ready" as well.
  await page.route(/\/api\/agent-runtimes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(fixtureRuntimes)}));
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
  // The list has answered, and says Codex is ready: a "not ready" card from here on comes from the poll.
  await expect(page.locator('[data-setting-target="agents-harness"]')).toContainText("Codex · ready");
  const runtimeCard=page.locator('[data-setting-target="agents-runtime"]');
  await expect(runtimeCard).toContainText("Agent runtime: not ready");
  await expect(runtimeCard).not.toContainText("Inference:");
  await page.getByRole("button",{name:/Diagnostics/}).click();
  // Once the runtime has answered, the unavailable harness reads as a warning (not as still loading, and not as ready).
  await expect(page.locator(".diag-badges span").first()).toHaveClass(/\bwarn\b/);
});

test("Diagnostics stays neutral while its first answers load, then shows the real state",async({page,request})=>{
  test.setTimeout(40_000);
  let releaseDiagnostics=()=>{},releaseRuntime=()=>{},releaseHarnesses=()=>{};
  const diagnosticsAnswered=new Promise(resolve=>{releaseDiagnostics=resolve}),runtimeAnswered=new Promise(resolve=>{releaseRuntime=resolve}),harnessesAnswered=new Promise(resolve=>{releaseHarnesses=resolve});
  const native={id:"native-default",kind:"native",name:"Trebell Native",available:true,installed:true,authenticated:true};
  const fulfill=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
  // The harness chip takes the runtime poll's answer or the harness list's (the same probe), so both are held at first.
  await page.route(/\/api\/agent-runtimes$/,async route=>{await harnessesAnswered;return fulfill(route,{selectedRuntime:"native",selectedInstanceId:"native-default",definitions:[{id:"native",name:"Trebell Native",protocol:"native"}],instances:[{id:"native-default",kind:"native",displayName:"Trebell Native",enabled:true}],statuses:[native]})});
  await page.route(/\/api\/diagnostics(?:\?.*)?$/,async route=>{await diagnosticsAnswered;return fulfill(route,{version:"fixture",runtime:{provider:"openai",providerReady:true},logs:[]})});
  await page.route(/\/api\/runtime(?:\?.*)?$/,async route=>{await runtimeAnswered;return fulfill(route,{agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeStatus:native,provider:"openai",providerReady:true,appServerReady:true,logs:[]})});
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Diagnostics Pending Workspace",activate:true}});
  try{
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Diagnostics/}).click();
    const chips=page.locator(".diag-badges span"),log=page.locator(".diagnostics-log");
    await expect(chips).toHaveCount(2);
    const palette=await page.evaluate(()=>{const probe=document.createElement("span");document.querySelector(".settings-page").appendChild(probe);probe.style.color="var(--warn)";const warn=getComputedStyle(probe).color;probe.style.color="var(--ok)";const ok=getComputedStyle(probe).color;probe.remove();return {warn,ok}});
    const chipColors=()=>chips.evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).color));
    // Neither answer has arrived: an unknown state is not a warning (amber) and not ready (green), and the log is loading, not empty.
    await expect(log).toContainText("Loading runtime log");
    await expect(log).not.toContainText("No runtime activity yet");
    for(const color of await chipColors()){expect(color).not.toBe(palette.warn);expect(color).not.toBe(palette.ok)}
    // Before the harness list names the harness, the chip names it as people know it, not by its id ("native").
    await expect(chips.nth(0)).toHaveText("Trebell Native");
    await page.screenshot({animations:"disabled",path:auditDir+"settings-diagnostics-pending-1280x800.png"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    for(const color of await chipColors()){expect(color).not.toBe(palette.warn)}
    await page.screenshot({animations:"disabled",path:auditDir+"settings-diagnostics-pending-light-1280x800.png"});
    // The harness list answers first: the harness chip shows its ready state while the runtime poll and the provider read are still out.
    releaseHarnesses();
    await expect(chips.nth(0)).toHaveClass(/\bok\b/);
    await expect(chips.nth(1)).toHaveClass(/\bpending\b/);await expect(page.locator(".diag-badges")).toHaveAttribute("aria-busy","true");
    releaseDiagnostics();releaseRuntime();
    // The answers arrive: both report ready, and an empty log now says there is no activity.
    await expect(log).toContainText("No runtime activity yet");
    await expect(chips.nth(0)).toHaveClass(/\bok\b/);await expect(chips.nth(1)).toHaveClass(/\bok\b/);
    await expect(page.locator(".diag-badges")).toHaveAttribute("aria-busy","false");
    await page.screenshot({animations:"disabled",path:auditDir+"settings-diagnostics-loaded-light-1280x800.png"});
  }finally{releaseDiagnostics();releaseRuntime();releaseHarnesses()}
});

// The harness list as the server sends it for a ready Trebell Native, or a failure, and a runtime poll that fails on every round.
const NATIVE_STATUS={id:"native-default",kind:"native",name:"Trebell Native",available:true,installed:true,authenticated:true};
const NATIVE_RUNTIMES={selectedRuntime:"native",selectedInstanceId:"native-default",definitions:[{id:"native",name:"Trebell Native",protocol:"native"}],instances:[{id:"native-default",kind:"native",displayName:"Trebell Native",enabled:true}],statuses:[NATIVE_STATUS]};
const fulfillJson=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
async function openNativeSettings(page,request,name){
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name,activate:true}});
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
}

test("a failing runtime poll does not leave the Diagnostics harness chip checking for good",async({page,request})=>{
  test.setTimeout(60_000);
  let runtimeCalls=0,harnessListFails=false;
  await page.route(/\/api\/runtime(?:\?.*)?$/,route=>{runtimeCalls++;return fulfillJson(route,{error:"Deliberate runtime poll failure"},500)});
  await page.route(/\/api\/agent-runtimes$/,route=>harnessListFails?fulfillJson(route,{error:"Deliberate harness list failure"},500):fulfillJson(route,NATIVE_RUNTIMES));
  await openNativeSettings(page,request,"Runtime Poll Failure Workspace");
  await page.getByRole("button",{name:/Diagnostics/}).click();
  const badges=page.locator(".diag-badges"),chips=badges.locator("span");
  await expect(chips).toHaveCount(2);
  // Every runtime poll fails, but the harness list this section loads is the same probe: the chip shows its answer and nothing stays busy.
  await expect.poll(()=>runtimeCalls,{timeout:15_000}).toBeGreaterThanOrEqual(2);
  await expect(chips.nth(0)).toHaveClass(/\bok\b/);
  await expect(badges).toHaveAttribute("aria-busy","false");
  await page.screenshot({animations:"disabled",path:auditDir+"settings-diagnostics-runtime-poll-failed-1280x800.png"});
  // With the harness list failing as well, nothing says whether the harness is ready: the chip is unknown (neutral, not busy) and says why.
  harnessListFails=true;
  await page.reload();
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Diagnostics/}).click();
  const harness=chips.nth(0);
  await expect(harness).toHaveAttribute("title","Could not check the harness: Deliberate harness list failure");
  await expect(harness).not.toHaveClass(/\b(pending|warn|ok)\b/);
  await expect(harness).toHaveText("Trebell Native");
  await expect(badges).toHaveAttribute("aria-busy","false");
  for(const mode of ["dark","light"]){
    await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
    const colors=await harness.evaluate(node=>{const probe=document.createElement("span");node.parentElement.appendChild(probe);probe.style.color="var(--warn)";const warn=getComputedStyle(probe).color;probe.style.color="var(--ok)";const ok=getComputedStyle(probe).color;probe.remove();return {chip:getComputedStyle(node).color,warn,ok}});
    expect(colors.chip,mode).not.toBe(colors.warn);expect(colors.chip,mode).not.toBe(colors.ok);
    await page.screenshot({animations:"disabled",path:auditDir+`settings-diagnostics-harness-unknown-${mode}-1280x800.png`});
  }
  // The Agents & models runtime card says the same: unknown, not "not ready".
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
  await page.getByRole("button",{name:/Agents & models/}).click();
  const runtimeCard=page.locator('[data-setting-target="agents-runtime"]');
  await expect(runtimeCard).toContainText("Agent runtime: unknown");
  await expect(runtimeCard).not.toContainText("not ready");
});

test("the Agents & models runtime card says checking until the harness answers instead of not ready",async({page,request})=>{
  test.setTimeout(40_000);
  let releaseRuntime=()=>{},releaseHarnesses=()=>{};
  const runtimeAnswered=new Promise(resolve=>{releaseRuntime=resolve}),harnessesAnswered=new Promise(resolve=>{releaseHarnesses=resolve});
  await page.route(/\/api\/runtime(?:\?.*)?$/,async route=>{await runtimeAnswered;return fulfillJson(route,{agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeStatus:NATIVE_STATUS,provider:"openai",providerReady:true,appServerReady:true,logs:[]})});
  await page.route(/\/api\/agent-runtimes$/,async route=>{await harnessesAnswered;return fulfillJson(route,NATIVE_RUNTIMES)});
  try{
    await openNativeSettings(page,request,"Runtime Card Pending Workspace");
    await page.getByRole("button",{name:/Agents & models/}).click();
    const runtimeCard=page.locator('[data-setting-target="agents-runtime"]');
    await expect(runtimeCard).toBeVisible();
    // Nothing has answered yet: the harness is being checked, which is not the same as not ready.
    await expect(runtimeCard).toContainText("Agent runtime: checking…");
    await expect(runtimeCard).not.toContainText("not ready");
    await expect(runtimeCard).toContainText("Agent: Trebell Native");
    await runtimeCard.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"settings-agents-runtime-card-checking-1280x800.png"});
    releaseHarnesses();releaseRuntime();
    await expect(runtimeCard).toContainText("Agent runtime: ready");
    await page.screenshot({animations:"disabled",path:auditDir+"settings-agents-runtime-card-ready-1280x800.png"});
  }finally{releaseRuntime();releaseHarnesses()}
});

test("a failed first Diagnostics read leaves the provider chip neutral and names the failure instead of checking forever",async({page,request})=>{
  test.setTimeout(40_000);
  const native={id:"native-default",kind:"native",name:"Trebell Native",available:true,installed:true,authenticated:true};
  const fulfill=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
  await page.route(/\/api\/agent-runtimes$/,route=>fulfill(route,{selectedRuntime:"native",selectedInstanceId:"native-default",definitions:[{id:"native",name:"Trebell Native",protocol:"native"}],instances:[{id:"native-default",kind:"native",displayName:"Trebell Native",enabled:true}],statuses:[native]}));
  await page.route(/\/api\/diagnostics(?:\?.*)?$/,route=>fulfill(route,{error:"Deliberate first diagnostics failure"},500));
  await page.route(/\/api\/runtime(?:\?.*)?$/,route=>fulfill(route,{agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeStatus:native,provider:"openai",providerReady:true,appServerReady:true,logs:[]}));
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Diagnostics Failed Workspace",activate:true}});
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Diagnostics/}).click();
  const badges=page.locator(".diag-badges"),chips=badges.locator("span"),log=page.locator(".diagnostics-log");
  await expect(log).toContainText("Runtime log unavailable");
  await expect(log).toContainText("Deliberate first diagnostics failure");
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveClass(/\bok\b/);
  // The read failed, so nothing is being checked any more: the provider chip is not busy, not amber, not green, and says why.
  await expect(badges).toHaveAttribute("aria-busy","false");
  const provider=chips.nth(1);
  await expect(provider).not.toHaveClass(/\b(pending|warn|ok)\b/);
  await expect(provider).toHaveAttribute("title","Could not check the provider: Deliberate first diagnostics failure");
  const colors=await provider.evaluate(node=>{const probe=document.createElement("span");node.parentElement.appendChild(probe);probe.style.color="var(--warn)";const warn=getComputedStyle(probe).color;probe.style.color="var(--ok)";const ok=getComputedStyle(probe).color;probe.remove();return {chip:getComputedStyle(node).color,warn,ok}});
  expect(colors.chip).not.toBe(colors.warn);expect(colors.chip).not.toBe(colors.ok);
  await page.screenshot({animations:"disabled",path:auditDir+"settings-diagnostics-read-failed-1280x800.png"});
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
  // Small caches show their size in a unit that keeps it readable, never "0.0 MB" for a cache that holds files.
  const storageSummary=page.locator(".storage-settings .provider-note").filter({hasText:"cached attachment"});
  await expect(storageSummary).not.toContainText("0.0 MB");
  await expect(storageSummary).toContainText(/cached attachments? · \d+(\.\d)? (B|KB|MB|GB)/);
  await page.locator(".storage-settings").screenshot({animations:"disabled",path:auditDir+"settings-storage-retention-zero-is-off.png"});
  expect((await savedSettings(request)).storageCleanup).toEqual({attachmentsAfterDays:null,terminalHistoryAfterDays:null});
  // Real day counts keep saving, and the server's 3650-day ceiling shows in the field. The person leaves the second field while the
  // first one's save is still on its way: the server has saved 14, but its answer is held back (a busy disk or a slow link) until
  // the second save has been sent. Each save names only its own field, so the second does not send the first one's old value back.
  const posts=[];let releaseFirst=()=>{},firstAnswered=()=>{};
  const firstHeld=new Promise(resolve=>{releaseFirst=resolve}),firstDelivered=new Promise(resolve=>{firstAnswered=resolve});
  await page.route(/\/api\/settings$/,async route=>{
    if(route.request().method()!=="POST")return route.fallback();
    posts.push(route.request().postDataJSON());
    if(posts.length===1){const response=await route.fetch();await firstHeld;await route.fulfill({response});firstAnswered();return}
    releaseFirst();await firstDelivered;return route.fallback();
  });
  await attachments.fill("14");await attachments.press("Tab");
  await expect.poll(async()=>(await savedSettings(request)).storageCleanup.attachmentsAfterDays).toBe(14);
  await terminals.fill("99999");await terminals.press("Tab");
  await expect.poll(()=>posts.length,{message:"the second field's save was sent"}).toBe(2);
  await expect.poll(async()=>(await savedSettings(request)).storageCleanup,{message:"both fields as saved"}).toEqual({attachmentsAfterDays:14,terminalHistoryAfterDays:3650});
  await expect(terminals).toHaveValue("3650");
  await expect(attachments).toHaveValue("14");
  expect(posts.map(body=>body.storageCleanup),"each save names only the field that was left").toEqual([{attachmentsAfterDays:14},{terminalHistoryAfterDays:3650}]);
  await page.locator(".storage-settings").screenshot({animations:"disabled",path:auditDir+"settings-storage-retention-two-fields-saved.png"});
  await page.unroute(/\/api\/settings$/);
  // A failed save puts the saved 14 back instead of a blank "Off" that is not in effect.
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"
    ?route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate retention save failure"})})
    :route.continue());
  await attachments.fill("0");await attachments.press("Tab");
  await expect(page.locator(".settings-action-error")).toContainText("Deliberate retention save failure");
  await expect(attachments).toHaveValue("14");
  expect((await savedSettings(request)).storageCleanup.attachmentsAfterDays).toBe(14);
  await page.locator(".storage-settings").screenshot({animations:"disabled",path:auditDir+"settings-storage-retention-failed-save-keeps-value.png"});
});

// A SnapShots switch flipped while another one's save is on its way keeps that other change: a switch shows the saved state until
// its save answers, and each save sent the settings as they showed, so the second save turned the first switch back.
test("SnapShots switches flipped while a save is on its way all stick, with the mouse or the keyboard",async({page,request})=>{
  await page.addInitScript(()=>{
    // As desktop/main.mjs takes snapshot:configure: one call at a time in the order sent, each merged into the saved settings
    // (normalizeSnapshotConfig), and the shortcut registered while SnapShots is on. window.__snapshotsBusy holds every call, as a
    // busy main process does.
    const saved={enabled:false,shortcut:"CommandOrControl+Shift+S",includeText:false,playSound:true,sound:"soft-pop",flash:false,animations:true};
    let main=Promise.resolve(),registered=null;window.__snapshotSaves=[];
    const queued=fn=>(...args)=>{const call=main.then(()=>window.__snapshotsBusy).then(()=>fn(...args));main=call.catch(()=>{});return call};
    const configure=queued(input=>{
      for(const key of Object.keys(saved))if(key in input)saved[key]=typeof saved[key]==="boolean"?Boolean(input[key]):String(input[key]||saved[key]);
      registered=saved.enabled?saved.shortcut:null;return {...saved,registered:Boolean(registered)};
    });
    Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{
      snapshots:{
        get:queued(()=>({...saved,registered:Boolean(registered),platform:"win32",pending:0})),
        configure:(input={})=>{window.__snapshotSaves.push(input);return configure(input)},
        pending:async()=>[],read:async id=>{throw new Error("ENOENT: snapshot "+id)},ack:async id=>({ok:true,id}),capture:async()=>({ok:true}),onCaptured:()=>()=>{},
      },
      background:{set:async()=>({ok:true})},
    }});
  });
  await openSettings(page,request,"SnapShots Saves Workspace");
  await page.getByRole("button",{name:/Desktop/}).click();
  const card=page.locator(".snapshot-settings"),enable=card.getByLabel("Enable global SnapShot shortcut"),flash=card.getByLabel("Flash captured window"),animate=card.getByLabel("Animate capture feedback");
  await expect(enable).not.toBeChecked();await expect(flash).not.toBeChecked();await expect(animate).toBeChecked();
  const hold=()=>page.evaluate(()=>{window.__snapshotsBusy=new Promise(resolve=>{window.__snapshotsFree=resolve})});
  const free=()=>page.evaluate(()=>window.__snapshotsFree());
  const sent=()=>page.evaluate(()=>window.__snapshotSaves.length);
  const shown=async()=>({enabled:await enable.isChecked(),flash:await flash.isChecked(),animations:await animate.isChecked()});
  const main=()=>page.evaluate(()=>window.trebellDesktop.snapshots.get().then(({enabled,flash,animations,registered})=>({enabled,flash,animations,registered})));
  // With the mouse: Enable, and Flash while Enable's save waits.
  await hold();
  await enable.click();
  await expect(card).toContainText("Saving…");await expect(enable).not.toBeChecked();
  await flash.click();
  await expect.poll(sent,{message:"both saves were sent"}).toBe(2);
  await free();
  await expect(flash).toBeChecked();
  await expect.poll(shown).toEqual({enabled:true,flash:true,animations:true});
  await expect(card).toContainText("SnapShots ready.");
  expect(await main()).toEqual({enabled:true,flash:true,animations:true,registered:true});
  await shootModes(page,"snapshots-two-switches-during-save",{show:card});
  // With the keyboard: Space on Flash, then Tab to Animate and Space, while Flash's save waits.
  await hold();
  await flash.focus();await page.keyboard.press("Space");
  await expect(card).toContainText("Saving…");
  await page.keyboard.press("Tab");await expect(animate).toBeFocused();await page.keyboard.press("Space");
  await expect.poll(sent,{message:"both saves were sent"}).toBe(4);
  await free();
  await expect(animate).not.toBeChecked();
  await expect.poll(shown).toEqual({enabled:true,flash:false,animations:false});
  await expect(card).toContainText("SnapShots ready.");
  expect(await main()).toEqual({enabled:true,flash:false,animations:false,registered:true});
});

// Capture now takes one SnapShot a press. The second click of a double click and the repeats of Enter held on it came as presses of
// their own, and so did a press while its SnapShot was being taken: each took the window again (lane G, GR5-1).
test("a double click or Enter held on Capture now takes one SnapShot, and a press while it is being taken takes none",async({page,request})=>{
  test.setTimeout(60_000);
  await page.addInitScript(()=>{
    // As desktop/main.mjs takes snapshot:capture: the foreground window is read and written as a PNG (250 ms, and for as long as
    // window.__captureHeld holds), then snapshot:captured goes to the window and the call answers. window.__captures counts the calls.
    // A save fails with window.__configureFails, as one whose shortcut another application holds does.
    const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",taken=new Map(),told=new Set();
    window.__captures=0;window.__captureHeld=null;window.__captureFails=null;window.__configureFails=null;
    Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{
      snapshots:{
        get:async()=>({enabled:false,shortcut:"CommandOrControl+Shift+S",includeText:false,playSound:true,sound:"soft-pop",flash:true,animations:true,registered:false,platform:"win32",pending:taken.size}),
        configure:async value=>{if(window.__configureFails)throw new Error(window.__configureFails);return value},pending:async()=>[],
        read:async id=>({...taken.get(id),dataBase64:png}),ack:async id=>{taken.delete(id);return {ok:true,id}},
        capture:async()=>{
          const id="snapshot-"+(++window.__captures)+"-e2e";
          await new Promise(resolve=>setTimeout(resolve,250));await window.__captureHeld;
          if(window.__captureFails){const reason=window.__captureFails;window.__captureFails=null;throw new Error(reason)}
          const meta={id,createdAt:Date.now(),title:"Notes - Notepad",process:"notepad",width:1,height:1,hasAccessibility:false};
          taken.set(id,meta);for(const handler of told)handler({id});return meta;
        },
        onCaptured:handler=>{told.add(handler);return()=>told.delete(handler)},
      },
      background:{set:async()=>({ok:true})},
    }});
  });
  await openSettings(page,request,"SnapShot Presses Workspace");
  const card=page.locator(".snapshot-settings"),capture=card.getByRole("button",{name:/^Captur/});
  // The SnapShots on the composer, where the app goes with each one (Settings shows no composer), and the captures asked for.
  const snapshots=page.getByTestId("context-chip").filter({hasText:"SnapShot: notepad"}),captures=()=>page.evaluate(()=>window.__captures);
  const openSnapShots=async()=>{
    if(!await card.isVisible())await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.locator(".settings-nav").getByRole("button",{name:/Desktop/}).click();await expect(capture).toHaveText("Capture now");
  };
  // What a press took once the app has gone to the composer with it and any SnapShot after it would have come.
  const took=async(capturesBefore,shownBefore)=>{await expect(snapshots).not.toHaveCount(shownBefore);await page.waitForTimeout(600);return {captures:await captures()-capturesBefore,shown:await snapshots.count()-shownBefore}};
  await openSnapShots();
  await capture.dblclick();
  expect.soft(await took(0,0),"a double click on Capture now takes one SnapShot").toEqual({captures:1,shown:1});
  // Enter held on it (a press, and five repeats 33 ms apart).
  let capturesBefore=await captures(),shownBefore=await snapshots.count();
  await openSnapShots();await capture.focus();
  await page.keyboard.down("Enter");for(let repeat=0;repeat<5;repeat++){await page.waitForTimeout(33);await page.keyboard.down("Enter")}await page.keyboard.up("Enter");
  expect.soft(await took(capturesBefore,shownBefore),"Enter held on Capture now takes one SnapShot").toEqual({captures:1,shown:1});
  // A click, then a click and Enter of their own while its SnapShot is being taken: Capture now says it is capturing, the presses take
  // nothing more, and the keyboard stays on it.
  capturesBefore=await captures();shownBefore=await snapshots.count();
  await openSnapShots();
  await page.evaluate(()=>{window.__captureHeld=new Promise(resolve=>{window.__captureFree=resolve})});
  const box=await capture.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
  await page.mouse.click(x,y);
  await expect(capture).toHaveText("Capturing…");await expect(capture).toHaveAttribute("aria-disabled","true");
  await page.waitForTimeout(600);await page.mouse.click(x,y);await page.keyboard.press("Enter");
  await expect(capture,"the keyboard stays on Capture now").toBeFocused();
  await shootModes(page,"snapshots-capturing",{show:card});
  await page.evaluate(()=>{window.__captureHeld=null;window.__captureFree()});
  expect(await took(capturesBefore,shownBefore),"presses while the SnapShot is being taken take none").toEqual({captures:1,shown:1});
  // A capture that fails says why on the card and lets go of Capture now, with the keyboard still on it for the next press.
  shownBefore=await snapshots.count();
  await openSnapShots();
  const failure="Could not match the active window (Notes - Notepad) to a capturable source.",failed=card.locator(".provider-status-error");
  const hold=()=>page.evaluate(()=>{window.__captureHeld=new Promise(resolve=>{window.__captureFree=resolve})}),free=()=>page.evaluate(()=>{window.__captureHeld=null;window.__captureFree()});
  await page.evaluate(reason=>{window.__captureFails=reason},failure);
  await capture.focus();await page.keyboard.press("Enter");
  await expect(failed).toHaveText(failure);
  await expect(capture).toHaveText("Capture now");await expect(capture).not.toHaveAttribute("aria-disabled","true");await expect(capture).toBeFocused();
  // The next press clears that line as its capture starts. The line stayed above Capturing…, so the card said it was capturing and
  // that it could not, and a capture that failed again the same way left the card as it was; one that fails again says why anew.
  await hold();await page.evaluate(reason=>{window.__captureFails=reason},failure);
  await page.keyboard.press("Enter");
  await expect(capture).toHaveText("Capturing…");
  await expect(failed,"a capture being taken clears the line saying why the last one failed").toHaveCount(0);
  await shootModes(page,"snapshots-capturing-after-failure",{show:card});
  await free();
  await expect(failed,"a capture that fails again says why anew").toHaveText(failure);
  // The line of the card's other actions stays through a capture: a save that failed is still not saved.
  const reserved="Shortcut CommandOrControl+Shift+S is already reserved by another application.";
  await page.evaluate(reason=>{window.__configureFails=reason},reserved);
  await card.getByLabel("Flash captured window").click();
  await expect(failed).toHaveText(reserved);
  await page.evaluate(()=>{window.__configureFails=null});
  capturesBefore=await captures();
  await hold();await capture.focus();await page.keyboard.press("Enter");
  await expect(capture).toHaveText("Capturing…");
  await expect(failed,"a capture leaves the line of a save that failed").toHaveText(reserved);
  await free();
  expect(await took(capturesBefore,shownBefore),"the next press takes a SnapShot").toEqual({captures:1,shown:1});
});

// The scoped "After inactive days" field is typed in like any number: it saves once it is left, the whole number, as the Projects
// card's own days field does. Saves are slowed as a busy disk or a remote environment slows them; a save on every keystroke came
// back mid-typing and put an earlier keystroke's value in the field, so 365 was saved as 35.
test("the scoped After inactive days field keeps every digit typed and saves the whole number",async({page,request})=>{
  const scoped=async(projectId="")=>(await (await request.get("/api/scoped-settings?"+new URLSearchParams(projectId?{environmentId:"",projectId}:{environmentId:""}))).json());
  const before=(await scoped()).effective.worktreeCleanup;
  try{
    await openSettings(page,request,"Scoped Days Workspace");
    const saves=[];
    await page.route(/\/api\/scoped-settings$/,async route=>{
      if(route.request().method()!=="POST")return route.continue();
      saves.push(route.request().postDataJSON());await new Promise(resolve=>setTimeout(resolve,400));return route.continue();
    });
    // The days each save after the field was first typed in sent (the cleanup select's own saves come before it).
    let typedFrom=0;const daysSaved=()=>saves.slice(typedFrom).map(body=>body.patch?.worktreeCleanup?.rules?.worktreeAfterDays);
    await page.getByRole("button",{name:/Workspace/}).click();
    const card=page.getByTestId("scoped-settings-card");
    await card.getByLabel("Automatic worktree cleanup").selectOption("custom");
    const days=card.getByLabel("After inactive days");
    await expect(days).toHaveValue("30");
    const typeDays=async(text,delay)=>{await days.click();await page.keyboard.press("Control+A");await page.keyboard.press("Delete");await page.keyboard.type(text,{delay})};
    typedFrom=saves.length;await typeDays("365",110);
    await expect(days).toHaveValue("365");
    await page.keyboard.press("Tab");
    await expect.poll(async()=>(await scoped()).effective.worktreeCleanup.rules.worktreeAfterDays).toBe(365);
    await expect(card).toContainText("Scoped default saved.");
    await expect(days).toHaveValue("365");
    expect(daysSaved()).toEqual([365]);
    await shootModes(page,"scoped-days-365",{show:days});
    // Back in the field while its save is on its way: what is typed there, and the keyboard, stay when that save lands, and
    // leaving the field again saves it.
    typedFrom=saves.length;await typeDays("45",60);
    const landed=page.waitForResponse(response=>response.url().endsWith("/api/scoped-settings")&&response.request().method()==="POST");
    await page.keyboard.press("Tab");await page.keyboard.press("Shift+Tab");
    await expect(days).toBeFocused();
    await page.keyboard.press("Control+A");await page.keyboard.type("60",{delay:60});
    await landed;
    await expect(card).toContainText("Scoped default saved.");
    await expect(days).toHaveValue("60");
    await expect(days).toBeFocused();
    await page.keyboard.press("Tab");
    await expect.poll(async()=>(await scoped()).effective.worktreeCleanup.rules.worktreeAfterDays).toBe(60);
    expect(daysSaved()).toEqual([45,60]);
    // A toggle clicked straight after typing keeps the days typed: its save does not send the saved days back over them.
    typedFrom=saves.length;await typeDays("45",150);
    await card.locator("label.toggle-line",{hasText:"After merge"}).click();
    await expect.poll(async()=>(await scoped()).effective.worktreeCleanup.rules).toMatchObject({worktreeAfterDays:45,worktreeOnMerge:true});
    await expect(days).toHaveValue("45");
    await expect(card.getByLabel("After merge")).toBeChecked();
    expect(daysSaved()).toEqual([45,45]);
    // A project's own rule is typed the same way, faster.
    await page.getByRole("combobox",{name:"Project scope"}).selectOption({label:"Scoped Days Workspace"});
    await card.getByLabel("Automatic worktree cleanup").selectOption("custom");
    await expect(days).toHaveValue("45");
    const project=(await (await request.get("/api/projects")).json()).projects.find(item=>item.name==="Scoped Days Workspace");
    typedFrom=saves.length;await typeDays("120",60);
    await expect(days).toHaveValue("120");
    await page.keyboard.press("Tab");
    await expect.poll(async()=>(await scoped(project.id)).overrides.worktreeCleanup?.rules?.worktreeAfterDays).toBe(120);
    await expect(days).toHaveValue("120");
    expect(daysSaved()).toEqual([120]);
    // Leaving the field without a change saves nothing.
    await days.click();await page.keyboard.press("Tab");
    await page.waitForTimeout(600);
    expect(daysSaved()).toEqual([120]);
  }finally{
    const project=(await (await request.get("/api/projects")).json()).projects.find(item=>item.name==="Scoped Days Workspace");
    if(project)await request.post("/api/scoped-settings",{data:{projectId:project.id,patch:{},resetKeys:["worktreeCleanup"]}});
    await request.post("/api/scoped-settings",{data:{environmentId:null,patch:{worktreeCleanup:before}}});
  }
});

// The chosen project's path on Workspace's scope line ends with the project's own folder: cut at its end, a long path showed only its
// first folders, hid the project's own and had nothing to hover for the rest. It is cut at its start, and the whole path shows on hover.
test("Workspace's scope line shows the chosen project's own folder at the end of its path, and the whole path on hover",async({page,request})=>{
  const root=join(e2eHome(),"scope-line"),folder=join(root,"a-project-folder-with-a-fairly-long-name-that-runs-past-the-end-of-the-scope-line","nested","repository");
  await mkdir(folder,{recursive:true});await writeFile(join(folder,"README.md"),"# Scope line fixture\n");
  const project=(await (await request.post("/api/projects",{data:{path:folder,name:"Long Path Project",activate:false}})).json()).project;
  try{
    await openSettings(page,request,"Scope Line Workspace");
    await page.locator(".settings-nav").getByRole("button",{name:/Workspace/}).click();
    const line=page.getByTestId("settings-scope-sentence"),path=line.locator("small");
    await line.getByRole("combobox",{name:"Project scope"}).selectOption({label:"Long Path Project"});
    await expect(path).toHaveText(project.path);
    await expect.soft(path,"the whole path shows on hover").toHaveAttribute("title",project.path);
    for(const mode of ["dark","light"])for(const width of [1280,900]){
      await page.setViewportSize({width,height:800});await switchMode(page,mode);
      // Where the path's first character and its last folder are drawn, against the line's box.
      const shown=await path.evaluate(node=>{
        const box=node.getBoundingClientRect(),text=document.createTreeWalker(node,NodeFilter.SHOW_TEXT).nextNode(),value=text.data;
        const at=(from,to)=>{const range=document.createRange();range.setStart(text,from);range.setEnd(text,to);return range.getBoundingClientRect()};
        const folder=at(value.search(/[^\\/]+$/),value.length),first=at(0,1),inside=rect=>rect.left>=box.left-.5&&rect.right<=box.right+.5;
        return {cut:node.scrollWidth>node.clientWidth+1,folderShown:inside(folder),startShown:inside(first)};
      });
      expect(shown.cut,"the path is longer than the line").toBe(true);
      expect.soft(shown,`the project's own folder shows whole at the end, the start of the path cut, at ${width} in ${mode}`).toEqual({cut:true,folderShown:true,startShown:false});
      await page.screenshot({animations:"disabled",path:shots+`scope-line-project-path-${mode}-${width}.png`});
    }
    await page.setViewportSize({width:1280,height:800});await switchMode(page,"dark");
  }finally{
    await request.delete("/api/projects?id="+encodeURIComponent(project.id));
    await rm(root,{recursive:true,force:true});
  }
});

// Waits until the page stops moving: what read() reads is the same twice in a row.
async function settles(read){let last;await expect.poll(async()=>{const now=await read(),same=now===last;last=now;return same},{intervals:[150]}).toBe(true)}

// A setting opened from the search stays in view while the page around it settles. Project defaults shows its fields only once the
// scoped settings answer (late here, as from a remote environment or a busy machine): they grew above Storage cleanup after its one
// scroll and pushed it down until only the edge of its heading showed. A person who scrolls meanwhile keeps the place they scrolled to.
// Enter held down repeats (after about half a second, then every 33 ms) while the card loads: its repeats carry on from the press that
// opened the setting, and ended the follow as if they were a key of their own.
test("a setting opened from the search stays in view when a card above it loads later, and a person's own scroll is left alone",async({page,request})=>{
  test.setTimeout(60_000);
  // Project defaults' read of the scoped settings waits while `hold` is set, until release().
  let hold=true;const held=[],release=()=>{hold=false;for(const resolve of held.splice(0))resolve()};
  await page.route(/\/api\/scoped-settings\?/,async route=>{if(hold)await new Promise(resolve=>held.push(resolve));await route.continue().catch(()=>{})});
  try{
    await page.setViewportSize({width:1280,height:800});
    await openSettings(page,request,"Search Reveal Workspace");
    const search=page.getByRole("textbox",{name:"Search settings"}),storage=page.locator('[data-setting-target="workspace-storage"]');
    const fields=page.getByTestId("scoped-settings-card").getByLabel("Default model"),scroller=page.locator(".secondary-page");
    const storageTop=async()=>Math.round((await storage.boundingBox()).y);
    const open=async how=>{
      await page.locator(".settings-nav").getByRole("button",{name:/General/}).click();hold=true;
      await search.click();await page.keyboard.type("storage",{delay:20});
      if(how==="Enter")await page.keyboard.press("Enter");
      else if(how==="held Enter")await page.keyboard.down("Enter");
      else await page.getByTestId("settings-search-results").getByRole("button",{name:/Storage cleanup/}).click();
      await expect(storage).toHaveClass(/settings-search-hit/);
    };
    // With the keyboard and with the mouse, in dark and light, wide and narrow: the card above loads after the setting's scroll has
    // ended, or while it is still on its way. Enter held down repeats (Playwright sends the next keydowns of a key still down as
    // repeats) before the card loads and while it does, and is let go once it has.
    for(const [mode,width,how,late] of [["dark",1280,"Enter",true],["light",1280,"click",false],["dark",900,"Enter",true],["light",900,"held Enter",true]]){
      const held=how==="held Enter";
      await page.setViewportSize({width,height:800});await switchMode(page,mode);
      await open(how);
      if(late){
        await expect(storage).toBeInViewport({ratio:0.9});await settles(storageTop);
        await expect(fields).toHaveCount(0);
      }
      if(held)for(let index=0;index<3;index++)await page.keyboard.down("Enter");
      release();
      if(held)await page.keyboard.down("Enter");
      await expect(fields).toBeVisible();
      if(held)await page.keyboard.up("Enter");
      await expect(storage,"Storage cleanup is still in view once Project defaults has grown above it").toBeInViewport({ratio:0.9});
      await settles(storageTop);await expect(storage).toBeInViewport({ratio:0.9});
      await page.screenshot({animations:"disabled",path:shots+`search-result-stays-in-view-${how.toLowerCase().replace(" ","-")}-${mode}-${width}.png`});
    }
    // The person turns the wheel before the card above loads: the page stays where they put it.
    await page.setViewportSize({width:1280,height:800});await switchMode(page,"dark");
    await open("Enter");
    await expect(storage).toBeInViewport({ratio:0.9});await settles(storageTop);
    const box=await storage.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+20);
    for(let notch=0;notch<3;notch++)await page.mouse.wheel(0,-100);
    const scrolled=()=>scroller.evaluate(node=>node.scrollTop);
    await settles(scrolled);const place=await scrolled();
    release();
    await expect(fields).toBeVisible();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    expect(await scrolled(),"the page stays where the person scrolled it").toBe(place);
    await page.screenshot({animations:"disabled",path:shots+"search-result-person-scrolled-dark-1280.png"});
  }finally{release()}
});

// The search results give way to the categories as one opens, so the second click of a double click on a result landed on the
// category under the pointer and opened General instead of the setting. In a narrow window the categories scroll away with the
// page, and the cards above the setting pass under the pointer instead. The setting also stays in view as Project defaults, above
// it, loads later.
test("a double click on a Settings search result opens that setting and keeps it in view, and its second click presses nothing",async({page,request})=>{
  let hold=true;const held=[],release=()=>{hold=false;for(const resolve of held.splice(0))resolve()};
  await page.route(/\/api\/scoped-settings\?/,async route=>{if(hold)await new Promise(resolve=>held.push(resolve));await route.continue().catch(()=>{})});
  try{
    await page.setViewportSize({width:1280,height:800});
    await openSettings(page,request,"Search Double Click Workspace");
    const storage=page.locator('[data-setting-target="workspace-storage"]'),fields=page.getByTestId("scoped-settings-card").getByLabel("Default model");
    // What the page asks the server to do (the mode button saves the mode).
    const posts=[];page.on("request",sent=>{if(sent.method()==="POST")posts.push(new URL(sent.url()).pathname)});
    for(const [mode,width] of [["dark",1280],["light",900]]){
      await page.setViewportSize({width,height:800});await switchMode(page,mode);
      await page.locator(".settings-nav").getByRole("button",{name:/General/}).click();hold=true;
      await page.getByRole("textbox",{name:"Search settings"}).click();await page.keyboard.type("storage",{delay:20});
      const box=await page.getByTestId("settings-search-results").getByRole("button",{name:/Storage cleanup/}).boundingBox();
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      // The first click opens the setting; the second comes as the page answers it, at the same place.
      await page.mouse.down();await page.mouse.up();
      await expect(storage).toHaveClass(/settings-search-hit/);
      await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});
      await expect(page.locator(".settings-section-head h2")).toHaveText("Workspace");
      await expect(page.locator(".settings-nav button[aria-current=page]")).toContainText("Workspace");
      await expect(storage).toBeInViewport({ratio:0.9});
      release();
      await expect(fields).toBeVisible();
      await expect(storage,"Storage cleanup is still in view once Project defaults has grown above it").toBeInViewport({ratio:0.9});
      await settles(async()=>Math.round((await storage.boundingBox()).y));await expect(storage).toBeInViewport({ratio:0.9});
      expect(posts.filter(path=>path!=="/api/settings"),"the second click pressed nothing").toEqual([]);
      await page.screenshot({animations:"disabled",path:shots+`search-result-double-click-${mode}-${width}.png`});
    }
  }finally{release()}
});

// A search result's title sits beside its section's name. It was held to one line and cut with an ellipsis, with nothing showing the
// rest: in the 250 px rail of a wide window "Runtime diagnostics", "Project & environment defaults" and "About & open source licenses"
// lost their ends, and so did a project action's own long name. Where the results are taller than the list (280 px in a narrow
// window), each was squeezed to fit, its description run into the result under it.
test("every Settings search result shows its whole title, in a wide window and a narrow one, dark and light",async({page,request})=>{
  test.setTimeout(120_000);
  const boot=await (await request.get("/api/bootstrap")).json();
  // A project action named with one long word, as a person's own scripts can be.
  const script={id:"regenerate-shots",name:"regenerate_visual_audit_screenshots",command:"node regenerate.mjs",previewUrl:null,autoOpenPreview:false,runOnWorktreeCreate:false,waitForSetup:false};
  await request.post("/api/projects",{data:{path:boot.cwd,scripts:[script]}});
  try{
    await openSettings(page,request,"Search Titles Workspace");
    const search=page.getByRole("textbox",{name:"Search settings"}),results=page.getByTestId("settings-search-results"),last=results.getByRole("button").last();
    // The results not drawn whole: a title cut short or running out of its own box (over the section's name), or a result whose lines
    // run out of its own box (into the result under it).
    const notWhole=()=>results.getByRole("button").evaluateAll(buttons=>buttons.flatMap(button=>{
      const title=button.querySelector("strong"),box=title.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(title);const text=range.getBoundingClientRect();
      const cut=title.scrollWidth>title.clientWidth+1||title.scrollHeight>title.clientHeight+1||text.left<box.left-1||text.right>box.right+1;
      return cut||button.scrollHeight>button.clientHeight+1?[title.textContent+(cut?" (cut)":" (squeezed)")]:[];
    }));
    const queries=[["runtime","Runtime diagnostics"],["licenses","About & open source licenses"],["regenerate","Run regenerate_visual_audit_screenshots"],["project","Project & environment defaults"]];
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      for(const width of [1600,1280,1100,900,700]){
        await page.setViewportSize({width,height:800});
        const shown=new Set();
        // Typed as a person types, each query replacing the last.
        for(const [query,title] of queries){
          await search.click();await page.keyboard.press("Control+A");await page.keyboard.type(query,{delay:20});
          await expect(results.getByRole("button",{name:title})).toBeVisible();
          for(const result of await notWhole())shown.add(result);
          if(width===1280&&query==="regenerate")await page.screenshot({animations:"disabled",path:shots+`search-result-titles-action-${mode}-${width}.png`});
        }
        expect.soft([...shown],`every result reads whole at ${width} in ${mode}`).toEqual([]);
        expect.soft(await page.locator(".secondary-page").evaluate(node=>node.scrollWidth-node.clientWidth),`no sideways scroll at ${width} in ${mode}`).toBeLessThanOrEqual(1);
        await page.screenshot({animations:"disabled",path:shots+`search-result-titles-${mode}-${width}.png`});
        // The wheel over the list brings its last result into view, whole.
        const inList=()=>last.evaluate(node=>{const box=node.getBoundingClientRect(),list=node.parentElement.getBoundingClientRect();return box.top>=list.top-1&&box.bottom<=list.bottom+1});
        const list=await results.boundingBox();await page.mouse.move(list.x+list.width/2,list.y+list.height/2);
        for(let notch=0;notch<12&&!await inList();notch++){await page.mouse.wheel(0,80);await page.waitForTimeout(60)}
        expect.soft(await inList(),`the last result scrolls into view at ${width} in ${mode}`).toBe(true);
        if(width===700)await page.screenshot({animations:"disabled",path:shots+`search-result-titles-scrolled-${mode}-${width}.png`});
      }
    }
    await search.press("Escape");await expect(results).toHaveCount(0);
    await page.setViewportSize({width:1280,height:800});await switchMode(page,"dark");
  }finally{await request.post("/api/projects",{data:{path:boot.cwd,scripts:[],preferredScriptId:null}})}
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
  await page.screenshot({animations:"disabled",path:auditDir+"settings-inline-save-failure-no-unhandled-rejection.png"});
  expect(pageErrors).toEqual([]);
});

// Dismissing the Settings alert puts the keyboard back on the control whose save failed, with the mouse or the keyboard, so the
// next Tab goes on from there instead of from the top of the page.
test("dismissing the Settings error alert gives focus back to the control that failed",async({page,request})=>{
  await openSettings(page,request,"Dismiss Focus Workspace",{continueThreadsAfterRestart:false});
  // Only the restart recovery save fails, so the header's mode button still saves for the screenshots.
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"&&"continueThreadsAfterRestart" in (route.request().postDataJSON()||{})
    ?route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate restart recovery failure"})})
    :route.continue());
  const restart=page.getByLabel("Continue supported active threads after restarts");
  const alert=page.locator(".settings-action-error"),dismiss=page.getByRole("button",{name:"Dismiss settings error"});
  await restart.click();
  await expect(alert).toContainText("Deliberate restart recovery failure");
  await expect(restart).not.toBeChecked();
  await dismiss.click();
  await expect(alert).toHaveCount(0);
  await expect(restart).toBeFocused();
  // The keyboard way: back up from the toggle to the alert's Dismiss button, press Enter. Shown in both modes, switched with the
  // header's mode button between the two.
  for(const mode of ["dark","light"]){
    await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
    if(mode==="dark")await page.keyboard.press("Space");else await restart.click();
    await expect(alert).toContainText("Deliberate restart recovery failure");
    await expect(restart).toBeFocused();
    for(let step=0;step<20&&!await dismiss.evaluate(button=>button===document.activeElement).catch(()=>false);step++)await page.keyboard.press("Shift+Tab");
    await expect(dismiss).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(alert).toHaveCount(0);
    await expect(restart).toBeFocused();
    expect(await restart.evaluate(input=>input.matches(":focus-visible")&&getComputedStyle(input).outlineStyle),"the toggle shows it has the keyboard").toBe("solid");
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await restart.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:shots+`settings-dismiss-focus-${mode}-${width}.png`})}
  }
  await page.setViewportSize({width:1280,height:800});
  // The next Tab goes on from the toggle, not from the top of the page.
  const after=await page.evaluate(()=>{const items=[...document.querySelectorAll("button,input,select,textarea,a[href]")].filter(item=>item.tabIndex>=0&&!item.disabled&&item.getClientRects().length);return items[items.indexOf(document.activeElement)+1]?.outerHTML.slice(0,80)});
  await page.keyboard.press("Tab");
  expect(await page.evaluate(()=>document.activeElement.outerHTML.slice(0,80))).toBe(after);
  await switchMode(page,"dark");
});

// Refresh published themes is disabled while it refreshes, so the keyboard has left it by the time its failure shows; dismissing
// the alert still gives focus back to it, not to the first control under the alert at the top of the section (Mode's system).
test("dismissing the alert of a failed Refresh published themes gives focus back to that button",async({page,request})=>{
  await openSettings(page,request,"Refresh Focus Workspace");
  await page.getByRole("button",{name:/Appearance/}).click();
  const refresh=page.getByRole("button",{name:"Refresh published themes"});
  await expect(refresh).toBeEnabled();
  await page.route(/\/api\/environment\/themes$/,async route=>{await new Promise(resolve=>setTimeout(resolve,150));return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate published themes failure"})})});
  // The person has tabbed down to the button; Enter presses it.
  await refresh.scrollIntoViewIfNeeded();await refresh.focus();
  await page.keyboard.press("Enter");
  const alert=page.locator(".settings-action-error");
  await expect(alert).toContainText("Deliberate published themes failure");
  await expect(refresh).toBeEnabled();
  await page.getByRole("button",{name:"Dismiss settings error"}).click();
  await expect(alert).toHaveCount(0);
  await expect(refresh).toBeFocused();
});

// The custom model form says what is wrong with a draft under the form, in view there, not in the Agent harness card's status line
// higher up the page; so does the note that the model was saved. The person has scrolled down only until Save shows.
test("the custom model form says what is wrong with a draft by the form",async({page,request})=>{
  try{
    await openSettings(page,request,"Custom Model Form Workspace",{customModels:[]});
    await page.setViewportSize({width:1280,height:800});
    await page.getByRole("button",{name:/Agents & models/}).click();
    const card=page.locator('[data-setting-target="agents-models"]'),harness=page.locator('[data-setting-target="agents-harness"]');
    await card.getByRole("button",{name:"Add custom model",exact:true}).click();
    await typeInto(page,card.getByLabel("Model ID"),"gpt-lane-d-mini");
    await typeInto(page,card.getByLabel("Input / 1M"),"-2");
    const save=card.getByRole("button",{name:"Save custom model",exact:true});
    await wheelUntilShown(page,save);
    await save.click();
    const problem=card.getByRole("alert").filter({hasText:"Custom model prices must be numbers of 0 or more."});
    await expect(problem).toBeInViewport({ratio:1});
    await expect(save).toBeInViewport({ratio:1});
    await expect(harness).not.toContainText("Custom model prices");
    await expect(card.getByLabel("Input / 1M")).toHaveValue("-2");
    expect((await savedSettings(request)).customModels).toEqual([]);
    await shootModes(page,"custom-model-price-problem",{show:problem});
    // Fixed, the draft saves, and the card says so where the form was.
    await typeInto(page,card.getByLabel("Input / 1M"),"2");
    await wheelUntilShown(page,save);
    await save.click();
    const saved=card.getByRole("status").filter({hasText:"Custom model saved."});
    await expect(saved).toBeInViewport({ratio:1});
    await expect(card.locator(".custom-model-list")).toContainText("gpt-lane-d-mini");
    await expect(problem).toHaveCount(0);
    await expect(harness).not.toContainText("Custom model saved.");
    await expect.poll(async()=>(await savedSettings(request)).customModels.map(item=>item.id)).toEqual(["gpt-lane-d-mini"]);
    await shootModes(page,"custom-model-saved",{show:saved});
  }finally{
    await request.post("/api/settings",{data:{customModels:[]}});
  }
});

// OpenCode's provider/model check on the same form is said there too. OpenCode is a fixture here: nothing runs it on this host.
test("the custom model form says by the form that an OpenCode model needs provider/model",async({page})=>{
  let settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",customModels:[]};
  const json=body=>({status:200,contentType:"application/json",body:JSON.stringify(body)});
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill(json({mock:true,provider:"openai",providerReady:true,agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",agentRuntimeReady:true,appServerReady:false,wsUrl:"",cwd:process.cwd(),platform:process.platform,version:"custom-model-opencode-fixture",activeEnvironmentId:null,activeEnvironment:null})));
  await page.route(/\/api\/state$/,route=>route.fulfill(json({settings,projects:[],threadMeta:{}})));
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")settings={...settings,...route.request().postDataJSON()};return route.fulfill(json(settings))});
  await page.route(/\/api\/models$/,route=>route.fulfill(json({agentRuntime:"opencode",ready:true,models:["openai/fixture-model"],metadata:{agentRuntime:"opencode",models:[{id:"openai/fixture-model",name:"Fixture model",agent:"OpenCode"}]}})));
  const status={id:"opencode-default",kind:"opencode",name:"OpenCode",available:true,installed:true,authenticated:true,version:"fixture"};
  await page.route(/\/api\/agent-runtimes$/,route=>route.fulfill(json({selectedRuntime:"opencode",selectedInstanceId:"opencode-default",definitions:[{id:"opencode",name:"OpenCode",protocol:"http",multipleInstances:false}],instances:[{id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true}],statuses:[status]})));
  await page.route(/\/api\/runtime$/,route=>route.fulfill(json({agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",agentRuntimeStatus:status,provider:"openai",providerReady:true,appServerReady:true})));
  await page.route(/\/api\/projects$/,route=>route.fulfill(json({projects:[]})));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill(json({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  const card=page.locator('[data-setting-target="agents-models"]'),harness=page.locator('[data-setting-target="agents-harness"]');
  await expect(harness).toContainText("OpenCode");
  await card.getByRole("button",{name:"Add custom model",exact:true}).click();
  await typeInto(page,card.getByLabel("Model ID"),"lane-model");
  const save=card.getByRole("button",{name:"Save custom model",exact:true});
  await wheelUntilShown(page,save);
  await save.click();
  const problem=card.getByRole("alert").filter({hasText:"OpenCode custom models must use provider/model format."});
  await expect(problem).toBeInViewport({ratio:1});
  await expect(harness).not.toContainText("provider/model format");
  await expect(card.getByLabel("Model ID")).toHaveValue("lane-model");
  expect(settings.customModels).toEqual([]);
  await shootModes(page,"custom-model-opencode-format",{show:problem});
});

// A theme import says how it went right under Import JSON, in view, not under the theme editor the import opens further down the
// card; and VS Code's own theme files, JSONC with comments and trailing commas, import as they are.
test("a theme import says how it went by Import JSON and reads VS Code's JSONC theme files",async({page,request})=>{
  await openSettings(page,request,"Theme Import Workspace");
  await page.setViewportSize({width:1280,height:800});
  await page.getByRole("button",{name:/Appearance/}).click();
  const card=page.locator('[data-setting-target="appearance-theme"]'),importButton=card.getByRole("button",{name:"Import JSON",exact:true}),name=card.getByLabel("Name",{exact:true});
  // The person picks the file in the file chooser Import JSON opens.
  async function importFile(file,text){const chooser=page.waitForEvent("filechooser");await importButton.click();await (await chooser).setFiles({name:file,mimeType:"application/json",buffer:Buffer.from(text)})}
  await importFile("lane-d-good.json",JSON.stringify({name:"Lane D Good",appearance:"dark",canvas:"#101814",accent:"#3ddc97"}));
  const imported=card.getByText("Imported Lane D Good.",{exact:true});
  await expect(imported).toBeInViewport({ratio:1});
  await expect(importButton).toBeInViewport({ratio:1});
  await expect(name).toHaveValue("Lane D Good");
  // The shape VS Code ships its color themes in: // and /* */ comments, a // inside a string, trailing commas.
  const darkModern=`{\n\t// Fixture in the shape of VS Code's Dark Modern.\n\t"$schema": "vscode://schemas/color-theme",\n\t"name": "Fixture Dark Modern",\n\t"type": "dark",\n\t/* Workbench colors */\n\t"colors": {\n\t\t"editor.background": "#1f1f1f",\n\t\t"editor.foreground": "#cccccc",\n\t\t"focusBorder": "#0078d4", // the accent\n\t},\n\t"tokenColors": [],\n}\n`;
  await importFile("dark_modern.json",darkModern);
  const modern=card.getByText("Imported Fixture Dark Modern.",{exact:true});
  await expect(modern).toBeInViewport({ratio:1});
  await expect(modern).toHaveAttribute("role","status");
  await expect(name).toHaveValue("Fixture Dark Modern");
  await expect(card.getByRole("button",{name:"Fixture Dark Modern",exact:true})).toHaveAttribute("aria-pressed","true");
  await expect.poll(async()=>(await savedSettings(request)).customThemes.map(theme=>[theme.name,theme.canvas,theme.accent])).toEqual([["Lane D Good","#101814","#3ddc97"],["Fixture Dark Modern","#1f1f1f","#0078d4"]]);
  await shootModes(page,"theme-import-jsonc",{show:modern});
  // A file that is not a theme is refused in the same place, and the open editor keeps the theme it had.
  await importFile("notes.json",JSON.stringify({name:"Notes",colors:{}}));
  const refused=card.getByText("Import failed: Theme must define canvas or colors.editor.background",{exact:true});
  await expect(refused).toBeInViewport({ratio:1});
  await expect(refused).toHaveAttribute("role","alert");
  await expect(modern).toHaveCount(0);
  await expect(name).toHaveValue("Fixture Dark Modern");
  expect((await savedSettings(request)).customThemes).toHaveLength(2);
  await shootModes(page,"theme-import-refused",{show:refused});
  // A theme whose name holds the word error (or failed) imported like any other, and is said as a status, not as a failure.
  await importFile("terror-night.json",JSON.stringify({name:"Terror Night",appearance:"dark",canvas:"#140f12",accent:"#e0457b"}));
  const terror=card.getByText("Imported Terror Night.",{exact:true});
  await expect(terror).toBeInViewport({ratio:1});
  await expect(terror).toHaveAttribute("role","status");
  await expect(terror).not.toHaveClass(/provider-status-error/);
  await expect(card.getByRole("button",{name:"Terror Night",exact:true})).toHaveAttribute("aria-pressed","true");
  await shootModes(page,"theme-import-error-in-name",{show:terror});
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
  await page.locator(".theme-settings").screenshot({animations:"disabled",path:auditDir+"settings-panel-animation-mid-drag.png"});
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
  await page.locator(".theme-settings").screenshot({animations:"disabled",path:auditDir+"settings-panel-animation-saved-once.png"});
  // Leaving Settings before the slider settles still saves the last value.
  await slider.press("ArrowRight");await slider.press("ArrowRight");await slider.press("ArrowRight");await slider.press("ArrowRight");
  await page.getByRole("button",{name:"History",exact:true}).click();
  await expect.poll(async()=>(await savedSettings(request)).panelAnimationMs).toBe(dragged+50);
  expect(saves).toEqual([dragged,dragged-50,dragged+50]);
});

test("a setting saved while Trebell is still starting keeps its saved value once the start-up lands",async({page,request})=>{
  // The start-up reads Trebell's settings with the harness's bootstrap, which a busy machine can take seconds to answer (the server
  // asks the harness CLI how it is); the person opens Settings meanwhile and saves. The page's first bootstrap is held here until the
  // save has answered, so the start-up lands with the settings it read before the save: the saved value stays on screen and in
  // effect. The sidebar names the harness once the start-up has landed ("Starting…" until then).
  await request.post("/api/settings",{data:{agentRuntime:"codex",modelProvider:"openai"}});
  const bootstrap=await (await request.get("/api/bootstrap")).text();
  let releaseBootstrap=()=>{},asked=0;const bootstrapHeld=new Promise(resolve=>{releaseBootstrap=resolve});
  await page.route(/\/api\/bootstrap$/,async route=>{if(asked++)return route.fallback();await bootstrapHeld;await route.fulfill({status:200,contentType:"application/json",body:bootstrap})});
  await openSettings(page,request,"Startup Save Workspace",{panelAnimationMs:0});
  const harness=page.locator(".sidebar-provider strong");
  await expect(harness).toHaveText("Starting…");
  await page.getByRole("button",{name:/Appearance/}).click();
  const slider=page.getByLabel("Panel animations",{exact:true});
  const label=page.locator(".theme-settings label").filter({has:slider});
  const saved=page.waitForResponse(response=>response.request().method()==="POST"&&/\/api\/settings$/.test(response.url()));
  await slider.focus();await slider.press("ArrowRight");await slider.press("ArrowRight");
  await expect(label).toContainText("50 ms");
  expect((await (await saved).json()).panelAnimationMs).toBe(50);
  const panelMs=()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--panel-animation-ms").trim());
  await expect.poll(panelMs).toBe("50ms");
  releaseBootstrap();
  await expect(harness).toHaveText("Codex");
  await expect(slider).toHaveValue("50");
  await expect(label).toContainText("50 ms");
  expect(await panelMs()).toBe("50ms");
  expect((await savedSettings(request)).panelAnimationMs).toBe(50);
  await page.locator(".theme-settings").screenshot({animations:"disabled",path:auditDir+"settings-saved-before-startup-lands.png"});
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
  await page.screenshot({animations:"disabled",path:auditDir+"settings-theme-delete-undo-toast.png"});
  await toast.getByRole("button",{name:"Undo",exact:true}).click();
  await expect(toast).toHaveCount(0);
  await expect(themes.getByRole("button",{name:"Warm paper",exact:true})).toHaveClass(/active/);
  await expect(themes.getByRole("button")).toHaveText(["Trebell","Midnight","Black","Warm paper","Slate night"]);
  await expect.poll(async()=>{const saved=await savedSettings(request);return {ids:saved.customThemes.map(item=>item.id),appearance:saved.appearance}}).toEqual({ids:[warm.id,slate.id],appearance:warm.id});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.customTheme)).toBe("true");
  await page.screenshot({animations:"disabled",path:auditDir+"settings-theme-delete-undone.png"});
});

test("Undo of a theme delete keeps a theme chosen after the delete",async({page,request})=>{
  const warm={id:"custom-reliability-warm",name:"Warm paper",appearance:"light",canvas:"#f4efe6",accent:"#b0582f",colors:{}};
  await openSettings(page,request,"Theme Undo Choice Workspace",{customThemes:[warm],appearance:warm.id,environmentThemeSelections:{}});
  await page.getByRole("button",{name:/Appearance/}).click();
  const themes=page.getByRole("group",{name:"Theme"});
  await page.getByRole("button",{name:"Delete selected",exact:true}).click();
  const toast=page.getByTestId("thread-undo-toast");
  await expect(toast).toContainText("Theme “Warm paper” deleted");
  await themes.getByRole("button",{name:"Midnight",exact:true}).click();
  await expect(themes.getByRole("button",{name:"Midnight",exact:true})).toHaveClass(/active/);
  await expect.poll(async()=>(await savedSettings(request)).appearance).toBe("midnight");
  await toast.getByRole("button",{name:"Undo",exact:true}).click();
  await expect(toast).toHaveCount(0);
  await expect(themes.getByRole("button")).toHaveText(["Trebell","Midnight","Black","Warm paper"]);
  await expect(themes.getByRole("button",{name:"Midnight",exact:true})).toHaveClass(/active/);
  await expect(themes.getByRole("button",{name:"Warm paper",exact:true})).not.toHaveClass(/active/);
  await expect.poll(async()=>{const saved=await savedSettings(request);return {ids:saved.customThemes.map(item=>item.id),appearance:saved.appearance}}).toEqual({ids:[warm.id],appearance:"midnight"});
  await page.screenshot({animations:"disabled",path:auditDir+"settings-theme-undo-keeps-later-choice.png"});
});

// Contrast of a token or of an element as the page paints it: colors come from getComputedStyle (rgb() or, for
// color-mix() tokens, color(srgb ...)), and an element's backdrop is its translucent backgrounds laid over the first opaque one.
const contrastScript=()=>{
  const parse=value=>{const numbers=(String(value).match(/[\d.]+/g)||[]).map(Number);const srgb=String(value).startsWith("color(");return {rgb:numbers.slice(0,3).map(channel=>srgb?channel*255:channel),alpha:numbers.length>3?numbers[3]:1}};
  const over=(top,bottom)=>top.rgb.map((channel,index)=>channel*top.alpha+bottom[index]*(1-top.alpha));
  const luminance=rgb=>{const [r,g,b]=rgb.map(channel=>{const c=channel/255;return c<=.03928?c/12.92:Math.pow((c+.055)/1.055,2.4)});return .2126*r+.7152*g+.0722*b};
  const ratio=(a,b)=>{const x=luminance(a)+.05,y=luminance(b)+.05;return Math.round((x>y?x/y:y/x)*100)/100};
  const backdrop=element=>{const layers=[];for(let node=element;node;node=node.parentElement){const layer=parse(getComputedStyle(node).backgroundColor);if(layer.alpha>0)layers.push(layer);if(layer.alpha>=1)break}let fill=[255,255,255];for(const layer of layers.reverse())fill=over(layer,fill);return fill};
  const probe=document.createElement("div");document.body.append(probe);
  const token=name=>{probe.style.color=`var(${name})`;return parse(getComputedStyle(probe).color).rgb};
  window.__contrast={
    tokens(texts,fills){const result={};for(const text of texts)result[text]=Math.min(...fills.map(fill=>ratio(token(text),token(fill))));return result},
    painted(element,pseudo){const fill=backdrop(element);return ratio(over(parse(getComputedStyle(element,pseudo).color),fill),fill)},
  };
};
async function expectReadablePalette(page,label){
  await page.evaluate(contrastScript);
  const lowest=await page.evaluate(()=>window.__contrast.tokens(["--tx0","--tx1","--tx2","--tx3","--ac","--ok","--err","--warn"],["--bg0","--bg1","--bg2","--bg3"]));
  const floors={"--tx0":7,"--tx1":4.5,"--tx2":4.5,"--tx3":3.8,"--ac":3,"--ok":4.5,"--err":4.5,"--warn":4.5};
  for(const [name,floor] of Object.entries(floors))expect(lowest[name],`${label}: ${name} is ${lowest[name]}:1 on its lightest fill`).toBeGreaterThanOrEqual(floor);
  // The tiers still read as tiers: primary over secondary over tertiary.
  expect(lowest["--tx0"]).toBeGreaterThan(lowest["--tx1"]);expect(lowest["--tx1"]).toBeGreaterThan(lowest["--tx2"]);expect(lowest["--tx2"]).toBeGreaterThan(lowest["--tx3"]);
  return lowest;
}

test("a custom theme stays readable in the other mode: muted text, the accent and status colors all keep their contrast",async({page,request})=>{
  const warm={id:"custom-contrast-warm",name:"Warm paper",appearance:"light",canvas:"#f4efe6",accent:"#b0582f",colors:{}};
  const darkPlus={id:"custom-contrast-dark-plus",name:"Dark Plus",appearance:"dark",canvas:"#1e1e1e",accent:"#007fd4",colors:{foreground:"#d4d4d4",error:"#f14c4c",warning:"#cca700",success:"#73c991"}};
  await openSettings(page,request,"Theme Contrast Workspace",{customThemes:[warm,darkPlus],appearance:warm.id,environmentThemeSelections:{}});
  await page.getByRole("button",{name:/Appearance/}).click();
  const themes=page.getByRole("group",{name:"Theme"}),modes=page.getByRole("group",{name:"Mode"});
  await expect(themes.getByRole("button",{name:"Warm paper",exact:true})).toHaveClass(/active/);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.mode)).toBe("dark");
  // The light theme in Dark mode: a dark canvas, not the mid-gray one it used to get, under readable description text.
  const canvas=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--theme-canvas").trim());
  expect(canvas).toBe("#272625");
  await expectReadablePalette(page,"Warm paper in Dark mode");
  const description=page.locator(".theme-settings>p").filter({hasText:"Appearance controls light/dark behavior"});
  await expect(description).toContainText("Appearance controls light/dark behavior");
  expect(await description.evaluate(element=>window.__contrast.painted(element))).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({animations:"disabled",path:auditDir+"settings-theme-light-custom-in-dark-mode.png"});
  // The same theme in its own Light mode keeps its canvas and accent.
  await modes.getByRole("button",{name:"light",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.mode)).toBe("light");
  expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--theme-canvas").trim())).toBe("#f4efe6");
  expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--purple").trim())).toBe("#b0582f");
  await expectReadablePalette(page,"Warm paper in Light mode");
  await page.screenshot({animations:"disabled",path:auditDir+"settings-theme-light-custom-in-light-mode.png"});
  // A dark theme in Light mode: its light foreground is darkened until it reads instead of vanishing into the light canvas.
  await themes.getByRole("button",{name:"Dark Plus",exact:true}).click();
  await expect(themes.getByRole("button",{name:"Dark Plus",exact:true})).toHaveClass(/active/);
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--theme-canvas").trim())).toBe("#e9e9e9");
  await expectReadablePalette(page,"Dark Plus in Light mode");
  expect(await description.evaluate(element=>window.__contrast.painted(element))).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({animations:"disabled",path:auditDir+"settings-theme-dark-custom-in-light-mode.png"});
  // Back in the chat with the light theme in Dark mode: the composer placeholder and header breadcrumb (tertiary text) read.
  await themes.getByRole("button",{name:"Warm paper",exact:true}).click();
  await modes.getByRole("button",{name:"dark",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--theme-canvas").trim())).toBe("#272625");
  await expect.poll(async()=>{const saved=await savedSettings(request);return {appearance:saved.appearance,mode:saved.appearanceMode}}).toEqual({appearance:warm.id,mode:"dark"});
  await page.getByRole("button",{name:"New thread",exact:true}).click();
  const composer=page.getByTestId("composer");
  await expect(composer).toBeVisible();
  expect(await composer.evaluate(element=>window.__contrast.painted(element,"::placeholder"))).toBeGreaterThanOrEqual(3.8);
  const breadcrumb=page.locator(".workspace-header .workspace-breadcrumb").first();
  await expect(breadcrumb).toBeVisible();
  expect(await breadcrumb.evaluate(element=>window.__contrast.painted(element))).toBeGreaterThanOrEqual(3.8);
  await page.screenshot({animations:"disabled",path:auditDir+"chat-light-custom-theme-in-dark-mode.png"});
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
  await page.screenshot({animations:"disabled",path:auditDir+"settings-theme-undo-failed-after-leaving.png"});
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
  await page.locator(".settings-grid").screenshot({animations:"disabled",path:auditDir+"settings-theme-note-cleared.png"});
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
  await updates.screenshot({animations:"disabled",path:auditDir+"settings-release-check-failed-retry.png"});
  await retry.click();
  await expect(updates).toContainText("Latest: 1.6.1");
  await expect(retry).toHaveCount(0);
  expect(releaseChecks).toBe(2);
  expect(otherChecks).toEqual([]);
  await updates.screenshot({animations:"disabled",path:auditDir+"settings-release-check-retried.png"});
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
  await runtimeCard.screenshot({animations:"disabled",path:auditDir+"settings-runtime-card-refresh-ignores-release-check.png"});
});
