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

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("Trebell Native keeps Freebuff account surfaces available when Freebuff supplies inference",async({page})=>{
  test.setTimeout(40_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-freebuff-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"freebuff",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),model="freebuff/test/coding-fast";
  const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-freebuff-session",model,name:"Native Freebuff fixture",preview:"Freebuff Native provider fixture",providerMeta:{runtimeInstanceId:"native-default",modelProvider:"freebuff",permissionProfile:"supervised",projectless:false,environmentId:null}});
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn:async request=>{await new Promise(resolve=>setTimeout(resolve,350));return{id:"native-freebuff-reply",provider:request.provider,model:request.model,text:"Native Freebuff reply.",toolCalls:[],finishReason:"stop",usage:{}}},version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-freebuff-project",name:"Native Freebuff Project",path:repo,environmentId:null,effectiveSettings:{}};let overviewCalls=0,heartbeatCalls=0,uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  const overview={loggedIn:true,user:{email:"native@example.test"},streak:{streak:9,freebucksDailyBonus:2},instanceId:"native-freebuff-fixture",derived:{balance:321,sessionStatus:"active",activeModel:model,selectedModel:model,selectedPrice:{current:7,source:"server"},priceByModel:{[model]:{current:7,source:"server"}},rateLimit:{remaining:44,limit:50},timezone:"Asia/Kolkata"}};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:[model],metadata:{provider:"freebuff",models:[{id:model,name:"Coding Fast",provider:"freebuff",agent:"Trebell Native"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]})}));
    await page.route(/\/api\/freebuff\/overview(?:\?.*)?$/,route=>{overviewCalls++;return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(overview)})});
    await page.route(/\/api\/freebuff\/heartbeat(?:\?.*)?$/,route=>{heartbeatCalls++;return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})})});
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();uiMeta={...uiMeta,...(body?.patch||{})}}await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(uiMeta)})});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{id:"native-freebuff-checkpoint",threadId:thread.id}:{checkpoints:[]})}));
    await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"native-freebuff-context",skipped:true,budget:{reserveTokens:1024}})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");const providerButton=page.locator(".sidebar-provider");await expect(providerButton).toContainText("Trebell Native");await expect(providerButton).toContainText("Freebuff inference");await expect.poll(()=>overviewCalls).toBeGreaterThan(0);
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native Freebuff fixture"]')});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();await page.getByTestId("composer").fill("Use Freebuff through Native");await page.getByTestId("send").click();await expect.poll(()=>heartbeatCalls,{timeout:5000}).toBeGreaterThan(0);await expect(page.getByText("Native Freebuff reply.",{exact:true})).toBeVisible({timeout:10_000});
    await providerButton.click();await expect(page.getByRole("heading",{name:"Freebuff",level:1})).toBeVisible();await expect(page.locator(".freebuff-page")).toContainText("native@example.test");await expect(page.locator(".freebuff-page")).toContainText("321");
    await page.screenshot({path:auditDir+"native-freebuff-1600x980.png",fullPage:true});await page.setViewportSize({width:1280,height:800});await expect(page.locator(".freebuff-page")).toBeVisible();const metrics=await page.locator(".freebuff-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({path:auditDir+"native-freebuff-1280x800.png",fullPage:true});
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
