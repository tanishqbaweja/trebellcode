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
import { replyItem,routeRelayApp,startRelayHarness } from "./relay-history-harness.js";

const execFileAsync=promisify(execFile),auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function git(cwd,args){return execFileAsync("git",args,{cwd,windowsHide:true,encoding:"utf8"})}
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
const modelName=id=>"Model "+id.slice(-1).toUpperCase();
const catalog=models=>({models,metadata:{provider:"agentrouter",models:models.map(id=>({id,name:modelName(id),provider:"agentrouter",agent:"Trebell Native"}))}});

// Trebell Native on the real relay in a real Git repository, with the provider scripted: every turn answers "Completed <model>." and
// providerCalls keeps the model and provider of each (the completion gate is answered apart). worktrees: the fan-out's own, real ones.
async function startNativeFanout(page,{models}){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-fanout-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","trebell-test@example.invalid"]);await git(repo,["config","user.name","Trebell Test"]);await writeFile(join(repo,"README.md"),"seed\n","utf8");await git(repo,["add","README.md"]);await git(repo,["commit","-m","seed"]);const baseBranch=(await git(repo,["branch","--show-current"])).stdout.trim();
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),providerCalls=[],worktrees=[];
  const nativeProviderTurn=async request=>{
    if(request.metadata?.completionGate||request.responseJsonSchema?.name==="trebell_completion_gate")return{id:"native-fanout-gate",provider:request.provider,model:request.model,text:JSON.stringify({status:"complete",progress:"improved",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"The fixture turn did what it was asked."}),toolCalls:[],finishReason:"stop",usage:{}};
    providerCalls.push({model:request.model,provider:request.provider});await new Promise(resolve=>setTimeout(resolve,80));return{id:"native-fanout-"+request.model,provider:request.provider,model:request.model,text:`Completed ${request.model}.`,toolCalls:[],finishReason:"stop",usage:{}};
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-fanout-project",name:"Native Fan-out Project",path:repo,environmentId:null,effectiveSettings:{defaultWorkspaceMode:"current"}},metaByThread={};
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
  await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:metaByThread})}));
  await page.route(/\/api\/models$/,route=>json(route,catalog(models)));
  await page.route(/\/api\/projects(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({project:{...project,id:"project-"+worktrees.length,path:body.path,environmentId:body.environmentId||null}})})}return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[project],project})})});
  await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,cwd:repo,root:repo,branch:baseBranch,branches:[baseBranch],status:[],remotes:[],worktrees:[{path:repo,branch:baseBranch}]})}));
  await page.route(/\/api\/git\/action$/,async route=>{const body=route.request().postDataJSON();expect(body.action).toBe("worktree-create");await git(repo,["worktree","add","-b",body.branch,body.path,"HEAD"]);worktrees.push(body.path);return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,result:{worktree:body.path,info:{root:body.path,branch:body.branch}}})})});
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();metaByThread[body.threadId]={...(metaByThread[body.threadId]||{}),...(body.patch||{})};return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(metaByThread[body.threadId])})}const id=new URL(route.request().url()).searchParams.get("threadId");return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(metaByThread[id]||{})})});
  await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{supported:false}:{checkpoints:[]})}));
  await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"native-fanout-context",skipped:true,budget:{mode:"skip",pressure:"normal",reserveTokens:1024,maxTokens:0,maxFiles:0}})}));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  // The light and dark toggle saves its setting in the page only.
  const saved={};await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return json(route,saved)});
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:280,rightPanelWidth:460,terminalHeight:330})));
  return {
    repo,baseBranch,threadStore,providerCalls,worktrees,
    async close(){await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));for(const path of [...worktrees].reverse())await git(repo,["worktree","remove","--force",path]).catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})},
  };
}

