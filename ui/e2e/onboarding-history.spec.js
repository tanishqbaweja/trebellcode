import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const shots=fileURLToPath(new URL("../../visual-audit/polish/onboarding/",import.meta.url));mkdirSync(shots,{recursive:true});
const SETTINGS={appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,modelProvider:"openai"};

// The header's mode button, clicked as a person switches between dark and light. Setup covers the header, so setup is marked done
// through the API while the button is clicked, and opened again after it.
async function switchModeUnderSetup(page,request,mode){
  if(await page.locator("html").getAttribute("data-mode")===mode)return;
  // Clicked once the app has loaded (the composer shows), as a person would, so the settings it loads cannot land after the click.
  await request.post("/api/settings",{data:{onboardingComplete:true}});await page.reload();await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
  await request.post("/api/settings",{data:{onboardingComplete:false}});await page.reload();
  await expect(page.getByTestId("onboarding")).toBeVisible();
}
// Screenshots of the setup dialog as it is, at 1280 and 900 wide; the page is left at 1280.
async function shootSetup(page,name,mode){
  for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:shots+`${name}-${mode}-${width}.png`})}
  await page.setViewportSize({width:1280,height:800});
}

// Pending Codex history for the onboarding workspace, laid over the server's own answer on whether Codex imports can run.
async function routeCodexHistory(page,cwd){
  await page.route(/\/api\/history-import$/,async route=>{
    if(route.request().method()!=="GET")return route.continue();
    const response=await route.fetch();const body=await response.json();
    return route.fulfill({response,json:{...body,sessions:[{id:"codex:onboarding-fixture",source:"codex",providerSessionId:"onboarding-fixture",cwd,title:"Onboarding Codex fixture",preview:"Onboarding Codex fixture",alreadyImported:false}]}});
  });
}

test("onboarding names the real reason Codex history cannot be imported",async({page,request})=>{
  test.setTimeout(60_000);
  const boot=await (await request.get("/api/bootstrap")).json();
  try{
    await request.post("/api/settings",{data:{...SETTINGS,onboardingComplete:false,agentRuntime:"codex"}});
    await routeCodexHistory(page,boot.cwd);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const onboarding=page.getByTestId("onboarding"),step=onboarding.locator(".onboarding-history-step");
    await expect(step).toContainText("Codex imports need a local Codex app-server, and none is reachable.");
    // Codex on Local machine is already the choice (the provider step says Codex is ready), so the step must not blame it.
    await expect(step).not.toContainText("Codex harness on Local machine");
    // The conversation was found and not imported, so the step does not call it already imported.
    await expect(step).toContainText("1 recent Codex conversation found.");
    await expect(step).not.toContainText("already imported");
    await expect(step.getByRole("button",{name:"Rescan"})).toBeEnabled();
    await page.screenshot({animations:"disabled",path:auditDir+"onboarding-codex-app-server-1280x800.png"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"onboarding-codex-app-server-light-1280x800.png"});

    // With another harness active, the harness choice is the reason, and the step keeps saying so.
    await request.post("/api/settings",{data:{agentRuntime:"native"}});
    await page.reload();
    await expect(step).toContainText("Codex imports need the Codex harness on Local machine.");
    await expect(step).not.toContainText("app-server");
    await page.screenshot({animations:"disabled",path:auditDir+"onboarding-codex-harness-1280x800.png"});
  }finally{
    await request.post("/api/settings",{data:{...SETTINGS,onboardingComplete:true,agentRuntime:"codex"}});
  }
});

// An import that copies some conversations and not others names each one it could not copy with the reason the server gave (those
// with the same reason together), on the import and on the retry; it used to say only how many failed. The scan and the import are
// answered here, so no real local history is read or copied.
test("onboarding names each conversation it could not import and why",async({page,request})=>{
  test.setTimeout(60_000);
  const boot=await (await request.get("/api/bootstrap")).json();
  const sessions=[["claude:login","claude","Fix the flaky login test"],["claude:notes","claude","Draft the release notes"],["codex:cli","codex","Port the CLI to Rust"],["codex:docs","codex","Write the docs site"]];
  const reasons={"claude:notes":"Session file is truncated (line 212 is not JSON)","codex:cli":"Local Codex app-server is not available","codex:docs":"Local Codex app-server is not available"};
  const imported=new Set(),posts=[];
  await page.route(/\/api\/history-import$/,route=>{
    if(route.request().method()!=="POST")return route.fulfill({json:{codexImportAvailable:true,sessions:sessions.map(([id,source,title])=>({id,source,providerSessionId:id.split(":")[1],cwd:boot.cwd,title,preview:title,alreadyImported:imported.has(id)}))}});
    const ids=route.request().postDataJSON().sessionIds;posts.push(ids);
    const results=ids.map(id=>reasons[id]?{id,source:id.split(":")[0],status:"error",error:reasons[id]}:(imported.add(id),{id,source:id.split(":")[0],status:"imported",threadId:"imported-"+id}));
    return route.fulfill({json:{ok:false,results,projects:[]}});
  });
  try{
    await request.post("/api/settings",{data:{...SETTINGS,onboardingComplete:false,agentRuntime:"codex"}});
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const onboarding=page.getByTestId("onboarding"),step=onboarding.locator(".onboarding-history-step"),message=step.getByRole("status");
    for(const mode of ["dark","light"]){
      imported.clear();await switchModeUnderSetup(page,request,mode);
      await expect(step).toContainText("4 recent conversations can be copied into Trebell.");
      await step.getByRole("button",{name:"Import history",exact:true}).click();
      await expect(message).toHaveText("Imported 1 conversation. “Draft the release notes” could not be imported: Session file is truncated (line 212 is not JSON). “Port the CLI to Rust” and “Write the docs site” could not be imported: Local Codex app-server is not available.");
      await expect(message).not.toHaveClass(/error/);
      await expect(step).toContainText("3 recent conversations can be copied into Trebell.");
      expect(posts.at(-1)).toEqual(["claude:login","claude:notes","codex:cli","codex:docs"]);
      await shootSetup(page,"history-import-partial",mode);
      // A retry tries only the three that are left, and says again what failed and why.
      await step.getByRole("button",{name:"Import history",exact:true}).click();
      await expect(message).toHaveText("“Draft the release notes” could not be imported: Session file is truncated (line 212 is not JSON). “Port the CLI to Rust” and “Write the docs site” could not be imported: Local Codex app-server is not available.");
      await expect(message).toHaveClass(/error/);
      expect(posts.at(-1)).toEqual(["claude:notes","codex:cli","codex:docs"]);
      await shootSetup(page,"history-import-retry-failed",mode);
    }
  }finally{
    await request.post("/api/settings",{data:{...SETTINGS,onboardingComplete:true,agentRuntime:"codex"}});
  }
});

