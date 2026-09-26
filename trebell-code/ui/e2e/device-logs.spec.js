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
  const deviceActions=[];
  await page.route(/\/api\/device\/action$/,async route=>{
    const body=route.request().postDataJSON();deviceActions.push(body);
    if(body.action==="packages")return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,id:deviceId,action:"packages",packages:["com.example.demo","com.example.other"],truncated:false,total:2})});
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,id:deviceId,action:body.action,app:body.args?.app||null})});
  });
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:520,terminalHeight:330})));
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Device",exact:true}).click();
  await expect(panel.locator(".device-toolbar select")).toHaveValue(deviceId);
  await expect(panel.getByAltText("Pixel Fixture")).toBeVisible();
  await panel.getByRole("button",{name:"Apps",exact:true}).click();
  await expect(panel.getByLabel("Simulator app id")).toHaveValue("com.example.demo");
  await panel.getByRole("button",{name:"Launch",exact:true}).click();
  expect(deviceActions.some(item=>item.action==="packages")).toBe(true);
  expect(deviceActions.some(item=>item.action==="launch"&&item.args?.app==="com.example.demo")).toBe(true);
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

test("iOS Device panel maps Retina screenshots into IDB point-space for real input",async({page,request})=>{
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"freebuff"}});
  const iosId="ios:12345678-1234-1234-1234-123456789ABC";
  const screenSvg='<svg xmlns="http://www.w3.org/2000/svg" width="1179" height="2556" viewBox="0 0 1179 2556"><rect width="1179" height="2556" fill="#111827"/><rect x="90" y="240" width="999" height="260" rx="54" fill="#1f2937"/><text x="589" y="365" text-anchor="middle" fill="#f3f4f6" font-family="sans-serif" font-size="72">iPhone Fixture</text><circle cx="589" cy="1300" r="180" fill="#6d5c8c"/><text x="589" y="1325" text-anchor="middle" fill="white" font-family="sans-serif" font-size="54">IDB</text></svg>';
  const dataUrl="data:image/svg+xml;base64,"+Buffer.from(screenSvg).toString("base64"),actions=[];
  await page.route(/\/api\/devices$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    capabilities:{android:{available:false,emulatorAvailable:false,sdkManagerAvailable:false,tools:[]},ios:{available:true,inputAvailable:true,inputTool:"idb",inputReason:null}},
    devices:[{id:iosId,platform:"ios",serial:iosId.slice(4),name:"iPhone Fixture",state:"Booted",runtime:"iOS-26-0",running:true}],avds:[],
  })}));
  await page.route(/\/api\/device\/screenshot\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:iosId,platform:"ios",dataUrl,width:1179,height:2556,inputWidth:393,inputHeight:852,inputCoordinateSpace:"points"})}));
  await page.route(/\/api\/device\/action$/,async route=>{const body=route.request().postDataJSON();actions.push(body);return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,id:iosId,action:body.action})})});
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:520,terminalHeight:330})));
  await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Device",exact:true}).click();
  const image=panel.getByAltText("iPhone Fixture");await expect(image).toBeVisible();const box=await image.boundingBox();expect(box).toBeTruthy();
  await page.mouse.click(box.x+box.width*0.25,box.y+box.height*0.5);
  await expect.poll(()=>actions.some(item=>item.action==="tap")).toBe(true);
  const tapAction=actions.find(item=>item.action==="tap");expect(tapAction.args.x).toBeGreaterThan(90);expect(tapAction.args.x).toBeLessThan(105);expect(tapAction.args.y).toBeGreaterThan(415);expect(tapAction.args.y).toBeLessThan(437);
  await panel.getByRole("button",{name:"Home",exact:true}).click();await expect.poll(()=>actions.some(item=>item.action==="key"&&item.args?.key==="home")).toBe(true);
  const input=panel.getByPlaceholder("Type into focused simulator control");await input.fill("hello ios");await panel.getByRole("button",{name:"Send",exact:true}).click();await expect.poll(()=>actions.some(item=>item.action==="type"&&item.args?.text==="hello ios")).toBe(true);
  await expect(panel.locator(".device-input-hint")).toHaveCount(0);
  await page.setViewportSize({width:1280,height:800});const metrics=await panel.locator(".device-panel").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
  await page.screenshot({path:auditDir+"device-ios-idb-input-1280x800.png",fullPage:true});
});
