import { test,expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
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
// Two frames on: the page has drawn what it was last given, and has done what React does once it is drawn (its effects).
const painted=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve)))));
const startProcess=(id,tag)=>({id,namespace:"trebell_process",name:"start",arguments:JSON.stringify({command:process.execPath,args:["-e",`/*${tag}*/process.stdout.write('READY');setInterval(()=>{},1000)`],cwd:"."})});
const providerReply=(request,id,{text="",toolCalls=[]}={})=>({id,provider:request.provider,model:request.model,text,toolCalls,finishReason:toolCalls.length?"tool_calls":"stop",usage:{inputTokens:30_000,outputTokens:1_000,totalTokens:31_000}});

// Trebell Native on the real agent relay with one thread per name in one project, its provider answering in turn: the first
// message sent starts two background processes and the next call says so. The page's socket to the relay passes through here:
// hold(which) keeps the requests which(message) picks until release(which) sends them on (a slow harness) and resolves once their
// answers are on the page and drawn; answered lists the requests the relay has answered; drop() closes the socket and keeps the
// window from connecting again until back() (a harness that goes away and comes back).
async function startNativeThreads(page,names){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-background-ui-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const threads=names.map((name,index)=>threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-background-threads-"+index,model:"gpt-5.6",name,preview:name,providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"auto",projectless:false,environmentId:null}}));
  let calls=0;
  const nativeProviderTurn=async request=>++calls===1?providerReply(request,"background-threads-tools",{toolCalls:[startProcess("background-web","native-background-web"),startProcess("background-worker","native-background-worker")]}):providerReply(request,"background-threads-answer",{text:"Two background processes started."});
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,nativeModelContextWindow:()=>100_000,version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const wsUrl=`ws://127.0.0.1:${relayPort}/api/agent/ws`,project={id:"native-background-threads-project",name:"Native Background Project",path:repo,environmentId:null,effectiveSettings:{}};
  const meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"}]));
  const sockets=[],held=[],answered=[];let holding=null,away=false;
  await page.routeWebSocket(wsUrl,ws=>{
    if(away){ws.close({code:1011,reason:"harness down"}).catch(()=>{});return}
    const server=ws.connectToServer(),asked=new Map(),waiting=new Map();sockets.push({ws,server});
    ws.onMessage(message=>{
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      if(parsed?.method&&parsed.id!=null)asked.set(parsed.id,{method:parsed.method,threadId:parsed.params?.threadId||null});
      if(parsed?.method&&parsed.id!=null&&holding?.(parsed))held.push({message:parsed,send:()=>server.send(message),answered:new Promise(resolve=>waiting.set(parsed.id,resolve))});
      else server.send(message);
    });
    server.onMessage(message=>{
      ws.send(message);
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      const request=parsed?.id!=null&&!parsed.method?asked.get(parsed.id):null;
      if(request){answered.push(request);waiting.get(parsed.id)?.()}
    });
  });
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
  await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:meta})}));
  await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}})}));
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
  await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
  await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,branch:"main",root:repo})}));
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{
    const id=new URL(route.request().url()).searchParams.get("threadId")||route.request().postDataJSON?.()?.threadId||threads[0].id;
    if(route.request().method()==="POST"){const body=route.request().postDataJSON();meta[id]={...(meta[id]||{}),...(body?.patch||{})}}
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(meta[id]||{})});
  });
  await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{id:"background-threads-checkpoint",threadId:threads[0].id}:{checkpoints:[]})}));
  await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
  await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"background-threads-context",skipped:true,budget:{reserveTokens:1024}})}));
  await page.route(/\/api\/traces\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[],journal:{backend:"sqlite",lastError:null}})}));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  // The theme button's setting stays in the page, so later specs on the shared server keep theirs.
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().postDataJSON()||{})}):route.fallback());
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  const panel=page.getByTestId("right-panel");
  return {
    threads,answered,panel,
    async open(name){
      const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});await expect(row).toBeVisible({timeout:10_000});
      await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
      if(!await panel.isVisible())await page.getByTestId("right-panel-toggle").click();
      await panel.getByRole("button",{name:"Runtime",exact:true}).click();
      return panel.getByTestId("agent-background-terminals");
    },
    async startTwo(){
      const composer=page.getByTestId("composer");await composer.fill("Start the web server and the worker in the background");await page.getByTestId("send").click();
      await expect(page.getByText("Two background processes started.",{exact:true})).toBeVisible({timeout:15_000});
    },
    hold(which){holding=which},
    async release(which=()=>true){const going=held.filter(entry=>which(entry.message));held.splice(0,held.length,...held.filter(entry=>!going.includes(entry)));for(const entry of going)entry.send();await Promise.all(going.map(entry=>entry.answered));await painted(page)},
    drop(){away=true;for(const {ws,server} of sockets.splice(0)){ws.close({code:1011,reason:"harness down"}).catch(()=>{});server.close().catch(()=>{})}},
    back(){away=false},
    // A client of the relay of its own, which the page's socket going away leaves alone.
    async rpc(method,params){
      const socket=new WebSocket(wsUrl);await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject)});
      try{return await new Promise((resolve,reject)=>{socket.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id===1)message.error?reject(new Error(message.error.message)):resolve(message.result)});socket.send(JSON.stringify({id:1,method,params}))})}
      finally{socket.close()}
    },
    async close(){holding=null;for(const entry of held.splice(0))entry.send();await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true})},
  };
}
// The page in dark and light at 1280 and 900 wide, with show in view; it is left dark at 1280. The theme button is pressed at
// 1280, as at 900 the open panel lies over the header.
async function shootModes(page,show,name){
  const mode=async value=>{await page.setViewportSize({width:1280,height:800});if(await page.locator("html").getAttribute("data-mode")!==value){await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode",value)}};
  for(const value of ["dark","light"]){await mode(value);for(const width of [1280,900]){await page.setViewportSize({width,height:800});await show.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+name+"-"+value+"-"+width+"x800.png"})}}
  await mode("dark");
}

