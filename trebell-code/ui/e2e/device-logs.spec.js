import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const deviceId="android:emulator-5554";

test("Device panel exposes bounded recent simulator logs without breaking the workspace layout",async({page,request})=>{
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"}});
  const screenSvg='<svg xmlns="http://www.w3.org/2000/svg" width="360" height="720" viewBox="0 0 360 720"><rect width="360" height="720" fill="#111827"/><rect x="24" y="70" width="312" height="90" rx="18" fill="#1f2937"/><text x="180" y="115" text-anchor="middle" fill="#f3f4f6" font-family="sans-serif" font-size="22">Pixel Fixture</text><text x="180" y="143" text-anchor="middle" fill="#9ca3af" font-family="sans-serif" font-size="14">Trebell device preview</text><circle cx="180" cy="360" r="58" fill="#6d5c8c"/><text x="180" y="368" text-anchor="middle" fill="white" font-family="sans-serif" font-size="18">APP</text></svg>';
  const dataUrl="data:image/svg+xml;base64,"+Buffer.from(screenSvg).toString("base64");
  await page.route(/\/api\/devices$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    capabilities:{android:{available:true,emulatorAvailable:true,sdkManagerAvailable:false,tools:[]},ios:{available:false}},
    devices:[{id:deviceId,platform:"android",serial:"emulator-5554",name:"Pixel Fixture",state:"device",running:true}],avds:[],
  })}));
  await page.route(/\/api\/device\/screenshot\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:deviceId,platform:"android",dataUrl,width:360,height:720})}));
  await page.route(/\/api\/device\/logs\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    id:deviceId,platform:"android",text:"09-26 10:42:01.012 I/TrebellDemo: Activity resumed\n09-26 10:42:01.083 I/Network: API handshake complete\n09-26 10:42:02.501 W/Renderer: Frame budget recovered",
    lineCount:3,omittedLines:17,omittedCharacters:0,truncated:true,
  })}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:520,terminalHeight:330})));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Device",exact:true}).click();
  await expect(panel.locator(".device-toolbar select")).toHaveValue(deviceId);
  await expect(panel.getByAltText("Pixel Fixture")).toBeVisible();
  await panel.getByRole("button",{name:"Recent logs",exact:true}).click();
  const logs=panel.getByTestId("device-logs");
  await expect(logs).toBeVisible();
  await expect(logs).toContainText("3 lines · truncated");
  await expect(logs).toContainText("API handshake complete");
  await expect(logs).toContainText("17 earlier lines omitted");
  await logs.scrollIntoViewIfNeeded();
  await page.setViewportSize({width:1280,height:800});
  const metrics=await panel.locator(".device-panel").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"device-logs-1280x800.png",fullPage:true});
});
