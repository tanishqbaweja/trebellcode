import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { chmod,copyFile,mkdir,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { keepThreadMeta } from "./test-home.js";

// Muse Code's harder asks, as the person meets them in Trebell: a staged command whose card follows Muse to its next stage, a workflow
// child's card that Stop leaves waiting, a protected write a workflow child asks in Full access, a file Muse asks to read outside the
// workspace, a turn that could not run signed out, and a message sent in another mode while Muse compacts or writes its report on
// the work it finished. Behind the page run the real agent relay and runtime manager on the stand-in Muse Code
// (tests/fixtures/muse/fake-muse.cjs), which records what Trebell sends.
const auditDir=fileURLToPath(new URL("../../visual-audit/muse-request-cases/",import.meta.url));mkdirSync(auditDir,{recursive:true});
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
// has seen what it checks (release). The model list is a copy of the harness's own, which a test can take away (signOut) as a sign-out
// does. relayOptions: more of the relay's options (the repository knowledge a turn gathers its context from).
async function startMuseHarness({environment={},holds=[],relayOptions={}}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-request-cases-")),repo=join(root,"muse-repo"),log=join(root,"muse.log"),models=join(root,"model-list.json");
  await mkdir(repo,{recursive:true});await copyFile(MODEL_LIST,models);
  const held=Object.fromEntries(holds.map(name=>[name,join(root,`release-${name}`)]));
  const folder=windows?join(root,"AppData","Local","Programs","muse"):join(root,"home",".local","bin");await mkdir(folder,{recursive:true});
  const launcher=join(folder,windows?"muse.cmd":"muse");
  await writeFile(launcher,windows?`@echo off\r\nsetlocal\r\n"${process.execPath}" "${FAKE_MUSE}" %*\r\nexit /b %ERRORLEVEL%\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${FAKE_MUSE}" "$@"\n`);
  if(!windows)await chmod(launcher,0o755);
  const switches={MUSE_FAKE_LOG:log,MUSE_FAKE_MODELS:models,...environment,...Object.fromEntries(holds.map(name=>[`MUSE_FAKE_${name.toUpperCase()}_HOLD`,held[name]]))};
  const settings={agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",activeEnvironmentId:null,agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,binaryPath:null,environment:switches}]},meta=new Map();
  const state={settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const env={...process.env,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"codex"),CLAUDE_CONFIG_DIR:join(root,"claude"),MUSE_INSTALL_DIR:"",...(windows?{LOCALAPPDATA:join(root,"AppData","Local")}:{HOME:join(root,"home")})};
  const runtimeManager=new AgentRuntimeManager({state,env,runFn:onlyMuse(launcher)}),threadStore=new AgentThreadStore(env);
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,version:"muse-request-cases-fixture",...relayOptions});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const entries=async()=>(await readFile(log,"utf8").catch(()=>"")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  return {
    root,repo,runtimeManager,threadStore,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,release:name=>writeFile(held[name],""),signOut:()=>rm(models,{force:true}),
    frames:async method=>(await entries()).filter(entry=>entry.frame?.method===method).map(entry=>entry.frame),
    hosts:async()=>(await entries()).filter(entry=>entry.start&&entry.start[0]==="serve"&&!entry.start.includes("--no-session-log")).map(entry=>entry.start),
    async close(){await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})},
  };
}
// The app's endpoints for a window on Muse Code in the given access mode and follow-up mode, answered from the harness's runtime
// manager as the GUI server answers.
async function routeMuseApp(page,harness,{mode="supervised",followUpMode="queue"}={}){
  const manager=harness.runtimeManager,status=await manager.probe("muse",{fresh:true}),listed=await manager.models("muse");
  const project={id:"muse-project",name:"Muse Project",path:harness.repo,environmentId:null,effectiveSettings:{}};
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",modelProvider:"openai",defaultPermissionMode:mode,defaultWorkspaceMode:"current",followUpMode};
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",runtimeCapabilities:manager.capabilities("muse"),agentRuntimeReady:true,agentRuntimeStatus:status,provider:"openai",providerReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:harness.repo,platform:process.platform,version:"muse-request-cases-fixture",activeEnvironment:null,activeEnvironmentId:null}));
  await page.route(/\/api\/runtime$/,async route=>json(route,{agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",agentRuntimeStatus:await manager.probe("muse"),provider:"openai",providerReady:true,appServerReady:true,appServerExitCode:null,activeEnvironment:null,appServerError:null,logs:[]}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[project],activeProjectId:project.id,threadMeta:{}}));
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,Object.assign(settings,route.request().postDataJSON()||{})):json(route,settings));
  await page.route(/\/api\/models$/,route=>json(route,{agentRuntime:"muse",ready:true,models:listed.models,defaultModel:listed.preferred||null,metadata:{provider:"muse",agentRuntime:"muse",source:listed.source,models:listed.metadata},error:listed.error||null}));
  await page.route(/\/api\/agent-runtimes$/,async route=>json(route,await manager.snapshot(route.request().method()==="GET"?{refresh:true}:{})));
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
const shoot=async(page,name,target=null)=>{for(const mode of ["dark","light"]){await switchMode(page,mode);if(target)await target.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`${name}-${mode}-1280x800.png`})}await switchMode(page,"dark")};
async function openMuse(page,harness,options){await routeMuseApp(page,harness,options);await page.setViewportSize({width:1280,height:800});await page.goto("/")}
const card=page=>page.locator(".inline-approval .approval-card");
// A step of an activity card by its title: a string is a part of it, a pattern the whole of it.
const row=(scope,title)=>scope.locator(".tool-event").filter({has:(scope.page?.()||scope).locator("summary strong",{hasText:title})});

