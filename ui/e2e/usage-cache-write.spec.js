import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

test("Usage page exposes cache reads and cache writes from recorded token telemetry",async({page,request})=>{
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"freebuff"}});
  const record={
    id:"usage-cache-write-fixture",runtime:"native",provider:"agentrouter",model:"gpt-fixture",environmentId:null,threadId:"thread-usage",turnId:"turn-usage",at:Date.now(),
    usage:{inputTokens:12_000,cachedInputTokens:3_000,cacheWriteInputTokens:1_500,outputTokens:2_000,reasoningOutputTokens:500,totalTokens:14_000},cost:null,
  };
  await page.route(/\/api\/usage(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    records:[record],total:{...record.usage},models:{"gpt-fixture":{tokens:14_000,turns:1,costUsd:0}},runtimes:{native:{tokens:14_000,turns:1,costUsd:0}},daily:{},
  })}));
  await page.goto("/");
  await page.getByRole("button",{name:"Usage",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();
  const summary=page.locator(".usage-summary");
  await expect(summary).toContainText("3.0K cache read");
  await expect(summary).toContainText("1.5K cache write");
  await expect(summary).toContainText("500 reasoning");
  await page.setViewportSize({width:1280,height:800});
  const metrics=await page.locator(".usage-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"usage-cache-write-1280x800.png",fullPage:true});
});
