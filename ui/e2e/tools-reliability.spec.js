import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { keepThreadMeta } from "./test-home.js";

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
    await keepThreadMeta(page);
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
// handshake waits too, so the app stays connecting until `releaseInit()`. The skills list (which the app reads for the composer
// and the Tools page) answers `control.skills` as it stands when it answers: "empty", "listed" (one skill) or "fail", or what
// `control.skillsByCwd` names for the workspace read, and waits while `holdSkills` is set, until `releaseSkills()`. It lists
// `threads` and resumes them, and the account's shared plugins as `control.shared` holds them: a checkout gives its plugin a local
// copy, a delete takes the share off the list and a visibility change sets who can find it, once answered; while `holdShare` is set
// they wait, until `releaseShare()`. One answered after its connection closed is done all the same, as Codex finishes what it was
// asked, but its answer is lost. The effective configuration is `control.config`. `drop()` closes the app's connections while the
// fixture keeps listening, so the app connects again.
async function startHeldMcpFixture({threads=[]}={}){
  const control={mcp:"servers",lists:"full",hold:true,held:[],holdInit:false,heldInit:[],skills:"empty",skillsByCwd:{},holdSkills:false,heldSkills:[],skillReads:0,skillCwds:[],shared:[],holdShare:false,heldShare:[],config:{}};
  const server={name:"docs-server",runtimeStatus:"connected",authStatus:"unsupported",tools:{},resources:[]};
  const skill={name:"release-notes",description:"Draft release notes from merged pull requests",path:"/home/test/.codex/skills/release-notes/SKILL.md",scope:"user",enabled:true,interface:{displayName:"Release notes"}};
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
      if(message.method==="skills/list"){
        const cwd=message.params?.cwds?.[0]||process.cwd();control.skillReads++;control.skillCwds.push(cwd);
        const answer=()=>{const mode=control.skillsByCwd[cwd]||control.skills;return mode==="fail"?send({error:{code:-32000,message:"Deliberate skills list failure"}}):send({result:{data:[{cwd,skills:mode==="listed"?[skill]:[],errors:[]}]}})};
        if(control.holdSkills)control.heldSkills.push(answer);else answer();
        return;
      }
      if(["plugin/share/checkout","plugin/share/delete","plugin/share/updateTargets"].includes(message.method)){
        const {remotePluginId:id,discoverability}=message.params||{},checkout=message.method==="plugin/share/checkout",copy="/home/test/plugins/"+id,mine=item=>item.plugin.remotePluginId===id;
        const answer=()=>{
          if(message.method==="plugin/share/delete")control.shared=control.shared.filter(item=>!mine(item));
          else control.shared=control.shared.map(item=>!mine(item)?item:checkout?{...item,localPluginPath:copy}:{...item,plugin:{...item.plugin,shareContext:{...item.plugin.shareContext,discoverability}}});
          if(ws.readyState===ws.OPEN)send({result:checkout?{localPluginPath:copy}:{}});
        };
        if(control.holdShare)control.heldShare.push(answer);else answer();
        return;
      }
      if(message.method==="thread/resume"&&threads.length){send({result:{thread:{...(threads.find(thread=>thread.id===message.params?.threadId)||threads[0]),turns:[]}}});return}
      if(message.method==="initialize"&&control.holdInit){control.heldInit.push(()=>send({result:{userAgent:"tools-held-list-fixture"}}));return}
      const full=control.lists==="full";let result={};
      if(message.method==="initialize")result={userAgent:"tools-held-list-fixture"};
      else if(message.method==="permissionProfile/list")result={data:full?[{id:"workspace-write",description:"Edit files in the workspace",allowed:true}]:[]};
      else if(message.method==="experimentalFeature/list")result={data:full?[{name:"step_model_switching",displayName:"Step model switching",description:"Switch models between steps of a running turn.",enabled:false}]:[]};
      else if(message.method==="thread/list")result={data:threads.map(thread=>({...thread,turns:[]})),nextCursor:null};
      else if(message.method==="plugin/share/list")result={data:control.shared,nextCursor:null};
      else if(["threadSection/list","collaborationMode/list","app/list","hooks/list","thread/loaded/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/continuity/get")result={continuity:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="plugin/list")result={marketplaces:[]};
      else if(message.method==="app/installed")result={apps:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      else if(message.method==="account/read")result={account:{type:"chatgpt",email:"fixture@example.com",planType:"plus"},requiresOpenaiAuth:false};
      else if(message.method==="account/rateLimits/read")result={rateLimits:{}};
      else if(message.method==="account/usage/read")result={summary:{}};
      else if(message.method==="config/read")result={config:control.config,layers:[]};
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
    releaseSkills(){control.holdSkills=false;for(const answer of control.heldSkills.splice(0))answer()},
    releaseShare(){for(const answer of control.heldShare.splice(0))answer()},
    drop(){for(const socket of sockets)try{socket.terminate()}catch{}},
    async close(){for(const socket of sockets)try{socket.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}
// projects are the saved projects (activeProjectId the open one); opening one answers with it, as the server does.
async function openTools(page,wsUrl,{connected=true,cwd=process.cwd(),projects=[],activeProjectId=null,threadMeta={}}={}){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl,cwd,platform:process.platform,version:"tools-held-list-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",...(activeProjectId?{activeProjectId}:{})},projects,threadMeta}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>{
    const opened=route.request().method()==="POST"?projects.find(project=>project.path===route.request().postDataJSON()?.path):null;
    return json(route,{projects,...(opened?{project:opened}:{})});
  });
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

test("Tools Skills card claims no skills only once the skills list has loaded empty, and names a failed list",async({page})=>{
  test.setTimeout(45_000);
  const fixture=await startHeldMcpFixture();fixture.release();fixture.control.holdSkills=true;
  const emptyClaim="No skills were discovered for this workspace.";
  const claimsSeen=await recordClaims(page,[emptyClaim]);
  const shoot=async name=>{
    await page.screenshot({animations:"disabled",path:auditDir+name+"-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+name+"-light-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
  };
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    const refresh=page.locator(".capabilities-toolbar button");
    const skills=page.locator(".capabilities-page .capability-card").filter({has:page.getByText("Skills",{exact:true})}).first();
    const claim=skills.getByText(emptyClaim,{exact:true}),pending=skills.getByText("Loading skills…",{exact:true});
    const badge=skills.locator(".capability-card-head em"),failure=skills.locator(".capability-error"),rows=skills.locator(".skill-list");
    // Codex has not answered the skills list yet, though every other read has: the card says it is loading, with no count,
    // rather than that the workspace has no skills.
    await expect.poll(()=>fixture.control.heldSkills.length).toBeGreaterThan(0);
    await expect(refresh).toHaveText("Refresh");
    await expect(pending).toBeVisible();await expect(pending).toHaveAttribute("aria-busy","true");
    await expect(claim).toHaveCount(0);await expect(badge).toHaveCount(0);await expect(failure).toHaveCount(0);
    await skills.scrollIntoViewIfNeeded();
    await shoot("tools-skills-pending");

    // The list fails: the card names what failed and why, and still does not claim there are no skills.
    fixture.control.skills="fail";fixture.releaseSkills();
    await expect(failure).toHaveText("Could not load skills: Deliberate skills list failure");
    await expect(pending).toHaveCount(0);await expect(claim).toHaveCount(0);await expect(badge).toHaveCount(0);
    await shoot("tools-skills-load-failed");
    expect(await claimsSeen()).toEqual([]);

    // Refresh reads the list again. While that read is held the failure gives way to the loading line; the empty answer is then
    // claimed, with a count of 0.
    fixture.control.skills="empty";fixture.control.holdSkills=true;
    const reads=fixture.control.skillReads;
    await refresh.click();
    await expect.poll(()=>fixture.control.skillReads).toBeGreaterThan(reads);
    await expect(pending).toBeVisible();
    await expect(failure).toHaveCount(0);await expect(claim).toHaveCount(0);await expect(badge).toHaveCount(0);
    fixture.releaseSkills();
    await expect(claim).toBeVisible();await expect(badge).toHaveText("0");await expect(pending).toHaveCount(0);
    await skills.scrollIntoViewIfNeeded();
    await shoot("tools-skills-loaded-empty");

    // A list with a skill shows it and its count. A refresh that then fails keeps that list on screen and says the refresh failed.
    fixture.control.skills="listed";await refresh.click();
    await expect(rows).toContainText("Release notes");
    await expect(badge).toHaveText("1");await expect(claim).toHaveCount(0);
    fixture.control.skills="fail";await refresh.click();
    await expect(failure).toHaveText("Could not refresh skills: Deliberate skills list failure");
    await expect(rows).toContainText("Release notes");await expect(badge).toHaveText("1");await expect(claim).toHaveCount(0);
    await skills.scrollIntoViewIfNeeded();
    await shoot("tools-skills-refresh-failed");
  }finally{fixture.releaseSkills();await fixture.close()}
});

test("Tools Skills card says no workspace is open, rather than loading or claiming none, when there is none to list skills for",async({page})=>{
  test.setTimeout(30_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl,{cwd:""});
    const skills=page.locator(".capabilities-page .capability-card").filter({has:page.getByText("Skills",{exact:true})}).first();
    await expect(skills.getByText("Open a workspace to list its skills.",{exact:true})).toBeVisible();
    await expect(skills.getByText("Loading skills…",{exact:true})).toHaveCount(0);
    await expect(skills.getByText("No skills were discovered for this workspace.",{exact:true})).toHaveCount(0);
    await expect(skills.locator(".capability-card-head em")).toHaveCount(0);
    expect(fixture.control.skillReads).toBe(0);
  }finally{await fixture.close()}
});

// Opening a thread that lives in another workspace makes the app read that workspace's skills. While that read is out, and after
// it fails, the Skills card shows the new workspace's state alone: the list read for the workspace left behind is not shown (or
// counted) as this one's, and the failure is the load's, not a refresh's.
test("Tools Skills card drops the previous workspace's skills while the next workspace's list loads or fails",async({page})=>{
  test.setTimeout(45_000);
  const workspaceA=process.cwd(),workspaceB=process.cwd()+(process.platform==="win32"?"\\":"/")+"ui";
  const thread={id:"workspace-b-thread",name:"Work in workspace B",preview:"B",cwd:workspaceB,model:"test/coding-fast",status:{type:"idle"},createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const projects=[{id:"workspace-a",name:"Workspace A",path:workspaceA,environmentId:null},{id:"workspace-b",name:"Workspace B",path:workspaceB,environmentId:null}];
  const fixture=await startHeldMcpFixture({threads:[thread]});fixture.release();
  fixture.control.skillsByCwd={[workspaceA]:"listed",[workspaceB]:"fail"};
  const shoot=async name=>{
    await page.screenshot({animations:"disabled",path:auditDir+name+"-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+name+"-light-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
  };
  try{
    await page.setViewportSize({width:1280,height:800});
    await page.route(/\/api\/thread-meta(?:\?|$)/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projectless:false,environmentId:null})}));
    await page.route(/\/api\/git\/info\?/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:false})}));
    await openTools(page,fixture.wsUrl,{cwd:workspaceA,projects,activeProjectId:"workspace-a",threadMeta:{[thread.id]:{projectless:false,environmentId:null}}});
    const skills=page.locator(".capabilities-page .capability-card").filter({has:page.getByText("Skills",{exact:true})}).first();
    const rows=skills.locator(".skill-list>div"),badge=skills.locator(".capability-card-head em"),failure=skills.locator(".capability-error");
    const pending=skills.getByText("Loading skills…",{exact:true}),claim=skills.getByText("No skills were discovered for this workspace.",{exact:true});
    await expect(rows).toHaveText([/Release notes/]);await expect(badge).toHaveText("1");
    // The thread in workspace B opens; its skills list is held.
    fixture.control.holdSkills=true;
    await page.locator(".thread-row .thread-main").filter({hasText:thread.name}).click();
    await expect.poll(()=>fixture.control.skillCwds.includes(workspaceB)).toBe(true);
    await page.getByRole("button",{name:"Tools",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Harness capabilities",level:2})).toBeVisible({timeout:10_000});
    await skills.scrollIntoViewIfNeeded();
    await expect(pending).toBeVisible();
    await expect(rows).toHaveCount(0);await expect(badge).toHaveCount(0);await expect(failure).toHaveCount(0);await expect(claim).toHaveCount(0);
    await shoot("tools-skills-next-workspace-pending");
    // Workspace B's list fails: the card says its skills could not load, beside no list.
    fixture.releaseSkills();
    await expect(failure).toHaveText("Could not load skills: Deliberate skills list failure");
    await expect(rows).toHaveCount(0);await expect(badge).toHaveCount(0);await expect(pending).toHaveCount(0);await expect(claim).toHaveCount(0);
    await shoot("tools-skills-next-workspace-failed");
    // Refresh reads workspace B again; its empty answer is claimed as B's.
    fixture.control.skillsByCwd[workspaceB]="empty";
    await page.locator(".capabilities-toolbar button").click();
    await expect(claim).toBeVisible();await expect(badge).toHaveText("0");await expect(failure).toHaveCount(0);await expect(rows).toHaveCount(0);
    expect(fixture.control.skillCwds.at(-1)).toBe(workspaceB);
  }finally{fixture.releaseSkills();await fixture.close()}
});

