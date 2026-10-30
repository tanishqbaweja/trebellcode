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
// header's Stop ends it, and a message that fails meanwhile is no end of it; a message sent with the context nearly full shows as
// being sent while Muse compacts first, and is kept through a reload; once the window stops waiting, the row says so, and Muse's
// later end takes that row; the sidebar's Fork thread makes a thread whose first message starts a fresh Muse Code session handed
// the earlier messages, which its row says; Edit from here is not offered, since Muse has no rewind. Behind the page run the
// real agent relay and runtime manager on the stand-in Muse Code (tests/fixtures/muse/fake-muse.cjs), which records what Trebell
// sends it.
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
// recipes: the project's recipes. meta: the threads' meta store, which another window of the test shares.
async function routeMuseApp(page,harness,{recipes=[],meta={}}={}){
  const manager=harness.runtimeManager,status=await manager.probe("muse",{fresh:true}),listed=await manager.models("muse");
  const project={id:"muse-project",name:"Muse Project",path:harness.repo,environmentId:null,effectiveSettings:{},recipes};
  const settings=Object.assign(harness.settings,{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"});
  await keepThreadMeta(page,meta);
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

// Where a row reads on screen, top to bottom, and the activity card a step is listed in.
const edges=locator=>locator.evaluate(node=>{const box=node.getBoundingClientRect();return {top:Math.round(box.top),bottom:Math.round(box.bottom)}});
const cardOf=step=>step.locator("xpath=ancestor::*[@data-testid='activity-card'][1]");

// Muse Code compacts between turns, in no turn of its own: Compact's row reads after the replies it compacts, below the latest one,
// in no turn's card, while it runs and once it has ended, compacted or not, and the turn before it keeps its card as it was.
for(const outcome of ["compacted","nothing to compact"]){
  test(`Compact on a Muse Code thread shows its row below the latest reply, in no turn's card, when Muse ends it ${outcome}`,async({page})=>{
    test.setTimeout(90_000);
    const harness=await startMuseHarness({environment:outcome==="compacted"?{MUSE_FAKE_COMPACT_MS:"1500"}:{MUSE_FAKE_COMPACT:"noop"}});
    try{
      await routeMuseApp(page,harness);
      await page.setViewportSize({width:1280,height:800});
      await page.goto("/");
      await send(page,"Hello Muse");
      const answer=reply(page,"Muse fixture reply");
      await expect(answer).toBeVisible({timeout:20_000});
      await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:20_000});
      // The turn's card lists its own step, the repository context its message was sent with.
      const card=page.locator("[data-testid=activity-card]").filter({hasText:"Trebell context skipped"});
      await expect(card).toHaveCount(1);
      const rows=compactRows(page),placed=async()=>{
        await expect(card.locator(".tool-event").filter({hasText:/compact/i}),"the turn's card lists no compaction").toHaveCount(0);
        await expect(card.locator(".activity-card-failed"),"the turn's card says nothing failed").toHaveCount(0);
        const [{top},{bottom}]=await Promise.all([edges(cardOf(rows.first())),edges(answer)]);
        expect(top,"the compaction's card reads below the latest reply").toBeGreaterThanOrEqual(bottom);
      };
      await page.getByRole("button",{name:"Compact",exact:true}).click();
      if(outcome==="compacted"){
        await expect(rows.locator("summary strong")).toHaveText("Compacting context");await expect(rows).toHaveClass(/status-running/);
        await expect(page.getByRole("button",{name:"Compact",exact:true}),"Compact is not offered while Muse compacts").toHaveCount(0);
        await placed();
        await expect(rows.locator("summary strong")).toHaveText("Context compacted",{timeout:20_000});await expect(rows).toHaveClass(/status-done/);
      }else await expect(rows.locator("summary strong")).toHaveText("Context compaction failed: There is no Muse Code conversation history to compact yet.",{timeout:20_000});
      await expect(rows).toHaveCount(1);await placed();
      await rows.scrollIntoViewIfNeeded();await shoot(page,"muse-compaction-below-reply-"+outcome.replaceAll(" ","-"));
      // In a narrow window too.
      await page.setViewportSize({width:700,height:800});await placed();await page.setViewportSize({width:1280,height:800});
      // Muse Code keeps no record of the compaction: once the window is reloaded, the thread shows no row of it, nor a failed step.
      await page.reload();
      const listed=page.locator(".thread-row").filter({hasText:"Hello Muse"});
      await listed.locator(".thread-main").click();await expect(listed).toHaveClass(/active/);
      await expect(answer).toBeVisible({timeout:20_000});
      await expect(rows).toHaveCount(0);await expect(page.locator(".activity-card-failed")).toHaveCount(0);
    }finally{await harness.close()}
  });
}

// What the window shows once the frame after the next one is drawn: what a timer that fired just now did is on the page.
const drawn=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,0)))));
// The row of a compaction the window stopped waiting for: what it says, all of it in view, the way back to the compaction too, and
// that it reads as a step whose end is not known, not as a failed one (no error mark or pill, and no card counting it failed). Soft,
// so that the old code also shows what comes after it.
const WAITED="Trebell stopped waiting for the context compaction after 10 minutes; Muse Code may still be compacting. Press Compact to follow it again; its Stop comes back.";
async function waitedLooks(page,rows){
  await expect.soft(rows).toHaveClass([/status-unknown/]);await expect.soft(rows).not.toHaveClass([/kind-error|status-error/]);
  await expect.soft(rows.locator("summary em")).toHaveText(["unknown"]);
  await expect.soft(page.locator(".activity-card-failed"),"no card counts it failed").toHaveCount(0);
  expect.soft(await rows.locator("summary strong").evaluateAll(nodes=>nodes.map(node=>node.scrollWidth<=node.clientWidth+1)),"its whole text shows").toEqual([true]);
}

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

