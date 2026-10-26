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
import { interactiveTerminalCommand } from "../../src/terminal-command.mjs";
import { keepThreadMeta } from "./test-home.js";

// Muse Code as a person meets it in Trebell: Settings' Agents & models lists it with its version and signs in with Muse's own
// `muse login` in a terminal, and the composer lists Muse's models with the Thinking levels each offers, runs a turn on the model and
// level picked, and names Muse Code in the sidebar. Behind the page run the real agent relay and runtime manager, on a stand-in Muse
// Code (tests/fixtures/muse/fake-muse.cjs) laid out as Meta's installer lays Muse out; the app's own endpoints answer from them.
const auditDir=fileURLToPath(new URL("../../visual-audit/muse-harness/",import.meta.url));mkdirSync(auditDir,{recursive:true});
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

async function startMuseHarness(){
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-e2e-")),repo=join(root,"muse-repo"),log=join(root,"muse.log");await mkdir(repo,{recursive:true});
  const folder=windows?join(root,"AppData","Local","Programs","muse"):join(root,"home",".local","bin");await mkdir(folder,{recursive:true});
  const launcher=join(folder,windows?"muse.cmd":"muse");
  await writeFile(launcher,windows?`@echo off\r\nsetlocal\r\n"${process.execPath}" "${FAKE_MUSE}" %*\r\nexit /b %ERRORLEVEL%\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${FAKE_MUSE}" "$@"\n`);
  if(!windows)await chmod(launcher,0o755);
  const settings={agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",activeEnvironmentId:null,agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,binaryPath:null,environment:{MUSE_FAKE_LOG:log,MUSE_FAKE_MODELS:MODEL_LIST}}]},meta=new Map();
  const state={settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const env={...process.env,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"codex"),CLAUDE_CONFIG_DIR:join(root,"claude"),MUSE_INSTALL_DIR:"",...(windows?{LOCALAPPDATA:join(root,"AppData","Local")}:{HOME:join(root,"home")})};
  const runtimeManager=new AgentRuntimeManager({state,env,runFn:onlyMuse(launcher)}),threadStore=new AgentThreadStore(env);
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,version:"muse-e2e-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const frames=async method=>(await readFile(log,"utf8").catch(()=>"")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(entry=>entry.frame?.method===method).map(entry=>entry.frame);
  return {
    root,repo,launcher,runtimeManager,threadStore,frames,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,
    async close(){await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})},
  };
}

