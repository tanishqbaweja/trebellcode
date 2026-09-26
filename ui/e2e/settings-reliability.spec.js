import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

test("manual diagnostics refresh failures preserve the last valid runtime log",async({page,request})=>{
  test.setTimeout(30_000);
  let failDiagnostics=false;
  const validDiagnostics={
    runtime:{provider:"freebuff",providerReady:true},
    logs:[{at:Date.now(),stream:"stdout",text:"known-good diagnostics\n"}],
  };
  await page.route(/\/api\/diagnostics(?:\?.*)?$/,route=>failDiagnostics
    ?route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate diagnostics refresh failure"})})
    :route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(validDiagnostics)}));
  await page.route(/\/api\/update\/check$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({current:true})}));
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"}});
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
      provider:"freebuff",providerReady:true,appServerReady:false,bridgeReady:true,logs:[],
    }),
  }));
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Unavailable Runtime Workspace",activate:true}});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  const runtimeCard=page.locator('[data-setting-target="agents-runtime"]');
  await expect(runtimeCard).toContainText("Agent runtime: not ready");
  await expect(runtimeCard).toContainText("Codex app-server: not ready");
  await page.getByRole("button",{name:/Diagnostics/}).click();
  await expect(page.locator(".diag-badges span").first()).not.toHaveClass(/\bok\b/);
});
