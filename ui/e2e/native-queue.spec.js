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

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test("Trebell Native project threads use the durable runtime follow-up queue",async({page})=>{
  test.setTimeout(45_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-project-queue-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const thread=threadStore.create({
    runtime:"native",cwd:repo,providerSessionId:"native-project-queue",model:"gpt-5.6",name:"Native durable queue",preview:"Project follow-up queue",
    providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"supervised",projectless:false,environmentId:null},
  });
  let providerCalls=0,firstStartedResolve,releaseFirstResolve,secondStartedResolve;
  const firstStarted=new Promise(resolve=>{firstStartedResolve=resolve}),releaseFirst=new Promise(resolve=>{releaseFirstResolve=resolve}),secondStarted=new Promise(resolve=>{secondStartedResolve=resolve});
  const nativeProviderTurn=async request=>{
    providerCalls++;
    if(providerCalls===1){firstStartedResolve();await releaseFirst;return{id:"queue-first",provider:request.provider,model:request.model,text:"Initial work complete.",toolCalls:[],finishReason:"stop",usage:{}}}
    secondStartedResolve();return{id:"queue-second",provider:request.provider,model:request.model,text:"Queued work complete.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-queue-project",name:"Native Queue Project",path:repo,environmentId:null,effectiveSettings:{}};
  let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      mock:false,loggedIn:true,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,
      wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null,
    })}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},
      projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta},
    })}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,branch:"main",root:repo})}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{
      if(route.request().method()==="POST"){const body=route.request().postDataJSON();uiMeta={...uiMeta,...(body?.patch||{})}}
      await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(uiMeta)});
    });
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{id:"queue-checkpoint",threadId:thread.id}:{checkpoints:[]})}));
    await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"queue-context",skipped:true,budget:{reserveTokens:1024}})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native durable queue"]')});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    const composer=page.getByTestId("composer");await expect(composer).toBeVisible();await composer.fill("Initial project work");await page.getByTestId("send").click();await firstStarted;
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeVisible();await expect(composer).toHaveAttribute("placeholder","Queue a follow-up…");
    await composer.fill("Queued project follow-up");await page.getByTestId("send").click();
    const queued=page.locator(".queued-message");await expect(queued).toContainText("Queued in Trebell Native");await expect(queued).toContainText("Queued project follow-up");
    const persistedWhileRunning=state.threadMeta(thread.id);expect(persistedWhileRunning.queuedSubmissions).toHaveLength(1);expect(persistedWhileRunning.trebellQueue||[]).toHaveLength(0);
    let metrics=await page.locator(".workspace-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await page.screenshot({path:auditDir+"native-project-durable-queue-1600x980.png",fullPage:true});
    await page.setViewportSize({width:1280,height:800});await expect(queued).toBeVisible();metrics=await page.locator(".workspace-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await page.screenshot({path:auditDir+"native-project-durable-queue-1280x800.png",fullPage:true});
    releaseFirstResolve();await secondStarted;await expect(queued).toHaveCount(0,{timeout:10_000});
    for(let attempt=0;attempt<100&&(state.threadMeta(thread.id).queuedSubmissions||[]).length;attempt++)await new Promise(resolve=>setTimeout(resolve,20));
    expect(state.threadMeta(thread.id).queuedSubmissions||[]).toHaveLength(0);expect(providerCalls).toBe(2);
  }finally{
    releaseFirstResolve?.();await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true});
  }
});
