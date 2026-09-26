import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("Windows sandbox readiness and async setup use native Codex RPCs",async({page})=>{
  test.setTimeout(35_000);
  const calls=[];let readiness="notConfigured",setupSocket=null,setupMode=null;const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      const respond=value=>ws.send(JSON.stringify({id:message.id,result:value}));
      if(message.method==="initialize")result={userAgent:"windows-sandbox-fixture"};
      else if(message.method==="thread/list")result={data:[],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="permissionProfile/list"||message.method==="mcpServerStatus/list"||message.method==="app/list"||message.method==="hooks/list"||message.method==="experimentalFeature/list"||message.method==="plugin/share/list")result={data:[]};
      else if(message.method==="plugin/list")result={marketplaces:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      else if(message.method==="account/read")result={account:null,requiresOpenaiAuth:false};
      else if(message.method==="account/rateLimits/read")result={rateLimits:{}};
      else if(message.method==="account/usage/read")result={};
      else if(message.method==="config/read")result={config:{},layers:[]};
      else if(message.method==="configRequirements/read")result={requirements:{allowedWindowsSandboxImplementations:["unelevated"]}};
      else if(message.method==="memory/status")result={v2ConsolidatedThreads:20,v2Ready:true};
      else if(message.method==="windowsSandbox/readiness")result={status:readiness};
      else if(message.method==="windowsSandbox/setupStart"){
        setupSocket=ws;setupMode=message.params.mode;respond({started:true});return;
      }
      respond(result);
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamPort}`});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/codex/ws`,cwd:process.cwd(),platform:"win32",version:"sandbox-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");await page.getByRole("button",{name:"Tools",exact:true}).click();
    const card=page.locator(".capability-card").filter({hasText:"Windows sandbox"});await expect(card).toContainText("Not configured");
    const unelevated=card.getByRole("button",{name:"Set up unelevated"}),elevated=card.getByRole("button",{name:"Set up elevated"});
    await expect(unelevated).toBeEnabled();await expect(elevated).toBeDisabled();
    await page.screenshot({path:auditDir+"tools-windows-sandbox-not-configured-1600x980.png",fullPage:true});
    await unelevated.click();await expect(card).toContainText(/setup started/i);await expect(card.getByRole("button",{name:"Setting up…"})).toBeDisabled();
    expect(calls.find(call=>call.method==="windowsSandbox/setupStart")?.params).toEqual({mode:"unelevated",cwd:process.cwd()});
    await page.screenshot({path:auditDir+"tools-windows-sandbox-setting-up-1600x980.png",fullPage:true});
    readiness="ready";setupSocket.send(JSON.stringify({method:"windowsSandbox/setupCompleted",params:{mode:setupMode,success:true,error:null}}));
    await expect(card).toContainText("Ready",{timeout:5000});await expect(card.getByRole("button",{name:/Set up/})).toHaveCount(0);
    const socket=[...sockets][0];socket.send(JSON.stringify({method:"windows/worldWritableWarning",params:{samplePaths:["C:\\Temp\\Everyone"],extraCount:2,failedScan:false}}));
    await expect(card).toContainText(/cannot be protected/i);await expect(card).toContainText(/C:\\Temp\\Everyone/);
    await page.setViewportSize({width:1280,height:800});const bounds=await page.locator(".capabilities-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
    await page.screenshot({path:auditDir+"tools-windows-sandbox-ready-1280x800.png",fullPage:true});
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});