test("Stop while Muse Code's host is still starting again for a compaction ends that compaction there with Muse Code's own words, and the thread goes on on that host",async({page})=>{
  test.setTimeout(90_000);
  // The stand-in's host holds its start while the file "start" names is there (MUSE_FAKE_START_HOLD).
  const harness=await startMuseHarness({environment:{MUSE_FAKE_COMPACT:"hold"},holds:["start"]}),startHold=join(harness.root,"release-start");
  const stopped="Context compaction failed: Muse Code's context compaction was stopped before it finished.";
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    const stop=page.getByRole("button",{name:"Stop",exact:true}),compact=page.getByRole("button",{name:"Compact",exact:true}),rows=compactRows(page);
    // A first compaction, stopped while Muse compacts: the Stop ends Muse Code's host, which has no stop for a compaction.
    await compact.click();
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    await stop.click();
    await expect(rows.locator("summary strong")).toHaveText(stopped,{timeout:20_000});
    // Compact again: Muse Code's host starts again for it, and takes its time. The header's Stop meanwhile ends the compaction there,
    // before Muse is asked to compact. Soft, so that the old code also shows what the row and the Stop say.
    await writeFile(startHold,"");
    await compact.click();
    await expect.poll(async()=>(await harness.hosts()).length,{timeout:20_000}).toBe(2);
    await expect(rows.locator("summary strong")).toHaveText("Compacting context");
    await expect(stop).toHaveAttribute("title","Stop the context compaction");
    await stop.click();
    await expect.soft(rows.locator("summary strong"),"the compaction ends at once, its host still starting").toHaveText(stopped,{timeout:5000});
    await expect.soft(rows).not.toHaveClass(/status-running/);
    await expect.soft(stop,"and its Stop goes").toHaveCount(0);
    await rows.scrollIntoViewIfNeeded();await shoot(page,"muse-compaction-stopped-while-starting");
    // The host goes on starting, and Muse is never asked to compact; the next message runs on that host.
    await rm(startHold,{force:true});
    await expect.poll(async()=>(await harness.frames("session/resume")).length,{timeout:20_000}).toBeGreaterThanOrEqual(1);
    await send(page,"After the stop");
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    expect((await harness.frames("session/compact")).length,"no compaction after the Stop").toBe(1);
    expect((await harness.hosts()).length).toBe(2);
  }finally{await rm(startHold,{force:true}).catch(()=>{});await harness.close()}
});

