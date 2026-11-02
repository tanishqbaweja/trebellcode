import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";

// Prices a person saves for a model of Trebell Native's provider (Settings' Custom models card, drawn for Native too) give Native's
// turns an estimated cost on the Usage page and in the composer, each cached token charged once, at the cache price. The figures are
// the live check's turns on 2.1.3 (2026-11-02) at Meta's Contributor prices: $0.10 input, $0.002 cached and $0.20 output per million
// tokens, which price its Native turn at $0.00114. No live model is called: the first test runs on the mock-mode server, the second
// on a relay of its own whose Native provider is a stand-in that answers with the live turn's usage.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const NATIVE_USAGE={totalTokens:43402,inputTokens:42232,cachedInputTokens:33845,cacheWriteInputTokens:0,outputTokens:1170,reasoningOutputTokens:149};
const MUSE_USAGE={totalTokens:273693,inputTokens:272402,cachedInputTokens:203942,cacheWriteInputTokens:0,outputTokens:1291,reasoningOutputTokens:456};
// Claude Code records its input without its cache reads and writes.
const CLAUDE_USAGE={totalTokens:32806,inputTokens:6,cachedInputTokens:30000,cacheWriteInputTokens:2000,outputTokens:800,reasoningOutputTokens:0};

// Waits for smooth scrolling (Settings reveals its target that way) to come to rest before a screenshot.
async function settle(page){
  await page.evaluate(()=>new Promise(resolve=>{
    const positions=()=>[...document.querySelectorAll("*")].map(node=>node.scrollTop).join(",");
    let last=positions(),still=0,frames=0;
    const tick=()=>{const now=positions();still=now===last?still+1:0;last=now;if(still>=6||++frames>180)resolve();else requestAnimationFrame(tick)};
    requestAnimationFrame(tick);
  }));
}
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