test("a staged command's card follows Muse to its next stage, with that stage's own choices, and the person's Always allow saves that stage's rule",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({holds:["stage"]});
  try{
    await openMuse(page,harness);
    await send(page,"Please run the staged approval");
    await expect(card(page)).toContainText("touch a.txt && rm b.txt",{timeout:20_000});
    await expect(card(page).locator(".approval-actions button")).toHaveText(["Allow once","Always allow in this workspace: touch ...","Reject"]);
    // The card names the stage its choices answer, the whole command under it.
    await expect(card(page).locator(".card-title strong")).toHaveText("Command needs approval");
    await expect(card(page).locator(":scope > p")).toHaveText("Stage 1 of 2: touch a.txt");
    await expect(card(page).getByTestId("approval-command")).toHaveText("touch a.txt && rm b.txt");
    await shoot(page,"muse-staged-first-stage",card(page));
    // Muse's reviewer moves the approval on to `rm b.txt`: the card shows that stage, its rule that keeps it out a choice of its own.
    await harness.release("stage");
    await expect(card(page).locator(".approval-actions button")).toHaveText(["Allow once","Always allow in this workspace: rm ...","Reject","Always reject in this workspace: rm ..."],{timeout:20_000});
    await expect(card(page).locator(":scope > p")).toHaveText("Stage 2 of 2: rm b.txt");
    await expect(card(page).getByTestId("approval-command")).toHaveText("touch a.txt && rm b.txt");
    await shoot(page,"muse-staged-next-stage",card(page));
    await card(page).getByRole("button",{name:"Always allow in this workspace: rm ...",exact:true}).click();
    await expect(reply(page,"STAGE DECIDED: allow_local_prefix_rm")).toBeVisible({timeout:20_000});
    await expect(card(page)).toHaveCount(0);
    expect((await harness.frames("approval/decide")).map(frame=>[frame.params.choiceId,frame.params.requirementId.sourceIndex])).toEqual([["allow_local_prefix_rm",1]]);
  }finally{await harness.close()}
});

