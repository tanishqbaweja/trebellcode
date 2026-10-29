import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readAgentRuntimeUsage } from "../../src/agent-usage-limits.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/polish/harness-usage/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// Cursor's, Grok Build's and OpenCode Go's usage would be read with the sign-in each harness keeps for itself (its stored login, or a
// token in the environment), which Trebell never reads or copies: the Usage page's subscription limits card for each says so in
// Trebell's words, with no meter, from what Trebell's server answers for the active profile (readAgentRuntimeUsage from src/, as
// /api/agent-runtime-usage answers it). The server function reads no file, no variable and no network: it is given none.
const HARNESSES=[["grok","Grok Build"],["cursor","Cursor"],["opencode","OpenCode"]];
for(const [kind,name] of HARNESSES)test(`the Usage page says ${name} does not report its usage to Trebell, with no meter`,async({page})=>{
  test.setTimeout(40_000);
  const reads=[];
  const serverRead=async()=>{const answer=await readAgentRuntimeUsage(kind,{name});reads.push(answer);return {runtime:kind,instanceId:kind+"-default",environmentId:null,...answer}};
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:kind,agentRuntimeInstanceId:kind+"-default",agentRuntimeReady:true,appServerReady:false,wsUrl:"",cwd:process.cwd(),platform:"win32",version:"harness-usage-unreported",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:kind,agentRuntimeInstanceId:kind+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}}));
  await page.route(/\/api\/agent-runtime-usage(?:\?.*)?$/,async route=>json(route,await serverRead()));
  await page.route(/\/api\/models$/,route=>json(route,{models:["fixture-model"],metadata:{provider:kind,models:[{id:"fixture-model",name:"Fixture model",provider:kind,agent:name}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/environments$/,route=>json(route,{profiles:[],activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/usage(?:\?.*)?$/,route=>json(route,{records:[],total:{},models:{},runtimes:{},daily:{}}));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");await page.getByRole("button",{name:"Usage",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();
  const card=page.getByTestId("runtime-account-usage");
  await expect(card).toContainText(`${name} subscription limits`);
  await expect(card).toContainText(`${name} does not report its usage to Trebell Code, which never reads the sign-in ${name} keeps.`);
  await expect(card.locator(".codex-limit-card")).toHaveCount(0);
  await expect(card).not.toContainText("Nothing is metered for this account");
  expect(reads.length).toBeGreaterThan(0);
  for(const answer of reads){expect(answer.windows).toEqual([]);expect(answer.unavailable.reason).toBe("unsupported");expect(answer.account).toBeUndefined()}
  // Refresh asks again and still shows no meter.
  const refresh=page.locator(".usage-toolbar .usage-refresh");
  const before=reads.length;await refresh.click();await expect(refresh).toHaveText("Refresh");
  await expect.poll(()=>reads.length).toBeGreaterThan(before);
  await expect(card.locator(".codex-limit-card")).toHaveCount(0);
  if(kind==="grok"){
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"usage-grok-unreported-dark-1280x800.png"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"usage-grok-unreported-light-1280x800.png"});
  }
});
