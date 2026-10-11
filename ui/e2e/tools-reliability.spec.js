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
  let failPlugins=false,failPluginInstall=false,failMcpReload=false,failMcpLogin=false,failSkills=false,failMarketplaceAdd=false;
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
      if(message.method==="mcpServer/oauth/login"&&failMcpLogin){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate MCP sign-in failure"}}));return;
      }
      if(message.method==="skills/list"&&failSkills){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate skills refresh failure"}}));return;
      }
      if(message.method==="marketplace/add"&&failMarketplaceAdd){
        ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"Deliberate marketplace add failure"}}));return;
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
      else if(message.method==="skills/list")result={data:[{cwd:process.cwd(),skills:[{name:"fixture-skill",path:"C:\\fixture\\SKILL.md",enabled:true,description:"Preserved skill fixture"}]}]};
      else if(message.method==="skills/config/write")result={effectiveEnabled:false};
      else if(message.method==="permissionProfile/list"||message.method==="app/list"||message.method==="hooks/list"||message.method==="experimentalFeature/list"||message.method==="plugin/share/list")result={data:[]};
      else if(message.method==="mcpServerStatus/list")result={data:[{name:"fixture-mcp",runtimeStatus:"connected",authStatus:"loggedIn",tools:{lookup:{name:"lookup",description:"Look up a fixture record",inputSchema:{type:"object",properties:{}}}},resources:[{uri:"fixture://readme",name:"README"}]},{name:"fixture-login",runtimeStatus:"connected",authStatus:"notLoggedIn",tools:{},resources:[]}]};
      else if(message.method==="plugin/list")result={marketplaces:[{name:"Fixture Marketplace",plugins:[{id:"known-good-plugin",name:"known-good-plugin",version:"1.0.0",installed:false,availability:"available",interface:{displayName:"Known Good Plugin",shortDescription:"Preserved plugin fixture"}}]}]};
      else if(message.method==="app/installed")result={apps:[]};
      else if(message.method==="thread/loaded/list")result={data:[],nextCursor:null};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      else if(message.method==="account/read")result={account:{type:"chatgpt",email:"fixture@example.com",planType:"plus"},requiresOpenaiAuth:false};
      else if(message.method==="account/rateLimits/read")result={rateLimits:{}};
      else if(message.method==="account/usage/read")result={summary:{}};
      else if(message.method==="config/read")result={config:{},layers:[{name:{type:"user",file:"C:\\fixture\\config.toml"},version:"sha256:0123456789abcdef0123456789abcdef",disabledReason:null}]};
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
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${port}`,cwd:process.cwd(),platform:process.platform,version:"tools-reliability-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    await page.getByRole("button",{name:"Tools",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Harness capabilities",level:2})).toBeVisible({timeout:10_000});
    const configLayers=page.locator(".capability-card").filter({hasText:"Configuration layers"}).first();
    await expect(configLayers).toContainText("User config");
    await expect(configLayers).toContainText("config.toml");
    await expect(configLayers).not.toContainText("[object Object]");
    const plugins=page.locator(".capability-card").filter({hasText:"Plugins"}).first();
    await expect(plugins).toContainText("Known Good Plugin");
    failPlugins=true;
    await page.setViewportSize({width:1280,height:800});
    await page.locator(".capabilities-toolbar").getByRole("button",{name:"Refresh",exact:true}).click();
    const pluginError=plugins.getByText("Deliberate plugin catalog refresh failure",{exact:false});
    await expect(pluginError).toBeVisible();
    // Each error line names what failed before the reason Codex gave.
    await expect(pluginError).toHaveText("Could not load the plugin catalog: Deliberate plugin catalog refresh failure");
    await expect(plugins).toContainText("Known Good Plugin");
    await expect(page.locator(".capabilities-toolbar").getByRole("button",{name:"Refresh",exact:true})).toBeEnabled();
    const metrics=await page.locator(".secondary-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await pluginError.scrollIntoViewIfNeeded();
    await expect(pluginError).toBeInViewport();
    await expect(plugins.getByText("Known Good Plugin",{exact:true})).toBeInViewport();
    await page.screenshot({animations:"disabled",path:auditDir+"tools-plugin-refresh-error-1280x800.png",fullPage:true});

    failPlugins=false;failPluginInstall=true;
    const install=plugins.getByRole("button",{name:"Install",exact:true});
    await install.click();
    const installError=plugins.getByText("Deliberate plugin install failure",{exact:false});
    await expect(installError).toHaveText("Could not install Known Good Plugin: Deliberate plugin install failure");
    await expect(install).toBeEnabled();
    await expect(install).toHaveText("Install");
    await expect(plugins).toContainText("Known Good Plugin");

    failMcpReload=true;
    const mcp=page.locator(".capability-card").filter({hasText:"MCP servers"}).first();
    const signedInServer=mcp.locator(".mcp-server-row").filter({hasText:"fixture-mcp"});
    await expect(signedInServer).toContainText("connected · 1 tool · 1 resource");
    await expect(signedInServer.locator(".capability-inline-actions>em")).toHaveText("Signed in");
    const signInServer=mcp.locator(".mcp-server-row").filter({hasText:"fixture-login"});
    await expect(signInServer).toContainText("connected · 0 tools · 0 resources");
    await expect(signInServer.locator(".capability-inline-actions>em")).toHaveText("Sign-in required");
    await expect(mcp).not.toContainText("notLoggedIn");
    const permissionProfiles=page.locator(".capability-card").filter({has:page.getByText("Permission profiles",{exact:true})}).first();
    await expect(permissionProfiles).toContainText("This runtime reported no permission profiles.");
    await mcp.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"tools-mcp-sign-in-labels-1280x800.png",fullPage:false});
    const reload=mcp.getByRole("button",{name:"Reload MCP",exact:true});
    await reload.click();
    const mcpError=mcp.getByText("Deliberate MCP reload failure",{exact:false});
    await expect(mcpError).toHaveText("Could not reload MCP servers: Deliberate MCP reload failure");
    await expect(reload).toBeEnabled();
    await mcpError.scrollIntoViewIfNeeded();
    await expect(mcpError).toBeInViewport();
    await page.screenshot({animations:"disabled",path:auditDir+"tools-action-errors-1280x800.png",fullPage:true});

    failMcpLogin=true;
    const signIn=mcp.getByRole("button",{name:"Sign in",exact:true});
    await signIn.click();
    const signInError=mcp.getByText("Deliberate MCP sign-in failure",{exact:false});
    await expect(signInError).toHaveText("Could not sign in to fixture-login: Deliberate MCP sign-in failure");
    await expect(signIn).toBeEnabled();

    failSkills=true;
    const skills=page.locator(".capability-card").filter({hasText:"Skills"}).first();
    const skillToggle=skills.getByRole("button",{name:"On",exact:true});
    await expect(skills).toContainText("fixture-skill");
    await skillToggle.click();
    const skillsError=skills.getByText("Deliberate skills refresh failure",{exact:false});
    await expect(skillsError).toHaveText("Could not refresh skills: Deliberate skills refresh failure");
    await expect(skills).toContainText("fixture-skill");
    await expect(skills.getByRole("button",{name:"Off",exact:true})).toBeEnabled();
    await skillsError.scrollIntoViewIfNeeded();
    await expect(skillsError).toBeInViewport();
    await page.screenshot({animations:"disabled",path:auditDir+"tools-skills-refresh-error-1280x800.png",fullPage:true});

    failMarketplaceAdd=true;
    const marketplaces=page.locator(".capability-card").filter({hasText:"Marketplaces"}).first();
    const source=marketplaces.getByPlaceholder("Git URL or local path");
    await source.fill("https://example.test/retry-marketplace.git");
    await marketplaces.getByRole("button",{name:"Add",exact:true}).click();
    const marketplaceError=marketplaces.getByText("Deliberate marketplace add failure",{exact:false});
    await expect(marketplaceError).toHaveText("Could not add the marketplace: Deliberate marketplace add failure");
    await expect(source).toHaveValue("https://example.test/retry-marketplace.git");
    await expect(marketplaces.getByRole("button",{name:"Add",exact:true})).toBeEnabled();
    await marketplaceError.scrollIntoViewIfNeeded();
    await expect(marketplaceError).toBeInViewport();
    await page.screenshot({animations:"disabled",path:auditDir+"tools-marketplace-action-error-1280x800.png",fullPage:true});
  }finally{
    for(const socket of sockets)try{socket.terminate()}catch{}
    wss.close();await new Promise(resolve=>http.close(resolve));
  }
});

// A Codex app-server for the Tools page whose MCP server list (the slow read: Codex starts the servers before it answers) can be
// held, answered with one server or none, or failed. The other lists answer at once, full or empty. With `holdInit` the
// handshake waits too, so the app stays connecting until `releaseInit()`.
async function startHeldMcpFixture(){
  const control={mcp:"servers",lists:"full",hold:true,held:[],holdInit:false,heldInit:[]};
  const server={name:"docs-server",runtimeStatus:"connected",authStatus:"unsupported",tools:{},resources:[]};
  const http=createServer();const wss=new WebSocketServer({noServer:true});const sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;
      const send=payload=>ws.send(JSON.stringify({id:message.id,...payload}));
      if(message.method==="mcpServerStatus/list"){
        const answer=()=>control.mcp==="fail"?send({error:{code:-32000,message:"Deliberate MCP server list failure"}}):send({result:{data:control.mcp==="servers"?[server]:[],nextCursor:null}});
        if(control.hold)control.held.push(answer);else answer();
        return;
      }
      if(message.method==="initialize"&&control.holdInit){control.heldInit.push(()=>send({result:{userAgent:"tools-held-list-fixture"}}));return}
      const full=control.lists==="full";let result={};
      if(message.method==="initialize")result={userAgent:"tools-held-list-fixture"};
      else if(message.method==="permissionProfile/list")result={data:full?[{id:"workspace-write",description:"Edit files in the workspace",allowed:true}]:[]};
      else if(message.method==="experimentalFeature/list")result={data:full?[{name:"step_model_switching",displayName:"Step model switching",description:"Switch models between steps of a running turn.",enabled:false}]:[]};
      else if(["thread/list","threadSection/list","collaborationMode/list","app/list","hooks/list","plugin/share/list","thread/loaded/list","skills/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="plugin/list")result={marketplaces:[]};
      else if(message.method==="app/installed")result={apps:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      else if(message.method==="account/read")result={account:{type:"chatgpt",email:"fixture@example.com",planType:"plus"},requiresOpenaiAuth:false};
      else if(message.method==="account/rateLimits/read")result={rateLimits:{}};
      else if(message.method==="account/usage/read")result={summary:{}};
      else if(message.method==="config/read")result={config:{},layers:[]};
      else if(message.method==="configRequirements/read")result={requirements:null};
      else if(message.method==="memory/status")result={v2ConsolidatedThreads:3,v2Ready:false};
      else if(message.method==="server/diagnostics")result={process:{id:321,residentMemoryBytes:4096},gauges:[]};
      else if(message.method==="externalAgentConfig/import/readHistories")result={data:[],connectors:[]};
      else if(message.method==="windowsSandbox/readiness")result={status:"ready"};
      send({result});
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {control,wsUrl:`ws://127.0.0.1:${port}`,
    release(){control.hold=false;for(const answer of control.held.splice(0))answer()},
    releaseInit(){control.holdInit=false;for(const answer of control.heldInit.splice(0))answer()},
    async close(){for(const socket of sockets)try{socket.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}
async function openTools(page,wsUrl,{connected=true}={}){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl,cwd:process.cwd(),platform:process.platform,version:"tools-held-list-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.goto("/");
  await page.getByRole("button",{name:"Tools",exact:true}).click();
  if(connected)await expect(page.getByRole("heading",{name:"Harness capabilities",level:2})).toBeVisible({timeout:10_000});
  else await expect(page.getByText("Codex harness is not connected",{exact:true})).toBeVisible({timeout:10_000});
}
// Records every listed claim the page ever puts in its text, from the first script on, so a claim shown for a single frame (and
// replaced before an assertion could look) is caught as well. A text changed in place leaves its old value in the record.
async function recordClaims(page,claims){
  await page.addInitScript(claims=>{
    const seen=window.__claimsSeen=[];
    const note=text=>{if(text)for(const claim of claims)if(text.includes(claim)&&!seen.includes(claim))seen.push(claim)};
    new MutationObserver(records=>{for(const record of records){
      if(record.type==="characterData"){note(record.oldValue);note(record.target.data)}
      else for(const node of [...record.addedNodes,...record.removedNodes])note(node.textContent);
    }}).observe(document,{subtree:true,childList:true,characterData:true,characterDataOldValue:true});
  },claims);
  return ()=>page.evaluate(()=>window.__claimsSeen);
}

test("Tools opened while Codex connects never claims the runtime reported nothing before it answers",async({page})=>{
  test.setTimeout(45_000);
  const fixture=await startHeldMcpFixture();fixture.control.holdInit=true;
  // The runtime answers every one of these cards with data, so none of their empty claims may appear at any point.
  const claims=["Codex did not return account metadata for this inference route.","Memory readiness is unavailable from this Codex runtime.","Process diagnostics are unavailable from this Codex runtime.","No capability report available.","Windows sandbox readiness is unavailable from this Codex runtime.","This runtime reported no permission profiles.","No MCP servers are configured for this runtime.","This runtime reported no experimental features."];
  const claimsSeen=await recordClaims(page,claims);
  try{
    await page.setViewportSize({width:1280,height:800});
    // The page is opened while the handshake is still pending, so it mounts before Codex connects.
    await openTools(page,fixture.wsUrl,{connected:false});
    fixture.releaseInit();
    const tools=page.locator(".capabilities-page"),refresh=page.locator(".capabilities-toolbar button");
    await expect(page.getByRole("heading",{name:"Harness capabilities",level:2})).toBeVisible({timeout:10_000});
    // The MCP list is still held: the page says it is loading.
    await expect(refresh).toHaveText("Refreshing…");
    await expect(tools.locator(".capability-card").filter({has:page.getByText("MCP servers",{exact:true})})).toContainText("Loading MCP servers…");
    fixture.release();
    await expect(refresh).toHaveText("Refresh");
    await expect(tools.locator(".mcp-server-row")).toContainText("docs-server");
    await expect(tools).toContainText("fixture@example.com");
    expect(await claimsSeen()).toEqual([]);
  }finally{await fixture.close()}
});

test("Tools cards claim a runtime list is empty only once it has loaded empty",async({page})=>{
  test.setTimeout(45_000);
  const fixture=await startHeldMcpFixture();
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    const tools=page.locator(".capabilities-page"),refresh=page.locator(".capabilities-toolbar button");
    const card=title=>tools.locator(".capability-card").filter({has:page.getByText(title,{exact:true})}).first();
    const listClaims=["This runtime reported no permission profiles.","No MCP servers are configured for this runtime.","This runtime reported no experimental features."];
    const otherClaims=["Codex did not return account metadata for this inference route.","Memory readiness is unavailable from this Codex runtime.","Process diagnostics are unavailable from this Codex runtime.","No capability report available.","No plugin catalog is available in this runtime.","No shared plugins were returned for this account.","No app connectors reported by Codex.","No project hooks loaded."];
    const expectNoClaims=async claims=>{for(const claim of claims)await expect(tools.getByText(claim,{exact:true}),claim).toHaveCount(0)};
    // The first load waits on every read, and the MCP list is still starting its servers: no card says its list is empty,
    // although the runtime has a profile, a server and a feature to report. The cards say they are loading instead.
    await expect(refresh).toHaveText("Refreshing…");
    await expectNoClaims([...listClaims,...otherClaims]);
    await expect(card("MCP servers")).toContainText("Loading MCP servers…");
    await expect(card("Permission profiles")).toContainText("Loading permission profiles…");
    await expect(card("Experimental features")).toContainText("Loading experimental features…");
    // A count badge waits for its list too, rather than reading 0.
    for(const title of ["Permission profiles","MCP servers","Experimental features","Plugins","Hooks"])await expect(card(title).locator(".capability-card-head em"),title).toHaveCount(0);
    await expect(card("Configuration layers").locator(".capability-card-head em")).toHaveCount(0);
    await card("MCP servers").scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"tools-first-load-pending-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"tools-first-load-pending-light-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});

    fixture.release();
    await expect(refresh).toHaveText("Refresh");
    await expect(card("MCP servers").locator(".mcp-server-row")).toContainText("docs-server");
    await expect(card("Permission profiles")).toContainText("workspace-write");
    await expect(card("Experimental features")).toContainText("Step model switching");
    await expectNoClaims(listClaims);
    await expect(tools.getByText(/^Loading .*…$/)).toHaveCount(0);
    for(const title of ["Permission profiles","MCP servers","Experimental features"])await expect(card(title).locator(".capability-card-head em"),title).toHaveText("1");
    // Lists that loaded empty still say so, with a count of 0.
    await expect(card("Hooks")).toContainText("No project hooks loaded.");
    await expect(card("Apps / connectors")).toContainText("No app connectors reported by Codex.");
    await expect(card("Hooks").locator(".capability-card-head em")).toHaveText("0");
    await expect(card("Configuration layers").locator(".capability-card-head em")).toHaveText("0 layers");
    // While a refresh runs, a list keeps its rows on screen and so its count; a list that loaded empty says it is loading again,
    // and its card head drops the "0" until this answer lands, so head and body agree.
    fixture.control.hold=true;
    await refresh.click();
    await expect(refresh).toHaveText("Refreshing…");
    for(const title of ["Permission profiles","MCP servers","Experimental features"])await expect(card(title).locator(".capability-card-head em"),title).toHaveText("1");
    await expect(card("Hooks")).toContainText("Loading hooks…");
    await expect(card("Hooks").locator(".capability-card-head em")).toHaveCount(0);
    await expect(card("Configuration layers")).toContainText("Loading configuration layers…");
    await expect(card("Configuration layers").locator(".capability-card-head em")).toHaveCount(0);
    fixture.release();
    await expect(refresh).toHaveText("Refresh");
    await expect(card("Hooks").locator(".capability-card-head em")).toHaveText("0");
    await expect(card("Configuration layers").locator(".capability-card-head em")).toHaveText("0 layers");

    // A refresh that answers every list empty shows each claim.
    fixture.control.mcp="empty";fixture.control.lists="empty";
    await refresh.click();
    for(const claim of listClaims)await expect(tools.getByText(claim,{exact:true}),claim).toBeVisible();

    // The MCP list then fails: its error replaces the claim.
    fixture.control.mcp="fail";
    await refresh.click();
    const mcpError=card("MCP servers").locator(".capability-error");
    await expect(mcpError).toHaveText("Could not load MCP servers: Deliberate MCP server list failure");
    await expectNoClaims([listClaims[1]]);

    // Refreshing after that failure: while the list is held again, the cleared error is not replaced by a claim that there are
    // no MCP servers, and the lists that loaded empty before wait for this answer too.
    fixture.control.mcp="empty";fixture.control.hold=true;
    await refresh.click();
    await expect(refresh).toHaveText("Refreshing…");
    await expect(mcpError).toHaveCount(0);
    await expectNoClaims(listClaims);
    await expect(card("MCP servers")).toContainText("Loading MCP servers…");
    // Every list here loaded empty before, so every card says it is loading and none keeps a "0" (or "0 layers") in its head.
    const emptyLists=["Permission profiles","MCP servers","Plugins","Shared plugins","Marketplaces","Apps / connectors","Hooks","Experimental features","Configuration layers"];
    for(const title of emptyLists)await expect(card(title).locator(".capability-card-head em"),title).toHaveCount(0);
    await card("MCP servers").scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"tools-refresh-after-failure-pending-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await card("Permission profiles").scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"tools-refresh-after-failure-pending-light-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    fixture.release();
    await expect(refresh).toHaveText("Refresh");
    for(const claim of listClaims)await expect(tools.getByText(claim,{exact:true}),claim).toBeVisible();
    for(const title of emptyLists.slice(0,-1))await expect(card(title).locator(".capability-card-head em"),title).toHaveText("0");
    await expect(card("Configuration layers").locator(".capability-card-head em")).toHaveText("0 layers");
    await page.screenshot({animations:"disabled",path:auditDir+"tools-loaded-empty-lists-1280x800.png",fullPage:false});

    // The refresh an action runs once it succeeds (here Reload MCP) is the same: the empty lists' counts wait for it too.
    fixture.control.hold=true;
    await card("MCP servers").getByRole("button",{name:"Reload MCP",exact:true}).click();
    await expect(refresh).toHaveText("Refreshing…");
    await expect(card("Permission profiles")).toContainText("Loading permission profiles…");
    for(const title of emptyLists)await expect(card(title).locator(".capability-card-head em"),title).toHaveCount(0);
    fixture.release();
    await expect(refresh).toHaveText("Refresh");
    await expect(card("Permission profiles").locator(".capability-card-head em")).toHaveText("0");
  }finally{await fixture.close()}
});

