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

// Claude Code's model list and its plan usage come from one probe. When the usage read fails and Claude Code then keeps timing out
// (a machine under load), the Usage card says it could not read the limits, but the composer still has Claude's models after a
// reload, from the probe that listed them, instead of "Claude Code could not list its models". The page's model list and usage reads
// are answered as gui-server.mjs answers them, by the server's own runtime manager, capability cache and probe, with only Claude
// Code's SDK scripted: answers[n] is what its n-th probe answers.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const SIGNED_IN={email:"person@example.test",subscriptionType:"max",tokenSource:"claude.ai"};
const SLOW={initError:"Claude Code did not report its capabilities in time."};

async function openThread(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}

test("after Claude Code's usage read failed and it keeps timing out, a reload still offers Claude's models while the Usage card says it could not read the limits",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const home=await mkdtemp(join(tmpdir(),"trebell-claude-models-usage-"));
  const {ANTHROPIC_BASE_URL:_endpoint,...processEnv}=process.env;
  const env={...processEnv,TREBELL_HOME:home,CLAUDE_CONFIG_DIR:join(home,"claude")},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",activeEnvironmentId:null,agentRuntimeInstances:[{id:"claude-default",kind:"claude",displayName:"Claude Code",enabled:true,binaryPath:"claude"}]});
  const answers=[{usageError:"Claude Code did not report usage in time."},SLOW,SLOW,SLOW,SLOW,SLOW],claude={probes:0};
  const query=()=>{
    const reply=answers[Math.min(claude.probes++,answers.length-1)];
    return {
      initializationResult:async()=>{if(reply.initError)throw new Error(reply.initError);return {models:[{value:"default",displayName:"Default (recommended)"},{value:"haiku",displayName:"Haiku"}],commands:[{name:"review",description:"Review the change"}],agents:[],account:SIGNED_IN}},
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async()=>{if(reply.usageError)throw new Error(reply.usageError);return reply.usage},
      close(){},
    };
  };
  const manager=new AgentRuntimeManager({state,env,claudeCapabilitiesCache:createClaudeCapabilitiesCache({probe:input=>probeClaudeCapabilities({...input,query,managedMcpExists:()=>false})})});
  manager.probe=async()=>({available:true,installed:true,authenticated:true});
  const harness=await startClaudeRelay({turn:async()=>{}});
  const reply=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  try{
    harness.seedThread("Parser fix");
    await routeClaudeApp(page,harness);
    await page.route(/\/api\/usage(?:\?.*)?$/,route=>reply(route,{records:[],total:{},models:{},runtimes:{},daily:{}}));
    await page.route(/\/api\/environments$/,route=>reply(route,{profiles:[],activeEnvironmentId:null,activeEnvironment:null}));
    // The model list as gui-server's selectedModelsPayload answers it for a Claude Code window.
    await page.route(/\/api\/models(?:\?.*)?$/,async route=>{
      const result=await manager.models(manager.activeInstance());
      await reply(route,{agentRuntime:"claude",ready:true,models:result.models||[],defaultModel:result.preferred||null,metadata:{provider:"claude",agentRuntime:"claude",source:result.source,models:result.metadata||[]},error:result.error||null,...(result.inventory?{inventory:result.inventory}:{})});
    });
    await page.route(/\/api\/agent-runtime-usage(?:\?.*)?$/,async route=>{
      const instance=manager.activeInstance(),limits=await manager.usageLimits(instance);
      await reply(route,{runtime:instance.kind,instanceId:instance.id,environmentId:null,...limits});
    });
    const picker=page.getByTestId("model-picker"),status=page.getByTestId("composer-model-status");

    await page.goto("/");await openThread(page,"Parser fix");
    await expect(picker).toContainText("Default (recommended)",{timeout:15_000});
    // The Usage card's read asks Claude Code again, which times out.
    await page.getByRole("button",{name:"Usage",exact:true}).click();
    const card=page.getByTestId("runtime-account-usage");
    await expect(card.getByText("Claude Code could not read usage limits.",{exact:true})).toBeVisible({timeout:15_000});
    const asked=claude.probes;
    // The person reloads the window and goes back to the thread.
    await page.reload();await openThread(page,"Parser fix");
    await expect.soft(picker,"Claude's models are still offered").toContainText("Default (recommended)",{timeout:15_000});
    await expect.soft(page.getByText(/Claude Code could not list its models/),"the list did not fail with the usage read").toHaveCount(0);
    expect.soft(claude.probes,"the model list asked Claude Code nothing more").toBe(asked);
    await expect(status).toHaveCount(0);
    await picker.click();
    await expect(page.locator(".model-picker-menu button").filter({hasText:"Haiku"})).toBeVisible();
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.keyboard.press("Escape");await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light");await picker.click()}
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-models-after-usage-failure-${mode}-1280x800.png`});
    }
  }finally{await harness.close();await rm(home,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