test("Stop leaves a workflow child's approval card waiting, and the person's Allow once then reaches Muse",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness();
  try{
    await openMuse(page,harness);
    await send(page,"Please run the workflow whose child approval waits");
    await expect(card(page)).toBeVisible({timeout:20_000});
    const stop=page.getByRole("button",{name:"Stop",exact:true});
    await stop.click();
    await expect(stop).toHaveCount(0,{timeout:20_000});
    // The turn ended; the workflow's child still waits on the person, and its card says a workflow agent asks (this one names no agent
    // of a workflow Trebell was told of, nor one it follows past a turn that ended), with the command under it.
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator(".approval-actions button")).toHaveText(["Allow once","Always allow in this workspace: touch ...","Reject"]);
    await expect(card(page).locator(":scope > p")).toHaveText("Asked by a Muse Code workflow agent.");
    await expect(card(page).getByTestId("approval-command")).toHaveText("touch trebell-approved.txt");
    expect(await harness.frames("approval/decide")).toEqual([]);
    await shoot(page,"muse-child-card-after-stop",card(page));
    await card(page).getByRole("button",{name:"Allow once",exact:true}).click();
    await expect(card(page)).toHaveCount(0,{timeout:20_000});
    await expect.poll(async()=>(await harness.frames("approval/decide")).map(frame=>frame.params.choiceId)).toEqual(["allow_once"]);
  }finally{await harness.close()}
});

test("a workflow agent's approval card names the agent and says it runs on past the turn that started it, and Stop on the next message's turn leaves the card so while the agent runs on",async({page})=>{
  test.setTimeout(90_000);
  // The workflow runs on past its turn, held while its agent alpha runs, and alpha asks once the next message's turn runs.
  const harness=await startMuseHarness({environment:{MUSE_FAKE_WORKFLOW_MS:"40"},holds:["workflow_agent","child_ask"]});
  try{
    await openMuse(page,harness);
    await send(page,"Please run workflow alpha-beta");
    await expect(reply(page,"Started the alpha-beta workflow.")).toBeVisible({timeout:20_000});
    const stop=page.getByRole("button",{name:"Stop",exact:true});
    await expect(stop).toHaveCount(0,{timeout:20_000});
    await expect(row(page,/^Workflow alpha-beta · alpha$/)).toHaveClass(/status-running/,{timeout:20_000});
    await send(page,"Hello Muse, hold until steered");
    await expect(stop).toBeVisible({timeout:20_000});
    await harness.release("child_ask");
    const line="Asked by the workflow agent alpha, which runs on past the turn that started it.";
    await expect(card(page).locator(":scope > p")).toHaveText(line,{timeout:20_000});
    await expect(card(page).locator(".card-title strong")).toHaveText("Command needs approval");
    await expect(card(page).getByTestId("approval-command")).toHaveText("touch trebell-approved.txt");
    // Stop ends the message's turn; the card stays under it, still saying which agent asks, and that agent's row runs on in the card
    // of the turn that launched the workflow.
    await stop.click();
    await expect(stop).toHaveCount(0,{timeout:20_000});
    await expect(card(page).locator(":scope > p")).toHaveText(line);
    await expect(card(page).locator(".approval-actions button")).toHaveText(["Allow once","Always allow in this workspace: touch ...","Reject"]);
    expect(await harness.frames("approval/decide")).toEqual([]);
    const [thread]=harness.threadStore.list(),launchedId=harness.threadStore.get(thread.id).turns[0].id;
    const launched=page.locator(`.turn-card[data-turn-id="${launchedId}"] [data-testid=activity-card]`);
    if(await launched.getAttribute("data-state")!=="open")await launched.locator(".activity-card-head").click();
    await expect(row(launched,/^Workflow alpha-beta · alpha$/)).toHaveClass(/status-running/);
    await shoot(page,"muse-workflow-agent-card-after-stop",card(page));
    // In a narrow window the line wraps above the command.
    await page.setViewportSize({width:700,height:800});
    await card(page).scrollIntoViewIfNeeded();await expect(card(page)).toBeInViewport();
    await page.screenshot({animations:"disabled",path:auditDir+"muse-workflow-agent-card-after-stop-dark-700x800.png"});
    await page.setViewportSize({width:1280,height:800});
    await card(page).getByRole("button",{name:"Allow once",exact:true}).click();
    await expect(card(page)).toHaveCount(0,{timeout:20_000});
    await expect.poll(async()=>(await harness.frames("approval/decide")).map(frame=>frame.params.choiceId)).toEqual(["allow_once"]);
  }finally{await harness.close()}
});

