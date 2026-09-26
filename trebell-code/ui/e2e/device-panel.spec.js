import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

test("iOS simulator lifecycle stays honest and visually clear",async({page,request})=>{
  test.setTimeout(30_000);await page.setViewportSize({width:1280,height:800});
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0}});
  let running=false;const actions=[];
  const devices=()=>({capabilities:{android:{available:false,tools:[],sdkManagerAvailable:false},ios:{available:true,reason:null}},devices:[{id:"ios:fixture-udid",platform:"ios",serial:"fixture-udid",name:"iPhone 17 Pro",state:running?"Booted":"Shutdown",runtime:"iOS-27-0",running}],avds:[]});
  await page.route(/\/api\/devices$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(devices())}));
  await page.route(/\/api\/device\/screenshot(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"ios:fixture-udid",platform:"ios",dataUrl:"data:image/png;base64,iVBORw0KGgo=",width:1179,height:2556})}));
  await page.route(/\/api\/device\/action$/,route=>{
    const body=route.request().postDataJSON()||{};actions.push(body);if(body.action==="boot")running=true;if(body.action==="poweroff")running=false;
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,id:body.id,action:body.action})});
  });
  await page.goto("/");await page.getByTestId("right-panel-toggle").click();const panel=page.getByTestId("right-panel");await panel.getByRole("button",{name:"Device",exact:true}).click();
  await expect(panel.locator(".device-panel")).toBeVisible();await expect(panel.locator("select")).toContainText("iPhone 17 Pro · ios · Shutdown");
  await expect(panel.getByText("Simulator is stopped.",{exact:true})).toBeVisible();await expect(panel.getByRole("button",{name:"Boot simulator",exact:true})).toBeVisible();
  await expect(panel.getByRole("button",{name:"Back",exact:true})).toHaveCount(0);await expect(panel.getByPlaceholder("Type into focused emulator control")).toHaveCount(0);
  await panel.screenshot({path:auditDir+"device-ios-stopped-dark-1280x800.png"});
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await panel.screenshot({path:auditDir+"device-ios-stopped-light-1280x800.png"});await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
  await panel.getByRole("button",{name:"Boot simulator",exact:true}).click();await expect.poll(()=>actions.length).toBe(1);expect(actions[0]).toMatchObject({id:"ios:fixture-udid",action:"boot"});
  await expect(panel.locator("select")).toContainText("iPhone 17 Pro · ios · Booted");await expect(panel.getByRole("button",{name:"Power off",exact:true})).toBeVisible();
  await panel.getByRole("button",{name:"Power off",exact:true}).click();await expect.poll(()=>actions.length).toBe(2);expect(actions[1]).toMatchObject({id:"ios:fixture-udid",action:"poweroff"});await expect(panel.getByRole("button",{name:"Boot simulator",exact:true})).toBeVisible();
});
