import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { createClaudeCapabilitiesCache,probeClaudeCapabilities } from "../../src/claude-capabilities.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";
import { routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// Claude Code's plan usage on the Usage page as a person reads it. The page's read is answered as the server answers it, by its own
// runtime manager, capability cache and probe, with Claude Code's SDK scripted: claude.next is what the next probe of it answers,
// and its CLI's own checks stubbed (claude.loggedIn is what `claude auth status` says). A read that failed, came without data or
// found the account signed out is read again at the next Refresh, a signed-out Claude Code says so and how to sign in, and a Team
// or Enterprise monthly spend limit shows as its own row.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const SIGNED_IN={email:"person@example.test",subscriptionType:"enterprise",tokenSource:"claude.ai"};
// What Claude Code answers signed out: tokenSource "none" with no account, and no plan limits.
const SIGNED_OUT={tokenSource:"none",apiProvider:"firstParty"};
const NO_PLAN={session:{},rate_limits_available:false,rate_limits:null};
const inHours=hours=>new Date(Date.now()+hours*3600_000).toISOString();
// An Enterprise seat: a session window and $46.31 of a $500.00 monthly spend limit.
const enterprise=()=>({session:{},rate_limits_available:true,rate_limits:{
  five_hour:{utilization:12,resets_at:inHours(3)},seven_day:null,
  spend:{enabled:true,used:{amount_minor:4_631,currency:"USD",exponent:2},limit:{amount_minor:50_000,currency:"USD",exponent:2},percent:9},
  extra_usage:{is_enabled:true,used_credits:4_631,monthly_limit:50_000,utilization:9.26,currency:"USD"},
}});
const COULD_NOT_READ="Claude Code could not read usage limits.";
const NOT_EXPOSED="This runtime/account does not expose subscription limits to Trebell.";
// What the card says of a Claude Code that answered signed out: that it is, and how to sign in again.
const SIGNED_OUT_SAID="Claude Code is signed out. Use Sign in under Claude Code in Settings → Agents & models, or run claude auth login, then press Refresh.";

// The Usage page on a Claude Code window. Its subscription limits read is answered as gui-server.mjs answers
// /api/agent-runtime-usage, from a runtime manager whose Claude Code is the scripted one.
async function openClaudeUsage(page){
  const home=await mkdtemp(join(tmpdir(),"trebell-claude-plan-usage-"));
  const {ANTHROPIC_BASE_URL:_endpoint,...processEnv}=process.env;
  const env={...processEnv,TREBELL_HOME:home,CLAUDE_CONFIG_DIR:join(home,"claude")},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",activeEnvironmentId:null,agentRuntimeInstances:[{id:"claude-default",kind:"claude",displayName:"Claude Code",enabled:true,binaryPath:"claude"}]});
  const claude={next:null,probes:0,loggedIn:true};
  const query=()=>{
    const reply=claude.next;claude.probes++;
    return {
      initializationResult:async()=>({models:[{value:"default",displayName:"Default"}],commands:[],agents:[],account:reply.account}),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async()=>{if(reply.usageError)throw new Error(reply.usageError);return reply.usage},
      close(){},
    };
  };
  const cache=createClaudeCapabilitiesCache({probe:input=>probeClaudeCapabilities({...input,query,managedMcpExists:()=>false})});
  // `claude --version` and `claude auth status`, as the recheck after a failed turn runs them: no Claude Code is started.
  const runFn=async(_command,args)=>args[0]==="--version"?{ok:true,code:0,error:null,stdout:"2.1.311 (Claude Code)\n",stderr:""}
    :{ok:claude.loggedIn,code:claude.loggedIn?0:1,error:null,stdout:JSON.stringify({loggedIn:claude.loggedIn,authMethod:claude.loggedIn?"claude.ai":"none",apiProvider:"firstParty"}),stderr:""};
  const manager=new AgentRuntimeManager({state,env,claudeCapabilitiesCache:cache,runFn,fetchImpl:async url=>{throw new Error("fetched "+url)}});
  const relay=await startClaudeRelay({turn:async()=>{}});
  const reply=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await routeClaudeApp(page,relay);
  await page.route(/\/api\/usage(?:\?.*)?$/,route=>reply(route,{records:[],total:{},models:{},runtimes:{},daily:{}}));
  await page.route(/\/api\/environments$/,route=>reply(route,{profiles:[],activeEnvironmentId:null,activeEnvironment:null}));
  // reads counts the page's reads answered; claude.probes the times Claude Code was asked.
  const usage={claude,reads:0};
  await page.route(/\/api\/agent-runtime-usage(?:\?.*)?$/,async route=>{
    const instance=manager.activeInstance(),limits=await manager.usageLimits(instance);usage.reads++;
    await reply(route,{runtime:instance.kind,instanceId:instance.id,environmentId:null,...limits});
  });
  return Object.assign(usage,{
    manager,
    async open(){
      await page.goto("/");await page.getByRole("button",{name:"Usage",exact:true}).click();
      await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();
    },
    async close(){await relay.close();await rm(home,{recursive:true,force:true,maxRetries:8,retryDelay:100})},
  });
}
// Presses Refresh and waits until the page's subscription limits read is answered and the button is back.
async function refreshUsage(page){
  const refresh=page.locator(".usage-toolbar .usage-refresh");
  await Promise.all([page.waitForResponse(response=>/\/api\/agent-runtime-usage(?:\?|$)/.test(response.url())),refresh.click()]);
  await expect(refresh).toHaveText("Refresh");
}
async function shoot(page,card,name){
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({animations:"disabled",path:`${auditDir}${name}-dark-1280x800.png`});
  await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light");
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({animations:"disabled",path:`${auditDir}${name}-light-1280x800.png`});
  await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
}

test("a Claude Code account signed out at first shows its plan's windows and Monthly spend at the first Refresh after signing in",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const usage=await openClaudeUsage(page);
  try{
    usage.claude.next={account:SIGNED_OUT,usage:NO_PLAN};
    await usage.open();
    const card=page.getByTestId("runtime-account-usage");
    await expect(card).toContainText("Claude Code subscription limits");
    // It says Claude Code is signed out and how to sign in, not that the account has no limits to show.
    await expect(card.locator("p"),"a signed-out Claude Code reads as an account without limits").toHaveText(SIGNED_OUT_SAID,{timeout:15_000});
    await expect(card.getByText(NOT_EXPOSED,{exact:true})).toHaveCount(0);
    expect(usage.claude.probes,"each read of a signed-out account asks Claude Code").toBe(usage.reads);
    // The person signs in to Claude Code in a terminal, comes back and presses Refresh.
    usage.claude.next={account:SIGNED_IN,usage:enterprise()};
    await refreshUsage(page);
    const rows=card.locator(".codex-limit-card");
    await expect(rows.filter({hasText:"Session"})).toContainText("12% used");
    await expect(rows.filter({hasText:"Monthly spend"})).toContainText("9.3% used");
    await expect(rows.filter({hasText:"Monthly spend"})).toContainText("monthly");
    await expect(rows).toHaveCount(2);
    await expect(card.getByText(SIGNED_OUT_SAID,{exact:true})).toHaveCount(0);
    expect(usage.claude.probes).toBe(usage.reads);
    await shoot(page,card,"claude-plan-usage-monthly-spend");
  }finally{await usage.close()}
});