test("a subagent's approval card names the subagent and not that it runs on past its turn, the desktop is told what it asks, and the card Stop leaves says the same while the subagent's row says it stopped with its turn",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness();
  try{
    // The desktop app's notifications, kept to read: the window tells it of an approval as it comes.
    await page.addInitScript(()=>{window.trebellDesktop={notify:note=>{(window.__trebellNotes||=[]).push(note)}}});
    await openMuse(page,harness);
    await send(page,"Please have the subagent approval wait");
    const line="Asked by the subagent counter.",stop=page.getByRole("button",{name:"Stop",exact:true});
    await expect(card(page).locator(":scope > p")).toHaveText(line,{timeout:20_000});
    await expect(card(page).locator(".card-title strong")).toHaveText("Command needs approval");
    await expect(card(page).getByTestId("approval-command")).toHaveText("touch trebell-approved.txt");
    await expect(stop,"the turn that waits on the subagent runs").toBeVisible();
    await expect.poll(()=>page.evaluate(()=>(window.__trebellNotes||[]).filter(note=>note.title==="Approval required").map(note=>note.body))).toEqual(["touch trebell-approved.txt"]);
    await shoot(page,"muse-subagent-card-while-its-turn-runs",card(page));
    // Stop ends the turn and the subagent with it; the card stays, saying what it said.
    await stop.click();
    await expect(stop).toHaveCount(0,{timeout:20_000});
    await expect(row(page,"Stopped with its turn")).toHaveCount(1,{timeout:20_000});
    await expect(card(page).locator(":scope > p")).toHaveText(line);
    expect(await harness.frames("approval/decide")).toEqual([]);
    await shoot(page,"muse-subagent-card-after-stop",card(page));
    await card(page).getByRole("button",{name:"Allow once",exact:true}).click();
    await expect(card(page)).toHaveCount(0,{timeout:20_000});
    await expect.poll(async()=>(await harness.frames("approval/decide")).map(frame=>frame.params.choiceId)).toEqual(["allow_once"]);
  }finally{await harness.close()}
});

test("in Full access a workflow child's protected write shows on the approval card, answered by the person and never for them",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness();
  try{
    await openMuse(page,harness,{mode:"full"});
    await expect(page.locator("select.permission-picker").first()).toHaveValue("full");
    await send(page,"Please have the protected child write its settings");
    await expect(card(page)).toContainText(".muse/settings.json",{timeout:20_000});
    await expect(card(page).locator(".approval-actions button")).toHaveText(["Allow once","Reject"]);
    // Titled for what it asks: a write to a protected file, which a workflow agent asks while the turn runs.
    await expect(card(page).locator(".card-title strong")).toHaveText("Write to a protected file needs approval");
    await expect(card(page).locator(":scope > p")).toHaveText("Asked by a Muse Code workflow agent.");
    await expect(card(page).getByTestId("approval-command")).toHaveText(".muse/settings.json");
    expect(await harness.frames("approval/decide")).toEqual([]);
    await shoot(page,"muse-protected-child-card",card(page));
    await card(page).getByRole("button",{name:"Reject",exact:true}).click();
    await expect(reply(page,"REJECTED")).toBeVisible({timeout:20_000});
    expect((await harness.frames("approval/decide")).map(frame=>frame.params.choiceId)).toEqual(["deny"]);
  }finally{await harness.close()}
});

test("a file Muse asks to read outside the workspace shows on the approval card with its path, and Allow once lets Muse read it",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness();
  try{
    await openMuse(page,harness);
    await send(page,"Please read outside the workspace");
    await expect(card(page)).toContainText("outside-notes.txt",{timeout:20_000});
    await expect(card(page).locator(".approval-actions button")).toHaveText(["Allow once","Reject"]);
    // Titled for what it asks: a read outside the workspace, of the file whose full path it shows.
    await expect(card(page).locator(".card-title strong")).toHaveText("Read outside the workspace needs approval");
    await expect(card(page).locator(":scope > p")).toHaveText(/^(?:[A-Za-z]:)?[\\/].*[\\/]outside-notes\.txt$/);
    await shoot(page,"muse-outside-read-card",card(page));
    await card(page).getByRole("button",{name:"Allow once",exact:true}).click();
    await expect(reply(page,"READ IT")).toBeVisible({timeout:20_000});
    expect((await harness.frames("approval/decide")).map(frame=>frame.params.choiceId)).toEqual(["allow_once"]);
  }finally{await harness.close()}
});

