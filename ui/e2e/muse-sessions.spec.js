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

// Muse Code as the person meets it in Trebell: an MCP server saved in Settings for Muse Code reaching its session beside Trebell's
// repository tools. Behind the page run the real agent relay and runtime manager on the stand-in Muse Code
// (tests/fixtures/muse/fake-muse.cjs), which records what Trebell sends it.
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
// environment: the stand-in's switches, as the Muse Code profile's own variables. The relay has a context engine, so each thread
// with a project gets Trebell's repository tools, as the app's does.
async function startMuseHarness({environment={}}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-sessions-")),repo=join(root,"muse-repo"),log=join(root,"muse.log");await mkdir(repo,{recursive:true});
  const folder=windows?join(root,"AppData","Local","Programs","muse"):join(root,"home",".local","bin");await mkdir(folder,{recursive:true});
  const launcher=join(folder,windows?"muse.cmd":"muse");
  await writeFile(launcher,windows?`@echo off\r\nsetlocal\r\n"${process.execPath}" "${FAKE_MUSE}" %*\r\nexit /b %ERRORLEVEL%\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${FAKE_MUSE}" "$@"\n`);
  if(!windows)await chmod(launcher,0o755);
  const settings={agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",activeEnvironmentId:null,mcpServers:[],agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,binaryPath:null,environment:{MUSE_FAKE_LOG:log,MUSE_FAKE_MODELS:MODEL_LIST,...environment}}]},meta=new Map();
  const state={settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const env={...process.env,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"codex"),CLAUDE_CONFIG_DIR:join(root,"claude"),MUSE_INSTALL_DIR:"",...(windows?{LOCALAPPDATA:join(root,"AppData","Local")}:{HOME:join(root,"home")})};
  const runtimeManager=new AgentRuntimeManager({state,env,runFn:onlyMuse(launcher)}),threadStore=new AgentThreadStore(env);
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:{},version:"muse-sessions-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const frames=async method=>(await readFile(log,"utf8").catch(()=>"")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(entry=>entry.frame?.method===method).map(entry=>entry.frame);
  return {
    root,repo,settings,runtimeManager,frames,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,
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
