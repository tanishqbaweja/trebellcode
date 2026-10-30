import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { chmod,mkdir,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { keepThreadMeta } from "./test-home.js";

// Muse Code's work as the person meets it in Trebell: a subagent's row and the todo list as the turn's plan while the turn runs, the
// composer's context meter, a workflow's agents in the turn that launched it with Muse's report on it as a turn of its own, and an
// MCP server saved in Settings for Muse Code reaching its session beside Trebell's repository tools. Behind the page run the real
// agent relay and runtime manager on the stand-in Muse Code (tests/fixtures/muse/fake-muse.cjs), which runs its subagent and its
// workflow as the recorded Muse sessions do and records what Trebell sends it.
const auditDir=fileURLToPath(new URL("../../visual-audit/muse-sessions/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const FAKE_MUSE=fileURLToPath(new URL("../../tests/fixtures/muse/fake-muse.cjs",import.meta.url));
const MODEL_LIST=fileURLToPath(new URL("../../tests/fixtures/muse/model-list-1.4.13.json",import.meta.url));
const windows=process.platform==="win32";
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The status checks run the stand-in only: every other harness answers as not installed, so nothing installed here is started.
function onlyMuse(launcher){
  return (command,args=[],{env,cwd,timeoutMs=6000}={})=>new Promise(resolve=>{
    if(command!==launcher)return resolve({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
    const child=spawn(command,args,{env,cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout+=chunk});child.stderr.on("data",chunk=>{stderr+=chunk});
    const timer=setTimeout(()=>child.kill(),timeoutMs);
    child.once("error",error=>{clearTimeout(timer);resolve({ok:false,code:null,error:error.message,stdout,stderr})});
    child.once("close",code=>{clearTimeout(timer);resolve({ok:code===0,code,error:null,stdout,stderr})});
  });
}
// environment: the stand-in's switches, as the Muse Code profile's own variables. holds: what the stand-in waits to do until the test
// has seen what it checks (release). The relay has a context engine, so each thread with a project gets Trebell's repository tools,
// as the app's does.
async function startMuseHarness({environment={},holds=[]}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-sessions-")),repo=join(root,"muse-repo"),log=join(root,"muse.log");await mkdir(repo,{recursive:true});
  const held=Object.fromEntries(holds.map(name=>[name,join(root,`release-${name}`)]));
  const folder=windows?join(root,"AppData","Local","Programs","muse"):join(root,"home",".local","bin");await mkdir(folder,{recursive:true});
  const launcher=join(folder,windows?"muse.cmd":"muse");
  await writeFile(launcher,windows?`@echo off\r\nsetlocal\r\n"${process.execPath}" "${FAKE_MUSE}" %*\r\nexit /b %ERRORLEVEL%\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${FAKE_MUSE}" "$@"\n`);
  if(!windows)await chmod(launcher,0o755);
  const switches={MUSE_FAKE_LOG:log,MUSE_FAKE_MODELS:MODEL_LIST,...environment,...Object.fromEntries(holds.map(name=>[`MUSE_FAKE_${name.toUpperCase()}_HOLD`,held[name]]))};
  const settings={agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",activeEnvironmentId:null,mcpServers:[],agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,binaryPath:null,environment:switches}]},meta=new Map();
  const state={settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const env={...process.env,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"codex"),CLAUDE_CONFIG_DIR:join(root,"claude"),MUSE_INSTALL_DIR:"",...(windows?{LOCALAPPDATA:join(root,"AppData","Local")}:{HOME:join(root,"home")})};
  const runtimeManager=new AgentRuntimeManager({state,env,runFn:onlyMuse(launcher)}),threadStore=new AgentThreadStore(env);
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:{},version:"muse-sessions-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const frames=async method=>(await readFile(log,"utf8").catch(()=>"")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(entry=>entry.frame?.method===method).map(entry=>entry.frame);
  return {
    root,repo,settings,runtimeManager,threadStore,frames,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,release:name=>writeFile(held[name],""),
    async close(){await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})},
  };
}
// The app's endpoints for a window on Muse Code in Supervised, answered from the harness's runtime manager as the GUI server answers.
async function routeMuseApp(page,harness){
  const manager=harness.runtimeManager,status=await manager.probe("muse",{fresh:true}),listed=await manager.models("muse");
  const project={id:"muse-project",name:"Muse Project",path:harness.repo,environmentId:null,effectiveSettings:{}};
  const settings=Object.assign(harness.settings,{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"});
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",runtimeCapabilities:manager.capabilities("muse"),agentRuntimeReady:true,agentRuntimeStatus:status,provider:"openai",providerReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:harness.repo,platform:process.platform,version:"muse-sessions-fixture",activeEnvironment:null,activeEnvironmentId:null}));
  await page.route(/\/api\/runtime$/,async route=>json(route,{agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",agentRuntimeStatus:await manager.probe("muse"),provider:"openai",providerReady:true,appServerReady:true,appServerExitCode:null,activeEnvironment:null,appServerError:null,logs:[]}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[project],activeProjectId:project.id,threadMeta:{}}));
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,Object.assign(settings,route.request().postDataJSON()||{})):json(route,settings));
  await page.route(/\/api\/models$/,route=>json(route,{agentRuntime:"muse",ready:true,models:listed.models,defaultModel:listed.preferred||null,metadata:{provider:"muse",agentRuntime:"muse",source:listed.source,models:listed.metadata},error:listed.error||null}));
  await page.route(/\/api\/agent-runtimes$/,async route=>json(route,await manager.snapshot(route.request().method()==="GET"?{refresh:true}:{})));
  await page.route(/\/api\/providers$/,route=>json(route,{ready:true,providers:[]}));
  await page.route(/\/api\/terminal\/sessions(?:\?.*)?$/,route=>route.request().method()==="GET"?json(route,{sessions:[]}):route.fallback());
  await page.route(/\/api\/project-script\/runs(?:\?.*)?$/,route=>json(route,{runs:{}}));
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{project}:{projects:[project]}));
  await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
  await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:false,cwd:harness.repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]}));
  await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{id:"muse-checkpoint-"+Date.now(),threadId:null}:{checkpoints:[]}));
  await page.route(/\/api\/checkpoints\/link$/,route=>json(route,{ok:true}));
  await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"muse-context",skipped:true,budget:{reserveTokens:1024}}));
  await page.route(/\/api\/verification\/plan-turn$/,route=>json(route,{supported:false}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
}
async function switchMode(page,mode){
  const html=page.locator("html");if(await html.getAttribute("data-mode")===mode)return;
  await page.getByTestId("appearance-toggle").first().click();await expect(html).toHaveAttribute("data-mode",mode);
}
async function send(page,text){
  const composer=page.getByTestId("composer");
  await composer.click();await page.keyboard.type(text);await page.keyboard.press("Enter");
}
const reply=(page,text)=>page.locator(".history-assistant").filter({hasText:text});
// A step of an activity card by its title: a string is a part of it, a pattern the whole of it.
const row=(scope,title)=>scope.locator(".tool-event").filter({has:(scope.page?.()||scope).locator("summary strong",{hasText:title})});

test("a Muse Code subagent and its todo list show as the running turn's row and plan, and the composer's context meter shows what Muse's context holds of its window",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_SUBAGENT_MS:"6000"}});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Please spawn subagent and keep a todo list");
    // While the subagent runs: its row, titled by its role, and Muse's todo list as the plan, without the cancelled and blank steps.
    const live=page.locator(".agent-block .activity-card");
    await expect(row(live,"Subagent · hello agent")).toHaveClass(/status-running/,{timeout:20_000});
    await expect(row(live,"Spawn the hello agent")).toHaveClass(/status-running/);
    await expect(row(live,"Read its result")).toHaveClass(/status-pending/);
    await expect(live).not.toContainText("Discarded step");
    for(const mode of ["dark","light"]){await switchMode(page,mode);await live.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-subagent-running-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    // Its result is ready: the turn replies, the row is done, and the meter reads the context Muse reported of its window.
    await expect(reply(page,"Hello")).toBeVisible({timeout:20_000});
    await expect(row(page,"Subagent · hello agent")).toHaveClass(/status-done/);
    await expect(row(page,"Spawn the hello agent")).toHaveClass(/status-done/);
    const meter=page.locator(".composer-context");
    await expect(meter).toContainText("3% · 33,267/1,007,997");
    await expect(meter).toHaveAttribute("title","Context 3% · 33,267 input · 66,296 total");
    for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:auditDir+`muse-subagent-done-${mode}-1280x800.png`})}
  }finally{await harness.close()}
});

