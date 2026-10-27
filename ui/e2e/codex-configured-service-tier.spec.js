import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { routeCodexApp, startCodexHarness } from "./codex-history-harness.js";

// A person whose Codex config runs Fast (service_tier = "fast" in config.toml) saw the Speed picker read Standard while Codex ran each
// new thread at Fast. Trebell's Codex model list now reads the configured tier (config/read, as T3 Code 3b844dab5 does) and gives it
// to each model that lists it as its default tier: the picker reads Fast while nothing is picked, a turn sends no tier, so Codex
// keeps applying its config, and a tier the person picks still goes with the turn.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// Codex 0.162.0's model/list rows, as it lists them for a home whose config.toml runs Fast (checked against the real CLI): every
// model has the priority tier, named Fast; only gpt-6-luna is Fast by its own default.
const fast={id:"priority",name:"Fast",description:"Faster responses"};
const row=(id,displayName,defaultServiceTier=null)=>({id,model:id,displayName,hidden:false,isDefault:false,supportedReasoningEfforts:[{reasoningEffort:"medium",description:""},{reasoningEffort:"high",description:""}],defaultReasoningEffort:"medium",serviceTiers:[fast],defaultServiceTier});
// The model list Trebell's server answers with for that config: those rows with the configured Fast as each one's default tier, as
// written here. That the server builds it from config/read's service_tier is tests/codex-configured-service-tier.test.mjs's check,
// against a fake Codex CLI; this spec checks the window's side, which the change left as it was, with such a list.
const LISTED=[row("gpt-6.1-sol","GPT-6.1 Sol","priority"),row("gpt-6-astra","GPT-6 Astra","priority"),row("gpt-6-luna","GPT-6 Luna","priority")];
function modelList(){
  const models=LISTED.map(item=>({...item,name:item.displayName,provider:"codex",agent:"Codex",reasoningEfforts:item.supportedReasoningEfforts,defaultReasoningEffort:item.defaultReasoningEffort}));
  return {models:models.map(item=>item.id),defaultModel:"gpt-6-astra",metadata:{provider:"codex",agentRuntime:"codex",source:"codex-model-list",models},scope:{agentRuntime:"codex",provider:"openai"}};
}

async function toggleMode(page){
  const before=await page.locator("html").getAttribute("data-mode"),direct=page.locator("[data-testid=appearance-toggle]:visible").first();
  if(await direct.count())await direct.click();
  else{await page.getByRole("button",{name:/More actions/}).first().click();await page.getByTestId("header-overflow-menu").getByRole("button",{name:/^Switch to (light|dark) mode$/}).click()}
  await expect(page.locator("html")).not.toHaveAttribute("data-mode",before||"");
}
// A screenshot in each mode at 1280x800, back in the mode it started in; ready() is what must show before each.
async function shoot(page,name,ready){
  for(let pass=0;pass<2;pass++){
    await ready();
    const mode=await page.locator("html").getAttribute("data-mode");
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({animations:"disabled",path:`${auditDir}codex-configured-service-tier-${name}-${mode}-1280x800.png`});
    await toggleMode(page);
  }
}

test("with the person's Codex config on Fast the Speed picker reads Fast while nothing is picked, a turn sends no tier, and Standard picked goes with the next turn",async({page})=>{
  test.setTimeout(90_000);
  const thread={id:"codex-configured-tier",name:"Codex configured tier",preview:"Speed from the Codex config",cwd:process.cwd(),status:{type:"idle"},model:"gpt-6-astra",createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const answer=text=>(turn,{emit,threadId,finish})=>{
    emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});
    const item={id:"agent-"+turn.id,type:"agentMessage",text};turn.items.push(item);emit({method:"item/completed",params:{threadId,turnId:turn.id,item}});finish("completed");
  };
  const listed=modelList();
  const harness=await startCodexHarness(thread,[answer("Release checks pass at the speed Codex runs."),answer("Release checks pass at Standard.")]);
  try{
    await routeCodexApp(page,harness,thread);
    await page.route(/\/api\/models$/,route=>json(route,listed));
    // A pick and the mode switch before each screenshot save settings, which answer with what was saved.
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const speed=page.getByTestId("service-tier-picker"),composer=page.getByTestId("composer");

    // A new task on Codex's default model: nothing is picked, and Codex runs it at Fast.
    await expect(page.getByTestId("model-picker")).toContainText("GPT-6 Astra",{timeout:15_000});
    await expect(speed).toHaveValue("priority");
    await expect(speed.locator("option:checked")).toHaveText("Speed · Fast");
    await expect(speed.locator("option")).toHaveText(["Speed · Standard","Speed · Fast"]);
    await shoot(page,"new-task",()=>expect(speed).toHaveValue("priority"));

    // The thread's turn goes with no tier of Trebell's, so Codex applies its config.
    const threadRow=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Codex configured tier"]')});
    await threadRow.locator(".thread-main").click();await expect(threadRow).toHaveClass(/active/);await expect(composer).not.toHaveAttribute("placeholder","Opening thread…");
    await expect(speed).toHaveValue("priority");
    await composer.click();await page.keyboard.type("Run the release checks");await page.keyboard.press("Enter");
    await expect(page.getByText("Release checks pass at the speed Codex runs.")).toBeVisible({timeout:15_000});
    const starts=()=>harness.calls.filter(call=>call.method==="turn/start").map(call=>call.params);
    expect(starts()).toHaveLength(1);
    expect(starts()[0].model).toBe("gpt-6-astra");
    expect(Object.prototype.hasOwnProperty.call(starts()[0],"serviceTier"),JSON.stringify(starts()[0])).toBe(false);

    // Standard picked: the picker reads it, and the next turn sends it.
    await speed.selectOption({label:"Speed · Standard"});
    await expect(speed).toHaveValue("default");
    await composer.click();await page.keyboard.type("Run them again at Standard");await page.keyboard.press("Enter");
    await expect(page.getByText("Release checks pass at Standard.")).toBeVisible({timeout:15_000});
    expect(starts()).toHaveLength(2);
    expect(starts()[1].serviceTier).toBe("default");
    await shoot(page,"standard-picked",()=>expect(speed).toHaveValue("default"));
  }finally{await harness.close()}
});