// The app's endpoints for a window on Muse Code, answered from the harness's runtime manager as the GUI server answers them.
// signIns lists the sign-ins the page asks for; the sign-in terminal shows the command Trebell types into it.
async function routeMuseApp(page,harness){
  const manager=harness.runtimeManager,status=await manager.probe("muse",{fresh:true}),listed=await manager.models("muse");
  const project={id:"muse-project",name:"Muse Project",path:harness.repo,environmentId:null,effectiveSettings:{}},signIns=[],terminals=[];
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"};
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",runtimeCapabilities:manager.capabilities("muse"),agentRuntimeReady:true,agentRuntimeStatus:status,provider:"openai",providerReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:harness.repo,platform:process.platform,version:"muse-e2e-fixture",activeEnvironment:null,activeEnvironmentId:null}));
  await page.route(/\/api\/runtime$/,route=>json(route,{agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",agentRuntimeStatus:status,provider:"openai",providerReady:true,appServerReady:true,appServerExitCode:null,activeEnvironment:null,appServerError:null,logs:[]}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[project],activeProjectId:project.id,threadMeta:{}}));
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,Object.assign(settings,route.request().postDataJSON()||{})):json(route,settings));
  await page.route(/\/api\/models$/,route=>json(route,{agentRuntime:"muse",ready:true,models:listed.models,defaultModel:listed.preferred||null,metadata:{provider:"muse",agentRuntime:"muse",source:listed.source,models:listed.metadata},error:listed.error||null}));
  await page.route(/\/api\/agent-runtimes$/,async route=>json(route,await manager.snapshot()));
  await page.route(/\/api\/agent-runtime-auth$/,route=>{
    const body=route.request().postDataJSON()||{};signIns.push(body);
    const {prelude,...auth}=manager.authCommand(body.instanceId||body.runtime,{action:"login"});
    const session={id:"muse-sign-in",name:auth.name+" sign in",cwd:body.cwd||harness.repo,environmentId:null,environmentName:"Local machine",environmentType:"local",cols:120,rows:32,running:true,exitCode:null,createdAt:Date.now(),updatedAt:Date.now(),buffer:""};
    terminals.push({session,typed:interactiveTerminalCommand(auth.command,auth.args)});
    return json(route,{ok:true,auth,session});
  });
  await page.route(/\/api\/terminal\/sessions(?:\?.*)?$/,route=>route.request().method()==="GET"?json(route,{sessions:terminals.map(item=>item.session)}):route.fallback());
  await page.route(/\/api\/project-script\/runs(?:\?.*)?$/,route=>json(route,{runs:{}}));
  await page.routeWebSocket(/\/api\/terminal\/ws\?/,ws=>{
    const url=new URL(ws.url()),found=terminals.find(item=>item.session.id===url.searchParams.get("session"));
    if(url.searchParams.get("watch")==="1"){ws.send(JSON.stringify({type:"state",running:Boolean(found),exitCode:null}));return}
    ws.send(JSON.stringify({type:"snapshot",session:{...(found?.session||{}),buffer:found?`${harness.repo}>${found.typed}\r\n`:""}}));
  });
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
  return {status,listed,signIns};
}
async function switchMode(page,mode){
  const html=page.locator("html");if(await html.getAttribute("data-mode")===mode)return;
  await page.getByTestId("appearance-toggle").first().click();await expect(html).toHaveAttribute("data-mode",mode);
}

test("Settings lists Muse Code with its version, and Sign in opens a Trebell terminal running Muse Code's own `muse login`",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startMuseHarness();
  try{
    const {status,signIns}=await routeMuseApp(page,harness);
    expect(status.version).toBe("1.4.13-R6996.1");
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    const row=page.locator(".agent-runtime-option").filter({hasText:"Muse Code"});
    await expect(row).toHaveCount(1);
    await expect(row.locator("small")).toHaveText("1.4.13-R6996.1");
    await expect(row.getByText("Active",{exact:true})).toBeVisible();
    await expect(page.locator(".agent-runtime-settings")).toContainText("Antigravity and Muse Code run as their real harnesses");
    // Muse Code does not say whether it is signed in (its turns do), so it offers Sign in; Trebell does not install it.
    await expect(row.getByRole("button",{name:"Sign in",exact:true})).toBeVisible();
    await expect(row.getByRole("button",{name:/^(Install|Update)$/})).toHaveCount(0);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await row.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`settings-muse-row-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    await row.getByRole("button",{name:"Sign in",exact:true}).click();
    await expect.poll(()=>signIns.length).toBe(1);
    expect(signIns[0]).toMatchObject({action:"login",runtime:"muse",instanceId:"muse-default"});
    const drawer=page.getByTestId("drawer"),screen=drawer.locator(".terminal-pane.active .terminal-screen");
    await expect(drawer.locator(".terminal-tab")).toHaveCount(1);
    await expect(drawer.locator(".terminal-tab")).toContainText("Muse Code sign in");
    await expect(screen).toContainText(harness.launcher);
    await expect(screen).toContainText(/muse(\.cmd)?"? login\s*$/);
    // The terminal comes up over the workspace, where the sign-in goes on in Muse Code's own words.
    await expect(page.getByRole("button",{name:"Muse Code sign in",exact:true})).toBeVisible();
    for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:auditDir+`settings-muse-sign-in-terminal-${mode}-1280x800.png`})}
  }finally{await harness.close()}
});

test("the composer lists Muse Code's models and the Thinking levels each offers, a turn runs on the model and level picked, and the sidebar names Muse Code",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startMuseHarness();
  try{
    await routeMuseApp(page,harness);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await expect(page.locator(".sidebar-provider strong")).toHaveText("Muse Code");
    const picker=page.getByTestId("model-picker"),thinking=page.getByTestId("reasoning-effort-picker");
    await expect(picker).toContainText("Muse Spark 1.2","a new chat starts on Muse's own default model");
    await picker.click();
    const menu=page.locator(".model-picker-menu");
    // Muse's own list, by the names it gives (a bare muse-* id title-cased), each row naming Muse Code; the local provider's row
    // and the second muse-spark-1.3 row are left out.
    await expect(menu.locator("button strong")).toHaveText(["Muse Wonder 1.0","Muse Spark 1.3","Muse Spark 1.2","Muse Spark 1.3 Contributor"]);
    await expect(menu.locator("button").first()).toContainText("Muse Code");
    await expect(menu).not.toContainText("Local coder");
    for(const mode of ["dark","light"]){await switchMode(page,mode);if(!await menu.isVisible())await picker.click();await page.screenshot({animations:"disabled",path:auditDir+`composer-muse-models-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    if(!await menu.isVisible())await picker.click();
    await menu.getByRole("button",{name:/Muse Wonder 1\.0/}).click();
    await expect(picker).toContainText("Muse Wonder 1.0");
    // Wonder's own levels, Minimal to Max; None, which Meta's provider refuses, is not one.
    await expect(thinking.locator("option")).toHaveText(["Thinking · Default","Thinking · Minimal","Thinking · Low","Thinking · Medium","Thinking · High","Thinking · Extra High","Thinking · Max"]);
    await thinking.selectOption({label:"Thinking · Extra High"});
    await expect(thinking).toHaveValue("xhigh");
    for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:auditDir+`composer-muse-thinking-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    const composer=page.getByTestId("composer");
    await composer.click();await page.keyboard.type("Hello Muse");await page.keyboard.press("Enter");
    await expect(page.getByText("Muse fixture reply on muse-wonder-1.0 at xhigh effort.")).toBeVisible({timeout:20_000});
    const [start]=await harness.frames("session/start"),[turn]=await harness.frames("turn/start");
    expect([start.params.modelId,start.params.providerId]).toEqual(["muse-wonder-1.0","meta"]);
    expect(turn.params.reasoningEffort).toBe("xhigh");
    // The contributor model lists Low to High: its levels replace Wonder's, and the next turn goes there with session/setModel.
    await picker.click();await menu.getByRole("button",{name:/Muse Spark 1\.3 Contributor/}).click();
    await expect(thinking.locator("option")).toHaveText(["Thinking · Default","Thinking · Low","Thinking · Medium","Thinking · High"]);
    await thinking.selectOption({label:"Thinking · High"});
    await composer.click();await page.keyboard.type("And again");await page.keyboard.press("Enter");
    await expect(page.getByText("Muse fixture reply on muse-spark-1.3-contributor at high effort.")).toBeVisible({timeout:20_000});
    expect((await harness.frames("session/setModel")).map(frame=>frame.params.model)).toEqual([{modelId:"muse-spark-1.3-contributor",providerId:"meta"}]);
    await expect(page.locator(".sidebar-provider strong")).toHaveText("Muse Code");
    await expect(page.locator(".thread-row.active")).toContainText("muse-spark-1.3-contributor");
    for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:auditDir+`muse-thread-reply-${mode}-1280x800.png`})}
  }finally{await harness.close()}
});
