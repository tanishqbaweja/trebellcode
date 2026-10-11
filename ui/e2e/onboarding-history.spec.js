import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const SETTINGS={appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,modelProvider:"openai"};

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
