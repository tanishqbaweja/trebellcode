import { test,expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm,stat,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";

const execFileAsync=promisify(execFile),auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function git(cwd,args){return execFileAsync("git",args,{cwd,windowsHide:true,encoding:"utf8"})}

test("Trebell Native multi-model fan-out launches real isolated worktrees and provider turns",async({page})=>{
  test.setTimeout(55_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-fanout-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","trebell-test@example.invalid"]);await git(repo,["config","user.name","Trebell Test"]);await writeFile(join(repo,"README.md"),"seed\n","utf8");await git(repo,["add","README.md"]);await git(repo,["commit","-m","seed"]);const baseBranch=(await git(repo,["branch","--show-current"])).stdout.trim();
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),providerCalls=[],worktrees=[];
  const nativeProviderTurn=async request=>{providerCalls.push({model:request.model,provider:request.provider});await new Promise(resolve=>setTimeout(resolve,80));return{id:"native-fanout-"+request.model,provider:request.provider,model:request.model,text:`Completed ${request.model}.`,toolCalls:[],finishReason:"stop",usage:{}}};
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-fanout-project",name:"Native Fan-out Project",path:repo,environmentId:null,effectiveSettings:{defaultWorkspaceMode:"current"}},metaByThread={};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:metaByThread})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["model-a","model-b"],metadata:{provider:"agentrouter",models:[{id:"model-a",name:"Model A",provider:"agentrouter",agent:"Trebell Native"},{id:"model-b",name:"Model B",provider:"agentrouter",agent:"Trebell Native"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({project:{...project,id:"project-"+worktrees.length,path:body.path,environmentId:body.environmentId||null}})})}return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[project],project})})});
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,cwd:repo,root:repo,branch:baseBranch,branches:[baseBranch],status:[],remotes:[],worktrees:[{path:repo,branch:baseBranch}]})}));
    await page.route(/\/api\/git\/action$/,async route=>{const body=route.request().postDataJSON();expect(body.action).toBe("worktree-create");await git(repo,["worktree","add","-b",body.branch,body.path,"HEAD"]);worktrees.push(body.path);return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,result:{worktree:body.path,info:{root:body.path,branch:body.branch}}})})});
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();metaByThread[body.threadId]={...(metaByThread[body.threadId]||{}),...(body.patch||{})};return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(metaByThread[body.threadId])})}const id=new URL(route.request().url()).searchParams.get("threadId");return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(metaByThread[id]||{})})});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{supported:false}:{checkpoints:[]})}));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"native-fanout-context",skipped:true,budget:{mode:"skip",pressure:"normal",reserveTokens:1024,maxTokens:0,maxFiles:0}})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:280,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");await expect(page.locator(".branch-control")).toContainText(baseBranch,{timeout:10_000});
    const picker=page.getByTestId("model-picker");await picker.click();const menu=page.locator(".model-picker-menu");await expect(menu).toContainText("Shift-click to select multiple models");await menu.getByRole("button",{name:/Model B/}).click({modifiers:["Shift"]});await expect(picker).toContainText("2 models");
    const composer=page.getByTestId("composer");await composer.fill("Run this task with both Native models");await page.getByTestId("send").click();
    await expect.poll(()=>worktrees.length,{timeout:10_000}).toBe(2);await expect.poll(()=>providerCalls.length,{timeout:15_000}).toBe(2);expect(new Set(providerCalls.map(call=>call.model))).toEqual(new Set(["model-a","model-b"]));expect(providerCalls.every(call=>call.provider==="agentrouter")).toBe(true);
    const threads=threadStore.list("native");expect(threads).toHaveLength(2);expect(new Set(threads.map(thread=>thread.cwd)).size).toBe(2);expect(threads.every(thread=>worktrees.includes(thread.cwd))).toBe(true);for(const path of worktrees)await expect.poll(async()=>{try{await stat(path);return true}catch{return false}}).toBe(true);
    await expect(page.locator(".thread-row")).toHaveCount(2);await page.setViewportSize({width:1280,height:800});const metrics=await page.locator(".app-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({path:auditDir+"native-multimodel-fanout-1280x800.png",fullPage:true});
  }finally{
    await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));for(const path of [...worktrees].reverse())await git(repo,["worktree","remove","--force",path]).catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
