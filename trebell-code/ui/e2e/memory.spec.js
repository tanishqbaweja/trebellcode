import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test("Codex memory status and controls use native app-server RPCs",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"codex-memory-fixture",name:"Codex memory fixture",preview:"Native memory controls",cwd:process.cwd(),createdAt:Date.now()-1000,updatedAt:Date.now(),turns:[]};
  const calls=[];const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"memory-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume"||message.method==="thread/read")result={thread};
      else if(message.method==="thread/items/list")result={data:[],nextCursor:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="permissionProfile/list"||message.method==="mcpServerStatus/list"||message.method==="app/list"||message.method==="hooks/list"||message.method==="experimentalFeature/list"||message.method==="plugin/share/list")result={data:[]};
      else if(message.method==="plugin/list")result={marketplaces:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      else if(message.method==="account/read")result={account:null,requiresOpenaiAuth:false};
      else if(message.method==="account/rateLimits/read")result={rateLimits:{}};
      else if(message.method==="account/usage/read")result={};
      else if(message.method==="config/read")result={config:{},layers:[]};
      else if(message.method==="memory/status")result={v2ConsolidatedThreads:17,v2Ready:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamPort}`});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/codex/ws`,cwd:process.cwd(),platform:process.platform,version:"memory-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");
    await page.getByRole("button",{name:/Codex memory fixture/}).click();await page.getByRole("button",{name:"Tools",exact:true}).click();
    const card=page.locator(".capability-card").filter({hasText:"Codex memory"});await expect(card).toContainText("17");await expect(card).toContainText("Building");
    await card.getByRole("button",{name:"Disable for this thread"}).click();await expect(card).toContainText("Memory disabled for this thread.");
    await expect.poll(()=>calls.some(call=>call.method==="thread/memoryMode/set"&&call.params?.mode==="disabled")).toBe(true);
    await card.getByRole("button",{name:"Reset memory"}).click();expect(calls.some(call=>call.method==="memory/reset")).toBe(false);
    await card.getByRole("button",{name:"Confirm reset"}).click();await expect(card).toContainText("Codex memory was reset.");
    await expect.poll(()=>calls.some(call=>call.method==="memory/reset")).toBe(true);
    expect(calls.find(call=>call.method==="memory/status")?.params).toEqual({minConsolidatedThreads:20});
    expect(Object.prototype.hasOwnProperty.call(calls.find(call=>call.method==="memory/reset")||{},"params")).toBe(false);
    await page.setViewportSize({width:1280,height:800});await card.scrollIntoViewIfNeeded();await page.screenshot({path:auditDir+"tools-memory-controls-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({path:auditDir+"tools-memory-controls-light-1280x800.png",fullPage:false});
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});