test("a turn Muse Code could not run signed out says once how to sign in",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness();
  try{
    await openMuse(page,harness);
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    // Signed out since: Muse lists no models any more, and the next turn cannot run.
    await harness.signOut();
    await send(page,"Now I am signed out");
    const failed=page.locator(".tool-event.kind-error").filter({hasText:"Muse Code is signed out"});
    await expect(failed.locator("summary strong")).toHaveText("Muse Code is signed out. Sign in with muse login, then send the message again.",{timeout:20_000});
    await expect(page.locator(".conversation-history")).not.toContainText("listed no models");
    await shoot(page,"muse-signed-out",failed);
  }finally{await harness.close()}
});

test("a message sent in Supervised while a Full access thread's compaction runs is not sent, saying to wait for it, keeps its draft and never runs on the Full access host",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_COMPACT:"hold"}});
  try{
    await openMuse(page,harness,{mode:"full"});
    await send(page,"First message");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await page.getByRole("button",{name:"Compact",exact:true}).click();
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    await page.locator("select.permission-picker").first().selectOption("supervised");
    await send(page,"Now in Supervised");
    const alert=page.getByTestId("composer-alert");
    // The refusal names no Stop: the compaction runs in no turn, and only the window that waits for it, as this one does, shows its
    // Stop in the header, which a reloaded window or another of the person's does not.
    await expect(alert).toHaveText("Not sent: Muse Code is still compacting this conversation, and this mode needs a new Muse Code host, which would stop the compaction. Wait for it to finish, or keep the current mode, then send the message again. Your draft is kept.",{timeout:20_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveAttribute("title","Stop the context compaction");
    await expect(page.getByTestId("composer")).toHaveValue("Now in Supervised");
    await expect(page.locator(".tool-event").filter({hasText:"Context compaction failed"})).toHaveCount(0);
    expect((await harness.frames("turn/start")).length).toBe(1);
    expect(await harness.hosts()).toEqual([["serve","--trust-workspace","--disable-sandbox"]]);
    await shoot(page,"muse-mode-change-while-compacting",alert);
  }finally{await harness.close()}
});

// Muse's report on the work it finished runs as a turn, which the window steers a message into: Enter or the Steer button with steer
// follow-ups, Send now or its shortcut on a queued follow-up. One in a mode the report's host was not launched for is not sent, as one
// sent while Muse compacts, and never goes into the report on that host; one in the report's own mode still does. A draft refused so
// stays in the composer; a queued follow-up refused so stays queued, as its note says in the queue's own words: it goes once the
// report ends, with nothing for the person to send again. The note goes once the follow-up leaves the queue, or a Stop holds it. Its
// words are checked soft, so that the old code also shows what Remove and Stop leave of it.
const REFUSED="Muse Code is still writing its report on the work it finished, and this mode needs a new Muse Code host, which would stop the report. Wait for it to finish (or stop it), or keep the current mode, then send the message again.";
const REPORT_NOT_SENT="Not sent: "+REFUSED+" Your draft is kept.",QUEUED_NOT_SENT="Queued follow-up not sent: Muse Code is still writing its report on the work it finished, and this mode needs a new Muse Code host, which would stop the report. It stays queued and goes once the report ends.";
test("a message steered in Supervised while Muse Code writes its report on a Full access thread is not sent, saying to wait for the report, keeps its draft and never reaches the Full access host, and back in Full access it steers into the report",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_REPORT_HOLD:"1"}});
  try{
    await openMuse(page,harness,{mode:"full",followUpMode:"steer"});
    await send(page,"Please run workflow alpha-beta");
    await expect(reply(page,"Started the alpha-beta workflow.")).toBeVisible({timeout:20_000});
    const live=page.locator(".agent-block .assistant-answer"),stop=page.getByRole("button",{name:"Stop",exact:true}),picker=page.locator("select.permission-picker").first();
    await expect(live).toContainText("The alpha and beta agents are done.",{timeout:20_000});
    await expect(stop).toHaveAttribute("title","Stop the running turn");
    await picker.selectOption("supervised");
    await send(page,"Ask before you run anything");
    const alert=page.getByTestId("composer-alert");
    await expect(alert).toHaveText(REPORT_NOT_SENT,{timeout:20_000});
    await expect(page.getByTestId("composer")).toHaveValue("Ask before you run anything");
    await expect(stop,"the report goes on").toBeVisible();
    await expect(page.locator(".tool-event").filter({hasText:"Could not steer the agent"})).toHaveCount(0);
    expect(await harness.frames("turn/steer")).toEqual([]);
    expect((await harness.frames("turn/start")).length).toBe(1);
    expect(await harness.hosts()).toEqual([["serve","--trust-workspace","--disable-sandbox"]]);
    await shoot(page,"muse-steer-mode-change-while-reporting",alert);
    // In a narrow window the note wraps beside the composer, the draft above it.
    await page.setViewportSize({width:700,height:800});
    await expect(alert).toBeInViewport();await expect(page.getByTestId("composer")).toBeInViewport();
    await page.screenshot({animations:"disabled",path:auditDir+"muse-steer-mode-change-while-reporting-dark-700x800.png"});
    await page.setViewportSize({width:1280,height:800});
    // Back in Full access, the report's own mode, the kept draft steers into the report, which ends with it.
    await picker.selectOption("full");
    await page.getByRole("button",{name:"Steer agent",exact:true}).click();
    await expect(reply(page,"Steered: Ask before you run anything.")).toBeVisible({timeout:20_000});
    await expect(alert).toHaveCount(0);
    await expect(page.getByTestId("composer")).toHaveValue("");
    expect((await harness.frames("turn/steer")).length).toBe(1);
    expect(await harness.hosts()).toEqual([["serve","--trust-workspace","--disable-sandbox"]]);
  }finally{await harness.close()}
});

