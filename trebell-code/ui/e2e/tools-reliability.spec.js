import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

test("Tools refresh preserves the last valid plugin catalog when one RPC fails",async({page})=>{
  test.setTimeout(35_000);
  let failPlugins=false,failPluginInstall=false,failMcpReload=false;
  const thread={id:"tools-reliability-thread",name:"Tools reliability fixture",preview:"Tools refresh coverage",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  const http=createServer();const wss=new WebSocketServer({noServer:true});const sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      if(message.method==="plugin/list"&&failPlugins){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate plugin catalog refresh failure"}}));return;
      }
      if(message.method==="plugin/install"&&failPluginInstall){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate plugin install failure"}}));return;
      }
      if(message.method==="config/mcpServer/reload"&&failMcpReload){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate MCP reload failure"}}));return;
      }
      let result={};
      if(message.method==="initialize")result={userAgent:"tools-reliability-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="permissionProfile/list"||message.method==="app/list"||message.method==="hooks/list"||message.method==="experimentalFeature/list"||message.method==="plugin/share/list")result={data:[]};
      else if(message.method==="mcpServerStatus/list")result={data:[{name:"fixture-mcp",runtimeStatus:"connected",authStatus:"loggedIn",tools:{},resources:[]}]};
      else if(message.method==="plugin/list")result={marketplaces:[{name:"Fixture Marketplace",plugins:[{id:"known-good-plugin",name:"known-good-plugin",version:"1.0.0",installed:false,availability:"available",interface:{displayName:"Known Good Plugin",shortDescription:"Preserved plugin fixture"}}]}]};
      else if(message.method==="app/installed")result={apps:[]};
      else if(message.method==="thread/loaded/list")result={data:[],nextCursor:null};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      else if(message.method==="account/read")result={account:{type:"chatgpt",email:"fixture@example.com",planType:"plus"},requiresOpenaiAuth:false};
      else if(message.method==="account/rateLimits/read")result={rateLimits:{}};
      else if(message.method==="account/usage/read")result={summary:{}};
      else if(message.method==="config/read")result={config:{},layers:[]};
      else if(message.method==="configRequirements/read")result={requirements:null};
      else if(message.method==="memory/status")result={v2ConsolidatedThreads:23,v2Ready:true};
      else if(message.method==="server/diagnostics")result={process:{id:123,residentMemoryBytes:4096},gauges:[]};
      else if(message.method==="externalAgentConfig/import/readHistories")result={data:[],connectors:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${port}`,cwd:process.cwd(),platform:process.platform,version:"tools-reliability-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    await page.getByRole("button",{name:"Tools",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Harness capabilities",level:2})).toBeVisible({timeout:10_000});
    const plugins=page.locator(".capability-card").filter({hasText:"Plugins"}).first();
    await expect(plugins).toContainText("Known Good Plugin");
    failPlugins=true;
    await page.setViewportSize({width:1280,height:800});
    await page.locator(".capabilities-toolbar").getByRole("button",{name:"Refresh",exact:true}).click();
    const pluginError=plugins.getByText("Deliberate plugin catalog refresh failure",{exact:false});
    await expect(pluginError).toBeVisible();
    await expect(plugins).toContainText("Known Good Plugin");
    await expect(page.locator(".capabilities-toolbar").getByRole("button",{name:"Refresh",exact:true})).toBeEnabled();
    const metrics=await page.locator(".secondary-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await pluginError.scrollIntoViewIfNeeded();
    await expect(pluginError).toBeInViewport();
    await expect(plugins.getByText("Known Good Plugin",{exact:true})).toBeInViewport();
    await page.screenshot({path:auditDir+"tools-plugin-refresh-error-1280x800.png",fullPage:true});

    failPlugins=false;failPluginInstall=true;
    const install=plugins.getByRole("button",{name:"Install",exact:true});
    await install.click();
    const installError=plugins.getByText("Deliberate plugin install failure",{exact:false});
    await expect(installError).toBeVisible();
    await expect(install).toBeEnabled();
    await expect(install).toHaveText("Install");
    await expect(plugins).toContainText("Known Good Plugin");

    failMcpReload=true;
    const mcp=page.locator(".capability-card").filter({hasText:"MCP servers"}).first();
    const reload=mcp.getByRole("button",{name:"Reload MCP",exact:true});
    await reload.click();
    const mcpError=mcp.getByText("Deliberate MCP reload failure",{exact:false});
    await expect(mcpError).toBeVisible();
    await expect(reload).toBeEnabled();
    await mcpError.scrollIntoViewIfNeeded();
    await expect(mcpError).toBeInViewport();
    await page.screenshot({path:auditDir+"tools-action-errors-1280x800.png",fullPage:true});
  }finally{
    for(const socket of sockets)try{socket.terminate()}catch{}
    wss.close();await new Promise(resolve=>http.close(resolve));
  }
});