// A plugin shared with the account, as Codex lists it, with no local copy yet.
const share=(id,name,version)=>({plugin:{id,name,...(version?{version}:{}),remotePluginId:"remote-"+id,shareContext:{remotePluginId:"remote-"+id,discoverability:"PRIVATE",shareUrl:"https://plugins.example.invalid/share/"+id,creatorName:"Lane G"}},localPluginPath:null});
// The mouse wheel over the page, notch by notch, as a person scrolls a card up to read it, until its head is near the window's top.
async function wheelTo(page,card){
  const scroller=page.locator(".secondary-page");
  await page.mouse.move(760,420);
  for(let notch=0;notch<40;notch++){
    const {y}=await card.boundingBox();if(y>=60&&y<=200)return;
    const before=await scroller.evaluate(node=>node.scrollTop);
    await page.mouse.wheel(0,Math.max(-400,Math.min(400,y-120)));
    await expect.poll(()=>scroller.evaluate(node=>node.scrollTop)).not.toBe(before);
  }
  throw new Error("The card did not come up to the window's top");
}

// A shared plugin's name reads in full in its row. Beside the share's four actions it ended in an ellipsis with nothing to hover:
// "lane-g-shared-plugin-wi…", and even a short name sharing its row with a version, "lane-g-sh…".
test("Tools Shared plugins shows each plugin's whole name beside its actions, in dark and light, wide and narrow",async({page})=>{
  test.setTimeout(45_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.shared=[share("long","lane-g-shared-plugin-with-a-longer-name"),share("short","lane-g-shared","2.0.0")];
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    const card=page.locator(".capabilities-page .capability-card").filter({has:page.getByText("Shared plugins",{exact:true})}).first();
    const rows=card.locator(".shared-plugin-list>div"),names=rows.locator("strong");
    await expect(names).toHaveText(["lane-g-shared-plugin-with-a-longer-name","lane-g-shared"]);
    await expect(rows.first().getByRole("button",{name:"Delete share",exact:true})).toBeVisible();
    for(const width of [1280,900])for(const mode of ["dark","light"]){
      await page.setViewportSize({width,height:800});await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      await card.scrollIntoViewIfNeeded();
      // All of each name shows: nothing of it is clipped, and the short one is not broken over two lines. The actions stay in the row.
      const shown=await names.evaluateAll(nodes=>nodes.map(node=>{const range=document.createRange();range.selectNodeContents(node);return {whole:node.scrollWidth<=node.clientWidth&&node.scrollHeight<=node.clientHeight,lines:range.getClientRects().length}}));
      expect(shown.map(name=>name.whole),`each name shows whole at ${width} px in ${mode}`).toEqual([true,true]);
      expect(shown[1].lines,"the short name stays on one line").toBe(1);
      expect(await rows.evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth))).toBe(true);
      await page.screenshot({animations:"disabled",path:auditDir+`tools-shared-plugin-names-${mode}-${width}x800.png`,fullPage:false});
    }
  }finally{await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// A share action Codex is slow to answer says what it is doing on the row it was pressed on, and is marked busy, while the page's
// other actions wait. On 01143dbe a checkout held 30 s greyed 25 of the page's 29 buttons, with nothing naming what ran; and a
// visibility changed meanwhile showed the old one again, greyed with the rest, as if the change was refused.
test("Tools Shared plugins says Checking out…, Deleting… or saving… on the row whose action Codex has not answered yet, pressed with the mouse or the keys",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.shared=[share("short","lane-g-shared","2.0.0"),share("long","lane-g-shared-plugin-with-a-longer-name"),share("third","lane-g-shared-three","2.0.2")];
  fixture.control.holdShare=true;
  const shoot=async name=>{for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:auditDir+`${name}-${mode}-${page.viewportSize().width}x800.png`,fullPage:false})}};
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const card=page.locator(".capabilities-page .capability-card").filter({has:page.getByText("Shared plugins",{exact:true})}).first();
    const rows=card.locator(".shared-plugin-list>div"),busy=page.locator(".capabilities-page [aria-busy=true]");
    await wheelTo(page,card);
    // Checkout double-clicked: one checkout, and its own row says it runs, the only thing marked busy. The other rows' actions wait;
    // Open stays.
    await rows.nth(0).getByRole("button",{name:"Checkout",exact:true}).dblclick();
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    const checking=rows.nth(0).getByRole("button",{name:"Checking out…",exact:true});
    await expect(checking).toBeDisabled();await expect(checking).toHaveAttribute("aria-busy","true");await expect(busy).toHaveCount(1);
    expect(fixture.control.heldShare.length,"one checkout for the double click").toBe(1);
    await expect(rows.nth(1).getByRole("button",{name:"Checkout",exact:true})).toBeDisabled();
    await expect(rows.nth(1).getByRole("button",{name:"Open",exact:true})).toBeEnabled();
    await shoot("tools-shared-plugin-checking-out");
    // Answered: the row has its local copy, so no Checkout, and nothing is busy.
    fixture.releaseShare();
    await expect(rows.nth(0).getByRole("button")).toHaveText(["Open","Delete share"]);
    await expect(busy).toHaveCount(0);
    // With the keys, in a narrower window: Tab from Open to the long name's Checkout and Enter. Its label shows whole in the row.
    await page.setViewportSize({width:900,height:800});await wheelTo(page,card);
    await rows.nth(1).getByRole("button",{name:"Open",exact:true}).focus();await page.keyboard.press("Tab");
    await expect(rows.nth(1).getByRole("button",{name:"Checkout",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    const checkingLong=rows.nth(1).getByRole("button",{name:"Checking out…",exact:true});
    await expect(checkingLong).toHaveAttribute("aria-busy","true");await expect(busy).toHaveCount(1);
    expect(await checkingLong.evaluate(node=>node.scrollWidth<=node.clientWidth),"the label shows whole").toBe(true);
    expect(await rows.evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth)),"the rows stay in the card").toBe(true);
    fixture.releaseShare();
    await expect(rows.nth(1).getByRole("button")).toHaveText(["Open","Delete share"]);
    // Who can find the share, changed while Codex answers: the row keeps the choice, marked busy, and says it is saving, in the
    // narrow window too; once answered the choice stays.
    const visibility=rows.nth(1).getByRole("combobox"),saving=rows.nth(1).getByText("saving…",{exact:true});
    await visibility.selectOption("UNLISTED");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await expect(visibility,"the row keeps the visibility chosen while Codex answers").toHaveValue("UNLISTED");
    await expect(visibility).toBeDisabled();await expect(visibility).toHaveAttribute("aria-busy","true");await expect(busy).toHaveCount(1);
    await expect(saving).toBeVisible();
    expect(await rows.evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth)),"the rows stay in the card").toBe(true);
    await shoot("tools-shared-plugin-saving-visibility");
    fixture.releaseShare();
    await expect(saving).toHaveCount(0);await expect(busy).toHaveCount(0);
    await expect(visibility).toHaveValue("UNLISTED");await expect(visibility).toBeEnabled();
    // Delete share, once the question is answered, says it is deleting on its row until Codex answers; then the row leaves.
    await page.setViewportSize({width:1280,height:800});await wheelTo(page,card);
    await rows.nth(2).getByRole("button",{name:"Delete share",exact:true}).click();
    await page.locator("dialog.inspector-text-prompt").getByRole("button",{name:"Delete share",exact:true}).click();
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    const deleting=rows.nth(2).getByRole("button",{name:"Deleting…",exact:true});
    await expect(deleting).toBeDisabled();await expect(deleting).toHaveAttribute("aria-busy","true");await expect(busy).toHaveCount(1);
    await shoot("tools-shared-plugin-deleting");
    fixture.releaseShare();
    await expect(rows).toHaveCount(2);await expect(busy).toHaveCount(0);
  }finally{fixture.releaseShare();await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// Presses a share action Codex holds, then drops the Codex connection with the next handshake held, so the page says it is not
// connected until Codex is let back (with Codex answering at once it said so for about half a second, which a look could fall
// between); meanwhile Codex finishes the action, its answer lost with the connection, or never does. Resolves once the page has
// read Codex again. With shot, the page while Codex is away is shot in dark and light.
async function cutOffShareAction(page,fixture,press,{finished,shot=""}){
  await press();await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
  fixture.control.holdInit=true;fixture.drop();
  await expect(page.getByText("Codex harness is not connected",{exact:true})).toBeVisible();
  if(shot)for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:auditDir+`${shot}-${mode}-1280x800.png`,fullPage:false})}
  if(shot)await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
  if(finished)fixture.releaseShare();else fixture.control.heldShare.splice(0);
  fixture.releaseInit();
  await expect(page.getByRole("heading",{name:"Harness capabilities",level:2})).toBeVisible({timeout:15_000});
  await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh",{timeout:15_000});
}