test("Stop during Muse Code's automatic compaction sends the message on uncompacted, saying the compaction was stopped, instead of giving the draft back",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_CONTEXT_USED:"943721",MUSE_FAKE_COMPACT:"hold"}});
  try{
    Object.assign(harness.settings,{autoCompactContext:true,autoCompactThresholdPercent:85});
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await expect(page.locator(".composer-context")).toContainText("90%");
    // The next message compacts the context first, and the person stops that compaction with the header's Stop.
    await send(page,"Go on with the long conversation");
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    const stop=page.getByRole("button",{name:"Stop",exact:true});
    await expect(stop).toHaveAttribute("title","Stop the context compaction");
    await stop.click();
    // The message goes on without it, on Muse Code started again, and its turn says the compaction was stopped. Soft, so that the
    // old code also shows where the message went.
    const note=page.locator(".tool-event").filter({hasText:"Automatic context compaction failed; continuing: Muse Code's context compaction was stopped before it finished."});
    await expect.soft(reply(page,"Muse fixture reply"),"the message ran").toHaveCount(2,{timeout:20_000});
    await expect.soft(note).toHaveCount(1);
    await expect.soft(page.getByTestId("composer"),"its draft did not come back").toHaveValue("");
    expect((await harness.frames("turn/start")).length).toBe(2);
    await note.scrollIntoViewIfNeeded();await shoot(page,"muse-auto-compaction-stopped");
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
  const harness=await startMuseHarness({environment:{MUSE_FAKE_CONTEXT_USED:"943721"},holds:["compact"]});
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

// A thread at 90% of its context with automatic compaction on, which the stand-in Muse holds compacting (release "compact").
async function nearlyFullThread(page){
  const harness=await startMuseHarness({environment:{MUSE_FAKE_CONTEXT_USED:"943721"},holds:["compact"]});
  Object.assign(harness.settings,{autoCompactContext:true,autoCompactThresholdPercent:85});
  await routeMuseApp(page,harness);
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await send(page,"Hello Muse");
  await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
  await expect(page.locator(".composer-context")).toContainText("90%");
  return harness;
}

test("a message waiting for Muse Code's automatic compaction shows in the thread as being sent, under a row saying the context is compacted first, also once the thread is opened again, and goes once Muse has compacted",async({page})=>{
  test.setTimeout(90_000);
  let harness;
  try{
    harness=await nearlyFullThread(page);
    await send(page,"Go on with the long conversation");
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    // While Muse compacts, the person still reads the message they sent, and a row says why it has not gone yet. Compact is not
    // offered for the compaction that runs. Soft, so that the old code also shows what the row and Compact do.
    const waiting=page.locator(".queued-message,.user-row").filter({hasText:"Go on with the long conversation"}),rows=compactRows(page);
    await expect.soft(waiting,"the message shows").toBeVisible();
    await expect.soft(rows.locator("summary strong"),"a row says the context is compacted").toHaveText(["Compacting context"]);await expect.soft(rows).toHaveClass([/status-running/]);
    await expect.soft(page.getByRole("button",{name:"Compact",exact:true}),"Compact is not offered").toHaveCount(0);
    expect((await harness.frames("turn/start")).length).toBe(1);
    // It reads as being sent, its own words saying what it waits for, and none of its buttons can send, change or drop it meanwhile.
    const held=page.locator(".queued-message").filter({hasText:"Go on with the long conversation"});
    const sending=async()=>{
      await expect(held.locator(":scope > span")).toHaveText("Sending…");
      await expect(held.locator(":scope > span")).toHaveAttribute("title","This message waits for the context compaction to end: it is sent then, and comes back to the composer if it cannot be.");
      for(const name of ["Send now","Edit","Remove"])await expect(held.getByRole("button",{name,exact:true}),name+" is off").toBeDisabled();
      await expect(held.getByRole("button",{name:"Send now",exact:true})).toHaveAttribute("title","This message is already on its way");
    };
    await sending();
    await shoot(page,"muse-auto-compaction-message-shown");
    // Away to New task and back to the thread meanwhile: both show again.
    await page.getByRole("button",{name:"New task",exact:true}).first().click();
    await expect(page.locator(".thread-row.active")).toHaveCount(0);
    await page.locator(".thread-row").filter({hasText:"Hello Muse"}).locator(".thread-main").click();
    await expect(reply(page,"Muse fixture reply")).toHaveCount(1);
    await expect.soft(waiting,"the message shows on the thread opened again").toBeVisible();
    await expect.soft(rows.locator("summary strong"),"and so does its row").toHaveText(["Compacting context"]);
    await sending();
    // Once Muse has compacted, the message goes, once, and the turn says the context was compacted before it.
    await harness.release("compact");
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    await expect(page.locator(".user-row").filter({hasText:"Go on with the long conversation"})).toHaveCount(1);
    await expect(page.locator(".queued-message")).toHaveCount(0);
    await expect(page.locator(".tool-event").filter({hasText:"Context compacted automatically before this turn"})).toBeVisible();
    expect((await harness.frames("turn/start")).length).toBe(2);
  }finally{await harness?.close()}
});

test("a reload while a message waits for Muse Code's automatic compaction keeps the message in its thread, and it goes from there once Muse has compacted",async({page})=>{
  test.setTimeout(120_000);
  let harness;
  try{
    harness=await nearlyFullThread(page);
    await send(page,"Go on with the long conversation");
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    // The person reloads the window while Muse compacts and opens the thread again: the message is still there, not sent.
    await page.reload();
    await page.locator(".thread-row").filter({hasText:"Hello Muse"}).locator(".thread-main").click();
    await expect(reply(page,"Muse fixture reply")).toHaveCount(1,{timeout:20_000});
    const kept=page.locator(".queued-message").filter({hasText:"Go on with the long conversation"});
    await expect(kept).toBeVisible();
    // Muse ends its compaction, and the person sends the message from there: it goes once.
    await harness.release("compact");
    await expect(compactRows(page).filter({hasText:"Context compacted"})).toHaveCount(1,{timeout:20_000});
    await shoot(page,"muse-auto-compaction-message-kept-after-reload");
    await kept.getByRole("button",{name:"Send now",exact:true}).click();
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    await expect(page.locator(".user-row").filter({hasText:"Go on with the long conversation"})).toHaveCount(1);
    await expect(kept).toHaveCount(0);
    expect((await harness.frames("turn/start")).length).toBe(2);
  }finally{await harness?.close()}
});

// The person's message sent in one window waits for Muse Code's automatic compaction (the stand-in holds it), with the context at
// 90%; the threads' meta is shared with the person's other windows, as the server's is. The window is returned with the harness.
async function heldInFirstWindow(page,meta){
  const harness=await startMuseHarness({environment:{MUSE_FAKE_CONTEXT_USED:"943721"},holds:["compact"]});
  Object.assign(harness.settings,{autoCompactContext:true,autoCompactThresholdPercent:85});
  await routeMuseApp(page,harness,{meta});
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await send(page,"Hello Muse");
  await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
  await expect(page.locator(".composer-context")).toContainText("90%");
  await send(page,"Go on with the long conversation");
  await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
  return harness;
}
// The person's other window opens the thread, its message waiting there.
async function openElsewhere(other,harness,meta){
  await routeMuseApp(other,harness,{meta});
  await other.setViewportSize({width:1280,height:800});
  await other.goto("/");
  await other.locator(".thread-row").filter({hasText:"Hello Muse"}).locator(".thread-main").click();
  await expect(reply(other,"Muse fixture reply")).toHaveCount(1,{timeout:20_000});
  return other.locator(".queued-message").filter({hasText:"Go on with the long conversation"});
}
const ELSEWHERE="This message is on its way in another window, which sends it once the context compaction has ended.";

test("another window that opens the thread while a message waits there for Muse Code's automatic compaction shows it on its way in the first window, with nothing to send it twice, and drops it as its turn starts",async({page})=>{
  test.setTimeout(120_000);
  const meta={};let harness=null,other=null;
  try{
    harness=await heldInFirstWindow(page,meta);
    other=await page.context().newPage();
    const elsewhere=await openElsewhere(other,harness,meta);
    await expect(elsewhere.locator(":scope > span")).toHaveText("Sending…");
    await expect(elsewhere.locator(":scope > span")).toHaveAttribute("title",ELSEWHERE);
    for(const name of ["Send now","Edit","Remove"])await expect(elsewhere.getByRole("button",{name,exact:true}),name+" is off").toBeDisabled();
    await expect(elsewhere.getByRole("button",{name:"Send now",exact:true})).toHaveAttribute("title","This message is already on its way");
    await other.screenshot({animations:"disabled",path:auditDir+"muse-auto-compaction-message-on-its-way-elsewhere-dark-1280x800.png"});
    // Muse compacts, and the first window sends the message, once: the other window drops it from its queue as its turn starts, and
    // shows its turn's reply.
    await harness.release("compact");
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    await expect(elsewhere,"the message leaves the other window's queue").toHaveCount(0,{timeout:20_000});
    await expect(reply(other,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    expect((await harness.frames("turn/start")).length).toBe(2);
  }finally{await other?.close().catch(()=>{});await harness?.close()}
});

// A tab duplicated from the window whose message waits (or a window opened from it) starts with a copy of that window's
// sessionStorage, as browsers copy it. It is another window all the same: it shows the message on its way in the first one, with
// nothing to send it twice, and the first window sends it once Muse has compacted.
test("a tab duplicated from the window whose message waits for Muse Code's automatic compaction shows that message on its way there, with nothing to send it twice",async({page})=>{
  test.setTimeout(120_000);
  const meta={};let harness=null,other=null;
  try{
    harness=await heldInFirstWindow(page,meta);
    const copied=await page.evaluate(()=>Object.fromEntries(Object.keys(sessionStorage).map(key=>[key,sessionStorage.getItem(key)])));
    other=await page.context().newPage();
    await other.addInitScript(entries=>{try{if(!sessionStorage.length)for(const [key,value] of Object.entries(entries))sessionStorage.setItem(key,value)}catch{}},copied);
    const elsewhere=await openElsewhere(other,harness,meta);
    await expect(elsewhere.locator(":scope > span")).toHaveText("Sending…");
    await expect(elsewhere.locator(":scope > span")).toHaveAttribute("title",ELSEWHERE);
    for(const name of ["Send now","Edit","Remove"])await expect(elsewhere.getByRole("button",{name,exact:true}),name+" is off").toBeDisabled();
    await harness.release("compact");
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    await expect(elsewhere,"the message leaves the duplicate's queue").toHaveCount(0,{timeout:20_000});
    expect((await harness.frames("turn/start")).length,"sent once").toBe(2);
  }finally{await other?.close().catch(()=>{});await harness?.close()}
});

// crypto.randomUUID exists only in secure contexts, so a page served on an http origin other than localhost (TREBELL_GUI_HOST, or
// behind a proxy that says http) has none: the window opens there all the same, and its messages go.
test("a window without crypto.randomUUID, as on an http origin other than localhost, opens and its message goes",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness(),errors=[];
  try{
    await page.addInitScript(()=>{delete Crypto.prototype.randomUUID});
    page.on("pageerror",error=>errors.push(error.message));
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    expect(await page.evaluate(()=>typeof crypto.randomUUID)).toBe("undefined");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    expect(errors,"nothing failed on the page").toEqual([]);
  }finally{await harness.close()}
});

// The window whose message waits renews its hold on it every 30 seconds, for two minutes from then, so the person's other window
// shows the message on its way there for as long as that window is open. Once it is closed, its hold ends within two minutes: the
// other window then leaves the message to retry, and nothing sends it by itself. Both windows' timers run on one clock the test moves
// on, and the first window renews its hold at each move.
test("a message waiting for Muse Code's automatic compaction stays on its way in the person's other window while its own window renews its hold, and is left to retry there within two minutes of that window closing, never sent by itself",async({page})=>{
  test.setTimeout(150_000);
  const meta={};let harness=null,first=null;
  try{
    await page.clock.install();
    first=await page.context().newPage();
    harness=await heldInFirstWindow(first,meta);
    const kept=await openElsewhere(page,harness,meta);
    await expect(kept.locator(":scope > span")).toHaveText("Sending…");
    await expect(kept.locator(":scope > span")).toHaveAttribute("title",ELSEWHERE);
    // Past the two minutes of its first hold the message is still on its way in the first window, with nothing here to send it.
    // Soft, so that the old code also shows what a closed window leaves.
    const holdEnd=()=>Object.values(meta).flatMap(entry=>entry.trebellQueue||[]).find(item=>item.text==="Go on with the long conversation")?.heldUntil||0;
    const renewed=async before=>{for(let tries=0;tries<50;tries++){if(holdEnd()>before)return true;await new Promise(resolve=>setTimeout(resolve,200))}return false};
    for(let step=1;step<=5;step++){const before=holdEnd();await page.clock.fastForward("00:31");expect.soft(await renewed(before),"the first window renewed its hold, move "+step).toBe(true)}
    await drawn(page);
    await expect.soft(kept.locator(":scope > span")).toHaveText("Sending…");
    for(const name of ["Send now","Edit","Remove"])await expect.soft(kept.getByRole("button",{name,exact:true}),name+" is off").toBeDisabled();
    // The first window is closed while its message waits: its hold ends within two minutes, and the message is left to retry.
    await first.close();first=null;
    await page.clock.fastForward("02:05");
    await expect(kept.locator(":scope > span")).toHaveText("Queued · retry needed",{timeout:20_000});
    await expect(kept.getByRole("button",{name:"Send now",exact:true})).toBeEnabled();
    await shoot(page,"muse-auto-compaction-message-left-to-retry");
    expect((await harness.frames("turn/start")).length,"nothing sent it").toBe(1);
    // Muse ends its compaction, and the person sends the message from there: it goes once.
    await harness.release("compact");
    await kept.getByRole("button",{name:"Send now",exact:true}).click();
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    await expect(kept).toHaveCount(0);
    expect((await harness.frames("turn/start")).length).toBe(2);
  }finally{await first?.close().catch(()=>{});await harness?.close()}
});

test("a project's recipe sent with the context nearly full shows its message in the thread while Muse Code compacts first, and goes once, when Muse has compacted",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_CONTEXT_USED:"943721"},holds:["compact"]});
  try{
    Object.assign(harness.settings,{autoCompactContext:true,autoCompactThresholdPercent:85});
    await routeMuseApp(page,harness,{recipes:[{id:"tidy",name:"/tidy",description:"Tidy what the conversation built"}]});
    await page.route(/\/api\/project-recipe\/resolve$/,route=>json(route,{execution:{turnInput:"Tidy what the long conversation built",context:"The project's tidy recipe",permissionMode:null,model:null,goalPatch:null,toolAllowlist:null}}));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await expect(page.locator(".composer-context")).toContainText("90%");
    // The recipe, picked from the composer's menu (Enter picks it, Enter sends it), runs a turn the automatic compaction comes before.
    await page.getByTestId("composer").click();await page.keyboard.type("/tidy");await page.keyboard.press("Enter");await page.keyboard.press("Enter");
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    const message=page.locator(".user-row").filter({hasText:"Tidy what the long conversation built"});
    await expect(message,"the recipe's message shows while Muse compacts").toBeVisible();
    await expect(compactRows(page).locator("summary strong")).toHaveText(["Compacting context"]);
    expect((await harness.frames("turn/start")).length).toBe(1);
    await shoot(page,"muse-auto-compaction-recipe-message-shown");
    await harness.release("compact");
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    await expect(message,"its message shows once").toHaveCount(1);
    expect((await harness.frames("turn/start")).length).toBe(2);
  }finally{await harness.close()}
});

