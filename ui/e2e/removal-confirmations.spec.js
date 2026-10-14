import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";

// Removals that lose what a person set up ask first, in the app's own dialog: Cancel (or Escape) changes nothing, and the dialog's
// own button removes. Used the way a person uses them: real clicks and keys, with the requests the page sends counted.
const shots=fileURLToPath(new URL("../../visual-audit/polish/removal-confirmations/",import.meta.url));mkdirSync(shots,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
const question=page=>page.locator("dialog.inspector-text-prompt");
// The page as it is now, dark and light, at 1280 wide; left dark.
async function shootModes(page,name){
  await page.setViewportSize({width:1280,height:800});
  for(const mode of ["dark","light"]){
    await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
    await page.screenshot({animations:"disabled",path:shots+`${name}-${mode}-1280.png`});
  }
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
}

test("Remove on a runtime profile asks first, and Cancel or Escape keeps the profile",async({page})=>{
  test.setTimeout(45_000);
  let instances=[
    {id:"codex-default",kind:"codex",displayName:"Codex",enabled:true},
    {id:"codex-spare",kind:"codex",displayName:"Codex Spare",enabled:true,homePath:"C:/codex-spare",binaryPath:"C:/tools/codex.exe"},
  ];
  const deletes=[];
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const snapshot=()=>({selectedRuntime:"codex",selectedInstanceId:"codex-default",definitions:[{id:"codex",name:"Codex",protocol:"codex",multipleInstances:true}],instances,statuses:instances.map(item=>({id:item.id,kind:item.kind,name:item.displayName,available:true,installed:true,authenticated:true,version:"fixture"}))});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",agentRuntimeReady:true,appServerReady:false,wsUrl:"",cwd:process.cwd(),platform:process.platform,version:"removal-confirmations-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
  await page.route(/\/api\/settings$/,route=>json(route,settings));
  await page.route(/\/api\/models$/,route=>json(route,{agentRuntime:"codex",models:["fixture-model"],metadata:{models:[{id:"fixture-model",name:"Fixture model",agent:"codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/agent-runtimes(?:\?.*)?$/,route=>{
    if(route.request().method()==="GET")return json(route,snapshot());
    if(route.request().method()!=="DELETE")return json(route,snapshot());
    const id=new URL(route.request().url()).searchParams.get("id");deletes.push(id);instances=instances.filter(item=>item.id!==id);
    return json(route,{ok:true,resetTo:null,kind:"codex",...snapshot()});
  });
  await page.goto("/");
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  const spare=page.locator(".runtime-profile-row").filter({hasText:"Codex Spare"}),remove=spare.getByRole("button",{name:"Remove",exact:true});
  const card=page.locator(".agent-runtime-settings");
  await remove.click();
  await expect(question(page)).toBeVisible();
  await expect(question(page).locator("p")).toHaveText("Remove the runtime profile “Codex Spare”? This cannot be undone: its paths and settings are lost.");
  await expect(question(page).getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
  expect(deletes,"nothing is removed while the question is open").toEqual([]);
  await shootModes(page,"runtime-profile-remove-question");
  await question(page).getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(question(page)).toHaveCount(0);
  await expect(spare).toBeVisible();
  await expect(remove).toBeFocused();
  await expect(card).not.toContainText("Runtime profile removed.");
  // Escape is a Cancel too.
  await remove.click();await expect(question(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(question(page)).toHaveCount(0);
  await expect(spare).toBeVisible();
  expect(deletes,"Cancel and Escape remove nothing").toEqual([]);
  // The dialog's own button removes it.
  await remove.click();
  await question(page).getByRole("button",{name:"Remove profile",exact:true}).click();
  await expect(spare).toHaveCount(0);
  await expect(card).toContainText("Runtime profile removed.");
  expect(deletes).toEqual(["codex-spare"]);
  await shootModes(page,"runtime-profile-removed");
});

test("Remove on an MCP server asks first, and Cancel keeps the server",async({page})=>{
  test.setTimeout(45_000);
  let settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",activeEnvironmentId:null,
    mcpServers:[{id:"mcp-workspace-tools",name:"Workspace tools",runtime:"native",environmentId:null,enabled:true,type:"stdio",command:"workspace-mcp",args:["--stdio"],env:[]}]};
  const posts=[];
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,appServerReady:true,wsUrl:null,cwd:process.cwd(),platform:process.platform,version:"removal-confirmations-fixture",runtimeCapabilities:{mcpInjection:true,dynamicTools:true}}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
  await page.route(/\/api\/settings$/,route=>{
    if(route.request().method()==="POST"){const patch=route.request().postDataJSON()||{};posts.push(patch);settings={...settings,...patch}}
    return json(route,settings);
  });
  await page.route(/\/api\/agent-runtimes$/,route=>json(route,{selectedRuntime:"native",selectedInstanceId:"native-default",definitions:[{id:"native",name:"Trebell Native",protocol:"native",capabilities:{mcpInjection:true,dynamicTools:true}}],instances:[{id:"native-default",kind:"native",displayName:"Trebell Native",enabled:true}],statuses:[{id:"native-default",kind:"native",name:"Trebell Native",available:true,installed:true,authenticated:true,version:"built-in"}]}));
  await page.route(/\/api\/providers$/,route=>json(route,{ready:true,providers:[{id:"openai",name:"OpenAI API",official:true,ready:true}]}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["gpt-5.6"],metadata:{provider:"openai",models:[{id:"gpt-5.6",name:"GPT-5.6"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/runtime$/,route=>json(route,{agentRuntime:"native",agentRuntimeStatus:{available:true}}));
  await page.goto("/");
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.locator(".settings-nav").getByRole("button",{name:/Agents & models/}).click();
  const card=page.locator('[data-setting-target="agents-mcp"]'),server=card.locator(".custom-model-list>div").filter({hasText:"Workspace tools"});
  const remove=server.getByRole("button",{name:"Remove",exact:true});
  await remove.scrollIntoViewIfNeeded();await remove.click();
  await expect(question(page)).toBeVisible();
  await expect(question(page).locator("p")).toHaveText("Remove the MCP server “Workspace tools”? This cannot be undone: its command and settings are lost.");
  await expect(question(page).getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
  await shootModes(page,"mcp-server-remove-question");
  await question(page).getByRole("button",{name:"Cancel",exact:true}).click();
  await expect(question(page)).toHaveCount(0);
  await expect(server).toBeVisible();
  await expect(remove).toBeFocused();
  expect(posts,"Cancel saves nothing").toEqual([]);
  await remove.click();
  await question(page).getByRole("button",{name:"Remove server",exact:true}).click();
  await expect(server).toHaveCount(0);
  await expect(card).toContainText("MCP server removed.");
  expect(posts).toEqual([{mcpServers:[]}]);
});

test("Delete on a project action asks first, and Cancel keeps the action",async({page,request})=>{
  test.setTimeout(45_000);
  const boot=await (await request.get("/api/bootstrap")).json();
  const action=(id,name,command)=>({id,name,command,previewUrl:null,autoOpenPreview:false,runOnWorktreeCreate:false,waitForSetup:false});
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Confirm Actions Workspace",activate:true,scripts:[action("dev-server","Dev server","npm run dev"),action("unit-tests","Unit tests","npm test")],preferredScriptId:"dev-server"}});
  const savedActions=async()=>((await (await request.get("/api/projects")).json()).projects||[]).find(project=>project.path===boot.cwd&&!project.environmentId)?.scripts?.map(script=>script.name)||[];
  try{
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"Projects",exact:true}).click();
    const actions=page.locator(".project-card.active .project-actions"),row=actions.locator(".project-action-row").filter({has:page.locator("strong",{hasText:/^Dev server$/})});
    const trash=row.getByRole("button",{name:"Delete action",exact:true});
    await trash.scrollIntoViewIfNeeded();await trash.click();
    await expect(question(page)).toBeVisible();
    await expect(question(page).locator("p")).toHaveText("Delete the action “Dev server”? This cannot be undone: its command and settings are lost.");
    await expect(question(page).getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
    await shootModes(page,"project-action-delete-question");
    await question(page).getByRole("button",{name:"Cancel",exact:true}).click();
    await expect(question(page)).toHaveCount(0);
    await expect(row).toBeVisible();
    expect(await savedActions(),"Cancel deletes nothing").toEqual(["Dev server","Unit tests"]);
    await trash.click();
    await question(page).getByRole("button",{name:"Delete action",exact:true}).click();
    await expect(row).toHaveCount(0);
    await expect(actions.locator(".project-action-row").filter({hasText:"Unit tests"})).toBeVisible();
    await expect.poll(savedActions).toEqual(["Unit tests"]);
  }finally{
    await request.post("/api/projects",{data:{path:boot.cwd,scripts:[],preferredScriptId:null}});
  }
});

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("Delete share on a shared plugin asks first, and Cancel keeps the share",async({page})=>{
  test.setTimeout(45_000);
  const thread={id:"share-fixture",name:"Share fixture",preview:"Shared plugins",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  let shared=[{plugin:{id:"weather@official",name:"weather",remotePluginId:"remote-weather",version:"1.2.3",shareContext:{remotePluginId:"remote-weather",creatorName:"Trebell Labs",discoverability:"PRIVATE",sharePrincipals:[]}},localPluginPath:"C:/plugins/weather"}];
  const deletes=[];
  // A Codex app-server stand-in behind the real Codex relay: one thread and one shared plugin; every other list is empty.
  const upstreamHttp=createServer(),upstreamWss=new WebSocketServer({noServer:true}),sockets=new Set();
  upstreamHttp.on("upgrade",(req,raw,head)=>upstreamWss.handleUpgrade(req,raw,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;let result={};
      if(message.method==="initialize")result={userAgent:"share-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume"||message.method==="thread/read")result={thread};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="plugin/list")result={marketplaces:[],marketplaceLoadErrors:[],featuredPluginIds:[]};
      else if(message.method==="plugin/share/list")result={data:shared};
      else if(message.method==="plugin/share/delete"){deletes.push(message.params);shared=shared.filter(item=>item.plugin.remotePluginId!==message.params?.remotePluginId)}
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      else if(/\/list$/.test(message.method))result={data:[],nextCursor:null};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await keepThreadMeta(page);
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:process.platform,version:"share-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}}));
    await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.goto("/");
    await page.getByRole("button",{name:/Share fixture/}).click();
    await expect(page.getByRole("heading",{name:"What do you want to think through?"})).toBeVisible();
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"Tools",exact:true}).click();
    const share=page.locator(".shared-plugin-list>div").filter({has:page.locator("strong",{hasText:/^weather$/})}),remove=share.getByRole("button",{name:"Delete share",exact:true});
    await remove.scrollIntoViewIfNeeded();await remove.click();
    await expect(question(page)).toBeVisible();
    await expect(question(page).locator("p")).toHaveText("Delete the share of “weather”? Everyone it was shared with loses it, and this cannot be undone.");
    await expect(question(page).getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
    await shootModes(page,"plugin-share-delete-question");
    await question(page).getByRole("button",{name:"Cancel",exact:true}).click();
    await expect(question(page)).toHaveCount(0);
    await expect(share).toBeVisible();
    expect(deletes,"Cancel deletes nothing").toEqual([]);
    await remove.click();
    await question(page).getByRole("button",{name:"Delete share",exact:true}).click();
    await expect(share).toHaveCount(0);
    expect(deletes).toEqual([{remotePluginId:"remote-weather"}]);
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});

// A server's change that lands while another server's Remove question is open stays: the removal saves the servers as they are once
// the person answers. Here Workspace tools' Disable is slow to save, and lands behind the question.
test("Removing an MCP server keeps another server's Disable that landed while the question was open",async({page})=>{
  test.setTimeout(45_000);
  await page.setViewportSize({width:1280,height:800});
  const proofShots=process.env.TREBELL_PROOF_SHOTS?String(process.env.TREBELL_PROOF_SHOTS).replace(/[\/]*$/,"/"):shots+"proof-";
  const workspace={id:"mcp-workspace-tools",name:"Workspace tools",runtime:"native",environmentId:null,enabled:true,type:"stdio",command:"workspace-mcp",args:["--stdio"],env:[]};
  const docs={id:"mcp-docs-search",name:"Docs search",runtime:"native",environmentId:null,enabled:true,type:"stdio",command:"docs-mcp",args:[],env:[]};
  let settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",activeEnvironmentId:null,mcpServers:[workspace,docs]};
  const posts=[];
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:true,provider:"openai",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,appServerReady:true,wsUrl:null,cwd:process.cwd(),platform:process.platform,version:"removal-confirmations-fixture",runtimeCapabilities:{mcpInjection:true,dynamicTools:true}}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
  // The first save (the Disable) answers after 1.5 s: a busy disk or a slow link.
  await page.route(/\/api\/settings$/,async route=>{
    if(route.request().method()==="POST"){const patch=route.request().postDataJSON()||{};posts.push(patch);if(posts.length===1)await new Promise(resolve=>setTimeout(resolve,1500));settings={...settings,...patch}}
    return json(route,settings);
  });
  await page.route(/\/api\/agent-runtimes$/,route=>json(route,{selectedRuntime:"native",selectedInstanceId:"native-default",definitions:[{id:"native",name:"Trebell Native",protocol:"native",capabilities:{mcpInjection:true,dynamicTools:true}}],instances:[{id:"native-default",kind:"native",displayName:"Trebell Native",enabled:true}],statuses:[{id:"native-default",kind:"native",name:"Trebell Native",available:true,installed:true,authenticated:true,version:"built-in"}]}));
  await page.route(/\/api\/providers$/,route=>json(route,{ready:true,providers:[{id:"openai",name:"OpenAI API",official:true,ready:true}]}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["gpt-5.6"],metadata:{provider:"openai",models:[{id:"gpt-5.6",name:"GPT-5.6"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/runtime$/,route=>json(route,{agentRuntime:"native",agentRuntimeStatus:{available:true}}));
  await page.goto("/");
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.locator(".settings-nav").getByRole("button",{name:/Agents & models/}).click();
  const card=page.locator('[data-setting-target="agents-mcp"]'),row=name=>card.locator(".custom-model-list>div").filter({hasText:name});
  await row("Workspace tools").getByRole("button",{name:"Disable",exact:true}).scrollIntoViewIfNeeded();
  await row("Workspace tools").getByRole("button",{name:"Disable",exact:true}).click();
  await row("Docs search").getByRole("button",{name:"Remove",exact:true}).click();
  await expect(question(page)).toBeVisible();
  // The Disable lands while the question is open: Workspace tools reads Enable behind the dialog.
  await expect(row("Workspace tools").getByRole("button",{name:"Enable",exact:true})).toBeVisible({timeout:5000});
  await question(page).getByRole("button",{name:"Remove server",exact:true}).click();
  await expect(row("Docs search")).toHaveCount(0);
  await expect(card).toContainText("MCP server removed.");
  console.log("posts:",JSON.stringify(posts.map(patch=>patch.mcpServers?.map(item=>item.name+":"+(item.enabled===false?"off":"on")))));
  await card.screenshot({animations:"disabled",path:proofShots+"F3-mcp-remove-keeps-disable.png"});
  expect(settings.mcpServers.find(item=>item.id===workspace.id)?.enabled,"Workspace tools stays disabled on the server").toBe(false);
  expect(posts.at(-1),"the removal saves Workspace tools as disabled").toEqual({mcpServers:[{...workspace,enabled:false}]});
  await expect(row("Workspace tools").getByRole("button",{name:"Enable",exact:true}),"and it reads Enable").toBeVisible();
});
