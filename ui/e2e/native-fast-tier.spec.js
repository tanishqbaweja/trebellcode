import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
// Saves the page in visual-audit in dark and light, switched with the header's theme button as a person switches it.
async function shootBothModes(page,name){
  for(const mode of ["dark","light"]){
    if(await page.locator("html").getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
    await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+".png",fullPage:true});
  }
}

// OpenAI with a key, offering GPT-6 Luna, which has both Thinking and Speed.
async function routeLuna(page){
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
}

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
  await routeLuna(page);

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
  await shootBothModes(page,"native-fast-tier");
});

// GPT-6 Luna, whose Thinking level Native was measured with (Max): with nothing saved the picker shows Max, the level a message runs at,
// lists no Default option (one could never stay chosen there: choosing it deleted the saved level and the picker showed Max again) and
// says in its title that Max is the default; each level picked is saved and shown, and the pill shows its whole value.
test("the Thinking picker on GPT-6 Luna shows Max with nothing saved, offers no Default that could never stay chosen, and keeps every pick",async({page,request})=>{
  await request.post("/api/settings",{data:{onboardingComplete:true,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",defaultModel:"gpt-6-luna",modelReasoningEfforts:{},modelServiceTiers:{}}});
  await routeLuna(page);
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await expect(page.getByTestId("model-picker")).toContainText("GPT-6 Luna");
  const thinking=page.getByTestId("reasoning-effort-picker");
  await expect(thinking).toHaveValue("max");
  await expect(thinking.locator("option")).toHaveText(["Thinking · None","Thinking · Low","Thinking · Medium","Thinking · High","Thinking · Extra High","Thinking · Max"]);
  await expect(thinking).toHaveAttribute("title",/Default: Max, the level Trebell Native was measured with/);
  const saved=async()=>(await (await request.get("/api/settings")).json()).modelReasoningEfforts?.["native:openai:gpt-6-luna"]??null;
  expect(await saved()).toBe(null);
  await thinking.selectOption({label:"Thinking · High"});
  await expect.poll(saved).toBe("high");await expect(thinking).toHaveValue("high");
  await thinking.selectOption({label:"Thinking · Max"});
  await expect.poll(saved).toBe("max");await expect(thinking).toHaveValue("max");
  await expect.poll(async()=>(await readComposer(page)).pickers.find(text=>text.startsWith("Thinking"))).toBe("Thinking · Max");
  await shootBothModes(page,"native-thinking-default");
});

// What a person reads in the composer's controls: each picker's chosen value, marked when the pill is too narrow for its whole text
// or lies past the edge of the row that clips it, the model picker's name, marked when cut, and whether the bar scrolls sideways.
const readComposer=page=>page.locator(".composer-bar").evaluate(async bar=>{
  await document.fonts.ready;
  const pen=document.createElement("canvas").getContext("2d"),row=bar.querySelector(".composer-left").getBoundingClientRect(),model=bar.querySelector("[data-testid=model-picker] strong");
  const pickers=[...bar.querySelectorAll(".composer-left>select")].map(select=>{
    const style=getComputedStyle(select),box=select.getBoundingClientRect(),text=select.selectedOptions[0]?.text||"";
    pen.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const needs=pen.measureText(text).width+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth);
    return text+(needs>box.width+1?" (cut)":"")+(box.left<row.left-1||box.right>row.right+1?" (past the row)":"");
  });
  return {pickers,model:model.textContent+(model.scrollWidth>model.clientWidth?" (cut)":""),sideways:bar.scrollWidth>bar.clientWidth+1};
});

// A new task in a project with Thinking · High and Speed · Fast picked: in a 900 and a 700 wide window the composer has no room
// for every picker beside the model picker on one row, and each still shows its whole value instead of "Thinking…" and "Speed · …".
test("the composer keeps the chosen Thinking and Speed readable in a 900 and a 700 wide window",async({page,request})=>{
  test.setTimeout(60_000);
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{},panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",defaultModel:"gpt-6-luna",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",modelReasoningEfforts:{},modelServiceTiers:{}}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Fast Tier Workspace",activate:true}});
  await routeLuna(page);
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"New task",exact:true}).click();
  await expect(page.getByTestId("model-picker")).toContainText("GPT-6 Luna");
  await page.getByTestId("reasoning-effort-picker").selectOption({label:"Thinking · High"});
  await page.getByTestId("service-tier-picker").selectOption({label:"Speed · Fast"});
  const whole={pickers:["Auto","Thinking · High","Speed · Fast","Current workspace"],model:"GPT-6 Luna",sideways:false};
  for(const width of [1280,900,700]){
    await page.setViewportSize({width,height:800});
    await expect.poll(()=>readComposer(page),{message:`the composer at ${width}x800`}).toEqual(whole);
    await shootBothModes(page,`native-fast-tier-composer-${width}x800`);
  }
});
