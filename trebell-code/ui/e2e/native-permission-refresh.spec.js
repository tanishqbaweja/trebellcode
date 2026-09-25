import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,readFile,rm } from "node:fs/promises";
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

test("Native permission picker updates the policy of an already-open thread",async({page})=>{
  test.setTimeout(40_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-permission-ui-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),model="model-a";
  const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-permission-ui",model,name:"Native permission refresh",preview:"Permission refresh fixture",providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"auto",projectless:false,environmentId:null}});
  let providerCall=0;
  const nativeProviderTurn=async request=>{
    providerCall++;
    if(providerCall===1)return{id:"ui-permission-write-1",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"ui-permission-tool-1",namespace:"trebell_workspace",name:"write_file",arguments:JSON.stringify({path:"allowed.txt",content:"allowed"})}],finishReason:"tool_calls",usage:{}};
    if(providerCall===2)return{id:"ui-permission-done-1",provider:request.provider,model:request.model,text:"Auto mode allowed the first write.",toolCalls:[],finishReason:"stop",usage:{}};
    if(providerCall===3)return{id:"ui-permission-write-2",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"ui-permission-tool-2",namespace:"trebell_workspace",name:"write_file",arguments:JSON.stringify({path:"blocked.txt",content:"blocked"})}],finishReason:"tool_calls",usage:{}};
    expect(request.messages.at(-1)?.content||"").toMatch(/read[- ]only|rejected|blocked|not permitted/i);return{id:"ui-permission-done-2",provider:request.provider,model:request.model,text:"Read-only mode blocked the second write.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-permission-project",name:"Native Permission Project",path:repo,environmentId:null,effectiveSettings:{}},uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({provider:"agentrouter",agentRuntime:"native",ready:true,models:[model],metadata:{provider:"agentrouter",models:[{id:model,name:"Model A",provider:"agentrouter",agent:"Trebell Native"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]})}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(uiMeta)}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{id:`permission-checkpoint-${Date.now()}`,threadId:thread.id}:{checkpoints:[]})}));
    await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"permission-context",skipped:true,budget:{reserveTokens:1024}})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.goto("/");const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native permission refresh"]')});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    const composer=page.getByTestId("composer"),permission=page.locator(".permission-picker").first();await expect(permission).toHaveValue("auto");await composer.fill("Write the first file");await page.getByTestId("send").click();await expect(page.getByText("Auto mode allowed the first write.",{exact:true})).toBeVisible({timeout:10_000});expect(await readFile(join(repo,"allowed.txt"),"utf8")).toBe("allowed");
    await permission.selectOption("read-only");await expect(permission).toHaveValue("read-only");await composer.fill("Try the second write");await page.getByTestId("send").click();await expect(page.getByText("Read-only mode blocked the second write.",{exact:true})).toBeVisible({timeout:10_000});await expect(readFile(join(repo,"blocked.txt"),"utf8")).rejects.toMatchObject({code:"ENOENT"});
    await page.setViewportSize({width:1280,height:800});const metrics=await page.locator(".workspace-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({path:auditDir+"native-permission-refresh-1280x800.png",fullPage:true});
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
