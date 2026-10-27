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

// Muse Code asking the person, as they meet it in Trebell: its approval on Trebell's approval card with Muse's own three choices, its
// question in Trebell's question dialog, a card Muse's reviewer takes away by deciding it, a retry on the turn's retry row, and a turn
// the subscription quota stopped. Behind the page run the real agent relay and runtime manager on the stand-in Muse Code
// (tests/fixtures/muse/fake-muse.cjs), which asks as T3's recorded Muse session asks and records what Trebell answers.
const auditDir=fileURLToPath(new URL("../../visual-audit/muse-requests/",import.meta.url));mkdirSync(auditDir,{recursive:true});
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
// environment: the stand-in's switches, as the Muse Code profile's own variables.
async function startMuseHarness({environment={}}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-requests-")),repo=join(root,"muse-repo"),log=join(root,"muse.log");await mkdir(repo,{recursive:true});
  const folder=windows?join(root,"AppData","Local","Programs","muse"):join(root,"home",".local","bin");await mkdir(folder,{recursive:true});
  const launcher=join(folder,windows?"muse.cmd":"muse");
  await writeFile(launcher,windows?`@echo off\r\nsetlocal\r\n"${process.execPath}" "${FAKE_MUSE}" %*\r\nexit /b %ERRORLEVEL%\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${FAKE_MUSE}" "$@"\n`);
  if(!windows)await chmod(launcher,0o755);
  const settings={agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",activeEnvironmentId:null,agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,binaryPath:null,environment:{MUSE_FAKE_LOG:log,MUSE_FAKE_MODELS:MODEL_LIST,...environment}}]},meta=new Map();
  const state={settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const env={...process.env,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"codex"),CLAUDE_CONFIG_DIR:join(root,"claude"),MUSE_INSTALL_DIR:"",...(windows?{LOCALAPPDATA:join(root,"AppData","Local")}:{HOME:join(root,"home")})};
  const runtimeManager=new AgentRuntimeManager({state,env,runFn:onlyMuse(launcher)}),threadStore=new AgentThreadStore(env);
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,version:"muse-requests-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const frames=async method=>(await readFile(log,"utf8").catch(()=>"")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(entry=>entry.frame?.method===method).map(entry=>entry.frame);
  return {
    root,repo,runtimeManager,frames,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,
    async close(){await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})},
  };
}
// The app's endpoints for a window on Muse Code in Supervised, answered from the harness's runtime manager as the GUI server answers.
async function routeMuseApp(page,harness){
  const manager=harness.runtimeManager,status=await manager.probe("muse",{fresh:true}),listed=await manager.models("muse");
  const project={id:"muse-project",name:"Muse Project",path:harness.repo,environmentId:null,effectiveSettings:{}};
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"};
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",runtimeCapabilities:manager.capabilities("muse"),agentRuntimeReady:true,agentRuntimeStatus:status,provider:"openai",providerReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:harness.repo,platform:process.platform,version:"muse-requests-fixture",activeEnvironment:null,activeEnvironmentId:null}));
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

test("Muse Code's approval shows on Trebell's approval card with Muse's own three choices: Allow once lets the command run, and Reject keeps it from running",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness();
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const card=page.locator(".inline-approval .approval-card");
    await send(page,"Please ask approval to touch muse-approved.txt");
    await expect(card).toBeVisible({timeout:20_000});
    await expect(card).toContainText("touch muse-approved.txt");
    await expect(card.locator(".approval-actions button")).toHaveText(["Allow once","Always allow in this workspace: touch ...","Reject"]);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await card.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-approval-card-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    await card.getByRole("button",{name:"Allow once",exact:true}).click();
    await expect(reply(page,"APPROVED")).toBeVisible({timeout:20_000});
    await expect(card).toHaveCount(0);
    expect((await harness.frames("approval/decide")).map(frame=>frame.params.choiceId)).toEqual(["allow_once"]);
    // The next one, rejected: Muse does not run it, and says so.
    await send(page,"Please ask approval once more");
    await expect(card).toBeVisible({timeout:20_000});
    await card.getByRole("button",{name:"Reject",exact:true}).click();
    await expect(reply(page,"REJECTED")).toBeVisible({timeout:20_000});
    await expect(card).toHaveCount(0);
    expect((await harness.frames("approval/decide")).map(frame=>frame.params.choiceId)).toEqual(["allow_once","abort"]);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:auditDir+`muse-approval-answered-${mode}-1280x800.png`})}
  }finally{await harness.close()}
});