test("Trebell Native exposes real thread-owned background processes in Runtime",async({page})=>{
  test.setTimeout(45_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-background-ui-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-background-ui",model:"gpt-5.6",name:"Native background fixture",preview:"Background process fixture",providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"auto",projectless:false,environmentId:null}});
  let calls=0;
  const nativeProviderTurn=async request=>{
    calls++;
    const processTools=request.tools.find(item=>item.name==="trebell_process");assert.ok(processTools);assert.ok(processTools.tools.some(item=>item.name==="start"));
    if(calls===1)return{id:"background-ui-tool",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"background-ui-call",namespace:"trebell_process",name:"start",arguments:JSON.stringify({command:process.execPath,args:["-e","process.stdout.write('READY');setInterval(()=>{},1000)"],cwd:"."})}],finishReason:"tool_calls",usage:{inputTokens:30_000,outputTokens:1_000,totalTokens:31_000}};
    return{id:"background-ui-answer",provider:request.provider,model:request.model,text:"Background server started.",toolCalls:[],finishReason:"stop",usage:{inputTokens:40_000,outputTokens:1_000,totalTokens:41_000}};
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,nativeModelContextWindow:()=>100_000,version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-background-project",name:"Native Background Project",path:repo,environmentId:null,effectiveSettings:{}};let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,branch:"main",root:repo})}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();uiMeta={...uiMeta,...(body?.patch||{})}}await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(uiMeta)})});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{id:"background-ui-checkpoint",threadId:thread.id}:{checkpoints:[]})}));
    await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"background-ui-context",skipped:true,budget:{reserveTokens:1024}})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native background fixture"]')});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    const composer=page.getByTestId("composer");await composer.fill("Start a background server");await page.getByTestId("send").click();await expect(page.getByText("Background server started.",{exact:true})).toBeVisible({timeout:10_000});
    await composer.fill("/p");await expect(page.locator(".slash-menu")).toContainText("Show agent background processes");await composer.fill("/s");await expect(page.locator(".slash-menu")).toContainText("Stop agent background processes");await composer.fill("");
    await page.getByTestId("right-panel-toggle").click();const panel=page.getByTestId("right-panel");await panel.getByRole("button",{name:"Runtime",exact:true}).click();
    await expect(panel.locator(".runtime-grid")).toContainText("Context 70%",{timeout:10_000});
    const background=panel.getByTestId("agent-background-terminals");await expect(background).toBeVisible();await expect(background).toContainText("Agent background processes");await expect(background).toContainText(process.execPath.split(/[\\/]/).pop(),{timeout:10_000});
    const capability=panel.getByTestId("runtime-capabilities").locator(".runtime-capability-grid>div").filter({hasText:"Background processes"});await expect(capability).toContainText("available");
    const language=panel.getByTestId("runtime-capabilities").locator(".runtime-capability-grid>div").filter({hasText:"Language intelligence"});await expect(language).toContainText("available");
    let metrics=await panel.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({animations:"disabled",path:auditDir+"native-background-runtime-1600x980.png",fullPage:true});
    await page.setViewportSize({width:1280,height:800});await expect(background).toBeVisible();metrics=await panel.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);await page.screenshot({animations:"disabled",path:auditDir+"native-background-runtime-1280x800.png",fullPage:true});
    await background.locator(".agent-background-list").getByRole("button",{name:"Stop",exact:true}).click();await expect(background).toContainText("No agent background processes.",{timeout:10_000});
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
});