// A row that came after Muse Code's last turn ended (Compact's, which found nothing to compact) is no step of the report Muse starts
// after it: it reads in a card of its own, between the turn it came after and the report, which says nothing failed.
test("Compact's row from between Muse Code's turns stays out of the report Muse starts after it, in a card of its own above the report's reply",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_WORKFLOW_MS:"40",MUSE_FAKE_COMPACT:"noop"},holds:["report_start"]});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Please run workflow alpha-beta");
    const launched=reply(page,"Started the alpha-beta workflow.");
    await expect(launched).toBeVisible({timeout:20_000});
    const stop=page.getByRole("button",{name:"Stop",exact:true});
    await expect(stop).toHaveCount(0,{timeout:20_000});
    await page.getByRole("button",{name:"Compact",exact:true}).click();
    const failed=page.locator(".tool-event").filter({hasText:"Context compaction failed: There is no Muse Code conversation history to compact yet."});
    await expect(failed).toHaveCount(1,{timeout:20_000});
    // Muse reports on its workflow in a turn of its own.
    await harness.release("report_start");
    const report=page.locator(".history-assistant,.agent-block .assistant-answer").filter({hasText:"The alpha and beta agents are done."});
    await expect(report).toBeVisible({timeout:20_000});
    await expect(stop).toHaveCount(0,{timeout:20_000});
    const [thread]=harness.threadStore.list();
    await expect.poll(()=>harness.threadStore.get(thread.id).turns.length).toBe(2);
    const reportId=harness.threadStore.get(thread.id).turns[1].id,launchedId=harness.threadStore.get(thread.id).turns[0].id;
    await expect(failed).toHaveCount(1);
    const own=cardOf(failed);
    await expect(own,"no turn's card").not.toHaveAttribute("data-turn-id",/./);
    await expect(page.locator(`[data-testid=activity-card][data-turn-id="${reportId}"] .tool-event`).filter({hasText:/compact/i}),"the report lists no compaction").toHaveCount(0);
    await expect(page.locator(`[data-testid=activity-card][data-turn-id="${reportId}"] .activity-card-failed`),"and says nothing failed").toHaveCount(0);
    const [card,before,after]=await Promise.all([edges(own),edges(launched),edges(report)]);
    expect(card.top,"it reads below the reply it came after").toBeGreaterThanOrEqual(before.bottom);
    expect(card.bottom,"and above the report's reply").toBeLessThanOrEqual(after.top);
    await failed.scrollIntoViewIfNeeded();await shoot(page,"muse-compaction-row-before-report");
    expect(launchedId).not.toBe(reportId);
  }finally{await harness.close()}
});