test("Muse Code's question opens Trebell's question dialog with Muse's options, and the person's choice and own words reach Muse as its answer",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness();
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const modal=page.locator(".question-modal");
    // A modal covers the header's light and dark toggle, so the question is asked once in each mode.
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await send(page,`Please ask question about the approach (${mode})`);
      await expect(modal).toContainText("Which approach should I take?",{timeout:20_000});
      await expect(modal).toContainText("Approach");
      const small=modal.getByRole("button",{name:/^Small/});
      await expect(modal.locator(".question-options button")).toHaveCount(2);
      await expect(small).toContainText("One file at a time");
      await small.click();
      await expect(small).toHaveAttribute("aria-pressed","true");
      await modal.getByPlaceholder("Custom answer…").click();await page.keyboard.type("Keep the tests focused");
      await page.screenshot({animations:"disabled",path:auditDir+`muse-question-dialog-${mode}-1280x800.png`});
      await modal.getByRole("button",{name:"Submit",exact:true}).click();
      await expect(modal).toHaveCount(0);
      await expect(reply(page,"ANSWERED: Small — Keep the tests focused").last()).toBeVisible({timeout:20_000});
    }
    const answers=(await harness.frames("userInput/answer")).map(frame=>frame.params.answers);
    expect(answers).toEqual([[{questionId:"approach",selectedLabel:"Small",note:"Keep the tests focused"}],[{questionId:"approach",selectedLabel:"Small",note:"Keep the tests focused"}]]);
  }finally{await harness.close()}
});

test("an approval card Muse's reviewer decides goes by itself, with nothing sent for it",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_REVIEW_MS:"2500"}});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const card=page.locator(".inline-approval .approval-card");
    await send(page,"Muse's reviewer decides this one");
    await expect(card).toBeVisible({timeout:20_000});
    await expect(card.locator(".approval-actions button")).toHaveText(["Allow once","Always allow in this workspace: touch ...","Reject"]);
    await expect(reply(page,"THE REVIEWER ALLOWED IT")).toBeVisible({timeout:20_000});
    await expect(card).toHaveCount(0);
    expect(await harness.frames("approval/decide")).toEqual([]);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:auditDir+`muse-reviewer-decided-${mode}-1280x800.png`})}
  }finally{await harness.close()}
});

test("a retry Muse schedules shows on the turn's retry row while the turn goes on, and a turn the quota stopped says the usage limit was reached and when it resets",async({page})=>{
  test.setTimeout(120_000);
  const harness=await startMuseHarness({environment:{MUSE_FAKE_RETRY_MS:"3000"}});
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    // Muse retries the turn's model request: the row says so while it waits, and reads recovered once the reply comes.
    await send(page,"Please retry once");
    const row=page.locator(".tool-event.kind-retry");
    await expect(row.locator("summary strong")).toHaveText("Retrying: Muse Code is trying again in 2 s (attempt 2 of 3): 429 Too Many Requests",{timeout:20_000});
    await expect(row).toHaveClass(/status-running/);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await row.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-retry-row-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    await expect(reply(page,"Muse fixture reply after a retry.")).toBeVisible({timeout:20_000});
    await expect(row.locator("summary strong")).toHaveText("Recovered after retrying");
    // A turn the subscription quota stopped: the usage limit and its reset in the person's own time, not Meta's 429.
    await send(page,"This one hits the quota");
    const resets=new Date("2031-05-04T10:45:52Z").toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"});
    const failed=page.locator(".tool-event.kind-error").filter({hasText:"Muse Code usage limit reached"});
    await expect(failed.locator("summary strong")).toHaveText(`Muse Code usage limit reached. Send the message again after it resets at ${resets}.`,{timeout:20_000});
    await expect(failed).toHaveClass(/status-error/);
    await expect(page.locator(".conversation-history")).not.toContainText("API error 429");
    for(const mode of ["dark","light"]){await switchMode(page,mode);await failed.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`muse-usage-limit-${mode}-1280x800.png`})}
  }finally{await harness.close()}
});