test("a slow Refresh of the thread just left lists nothing under the thread opened",async({page})=>{
  test.setTimeout(60_000);
  const native=await startNativeThreads(page,["Background thread A","Background thread B"]),[threadA,threadB]=native.threads;
  const lists=thread=>native.answered.filter(item=>item.method==="thread/backgroundTerminals/list"&&item.threadId===thread.id).length;
  try{
    const background=await native.open("Background thread A"),rows=background.locator(".agent-background-list>div"),count=background.locator(".agent-background-head>div>span");
    await native.startTwo();
    await expect(rows).toHaveCount(2,{timeout:10_000});
    // Refresh is pressed on thread A and its answer is slow; thread B, which has none, is opened while it is on its way, and B's
    // own list answers.
    native.hold(message=>message.method==="thread/backgroundTerminals/list"&&message.params?.threadId===threadA.id);
    await background.getByTitle("Refresh background processes").click();
    await expect(background.getByTitle("Refresh background processes")).toBeDisabled();
    const listedB=lists(threadB);
    await native.open("Background thread B");
    await expect.poll(()=>lists(threadB)).toBeGreaterThan(listedB);
    // B's later lists are slow too, so nothing of B's would replace what A's answer leaves once it lands.
    native.hold(message=>message.method==="thread/backgroundTerminals/list");
    await native.release(message=>message.params?.threadId===threadA.id);
    await expect(rows,"thread A's slow Refresh listed its processes under thread B").toHaveCount(0);
    await expect(count).toHaveText("0");
    await expect(background.locator(".agent-background-empty")).toHaveText("No agent background processes.");
    await expect(background.getByRole("button",{name:"Stop all"})).toHaveCount(0);
    await expect(background.getByTitle("Refresh background processes")).toBeEnabled();
    await shootModes(page,background,"native-background-thread-switch");
    // Back on A, its two processes are listed, and Stop all stops them.
    native.hold(null);await native.release();
    await native.open("Background thread A");
    await expect(rows).toHaveCount(2,{timeout:10_000});
    await background.getByRole("button",{name:"Stop all"}).click();
    await expect(background.locator(".agent-background-empty")).toHaveText("No agent background processes.",{timeout:10_000});
  }finally{await native.close()}
});

test("while the harness is away, Runtime keeps the background processes it last listed and says it cannot check them",async({page})=>{
  test.setTimeout(60_000);
  const native=await startNativeThreads(page,["Background drop thread"]);
  try{
    const background=await native.open("Background drop thread"),rows=background.locator(".agent-background-list>div"),summary=native.panel.locator(".runtime-summary");
    await native.startTwo();
    await expect(rows).toHaveCount(2,{timeout:10_000});
    await expect(summary).toContainText("Connected locally");
    // The page's connection to the harness drops and stays down, while both processes go on running in the relay.
    native.drop();
    await expect(summary).not.toContainText("Connected locally");await painted(page);
    expect((await native.rpc("thread/backgroundTerminals/list",{threadId:native.threads[0].id})).data).toHaveLength(2);
    await expect(rows,"the list was emptied while the harness was away").toHaveCount(2);
    await expect(background).not.toContainText("No agent background processes.");
    await expect(background.getByRole("status")).toHaveText("Agent harness is not connected, so this thread's background processes cannot be checked or stopped. The processes it last listed are kept below.");
    await expect(background.locator(".agent-background-head>div>span")).toHaveText("2");
    for(const button of [background.getByTitle("Refresh background processes"),background.getByRole("button",{name:"Stop all"}),rows.nth(0).getByRole("button",{name:"Stop",exact:true}),rows.nth(1).getByRole("button",{name:"Stop",exact:true})])await expect(button).toBeDisabled();
    await shootModes(page,background,"native-background-harness-away");
    // Once the harness is back the list is current again, and Stop all stops both processes.
    native.back();
    await expect(summary).toContainText("Connected locally",{timeout:20_000});
    await expect(background.getByRole("status")).toHaveCount(0);
    await expect(rows).toHaveCount(2);
    await background.getByRole("button",{name:"Stop all"}).click();
    await expect(background.locator(".agent-background-empty")).toHaveText("No agent background processes.",{timeout:10_000});
  }finally{await native.close()}
});