test("once the window has waited its ten minutes for Muse Code's compaction, its row says the window stopped waiting while Muse may still compact, and Muse's later end replaces that row",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({holds:["compact"]});
  try{
    await routeMuseApp(page,harness);
    // The window's timers run on a clock the test moves on, past its ten minutes, while Muse holds its compaction.
    await page.clock.install();
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await page.getByRole("button",{name:"Compact",exact:true}).click();
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    const rows=compactRows(page);
    await expect(rows.locator("summary strong")).toHaveText(["Compacting context"]);
    // Soft, so that the old code also shows what Muse's later end does.
    await page.clock.fastForward("10:30");await drawn(page);
    await expect.soft(rows.locator("summary strong")).toHaveText([WAITED]);
    await waitedLooks(page,rows);
    await expect(page.getByRole("button",{name:"Stop",exact:true}),"the window no longer follows the compaction").toHaveCount(0);
    await rows.scrollIntoViewIfNeeded();await shoot(page,"muse-compaction-window-stopped-waiting");
    // Compact follows it again, as the row says: its Stop comes back, on the same row, compacting.
    await page.getByRole("button",{name:"Compact",exact:true}).click();
    await expect(rows.locator("summary strong")).toHaveText(["Compacting context"]);await expect(rows).toHaveClass([/status-running/]);
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveAttribute("title","Stop the context compaction");
    // Muse's end comes later, and takes that row's place: one row, compacted.
    await harness.release("compact");
    await expect(rows.locator("summary strong")).toHaveText(["Context compacted"],{timeout:20_000});await expect(rows).toHaveClass([/status-done/]);
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);
    // /compact typed afterwards (Enter picks it from the menu, Enter sends it) compacts again, on that same row.
    await page.getByTestId("composer").click();await page.keyboard.type("/compact");await page.keyboard.press("Enter");await page.keyboard.press("Enter");
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(2);
    await expect(rows.locator("summary strong")).toHaveText(["Context compacted"],{timeout:20_000});await expect(rows).toHaveClass([/status-done/]);
    await send(page,"After the long compaction");
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
  }finally{await harness.close()}
});

