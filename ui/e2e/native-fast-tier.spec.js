import { test, expect } from "@playwright/test";

test("Trebell Native exposes and persists OpenAI Fast independently from Max thinking",async({page,request})=>{
  await request.post("/api/settings",{data:{
    onboardingComplete:true,
    agentRuntime:"native",
    agentRuntimeInstanceId:"native-default",
    modelProvider:"openai",
    defaultModel:"gpt-6-luna",
    modelReasoningEfforts:{"native:openai:gpt-6-luna":"max"},
    modelServiceTiers:{},
  }});

  await page.route("**/api/providers",async route=>{
    if(route.request().method()!=="GET")return route.continue();
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      selected:"openai",ready:true,
      status:{id:"openai",name:"OpenAI API",official:true,requiresKey:true,hasKey:true,ready:true},
      providers:[{id:"openai",name:"OpenAI API",official:true,requiresKey:true,hasKey:true}],
    })});
  });
  await page.route("**/api/models",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    provider:"openai",agentRuntime:"native",ready:true,models:["gpt-6-luna"],
    metadata:{provider:"openai",models:[{id:"gpt-6-luna",name:"GPT-6 Luna",provider:"openai",agent:"Trebell Native"}]},
  })}));

  await page.goto("/");
  const modelPicker=page.getByTestId("model-picker");await expect(modelPicker).toContainText("GPT-6 Luna");
  const thinking=page.getByTestId("reasoning-effort-picker");await expect(thinking).toHaveValue("max");
  const speed=page.getByTestId("service-tier-picker");await expect(speed).toBeVisible();await expect(speed).toHaveValue("");
  await expect(speed.locator("option")).toHaveText(["Speed · Standard","Speed · Fast"]);
  await speed.selectOption("fast");

  await expect.poll(async()=>{
    const settings=await (await request.get("/api/settings")).json();
    return settings.modelServiceTiers?.["native:openai:gpt-6-luna"]||null;
  }).toBe("fast");
  await expect(thinking).toHaveValue("max");
  await expect(modelPicker).toContainText("GPT-6 Luna");
  await page.screenshot({path:"test-results/native-fast-tier.png",fullPage:true});
});
