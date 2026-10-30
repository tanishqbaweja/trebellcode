import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";

// Muse Code's subscription windows on the Usage page, as a person on a Muse Code window reads them. The page's subscription limits
// read is answered as gui-server.mjs answers /api/agent-runtime-usage, by a runtime manager of the test's own: what it shows is the
// last usage/changed Muse Code's sessions keep for the account (read through museUsageReport, which a stand-in for that store answers
// here), in the shape of Muse 1.4's usage/changed report. Before any
// report the card says none came yet; then a 5-hour row (the length Muse reports) and a Weekly row, a window Meta reports at 103%
// held at 100% used, with their resets and the time the report was observed; a later report shows at the next Refresh.
const shots=fileURLToPath(new URL("../../visual-audit/polish/muse-usage/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const NOT_OBSERVED="Muse Code has not reported its subscription windows yet. They show here once a Muse Code turn in Trebell Code reports them.";

async function shoot(page,card,name){
  for(const mode of ["dark","light"]){
    if(await page.locator("html").getAttribute("data-mode")!==mode){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:`${shots}${name}-${mode}-1280x800.png`});
  }
  await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
}

test("a Muse Code window's Usage card says no windows came before a turn reports them, then shows the 5-hour and Weekly windows with their resets, clamped, and when they were observed",async({page})=>{
  test.setTimeout(60_000);
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",
    agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,environment:{}}]};
  // Nothing of the manager's runs a command or reads the network for the windows: both are refused here.
  const manager=new AgentRuntimeManager({state:{settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch)},env:{PATH:""},
    runFn:async command=>{throw new Error("ran "+command)},fetchImpl:async url=>{throw new Error("fetched "+url)}});
  // The store Muse Code's sessions keep the account's last report in: none yet.
  manager.museUsageReport=()=>null;
  const reads=[];
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",agentRuntimeReady:true,appServerReady:false,wsUrl:"",cwd:process.cwd(),platform:"win32",version:"muse-subscription-usage",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
  // The theme button saves the mode: the window's own settings take it, and stay on Muse Code.
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
  await page.route(/\/api\/agent-runtime-usage(?:\?.*)?$/,async route=>{
    const instance=manager.activeInstance(),usage=await manager.usageLimits(instance);reads.push(usage);
    await json(route,{runtime:instance.kind,instanceId:instance.id,environmentId:null,...usage});
  });
  await page.route(/\/api\/models$/,route=>json(route,{models:["muse-spark-1.3"],metadata:{provider:"muse",models:[{id:"muse-spark-1.3",name:"Muse Spark 1.3",provider:"muse",agent:"Muse Code"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/environments$/,route=>json(route,{profiles:[],activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/usage(?:\?.*)?$/,route=>json(route,{records:[],total:{},models:{},runtimes:{},daily:{}}));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");await page.getByRole("button",{name:"Usage",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();
  const card=page.getByTestId("runtime-account-usage"),rows=card.locator(".codex-limit-card"),head=card.locator(".capability-card-head em");
  const refresh=page.locator(".usage-toolbar .usage-refresh");
  // No Muse Code turn has reported its windows yet.
  await expect(card.locator(".capability-card-head strong")).toHaveText("Muse Code subscription limits");
  await expect(card.getByText(NOT_OBSERVED,{exact:true})).toBeVisible();
  // Muse's windows are never read live, so with no report its head names only the environment.
  await expect(rows).toHaveCount(0);await expect(head).toHaveText(/^[^·]+$/);await expect(head).not.toContainText("live");
  await shoot(page,card,"not-observed");
  // A Muse Code turn reports them (usage/changed, which its session keeps): Meta's 103% for the 5-hour window, 41% for the week.
  const now=Date.now(),observedAtMs=now-2*60_000,windowReset=now+3*3_600_000,weeklyReset=now+4*86_400_000;
  manager.museUsageReport=()=>({observedAtMs,tier:"tier-1",window:{usedPercent:103,windowDurationMins:300,resetsAtMs:windowReset},weekly:{usedPercent:41,resetsAtMs:weeklyReset}});
  await refresh.click();await expect(refresh).toHaveText("Refresh");
  const local=ms=>page.evaluate(value=>new Date(value).toLocaleString(),ms);
  await expect(rows).toHaveCount(2);
  const hours=rows.nth(0),weekly=rows.nth(1);
  await expect(hours.locator("strong").first()).toHaveText("5-hour");await expect(hours.locator("span").first()).toHaveText("session");
  await expect(hours.locator(".limit-window strong")).toHaveText("100% used");
  await expect(hours.locator(".limit-window small")).toHaveText(`0% left · resets ${await local(windowReset)}`);
  await expect(hours.locator(".limit-window")).toHaveClass(/critical/);
  await expect(weekly.locator("strong").first()).toHaveText("Weekly");await expect(weekly.locator("span").first()).toHaveText("weekly");
  await expect(weekly.locator(".limit-window strong")).toHaveText("41% used");
  await expect(weekly.locator(".limit-window small")).toHaveText(`59% left · resets ${await local(weeklyReset)}`);
  await expect(head).toContainText(` · observed ${await local(observedAtMs)}`);await expect(head).not.toContainText("live");
  await expect(card.getByText(NOT_OBSERVED,{exact:true})).toHaveCount(0);
  await shoot(page,card,"observed");
  // A later turn's report shows at the next Refresh, pressed from the keyboard this time.
  const later=now-30_000;
  manager.museUsageReport=()=>({observedAtMs:later,tier:"tier-1",window:{usedPercent:12,windowDurationMins:300,resetsAtMs:windowReset},weekly:{usedPercent:44,resetsAtMs:weeklyReset}});
  await refresh.focus();await page.keyboard.press("Enter");await expect(refresh).toHaveText("Refresh");
  await expect(hours.locator(".limit-window strong")).toHaveText("12% used");await expect(weekly.locator(".limit-window strong")).toHaveText("44% used");
  await expect(head).toContainText(` · observed ${await local(later)}`);
  expect(reads.length).toBe(3);
});