for(const mode of ["dark","light"])test(`a price saved in Settings for Native's Meta model gives Native's Meta turns their cost on the Usage page, which names each harness of a model (${mode})`,async({page,request})=>{
  test.setTimeout(90_000);
  expect((await request.post("/api/providers",{data:{provider:"meta",apiKey:"meta-fixture-key"}})).ok()).toBe(true);
  await request.post("/api/settings",{data:{onboardingComplete:true,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"meta",appearance:"dark",appearanceMode:mode,panelAnimationMs:0,customModels:[]}});
  try{
    await page.setViewportSize({width:1280,height:900});
    await page.goto("/");
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    // The harness card names Grok Build by its name.
    const harnesses=page.locator(".settings-card").filter({hasText:"Choose the coding-agent runtime."});
    await expect(harnesses).toContainText("Cursor, Grok Build, Antigravity and Muse Code run as their real harnesses.");
    await harnesses.locator("p").first().scrollIntoViewIfNeeded();await settle(page);
    await page.screenshot({animations:"disabled",path:auditDir+`native-model-prices-harness-intro-${mode}-1280.png`});
    const card=page.locator('[data-setting-target="agents-models"]');
    await expect(card.getByRole("heading",{name:"Custom models"})).toBeVisible();
    await expect(card).toContainText("Prices for Meta Model API models, in USD per million tokens, give Trebell Native's turns on them an estimated cost on the Usage page and in the composer.");
    await card.getByRole("button",{name:"Add a model by ID"}).click();
    // The provider's listed models are offered to pick from.
    await expect(card.locator("datalist#custom-model-ids option")).toHaveCount(2);
    expect(await card.locator("datalist#custom-model-ids option").evaluateAll(options=>options.map(option=>option.value))).toEqual(["muse-spark-1.3","muse-wonder-1.0"]);
    await card.getByLabel("Model ID").fill("muse-spark-1.3");
    await card.getByLabel("Input / 1M").fill("0.10");
    await card.getByLabel("Output / 1M").fill("0.20");
    await card.getByLabel("Cache read / 1M").fill("0.002");
    await card.scrollIntoViewIfNeeded();await settle(page);
    await page.screenshot({animations:"disabled",path:auditDir+`native-model-prices-editor-${mode}-1280.png`});
    await card.getByRole("button",{name:"Save custom model"}).click();
    await expect(card.getByRole("status")).toHaveText("Custom model saved.");
    await expect(card.locator(".custom-model-list")).toContainText("muse-spark-1.3");
    const saved=(await (await request.get("/api/state")).json()).settings.customModels;
    expect(saved).toHaveLength(1);expect(saved[0]).toMatchObject({id:"muse-spark-1.3",runtime:"native",provider:"meta",inputPrice:0.1,outputPrice:0.2,cacheReadPrice:0.002,cacheWritePrice:null});
    await card.scrollIntoViewIfNeeded();await settle(page);
    await page.screenshot({animations:"disabled",path:auditDir+`native-model-prices-settings-${mode}-1280.png`});

    // The priced model is listed once, as the provider lists it, not as a custom one.
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    const picker=page.getByTestId("model-picker");await expect(picker).toBeEnabled({timeout:15_000});
    await picker.click();
    const menu=page.locator(".model-picker-menu");await expect(menu).toBeVisible();
    await expect(menu.locator("> button strong")).toHaveText(["muse-spark-1.3","muse-wonder-1.0"]);
    expect(await menu.locator("> button small").allTextContents()).not.toContain("custom");
    await page.keyboard.press("Escape");

    // The Usage page: the Native turn on Meta and a Muse Code turn of the same model, and a Claude Code turn.
    const at=Date.now(),records=[
      {id:"muse:fixture",runtime:"muse",provider:"muse-default",model:"muse-spark-1.3",environmentId:null,threadId:"muse-thread",turnId:"muse-turn",at:at-1000,usage:MUSE_USAGE,cost:null},
      {id:"native:fixture",runtime:"native",provider:"meta",model:"muse-spark-1.3",environmentId:null,threadId:"native-thread",turnId:"native-turn",at,usage:NATIVE_USAGE,cost:null},
      {id:"claude:fixture",runtime:"claude",provider:"claude-default",model:"claude-fixture",environmentId:null,threadId:"claude-thread",turnId:"claude-turn",at:at-2000,usage:CLAUDE_USAGE,cost:null},
    ];
    const total={totalTokens:349901,inputTokens:314640,cachedInputTokens:267787,cacheWriteInputTokens:2000,outputTokens:3261,reasoningOutputTokens:605,costUsd:0,costKnown:0};
    await page.route(/\/api\/usage(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({days:30,records,total,models:{},runtimes:{},daily:{},storedTurns:3})}));
    await page.getByRole("button",{name:"Usage",exact:true}).click();
    const usage=page.locator(".usage-page");await expect(usage).toBeVisible();
    const row=text=>usage.locator(".usage-table > div").filter({hasText:text});
    await expect(row("Trebell Native")).toContainText("≈$0.0011");
    await expect(row("Muse Code")).toContainText("—");
    const summary=usage.locator(".usage-summary");
    await expect(summary.locator("> div").nth(3)).toContainText("$0.0011");
    await expect(summary.locator("> div").nth(3)).toContainText("0 provider · 1 estimated");
    // Input counts every input token once, the cached ones with it, whichever harness recorded them.
    await expect(summary.locator("> div").nth(1)).toContainText("347K");
    await expect(summary.locator("> div").nth(1)).toContainText("268K cache read · 2.0K cache write");
    // The Models card names the harness of each row: the one model on two harnesses is a row for each.
    const models=usage.locator(".usage-models > div");
    await expect(models).toHaveCount(3);
    await expect(models.nth(0)).toContainText("muse-spark-1.3");await expect(models.nth(0)).toContainText("Muse Code · 1 turn");await expect(models.nth(0)).toContainText("—");
    await expect(models.nth(1)).toContainText("muse-spark-1.3");await expect(models.nth(1)).toContainText("Trebell Native · 1 turn");await expect(models.nth(1)).toContainText("$0.0011");
    await expect(models.nth(2)).toContainText("claude-fixture");await expect(models.nth(2)).toContainText("Claude Code · 1 turn");
    const metrics=await usage.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await page.screenshot({animations:"disabled",path:auditDir+`native-model-prices-usage-${mode}-1280.png`,fullPage:true});
  }finally{
    await request.post("/api/settings",{data:{customModels:[],modelProvider:"openai"}});
    await request.post("/api/providers",{data:{provider:"meta",apiKey:""}});
  }
});