test("Trebell Native multi-model fan-out launches real isolated worktrees and provider turns",async({page})=>{
  test.setTimeout(55_000);
  const fanout=await startNativeFanout(page,{models:["model-a","model-b"]}),{threadStore,providerCalls,worktrees}=fanout;
  try{
    await page.goto("/");await expect(page.locator(".branch-control")).toContainText(fanout.baseBranch,{timeout:10_000});
    const picker=page.getByTestId("model-picker");await picker.click();const menu=page.locator(".model-picker-menu");await expect(menu).toContainText("Shift-click to select multiple models");await menu.getByRole("button",{name:/Model B/}).click({modifiers:["Shift"]});await expect(picker).toContainText("2 models");
    const composer=page.getByTestId("composer");await composer.fill("Run this task with both Native models");await page.getByTestId("send").click();
    await expect.poll(()=>worktrees.length,{timeout:10_000}).toBe(2);await expect.poll(()=>providerCalls.length,{timeout:15_000}).toBe(2);expect(new Set(providerCalls.map(call=>call.model))).toEqual(new Set(["model-a","model-b"]));expect(providerCalls.every(call=>call.provider==="agentrouter")).toBe(true);
    const threads=threadStore.list("native");expect(threads).toHaveLength(2);expect(new Set(threads.map(thread=>thread.cwd)).size).toBe(2);expect(threads.every(thread=>worktrees.includes(thread.cwd))).toBe(true);for(const path of worktrees)await expect.poll(async()=>{try{await stat(path);return true}catch{return false}}).toBe(true);
    await expect(page.locator(".thread-row")).toHaveCount(2);await page.setViewportSize({width:1280,height:800});const metrics=await page.locator(".app-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({animations:"disabled",path:auditDir+"native-multimodel-fanout-1280x800.png",fullPage:true});
  }finally{await fanout.close()}
});

// The fan-out's threads each run on their own model. Opened, one shows that model in its picker, not the composer's pick of several,
// and a follow-up sent there goes to it: the follow-up went to the first model picked, which the relay then made the thread's model.
test("a follow-up in a Native fan-out thread goes to that thread's own model, the one its picker shows",async({page})=>{
  test.setTimeout(90_000);
  const fanout=await startNativeFanout(page,{models:["model-a","model-b","model-c"]}),{threadStore,providerCalls}=fanout;
  try{
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.locator(".branch-control")).toContainText(fanout.baseBranch,{timeout:10_000});
    const picker=page.getByTestId("model-picker"),menu=page.locator(".model-picker-menu"),composer=page.getByTestId("composer");
    await picker.click();await menu.getByRole("button",{name:/Model B/}).click({modifiers:["Shift"]});await menu.getByRole("button",{name:/Model C/}).click({modifiers:["Shift"]});
    await expect(picker).toContainText("3 models");await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
    await composer.click();await page.keyboard.type("Add a health check endpoint",{delay:5});await page.keyboard.press("Enter");
    await expect.poll(()=>providerCalls.length,{timeout:20_000}).toBe(3);await expect(page.locator(".thread-row")).toHaveCount(3);
    // Each worktree, and so each thread's folder, is named after its model (prepareDetachedWorktree).
    const threadOf=model=>threadStore.list("native").find(thread=>thread.cwd.includes("-"+model+"-"));
    for(const model of ["model-c","model-b"]){
      const row=page.locator(".thread-row").filter({hasText:model}),id=threadOf(model)?.id;expect(id,"the "+model+" thread").toBeTruthy();
      // The model-c thread is opened with a click, the model-b one from the keyboard.
      if(model==="model-c")await row.locator(".thread-main").click();else{await row.locator(".thread-main").focus();await page.keyboard.press("Enter")}
      await expect(row).toHaveClass(/active/);
      // Soft, so that the old build also shows where the follow-up went.
      await expect.soft(picker,"the picker of the "+model+" thread").toHaveText(modelName(model),{timeout:10_000});
      const sent=providerCalls.length;
      await composer.click();await page.keyboard.type("Follow up in this thread",{delay:5});await page.keyboard.press("Enter");
      await expect.poll(()=>providerCalls.length,{timeout:15_000}).toBe(sent+1);
      expect(providerCalls.at(-1).model,"the model the follow-up in the "+model+" thread went to").toBe(model);
      const reply=page.locator(".history-assistant").filter({hasText:"Completed "+model+"."}).last();
      await expect(reply.getByTestId("assistant-heading")).toContainText(modelName(model),{timeout:15_000});
      // The thread keeps its model: its sidebar row still names it, and so does the relay.
      expect(threadStore.get(id).model).toBe(model);await expect(row).toContainText(model);await expect(picker).toHaveText(modelName(model));
      for(const mode of model==="model-c"?["dark","light"]:[]){
        if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
        await page.screenshot({animations:"disabled",path:`${auditDir}native-fanout-follow-up-own-model-${mode}-1280x800.png`});
      }
    }
  }finally{await fanout.close()}
});

