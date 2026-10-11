import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("external agent imports use native progress and completion notifications",async({page})=>{
  test.setTimeout(35_000);
  const calls=[];let importStarted=false,importCompleted=false,postImportHistoryReads=0,notificationSocket=null;
  const migrationItem={itemType:"SKILLS",description:"Claude skills",cwd:null,details:{plugins:[],skills:[],sessions:[],mcpServers:[],hooks:[],subagents:[],commands:[],memory:[]}};
  const oldHistory={importId:"old-import",providerId:"claude",completedAtMs:Date.now()-60_000,successes:[{itemType:"CONFIG",cwd:null,source:"claude",target:"config.toml",title:null}],failures:[]};
  const completedHistory={importId:"import-new",providerId:"claude",completedAtMs:Date.now(),successes:[{itemType:"SKILLS",cwd:null,source:"claude",target:"skills",title:null}],failures:[{itemType:"MCP_SERVER_CONFIG",errorType:"invalid_config",subErrorType:null,failureStage:"write",message:"One connector could not be imported.",cwd:null,source:"claude"}]};
  const connector={name:"linear",sessionCount:3,source:"remoteMcpServersConfig"};
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);notificationSocket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"external-import-fixture"};
      else if(message.method==="thread/list")result={data:[],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="externalAgentConfig/detect")result={items:[migrationItem],connectors:[]};
      else if(message.method==="externalAgentConfig/import"){
        importStarted=true;ws.send(JSON.stringify({id:message.id,result:{importId:"import-new"}}));
        setTimeout(()=>notificationSocket?.send(JSON.stringify({method:"externalAgentConfig/import/progress",params:{importId:"import-new",itemTypeResults:[{itemType:"SKILLS",successes:[completedHistory.successes[0]],failures:[]}]}})),30);
        setTimeout(()=>{importCompleted=true;notificationSocket?.send(JSON.stringify({method:"externalAgentConfig/import/completed",params:{importId:"import-new",itemTypeResults:[{itemType:"SKILLS",successes:[completedHistory.successes[0]],failures:[]},{itemType:"MCP_SERVER_CONFIG",successes:[],failures:[completedHistory.failures[0]]}]}}))},220);
        return;
      }
      else if(message.method==="externalAgentConfig/import/readHistories"){
        if(importStarted)postImportHistoryReads++;
        result={data:importCompleted?[completedHistory,oldHistory]:[oldHistory],connectors:[connector]};
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
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:"linux",version:"external-import-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");await page.getByRole("button",{name:"Tools",exact:true}).click();
    const card=page.locator(".capability-card").filter({has:page.getByText("Import agent configuration",{exact:true})}).first();
    await expect(card).toContainText("Previous native imports · 1");await expect(card).toContainText("Imported connector candidates · 1");
    await card.getByRole("button",{name:"Scan"}).click();await expect(card).toContainText("Claude skills");await expect(card.locator(".capability-list>div").filter({hasText:"Claude skills"}).locator("em")).toHaveText("Skills");await card.getByRole("button",{name:"Import 1 item",exact:true}).click();
    await expect(card).toContainText("Importing · Skills · 1 imported");
    await expect(card).toContainText("Import complete · Skills, MCP server config · 1 imported · 1 failed",{timeout:10_000});expect(postImportHistoryReads).toBe(1);
    // A partly failed import says what failed: the item's kind and the runtime's message.
    const failuresAfterImport=card.getByRole("list",{name:"Import failures"});
    await expect(failuresAfterImport.getByRole("listitem")).toHaveCount(1);
    await expect(failuresAfterImport.getByRole("listitem")).toContainText("MCP server config");
    await expect(failuresAfterImport.getByRole("listitem")).toContainText("One connector could not be imported.");
    await expect(failuresAfterImport).not.toContainText("MCP_SERVER_CONFIG");
    const importCall=calls.find(call=>call.method==="externalAgentConfig/import");expect(importCall?.params).toEqual({migrationItems:[migrationItem],source:"trebell-code"});
    await expect(card).toContainText("Previous native imports · 2");
    await card.getByText("Previous native imports · 2",{exact:true}).click();await expect(card).toContainText("1 imported · 1 failed");await expect(card.locator(".migration-history-list strong").first()).toHaveText("Claude Code");
    // Each history row with failures opens to list them; its badge names the failures instead of a bare "review".
    const failedEntry=card.locator(".migration-history-list>details").filter({hasText:"1 failed"});
    await expect(card.locator(".migration-history-list")).not.toContainText("review");
    await expect(failedEntry.getByRole("list",{name:"Import failures"})).toBeHidden();
    await failedEntry.locator("summary").click();
    const entryFailures=failedEntry.getByRole("list",{name:"Import failures"});
    await expect(entryFailures).toBeVisible();
    await expect(entryFailures).toContainText("MCP server config");await expect(entryFailures).toContainText("One connector could not be imported.");await expect(entryFailures).toContainText("Write stage");
    await card.getByText("Imported connector candidates · 1",{exact:true}).click();await expect(card).toContainText("linear");await expect(card).toContainText("3 imported sessions");
    await page.setViewportSize({width:1280,height:800});await card.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+"tools-native-import-history-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});await page.screenshot({animations:"disabled",path:auditDir+"tools-native-import-history-light-1280x800.png",fullPage:false});
    const bounds=await card.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
    // A runtime that reports empty lists says so in each card instead of leaving the card blank under its heading.
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    const configLayers=page.locator(".capability-card").filter({has:page.getByText("Configuration layers",{exact:true})}).first();await expect(configLayers).toContainText("Codex reported no configuration layers.");
    const permissionProfiles=page.locator(".capability-card").filter({has:page.getByText("Permission profiles",{exact:true})}).first();await expect(permissionProfiles).toContainText("This runtime reported no permission profiles.");
    const mcpServers=page.locator(".capability-card").filter({has:page.getByText("MCP servers",{exact:true})}).first();await expect(mcpServers).toContainText("No MCP servers are configured for this runtime.");
    const features=page.locator(".capability-card").filter({has:page.getByText("Experimental features",{exact:true})}).first();await expect(features).toContainText("This runtime reported no experimental features.");
    await permissionProfiles.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+"tools-empty-runtime-lists-1280x800.png",fullPage:false});
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});

