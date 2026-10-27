import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { chmod,mkdir,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { HARNESS_TEXT_INSTRUCTIONS,generateTextWithHarness } from "../../src/harness-text-generation.mjs";
import { keepThreadMeta } from "./test-home.js";

// Generate in the Git panel with Muse Code active, as the person meets it: Muse Code writes the commit message. The panel's request
// is answered as the GUI server answers it, by the active harness's Git text writer (generateTextWithHarness, which gui-server.mjs
// hands the commit prompt), here with the real runtime manager on the stand-in Muse Code (tests/fixtures/muse/fake-muse.cjs), which
// records how Trebell started it and what it sent. Beside the page run the real agent relay and runtime manager, as for a Muse thread.
const auditDir=fileURLToPath(new URL("../../visual-audit/muse-git-text/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const FAKE_MUSE=fileURLToPath(new URL("../../tests/fixtures/muse/fake-muse.cjs",import.meta.url));
const MODEL_LIST=fileURLToPath(new URL("../../tests/fixtures/muse/model-list-1.4.13.json",import.meta.url));
const windows=process.platform==="win32";
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
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
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-git-text-")),repo=join(root,"muse-repo"),log=join(root,"muse.log");await mkdir(repo,{recursive:true});
  const folder=windows?join(root,"AppData","Local","Programs","muse"):join(root,"home",".local","bin");await mkdir(folder,{recursive:true});
  const launcher=join(folder,windows?"muse.cmd":"muse");
  await writeFile(launcher,windows?`@echo off\r\nsetlocal\r\n"${process.execPath}" "${FAKE_MUSE}" %*\r\nexit /b %ERRORLEVEL%\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${FAKE_MUSE}" "$@"\n`);
  if(!windows)await chmod(launcher,0o755);
  const settings={agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",activeEnvironmentId:null,mcpServers:[],agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,binaryPath:null,environment:{MUSE_FAKE_LOG:log,MUSE_FAKE_MODELS:MODEL_LIST}}]},meta=new Map();
  const state={settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const env={...process.env,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"codex"),CLAUDE_CONFIG_DIR:join(root,"claude"),MUSE_INSTALL_DIR:"",...(windows?{LOCALAPPDATA:join(root,"AppData","Local")}:{HOME:join(root,"home")})};
  const runtimeManager=new AgentRuntimeManager({state,env,runFn:onlyMuse(launcher)}),threadStore=new AgentThreadStore(env);
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,version:"muse-git-text-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const entries=async()=>(await readFile(log,"utf8").catch(()=>"")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  return {
    root,repo,settings,runtimeManager,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,
    frames:async method=>(await entries()).filter(entry=>entry.frame?.method===method).map(entry=>entry.frame),
    hosts:async()=>(await entries()).filter(entry=>entry.start?.[0]==="serve"&&!entry.start.includes("--no-session-log")),
    async close(){await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})},
  };
}
// The commit prompt as the GUI server words it (gui-server.mjs sourceControlTextRequest), for one changed file.
const COMMIT_PROMPT=["Write one Git commit subject for the current change.","Keep the subject under 100 characters. Return only the subject with no quotes or markdown.","Status:\n M src/greeting.js","Diff:\n+export const greeting = \"hello\";"].join("\n\n");
// The app's endpoints for a window on Muse Code in a Git project with one changed file, answered from the harness's runtime manager
// as the GUI server answers them; the commit message is written by Muse Code through Trebell's Git text writer.
async function routeMuseApp(page,harness,generated){
  const manager=harness.runtimeManager,status=await manager.probe("muse",{fresh:true}),listed=await manager.models("muse");
  const project={id:"muse-project",name:"Muse Project",path:harness.repo,environmentId:null,effectiveSettings:{}};
  const settings=Object.assign(harness.settings,{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"});
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",runtimeCapabilities:manager.capabilities("muse"),agentRuntimeReady:true,agentRuntimeStatus:status,provider:"openai",providerReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:harness.repo,platform:process.platform,version:"muse-git-text-fixture",activeEnvironment:null,activeEnvironmentId:null}));
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
  await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:true,cwd:harness.repo,root:harness.repo,branch:"main",branches:["main"],upstream:"origin/main",status:[{code:" M",path:"src/greeting.js"}],worktrees:[{path:harness.repo,branch:"main"}],remotes:[{name:"origin",url:"https://example.test/repo.git"}]}));
  await page.route(/\/api\/source-control\/diagnostics(?:\?.*)?$/,route=>json(route,{selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{create:true,comment:true,review:true,merge:true}}}));
  await page.route(/\/api\/source-control\/prs(?:\?.*)?$/,route=>json(route,{provider:"github",capabilities:{create:true,comment:true,review:true,merge:true},items:[]}));
  await page.route(/\/api\/git\/commit-message$/,async route=>{
    const body=route.request().postDataJSON()||{};generated.requests.push(body);
    try{
      const text=await generateTextWithHarness({runtimeManager:manager,instance:manager.activeInstance(),prompt:COMMIT_PROMPT,cwd:harness.repo,models:[body.model].filter(Boolean),version:"muse-git-text-fixture"});
      generated.results.push(text);
      return json(route,{message:text.text.split(/\r?\n/)[0].trim(),style:"repository",model:text.model,runtime:text.runtime,generatedWith:text.name});
    }catch(error){generated.errors.push(error.message);return json(route,{error:error.message},400)}
  });
  await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{id:"muse-checkpoint-"+Date.now(),threadId:null}:{checkpoints:[]}));
  await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"muse-context",skipped:true,budget:{reserveTokens:1024}}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
}
async function switchMode(page,mode){
  const html=page.locator("html");if(await html.getAttribute("data-mode")===mode)return;
  await page.getByTestId("appearance-toggle").first().click();await expect(html).toHaveAttribute("data-mode",mode);
}
async function shoot(page,name){for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:auditDir+`${name}-${mode}-1280x800.png`})}await switchMode(page,"dark")}

