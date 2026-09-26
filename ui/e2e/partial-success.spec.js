import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function prepare(page,request){
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Partial Success Workspace",activate:true}});
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  return boot;
}

test("successful project removal reports a follow-up refresh failure as partial success",async({page,request})=>{
  await prepare(page,request);
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  const card=page.locator(".project-card").filter({hasText:"Partial Success Workspace"});
  await expect(card).toBeVisible();
  let removed=false;
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>{
    if(route.request().method()==="DELETE"){removed=true;return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})})}
    if(route.request().method()==="GET"&&removed)return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate post-removal refresh failure"})});
    return route.continue();
  });
  await card.getByRole("button",{name:"Remove Partial Success Workspace"}).click();
  const alert=page.getByRole("alert");
  await expect(alert).toContainText("Project was removed, but the project list could not refresh");
  await expect(alert).toContainText("last valid project data is still shown");
  await expect(alert).not.toContainText("Could not remove project");
  await expect(card).toBeVisible();
  await page.setViewportSize({width:1280,height:800});
  const metrics=await page.locator(".projects-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"project-remove-partial-success-1280x800.png",fullPage:true});
});

test("successful Git push reports a follow-up repository refresh failure as partial success",async({page,request})=>{
  const boot=await prepare(page,request);
  let pushed=false;
  const info={isGit:true,root:boot.cwd,branch:"main",branches:["main"],upstream:"origin/main",status:[],remotes:[{name:"origin",url:"https://github.com/example/fixture.git"}],worktrees:[{path:boot.cwd,branch:"main"}]};
  await page.route(/\/api\/git\/info\?/,route=>pushed
    ?route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate post-push refresh failure"})})
    :route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(info)}));
  await page.route(/\/api\/source-control\/diagnostics\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},
    providers:{github:{label:"GitHub",installed:true,authenticated:true}},
    capabilities:{github:{create:true,comment:true,review:true,merge:true,updateBranch:true,publish:true}},
  })}));
  await page.route(/\/api\/source-control\/prs\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[],capabilities:{create:true,comment:true,review:true,merge:true,updateBranch:true,publish:true}})}));
  await page.route(/\/api\/git\/action$/,async route=>{
    const body=route.request().postDataJSON();
    if(body.action==="push")pushed=true;
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({result:{info}})});
  });
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
  await expect(panel.getByRole("button",{name:"Push",exact:true})).toBeVisible();
  await panel.getByRole("button",{name:"Push",exact:true}).click();
  const alert=panel.getByRole("alert");
  await expect(alert).toContainText("Push completed, but the latest source-control state could not be refreshed");
  await expect(alert).toContainText("last valid view is still shown");
  await expect(panel.locator(".sc-card").filter({hasText:"Repository"})).toContainText("origin/main");
  await page.setViewportSize({width:1280,height:800});
  const metrics=await panel.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"source-control-push-partial-success-1280x800.png",fullPage:true});
});
