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

test("Native usage estimates use the price for the recorded inference provider",async({page})=>{
  test.setTimeout(35_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-usage-pricing-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const customModels=[
    {id:"shared-model",name:"Shared AgentRouter",runtime:"native",provider:"agentrouter",inputPrice:1,outputPrice:2},
    {id:"shared-model",name:"Shared HCNSec",runtime:"native",provider:"hcnsec",inputPrice:10,outputPrice:20},
  ];
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"hcnsec",activeEnvironmentId:null,customModels});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn:async request=>({id:"unused-native-usage",provider:request.provider,model:request.model,text:"",toolCalls:[],finishReason:"stop",usage:{}}),version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const usageRecord={id:"native-hcnsec-usage",at:Date.now(),runtime:"native",provider:"hcnsec",model:"shared-model",environmentId:null,usage:{inputTokens:1_000_000,outputTokens:1_000_000,totalTokens:2_000_000,cachedInputTokens:0,cacheWriteInputTokens:0}};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"hcnsec",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"hcnsec",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",customModels},projects:[],activeProjectId:null,threadMeta:{}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({provider:"hcnsec",agentRuntime:"native",ready:true,models:["shared-model"],metadata:{provider:"hcnsec",models:[{id:"shared-model",name:"Shared HCNSec",provider:"hcnsec",agent:"Trebell Native",custom:true}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]})}));
    await page.route(/\/api\/usage(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({records:[usageRecord],total:{inputTokens:1_000_000,outputTokens:1_000_000,totalTokens:2_000_000,cachedInputTokens:0},models:{},runtimes:{native:{totalTokens:2_000_000}},daily:{}})}));
    await page.route(/\/api\/environments$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({profiles:[],activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.goto("/");await page.getByRole("button",{name:"Usage",exact:true}).click();const usage=page.locator(".usage-page");await expect(usage).toBeVisible();await expect(usage.locator(".usage-summary")).toContainText("$30.00");const recent=usage.locator(".usage-recent");await expect(recent).toContainText("Trebell Native");await expect(recent).toContainText("shared-model");await expect(recent).toContainText("≈$30.00");
    await page.setViewportSize({width:1280,height:800});const metrics=await usage.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({path:auditDir+"native-usage-pricing-1280x800.png",fullPage:true});
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