// A Native thread opened while no session of its own runs (Trebell restarted since its last turn) starts one on the thread's model,
// not the composer's: the open asked for the composer's model, and the relay made it the thread's before anything was sent.
test("a Native thread reopened after a restart keeps its own model in the picker and for its next turn",async({page})=>{
  test.setTimeout(60_000);
  const models=[];const harness=await startRelayHarness({replies:[request=>{models.push(request.model);return{text:"Answered with "+request.model+"."}}]});
  try{
    const thread=harness.seedThread("Health check endpoint",[{user:"Add a health check endpoint",items:[replyItem("seed-reply-c","Added the endpoint.")]}]);harness.threadStore.update(thread.id,{model:"model-c"});
    await routeRelayApp(page,harness);
    await page.route(/\/api\/models$/,route=>json(route,catalog(["model-a","model-b","model-c"])));
    await page.goto("/");
    const picker=page.getByTestId("model-picker"),composer=page.getByTestId("composer"),row=page.locator(".thread-row").filter({hasText:"Health check endpoint"});
    await expect(picker).toHaveText("Model A",{timeout:15_000});
    // Opened with a double click: the second click waits for the open the first began.
    await row.locator(".thread-main").dblclick();await expect(row).toHaveClass(/active/);await expect(page.getByText("Added the endpoint.")).toBeVisible({timeout:15_000});
    // Soft, so that the old build also shows where the follow-up went.
    await expect.soft(picker,"the picker of the reopened thread").toHaveText("Model C");expect.soft(harness.threadStore.get(thread.id).model,"the thread's model once it is open").toBe("model-c");
    await composer.click();await page.keyboard.type("Follow up in this thread",{delay:5});await page.keyboard.press("Enter");
    await expect.poll(()=>models.length,{timeout:15_000}).toBe(1);expect(models[0],"the model the follow-up went to").toBe("model-c");
    await expect(page.getByText("Answered with model-c.")).toBeVisible({timeout:15_000});expect(harness.threadStore.get(thread.id).model).toBe("model-c");await expect(picker).toHaveText("Model C");
  }finally{await harness.close()}
});

// A multi-model run where one model cannot start: its rows open to words, as a failed background launch's row does, not to the
// event's data. The run's error row says what failed for that model and where its draft went, and the started row names the model
// that runs and its thread; each opens by a click and from the keyboard, and fits a narrow window.
test("a multi-model run with a model that cannot start opens its rows to what failed for that model and where its draft went",async({page})=>{
  test.setTimeout(55_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-fanout-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","trebell-test@example.invalid"]);await git(repo,["config","user.name","Trebell Test"]);await writeFile(join(repo,"README.md"),"seed\n","utf8");await git(repo,["add","README.md"]);await git(repo,["commit","-m","seed"]);const baseBranch=(await git(repo,["branch","--show-current"])).stdout.trim();
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),worktrees=[],stashes=[];
  const nativeProviderTurn=async request=>{await new Promise(resolve=>setTimeout(resolve,80));return{id:"native-fanout-"+request.model,provider:request.provider,model:request.model,text:`Completed ${request.model}.`,toolCalls:[],finishReason:"stop",usage:{}}};
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-fanout-project",name:"Native Fan-out Project",path:repo,environmentId:null,effectiveSettings:{defaultWorkspaceMode:"current"}},metaByThread={};
  const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  try{
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:metaByThread}));
    await page.route(/\/api\/models$/,route=>json(route,{models:["model-a","model-b"],metadata:{provider:"agentrouter",models:[{id:"model-a",name:"Model A",provider:"agentrouter",agent:"Trebell Native"},{id:"model-b",name:"Model B",provider:"agentrouter",agent:"Trebell Native"}]}}));
    await page.route(/\/api\/projects(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();return json(route,{project:{...project,id:"project-"+worktrees.length,path:body.path,environmentId:body.environmentId||null}})}return json(route,{projects:[project],project})});
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:true,cwd:repo,root:repo,branch:baseBranch,branches:[baseBranch],status:[],remotes:[],worktrees:[{path:repo,branch:baseBranch}]}));
    // Model B's worktree cannot be made, so it never starts.
    await page.route(/\/api\/git\/action$/,async route=>{const body=route.request().postDataJSON();if(String(body.branch).includes("model-b"))return json(route,{error:"Deliberate worktree failure"},500);await git(repo,["worktree","add","-b",body.branch,body.path,"HEAD"]);worktrees.push(body.path);return json(route,{ok:true,result:{worktree:body.path,info:{root:body.path,branch:body.branch}}})});
    await page.route(/\/api\/stashes$/,route=>{if(route.request().method()!=="POST")return json(route,{stashes:[]});stashes.push(route.request().postDataJSON());return json(route,{stash:{id:"fanout-stash-"+stashes.length}})});
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();metaByThread[body.threadId]={...(metaByThread[body.threadId]||{}),...(body.patch||{})};return json(route,metaByThread[body.threadId])}const id=new URL(route.request().url()).searchParams.get("threadId");return json(route,metaByThread[id]||{})});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{supported:false}:{checkpoints:[]}));
    await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"native-fanout-context",skipped:true,budget:{mode:"skip",pressure:"normal",reserveTokens:1024,maxTokens:0,maxFiles:0}}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:280,rightPanelWidth:460,terminalHeight:330})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.locator(".branch-control")).toContainText(baseBranch,{timeout:10_000});
    const picker=page.getByTestId("model-picker");await picker.click();const menu=page.locator(".model-picker-menu");await expect(menu).toContainText("Shift-click to select multiple models");await menu.getByRole("button",{name:/Model B/}).click({modifiers:["Shift"]});await expect(picker).toContainText("2 models");
    const draft="Run this task with both Native models";
    await page.getByTestId("composer").fill(draft);await page.getByTestId("send").click();
    const failedRow=page.locator(".tool-event").filter({hasText:"1/2 model runs failed"}),startedRow=page.locator(".tool-event").filter({hasText:"Started 1/2 model"});
    await expect(failedRow.locator("summary")).toContainText("1/2 model runs failed · 1 failed draft was stashed for retry",{timeout:15_000});
    expect(stashes.map(stash=>stash.text)).toEqual(["[model-b] "+draft]);
    // The error row opens to what failed for model B and where its draft went, by a click and from the keyboard.
    const failedBody=failedRow.locator(".tool-event-body"),detail=["Could not start the background task: Deliberate worktree failure","Model: model-b","The draft was saved to Trebell stash, marked [model-b]."].join("\n");
    await failedRow.locator("summary").click();
    await expect(failedBody.locator("pre")).toHaveCount(1);expect(await failedBody.locator("pre").textContent()).toBe(detail);await expect(failedBody.locator(".tool-json")).toHaveCount(0);
    await failedRow.locator("summary").click();await expect(failedBody).toHaveCount(0);
    await failedRow.locator("summary").focus();await page.keyboard.press("Enter");await expect.poll(()=>failedBody.locator("pre").textContent()).toBe(detail);
    // The started row names the model that runs and its thread.
    await startedRow.locator("summary").click();
    const thread=threadStore.list("native")[0];expect(thread?.id).toBeTruthy();
    await expect(startedRow.locator(".tool-event-body pre")).toHaveText("Model: model-a · thread "+thread.id);await expect(startedRow.locator(".tool-json")).toHaveCount(0);
    for(const [mode,width] of [["dark",1280],["light",900]]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.setViewportSize({width,height:800});
      const metrics=await page.locator(".chat-workspace").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
      await failedRow.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+`native-multimodel-fanout-failed-row-opened-${mode}-${width}x800.png`});
    }
  }finally{
    await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));for(const path of [...worktrees].reverse())await git(repo,["worktree","remove","--force",path]).catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});