test("a message whose automatic compaction Muse Code has not finished in the window's ten minutes goes on, its row saying the window stopped waiting while Muse may still compact, and Muse's later end replaces that row",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_CONTEXT_USED:"943721"},holds:["compact"]});
  try{
    Object.assign(harness.settings,{autoCompactContext:true,autoCompactThresholdPercent:85});
    await routeMuseApp(page,harness);
    // The window's timers run on a clock the test moves on, past its ten minutes, while Muse holds its compaction.
    await page.clock.install();
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await send(page,"Hello Muse");
    await expect(reply(page,"Muse fixture reply")).toBeVisible({timeout:20_000});
    await expect(page.locator(".composer-context")).toContainText("90%");
    await send(page,"Go on with the long conversation");
    await expect.poll(async()=>(await harness.frames("session/compact")).length).toBe(1);
    // At ten minutes the message goes on without the compaction, and its turn's row says why. Soft, so that the old code also shows
    // what Muse's later end does.
    await page.clock.fastForward("10:30");await drawn(page);
    await expect(reply(page,"Muse fixture reply")).toHaveCount(2,{timeout:20_000});
    const rows=compactRows(page);
    await expect.soft(rows.locator("summary strong")).toHaveText([WAITED]);
    await waitedLooks(page,rows);
    await rows.first().scrollIntoViewIfNeeded();await shoot(page,"muse-auto-compaction-window-stopped-waiting");
    // Once the message's turn has ended, Compact follows Muse's compaction again, as the row says: its Stop comes back, and Compact's
    // row takes the place of the message's, one row of the one compaction.
    const stop=page.getByRole("button",{name:"Stop",exact:true});
    await expect(stop).toHaveCount(0,{timeout:20_000});
    await page.getByRole("button",{name:"Compact",exact:true}).click();
    await expect(rows.locator("summary strong")).toHaveText(["Compacting context"]);await expect(rows).toHaveClass([/status-running/]);
    await expect(stop).toHaveAttribute("title","Stop the context compaction");
    expect((await harness.frames("session/compact")).length,"Muse is asked nothing more: Compact joins the compaction it runs").toBe(1);
    // Muse's end comes later, and takes that row's place: one row, compacted.
    await harness.release("compact");
    await expect(rows.locator("summary strong")).toHaveText(["Context compacted"],{timeout:20_000});await expect(rows).toHaveClass([/status-done/]);
    await expect(stop).toHaveCount(0);
    expect((await harness.frames("turn/start")).length).toBe(2);
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