// A Codex app-server behind the real relay that answers the Tools page's reads with empty lists and the given import history.
async function startHistoryFixture(history){
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  const empty=["thread/list","threadSection/list","permissionProfile/list","mcpServerStatus/list","hooks/list","experimentalFeature/list","plugin/share/list","app/list","thread/loaded/list"];
  const answers={"initialize":{userAgent:"import-history-fixture"},"skills/list":{data:[]},"externalAgentConfig/detect":{items:[],connectors:[]},"externalAgentConfig/import/readHistories":{data:history,connectors:[]},"plugin/list":{marketplaces:[],marketplaceLoadErrors:[],featuredPluginIds:[]},"app/installed":{apps:[]},"modelProvider/capabilities/read":{namespaceTools:true,webSearch:true,imageGeneration:false},"account/read":{account:null,requiresOpenaiAuth:false},"account/rateLimits/read":{rateLimits:{}},"account/usage/read":{},"config/read":{config:{},layers:[]},"configRequirements/read":{requirements:{}},"memory/status":{v2ConsolidatedThreads:0,v2Ready:false},"server/diagnostics":{process:{id:4242,residentMemoryBytes:67108864,physicalFootprintBytes:null},gauges:[]}};
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{const message=JSON.parse(String(data));if(message.id==null||!message.method)return;ws.send(JSON.stringify({id:message.id,result:empty.includes(message.method)?{data:[],nextCursor:null}:answers[message.method]||{}}))});
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",async close(){relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}};
}

test("an opened import history row grows the history list instead of hiding its failures in a nested scroll area",async({page})=>{
  test.setTimeout(40_000);
  const longPath="C:/Users/someone/AppData/Roaming/Claude/very/deep/nested/configuration/directory/mcp-servers-config-backup-2026-10-11.json";
  const failures=[
    {itemType:"MCP_SERVER_CONFIG",errorType:"invalid_config",failureStage:"write",message:"One connector could not be imported because its command points at "+longPath+", which does not exist on this machine.",cwd:null,source:"claude"},
    {itemType:"HOOKS",errorType:"permission_denied",failureStage:"read",message:"",cwd:null,source:"claude"},
    {itemType:"AGENTS_MD",errorType:"conflict",failureStage:"merge",message:"AGENTS.md already has a section with the same heading.",cwd:"C:/repo",source:"claude"},
    {itemType:"SKILLS",errorType:"invalid_skill",failureStage:"validate",message:"Skill 'deploy' is missing a description.",cwd:null,source:"claude"},
  ];
  const history=[{importId:"import-many-failures",providerId:"claude",completedAtMs:Date.now(),successes:[{itemType:"SKILLS",cwd:null,source:"claude",target:"skills",title:null}],failures}];
  for(let index=0;index<7;index++)history.push({importId:"older-"+index,providerId:index%2?"claude":"cursor",completedAtMs:Date.now()-(index+1)*3_600_000,successes:[{itemType:"CONFIG",cwd:null,source:"claude",target:"config.toml",title:null}],failures:[]});
  const fixture=await startHistoryFixture(history);
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  try{
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:fixture.wsUrl,cwd:process.cwd(),platform:"linux",version:"import-history-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}}));
    await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await page.getByRole("button",{name:"Tools",exact:true}).click();
    const card=page.locator(".capability-card").filter({has:page.getByText("Import agent configuration",{exact:true})}).first();
    await card.getByText("Previous native imports · 8",{exact:true}).click();
    const list=card.locator(".migration-history-list"),failed=list.locator(":scope>details").first();
    await expect(failed.locator("summary")).toContainText("4 failed");
    // A keyboard user opens the row: focus its summary and press Enter.
    await failed.locator("summary").focus();await page.keyboard.press("Enter");
    await expect(failed).toHaveJSProperty("open",true);
    await expect(failed.getByRole("listitem")).toHaveCount(4);
    const metrics=()=>list.evaluate(node=>{const box=node.getBoundingClientRect(),open=node.querySelector(":scope>details[open]");return {client:node.clientHeight,scroll:node.scrollHeight,openBottom:open?open.getBoundingClientRect().bottom:null,listBottom:box.bottom,lastBottom:node.lastElementChild.getBoundingClientRect().bottom}});
    const opened=await metrics();
    // The opened row and every row after it show in full: the list grows with the row rather than scrolling inside the card.
    expect(opened.scroll,JSON.stringify(opened)).toBeLessThanOrEqual(opened.client+1);
    expect(opened.openBottom,JSON.stringify(opened)).toBeLessThanOrEqual(opened.listBottom+1);
    expect(opened.lastBottom,JSON.stringify(opened)).toBeLessThanOrEqual(opened.listBottom+1);
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      await failed.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:auditDir+`tools-import-history-open-${mode}-1280x800.png`,fullPage:false});
    }
    // Closed again, the list keeps its usual height cap.
    await page.keyboard.press("Enter");
    await expect(failed).toHaveJSProperty("open",false);
    expect(await list.evaluate(node=>getComputedStyle(node).maxHeight)).not.toBe("none");
  }finally{await fixture.close()}
});