test("Tools Conversation history claims no history only for the latest scan, and names a failed scan or import",async({page})=>{
  test.setTimeout(45_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  let scan="empty";const heldScans=[];
  const session={id:"history-claude-1",source:"claude",providerSessionId:"claude-history-1",cwd:process.cwd(),title:"Recent Claude conversation",preview:"Recent Claude conversation",alreadyImported:false};
  const answer=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/history-import$/,route=>{
    if(route.request().method()==="POST")return answer(route,{error:"Deliberate history import failure"},500);
    if(scan==="fail")return answer(route,{error:"Deliberate history scan failure"},500);
    if(scan==="hold")return heldScans.push(route);
    return answer(route,{codexImportAvailable:true,sessions:scan==="sessions"?[session]:[]});
  });
  const shoot=async name=>{
    await page.screenshot({animations:"disabled",path:auditDir+name+"-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+name+"-light-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
  };
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    const history=page.locator(".capabilities-page .capability-card").filter({has:page.getByText("Conversation history",{exact:true})}).first();
    const claim=history.getByText("No recent local agent history was found.",{exact:true}),badge=history.locator(".capability-card-head em");
    const scanButton=history.getByRole("button",{name:"Scan history",exact:true}),alert=history.getByRole("alert");
    // Nothing is claimed before the first scan.
    await expect(claim).toHaveCount(0);await expect(badge).toHaveCount(0);
    await scanButton.click();
    await expect(claim).toBeVisible();await expect(badge).toHaveText("0");

    // A re-scan fails: the alert names the scan, and the card no longer says there is no history, as that answer is not the latest.
    scan="fail";await scanButton.click();
    await expect(alert).toHaveText("Could not scan conversation history: Deliberate history scan failure");
    await expect(claim).toHaveCount(0);await expect(badge).toHaveCount(0);
    await history.scrollIntoViewIfNeeded();
    await shoot("tools-history-scan-failed");

    // While the next scan runs, the card claims nothing either.
    scan="hold";await scanButton.click();
    await expect(history.getByRole("button",{name:"Scanning…",exact:true})).toBeDisabled();
    await expect.poll(()=>heldScans.length).toBe(1);
    await expect(alert).toHaveCount(0);await expect(claim).toHaveCount(0);await expect(badge).toHaveCount(0);
    await shoot("tools-history-scan-pending");

    // That scan finds nothing, and the card says so again.
    for(const route of heldScans.splice(0))await answer(route,{codexImportAvailable:true,sessions:[]});
    await expect(claim).toBeVisible();await expect(badge).toHaveText("0");

    // A scan that finds a conversation lists it. Importing it fails: the alert names the import, and the row stays importable.
    scan="sessions";await scanButton.click();
    const rows=history.locator(".history-import-list");
    await expect(rows).toContainText("Recent Claude conversation");
    await expect(claim).toHaveCount(0);await expect(badge).toHaveText("1");
    await rows.getByRole("button",{name:"Import",exact:true}).click();
    await expect(alert).toHaveText("Could not import conversations: Deliberate history import failure");
    await expect(rows).toContainText("available");
    await expect(rows.getByRole("button",{name:"Import",exact:true})).toBeEnabled();
    await expect(badge).toHaveText("1");
    await shoot("tools-history-import-failed");
  }finally{for(const route of heldScans.splice(0))await answer(route,{sessions:[]}).catch(()=>{});await fixture.close()}
});