for(const mode of ["dark","light"])test(`the composer shows a Native Meta turn's cost at the saved prices, and the Usage page the same for the turn it recorded (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-prices-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const model="muse-spark-1.3-contributor",customModels=[{id:model,name:model,runtime:"native",provider:"meta",inputPrice:0.1,outputPrice:0.2,cacheReadPrice:0.002,cacheWritePrice:null}];
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"meta",activeEnvironmentId:null,customModels});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-prices-session",model,name:"Native prices",preview:"Native turn on Meta",
    providerMeta:{runtimeInstanceId:"native-default",modelProvider:"meta",permissionProfile:"read-only",projectless:false,environmentId:null}});
  const nativeProviderTurn=async request=>{
    if(request.metadata?.completionGate||request.responseJsonSchema?.name==="trebell_completion_gate")return {id:"native-prices-gate",provider:request.provider,model:request.model,text:JSON.stringify({status:"complete",progress:"uncertain",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"The reply answers the question."}),toolCalls:[],finishReason:"stop",usage:{}};
    return {id:"native-prices-reply",provider:request.provider,model:request.model,text:"Parsed four keys.",toolCalls:[],finishReason:"stop",usage:{...NATIVE_USAGE}};
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-prices-project",name:"Native Prices",path:repo,environmentId:null,effectiveSettings:{}};
  let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  const json=body=>({status:200,contentType:"application/json",body:JSON.stringify(body)});
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill(json({mock:false,provider:"meta",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})));
    await page.route(/\/api\/state$/,route=>route.fulfill(json({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:mode,panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"meta",defaultPermissionMode:"read-only",defaultWorkspaceMode:"current",followUpMode:"queue",customModels},projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}})));
    await page.route(/\/api\/models$/,route=>route.fulfill(json({provider:"meta",agentRuntime:"native",ready:true,models:[model],metadata:{provider:"meta",models:[{id:model,name:"Muse Spark 1.3 Contributor",provider:"meta",agent:"Trebell Native"}]}})));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill(json(route.request().method()==="POST"?{project}:{projects:[project]})));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill(json({ok:true})));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill(json({isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]})));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();uiMeta={...uiMeta,...(body?.patch||{})}}await route.fulfill(json(uiMeta))});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill(json(route.request().method()==="POST"?{id:"native-prices-checkpoint",threadId:thread.id}:{checkpoints:[]})));
    await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill(json({ok:true})));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill(json({id:"native-prices-packet",root:repo,task:"",generatedAt:Date.now(),tokenEstimate:0,maxTokens:0,injection:"",items:[],budget:{},stats:{}})));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill(json({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})));
    await page.route(/\/api\/environments$/,route=>route.fulfill(json({profiles:[],activeEnvironmentId:null,activeEnvironment:null})));
    // The Usage page reads what the relay recorded.
    await page.route(/\/api\/usage(?:\?.*)?$/,route=>route.fulfill(json(state.usage({days:30,limit:5000}))));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native prices"]')});
    await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    await page.getByTestId("composer").fill("How many keys does sample.env have?");
    await page.getByTestId("send").click();
    await expect(page.getByText("Parsed four keys.",{exact:true})).toBeVisible({timeout:15_000});
    const context=page.locator(".composer-context");
    await expect(context).toContainText("43,402 tokens · $0.0011",{timeout:10_000});
    await expect(context).toHaveAttribute("title","Tokens 43,402 · $0.0011");
    await page.screenshot({animations:"disabled",path:auditDir+`native-model-prices-composer-${mode}-1280.png`});
    await expect.poll(()=>state.usage({days:30,limit:5000}).records.length).toBe(1);
    expect(state.usage({days:30,limit:5000}).records[0]).toMatchObject({runtime:"native",provider:"meta",model,usage:{inputTokens:42232,cachedInputTokens:33845,outputTokens:1170}});
    await page.getByRole("button",{name:"Usage",exact:true}).click();
    const usage=page.locator(".usage-page");await expect(usage).toBeVisible();
    await expect(usage.locator(".usage-table > div").filter({hasText:"Trebell Native"})).toContainText("≈$0.0011");
    await expect(usage.locator(".usage-models > div")).toHaveCount(1);
    await expect(usage.locator(".usage-models > div").first()).toContainText("Trebell Native · 1 turn");
    await page.screenshot({animations:"disabled",path:auditDir+`native-model-prices-recorded-usage-${mode}-1280.png`});
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

// Muse Code on the Meta key it shares with Native: its Usage card says the account has no subscription limits to show, as Claude
// Code's says on an API key, where it said Muse Code had not reported its windows yet. The page's subscription limits read is
// answered as gui-server.mjs answers /api/agent-runtime-usage, by a runtime manager of the test's own whose Muse Code profile runs
// on the Meta key, with a report a signed-in turn left in the store Muse Code's sessions keep (which it would show signed in).
for(const mode of ["dark","light"])test(`Usage says Muse Code on an API key has no subscription limits to show (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:mode,panelAnimationMs:0,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",modelProvider:"meta",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",
    agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,environment:{},auth:"api-key"}]};
  const manager=new AgentRuntimeManager({state:{settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch)},env:{PATH:""},
    providers:{keyFor:id=>id==="meta"?{key:"meta-fixture-key",source:"settings"}:null},
    runFn:async command=>{throw new Error("ran "+command)},fetchImpl:async url=>{throw new Error("fetched "+url)}});
  const now=Date.now();manager.museUsageReport=()=>({observedAtMs:now-60_000,tier:"tier-1",window:{usedPercent:3,windowDurationMins:300,resetsAtMs:now+3_600_000},weekly:{usedPercent:8,resetsAtMs:now+86_400_000}});
  const json=body=>({status:200,contentType:"application/json",body:JSON.stringify(body)}),reads=[];
  const record={id:"muse:fixture",runtime:"muse",provider:"muse-default",model:"muse-spark-1.3-contributor",environmentId:null,threadId:"muse-thread",turnId:"muse-turn",at:now,usage:MUSE_USAGE,cost:null};
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill(json({mock:true,provider:"meta",providerReady:true,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",agentRuntimeReady:true,appServerReady:false,wsUrl:"",cwd:process.cwd(),platform:"win32",version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})));
  await page.route(/\/api\/state$/,route=>route.fulfill(json({settings,projects:[],threadMeta:{}})));
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return route.fulfill(json(settings))});
  await page.route(/\/api\/agent-runtime-usage(?:\?.*)?$/,async route=>{const instance=manager.activeInstance(),usage=await manager.usageLimits(instance);reads.push(usage);await route.fulfill(json({runtime:instance.kind,instanceId:instance.id,environmentId:null,...usage}))});
  await page.route(/\/api\/models$/,route=>route.fulfill(json({models:["muse-spark-1.3-contributor"],metadata:{provider:"muse",models:[{id:"muse-spark-1.3-contributor",name:"Muse Spark 1.3 Contributor",provider:"muse",agent:"Muse Code"}]}})));
  await page.route(/\/api\/projects$/,route=>route.fulfill(json({projects:[]})));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill(json({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})));
  await page.route(/\/api\/recovery$/,route=>route.fulfill(json({enabled:false,items:[]})));
  await page.route(/\/api\/environments$/,route=>route.fulfill(json({profiles:[],activeEnvironmentId:null,activeEnvironment:null})));
  await page.route(/\/api\/usage(?:\?.*)?$/,route=>route.fulfill(json({days:30,records:[record],total:{...MUSE_USAGE},models:{},runtimes:{},daily:{},storedTurns:1})));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.getByRole("button",{name:"Usage",exact:true}).click();
  const card=page.getByTestId("runtime-account-usage");
  await expect(card.locator(".capability-card-head strong")).toHaveText("Muse Code subscription limits");
  await expect(card).toContainText("This runtime/account does not expose subscription limits to Trebell.");
  await expect(card).not.toContainText("has not reported its subscription windows");
  await expect(card.locator(".codex-limit-card")).toHaveCount(0);
  expect(reads.length).toBeGreaterThan(0);for(const read of reads)expect(read).toMatchObject({windows:[],unavailable:{reason:"unsupported"}});
  await page.screenshot({animations:"disabled",path:auditDir+`usage-muse-api-key-${mode}-1280.png`});
  // Signed in, the same report shows as its 5-hour and Weekly windows.
  settings.agentRuntimeInstances=[{...settings.agentRuntimeInstances[0],auth:"sign-in"}];
  expect((await manager.usageLimits(manager.activeInstance())).windows.map(row=>row.label)).toEqual(["5-hour","Weekly"]);
});
