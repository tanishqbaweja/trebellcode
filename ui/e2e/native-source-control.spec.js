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
  let calls=0;const nativeProviderTurn=async request=>{if(request.metadata?.completionGate||request.responseJsonSchema?.name==="trebell_completion_gate")return{id:"source-ui-gate",provider:request.provider,model:request.model,text:JSON.stringify({status:"complete",progress:"improved",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"The requested branch was created successfully."}),toolCalls:[],finishReason:"stop",usage:{}};calls++;if(calls===1)return{id:"source-ui-tool",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"source-ui-1",namespace:"trebell_source_control",name:"branch_create",arguments:JSON.stringify({name:"trebell/native-ui-proof"})}],finishReason:"tool_calls",usage:{}};return{id:"source-ui-answer",provider:request.provider,model:request.model,text:"Created the Trebell proof branch.",toolCalls:[],finishReason:"stop",usage:{}}};
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-source-project",name:"Native Source Project",path:repo,environmentId:null,effectiveSettings:{}};let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();uiMeta={...uiMeta,...(body?.patch||{})}}await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(uiMeta)})});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{id:"source-ui-checkpoint",threadId:thread.id}:{checkpoints:[]})}));
    await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"source-ui-context",skipped:true,budget:{reserveTokens:1024}})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    // The Git panel polls on a timer: a poll that lands after the test removed its repository answers 404 instead of failing the test.
    await page.route(/\/api\/git\/info(?:\?.*)?$/,async route=>{const info=await gitInfo(repo).catch(()=>null);return route.fulfill(info?{status:200,contentType:"application/json",body:JSON.stringify(info)}:{status:404,contentType:"application/json",body:JSON.stringify({error:"The fixture repository was removed."})}).catch(()=>{})});
    await page.route(/\/api\/source-control\/diagnostics(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({selectedProvider:"",detectedProvider:"unknown",capabilities:{}})}));
    await page.route(/\/api\/source-control\/prs(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[],capabilities:{create:true,comment:true,review:true,merge:true,updateBranch:true}})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:500,terminalHeight:330})));
    await page.goto("/");const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native source-control fixture"]')});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    const composer=page.getByTestId("composer");await composer.fill("Create a proof branch");await page.getByTestId("send").click();await expect(page.getByText("Created the Trebell proof branch.",{exact:true})).toBeVisible({timeout:10_000});await expect(page.getByText("trebell_source_control / branch_create",{exact:true})).toBeVisible();
    await expect(page.locator(".branch-control")).toContainText("trebell/native-ui-proof",{timeout:3000});
    await page.getByTestId("right-panel-toggle").click();const panel=page.getByTestId("right-panel");await panel.getByRole("button",{name:"Git",exact:true}).click();await expect(panel.locator("select").first()).toHaveValue("trebell/native-ui-proof",{timeout:10_000});
    let metrics=await panel.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({animations:"disabled",path:auditDir+"native-source-control-1600x980.png",fullPage:true});
    await page.setViewportSize({width:1280,height:800});await expect(panel.locator("select").first()).toHaveValue("trebell/native-ui-proof");
    // A branch name too long for the select ends in an ellipsis, and the tooltip names the whole branch.
    const branchSelect=panel.getByRole("combobox",{name:"Current branch"});await expect(branchSelect).toHaveAttribute("title",/^trebell\/native-ui-proof\b/);expect(await branchSelect.evaluate(node=>getComputedStyle(node).textOverflow)).toBe("ellipsis");
    metrics=await panel.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({animations:"disabled",path:auditDir+"native-source-control-1280x800.png",fullPage:true});
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("the Git tab's Changes card shows the file an agent's turn wrote, and reads the repository again only when the open thread's files change",async({page})=>{
  test.setTimeout(90_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-changes-ui-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(join(repo,"src"),{recursive:true});await git(repo,["init"]);await git(repo,["config","user.email","trebell-test@example.invalid"]);await git(repo,["config","user.name","Trebell Test"]);await writeFile(join(repo,"README.md"),"seed\n","utf8");await writeFile(join(repo,"src","app.js"),"export const answer = 42;\n","utf8");await git(repo,["add","-A"]);await git(repo,["commit","-m","seed"]);
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-changes-ui",model:"gpt-5.6",name:"Native changes fixture",preview:"Agent file fixture",providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"auto",projectless:false,environmentId:null}});
  // The agent's turn writes src/agent-edit.js with its workspace tool, then says it is done.
  let calls=0;const nativeProviderTurn=async request=>{if(request.metadata?.completionGate||request.responseJsonSchema?.name==="trebell_completion_gate")return{id:"changes-ui-gate",provider:request.provider,model:request.model,text:JSON.stringify({status:"complete",progress:"improved",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"The requested file was written."}),toolCalls:[],finishReason:"stop",usage:{}};calls++;if(calls===1)return{id:"changes-ui-tool",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"changes-ui-1",namespace:"trebell_workspace",name:"write_file",arguments:JSON.stringify({path:"src/agent-edit.js",content:"export const fromAgent = true;\n"})}],finishReason:"tool_calls",usage:{}};return{id:"changes-ui-answer",provider:request.provider,model:request.model,text:"Done editing the file.",toolCalls:[],finishReason:"stop",usage:{}}};
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-changes-project",name:"Native Changes Project",path:repo,environmentId:null,effectiveSettings:{}};let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  // The Git panel's reads name the environment (environmentId=), as the thread's context save does when the thread opens; the
  // header's poll of a local project does not. headerHold, while set, holds the header's next poll until it settles (headerHeld
  // says one is waiting).
  const panelReads=[];let headerHold=null,headerHeld=null;
  // The appearance toggle saves the settings, which the fixture keeps, so the screenshots in both modes show the window as it was.
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}})}));
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(settings)})});
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();uiMeta={...uiMeta,...(body?.patch||{})}}await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(uiMeta)})});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{id:"changes-ui-checkpoint",threadId:thread.id}:{checkpoints:[]})}));
    await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"changes-ui-context",skipped:true,budget:{reserveTokens:1024}})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,async route=>{if(new URL(route.request().url()).searchParams.has("environmentId"))panelReads.push(Date.now());else if(headerHold){headerHeld?.();await headerHold}const info=await gitInfo(repo).catch(()=>null);return route.fulfill(info?{status:200,contentType:"application/json",body:JSON.stringify(info)}:{status:404,contentType:"application/json",body:JSON.stringify({error:"The fixture repository was removed."})}).catch(()=>{})});
    await page.route(/\/api\/source-control\/diagnostics(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({selectedProvider:"",detectedProvider:"unknown",git:{version:"git version fixture"},capabilities:{}})}));
    await page.route(/\/api\/source-control\/prs(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[],capabilities:{create:true,comment:true,review:true,merge:true,updateBranch:true}})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native changes fixture"]')});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    await page.getByTestId("right-panel-toggle").click();const panel=page.getByTestId("right-panel");await panel.getByRole("button",{name:"Git",exact:true}).click();
    const changes=panel.locator("section.sc-card").filter({has:page.getByRole("heading",{name:/^Changes/})}),count=changes.locator("h3 span"),list=changes.locator(".status-list");
    await expect(changes.locator(".sc-clean")).toHaveText("Working tree clean.",{timeout:15_000});await expect(count).toHaveText("0");
    // The person asks for a change and the agent's turn writes the file; the card lists it when the turn ends, without leaving the tab.
    await page.getByTestId("composer").click();await page.keyboard.type("Add a small file please",{delay:10});await page.keyboard.press("Enter");
    await expect(page.getByText("Done editing the file.",{exact:true})).toBeVisible({timeout:20_000});
    expect((await git(repo,["status","--porcelain"])).stdout,"the agent's file is on disk and git lists it").toContain("?? src/agent-edit.js");
    await expect(list).toContainText("src/agent-edit.js",{timeout:8000});
    await expect(count).toHaveText("1");await expect(changes.locator(".sc-clean")).toHaveCount(0);
    await expect(list.locator(":scope > div").filter({hasText:"src/agent-edit.js"}).locator("code")).toHaveText("N");
    for(const mode of ["dark","light"]){
      if(await page.locator("html").getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(list).toContainText("src/agent-edit.js");await page.screenshot({animations:"disabled",path:auditDir+"native-git-changes-after-turn-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
    }
    // Nothing of the open thread's changing reads nothing: another thread's turn ending, or the open thread's reply text streaming in.
    const settled=panelReads.length;
    await page.evaluate(id=>{for(const detail of [{method:"turn/completed",params:{threadId:"another-thread",turn:{id:"other-turn",status:"completed"}}},{method:"item/agentMessage/delta",params:{threadId:id,itemId:"reply",delta:"More text."}}])window.dispatchEvent(new CustomEvent("trebell:rpc-notification",{detail}))},thread.id);
    await page.waitForTimeout(1500);
    expect(panelReads.length,"the Git panel read nothing while nothing of the open thread's changed").toBe(settled);
    // A file change of the open thread's, here to a file an editor also changed on disk, is read at once, in one read. The header's
    // poll, which would see the edit too (below), is held from before the edit until that read is counted.
    let release=()=>{};const waiting=new Promise(resolve=>{headerHeld=resolve});headerHold=new Promise(resolve=>{release=resolve});
    await waiting;
    await writeFile(join(repo,"README.md"),"changed on disk\n","utf8");
    await page.evaluate(id=>window.dispatchEvent(new CustomEvent("trebell:rpc-notification",{detail:{method:"item/completed",params:{threadId:id,item:{type:"fileChange",id:"edit-1",status:"completed",changes:[{path:"README.md",kind:"update"}]}}}})),thread.id);
    await expect(list).toContainText("README.md",{timeout:8000});await expect(count).toHaveText("2");
    expect(panelReads.length).toBe(settled+1);
    headerHold=null;release();
    // An edit made outside the app (an editor's save, a terminal, another thread's turn) sends the open thread no notification. The
    // header's poll of the repository (every 3.5 s while the window has focus) sees it, and the card reads the repository then, once:
    // the polls after it find what the card shows and read nothing more.
    const outside=panelReads.length;
    await writeFile(join(repo,"src","app.js"),"export const answer = 43;\n","utf8");
    await expect(list).toContainText("src/app.js",{timeout:12_000});await expect(count).toHaveText("3");
    await expect(list.locator(":scope > div").filter({hasText:"src/app.js"}).locator("code")).toHaveText("M");
    await page.waitForTimeout(4000);
    expect(panelReads.length,"one read for the edit outside the app").toBe(outside+1);
    for(const mode of ["dark","light"]){
      if(await page.locator("html").getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(list).toContainText("src/app.js");await page.screenshot({animations:"disabled",path:auditDir+"native-git-changes-outside-edit-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
    }
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