test("a queued message sent now in Full access while Muse Code writes its report on a Supervised thread, by its shortcut or Send now, is not sent, saying to wait for the report, stays queued and never reaches the Supervised host, and after Stop it goes on a Full access host",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_REPORT_HOLD:"1"}});
  try{
    await openMuse(page,harness);
    await send(page,"Please run workflow alpha-beta");
    await expect(reply(page,"Started the alpha-beta workflow.")).toBeVisible({timeout:20_000});
    const live=page.locator(".agent-block .assistant-answer"),stop=page.getByRole("button",{name:"Stop",exact:true});
    await expect(live).toContainText("The alpha and beta agents are done.",{timeout:20_000});
    await page.locator("select.permission-picker").first().selectOption("full");
    await send(page,"Now in Full access");
    const queued=page.locator(".queued-message"),alert=page.getByTestId("composer-alert");
    await expect(queued.locator("p")).toHaveText(["Now in Full access"]);
    // The shortcut that sends the oldest queued follow-up now, from the composer.
    await page.keyboard.press("Control+Shift+Enter");
    await expect.soft(alert).toHaveText(QUEUED_NOT_SENT,{timeout:20_000});
    // The next message waits behind it, and its own Send now is refused alike.
    await send(page,"And run the tests");
    await expect(alert).toHaveCount(0);
    await expect(queued.locator("p")).toHaveText(["Now in Full access","And run the tests"]);
    await queued.filter({hasText:"And run the tests"}).getByRole("button",{name:"Send now"}).click();
    await expect.soft(alert).toHaveText(QUEUED_NOT_SENT,{timeout:20_000});
    await expect(queued.locator(":scope > span")).toHaveText(["Queued","Queued"]);
    await expect(page.getByTestId("app-action-error")).toHaveCount(0);
    await expect(stop,"the report goes on").toBeVisible();
    expect(await harness.frames("turn/steer")).toEqual([]);
    expect(await harness.hosts()).toEqual([["serve","--trust-workspace"]]);
    await shoot(page,"muse-send-now-mode-change-while-reporting",alert);
    // Stop ends the report and holds the queue, so the note that the follow-up goes once the report ends goes; Send now then starts
    // Muse Code for Full access, and the queue goes on after it.
    await stop.click();
    await expect(stop).toHaveCount(0,{timeout:20_000});
    await expect(queued.locator(":scope > span")).toHaveText(["Queued · held after Stop","Queued · held after Stop"]);
    await expect(alert,"the note goes with the hold").toHaveCount(0);
    await queued.filter({hasText:"Now in Full access"}).getByRole("button",{name:"Send now"}).click();
    await expect(queued).toHaveCount(0,{timeout:20_000});
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    expect((await harness.frames("turn/start")).length).toBe(3);
    expect(await harness.frames("turn/steer")).toEqual([]);
    expect(await harness.hosts()).toEqual([["serve","--trust-workspace"],["serve","--trust-workspace","--disable-sandbox"]]);
  }finally{await harness.close()}
});