test("a Muse Code workflow's agents settle in the turn that launched it, and Muse's report on it comes as a turn of its own",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_WORKFLOW_MS:"500"},holds:["workflow"]});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Please run workflow ping-pong");
    await expect(reply(page,"Started the ping-pong workflow.")).toBeVisible({timeout:20_000});
    // The turn has ended and the workflow runs on, held after its first agent's scheduling: the workflow's row still runs, and that
    // agent, scheduled after the turn ended, comes in pending on the ended turn's card (the live card until another turn starts).
    // Soft, so that the old code also shows what each of the two rows says.
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:20_000});
    const live=page.locator(".agent-block .activity-card");
    await expect(row(live,"Workflow ping-pong")).toHaveCount(2,{timeout:20_000});
    await expect.soft(row(live,/^Workflow ping-pong$/),"the workflow, past the end of its turn").toHaveClass(/status-running/);
    await expect.soft(row(live,/^Workflow ping-pong · ping$/),"its agent, scheduled after the turn ended").toHaveClass(/status-pending/);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await live.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-workflow-runs-on-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    await harness.release("workflow");
    // Muse reports once the workflow is done, in a turn with no message of the person's.
    await expect(reply(page,"The workflow with ping and pong agents is complete.")).toBeVisible({timeout:20_000});
    await expect(page.locator(".user-row")).toHaveCount(1);
    const launched=page.locator(".turn-card").first().locator(".activity-card");
    if(await launched.getAttribute("data-state")!=="open")await launched.locator(".activity-card-head").click();
    await expect(row(launched,"Workflow ping-pong")).toHaveCount(3);
    await expect(row(launched,/^Workflow ping-pong$/)).toHaveClass(/status-done/);
    await expect(row(launched,/^Workflow ping-pong · ping$/)).toHaveClass(/status-done/);
    await expect(row(launched,/^Workflow ping-pong · pong: budget_exhausted$/)).toHaveClass(/status-error/);
    // The report turn has no steps of the workflow's.
    await expect(page.locator(".activity-card").filter({hasText:"Workflow ping-pong"})).toHaveCount(1);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await launched.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-workflow-report-${mode}-1280x800.png`})}
  }finally{await harness.close()}
});

test("Muse Code's report on a workflow lists none of the launching turn's steps, whose card keeps the repository context its message was sent with",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_WORKFLOW_MS:"500"}});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Please run workflow ping-pong");
    await expect(reply(page,"Started the ping-pong workflow.")).toBeVisible({timeout:20_000});
    const context=row(page,"Trebell context skipped");
    await expect(context).toHaveCount(1);
    // Muse reports once the workflow is done, in a turn with no message of the person's.
    await expect(reply(page,"The workflow with ping and pong agents is complete.")).toBeVisible({timeout:20_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:20_000});
    const [thread]=harness.threadStore.list(),[launchedTurn,reportTurn]=harness.threadStore.get(thread.id).turns;
    expect(reportTurn,"the report is a turn of its own").toBeTruthy();
    const launched=page.locator(`[data-testid=activity-card][data-turn-id="${launchedTurn.id}"]`);
    await expect(launched).toHaveCount(1);
    if(await launched.getAttribute("data-state")!=="open")await launched.locator(".activity-card-head").click();
    // The context step reads once, first on the launching turn's card, with the workflow's steps after it; the report turn has none.
    await expect(context).toHaveCount(1);
    await expect(row(launched,"Trebell context skipped")).toHaveCount(1);
    await expect(launched.locator(".tool-event summary strong").first()).toHaveText(/^Trebell context skipped/);
    await expect(row(launched,"Workflow ping-pong")).toHaveCount(3);
    await expect(page.locator(".agent-block [data-testid=activity-card]"),"no card of the report turn's").toHaveCount(0);
    await expect(page.locator(`[data-testid=activity-card][data-turn-id="${reportTurn.id}"]`)).toHaveCount(0);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await launched.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-report-no-launching-steps-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    // Once the window is reloaded, the report turn still lists none of them.
    await page.reload();
    const listed=page.locator(".thread-row").filter({hasText:"Please run workflow ping-pong"});
    await listed.locator(".thread-main").click();await expect(listed).toHaveClass(/active/);
    await expect(reply(page,"The workflow with ping and pong agents is complete.")).toBeVisible({timeout:20_000});
    await expect(page.locator(`[data-testid=activity-card][data-turn-id="${reportTurn.id}"]`)).toHaveCount(0);
    await expect(page.locator(".agent-block [data-testid=activity-card]")).toHaveCount(0);
  }finally{await harness.close()}
});

test("a Muse Code workflow goes on in the card of the turn that launched it while the person's next message runs and after it ended, its agents coming and settling there and never on that message's card",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_WORKFLOW_MS:"300"},holds:["workflow","report_start"]});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Please run workflow ping-pong");
    await expect(reply(page,"Started the ping-pong workflow.")).toBeVisible({timeout:20_000});
    await expect(row(page.locator(".agent-block .activity-card"),"Workflow ping-pong")).toHaveCount(2,{timeout:20_000});
    // The next message's turn takes the live card; the launching turn's own card has the workflow as it is, still running. Soft, so
    // that the old code also shows what that card and the live card say at each step.
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:20_000});
    const [thread]=harness.threadStore.list(),launchedId=harness.threadStore.get(thread.id).turns[0].id;
    const launched=page.locator(`.turn-card[data-turn-id="${launchedId}"] [data-testid=activity-card]`);
    if(await launched.getAttribute("data-state")!=="open")await launched.locator(".activity-card-head").click();
    await expect.soft(row(launched,/^Workflow ping-pong$/),"the workflow on its turn's card").toHaveClass(/status-running/);
    await expect.soft(row(launched,/^Workflow ping-pong · ping$/),"its agent on its turn's card").toHaveClass(/status-pending/);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await launched.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-workflow-past-next-turn-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    // The workflow goes on with no turn running: its agents start, pong comes and fails on its budget, and the workflow ends, each on
    // the launching turn's card, before Muse starts its report; the live card, the next message's, lists none of it.
    await harness.release("workflow");
    await expect.soft(row(launched,"Workflow ping-pong · pong"),"the agent that came after the next turn, on the launching turn's card").toHaveClass(/status-error/,{timeout:20_000});
    await expect.soft(row(launched,/^Workflow ping-pong · ping$/)).toHaveClass(/status-done/);
    await expect.soft(row(launched,/^Workflow ping-pong$/)).toHaveClass(/status-done/);
    await expect.soft(page.locator(".agent-block").filter({hasText:"Workflow ping-pong"}),"none of it on the next message's card").toHaveCount(0);
    await expect.soft(page.locator(".activity-card").filter({hasText:"Workflow ping-pong"})).toHaveCount(1);
    await harness.release("report_start");
    await expect(reply(page,"The workflow with ping and pong agents is complete.")).toBeVisible({timeout:20_000});
    await expect(page.locator(".activity-card").filter({hasText:"Workflow ping-pong"})).toHaveCount(1);
    await expect(row(launched,"Workflow ping-pong")).toHaveCount(3);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await launched.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-workflow-settled-past-turns-${mode}-1280x800.png`})}
  }finally{await harness.close()}
});