// A checkout cut off by a dropped Codex connection. While Codex is away the page says it is not connected; once Codex is back, the
// card says the checkout did not go through, in the app's words for the lost connection, and the page is as the person left it:
// where they had scrolled to, with what they had opened still open. On 01143dbe the refresh run as Codex came back wiped that reason
// before it ever showed, and the page came back at its top; then, given back where it was scrolled to but drawn again, it came back
// with what the person had opened (Effective config) closed, shorter above the card, which so stood higher. Checkout tried again
// says it runs with that line gone: the line saying the last try failed stayed beside Checking out….
test("Tools says a checkout cut off by a dropped Codex connection did not finish, and is back as the person left it once Codex reconnects",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.shared=[share("short","lane-g-shared","2.0.0"),share("long","lane-g-shared-plugin-with-a-longer-name"),share("third","lane-g-shared-three","2.0.2")];
  // A configuration long enough to fill Effective config's 260 px once it is open.
  fixture.control.config=Object.fromEntries(Array.from({length:30},(_,index)=>["setting_"+index,"value "+index]));
  fixture.control.holdShare=true;
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    const refresh=page.locator(".capabilities-toolbar button");
    await expect(refresh).toHaveText("Refresh");
    const card=page.locator(".capabilities-page .capability-card").filter({has:page.getByText("Shared plugins",{exact:true})}).first();
    const rows=card.locator(".shared-plugin-list>div"),reason=card.locator(".capability-error");
    const config=page.locator(".capabilities-page details.capability-details").filter({has:page.locator("summary",{hasText:"Effective config"})});
    await config.locator("summary").click();await expect(config).toHaveJSProperty("open",true);
    await wheelTo(page,card);
    const place=(await card.boundingBox()).y;
    await cutOffShareAction(page,fixture,()=>rows.nth(1).getByRole("button",{name:"Checkout",exact:true}).click(),{finished:false,shot:"tools-not-connected-while-dropped"});
    expect.soft(Math.abs((await card.boundingBox()).y-place),"the Shared plugins card is where the person had it").toBeLessThanOrEqual(4);
    await expect.soft(config,"Effective config, opened before Codex went, is still open").toHaveJSProperty("open",true);
    await expect(reason).toHaveText("Could not check out lane-g-shared-plugin-with-a-longer-name: Codex disconnected");
    await expect(reason).toBeInViewport({ratio:1});
    // The checkout did not finish: its row offers Checkout again.
    await expect(rows.nth(1).getByRole("button",{name:"Checkout",exact:true})).toBeEnabled();
    for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:auditDir+`tools-shared-plugin-checkout-dropped-${mode}-1280x800.png`,fullPage:false})}
    // Checkout tried again says it runs on the row, and the line saying the last try failed goes as it starts; once the checkout
    // goes through the row has its local copy.
    await rows.nth(1).getByRole("button",{name:"Checkout",exact:true}).click();
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await expect(rows.nth(1).getByRole("button",{name:"Checking out…",exact:true})).toHaveAttribute("aria-busy","true");
    await expect.soft(reason,"the line saying the last checkout failed goes as Checkout is tried again").toHaveCount(0);
    for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:auditDir+`tools-shared-plugin-checkout-retried-${mode}-1280x800.png`,fullPage:false})}
    fixture.releaseShare();
    await expect(rows.nth(1).getByRole("button")).toHaveText(["Open","Delete share"]);
    await expect(reason).toHaveCount(0);
  }finally{await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// A share action the dropped connection cut off that Codex finished all the same: the answer went with the connection, but the list
// read as Codex is back shows it done, and the card says nothing failed. The line saying it could not be done stayed beside the list
// that showed it done (the plugin checked out, the visibility set, the share gone). One Codex did not finish keeps its line until
// the action is tried again, which clears it as it starts, as a checkout does.
test("Tools drops the line of a share action a dropped Codex connection cut off once the list read again shows it done",async({page})=>{
  test.setTimeout(90_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.shared=[share("short","lane-g-shared","2.0.0"),share("long","lane-g-shared-plugin-with-a-longer-name"),share("third","lane-g-shared-three","2.0.2")];
  fixture.control.holdShare=true;
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const card=page.locator(".capabilities-page .capability-card").filter({has:page.getByText("Shared plugins",{exact:true})}).first();
    const rows=card.locator(".shared-plugin-list>div"),reason=card.locator(".capability-error");
    const checkoutLine=reason.filter({hasText:/^Could not check out /}),visibilityLine=reason.filter({hasText:/^Could not change who can find /}),deleteLine=reason.filter({hasText:/^Could not delete the share of /});
    await wheelTo(page,card);
    // A checkout Codex finished: the row has its local copy, and nothing says it could not be checked out.
    await cutOffShareAction(page,fixture,()=>rows.nth(0).getByRole("button",{name:"Checkout",exact:true}).click(),{finished:true});
    await expect(rows.nth(0).getByRole("button")).toHaveText(["Open","Delete share"]);
    await expect.soft(checkoutLine,"no line says the finished checkout could not be done").toHaveCount(0);
    // A visibility change Codex finished: the row shows it, and nothing says it could not be changed.
    await cutOffShareAction(page,fixture,()=>rows.nth(1).getByRole("combobox").selectOption("LISTED"),{finished:true});
    await expect(rows.nth(1).getByRole("combobox")).toHaveValue("LISTED");
    await expect.soft(visibilityLine,"no line says the finished visibility change could not be done").toHaveCount(0);
    // A delete Codex did not finish keeps its line, and the share its row; Delete share tried again clears the line as it starts,
    // and that delete, finished as Codex went again, takes the row away with no line.
    const deleteShare=async()=>{await rows.nth(2).getByRole("button",{name:"Delete share",exact:true}).click();await page.locator("dialog.inspector-text-prompt").getByRole("button",{name:"Delete share",exact:true}).click()};
    await cutOffShareAction(page,fixture,deleteShare,{finished:false});
    await expect(deleteLine).toHaveText("Could not delete the share of lane-g-shared-three: Codex disconnected");
    await expect(rows).toHaveCount(3);
    await cutOffShareAction(page,fixture,async()=>{
      await deleteShare();
      await expect(rows.nth(2).getByRole("button",{name:"Deleting…",exact:true})).toHaveAttribute("aria-busy","true");
      await expect.soft(deleteLine,"the line saying the last delete failed goes as Delete share is tried again").toHaveCount(0);
    },{finished:true});
    await expect(rows).toHaveCount(2);
    await expect.soft(deleteLine,"no line says the finished delete could not be done").toHaveCount(0);
    for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:auditDir+`tools-shared-plugin-finished-while-dropped-${mode}-1280x800.png`,fullPage:false})}
    await expect(reason).toHaveCount(0);
  }finally{await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});