test("a follow-up queued before the person picks Full access, sent now by its shortcut while Muse Code writes its report on a Supervised thread, is not sent, as its Send now is not, and never reaches the Supervised host",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_REPORT_HOLD:"1"}});
  try{
    await openMuse(page,harness);
    await send(page,"Please run workflow alpha-beta");
    await expect(reply(page,"Started the alpha-beta workflow.")).toBeVisible({timeout:20_000});
    const live=page.locator(".agent-block .assistant-answer"),stop=page.getByRole("button",{name:"Stop",exact:true});
    const queued=page.locator(".queued-message"),alert=page.getByTestId("composer-alert");
    await expect(live).toContainText("The alpha and beta agents are done.",{timeout:20_000});
    // The follow-up is queued in Supervised; Full access is picked after it, and nothing else changes before the shortcut is pressed.
    await send(page,"Now in Full access");
    await expect(queued.locator("p")).toHaveText(["Now in Full access"]);
    await page.locator("select.permission-picker").first().selectOption("full");
    await page.keyboard.press("Control+Shift+Enter");
    await expect.soft(alert).toHaveText(QUEUED_NOT_SENT,{timeout:20_000});
    await expect(queued.locator(":scope > span")).toHaveText(["Queued"]);
    expect(await harness.frames("turn/steer"),"nothing went into the report").toEqual([]);
    // Its Send now says the same.
    await page.getByTestId("composer").click();await page.keyboard.type("x");await page.keyboard.press("Backspace");
    await expect(alert).toHaveCount(0);
    await queued.getByRole("button",{name:"Send now"}).click();
    await expect.soft(alert).toHaveText(QUEUED_NOT_SENT,{timeout:20_000});
    await expect(stop,"the report goes on").toBeVisible();
    expect(await harness.frames("turn/steer")).toEqual([]);
    expect(await harness.hosts()).toEqual([["serve","--trust-workspace"]]);
    await shoot(page,"muse-shortcut-after-mode-pick-while-reporting",alert);
    // Remove takes the follow-up out of the queue, and the note about it goes with it.
    await queued.getByRole("button",{name:"Remove"}).click();
    await expect(queued).toHaveCount(0);
    await expect(alert,"no note is left about a follow-up the queue no longer has").toHaveCount(0);
  }finally{await harness.close()}
});

test("a follow-up whose Send now Muse Code's report refused goes by itself once the report ends, on a host of the mode picked, and the note that it was not sent goes as it goes",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_REPORT_HOLD:"1"},holds:["report_end"]});
  try{
    await openMuse(page,harness);
    await send(page,"Please run workflow alpha-beta");
    await expect(reply(page,"Started the alpha-beta workflow.")).toBeVisible({timeout:20_000});
    const live=page.locator(".agent-block .assistant-answer"),queued=page.locator(".queued-message"),alert=page.getByTestId("composer-alert");
    await expect(live).toContainText("The alpha and beta agents are done.",{timeout:20_000});
    await page.locator("select.permission-picker").first().selectOption("full");
    await send(page,"Now in Full access");
    await queued.getByRole("button",{name:"Send now"}).click();
    // The note says what became of the follow-up, which still reads queued. Soft, so that the old code also shows what the note does
    // once the queue sends it.
    await expect.soft(alert).toHaveText(QUEUED_NOT_SENT,{timeout:20_000});
    await expect(queued.locator(":scope > span")).toHaveText(["Queued"]);
    // Muse ends its report by itself: the queue sends the follow-up then, on a Full access host, and nothing says it was not sent.
    await harness.release("report_end");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await expect(queued).toHaveCount(0);
    await expect(alert,"no note says the follow-up was not sent").toHaveCount(0);
    expect(await harness.frames("turn/steer")).toEqual([]);
    expect(await harness.hosts()).toEqual([["serve","--trust-workspace"],["serve","--trust-workspace","--disable-sandbox"]]);
    await shoot(page,"muse-refused-follow-up-sent-after-report",reply(page,"Muse fixture reply"));
  }finally{await harness.close()}
});