test("a Muse Code workflow still running past its turn keeps running on that turn's card after the window is reloaded and the thread opened again, and settles there",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_WORKFLOW_MS:"300"},holds:["workflow"]});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Please run workflow ping-pong");
    await expect(reply(page,"Started the ping-pong workflow.")).toBeVisible({timeout:20_000});
    await expect(row(page.locator(".agent-block .activity-card"),"Workflow ping-pong")).toHaveCount(2,{timeout:20_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:20_000});
    // The window is reloaded while the workflow runs on, held after its first agent's scheduling, and the person opens the thread
    // again: its card is rebuilt from the thread's history. Soft, so that the old code also shows what each row says.
    await page.reload();
    const listed=page.locator(".thread-row").filter({hasText:"Please run workflow ping-pong"});
    await listed.locator(".thread-main").click();await expect(listed).toHaveClass(/active/);
    await expect(reply(page,"Started the ping-pong workflow.")).toBeVisible({timeout:20_000});
    const [stored]=harness.threadStore.list(),launchedId=harness.threadStore.get(stored.id).turns[0].id;
    const card=page.locator(`[data-testid=activity-card][data-turn-id="${launchedId}"]`);
    await expect(card).toHaveCount(1);
    if(await card.getAttribute("data-state")!=="open")await card.locator(".activity-card-head").click();
    await expect.soft(row(card,/^Workflow ping-pong$/),"the workflow, still running").toHaveClass(/status-running/);
    await expect.soft(row(card,/^Workflow ping-pong · ping$/),"its agent, still scheduled").toHaveClass(/status-pending/);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await card.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-workflow-runs-on-after-reload-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    // The workflow goes on and ends, its rows settling on that card, and Muse reports on it in a turn of its own.
    await harness.release("workflow");
    await expect(reply(page,"The workflow with ping and pong agents is complete.")).toBeVisible({timeout:20_000});
    if(await card.getAttribute("data-state")!=="open")await card.locator(".activity-card-head").click();
    await expect(row(card,/^Workflow ping-pong$/)).toHaveClass(/status-done/);
    await expect(row(card,/^Workflow ping-pong · ping$/)).toHaveClass(/status-done/);
    await expect(row(card,/^Workflow ping-pong · pong: budget_exhausted$/)).toHaveClass(/status-error/);
    await expect(page.locator(".tool-event").filter({hasText:"Workflow ping-pong"}),"on that card only").toHaveCount(3);
  }finally{await harness.close()}
});

