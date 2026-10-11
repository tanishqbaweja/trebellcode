import { expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { NATIVE_REPLY_STREAM } from "../../src/native-agent-session.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";

// The page and relay for the Native reply streaming specs: the real agent relay runs the real Native session, and the GUI
// server is mocked at its HTTP API, as native-queue.spec.js does.
export const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
export function gate(){let open=()=>{};const promise=new Promise(resolve=>{open=resolve});return {promise,open}}

// The Native relay, its threads and the GUI server's HTTP API for one page. script holds one function per provider call
// (request, hook) => reply; requests records whether each call carried the stream hook. holdOpening(threadId), once armed,
// holds the relay's answers about that thread after its next thread/resume until the function it returns is called, so the
// app keeps that thread's notifications back while it opens. providerTurn, when given, answers every call instead of the
// script (a live provider); rootDir is where the run keeps its files.
export async function startStreamingFixture(page,{mode="dark",threads=[{name:"Native streaming",preview:"Live reply"}],model="gpt-5.6",providerTurn=null,rootDir=tmpdir()}={}){
  const root=await mkdtemp(join(rootDir,"trebell-native-reply-stream-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await writeFile(join(repo,"session.js"),"export class SessionManager { refresh(){ return true; } }\n","utf8");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const created=threads.map((item,index)=>threadStore.create({
    runtime:"native",cwd:repo,providerSessionId:"native-reply-stream-"+index,model,name:item.name,preview:item.preview,
    providerMeta:{runtimeInstanceId:"native-default",modelProvider:"openai",permissionProfile:"auto",projectless:false,environmentId:null},
  }));
  const script=[],requests=[];
  const nativeProviderTurn=async request=>{
    const hook=request[NATIVE_REPLY_STREAM];requests.push({hooked:typeof hook==="function",gate:request.metadata?.completionGate===true});
    if(typeof providerTurn==="function")return providerTurn(request);
    const step=script.shift();if(!step)throw new Error("unexpected provider call");return step(request,typeof hook==="function"?hook:()=>{});
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const wsUrl=`ws://127.0.0.1:${relayPort}/api/agent/ws`;
  let opening=null;
  await page.routeWebSocket(wsUrl,ws=>{
    const server=ws.connectToServer(),sent=new Map();
    ws.onMessage(message=>{try{const parsed=JSON.parse(String(message));if(parsed?.id!=null&&parsed.method)sent.set(parsed.id,{method:parsed.method,threadId:String(parsed.params?.threadId||"")})}catch{}server.send(message)});
    server.onMessage(async message=>{
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      const asked=parsed?.id!=null&&!parsed.method?sent.get(parsed.id):null;
      if(asked&&opening&&asked.threadId===opening.threadId){
        if(asked.method==="thread/resume"&&!opening.resumed)opening.resumed=true;
        else if(opening.resumed)await opening.released;
      }
      ws.send(message);
    });
  });
  const project={id:"native-stream-project",name:"Native Stream Project",path:repo,environmentId:null,effectiveSettings:{}};
  const meta=Object.fromEntries(created.map(thread=>[thread.id,{projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"}]));
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    mock:false,provider:"openai",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null,
  })}));
  await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    settings:{onboardingComplete:true,appearance:mode,appearanceMode:mode,panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"},
    projects:[project],activeProjectId:project.id,threadMeta:meta,
  })}));
  await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:[model],metadata:{provider:"openai",models:[{id:model,name:model.toUpperCase(),provider:"openai",agent:"Trebell Native"}]}})}));
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
  await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
  await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,branch:"main",root:repo})}));
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{
    const url=new URL(route.request().url()),id=url.searchParams.get("threadId")||route.request().postDataJSON?.()?.threadId||created[0].id;
    if(route.request().method()==="POST"){const body=route.request().postDataJSON();meta[id]={...(meta[id]||{}),...(body?.patch||{})}}
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(meta[id]||{})});
  });
  await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{id:"stream-checkpoint",threadId:created[0].id}:{checkpoints:[]})}));
  await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
  await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"stream-context",skipped:true,budget:{reserveTokens:1024}})}));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  const open=async name=>{const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();await expect(page.getByTestId("composer")).toBeEnabled({timeout:10_000})};
  const send=async text=>{const composer=page.getByTestId("composer");await composer.fill(text);await page.getByTestId("send").click()};
  // A second client of the relay, for what the app itself does not send (steering a Native turn).
  const rpc=async(method,params)=>{
    const socket=new WebSocket(wsUrl);await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject)});
    try{return await new Promise((resolve,reject)=>{socket.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id===1)message.error?reject(new Error(message.error.message)):resolve(message.result)});socket.send(JSON.stringify({id:1,method,params}))})}
    finally{socket.close()}
  };
  return {
    page,repo,threadStore,threads:created,script,requests,open,send,rpc,
    holdOpening(threadId){const held=gate();opening={threadId:String(threadId),resumed:false,released:held.promise};return ()=>{held.open();opening=null}},
    async close(){opening=null;await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})},
  };
}

export const live=page=>page.locator(".assistant-answer");
export const stop=page=>page.getByRole("button",{name:"Stop",exact:true});
// Records every text the live reply showed from now on, so a check can say what was on screen between two assertions.
export async function watchLiveReply(page){
  await page.evaluate(()=>{
    const seen=window.__liveReplySeen=[];const note=()=>{for(const node of document.querySelectorAll(".assistant-answer")){const text=node.textContent||"";if(text&&seen.at(-1)!==text)seen.push(text)}};
    window.__liveReplyObserver?.disconnect();window.__liveReplyObserver=new MutationObserver(note);window.__liveReplyObserver.observe(document.body,{subtree:true,childList:true,characterData:true});note();
  });
  return ()=>page.evaluate(()=>window.__liveReplySeen.slice());
}
export async function assertNoHorizontalScroll(page){
  const metrics=await page.locator(".workspace-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
}

