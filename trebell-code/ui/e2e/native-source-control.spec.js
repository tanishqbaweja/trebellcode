import { test,expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";

const execFileAsync=promisify(execFile),auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function git(cwd,args){return execFileAsync("git",args,{cwd,windowsHide:true,encoding:"utf8"})}
async function gitInfo(cwd){
  const root=(await git(cwd,["rev-parse","--show-toplevel"])).stdout.trim(),branch=(await git(root,["branch","--show-current"])).stdout.trim(),branches=(await git(root,["for-each-ref","--format=%(refname:short)","refs/heads"])).stdout.split(/\r?\n/).filter(Boolean),status=(await git(root,["status","--porcelain=v1"])).stdout.split(/\r?\n/).filter(Boolean).map(line=>({code:line.slice(0,2),path:line.slice(3)}));
  return {isGit:true,cwd,root,branch,branches,status,statusHeader:"",upstream:null,remotes:[],worktrees:[{path:root,branch}]};
}

test("Trebell Native can create a Git branch directly and the Git panel reflects it",async({page})=>{
  test.setTimeout(45_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-source-ui-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});await git(repo,["init"]);await git(repo,["config","user.email","trebell-test@example.invalid"]);await git(repo,["config","user.name","Trebell Test"]);await writeFile(join(repo,"README.md"),"seed\n","utf8");await git(repo,["add","README.md"]);await git(repo,["commit","-m","seed"]);
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-source-ui",model:"gpt-5.6",name:"Native source-control fixture",preview:"Git branch fixture",providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"auto",projectless:false,environmentId:null,dynamicToolNamespaces:["trebell_source_control"]}});
  let calls=0;const nativeProviderTurn=async request=>{calls++;if(calls===1)return{id:"source-ui-tool",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"source-ui-1",namespace:"trebell_source_control",name:"branch_create",arguments:JSON.stringify({name:"trebell/native-ui-proof"})}],finishReason:"tool_calls",usage:{}};return{id:"source-ui-answer",provider:request.provider,model:request.model,text:"Created the Trebell proof branch.",toolCalls:[],finishReason:"stop",usage:{}}};
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-source-project",name:"Native Source Project",path:repo,environmentId:null,effectiveSettings:{}};let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();uiMeta={...uiMeta,...(body?.patch||{})}}await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(uiMeta)})});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{id:"source-ui-checkpoint",threadId:thread.id}:{checkpoints:[]})}));
    await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"source-ui-context",skipped:true,budget:{reserveTokens:1024}})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,async route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(await gitInfo(repo))}));
    await page.route(/\/api\/source-control\/diagnostics(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({selectedProvider:"",detectedProvider:"unknown",capabilities:{}})}));
    await page.route(/\/api\/source-control\/prs(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[],capabilities:{create:true,comment:true,review:true,merge:true,updateBranch:true}})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:500,terminalHeight:330})));
    await page.goto("/");const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native source-control fixture"]')});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    const composer=page.getByTestId("composer");await composer.fill("Create a proof branch");await page.getByTestId("send").click();await expect(page.getByText("Created the Trebell proof branch.",{exact:true})).toBeVisible({timeout:10_000});await expect(page.getByText("trebell_source_control / branch_create",{exact:true})).toBeVisible();
    await expect(page.locator(".branch-control")).toContainText("trebell/native-ui-proof",{timeout:3000});
    await page.getByTestId("right-panel-toggle").click();const panel=page.getByTestId("right-panel");await panel.getByRole("button",{name:"Git",exact:true}).click();await expect(panel.locator("select").first()).toHaveValue("trebell/native-ui-proof",{timeout:10_000});
    let metrics=await panel.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({path:auditDir+"native-source-control-1600x980.png",fullPage:true});
    await page.setViewportSize({width:1280,height:800});await expect(panel.locator("select").first()).toHaveValue("trebell/native-ui-proof");metrics=await panel.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({path:auditDir+"native-source-control-1280x800.png",fullPage:true});
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
