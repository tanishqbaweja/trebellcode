import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("Codex MCP user verification uses the native signed-device proof flow",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"verification-fixture",name:"Verification fixture",preview:"Native verification",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  const calls=[],responses=[];let notificationSocket=null;
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);notificationSocket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));
      if(message.id!=null&&!message.method){responses.push(message);return}
      if(message.id==null||!message.method)return;
      calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"verification-fixture"};
      else if(message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="userVerification/verify")result={proof:{credentialId:"cred-local",signature:"sig-local"}};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:"win32",version:"verification-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");await page.getByRole("button",{name:/Verification fixture/}).click();
    notificationSocket.send(JSON.stringify({id:71,method:"mcpServer/elicitation/request",params:{threadId:thread.id,serverName:"codex_apps",mode:"openai/userVerification",title:"Confirm sensitive action",description:"Use your local device verification to continue.",challenge:"Y2hhbGxlbmdl"}}));
    const modal=page.getByTestId("mcp-elicitation");await expect(modal).toBeVisible();await expect(modal).toContainText("Confirm sensitive action");await expect(modal).toContainText("Use your local device verification to continue.");await expect(modal.getByRole("button",{name:"Verify with device"})).toBeVisible();
    await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"mcp-user-verification-1280x800.png",fullPage:true});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({path:auditDir+"mcp-user-verification-light-1280x800.png",fullPage:true});await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    await modal.getByRole("button",{name:"Verify with device"}).click();
    await expect(modal).toHaveCount(0);
    await expect.poll(()=>calls.filter(call=>call.method==="userVerification/verify").length).toBe(1);
    expect(calls.find(call=>call.method==="userVerification/verify")?.params).toEqual({challenge:"Y2hhbGxlbmdl",title:"Confirm sensitive action",description:"Use your local device verification to continue."});
    await expect.poll(()=>responses.some(message=>message.id===71)).toBe(true);
    expect(responses.find(message=>message.id===71)?.result).toEqual({action:"accept",content:{credentialId:"cred-local",signature:"sig-local"},_meta:null});
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});