test("a Claude Code signed out while its plan shows says so, and how to sign in, at the Refresh after a failed turn finds it",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const usage=await openClaudeUsage(page);
  try{
    usage.claude.next={account:SIGNED_IN,usage:enterprise()};
    await usage.open();
    const card=page.getByTestId("runtime-account-usage"),rows=card.locator(".codex-limit-card");
    await expect(rows.filter({hasText:"Session"})).toContainText("12% used",{timeout:15_000});
    // The person signs out in a terminal (claude auth logout); a turn fails, and Trebell's recheck finds `claude auth status` signed out.
    usage.claude.loggedIn=false;usage.claude.next={account:SIGNED_OUT,usage:NO_PLAN};
    expect((await usage.manager.recheck("claude")).message).toBe("Claude Code is not authenticated. Run `claude auth login` and try again.");
    // Refresh from the keyboard.
    const refresh=page.locator(".usage-toolbar .usage-refresh");
    await refresh.focus();
    await Promise.all([page.waitForResponse(response=>/\/api\/agent-runtime-usage(?:\?|$)/.test(response.url())),page.keyboard.press("Enter")]);
    await expect(card.locator("p"),"a signed-out Claude Code reads as an account without limits").toHaveText(SIGNED_OUT_SAID);
    await expect(rows).toHaveCount(0);
    await expect(card.getByText(NOT_EXPOSED,{exact:true})).toHaveCount(0);
    await shoot(page,card,"claude-plan-usage-signed-out");
    // A narrow window wraps the sentence inside the card.
    await page.setViewportSize({width:700,height:800});
    await card.locator("p").scrollIntoViewIfNeeded();
    const fit=await card.evaluate(node=>{const p=node.querySelector("p"),box=node.getBoundingClientRect(),line=p.getBoundingClientRect();return {inside:line.left>=box.left-.5&&line.right<=box.right+.5,cut:p.scrollWidth>p.clientWidth+1,sideways:document.documentElement.scrollWidth>document.documentElement.clientWidth+1}});
    expect(fit).toEqual({inside:true,cut:false,sideways:false});
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-plan-usage-signed-out-dark-700x800.png`});
    await page.setViewportSize({width:1280,height:800});
    // Signed in again (Settings' Sign in, or claude auth login): the next Refresh shows the plan.
    usage.claude.loggedIn=true;usage.claude.next={account:SIGNED_IN,usage:enterprise()};
    await refreshUsage(page);
    await expect(rows.filter({hasText:"Session"})).toContainText("12% used");
    await expect(card.getByText(SIGNED_OUT_SAID,{exact:true})).toHaveCount(0);
  }finally{await usage.close()}
});

test("a Claude Code usage read that came without data or failed says it could not read them, and is read again at the next Refresh",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const usage=await openClaudeUsage(page);
  try{
    // Claude Code says the plan's limits apply but sends none of them.
    usage.claude.next={account:SIGNED_IN,usage:{session:{},rate_limits_available:true,rate_limits:null}};
    await usage.open();
    const card=page.getByTestId("runtime-account-usage"),rows=card.locator(".codex-limit-card");
    await expect(card.getByText(COULD_NOT_READ,{exact:true})).toBeVisible({timeout:15_000});
    await expect(card.getByText(NOT_EXPOSED,{exact:true})).toHaveCount(0);
    await shoot(page,card,"claude-plan-usage-could-not-read");
    // Its usage request then times out: asked again, it still says so.
    usage.claude.next={account:SIGNED_IN,usageError:"Claude Code did not report usage in time."};
    await refreshUsage(page);
    expect(usage.claude.probes,"each read after one that could not read asks Claude Code").toBe(usage.reads);
    await expect(card.getByText(COULD_NOT_READ,{exact:true})).toBeVisible();await expect(rows).toHaveCount(0);
    // The next Refresh reads them.
    usage.claude.next={account:SIGNED_IN,usage:{session:{},rate_limits_available:true,rate_limits:{five_hour:{utilization:30,resets_at:inHours(2)},seven_day:{utilization:41,resets_at:inHours(72)}}}};
    await refreshUsage(page);
    await expect(rows.filter({hasText:"Session"})).toContainText("30% used");
    await expect(rows.filter({hasText:"Weekly"})).toContainText("41% used");
    await expect(card.getByText(COULD_NOT_READ,{exact:true})).toHaveCount(0);
    expect(usage.claude.probes).toBe(usage.reads);
    // A read that has the plan's windows is kept: the next Refresh shows them without asking Claude Code again.
    const probes=usage.claude.probes;
    await refreshUsage(page);
    await expect(rows.filter({hasText:"Session"})).toContainText("30% used");
    expect(usage.claude.probes,"the kept read is reused").toBe(probes);expect(usage.reads).toBe(probes+1);
  }finally{await usage.close()}
});