test("a command Muse Code sends to the background reads running on its turn's card past that turn's end, after a reload and the next message, until Muse tells its end, then done there",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({holds:["background"]});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Please start the dev server in the background");
    await expect(reply(page,"The dev server runs in the background.")).toBeVisible({timeout:20_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:20_000});
    // Muse settles the call as it sends it to the background, and the dev server runs on until the test lets Muse tell its end. Soft,
    // so that the old code also shows what the row says at each step.
    const [thread]=harness.threadStore.list(),launchedId=harness.threadStore.get(thread.id).turns[0].id;
    const card=page.locator(`[data-testid=activity-card][data-turn-id="${launchedId}"]`),dev=row(card,/^npm run dev$/);
    const open=async()=>{if(await card.getAttribute("data-state")!=="open")await card.locator(".activity-card-head").click()};
    await expect(card).toHaveCount(1);await open();
    await expect.soft(dev,"the dev server runs on past its turn's end").toHaveClass(/status-running/);
    await expect.soft(dev.locator("summary em")).toHaveText("running");
    await dev.locator("summary").click();
    await expect(dev.locator(".tool-event-body")).toContainText("Running in the background.");
    for(const mode of ["dark","light"]){await switchMode(page,mode);await dev.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-background-command-runs-past-turn-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    // The window reloaded and the thread opened again: its card, rebuilt from the thread's history, has the command still running.
    await page.reload();
    const listed=page.locator(".thread-row").filter({hasText:"Please start the dev server in the background"});
    await listed.locator(".thread-main").click();await expect(listed).toHaveClass(/active/);
    await expect(reply(page,"The dev server runs in the background.")).toBeVisible({timeout:20_000});
    await expect(card).toHaveCount(1);await open();
    await expect.soft(dev,"still running after a reload").toHaveClass(/status-running/);
    // The person's next message runs and ends; the command still runs on its own turn's card, on no other.
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:20_000});
    await open();
    await expect.soft(dev,"still running past the next message").toHaveClass(/status-running/);
    // Muse tells the command's end: the row settles there, done with the command's last words.
    await harness.release("background");
    await expect(dev,"its end settles it").toHaveClass(/status-done/,{timeout:20_000});
    await expect(dev.locator("summary em")).toHaveText("done");
    if(!await dev.locator(".tool-event-body").count())await dev.locator("summary").click();
    await expect(dev.locator(".tool-event-body")).toContainText("Dev server stopped.");
    await expect(page.locator(".activity-card").filter({hasText:"npm run dev"}),"on that card only").toHaveCount(1);
    await expect(page.locator(".tool-event").filter({hasText:"npm run dev"})).toHaveCount(1);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await dev.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-background-command-ended-${mode}-1280x800.png`})}
  }finally{await harness.close()}
});

test("a command Muse Code's report still runs when the person's message takes the report over goes on running in the report's card past the report's end and settles there, never in that message's",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_REPORT_HOLD:"1",MUSE_FAKE_REPORT_COMMAND:"1"},holds:["report_command"]});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Please run workflow ping-pong");
    await expect(reply(page,"Started the ping-pong workflow.")).toBeVisible({timeout:20_000});
    // Muse reports on the finished workflow in a turn of its own, says its first sentence and runs `npm test`, and holds there.
    await expect(page.getByText("The workflow with ping and pong agents is complete.").first()).toBeVisible({timeout:20_000});
    const live=page.locator(".agent-block .activity-card");
    await expect(row(live,"npm test")).toHaveClass(/status-running/,{timeout:20_000});
    // A message from another window of the person's takes the report over (this window queues its own behind the running report):
    // the report's turn ends here while Muse still runs the command, which goes on until the test lets it end, and the message's turn
    // waits for Muse. Soft, so that the old code also shows what each card says.
    const [thread]=harness.threadStore.list(),other=new WebSocket(harness.wsUrl);
    const card=turn=>page.locator(`.turn-card[data-turn-id="${turn.id}"] [data-testid=activity-card]`);
    const open=async turn=>{if(await card(turn).count()&&await card(turn).getAttribute("data-state")!=="open")await card(turn).locator(".activity-card-head").click()};
    await new Promise((resolve,reject)=>{other.once("open",resolve);other.once("error",reject)});
    try{
      other.send(JSON.stringify({id:1,method:"turn/start",params:{threadId:thread.id,input:[{type:"text",text:"And one more thing"}]}}));
      await expect.poll(()=>{const turns=harness.threadStore.get(thread.id).turns;return turns.length===3&&turns[1].status!=="inProgress"},{message:"the report's turn ends in Trebell",timeout:20_000}).toBe(true);
      const ended=harness.threadStore.get(thread.id).turns[1];
      await expect(card(ended)).toHaveCount(1,{timeout:20_000});await open(ended);
      await expect.soft(row(card(ended),"npm test"),"the command, still running past the report's end, on the report's card").toHaveClass(/status-running/);
      for(const mode of ["dark","light"]){await switchMode(page,mode);await card(ended).scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-report-command-runs-past-report-${mode}-1280x800.png`})}
      await switchMode(page,"dark");
      // Muse ends the command, says the rest of the report, and runs the message.
      await harness.release("report_command");
      await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    }finally{other.close()}
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:20_000});
    const [,report,message]=harness.threadStore.get(thread.id).turns;
    for(const turn of [report,message])await open(turn);
    await expect.soft(row(card(report),"npm test"),"the command settled on the report's card").toHaveClass(/status-done/);
    await expect.soft(page.locator(".activity-card").filter({hasText:"npm test"}),"and on no other card").toHaveCount(1);
    await expect.soft(row(page.locator(".agent-block .activity-card"),"npm test"),"none of it on the message's card").toHaveCount(0);
    await expect(row(card(report),"npm test")).toHaveCount(1);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await card(report).scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-report-command-taken-over-${mode}-1280x800.png`})}
  }finally{await harness.close()}
});

test("Settings lists MCP servers for Muse Code, and one saved there reaches Muse's session as an optional server beside Trebell's repository tools",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness();
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.locator(".settings-nav").getByRole("button",{name:/Agents & models/}).click();
    const card=page.locator('[data-setting-target="agents-mcp"]');await expect(card).toBeVisible();
    await card.getByRole("button",{name:"Add MCP server",exact:true}).click();
    await card.getByLabel("MCP server name").click();await page.keyboard.type("Docs tools");
    await card.getByLabel("MCP server executable").click();await page.keyboard.type("docs-mcp");
    await card.getByLabel("MCP server arguments").click();await page.keyboard.type("--stdio");
    await card.getByRole("button",{name:"Save MCP server",exact:true}).click();
    await expect(card).toContainText("Docs tools");
    await expect(card).toContainText("docs-mcp · --stdio");
    for(const mode of ["dark","light"]){await switchMode(page,mode);await card.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-mcp-settings-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    await page.goto("/");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    const [start]=await harness.frames("session/start");
    expect(Object.keys(start.params.config.mcpServers).sort()).toEqual(["Docs tools","trebell_repository"]);
    expect(start.params.config.mcpServers["Docs tools"]).toEqual({transport:"stdio",command:"docs-mcp",args:["--stdio"],env:{},mode:"optional"});
    expect(start.params.config.mcpServers.trebell_repository).toMatchObject({transport:"stdio",command:process.execPath,mode:"optional"});
  }finally{await harness.close()}
});
