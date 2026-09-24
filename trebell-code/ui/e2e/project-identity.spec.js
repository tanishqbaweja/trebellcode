import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("local Trebell projects become native Codex project ownership for existing threads",async({page})=>{
  test.setTimeout(35_000);
  const cwd=process.cwd();
  const trebellProject={id:"trebell-project-1",name:"Native project fixture",path:cwd,environmentId:null,effectiveSettings:{}};
  let thread={id:"native-project-thread",name:"Native project thread",preview:"Project identity fixture",historyMode:"paginated",projectId:null,cwd,createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};let nativeCreated=false;
  const nativeProject={id:"codex-project-1",name:trebellProject.name,roots:[{path:cwd}],metadata:{trebellManaged:"true",trebellProjectId:trebellProject.id},position:0,createdAt:1,updatedAt:1,recencyAt:null};
  const calls=[];
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"project-identity-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="project/list")result={data:nativeCreated?[nativeProject]:[],nextCursor:null};
      else if(message.method==="project/create"){nativeCreated=true;result={project:nativeProject}}
      else if(message.method==="thread/metadata/update"){
        thread={...thread,projectId:message.params.projectId};
        ws.send(JSON.stringify({method:"thread/project/updated",params:{threadId:thread.id,projectId:thread.projectId}}));
        result={thread};
      }else if(message.method==="thread/start")result={thread:{id:"native-project-new-thread",name:"New project thread",preview:"",historyMode:"paginated",projectId:message.params.projectId||null,cwd,createdAt:Date.now()/1000,updatedAt:Date.now()/1000,turns:[]}};
      else if(message.method==="turn/start")result={turn:{id:"native-project-turn",status:"inProgress",items:[]}};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd,platform:process.platform,version:"project-identity-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",activeProjectId:trebellProject.id,defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[trebellProject],threadMeta:{[thread.id]:{projectless:false,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,async route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="GET"?{projects:[trebellProject]}:{project:trebellProject})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({checkpoints:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");await page.getByRole("button",{name:/Native project thread/}).click();
    await expect.poll(()=>calls.filter(call=>call.method==="thread/metadata/update").length).toBe(1);
    const created=calls.find(call=>call.method==="project/create");expect(created?.params).toEqual({name:trebellProject.name,roots:[{path:cwd}],metadata:{trebellManaged:"true",trebellProjectId:trebellProject.id},idempotencyKey:"trebell-code:"+trebellProject.id});
    const assigned=calls.find(call=>call.method==="thread/metadata/update");expect(assigned?.params).toEqual({threadId:thread.id,projectId:nativeProject.id});
    await expect(page.getByRole("button",{name:"trebell-code",exact:true})).toBeVisible();
    await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"chat-native-project-identity-1280x800.png",fullPage:true});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({path:auditDir+"chat-native-project-identity-light-1280x800.png",fullPage:true});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await page.getByRole("button",{name:"New thread"}).click();await page.getByTestId("composer").fill("Start a project-linked thread.");await page.getByTestId("send").click();
    await expect.poll(()=>calls.filter(call=>call.method==="thread/start").length).toBe(1);
    const started=calls.find(call=>call.method==="thread/start");expect(started?.params?.projectId).toBe(nativeProject.id);expect(calls.filter(call=>call.method==="project/create").length).toBe(1);
    await page.screenshot({path:auditDir+"chat-native-project-new-thread-1280x800.png",fullPage:true});
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});

test("Codex project identity sync failures warn without blocking thread open or start",async({page})=>{
  test.setTimeout(35_000);
  const cwd=process.cwd();
  const trebellProject={id:"trebell-project-sync-failure",name:"Project sync failure fixture",path:cwd,environmentId:null,effectiveSettings:{}};
  const existingThread={id:"project-sync-failure-thread",name:"Project sync failure thread",preview:"Project sync failure coverage",historyMode:"paginated",projectId:null,cwd,createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  const calls=[];
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);
      if(message.method==="project/list"){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate Codex project sync failure"}}));return;
      }
      let result={};
      if(message.method==="initialize")result={userAgent:"project-sync-failure-fixture"};
      else if(message.method==="thread/list")result={data:[existingThread],nextCursor:null};
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/resume")result={thread:existingThread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="thread/start")result={thread:{id:"project-sync-failure-new-thread",name:"New thread without native project",preview:"",historyMode:"paginated",projectId:message.params.projectId||null,cwd,createdAt:Date.now()/1000,updatedAt:Date.now()/1000,turns:[]}};
      else if(message.method==="turn/start")result={turn:{id:"project-sync-failure-turn",status:"inProgress",items:[]}};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd,platform:process.platform,version:"project-sync-failure-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",activeProjectId:trebellProject.id,defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[trebellProject],threadMeta:{[existingThread.id]:{projectless:false,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="GET"?{projects:[trebellProject]}:{project:trebellProject})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({checkpoints:[]})}));
    await page.route(/\/api\/thread-meta$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({cwd,environmentId:null,projectless:false,sectionName:"Active",archived:false})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");
    const existingRow=page.locator(".thread-row").filter({hasText:"Project sync failure thread"});
    await existingRow.locator(".thread-main").click();
    await expect(existingRow).toHaveClass(/active/);
    const alert=page.getByTestId("app-action-error");
    await expect(alert).toContainText("Could not sync Codex project identity: Deliberate Codex project sync failure");
    await expect(alert).toBeInViewport();
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({path:auditDir+"codex-project-sync-open-error-1280x800.png",fullPage:true});

    await page.getByRole("button",{name:"New thread",exact:true}).click();
    const composer=page.getByTestId("composer");
    await composer.fill("Start even when Codex project identity sync fails.");
    await page.getByTestId("send").click();
    await expect.poll(()=>calls.filter(call=>call.method==="thread/start").length).toBe(1);
    const started=calls.find(call=>call.method==="thread/start");
    expect(started?.params?.projectId).toBeUndefined();
    await expect(page.locator(".thread-row.active")).toContainText("New thread without native project");
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(alert).toContainText("Could not sync Codex project identity: Deliberate Codex project sync failure");
    await page.screenshot({path:auditDir+"codex-project-sync-new-thread-error-1280x800.png",fullPage:true});
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});
