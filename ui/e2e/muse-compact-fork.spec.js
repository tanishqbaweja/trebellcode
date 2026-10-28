import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { chmod,mkdir,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { keepThreadMeta } from "./test-home.js";

// Compact and Fork on a Muse Code thread, as the person meets them: the composer's Compact compacts Muse's context (session/compact)
// and says so, or says there is nothing to compact while the thread goes on; a compaction may take as long as Muse needs, the
// header's Stop ends it, and a message that fails meanwhile is no end of it; the sidebar's Fork thread makes a thread whose first
// message starts a fresh Muse Code session handed the earlier messages, which its row says; Edit from here is not offered, since Muse
// has no rewind. Behind the page run the real agent relay and runtime manager on the stand-in Muse Code
// (tests/fixtures/muse/fake-muse.cjs), which records what Trebell sends it.
const auditDir=fileURLToPath(new URL("../../visual-audit/muse-compact-fork/",import.meta.url));mkdirSync(auditDir,{recursive:true});
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
// has seen what it checks (release).
async function startMuseHarness({environment={},holds=[]}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-compact-fork-")),repo=join(root,"muse-repo"),log=join(root,"muse.log");await mkdir(repo,{recursive:true});
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
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,version:"muse-compact-fork-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const entries=async()=>(await readFile(log,"utf8").catch(()=>"")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  return {
    root,repo,settings,runtimeManager,threadStore,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,release:name=>writeFile(held[name],""),
    frames:async method=>(await entries()).filter(entry=>entry.frame?.method===method).map(entry=>entry.frame),
    hosts:async()=>(await entries()).filter(entry=>entry.start?.[0]==="serve"&&!entry.start.includes("--no-session-log")),
    async close(){await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})},
  };
}
// The app's endpoints for a window on Muse Code in Supervised, answered from the harness's runtime manager as the GUI server answers.
async function routeMuseApp(page,harness){
  const manager=harness.runtimeManager,status=await manager.probe("muse",{fresh:true}),listed=await manager.models("muse");
  const project={id:"muse-project",name:"Muse Project",path:harness.repo,environmentId:null,effectiveSettings:{}};
  const settings=Object.assign(harness.settings,{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"});
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",runtimeCapabilities:manager.capabilities("muse"),agentRuntimeReady:true,agentRuntimeStatus:status,provider:"openai",providerReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:harness.repo,platform:process.platform,version:"muse-compact-fork-fixture",activeEnvironment:null,activeEnvironmentId:null}));
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
const compactRows=page=>page.locator(".tool-event").filter({hasText:/compact/i});
async function shoot(page,name){for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:auditDir+`${name}-${mode}-1280x800.png`})}await switchMode(page,"dark")}

test("the composer's Compact compacts a Muse Code thread's context through Muse, and Edit from here is not offered",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_COMPACT_MS:"1500"}});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    // Muse Code has no conversation rewind, so the person's message offers no Edit from here.
    await expect(page.getByRole("button",{name:"Edit from here",exact:true})).toHaveCount(0);
    const compact=page.getByRole("button",{name:"Compact",exact:true});
    await expect(compact).toBeVisible();
    await compact.click();
    const rows=compactRows(page);
    await expect(rows).toHaveCount(1);await expect(rows).toHaveClass(/status-running/);await expect(rows.locator("summary strong")).toHaveText("Compacting context");
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    await expect(rows).toHaveClass(/status-done/,{timeout:20_000});await expect(rows.locator("summary strong")).toHaveText("Context compacted");
    await rows.scrollIntoViewIfNeeded();await shoot(page,"muse-compacted");
    // The thread goes on, on the same Muse Code host.
    await send(page,"After compacting");
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    expect((await harness.hosts()).length).toBe(1);
  }finally{await harness.close()}
});