test("Generate with Muse Code writes the commit message through Muse Code, on a read-only host in an empty folder",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startMuseHarness(),generated={requests:[],results:[],errors:[]};
  try{
    await routeMuseApp(page,harness,generated);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible({timeout:20_000});
    await page.getByTestId("right-panel-toggle").click();
    const right=page.getByTestId("right-panel");await right.getByRole("button",{name:"Git",exact:true}).click();
    await expect(right.locator(".status-list > div")).toHaveCount(1);
    const generate=right.getByRole("button",{name:"Generate with Muse Code",exact:true}),message=right.getByPlaceholder("Commit message");
    await expect(generate).toBeVisible({timeout:10_000});
    const hostsBefore=(await harness.hosts()).length;
    await generate.click();
    // The stand-in's reply names the model the session ran and the Thinking level of its turn.
    await expect(message).toHaveValue(/^Muse fixture reply on muse-spark-1\.2 at low effort\.$/,{timeout:30_000});
    await expect(right.locator(".source-control-error")).toHaveCount(0);
    expect(generated.errors).toEqual([]);
    expect(generated.results.at(-1)).toMatchObject({runtime:"muse",name:"Muse Code",model:"muse-spark-1.2"});
    // One host of its own for the request: Muse's read-only serve (no shell, no writes, no workspace trust), its session log kept, in
    // an empty folder that is not the repository, with a session that denies whatever its policy does not allow.
    const hosts=await harness.hosts(),host=hosts.at(-1);
    expect(hosts.length).toBe(hostsBefore+1);
    expect(host.start).toEqual(["serve","--disable-shell","--disable-write"]);
    expect(resolve(host.cwd)).not.toBe(resolve(harness.repo));expect(basename(host.cwd)).toMatch(/^trebell-git-text-/);
    const [start]=await harness.frames("session/start");
    expect({providerId:start.params.providerId,modelId:start.params.modelId,approvalMode:start.params.approvalMode}).toEqual({providerId:"meta",modelId:"muse-spark-1.2",approvalMode:"denyUnmatched"});
    const [turn]=await harness.frames("turn/start");
    expect(turn.params.reasoningEffort).toBe("low");
    expect(turn.params.input).toEqual([{type:"text",text:HARNESS_TEXT_INSTRUCTIONS+"\n\n"+COMMIT_PROMPT}]);
    await expect(right.locator(".commit-box")).toBeVisible();
    await shoot(page,"muse-commit-message");
  }finally{await harness.close()}
});
