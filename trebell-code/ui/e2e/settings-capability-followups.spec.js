import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

test("follow-up settings obey runtime steering capability instead of runtime name",async({page})=>{
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"freebuff",followUpMode:"queue",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:true,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"claude",agentRuntimeReady:true,appServerReady:false,wsUrl:"",cwd:process.cwd(),platform:process.platform,version:"settings-capability-fixture",runtimeCapabilities:{queue:true,steering:true},activeEnvironmentId:null,activeEnvironment:null})}));
  await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:{}})}));
  await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({agentRuntime:"claude",models:["claude-fixture"],metadata:{models:[{id:"claude-fixture",name:"Claude Fixture",agent:"Claude Code"}]}})}));
  await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
  await page.route(/\/api\/agent-runtimes$/,route=>route.fulfill({
    status:200,contentType:"application/json",body:JSON.stringify({
      selectedRuntime:"claude",selectedInstanceId:"claude-default",compatibleInstanceIds:["claude-default"],capabilities:{queue:true,steering:true},
      definitions:[{id:"claude",name:"Claude Code",multipleInstances:true,capabilities:{queue:true,steering:true},installable:true,canAuthenticate:true}],
      instances:[{id:"claude-default",kind:"claude",displayName:"Claude Code"}],
      statuses:[{id:"claude-default",kind:"claude",name:"Claude Code",available:true,installed:true,authenticated:true,version:"fixture"}],
    }),
  }));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  const card=page.locator('[data-setting-target="general-followups"]');
  await expect(card).toContainText("Follow-up behavior");
  const select=card.getByRole("combobox",{name:"While the agent is working"});
  await expect(select).toBeVisible();
  await expect(select.locator('option[value="steer"]')).toHaveText("Steer current turn immediately");
  await expect(card).not.toContainText("does not expose in-flight steering");
  await page.setViewportSize({width:1280,height:800});
  const metrics=await page.locator(".settings-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"settings-capability-steering-1280x800.png",fullPage:true});
});