test("Compact on a Muse Code thread with nothing to compact says so, and the thread goes on",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_COMPACT:"noop"}});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await page.getByRole("button",{name:"Compact",exact:true}).click();
    const failed=page.locator(".tool-event").filter({hasText:"Context compaction failed: There is no Muse Code conversation history to compact yet."});
    await expect(failed).toHaveCount(1,{timeout:20_000});
    await expect(page.locator(".tool-event.status-running")).toHaveCount(0);
    await failed.scrollIntoViewIfNeeded();await shoot(page,"muse-nothing-to-compact");
    await send(page,"Still here");
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
  }finally{await harness.close()}
});

// What the window shows once the frame after the next one is drawn: what a timer that fired just now did is on the page.
const drawn=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,0)))));

test("a Muse Code compaction that runs past the 45 seconds the window waits for another harness's still ends compacted, and the thread goes on",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({holds:["compact"]});
  try{
    await routeMuseApp(page,harness);
    // The window's timers run on a clock the test moves on, past 45 seconds, while Muse holds its compaction.
    await page.clock.install();
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await page.getByRole("button",{name:"Compact",exact:true}).click();
    const rows=compactRows(page);
    await expect(rows.locator("summary strong")).toHaveText("Compacting context");
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    await page.clock.fastForward("00:46");await drawn(page);
    await expect(rows).toHaveCount(1);await expect(rows.locator("summary strong")).toHaveText("Compacting context");await expect(rows).toHaveClass(/status-running/);
    await harness.release("compact");
    await expect(rows.locator("summary strong")).toHaveText("Context compacted",{timeout:20_000});await expect(rows).toHaveClass(/status-done/);
    await rows.scrollIntoViewIfNeeded();await shoot(page,"muse-long-compaction");
    await send(page,"After the long compaction");
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    expect((await harness.hosts()).length).toBe(1);
  }finally{await harness.close()}
});

test("Stop while Muse Code compacts a thread ends the compaction with Muse Code's own words, and the next message starts Muse Code again on the conversation",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_COMPACT:"hold"}});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    const stop=page.getByRole("button",{name:"Stop",exact:true});
    await expect(stop).toHaveCount(0,{timeout:20_000});
    await page.getByRole("button",{name:"Compact",exact:true}).click();
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    const rows=compactRows(page);await expect(rows.locator("summary strong")).toHaveText("Compacting context");
    // Muse's compaction runs in no turn: the header's Stop is the compaction's own.
    await expect(stop).toBeVisible();await expect(stop).toHaveAttribute("title","Stop the context compaction");
    await shoot(page,"muse-compaction-stop");
    await stop.click();
    await expect(rows.locator("summary strong")).toHaveText("Context compaction failed: Muse Code's context compaction was stopped before it finished.",{timeout:20_000});
    await expect(rows).not.toHaveClass(/status-running/);await expect(stop).toHaveCount(0);
    await rows.scrollIntoViewIfNeeded();await shoot(page,"muse-compaction-stopped");
    // The thread goes on: its next message starts Muse Code again, which resumes the conversation.
    await send(page,"After the stop");
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    expect((await harness.hosts()).length).toBe(2);
    expect((await harness.frames("session/resume")).length).toBe(1);
  }finally{await harness.close()}
});

test("a message that fails while Muse Code compacts the thread is no end of the compaction, which goes on to end compacted",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({holds:["compact"]});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await page.getByRole("button",{name:"Compact",exact:true}).click();
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    const rows=compactRows(page);await expect(rows.locator("summary strong")).toHaveText("Compacting context");
    // A message sent meanwhile in the thread's own mode goes to Muse, and its turn fails on the account's quota: an error of the
    // thread, not of the compaction. Soft, so that the old code also shows what the compaction's row says.
    await send(page,"This one hits the quota");
    await expect(page.locator(".tool-event.kind-error summary strong").filter({hasText:/^Muse Code usage limit reached/}).first()).toBeVisible({timeout:20_000});
    await expect.soft(rows,"the compaction's row only").toHaveCount(1);
    await expect.soft(rows.locator("summary strong")).toHaveText(["Compacting context"]);
    await expect.soft(rows).toHaveClass([/status-running/]);
    await expect.soft(page.getByRole("button",{name:"Stop",exact:true}),"the compaction's Stop, its turn over").toHaveAttribute("title","Stop the context compaction");
    await rows.first().scrollIntoViewIfNeeded();await shoot(page,"muse-compaction-past-other-error");
    await harness.release("compact");
    await expect(rows.locator("summary strong")).toHaveText(["Context compacted"],{timeout:20_000});await expect(rows).toHaveClass([/status-done/]);
    await send(page,"After the compaction");
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
  }finally{await harness.close()}
});