// Forty conversations that fail for one reason (the local Codex app-server did not come up): the message says how many and why
// first and names three of them, so the reason is read without scrolling, at 1280 and 900 wide; it named all forty before it.
test("onboarding says why forty conversations could not be imported without naming every one",async({page,request})=>{
  test.setTimeout(60_000);
  const boot=await (await request.get("/api/bootstrap")).json();
  const title=index=>"Find out why the nightly payments reconciliation job fails at step "+index;
  const sessions=Array.from({length:40},(_,index)=>["codex:s"+index,"codex",title(index+1)]);
  await page.route(/\/api\/history-import$/,route=>{
    if(route.request().method()!=="POST")return route.fulfill({json:{codexImportAvailable:true,sessions:sessions.map(([id,source,title])=>({id,source,providerSessionId:id.split(":")[1],cwd:boot.cwd,title,preview:title,alreadyImported:false}))}});
    return route.fulfill({json:{ok:false,results:route.request().postDataJSON().sessionIds.map(id=>({id,source:"codex",status:"error",error:"Local Codex app-server is not ready"})),projects:[]}});
  });
  try{
    await request.post("/api/settings",{data:{...SETTINGS,onboardingComplete:false,agentRuntime:"codex"}});
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const onboarding=page.getByTestId("onboarding"),step=onboarding.locator(".onboarding-history-step"),message=step.getByRole("status");
    for(const mode of ["dark","light"]){
      await switchModeUnderSetup(page,request,mode);
      await expect(step).toContainText("40 recent conversations can be copied into Trebell.");
      await step.getByRole("button",{name:"Import history",exact:true}).click();
      await expect(message).toHaveText(`40 conversations could not be imported: Local Codex app-server is not ready (“${title(1)}”, “${title(2)}”, “${title(3)}” and 37 more).`);
      await expect(message).toHaveClass(/error/);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(message,`the whole message is in view at ${width}`).toBeInViewport({ratio:1})}
      await page.setViewportSize({width:1280,height:800});
      await shootSetup(page,"history-import-forty-failed",mode);
    }
  }finally{
    await request.post("/api/settings",{data:{...SETTINGS,onboardingComplete:true,agentRuntime:"codex"}});
  }
});

// Finish setup is disabled while it saves; when the save failed, the keyboard was left on the page body, outside the dialog. It stays
// on Finish setup, so Enter tries again. The history scan is answered here, so no real local history is read.
test("a Finish setup that fails leaves the keyboard on Finish setup in the dialog",async({page,request})=>{
  test.setTimeout(60_000);
  let failFinish=false;
  await page.route(/\/api\/history-import$/,route=>route.fulfill({json:{codexImportAvailable:true,sessions:[]}}));
  await page.route(/\/api\/settings$/,route=>{
    if(route.request().method()!=="POST"||!failFinish)return route.fallback();
    failFinish=false;return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Could not save settings: EPERM: operation not permitted, rename 'state.json.tmp'"})});
  });
  try{
    await request.post("/api/settings",{data:{...SETTINGS,onboardingComplete:false,agentRuntime:"codex"}});
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const onboarding=page.getByTestId("onboarding"),dialog=onboarding.getByRole("dialog",{name:"Set up Trebell Code"}),finish=onboarding.getByRole("button",{name:"Finish setup",exact:true});
    for(const mode of ["dark","light"]){
      await switchModeUnderSetup(page,request,mode);
      await expect(onboarding.getByRole("button",{name:"Rescan",exact:true})).toBeEnabled();
      // The person tabs to Finish setup and presses Enter; the save fails once.
      for(let presses=0;presses<6&&!await finish.evaluate(node=>node===document.activeElement);presses++)await page.keyboard.press("Tab");
      await expect(finish).toBeFocused();
      failFinish=true;await page.keyboard.press("Enter");
      await expect(onboarding.getByRole("alert")).toContainText("EPERM: operation not permitted");
      await expect(finish).toBeEnabled();
      await expect(finish).toBeFocused();
      await shootSetup(page,"finish-failed-focus",mode);
      // Tab and Shift+Tab go on inside the dialog.
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate(node=>node.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Shift+Tab");
      await expect(finish).toBeFocused();
    }
    // Enter, where the keyboard is, finishes setup.
    await page.keyboard.press("Enter");
    await expect(onboarding).toBeHidden();
    expect((await (await request.get("/api/state")).json()).settings.onboardingComplete).toBe(true);
  }finally{
    await request.post("/api/settings",{data:{...SETTINGS,onboardingComplete:true,agentRuntime:"codex"}});
  }
});
