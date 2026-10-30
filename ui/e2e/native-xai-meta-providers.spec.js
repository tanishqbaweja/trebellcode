import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Trebell Native on xAI's API and on the Meta Model API, against the mock-mode GUI server itself (no route of the page is
// stood in for): Settings' Model provider card offers both as official providers, each is picked, a key is typed and saved,
// and the composer lists that provider's models (the mock server's catalog; mock mode contacts no provider). Meta's catalog
// names no Thinking levels, so the composer offers the ones Meta documents for Muse Spark 1.3.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const PROVIDERS=[
  {id:"xai",name:"xAI API",models:["grok-4.7","grok-4.6"],note:"Grok models from xAI. Models are loaded live from the official xAI /v1/language-models API for this key.",thinking:[]},
  {id:"meta",name:"Meta Model API",models:["muse-spark-1.3","muse-wonder-1.0"],note:"Muse models from Meta. Models are loaded live from the official Meta Model API /v1/models for this key.",thinking:["Default","Minimal","Low","Medium","High","Extra High","Max"].map(level=>"Thinking · "+level)},
];

// Waits for smooth scrolling (Settings reveals its target that way) to come to rest before a screenshot.
async function settle(page){
  await page.evaluate(()=>new Promise(resolve=>{
    const positions=()=>[...document.querySelectorAll("*")].map(node=>node.scrollTop).join(",");
    let last=positions(),still=0,frames=0;
    const tick=()=>{const now=positions();still=now===last?still+1:0;last=now;if(still>=6||++frames>180)resolve();else requestAnimationFrame(tick)};
    requestAnimationFrame(tick);
  }));
}
async function openProviderCard(page){
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  await expect(page.getByTestId("provider-settings-card")).toBeVisible();
}

for(const mode of ["dark","light"])test(`xAI and the Meta Model API are picked in Settings, take a key and list their models (${mode})`,async({page,request})=>{
  test.setTimeout(90_000);
  // Each run of the test starts on OpenAI with neither new provider holding a key, whatever an earlier test of the run saved.
  for(const provider of PROVIDERS)expect((await request.post("/api/providers",{data:{provider:provider.id,apiKey:""}})).ok()).toBe(true);
  await request.post("/api/settings",{data:{onboardingComplete:true,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",appearance:"dark",appearanceMode:mode,panelAnimationMs:0}});
  await page.setViewportSize({width:1280,height:900});
  await page.goto("/");
  await openProviderCard(page);
  const card=page.getByTestId("provider-settings-card"),selector=page.getByTestId("provider-selector"),status=page.getByTestId("provider-status");
  await expect(selector.locator('option[value="xai"]')).toHaveText("xAI API · official");
  await expect(selector.locator('option[value="meta"]')).toHaveText("Meta Model API · official");
  for(const provider of PROVIDERS){
    await selector.selectOption(provider.id);
    await expect(card).toHaveAttribute("aria-busy","false",{timeout:15_000});
    await expect(selector).toHaveValue(provider.id);
    await expect(status).toHaveText(`${provider.name} · API key required`);
    await expect(card.locator("p.provider-note")).toHaveText(provider.note);
    await page.getByTestId("provider-api-key").fill(provider.id+"-fixture-key");
    await page.getByTestId("save-provider-key").click();
    await expect(status).toHaveText(`${provider.name} · ready · API key saved. Harness ready.`,{timeout:15_000});
    await expect(page.getByTestId("provider-api-key")).toHaveValue("");
    await expect(page.getByTestId("provider-api-key")).toHaveAttribute("placeholder","Saved key ••••••••");
    await expect(card.getByRole("button",{name:"Remove key",exact:true})).toBeVisible();
    const saved=await (await request.get("/api/providers")).json();
    expect(saved.selected).toBe(provider.id);
    expect(saved.providers.find(item=>item.id===provider.id)).toMatchObject({name:provider.name,official:true,hasKey:true});
    expect(JSON.stringify(saved),"the key never comes back from the server").not.toContain(provider.id+"-fixture-key");
    await card.scrollIntoViewIfNeeded();await settle(page);
    await page.screenshot({animations:"disabled",path:auditDir+`native-provider-${provider.id}-key-saved-${mode}.png`});

    // The composer lists the provider's models. Neither provider names a default model, so none is assumed: the picker asks for
    // one, and the model picked shows with the Thinking levels it takes.
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    const picker=page.getByTestId("model-picker"),thinking=page.getByTestId("reasoning-effort-picker");
    await expect(picker).toBeEnabled({timeout:15_000});await expect(picker).toHaveText("Choose a model");
    await expect(thinking).toHaveCount(0);
    await picker.click();
    const menu=page.locator(".model-picker-menu");await expect(menu).toBeVisible();
    await expect(menu.locator("> button strong")).toHaveText(provider.models);
    await expect(page.locator(".sidebar-provider")).toContainText(provider.name);
    await settle(page);
    await page.screenshot({animations:"disabled",path:auditDir+`native-provider-${provider.id}-models-${mode}.png`});
    await menu.getByRole("button",{name:provider.models[0],exact:true}).click();await expect(menu).toBeHidden();
    await expect(picker).toHaveText(provider.models[0]);
    if(provider.thinking.length)await expect(thinking.locator("option")).toHaveText(provider.thinking);
    else await expect(thinking).toHaveCount(0);
    await openProviderCard(page);
  }
});