test("a message sent with the context nearly full waits for Muse Code's automatic compaction to end, however long Muse takes, and then goes",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_CONTEXT_USED:"907200"},holds:["compact"]});
  try{
    Object.assign(harness.settings,{autoCompactContext:true,autoCompactThresholdPercent:85});
    await routeMuseApp(page,harness);
    // The window's timers run on a clock the test moves on, past 45 seconds, while Muse holds its compaction.
    await page.clock.install();
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await expect(page.locator(".composer-context")).toContainText("90%");
    // The next message compacts the context first, and waits for the compaction past the 45 seconds another harness's gets: it is
    // not sent meanwhile, and the header's Stop is the compaction's.
    await send(page,"Go on with the long conversation");
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    await page.clock.fastForward("00:46");await drawn(page);
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveAttribute("title","Stop the context compaction");
    expect((await harness.frames("turn/start")).length).toBe(1);
    await expect(page.locator(".tool-event").filter({hasText:"Automatic context compaction failed"})).toHaveCount(0);
    await shoot(page,"muse-auto-compaction-waits");
    // Once Muse has compacted, the message goes.
    await harness.release("compact");
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    expect((await harness.frames("turn/start")).length).toBe(2);
    await expect(page.locator(".tool-event").filter({hasText:"Context compacted automatically before this turn"})).toBeVisible();
    await expect(page.locator(".tool-event").filter({hasText:"Automatic context compaction failed"})).toHaveCount(0);
  }finally{await harness.close()}
});

test("Fork thread on a Muse Code thread makes a thread whose first message starts a fresh Muse Code session with the earlier messages handed over",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness();
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Remember the word pelican");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    const rows=page.locator(".thread-row").filter({hasText:"Remember the word pelican"});
    await expect(rows).toHaveCount(1);
    const source=rows.first();await source.hover();await source.locator(".thread-menu summary").click();
    const fork=source.getByRole("button",{name:"Fork thread",exact:true});await expect(fork).toBeVisible();
    await page.screenshot({animations:"disabled",path:auditDir+"muse-fork-menu-dark-1280x800.png"});
    const hostsBefore=(await harness.hosts()).length;
    await fork.click();
    // The fork opens with the earlier conversation, and no Muse Code starts for it until its first message.
    await expect(rows).toHaveCount(2,{timeout:10_000});
    await expect(page.locator(".thread-row.active").filter({hasText:"Remember the word pelican"})).toHaveCount(1);
    await expect(page.locator(".user-row").filter({hasText:"Remember the word pelican"})).toBeVisible();
    expect((await harness.hosts()).length).toBe(hostsBefore);
    await send(page,"Which word did I give you?");
    const handoff=page.getByTestId("session-handoff");
    await expect(handoff).toHaveText("This fork continues in a new Muse Code session with the earlier messages handed over.",{timeout:20_000});
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    // Muse got the earlier messages with the fork's first turn, in a session of the fork's own (never Muse's own session/fork).
    const starts=await harness.frames("session/start"),turns=await harness.frames("turn/start");
    expect(starts).toHaveLength(2);expect(await harness.frames("session/fork")).toHaveLength(0);
    expect(turns.at(-1).params.sessionId).toBe(starts.at(-1).params.sessionId);
    expect(JSON.stringify(turns.at(-1).params.input)).toContain("Remember the word pelican");
    await handoff.scrollIntoViewIfNeeded();await shoot(page,"muse-fork-handoff");
  }finally{await harness.close()}
});
