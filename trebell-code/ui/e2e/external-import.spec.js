import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("external agent imports wait for persisted native completion history",async({page})=>{
  test.setTimeout(35_000);
  const calls=[];let importStarted=false,postImportHistoryReads=0;
  const migrationItem={itemType:"SKILLS",description:"Claude skills",cwd:null,details:{plugins:[],skills:[],sessions:[],mcpServers:[],hooks:[],subagents:[],commands:[],memory:[]}};
  const oldHistory={importId:"old-import",providerId:"claude",completedAtMs:Date.now()-60_000,successes:[{itemType:"CONFIG",cwd:null,source:"claude",target:"config.toml",title:null}],failures:[]};
  const completedHistory={importId:"import-new",providerId:"claude",completedAtMs:Date.now(),successes:[{itemType:"SKILLS",cwd:null,source:"claude",target:"skills",title:null}],failures:[{itemType:"MCP_SERVER_CONFIG",errorType:"invalid_config",subErrorType:null,failureStage:"write",message:"One connector could not be imported.",cwd:null,source:"claude"}]};
  const connector={name:"linear",sessionCount:3,source:"remoteMcpServersConfig"};
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"external-import-fixture"};
      else if(message.method==="thread/list")result={data:[],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="externalAgentConfig/detect")result={items:[migrationItem],connectors:[]};
      else if(message.method==="externalAgentConfig/import"){importStarted=true;result={importId:"import-new"}}
      else if(message.method==="externalAgentConfig/import/readHistories"){
        if(importStarted)postImportHistoryReads++;
        result={data:importStarted&&postImportHistoryReads>=2?[completedHistory,oldHistory]:[oldHistory],connectors:[connector]};
      }
      else if(message.method==="permissionProfile/list"||message.method==="mcpServerStatus/list"||message.method==="hooks/list"||message.method==="experimentalFeature/list"||message.method==="plugin/share/list")result={data:[],nextCursor:null};
      else if(message.method==="plugin/list")result={marketplaces:[],marketplaceLoadErrors:[],featuredPluginIds:[]};
      else if(message.method==="app/list")result={data:[],nextCursor:null};
      else if(message.method==="app/installed")result={apps:[]};
      else if(message.method==="thread/loaded/list")result={data:[],nextCursor:null};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      else if(message.method==="account/read")result={account:null,requiresOpenaiAuth:false};
      else if(message.method==="account/rateLimits/read")result={rateLimits:{}};
      else if(message.method==="account/usage/read")result={};
      else if(message.method==="config/read")result={config:{},layers:[]};
      else if(message.method==="configRequirements/read")result={requirements:{}};
      else if(message.method==="memory/status")result={v2ConsolidatedThreads:0,v2Ready:false};
      else if(message.method==="server/diagnostics")result={process:{id:4242,residentMemoryBytes:67108864,physicalFootprintBytes:null},gauges:[]};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:"linux",version:"external-import-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");await page.getByRole("button",{name:"Tools",exact:true}).click();
    const card=page.locator(".capability-card").filter({has:page.getByText("Import agent configuration",{exact:true})}).first();
    await expect(card).toContainText("Previous native imports · 1");await expect(card).toContainText("Imported connector candidates · 1");
    await card.getByRole("button",{name:"Scan"}).click();await expect(card).toContainText("Claude skills");await card.getByRole("button",{name:"Import 1 items"}).click();
    await expect(card).toContainText("1 imported · 1 failed",{timeout:10_000});expect(postImportHistoryReads).toBeGreaterThanOrEqual(2);
    const importCall=calls.find(call=>call.method==="externalAgentConfig/import");expect(importCall?.params).toEqual({migrationItems:[migrationItem],source:"trebell-code"});
    await expect(card).toContainText("Previous native imports · 2");
    await card.getByText("Previous native imports · 2",{exact:true}).click();await expect(card).toContainText("1 imported · 1 failed");
    await card.getByText("Imported connector candidates · 1",{exact:true}).click();await expect(card).toContainText("linear");await expect(card).toContainText("3 imported sessions");
    await page.setViewportSize({width:1280,height:800});await card.scrollIntoViewIfNeeded();await page.screenshot({path:auditDir+"tools-native-import-history-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({path:auditDir+"tools-native-import-history-light-1280x800.png",fullPage:false});
    const bounds=await card.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});