// A thread whose own model the catalog does not list (one made under another provider, or on a model the provider no longer lists)
// cannot go on with it: its follow-up goes to the composer's one model. Opened, it shows that model in its picker, never the pick of
// several models made for a new task, which an open thread does not send to: the picker said "3 models" and the follow-up went to
// the first.
test("a Native thread whose model the catalog does not list shows the one model its follow-up goes to, not the composer's several",async({page})=>{
  test.setTimeout(60_000);
  const models=[];const harness=await startRelayHarness({replies:[request=>{models.push(request.model);return{text:"Answered with "+request.model+"."}}]});
  try{
    const thread=harness.seedThread("Health check endpoint",[{user:"Add a health check endpoint",items:[replyItem("seed-reply-z","Added the endpoint.")]}]);harness.threadStore.update(thread.id,{model:"model-z"});
    await routeRelayApp(page,harness);
    await page.route(/\/api\/models$/,route=>json(route,catalog(["model-a","model-b","model-c"])));
    // A Git project, where a new task can fan out to several models.
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:true,cwd:harness.repo,root:harness.repo,branch:"main",branches:["main"],status:[],remotes:[],worktrees:[{path:harness.repo,branch:"main"}]}));
    const saved={};await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return json(route,saved)});
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const picker=page.getByTestId("model-picker"),menu=page.locator(".model-picker-menu"),composer=page.getByTestId("composer"),row=page.locator(".thread-row").filter({hasText:"Health check endpoint"});
    await expect(picker).toHaveText("Model A",{timeout:15_000});
    await picker.click();await menu.getByRole("button",{name:/Model B/}).click({modifiers:["Shift"]});await menu.getByRole("button",{name:/Model C/}).click({modifiers:["Shift"]});
    await expect(picker).toContainText("3 models");await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);await expect(page.getByText("Added the endpoint.")).toBeVisible({timeout:15_000});
    await expect(picker,"the picker of a thread whose model the catalog does not list").toHaveText("Model A");
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(picker).toHaveText("Model A");await page.screenshot({animations:"disabled",path:`${auditDir}native-unlisted-model-thread-picker-${mode}-${width}x800.png`})}
    }
    await page.setViewportSize({width:1280,height:800});
    await composer.click();await page.keyboard.type("Follow up in this thread",{delay:5});await page.keyboard.press("Enter");
    await expect.poll(()=>models.length,{timeout:15_000}).toBe(1);expect(models[0],"the model the follow-up went to, the one its picker named").toBe("model-a");
    await expect(page.getByText("Answered with model-a.")).toBeVisible({timeout:15_000});await expect(picker).toHaveText("Model A");
  }finally{await harness.close()}
});
