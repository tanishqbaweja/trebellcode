import { test,expect } from "@playwright/test";
import assert from "node:assert/strict";
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
const IMAGE_DATA_URL="data:image/png;base64,iVBORw0KGgo=";
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("Trebell Native expands browser tools on a later turn and receives the screenshot on the same thread",async({page})=>{
  test.setTimeout(40_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-browser-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-browser-session",model:"model-a",name:"Native browser fixture",preview:"Browser screenshot fixture",providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"read-only",projectless:false,environmentId:null,dynamicToolNamespaces:[]}});
  let calls=0;
  const nativeProviderTurn=async request=>{
    calls++;const browser=(request.tools||[]).find(item=>item.name==="trebell_browser");
    if(calls===1){assert.equal(browser,undefined);return{id:"plain-turn-done",provider:request.provider,model:request.model,text:"Parser check done.",toolCalls:[],finishReason:"stop",usage:{}}}
    assert.ok(browser);assert.ok(browser.tools.some(tool=>tool.name==="screenshot"));assert.ok(request.messages.some(message=>message.role==="assistant"&&String(message.content||"").includes("Parser check done.")));
    if(calls===2)return{id:"browser-shot-call",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"browser-shot-1",namespace:"trebell_browser",name:"screenshot",arguments:"{}"}],finishReason:"tool_calls",usage:{}};
    const observation=request.messages.at(-1);assert.equal(observation.role,"tool");assert.ok(Array.isArray(observation.content));assert.ok(observation.content.some(item=>item.type==="text"&&/untrusted external tool data/i.test(item.text||"")));assert.ok(observation.content.some(item=>item.type==="image_url"&&item.image_url?.url===IMAGE_DATA_URL));
    return{id:"browser-shot-done",provider:request.provider,model:request.model,text:"Browser screenshot received.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-browser-project",name:"Native Browser Project",path:repo,environmentId:null,effectiveSettings:{}};let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  try{
    await page.addInitScript(({image})=>{window.__browserScreenshotCalls=0;window.trebellDesktop={browser:{screenshot:async()=>{window.__browserScreenshotCalls++;return{dataUrl:image,url:"https://example.test",title:"Fixture page",width:1280,height:800}}}}},{image:IMAGE_DATA_URL});
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"read-only",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["model-a"],metadata:{provider:"agentrouter",models:[{id:"model-a",name:"Model A",provider:"agentrouter",agent:"Trebell Native"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]})}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();uiMeta={...uiMeta,...(body?.patch||{})}}await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(uiMeta)})});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{supported:false}:{checkpoints:[]})}));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"native-browser-context",skipped:true,budget:{reserveTokens:1024}})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native browser fixture"]')});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    const composer=page.getByTestId("composer");await composer.fill("Check the parser status");await page.getByTestId("send").click();await expect(page.getByText("Parser check done.",{exact:true})).toBeVisible({timeout:10_000});assert.deepEqual(threadStore.get(thread.id).providerMeta.dynamicToolNamespaces,[]);
    await composer.fill("Now take a browser screenshot to verify the frontend");await page.getByTestId("send").click();await expect(page.getByText("Browser screenshot received.",{exact:true})).toBeVisible({timeout:10_000});expect(await page.evaluate(()=>window.__browserScreenshotCalls)).toBe(1);assert.deepEqual(threadStore.get(thread.id).providerMeta.dynamicToolNamespaces,["trebell_browser"]);assert.equal(threadStore.get(thread.id).turns.length,2);
    await expect(page.getByText("trebell_browser / screenshot",{exact:true})).toBeVisible();await page.setViewportSize({width:1280,height:800});const metrics=await page.locator(".workspace-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({path:auditDir+"native-browser-tool-1280x800.png",fullPage:true});
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
