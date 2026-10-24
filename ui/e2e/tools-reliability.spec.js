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
// they wait, until `releaseShare()`, or until `refuseShare(reason)` refuses them with reason. One answered after its connection
// closed is done all the same, as Codex finishes what it was asked, but its answer is lost. The plugin catalog is
// `control.marketplaces`: a plugin shared, installed or uninstalled and a marketplace upgraded or removed change it once answered,
// and wait while `holdShare` is set as well; a plugin search lists the catalog's plugins whose name has the term in it, and a
// plugin's read describes it, both waiting while `holdReads` is set, until `releaseReads()`. The
// effective configuration is `control.config`. `control.listReads` counts the catalog's reads. The Windows sandbox's readiness is
// `control.sandbox`, and a setup started answers that it started (`control.setups` lists them); the agent configuration found is
// `control.migrationItems`, and an import of it answers with its id (`control.imports` lists them; Codex's import history, the imports
// done, is `control.histories`). `notify(method,params)` sends a
// notification on the app's connections, as Codex says a setup or an import is done. `drop()` closes the app's connections while
// the fixture keeps listening, so the app connects again.
async function startHeldMcpFixture({threads=[]}={}){
  const control={mcp:"servers",lists:"full",hold:true,held:[],holdInit:false,heldInit:[],skills:"empty",skillsByCwd:{},holdSkills:false,heldSkills:[],skillReads:0,skillCwds:[],shared:[],holdShare:false,heldShare:[],holdReads:false,heldReads:[],marketplaces:[],config:{},listReads:0,sandbox:"ready",setups:[],migrationItems:[],imports:[],histories:[]};
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
        const answer=reason=>{
          if(reason){if(ws.readyState===ws.OPEN)send({error:{code:-32000,message:reason}});return}
          if(message.method==="plugin/share/delete")control.shared=control.shared.filter(item=>!mine(item));
          else control.shared=control.shared.map(item=>!mine(item)?item:checkout?{...item,localPluginPath:copy}:{...item,plugin:{...item.plugin,shareContext:{...item.plugin.shareContext,discoverability}}});
          if(ws.readyState===ws.OPEN)send({result:checkout?{localPluginPath:copy}:{}});
        };
        if(control.holdShare)control.heldShare.push(answer);else answer();
        return;
      }
      if(["plugin/share/save","plugin/install","plugin/uninstall","marketplace/upgrade","marketplace/remove"].includes(message.method)){
        const {method,params={}}=message;
        const changed=plugin=>method==="plugin/share/save"&&plugin.source?.path===params.pluginPath?{...plugin,remotePluginId:"remote-"+plugin.id,shareContext:{remotePluginId:"remote-"+plugin.id,discoverability:params.discoverability,sharePrincipals:[]}}
          :method==="plugin/install"&&plugin.name===params.pluginName?{...plugin,installed:true}:method==="plugin/uninstall"&&plugin.id===params.pluginId?{...plugin,installed:false}:plugin;
        const answer=reason=>{
          if(reason){if(ws.readyState===ws.OPEN)send({error:{code:-32000,message:reason}});return}
          control.marketplaces=method==="marketplace/remove"?control.marketplaces.filter(item=>item.name!==params.marketplaceName):control.marketplaces.map(item=>({...item,plugins:(item.plugins||[]).map(changed)}));
          if(ws.readyState===ws.OPEN)send({result:{}});
        };
        if(control.holdShare)control.heldShare.push(answer);else answer();
        return;
      }
      if(["plugin/search","plugin/read"].includes(message.method)){
        const {searchTerm,pluginName}=message.params||{},listed=control.marketplaces.flatMap(market=>(market.plugins||[]).map(plugin=>({market,plugin}))),read=listed.find(({plugin})=>plugin.name===pluginName);
        const answer=()=>send({result:message.method==="plugin/search"?{data:listed.filter(({plugin})=>plugin.name.includes(searchTerm)).map(({market,plugin})=>({marketplaceName:market.name,marketplacePath:market.path,plugin})),nextCursor:null}
          :{plugin:read?{summary:read.plugin,marketplaceName:read.market.name,description:"What "+(read.plugin.interface?.displayName||read.plugin.name)+" does, as Codex describes it.",skills:[],hooks:[],apps:[],mcpServers:[],scheduledTasks:[]}:null}});
        if(control.holdReads)control.heldReads.push(answer);else answer();
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
      else if(message.method==="plugin/list"){control.listReads++;result={marketplaces:control.marketplaces}}
      else if(message.method==="app/installed")result={apps:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      else if(message.method==="account/read")result={account:{type:"chatgpt",email:"fixture@example.com",planType:"plus"},requiresOpenaiAuth:false};
      else if(message.method==="account/rateLimits/read")result={rateLimits:{}};
      else if(message.method==="account/usage/read")result={summary:{}};
      else if(message.method==="config/read")result={config:control.config,layers:[]};
      else if(message.method==="configRequirements/read")result={requirements:null};
      else if(message.method==="memory/status")result={v2ConsolidatedThreads:3,v2Ready:false};
      else if(message.method==="server/diagnostics")result={process:{id:321,residentMemoryBytes:4096},gauges:[]};
      else if(message.method==="externalAgentConfig/import/readHistories")result={data:control.histories,connectors:[]};
      else if(message.method==="externalAgentConfig/detect")result={items:control.migrationItems,connectors:[]};
      else if(message.method==="externalAgentConfig/import"){control.imports.push(message.params);result={importId:"import-"+control.imports.length}}
      else if(message.method==="windowsSandbox/readiness")result={status:control.sandbox};
      else if(message.method==="windowsSandbox/setupStart"){control.setups.push(message.params);result={started:true}}
      send({result});
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {control,wsUrl:`ws://127.0.0.1:${port}`,
    release(){control.hold=false;for(const answer of control.held.splice(0))answer()},
    releaseInit(){control.holdInit=false;for(const answer of control.heldInit.splice(0))answer()},
    releaseSkills(){control.holdSkills=false;for(const answer of control.heldSkills.splice(0))answer()},
    releaseShare(){for(const answer of control.heldShare.splice(0))answer()},
    refuseShare(reason){for(const answer of control.heldShare.splice(0))answer(reason)},
    releaseReads(){for(const answer of control.heldReads.splice(0))answer()},
    notify(method,params){for(const socket of sockets)if(socket.readyState===socket.OPEN)socket.send(JSON.stringify({method,params}))},
    drop(){for(const socket of sockets)try{socket.terminate()}catch{}},
    async close(){for(const socket of sockets)try{socket.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}
// projects are the saved projects (activeProjectId the open one); opening one answers with it, as the server does. platform is the
// host's the app is told of (the Windows sandbox card shows on win32).
async function openTools(page,wsUrl,{connected=true,cwd=process.cwd(),projects=[],activeProjectId=null,threadMeta={},platform=process.platform}={}){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl,cwd,platform,version:"tools-held-list-fixture",activeEnvironmentId:null,activeEnvironment:null}));
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
// The mouse wheel over the page, notch by notch, as a person scrolls a card up to read it, until its head is near the window's top,
// or, for a card at the page's foot, until the page ends with it in view.
async function wheelTo(page,card){
  const scroller=page.locator(".secondary-page");
  await page.mouse.move(760,420);
  for(let notch=0;notch<40;notch++){
    const {y}=await card.boundingBox();if(y>=60&&y<=200)return;
    if(y>200&&await scroller.evaluate(node=>node.scrollTop+node.clientHeight>=node.scrollHeight-1))return;
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

// A marketplace on disk with one local plugin, as Codex lists it, neither installed nor shared yet.
const catalog=()=>[{name:"lane-g-market",path:"/home/test/lane-g/market",interface:{displayName:"Lane G Market"},plugins:[{id:"lane-g-local@lane-g-market",name:"lane-g-local",version:"1.2.0",installed:false,availability:"available",interface:{displayName:"Lane G Local"},source:{type:"local",path:"/home/test/lane-g/plugins/local"}}]}];
const toolsCard=(page,title)=>page.locator(".capabilities-page .capability-card").filter({has:page.locator(".capability-card-head strong",{hasText:new RegExp("^"+title+"$")})}).first();

// A Plugins or Marketplaces action Codex is slow to answer says what it is doing on the button it was pressed on, marked busy, while
// the page's other actions wait, as the Shared plugins rows do. On cd97bb9f Share privately, Update share, Install and a
// marketplace's Upgrade each kept their label while Codex held the answer, with nothing marked busy, as 19 of the page's 20 buttons
// greyed out.
test("Tools Plugins and Marketplaces say Sharing…, Installing… or Upgrading… on the button whose action Codex has not answered yet, pressed with the mouse or the keys",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.marketplaces=catalog();fixture.control.holdShare=true;
  const shoot=async name=>{for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:auditDir+`${name}-${mode}-${page.viewportSize().width}x800.png`,fullPage:false})}};
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const plugins=toolsCard(page,"Plugins"),marketplaces=toolsCard(page,"Marketplaces"),busy=page.locator(".capabilities-page [aria-busy=true]");
    const row=plugins.locator(".capability-list>div").filter({hasText:"Lane G Local"}),market=marketplaces.locator(".capability-list>div").filter({hasText:"Lane G Market"});
    await wheelTo(page,plugins);
    // Share privately clicked: its button says Sharing…, marked busy, the only thing busy; the row's other actions wait.
    await row.getByRole("button",{name:"Share privately",exact:true}).click();
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    const sharing=row.getByRole("button",{name:"Sharing…",exact:true});
    await expect(sharing,"Share privately says it is sharing while Codex answers").toHaveAttribute("aria-busy","true");
    await expect(sharing).toBeDisabled();await expect(busy).toHaveCount(1);
    await expect(row.getByRole("button",{name:"Install",exact:true})).toBeDisabled();
    await shoot("tools-plugin-sharing");
    // Answered: the plugin is shared, so the row offers Update share, and nothing is busy.
    fixture.releaseShare();
    await expect(row.getByRole("button")).toHaveText(["Details","Update share","Install"]);await expect(busy).toHaveCount(0);
    // Update share double-clicked: one save, and the button says Updating… until Codex answers.
    await row.getByRole("button",{name:"Update share",exact:true}).dblclick();
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await expect(row.getByRole("button",{name:"Updating…",exact:true})).toHaveAttribute("aria-busy","true");await expect(busy).toHaveCount(1);
    expect(fixture.control.heldShare.length,"one save for the double click").toBe(1);
    fixture.releaseShare();
    await expect(row.getByRole("button",{name:"Update share",exact:true})).toBeEnabled();await expect(busy).toHaveCount(0);
    // With the keys: Tab from Update share to Install and Enter. Install says Installing… with the keyboard on it, and the keyboard
    // is still there once Codex answers, on Uninstall.
    await row.getByRole("button",{name:"Update share",exact:true}).focus();await page.keyboard.press("Tab");
    await expect(row.getByRole("button",{name:"Install",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    const installing=row.getByRole("button",{name:"Installing…",exact:true});
    await expect(installing).toHaveAttribute("aria-busy","true");await expect(installing).toBeFocused();
    fixture.releaseShare();
    await expect(row.getByRole("button",{name:"Uninstall",exact:true})).toBeFocused();await expect(busy).toHaveCount(0);
    // A marketplace's Upgrade, in a narrower window: Upgrading… on its own row, which stays in the card, while Upgrade all waits.
    await page.setViewportSize({width:900,height:800});await wheelTo(page,marketplaces);
    await market.getByRole("button",{name:"Upgrade",exact:true}).click();
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    const upgrading=market.getByRole("button",{name:"Upgrading…",exact:true});
    await expect(upgrading).toHaveAttribute("aria-busy","true");await expect(busy).toHaveCount(1);
    await expect(marketplaces.getByRole("button",{name:"Upgrade all",exact:true})).toBeDisabled();
    expect(await market.evaluate(node=>node.scrollWidth<=node.clientWidth),"the row stays in the card").toBe(true);
    await shoot("tools-marketplace-upgrading");
    fixture.releaseShare();
    await expect(market.getByRole("button",{name:"Upgrade",exact:true})).toBeEnabled();await expect(busy).toHaveCount(0);
    // Remove says Removing… on its row until Codex answers; then the row leaves.
    await market.getByRole("button",{name:"Remove",exact:true}).click();
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await expect(market.getByRole("button",{name:"Removing…",exact:true})).toHaveAttribute("aria-busy","true");await expect(busy).toHaveCount(1);
    fixture.releaseShare();
    await expect(market).toHaveCount(0);await expect(busy).toHaveCount(0);
  }finally{fixture.releaseShare();await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// A person points at the Tools action Codex is answering, pressed with the mouse or the keys, and at the actions that wait meanwhile:
// each shows the default arrow, as a disabled button does on every page and Settings' Capturing… does, while the actions that work
// show the hand. On 86c4fdb8 Sharing…, Install and Checkout kept the hand at half opacity: the rule for the Tools buttons outweighed
// the one for busy and disabled buttons.
test("Tools shows the default arrow, not the hand, over the action Codex is answering and the actions that wait meanwhile",async({page})=>{
  test.setTimeout(45_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.marketplaces=catalog();fixture.control.shared=[share("short","lane-g-shared","2.0.0")];fixture.control.holdShare=true;
  // The mouse on a button, as a person points at it: the pointer shown there and how faded the button is.
  const pointed=async button=>{const box=await button.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);return button.evaluate(node=>getComputedStyle(node).cursor+" "+getComputedStyle(node).opacity)};
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const plugins=toolsCard(page,"Plugins"),shared=toolsCard(page,"Shared plugins");
    const row=plugins.locator(".capability-list>div").filter({hasText:"Lane G Local"}),sharedRow=shared.locator(".shared-plugin-list>div").first();
    const install=row.getByRole("button",{name:"Install",exact:true}),checkout=sharedRow.getByRole("button",{name:"Checkout",exact:true});
    await wheelTo(page,plugins);
    expect(await pointed(install),"Install, which works").toBe("pointer 1");
    // Share privately clicked: it says Sharing… while Codex answers, and Install waits; down in Shared plugins Checkout waits too, and
    // Open works.
    await row.getByRole("button",{name:"Share privately",exact:true}).click();
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    const sharing=row.getByRole("button",{name:"Sharing…",exact:true});
    await expect(sharing).toHaveAttribute("aria-busy","true");await expect(install).toBeDisabled();
    expect([await pointed(sharing),await pointed(install)],"Sharing… and Install while Codex shares").toEqual(["default 0.5","default 0.5"]);
    await wheelTo(page,shared);
    await expect(checkout).toBeDisabled();
    expect([await pointed(checkout),await pointed(sharedRow.getByRole("button",{name:"Open",exact:true}))],"Checkout and Open while Codex shares").toEqual(["default 0.5","pointer 1"]);
    fixture.releaseShare();
    await expect(checkout).toBeEnabled();expect(await pointed(checkout),"Checkout once Codex has shared").toBe("pointer 1");
    // With the keys: Tab from Update share to Install and Enter. Installing… under the mouse shows the arrow too, in dark and light.
    await wheelTo(page,plugins);
    await row.getByRole("button",{name:"Update share",exact:true}).focus();await page.keyboard.press("Tab");
    await expect(install).toBeFocused();await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    const installing=row.getByRole("button",{name:"Installing…",exact:true});
    await expect(installing).toHaveAttribute("aria-busy","true");await expect(installing).toBeFocused();
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      expect(await pointed(installing),`Installing…, pressed with the keys (${mode})`).toBe("default 0.5");
      await page.screenshot({animations:"disabled",path:auditDir+`tools-plugin-installing-arrow-${mode}-1280x800.png`,fullPage:false});
    }
    fixture.releaseShare();
    const uninstall=row.getByRole("button",{name:"Uninstall",exact:true});
    await expect(uninstall).toBeFocused();expect(await pointed(uninstall),"Uninstall, which works").toBe("pointer 1");
  }finally{fixture.releaseShare();await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// The wheel over the page's right edge, clear of the lists that scroll by themselves, a notch at a time, as a person scrolls the page
// on down while Codex answers, until control is out of sight above.
async function wheelPast(page,control){
  const scroller=page.locator(".secondary-page");
  await page.mouse.move(page.viewportSize().width-6,420);
  for(let notch=0;notch<30;notch++){
    const box=await control.boundingBox(),view=await scroller.boundingBox();if(box.y+box.height<view.y)return;
    const before=await scroller.evaluate(node=>node.scrollTop);
    await page.mouse.wheel(0,120);
    await expect.poll(()=>scroller.evaluate(node=>node.scrollTop)).not.toBe(before);
  }
  throw new Error("The page did not scroll the control out of sight");
}

// A person on the keyboard: the Shared plugins control they pressed keeps the keyboard while Codex answers, and once the action takes
// the control away (Checkout once checked out, the row of a deleted share) the keyboard is on the control in its place in its row, or
// on the first control of the row after it, with the page left where the person scrolled it. On cd97bb9f each control was disabled
// under the keyboard as its action started, which dropped the focus on the page: a second ArrowDown on the visibility select scrolled
// the page instead, and the focus was still on the page once the change was saved, as it was during a checkout and after a delete.
// On fbdd1659 the keyboard handed on scrolled the page back up to the list from where the person had scrolled it meanwhile, and the
// focus was handed on after a Checkout clicked with the mouse too, or one the person had clicked away from: the select took it, with
// its focus ring.
test("Tools Shared plugins keeps the keyboard on the control pressed while Codex answers it, and in the list once the action takes the control away",async({page})=>{
  test.setTimeout(90_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.shared=[share("short","lane-g-shared","2.0.0"),share("long","lane-g-shared-plugin-with-a-longer-name"),share("third","lane-g-shared-three","2.0.2"),share("fourth","lane-g-shared-four","2.0.4")];
  fixture.control.holdShare=true;
  const shoot=async name=>{for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:auditDir+`${name}-${mode}-${page.viewportSize().width}x800.png`,fullPage:false})}};
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const card=toolsCard(page,"Shared plugins"),rows=card.locator(".shared-plugin-list>div"),scroller=page.locator(".secondary-page");
    await wheelTo(page,card);
    // The second row's visibility, reached with Tab from its Open and changed with ArrowDown: the keyboard stays on the select while
    // Codex saves Unlisted, so a second ArrowDown meanwhile neither changes it nor scrolls the page, and it is still there once saved.
    const visibility=rows.nth(1).getByRole("combobox");
    await rows.nth(1).getByRole("button",{name:"Open",exact:true}).focus();
    await page.keyboard.press("Tab");await page.keyboard.press("Tab");
    await expect(visibility).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await expect(visibility).toHaveAttribute("aria-busy","true");
    await expect(visibility,"the keyboard stays on the select while Codex saves the change").toBeFocused();
    const top=await scroller.evaluate(node=>node.scrollTop);
    await page.keyboard.press("ArrowDown");
    await expect(visibility).toHaveValue("UNLISTED");await expect(visibility).toBeFocused();
    expect(await scroller.evaluate(node=>node.scrollTop),"the second ArrowDown does not scroll the page").toBe(top);
    expect(fixture.control.heldShare.length,"the second ArrowDown sends no change").toBe(1);
    await shoot("tools-shared-plugin-keyboard-saving");
    fixture.releaseShare();
    await expect(visibility).not.toHaveAttribute("aria-busy","true");await expect(visibility).toHaveValue("UNLISTED");
    await expect(visibility,"the keyboard is on the select once the change is saved").toBeFocused();
    // The first row's Checkout, from its Open with Tab, pressed with Enter: the keyboard stays on Checking out…; once checked out the
    // row has no Checkout, and the keyboard is on the control in its place, the visibility select.
    await rows.nth(0).getByRole("button",{name:"Open",exact:true}).focus();await page.keyboard.press("Tab");
    await expect(rows.nth(0).getByRole("button",{name:"Checkout",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await expect(rows.nth(0).getByRole("button",{name:"Checking out…",exact:true}),"the keyboard stays on Checking out…").toBeFocused();
    fixture.releaseShare();
    await expect(rows.nth(0).getByRole("button")).toHaveText(["Open","Delete share"]);
    await expect(rows.nth(0).getByRole("combobox"),"the keyboard goes on to the control in Checkout's place").toBeFocused();
    // In a narrower window, where the cards stand in one column, the person scrolls the page on down while Codex answers: a card
    // further down stays where they scrolled it as the action ends. onPage: the focus is on the page, on no control.
    await page.setViewportSize({width:900,height:800});
    const later=toolsCard(page,"Conversation history"),stands=async()=>(await later.boundingBox()).y,onPage=()=>page.evaluate(()=>document.activeElement===document.body);
    // The second row's Checkout pressed with Enter, then the page scrolled on until the select beside it is out of sight: once
    // checked out the keyboard is on the select, in Checkout's place, and the page has not moved.
    await wheelTo(page,card);
    await rows.nth(1).getByRole("button",{name:"Open",exact:true}).focus();await page.keyboard.press("Tab");
    await expect(rows.nth(1).getByRole("button",{name:"Checkout",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await wheelPast(page,rows.nth(1).getByRole("combobox"));
    let place=await stands();
    fixture.releaseShare();
    await expect(rows.nth(1).getByRole("button")).toHaveText(["Open","Delete share"]);
    await expect(rows.nth(1).getByRole("combobox"),"the keyboard goes on to the select, out of sight").toBeFocused();
    expect.soft(Math.abs(await stands()-place),"the page stays where the person scrolled it as the keyboard goes on").toBeLessThanOrEqual(4);
    await shoot("tools-shared-plugin-keyboard-scrolled-on");
    // The third row's Checkout clicked with the mouse, then the page scrolled on: once checked out the focus is left on the page,
    // where it fell, and not given to the select (with its focus ring), and the page has not moved.
    await wheelTo(page,card);
    await rows.nth(2).getByRole("button",{name:"Checkout",exact:true}).click();
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await wheelPast(page,rows.nth(2).getByRole("combobox"));
    place=await stands();
    fixture.releaseShare();
    await expect(rows.nth(2).getByRole("button")).toHaveText(["Open","Delete share"]);
    await expect(rows.nth(0).getByRole("button",{name:"Delete share",exact:true}),"the page's other actions are back").toBeEnabled();
    expect.soft(await onPage(),"a Checkout clicked with the mouse hands the focus to no control").toBe(true);
    expect.soft(Math.abs(await stands()-place),"the page stays where the person scrolled it after a click").toBeLessThanOrEqual(4);
    // The fourth row's Checkout pressed with Enter, then a click on the card's text, away from it: once checked out the focus is still
    // on the page, where the person put it.
    await wheelTo(page,card);
    await rows.nth(3).getByRole("button",{name:"Open",exact:true}).focus();await page.keyboard.press("Tab");
    await expect(rows.nth(3).getByRole("button",{name:"Checkout",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await card.locator(":scope>p").click();
    await expect.poll(onPage,{message:"the click on the card's text takes the focus off Checking out…"}).toBe(true);
    fixture.releaseShare();
    await expect(rows.nth(3).getByRole("button")).toHaveText(["Open","Delete share"]);
    await expect(rows.nth(0).getByRole("button",{name:"Delete share",exact:true}),"the page's other actions are back").toBeEnabled();
    expect.soft(await onPage(),"the focus stays on the page, where the person put it").toBe(true);
    // The second row's Delete share pressed with Enter, and the question's Delete share reached with Tab and pressed with Enter: the
    // keyboard is on Deleting… while Codex answers, and once the share is gone, on the first control of the row after it, its Open.
    await wheelTo(page,card);
    await rows.nth(1).getByRole("button",{name:"Delete share",exact:true}).focus();await page.keyboard.press("Enter");
    const question=page.locator("dialog.inspector-text-prompt");
    await expect(question.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
    await page.keyboard.press("Tab");await expect(question.getByRole("button",{name:"Delete share",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await expect(rows.nth(1).getByRole("button",{name:"Deleting…",exact:true}),"the keyboard is on Deleting… while Codex answers").toBeFocused();
    fixture.releaseShare();
    await expect(rows).toHaveCount(3);await expect(rows.nth(1).locator("strong")).toHaveText("lane-g-shared-three");
    await expect(rows.nth(1).getByRole("button",{name:"Open",exact:true}),"the keyboard goes on to the first control of the row after the deleted share").toBeFocused();
    await shoot("tools-shared-plugin-keyboard-after-delete");
  }finally{fixture.releaseShare();await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// Three marketplaces on disk, as Codex lists them: each row has Upgrade and then Remove.
const markets=()=>["Alpha","Beta","Gamma"].map(name=>({name:"lane-g-"+name.toLowerCase(),path:"/home/test/lane-g/"+name.toLowerCase(),interface:{displayName:"Lane G "+name},plugins:[]}));

// A person on the keyboard removes a marketplace: once Remove takes its row away, the keyboard is on the first control of the row
// after it, that marketplace's Upgrade, or of the row before it when the last one goes. On fbdd1659 it went to the control in Remove's
// place there, the next marketplace's Remove, which removes at once, asking nothing: the next Enter removed that marketplace too.
test("Tools Marketplaces hands the keyboard on to the next marketplace's Upgrade once Remove takes a marketplace away, not to its Remove",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.marketplaces=markets();fixture.control.holdShare=true;
  const shoot=async name=>{for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:auditDir+`${name}-${mode}-${page.viewportSize().width}x800.png`,fullPage:false})}};
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const card=toolsCard(page,"Marketplaces"),rows=card.locator(".capability-list>div"),names=rows.locator("strong");
    await expect(names).toHaveText(["Lane G Alpha","Lane G Beta","Lane G Gamma"]);
    await wheelTo(page,card);
    // The first marketplace's Remove, from its Upgrade with Tab, pressed with Enter: the keyboard stays on Removing… while Codex
    // answers, and once the row has gone it is on the next marketplace's Upgrade.
    await rows.nth(0).getByRole("button",{name:"Upgrade",exact:true}).focus();await page.keyboard.press("Tab");
    await expect(rows.nth(0).getByRole("button",{name:"Remove",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await expect(rows.nth(0).getByRole("button",{name:"Removing…",exact:true}),"the keyboard stays on Removing…").toBeFocused();
    fixture.releaseShare();
    await expect(names).toHaveText(["Lane G Beta","Lane G Gamma"]);
    await expect.soft(rows.nth(0).getByRole("button",{name:"Upgrade",exact:true}),"the keyboard goes on to the next marketplace's Upgrade, not to its Remove").toBeFocused();
    await shoot("tools-marketplace-removed-keyboard");
    // Enter again, a press of its own, does what the control it is on does: here it upgrades that marketplace, which stays.
    await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await expect.soft(rows.nth(0).getByRole("button",{name:"Upgrading…",exact:true}),"the next Enter upgrades the next marketplace").toBeFocused();
    fixture.releaseShare();
    await expect(card.getByRole("button",{name:"Upgrade all",exact:true}),"the action has ended").toBeEnabled();
    await expect.soft(names,"the next Enter removes nothing").toHaveText(["Lane G Beta","Lane G Gamma"]);
    // The last marketplace's Remove: once it has gone, the keyboard is on the Upgrade of the marketplace before it.
    await rows.last().getByRole("button",{name:"Upgrade",exact:true}).focus();await page.keyboard.press("Tab");
    await expect(rows.last().getByRole("button",{name:"Remove",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    fixture.releaseShare();
    await expect(names).toHaveText(["Lane G Beta"]);
    await expect(rows.nth(0).getByRole("button",{name:"Upgrade",exact:true}),"the keyboard goes on to the Upgrade of the marketplace before it").toBeFocused();
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

// A Plugins or Marketplaces action the dropped connection cut off that Codex finished all the same: the list read as Codex is back
// shows it done (the plugin shared, installed or uninstalled, from its row or from a search result, the marketplace gone), and the
// card says nothing failed, as the Shared plugins' actions do. On adb7db5f the line stayed beside the row that showed it done: Lane G
// Local offered Update share under "Could not share Lane G Local: Codex disconnected", and Uninstall under "Could not install Lane G
// Local: Codex disconnected". One Codex did not finish keeps its line, with the action offered again, until it is tried again.
test("Tools drops the line of a Plugins or Marketplaces action a dropped Codex connection cut off once the list read again shows it done, and keeps it with the action offered again when it is not",async({page})=>{
  test.setTimeout(150_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.marketplaces=[...catalog(),...markets()];fixture.control.holdShare=true;
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const plugins=toolsCard(page,"Plugins"),marketplaces=toolsCard(page,"Marketplaces");
    const row=plugins.locator(".capability-list>div").filter({hasText:"Lane G Local"}),button=name=>row.getByRole("button",{name,exact:true});
    const line=(card,head)=>card.locator(".capability-error").filter({hasText:new RegExp("^"+head+" ")});
    await wheelTo(page,plugins);
    // Share privately Codex did not finish: the line says so, and Share privately is offered again.
    await cutOffShareAction(page,fixture,()=>button("Share privately").click(),{finished:false});
    await expect(line(plugins,"Could not share")).toHaveText("Could not share Lane G Local: Codex disconnected");
    await expect(row.getByRole("button")).toHaveText(["Details","Share privately","Install"]);
    // Tried again with the keys and finished as Codex went: the row offers Update share, and no line says the share failed.
    await cutOffShareAction(page,fixture,async()=>{await button("Details").focus();await page.keyboard.press("Tab");await expect(button("Share privately")).toBeFocused();await page.keyboard.press("Enter")},{finished:true});
    await expect(row.getByRole("button")).toHaveText(["Details","Update share","Install"]);
    await expect.soft(line(plugins,"Could not share"),"no line says the share Codex did failed").toHaveCount(0);
    for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:auditDir+`tools-plugin-share-finished-while-dropped-${mode}-1280x800.png`,fullPage:false})}
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    // Install clicked and finished as Codex went: the row offers Uninstall, with no line.
    await cutOffShareAction(page,fixture,()=>button("Install").click(),{finished:true});
    await expect(row.getByRole("button")).toHaveText(["Details","Update share","Uninstall"]);
    await expect.soft(line(plugins,"Could not install"),"no line says the install Codex did failed").toHaveCount(0);
    // Uninstall Codex did not finish keeps its line, with Uninstall offered again; double-clicked again and finished, the row offers
    // Install, with no line.
    await cutOffShareAction(page,fixture,()=>button("Uninstall").click(),{finished:false});
    await expect(line(plugins,"Could not uninstall")).toHaveText("Could not uninstall Lane G Local: Codex disconnected");
    await expect(button("Uninstall")).toBeEnabled();
    await cutOffShareAction(page,fixture,()=>button("Uninstall").dblclick(),{finished:true});
    await expect(row.getByRole("button")).toHaveText(["Details","Update share","Install"]);
    await expect.soft(line(plugins,"Could not uninstall"),"no line says the uninstall Codex did failed").toHaveCount(0);
    // From a search result: an Install finished as Codex went shows the result installed, offering Uninstall, with no line.
    await plugins.getByPlaceholder("Search plugins").fill("lane");await page.keyboard.press("Enter");
    const result=plugins.locator(".plugin-search-results>div").filter({hasText:"Lane G Local"});
    await expect(result.getByRole("button")).toHaveText(["Details","Install"]);
    await cutOffShareAction(page,fixture,()=>result.getByRole("button",{name:"Install",exact:true}).click(),{finished:true});
    await expect.soft(result.getByRole("button"),"the search result shows the install Codex did").toHaveText(["Details","Uninstall"]);
    await expect.soft(line(plugins,"Could not install"),"no line says the install from the search Codex did failed").toHaveCount(0);
    // A marketplace's Remove Codex did not finish keeps its line and its row; tried again and finished, the row goes, with no line.
    await wheelTo(page,marketplaces);
    const gamma=marketplaces.locator(".capability-list>div").filter({hasText:"Lane G Gamma"});
    await cutOffShareAction(page,fixture,()=>gamma.getByRole("button",{name:"Remove",exact:true}).click(),{finished:false});
    await expect(line(marketplaces,"Could not remove")).toHaveText("Could not remove lane-g-gamma: Codex disconnected");
    await expect(gamma.getByRole("button",{name:"Remove",exact:true})).toBeEnabled();
    await cutOffShareAction(page,fixture,()=>gamma.getByRole("button",{name:"Remove",exact:true}).click(),{finished:true});
    await expect(gamma).toHaveCount(0);
    await expect.soft(line(marketplaces,"Could not remove"),"no line says the remove Codex did failed").toHaveCount(0);
  }finally{fixture.releaseShare();await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// A round trip to Codex on the app's connection: the toolbar's Refresh, which no action waits for, reads the catalog again, and the
// frames of one connection arrive in order, so once that read has reached the fixture so has whatever the presses before it sent.
async function roundTrip(page,fixture){
  const refresh=page.locator(".capabilities-toolbar button"),reads=fixture.control.listReads;
  await refresh.click();await expect.poll(()=>fixture.control.listReads).toBeGreaterThan(reads);await expect(refresh).toHaveText("Refresh");
}

// A Tools page drawn again while a Plugins action is on its way (back from Settings with the mouse or the keys, or back from Usage)
// says so as the page that sent it did: the action's button reads Sharing…, Updating… or Installing…, marked busy, with the page's
// other actions waiting, and a second press, a click or Enter, sends nothing. Once Codex answers, the row shows what the action did,
// or a line says why it failed. The action went with the page that sent it: on adb7db5f the page drawn again offered Details, Share
// privately and Install live, a second Share privately sent a second share while the first was on its way, the row still offered
// Install once Codex had installed the plugin, and a refusal was said nowhere.
test("Tools drawn again while a Plugins action is on its way says so on its button with the other actions waiting, sends nothing for a second press, and shows what Codex did or why it refused once it answers",async({page})=>{
  test.setTimeout(120_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.marketplaces=catalog();fixture.control.holdShare=true;
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    const refresh=page.locator(".capabilities-toolbar button");await expect(refresh).toHaveText("Refresh");
    const plugins=toolsCard(page,"Plugins"),row=plugins.locator(".capability-list>div").filter({hasText:"Lane G Local"}),buttons=row.getByRole("button"),button=name=>row.getByRole("button",{name,exact:true});
    const settings=page.getByRole("heading",{name:"Settings",level:1}),tools=page.getByRole("heading",{name:"Harness capabilities",level:2});
    // The ways a person leaves Tools and comes back to it.
    const ways={
      "back from Settings":async()=>{await page.getByRole("button",{name:"Settings",exact:true}).click();await expect(settings).toBeVisible();await page.getByRole("button",{name:"Tools",exact:true}).click()},
      "back from Settings with the keys":async()=>{await page.keyboard.press("Control+,");await expect(settings).toBeVisible();await page.keyboard.press("Control+[")},
      "back from Usage":async()=>{await page.getByRole("button",{name:"Usage",exact:true}).click();await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();await page.getByRole("button",{name:"Tools",exact:true}).click()},
    };
    const away=async way=>{await ways[way]();await expect(tools).toBeVisible();await expect(refresh).toHaveText("Refresh");await wheelTo(page,plugins)};
    // A second press as a person makes it on the action's button: a click on it, then Enter; then a round trip to Codex, so what
    // either sent has reached the fixture before it is counted.
    const pressAgain=async target=>{await target.scrollIntoViewIfNeeded();const box=await target.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await target.focus();await page.keyboard.press("Enter");await roundTrip(page,fixture)};
    const shoot=async(name,shown)=>{
      for(const width of [1280,700]){await page.setViewportSize({width,height:800});await shown.evaluate(node=>node.scrollIntoView({block:"center"}));for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:auditDir+`${name}-${mode}-${width}x800.png`,fullPage:false})}}
      await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    };
    await wheelTo(page,plugins);
    // Share privately clicked, back from Settings: Sharing…, marked busy, with Details and Install waiting; a second press sends no
    // second share, and once Codex answers the row offers Update share.
    await button("Share privately").click();await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await away("back from Settings");
    await expect.soft(buttons,"the page drawn again says the share is on its way").toHaveText(["Details","Sharing…","Install"]);
    await expect.soft(buttons.nth(1),"marked busy").toHaveAttribute("aria-busy","true");
    for(const name of ["Details","Install"])await expect.soft(button(name),name+" waits").toBeDisabled();
    await shoot("tools-drawn-again-while-sharing",buttons.nth(1));
    await pressAgain(buttons.nth(1));
    expect.soft(fixture.control.heldShare.length,"a second press sends no second share while the first is on its way").toBe(1);
    fixture.releaseShare();
    await expect(buttons).toHaveText(["Details","Update share","Install"]);await expect(button("Update share")).toBeEnabled();
    // Update share pressed with the keys, back from Settings with the keys: Updating…, marked busy, and no second save.
    await button("Details").focus();await page.keyboard.press("Tab");await expect(button("Update share")).toBeFocused();await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await away("back from Settings with the keys");
    await expect.soft(buttons,"the page drawn again says the update is on its way").toHaveText(["Details","Updating…","Install"]);
    await expect.soft(buttons.nth(1),"marked busy").toHaveAttribute("aria-busy","true");
    await pressAgain(buttons.nth(1));
    expect.soft(fixture.control.heldShare.length,"a second press sends no second save while the first is on its way").toBe(1);
    fixture.releaseShare();
    await expect(button("Update share")).toBeEnabled();
    // Install clicked, back from Usage: Installing…, marked busy, and once Codex answers the row offers Uninstall.
    await button("Install").click();await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await away("back from Usage");
    await expect.soft(buttons,"the page drawn again says the install is on its way").toHaveText(["Details","Update share","Installing…"]);
    await expect.soft(buttons.nth(2),"marked busy").toHaveAttribute("aria-busy","true");
    fixture.releaseShare();
    await expect.soft(buttons,"once Codex answers, the page drawn again shows the plugin installed").toHaveText(["Details","Update share","Uninstall"]);
    await refresh.click();await expect(refresh).toHaveText("Refresh");await expect(button("Uninstall")).toBeEnabled();
    // Uninstall refused once the page is drawn again: the page drawn again says why, and offers Uninstall again.
    await button("Uninstall").click();await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
    await away("back from Settings");
    await expect.soft(button("Uninstalling…"),"the page drawn again says the uninstall is on its way").toHaveAttribute("aria-busy","true");
    fixture.refuseShare("the plugin is in use by a running task");
    await expect.soft(plugins.locator(".capability-error"),"the refusal is said on the page drawn again").toHaveText(["Could not uninstall Lane G Local: the plugin is in use by a running task"]);
    await expect(button("Uninstall")).toBeEnabled();
    await shoot("tools-drawn-again-uninstall-refused",row);
  }finally{fixture.releaseShare();await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// The ways a person leaves Tools and comes back to it, with Tools read again on its return.
function toolsWays(page){
  const settings=page.getByRole("heading",{name:"Settings",level:1}),tools=page.getByRole("heading",{name:"Harness capabilities",level:2}),refresh=page.locator(".capabilities-toolbar button");
  const back=async()=>{await expect(tools).toBeVisible();await expect(refresh).toHaveText("Refresh")};
  return {settings,
    async mouse(){await page.getByRole("button",{name:"Settings",exact:true}).click();await expect(settings).toBeVisible();await page.getByRole("button",{name:"Tools",exact:true}).click();await back()},
    async keys(){await page.keyboard.press("Control+,");await expect(settings).toBeVisible();await page.keyboard.press("Control+[");await back()},
    async to(){await page.getByRole("button",{name:"Settings",exact:true}).click();await expect(settings).toBeVisible()},
    async from(){await page.getByRole("button",{name:"Tools",exact:true}).click();await back()},
  };
}
const shootTools=async(page,name,shown)=>{
  for(const width of [1280,700]){await page.setViewportSize({width,height:800});await shown.evaluate(node=>node.scrollIntoView({block:"center"}));for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:auditDir+`${name}-${mode}-${width}x800.png`,fullPage:false})}}
  await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
};

// A page drawn again while a marketplace's Remove is on its way keeps the keyboard's place as the page that sent it does: put on
// Removing… there with Tab, and Enter pressed on it (which does nothing more), once Codex answers and the marketplace's row goes the
// keyboard is on the next marketplace's Upgrade, whether the Remove was pressed with the keys or the mouse. It fell to the page: only
// the page that sent the Remove knew where the keyboard was.
test("Tools drawn again while a Remove is on its way hands the keyboard on to the next marketplace's Upgrade once its row goes",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.marketplaces=markets();fixture.control.holdShare=true;
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const ways=toolsWays(page),card=toolsCard(page,"Marketplaces"),rows=card.locator(".capability-list>div"),names=rows.locator("strong");
    await expect(names).toHaveText(["Lane G Alpha","Lane G Beta","Lane G Gamma"]);
    await wheelTo(page,card);
    for(const [how,left] of [["keys",["Lane G Beta","Lane G Gamma"]],["mouse",["Lane G Gamma"]]]){
      const remove=rows.nth(0).getByRole("button",{name:"Remove",exact:true});
      if(how==="keys"){await rows.nth(0).getByRole("button",{name:"Upgrade",exact:true}).focus();await page.keyboard.press("Tab");await expect(remove).toBeFocused();await page.keyboard.press("Enter")}
      else await remove.click();
      await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
      await ways.keys();await wheelTo(page,card);
      const removing=rows.nth(0).getByRole("button",{name:"Removing…",exact:true});
      await card.getByPlaceholder("Git URL or local path").focus();await page.keyboard.press("Tab");
      await expect(removing,"Tab from the source field reaches Removing… on the page drawn again").toBeFocused();
      await page.keyboard.press("Enter");
      fixture.releaseShare();
      await expect(names).toHaveText(left);
      await expect.soft(rows.nth(0).getByRole("button",{name:"Upgrade",exact:true}),`once the row goes the keyboard is on the next marketplace's Upgrade (Remove pressed with the ${how})`).toBeFocused();
      await shootTools(page,"tools-drawn-again-marketplace-removed-keyboard-"+how,card);
    }
  }finally{fixture.releaseShare();await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// A Plugins action Codex refuses while the person is away from Tools (on Settings) is said once Tools is drawn again, as to a page
// that stays, with the action offered again: the line went with the page that sent it, and the page drawn again said nothing.
test("Tools says why Codex refused a Plugins action while the person was away, once Tools is drawn again, and offers the action again",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.marketplaces=catalog();fixture.control.holdShare=true;
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const ways=toolsWays(page),plugins=toolsCard(page,"Plugins"),row=plugins.locator(".capability-list>div").filter({hasText:"Lane G Local"}),button=name=>row.getByRole("button",{name,exact:true});
    await wheelTo(page,plugins);
    for(const [action,said,reason] of [["Install","Could not install Lane G Local","the marketplace is offline"],["Share privately","Could not share Lane G Local","sharing is turned off for this workspace"]]){
      await button(action).click();await expect.poll(()=>fixture.control.heldShare.length).toBe(1);
      await ways.to();
      fixture.refuseShare(reason);await page.waitForTimeout(600);
      await ways.from();await wheelTo(page,plugins);
      await expect.soft(plugins.locator(".capability-error"),`the refusal of ${action} that came while Settings showed is said once Tools is drawn again`).toHaveText([said+": "+reason]);
      await expect(button(action),action+" is offered again").toBeEnabled();
      await shootTools(page,"tools-refused-while-away-"+action.split(" ")[0].toLowerCase(),row);
    }
  }finally{fixture.releaseShare();await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// A plugin's Details, or a plugin search, that Codex answers once the person is back on Tools from Settings (by the mouse or the
// keys) or Usage shows what it read on the page drawn again: the plugin's details, or the results with the search they answer in
// the box. The answer went to the page that sent it: Loading… turned back into Details with no details shown, so it read as a press
// that did nothing, and Searching… ended with the box empty and the catalog listed.
test("Tools drawn again while a plugin's Details or a plugin search is on its way shows the details or the results once Codex answers",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.marketplaces=catalog();fixture.control.holdReads=true;
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const ways=toolsWays(page),plugins=toolsCard(page,"Plugins"),box=plugins.getByPlaceholder("Search plugins"),detail=plugins.locator(".plugin-detail");
    const row=plugins.locator(".capability-list:not(.plugin-search-results)>div").filter({hasText:"Lane G Local"}),result=plugins.locator(".plugin-search-results>div").filter({hasText:"Lane G Local"});
    await wheelTo(page,plugins);
    // Details clicked, then Settings and back: Loading… there, and once Codex answers the plugin's details.
    await row.getByRole("button",{name:"Details",exact:true}).click();await expect.poll(()=>fixture.control.heldReads.length).toBe(1);
    await ways.mouse();await wheelTo(page,plugins);
    await expect(row.getByRole("button",{name:"Loading…",exact:true})).toHaveAttribute("aria-busy","true");
    fixture.releaseReads();
    await expect.soft(detail,"the page drawn again shows the details Codex read").toContainText("What Lane G Local does, as Codex describes it.");
    await expect(row.getByRole("button",{name:"Details",exact:true})).toBeEnabled();
    await shootTools(page,"tools-drawn-again-plugin-details",plugins);
    if(await detail.count())await detail.getByRole("button",{name:"Close",exact:true}).click();
    // A search, Enter in the box, then Settings and back with the keys: Searching… there, and once Codex answers the results, with
    // the search in the box.
    await box.fill("lane");await box.press("Enter");await expect.poll(()=>fixture.control.heldReads.length).toBe(1);
    await ways.keys();await wheelTo(page,plugins);
    await expect(plugins.getByRole("button",{name:"Searching…",exact:true})).toHaveAttribute("aria-busy","true");
    fixture.releaseReads();
    await expect.soft(result,"the page drawn again shows the results").toHaveCount(1);
    await expect.soft(box,"with the search they answer in the box").toHaveValue("lane");
    await expect.soft(row,"in place of the catalog").toHaveCount(0);
    await shootTools(page,"tools-drawn-again-plugin-search",plugins);
    // Details on that result, pressed with the keys, then Usage and back: the details once Codex answers.
    if(await result.count()){
      await result.getByRole("button",{name:"Details",exact:true}).focus();await page.keyboard.press("Enter");await expect.poll(()=>fixture.control.heldReads.length).toBe(1);
      await page.getByRole("button",{name:"Usage",exact:true}).click();await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();
      await ways.from();await wheelTo(page,plugins);
      fixture.releaseReads();
      await expect.soft(detail,"the details of a search result read while Usage showed, on the page drawn again").toContainText("What Lane G Local does, as Codex describes it.");
    }
  }finally{fixture.releaseReads();await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// A history import says what it did once Conversation history is scanned again: the scan cleared the line as it started, so the
// summary never showed. Import available pressed, then Settings and back while the import runs: the page drawn again has no scan to
// draw Import available from, and says Importing… in its place, with Scan history waiting; once the import lands it says what was
// imported, and lists the scan read again. It showed only a disabled Scan history, and what the import did went with the page that
// sent it.
test("Tools says what a history import did, and drawn again while it runs says Importing…, and once it lands what it imported",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  const imported=new Set(),heldImports=[];let hold=false;
  const session=(index,title)=>({id:"history-claude-"+index,source:"claude",providerSessionId:"claude-history-"+index,cwd:process.cwd(),title,preview:title});
  const sessions=[session(1,"Recent Claude conversation"),session(2,"Older Claude conversation")];
  const answer=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/history-import$/,route=>{
    if(route.request().method()!=="POST")return answer(route,{codexImportAvailable:true,sessions:sessions.map(item=>({...item,alreadyImported:imported.has(item.id)}))});
    if(hold)return heldImports.push(route);
    const ids=route.request().postDataJSON()?.sessionIds||[];for(const id of ids)imported.add(id);
    return answer(route,{results:ids.map(id=>({id,status:"imported"}))});
  });
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const ways=toolsWays(page),history=toolsCard(page,"Conversation history"),scan=history.getByRole("button",{name:"Scan history",exact:true});
    const list=history.locator(".history-import-list"),row=title=>list.locator(":scope>div").filter({hasText:title}),status=history.locator(".capability-status");
    await wheelTo(page,history);
    await scan.click();await expect(list).toContainText("Recent Claude conversation");
    // On the page that stays: Import on the first conversation's row.
    await row("Recent Claude conversation").getByRole("button",{name:"Import",exact:true}).click();
    await expect(row("Recent Claude conversation")).toContainText("imported");await expect(scan).toBeEnabled();
    await expect.soft(status,"the page says what the import did once the history is scanned again").toHaveText("1 imported");
    // Drawn again while Import available runs.
    hold=true;
    await history.getByRole("button",{name:"Import available",exact:true}).click();await expect.poll(()=>heldImports.length).toBe(1);
    await ways.mouse();await wheelTo(page,history);
    await expect.soft(history.getByRole("button",{name:"Importing…",exact:true}),"the page drawn again says the import runs").toBeDisabled();
    await expect.soft(scan,"with Scan history waiting").toBeDisabled();
    await shootTools(page,"tools-drawn-again-history-importing",history);
    hold=false;
    for(const route of heldImports.splice(0)){imported.add(sessions[1].id);await answer(route,{results:[{id:sessions[1].id,status:"imported"},{id:sessions[0].id,status:"skipped"}]})}
    await expect.soft(status,"once the import lands the page drawn again says what it imported").toHaveText("1 imported · 1 already imported");
    await expect(row("Older Claude conversation"),"and lists the scan read again").toContainText("imported");
    await expect(scan).toBeEnabled();
    await shootTools(page,"tools-drawn-again-history-imported",history);
  }finally{for(const route of heldImports.splice(0))await answer(route,{results:[]}).catch(()=>{});await fixture.close()}
});

// A history import that lands, or is refused, while the person is away from Tools (on Settings or Usage) is said once Tools is drawn
// again, with the conversations read again: what it imported, both conversations listed imported, or why it was refused, both
// offered again; and only once, not again on the page drawn after. Both went nowhere: the page drawn again showed only Scan history,
// and only a second scan showed what the import had done.
test("Tools says what a history import that landed while the person was away did, or why it was refused, once Tools is drawn again, with the conversations read again",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  const imported=new Set(),heldImports=[];
  const session=(index,title)=>({id:"history-claude-"+index,source:"claude",providerSessionId:"claude-history-"+index,cwd:process.cwd(),title,preview:title});
  const sessions=[session(1,"Recent Claude conversation"),session(2,"Older Claude conversation")];
  const answer=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/history-import$/,route=>{
    if(route.request().method()!=="POST")return answer(route,{codexImportAvailable:true,sessions:sessions.map(item=>({...item,alreadyImported:imported.has(item.id)}))});
    heldImports.push(route);
  });
  // The held import answered while Tools is not shown, and read by the page before the person comes back.
  const land=async(value,status)=>{
    const read=page.waitForEvent("requestfinished",request=>request.method()==="POST"&&/\/api\/history-import$/.test(request.url()));
    for(const route of heldImports.splice(0))await answer(route,value,status);
    await read;await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
  };
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const ways=toolsWays(page),history=toolsCard(page,"Conversation history"),scan=history.getByRole("button",{name:"Scan history",exact:true}),importAll=history.getByRole("button",{name:"Import available",exact:true});
    const states=history.locator(".history-import-list>div em"),status=history.locator(".capability-status"),alert=history.getByRole("alert");
    await wheelTo(page,history);
    await scan.click();await expect(states).toHaveText(["available","available"]);
    // Import available, then Settings, where the import lands: back on Tools the card says what it imported, both conversations
    // listed imported.
    await importAll.click();await expect.poll(()=>heldImports.length).toBe(1);
    await ways.to();
    for(const item of sessions)imported.add(item.id);
    await land({results:sessions.map(item=>({id:item.id,status:"imported"}))});
    await ways.from();await wheelTo(page,history);
    await expect.soft(status,"an import that landed while Settings showed is said once Tools is drawn again").toHaveText("2 imported");
    await expect.soft(states,"with the conversations read again, both imported").toHaveText(["imported","imported"]);
    await expect(scan).toBeEnabled();await expect(importAll).toHaveCount(0);
    await shootTools(page,"tools-history-landed-while-away",history);
    // Said once: the page drawn after, back from Settings with the keys, says it no more.
    await ways.keys();await wheelTo(page,history);
    await expect.soft(status,"said once, not again on the page drawn after").toHaveCount(0);
    // Refused while Usage shows: back on Tools the card says why, and offers both conversations again.
    imported.clear();
    await scan.click();await expect(states).toHaveText(["available","available"]);
    await importAll.click();await expect.poll(()=>heldImports.length).toBe(1);
    await page.getByRole("button",{name:"Usage",exact:true}).click();await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();
    await land({error:"Deliberate history import failure"},500);
    await ways.from();await wheelTo(page,history);
    await expect.soft(alert,"a refusal that came while Usage showed is said once Tools is drawn again").toHaveText("Could not import conversations: Deliberate history import failure");
    await expect.soft(states,"with the conversations read again, both offered again").toHaveText(["available","available"]);
    await expect.soft(importAll,"Import available is offered again").toBeEnabled();
    await shootTools(page,"tools-history-refused-while-away",history);
  }finally{for(const route of heldImports.splice(0))await answer(route,{results:[]}).catch(()=>{});await fixture.close()}
});

// A Windows sandbox setup Codex has started runs until Codex says it is done, while Windows may ask for permission: a page drawn again
// meanwhile still says Setting up…, with both setups waiting, so a press sends no second setup, which could raise a second elevation
// prompt, until Codex says the setup is done. One done while the person is away leaves nothing waiting. The page drawn again offered
// both setups live.
test("Tools drawn again while a Windows sandbox setup runs says Setting up…, sends no second setup, and offers it again once Codex says it is done",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startHeldMcpFixture();fixture.release();fixture.control.sandbox="notConfigured";
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl,{platform:"win32"});
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const ways=toolsWays(page),card=toolsCard(page,"Windows sandbox"),setup=name=>card.getByRole("button",{name,exact:true}),settingUp=setup("Setting up…");
    await expect(card).toContainText("Not configured");await wheelTo(page,card);
    await setup("Set up elevated").click();await expect(settingUp).toBeDisabled();await expect.poll(()=>fixture.control.setups.length).toBe(1);
    await ways.mouse();await wheelTo(page,card);
    await expect.soft(settingUp,"the page drawn again says the setup runs").toBeDisabled();
    await expect.soft(setup("Set up unelevated"),"and the other setup waits").toBeDisabled();
    // A person tries again, on either setup it offers.
    for(const name of ["Set up elevated","Set up unelevated"])if(await setup(name).count()&&await setup(name).isEnabled())await setup(name).click();
    await roundTrip(page,fixture);
    expect.soft(fixture.control.setups.length,"no second setup while the first runs").toBe(1);
    await shootTools(page,"tools-drawn-again-sandbox-setting-up",card);
    // Codex says the setup failed: the page drawn again says so, and offers both setups again.
    fixture.notify("windowsSandbox/setupCompleted",{mode:"elevated",success:false,error:"Deliberate sandbox setup failure"});
    await expect(card.locator(".capability-error")).toContainText("Windows sandbox setup failed: Deliberate sandbox setup failure");
    await expect(setup("Set up elevated")).toBeEnabled();await expect(setup("Set up unelevated")).toBeEnabled();
    // A setup Codex says is done while the person is away leaves nothing waiting on the page drawn after, which says why it failed.
    await setup("Set up elevated").click();await expect(settingUp).toBeDisabled();await expect.poll(()=>fixture.control.setups.length).toBe(2);
    await ways.to();
    fixture.notify("windowsSandbox/setupCompleted",{mode:"elevated",success:false,error:"Deliberate sandbox setup failure while away"});await page.waitForTimeout(600);
    await ways.from();await wheelTo(page,card);
    await expect(setup("Set up elevated"),"a setup done while the person was away leaves nothing waiting").toBeEnabled();
    await expect(setup("Set up unelevated")).toBeEnabled();
    await expect.soft(card.locator(".capability-error"),"and the page drawn after says why it failed").toHaveText(["Windows sandbox setup failed: Deliberate sandbox setup failure while away"]);
    await shootTools(page,"tools-sandbox-setup-failed-while-away",card);
  }finally{await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// An agent configuration import Codex has started runs until Codex says it is done: a page drawn again meanwhile says Importing…,
// with Scan waiting, so no second import goes out, and says what the import did once Codex says it is done. The page drawn again
// offered Scan, and from it a second import, and passed over the first import's completion.
test("Tools drawn again while an agent configuration import runs says Importing…, sends no second import, and says what the import did",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.migrationItems=[{itemType:"SKILLS",description:"Claude Code skills",cwd:null}];
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const ways=toolsWays(page),card=toolsCard(page,"Import agent configuration"),scan=card.getByRole("button",{name:"Scan",exact:true});
    const importing=card.getByRole("button",{name:"Importing…",exact:true}),start=card.getByRole("button",{name:"Import 1 item",exact:true});
    await wheelTo(page,card);
    await scan.click();await start.click();
    await expect(importing).toBeDisabled();await expect.poll(()=>fixture.control.imports.length).toBe(1);
    await ways.keys();await wheelTo(page,card);
    await expect.soft(importing,"the page drawn again says the import runs").toBeDisabled();
    await expect.soft(scan,"with Scan waiting").toBeDisabled();
    // A person tries again: Scan, and Import once it is offered.
    if(await scan.isEnabled()){await scan.click();await expect(start).toBeVisible();if(await start.isEnabled())await start.click()}
    await roundTrip(page,fixture);
    expect.soft(fixture.control.imports.length,"no second import while the first runs").toBe(1);
    await shootTools(page,"tools-drawn-again-config-importing",card);
    const done={itemTypeResults:[{itemType:"SKILLS",successes:[{itemType:"SKILLS",description:"release-notes"}],failures:[]}]};
    fixture.notify("externalAgentConfig/import/completed",{importId:"import-1",...done});
    await expect.soft(card.locator(".capability-status"),"the page drawn again says what the import did").toHaveText("Import complete · Skills · 1 imported");
    await expect(scan).toBeEnabled();
    await shootTools(page,"tools-drawn-again-config-imported",card);
    // An import Codex ends while the person is away (on Settings), which no page heard end, leaves nothing waiting on the page drawn
    // after, as Codex lists it done in its import history.
    await start.click();await expect(importing).toBeDisabled();await expect.poll(()=>fixture.control.imports.length).toBe(2);
    await ways.to();
    fixture.control.histories.push({importId:"import-2",providerId:"claude",completedAtMs:Date.now(),successes:[{itemType:"SKILLS",cwd:null,source:"claude",target:"skills",title:null}],failures:[]});
    fixture.notify("externalAgentConfig/import/completed",{importId:"import-2",...done});await page.waitForTimeout(600);
    await ways.from();await wheelTo(page,card);
    await expect(scan,"an import done while the person was away leaves nothing waiting").toBeEnabled();await expect(importing).toHaveCount(0);
    await expect(card.getByText("Previous native imports · 1")).toBeVisible();
  }finally{await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// Codex's connection drops, and Codex comes back on a new one, with what it finished meanwhile done (done); resolves once the page
// has read Codex again.
async function dropCodex(page,fixture,done=()=>{}){
  fixture.control.holdInit=true;fixture.drop();
  await expect(page.getByText("Codex harness is not connected",{exact:true})).toBeVisible();
  done();fixture.releaseInit();
  await expect(page.getByRole("heading",{name:"Harness capabilities",level:2})).toBeVisible({timeout:15_000});
  await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh",{timeout:15_000});
}

// A Windows sandbox setup Codex started on a connection that drops is heard to end on none, as Codex reports it on the connection it
// was started on: once Codex is back the page that stays waits no more, as a page drawn again does, offers both setups again and
// says the setup's end is unknown, unless the sandbox reads ready. Dropped while Settings shows, the page drawn after says so, once.
// The page that stayed said Setting up… for good, with Set up unelevated waiting, while the page drawn again offered both.
test("Tools stops waiting for a Windows sandbox setup whose Codex connection dropped, says its end is unknown unless the sandbox reads ready, and offers it again",async({page})=>{
  test.setTimeout(90_000);
  const fixture=await startHeldMcpFixture();fixture.release();fixture.control.sandbox="notConfigured";
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl,{platform:"win32"});
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const ways=toolsWays(page),card=toolsCard(page,"Windows sandbox"),setup=name=>card.getByRole("button",{name,exact:true}),line=card.locator(".capability-status");
    const unknown="Codex disconnected before reporting how the elevated Windows sandbox setup ended, so it may still be running.";
    await expect(card).toContainText("Not configured");await wheelTo(page,card);
    // Set up elevated, then the drop: the page that stays offers both setups again, and says the setup's end is unknown.
    await setup("Set up elevated").click();await expect(setup("Setting up…")).toBeDisabled();
    await dropCodex(page,fixture);
    await expect(setup("Set up elevated"),"the page that stays offers the setup again once Codex is back").toBeEnabled();
    await expect.soft(setup("Set up unelevated"),"and the other setup").toBeEnabled();
    await expect.soft(line,"and says the setup's end is unknown").toHaveText(unknown);
    await shootTools(page,"tools-sandbox-setup-dropped",card);
    // Set up again with the keys sends a second setup; one Codex finished meanwhile reads Ready, with no line.
    await setup("Set up elevated").focus();await page.keyboard.press("Enter");
    await expect.poll(()=>fixture.control.setups.length).toBe(2);await expect(setup("Setting up…")).toBeDisabled();
    await dropCodex(page,fixture,()=>{fixture.control.sandbox="ready"});
    await expect(card).toContainText("Ready");await expect(setup("Setting up…")).toHaveCount(0);
    await expect.soft(line,"a setup the sandbox reads done says nothing more").toHaveCount(0);
    // Dropped while Settings shows: the page drawn after offers the setup and says its end is unknown, once.
    fixture.control.sandbox="notConfigured";await page.locator(".capabilities-toolbar button").click();
    await setup("Set up elevated").click();await expect(setup("Setting up…")).toBeDisabled();await expect.poll(()=>fixture.control.setups.length).toBe(3);
    await ways.to();
    fixture.control.holdInit=true;fixture.drop();await expect.poll(()=>fixture.control.heldInit.length).toBe(1);fixture.releaseInit();
    await ways.from();await wheelTo(page,card);
    await expect(setup("Set up elevated")).toBeEnabled();
    await expect.soft(line,"the page drawn after a drop while Settings showed says the setup's end is unknown").toHaveText(unknown);
    await ways.mouse();await wheelTo(page,card);
    await expect.soft(line,"once").toHaveCount(0);
  }finally{fixture.releaseInit();await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});

// An agent configuration import Codex started on a connection that drops is heard to end on none: once Codex is back the page that
// stays offers Scan and the import again, as a page drawn again does, and says the import's end is unknown, unless Codex lists it
// done in its import history. The page that stayed said Importing… for good, with Scan waiting.
test("Tools stops waiting for an agent configuration import whose Codex connection dropped, says its end is unknown unless Codex lists it done, and offers it again",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await startHeldMcpFixture();fixture.release();
  fixture.control.migrationItems=[{itemType:"SKILLS",description:"Claude Code skills",cwd:null}];
  try{
    await page.setViewportSize({width:1280,height:800});
    await openTools(page,fixture.wsUrl);
    await expect(page.locator(".capabilities-toolbar button")).toHaveText("Refresh");
    const ways=toolsWays(page),card=toolsCard(page,"Import agent configuration"),scan=card.getByRole("button",{name:"Scan",exact:true}),line=card.locator(".capability-status");
    const importing=card.getByRole("button",{name:"Importing…",exact:true}),start=card.getByRole("button",{name:"Import 1 item",exact:true});
    await wheelTo(page,card);
    await scan.click();await start.click();await expect(importing).toBeDisabled();await expect.poll(()=>fixture.control.imports.length).toBe(1);
    await dropCodex(page,fixture);
    await expect(scan,"the page that stays offers Scan again once Codex is back").toBeEnabled();
    await expect.soft(start,"and the import").toBeEnabled();
    await expect.soft(line,"and says the import's end is unknown").toHaveText("Codex disconnected before reporting how the agent configuration import ended, so it may still be running.");
    await shootTools(page,"tools-config-import-dropped",card);
    // Imported again; one Codex finished meanwhile is in its import history: nothing waits, and no line.
    await start.click();await expect(importing).toBeDisabled();await expect.poll(()=>fixture.control.imports.length).toBe(2);
    await dropCodex(page,fixture,()=>fixture.control.histories.push({importId:"import-2",providerId:"claude",completedAtMs:Date.now(),successes:[{itemType:"SKILLS",cwd:null,source:"claude",target:"skills",title:null}],failures:[]}));
    await expect(scan).toBeEnabled();await expect(importing).toHaveCount(0);
    await expect.soft(line,"an import Codex lists done says nothing more").toHaveCount(0);
    await expect(card.getByText("Previous native imports · 1")).toBeVisible();
    // The page drawn after says nothing of it.
    await ways.mouse();await wheelTo(page,card);
    await expect(scan).toBeEnabled();await expect.soft(line).toHaveCount(0);
  }finally{fixture.releaseInit();await page.evaluate(()=>{document.documentElement.dataset.mode="dark"}).catch(()=>{});await fixture.close()}
});