test("a report Muse starts while the person's next message gathers its context shows in that message's turn, which keeps its Stop until it ends",async({page})=>{
  test.setTimeout(90_000);
  // The message's turn gathers its context (the repository knowledge the relay asks for) only once Muse has started its report and
  // the report's first words show: the report starts after the message's turn has started and before the message reaches Muse.
  const box={},live=page.locator(".agent-block .assistant-answer");
  const repositoryKnowledge={context:async({query})=>{
    if(!/one more thing/i.test(query))return null;
    await box.harness.release("report_start");
    await expect(live).toContainText("The alpha and beta agents are done.",{timeout:20_000});
    return null;
  }};
  const harness=box.harness=await startMuseHarness({environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_REPORT_HOLD:"1"},holds:["report_start"],relayOptions:{repositoryKnowledge}});
  try{
    await openMuse(page,harness);
    await send(page,"Please run workflow alpha-beta");
    await expect(reply(page,"Started the alpha-beta workflow.")).toBeVisible({timeout:20_000});
    const stop=page.getByRole("button",{name:"Stop",exact:true});
    await expect(stop).toHaveCount(0,{timeout:20_000});
    await send(page,"And one more thing, hold until steered");
    // The report and then the message's reply show in the message's turn as it runs, the report's words once, and its Stop stays.
    await expect(live).toContainText("Muse fixture reply",{timeout:20_000});
    await expect(live).toContainText("The alpha and beta agents are done. The rest of the report.");
    await expect(page.locator(".history-assistant, .agent-block .assistant-answer").filter({hasText:"The alpha and beta agents are done."})).toHaveCount(1);
    await expect(stop).toBeVisible();
    await shoot(page,"muse-report-in-message-turn",live);
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(stop).toHaveCount(0,{timeout:20_000});
    const [thread]=harness.threadStore.list();
    await expect.poll(()=>harness.threadStore.get(thread.id).turns.map(turn=>turn.status)).toEqual(["completed","cancelled"]);
  }finally{await harness.close()}
});

test("a message refused in Full access while a Supervised thread compacts leaves the thread in Supervised, so a workflow child's approval during the compaction shows on the card",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_COMPACT:"hold"},holds:["child_ask"]});
  try{
    await openMuse(page,harness);
    await send(page,"First message");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await page.getByRole("button",{name:"Compact",exact:true}).click();
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    await page.locator("select.permission-picker").first().selectOption("full");
    await send(page,"Now in Full access");
    await expect(page.getByTestId("composer-alert")).toContainText("Not sent: Muse Code is still compacting this conversation",{timeout:20_000});
    // A workflow child still running from the first turn asks to run a command: the thread is still in Supervised, so the person answers.
    await harness.release("child_ask");
    await expect(card(page)).toContainText("touch trebell-approved.txt",{timeout:20_000});
    await expect(card(page).locator(".approval-actions button")).toHaveText(["Allow once","Always allow in this workspace: touch ...","Reject"]);
    expect(await harness.frames("approval/decide")).toEqual([]);
    const [thread]=harness.threadStore.list();
    expect(harness.threadStore.get(thread.id).providerMeta?.permissionProfile).toBe("supervised");
    await shoot(page,"muse-child-card-after-refused-mode",card(page));
    await card(page).getByRole("button",{name:"Reject",exact:true}).click();
    await expect(card(page)).toHaveCount(0,{timeout:20_000});
    await expect.poll(async()=>(await harness.frames("approval/decide")).map(frame=>frame.params.choiceId)).toEqual(["abort"]);
  }finally{await harness.close()}
});
