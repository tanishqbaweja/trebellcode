import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readGrokUsageLimits } from "../../src/agent-usage-limits.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// A Grok account that has used nothing in its billing period yet: xAI's billing answer leaves the used percentage out until
// something is metered, while it still names the period. The Usage page's subscription limits read is answered with what
// Trebell's server makes of that answer (readGrokUsageLimits from src/, as /api/agent-runtime-usage answers for the active Grok
// profile), on a stand-in for xAI's billing endpoint.
test("a Grok billing period with nothing used yet shows its meter at 0% with its reset, and a period without its start shows none",async({page})=>{
  test.setTimeout(40_000);
  const start=new Date(Date.now()-2*86_400_000).toISOString(),end=new Date(Date.now()+5*86_400_000).toISOString();
  let billing={config:{currentPeriod:{type:"USAGE_PERIOD_TYPE_WEEKLY",start,end}}};const billingReads=[];
  const serverRead=async()=>({runtime:"grok",instanceId:"grok-default",environmentId:null,...await readGrokUsageLimits({
    environment:{GROK_AUTH:JSON.stringify({"https://accounts.x.ai/sign-in":{key:"grok-fixture-key",email:"grok@example.test"}})},
    home:"/home/fixture",joinPath:(...parts)=>parts.join("/"),readText:async()=>null,
    fetchImpl:async url=>{billingReads.push(url);return Response.json(billing)},
  })});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"grok",agentRuntimeInstanceId:"grok-default",agentRuntimeReady:true,appServerReady:false,wsUrl:"",cwd:process.cwd(),platform:"win32",version:"grok-unused-period",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"grok",agentRuntimeInstanceId:"grok-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}}));
  await page.route(/\/api\/agent-runtime-usage(?:\?.*)?$/,async route=>json(route,await serverRead()));
  await page.route(/\/api\/models$/,route=>json(route,{models:["grok-4.7"],metadata:{provider:"grok",models:[{id:"grok-4.7",name:"Grok 4.7",provider:"grok",agent:"Grok Build"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/environments$/,route=>json(route,{profiles:[],activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/usage(?:\?.*)?$/,route=>json(route,{records:[],total:{},models:{},runtimes:{},daily:{}}));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");await page.getByRole("button",{name:"Usage",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();
  const card=page.getByTestId("runtime-account-usage"),meter=card.locator(".codex-limit-card"),refresh=page.locator(".usage-toolbar .usage-refresh");
  const nothingMetered=card.getByText("Nothing is metered for this account in the current period yet.",{exact:true});
  await expect(card).toContainText("Grok Build subscription limits");await expect(card).toContainText("grok@example.test");
  // The period's meter, at 0% with the period's end as its reset, where the card used to say only that nothing is metered.
  const resets=await page.evaluate(iso=>new Date(iso).toLocaleString(),new Date(end).toISOString());
  await expect(meter).toHaveCount(1);
  await expect(meter.locator("strong").first()).toHaveText("Weekly");await expect(meter.locator("span").first()).toHaveText("weekly");
  await expect(meter.locator(".limit-window strong")).toHaveText("0% used");
  await expect(meter.locator(".limit-window small")).toHaveText(`100% left · resets ${resets}`);
  await expect(nothingMetered).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({animations:"disabled",path:auditDir+"usage-grok-unused-period-1280x800.png",fullPage:false});
  await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
  await page.screenshot({animations:"disabled",path:auditDir+"usage-grok-unused-period-light-1280x800.png",fullPage:false});
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
  // A period Grok sends without its start is no whole period: Refresh shows no meter, and the card says nothing is metered yet.
  billing={config:{currentPeriod:{type:"USAGE_PERIOD_TYPE_WEEKLY",end}}};
  await refresh.click();await expect(refresh).toHaveText("Refresh");
  await expect(nothingMetered).toBeVisible();await expect(meter).toHaveCount(0);
  expect(billingReads).toEqual(["https://cli-chat-proxy.grok.com/v1/billing?format=credits","https://cli-chat-proxy.grok.com/v1/billing?format=credits"]);
});
