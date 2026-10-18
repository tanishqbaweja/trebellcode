import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { keepThreadMeta } from "./test-home.js";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const CATALOGS={
  claude:{agentRuntime:"claude",ready:true,models:["sonnet","opus"],defaultModel:"sonnet",metadata:{models:[{id:"sonnet",name:"Claude Fixture Sonnet",agent:"claude"},{id:"opus",name:"Claude Fixture Opus",agent:"claude"}]},error:null},
  opencode:{agentRuntime:"opencode",ready:true,models:["opencode/fixture-fast","opencode/fixture-large"],defaultModel:"opencode/fixture-fast",metadata:{models:[{id:"opencode/fixture-fast",name:"OpenCode Fixture Fast",agent:"opencode"},{id:"opencode/fixture-large",name:"OpenCode Fixture Large",agent:"opencode"}]},error:null},
  native:{provider:"openai",agentRuntime:"native",ready:true,models:["gpt-fixture"],defaultModel:"gpt-fixture",metadata:{provider:"openai",models:[{id:"gpt-fixture",name:"GPT Fixture",provider:"openai"}]},error:null},
  codex:{agentRuntime:"codex",ready:true,models:["gpt-codex-fixture"],defaultModel:"gpt-codex-fixture",metadata:{models:[{id:"gpt-codex-fixture",name:"Codex Fixture",agent:"codex"}]},error:null},
};
const HARNESSES=[["claude","Claude Code","claude"],["opencode","OpenCode","http"],["native","Trebell Native","native"]];
// The harnesses with Codex among them, whose window speaks to it on a socket of its own in the app (here the fixture's one socket).
const WITH_CODEX=[["codex","Codex","codex"],...HARNESSES];

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// Like the GUI server's /api/agent/ws: every non-Codex harness shares one socket URL and each request is served by whichever runtime the
// server has active when it arrives, so a stale-model send made while a switch is in flight lands in the new harness (the live F1 failure).
// As the agent relay does, it lists the threads of the harness that runs, and tells a thread's turn to every window (emit), so a turn
// still running after a switch is heard on the socket that replaced the one that started it. holdTurns: a promise the turns wait on
// once started, or a function giving each turn the one it waits on as it starts (none: it ends at once).
async function startAgentRelay(activeRuntime,{turnDelayMs=0,reconnectInitializeDelayMs=0,approvalTurns=false,holdTurns=null}={}){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),open=new Map(),requests=[],threads=[],responses=[],answers=new Map();let connections=0,lostReplies=0;
  const notify=value=>{for(const socket of open.values())if(socket.readyState===1)socket.send(JSON.stringify(value))};
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    const connection=++connections;open.set(connection,ws);ws.on("close",()=>open.delete(connection));
    const send=value=>{if(ws.readyState!==1){lostReplies++;return}ws.send(JSON.stringify(value))};
    ws.on("message",async raw=>{
      const message=JSON.parse(String(raw));
      // A client answer to a server request (an approval), recorded with the socket it arrived on.
      if(message.id!=null&&!message.method){responses.push({connection,id:message.id,result:message.result??null,error:message.error??null});answers.get(message.id)?.(message);answers.delete(message.id);return}
      if(message.id==null||!message.method)return;
      const runtime=activeRuntime(),params=message.params||{};requests.push({connection,runtime,method:message.method,params});
      if(message.method==="turn/start"){
        // The turn stays in flight for turnDelayMs, so a transport reconnect during that window loses it like the live "<harness> disconnected".
        const threadId=params.threadId,turnId="switch-turn-"+requests.length,thread=threads.find(item=>item.id===threadId);if(turnDelayMs)await delay(turnDelayMs);
        if(thread)thread.status={type:"active"};
        send({id:message.id,result:{turn:{id:turnId,status:"inProgress",items:[]}}});
        notify({method:"turn/started",params:{threadId,turn:{id:turnId,status:"inProgress",startedAt:Date.now()/1000}}});
        if(approvalTurns){
          // A supervised turn waits on an approval sent to the socket that started it, as the agent relay routes a session's permission requests.
          const approvalId="approval-"+turnId,answered=new Promise(resolve=>answers.set(approvalId,resolve));
          send({id:approvalId,method:"item/commandExecution/requestApproval",params:{threadId,turnId,itemId:"command-"+turnId,command:["git","status"],reason:"Approve the runtime switch fixture command"}});
          await answered;
        }
        await (typeof holdTurns==="function"?holdTurns():holdTurns);
        const reply={id:"reply-"+turnId,type:"agentMessage",text:"Fixture reply from "+runtime};
        notify({method:"item/completed",params:{threadId,turnId,item:reply}});
        // The thread keeps the turn, as the relay stores it, so a reopen shows it.
        if(thread){thread.status={type:"idle"};thread.turns.push({id:turnId,status:"completed",items:[{type:"userMessage",id:"user-"+turnId,content:params.input||[]},reply]})}
        notify({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed",completedAt:Date.now()/1000}}});
        return;
      }
      let result={};
      if(message.method==="initialize"){if(connection>1&&reconnectInitializeDelayMs)await delay(reconnectInitializeDelayMs);result={userAgent:"runtime-switch-fixture"}}
      else if(message.method==="thread/start"){const thread={id:"switch-thread-"+requests.length,runtime,name:"Runtime switch fixture",preview:"",cwd:params.cwd||process.cwd(),createdAt:Date.now()/1000,updatedAt:Date.now()/1000,status:{type:"idle"},turns:[]};threads.push(thread);result={thread}}
      else if(message.method==="thread/list")result={data:threads.filter(thread=>thread.runtime===runtime),nextCursor:null};
      else if(message.method==="thread/resume"||message.method==="thread/read")result={thread:threads.find(item=>item.id===params.threadId)||{id:params.threadId,turns:[]},itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(["thread/turns/list","thread/queue/list","thread/attachment/list","thread/timeline/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(["threadSection/list","skills/list","collaborationMode/list"].includes(message.method))result={data:[]};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      send({id:message.id,result});
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",requests,responses,
    connections:()=>connections,openConnections:()=>[...open.keys()],lostReplies:()=>lostReplies,
    calls:(...methods)=>requests.filter(item=>methods.includes(item.method)),
    async close(){for(const ws of open.values())try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
}

// The GUI server side of a harness switch, mirroring POST /api/agent-runtimes {action:"select"}: the active runtime changes as soon as the
// request arrives, but the response (bundled bootstrap + catalog) and /api/models wait for the new runtime's catalog — live OpenCode
// discovery took about 3.4 s. catalogGate(runtime) returns that wait; holdRuntimeReads delays GET /api/agent-runtimes (the CLI probes).
// profileEditing lets Claude Code keep several profiles, so its active profile can be edited and saved ({action:"upsert"}). holdSelect()
// gives the promise a refused switch (rejectSelect, server.rejectSelect once started) waits on before it answers, in place of 300 ms.
// harnesses: the harness rows Settings lists; profiles: more profiles ({id,kind,displayName}) besides each harness's default one.
// installs offers Install or Update on Claude Code and OpenCode ({action:"install"}): holdInstall holds each install until it settles,
// failInstall is the error the next one fails with, and holdInstallAnswer holds its answer once the harness list in it is taken, as
// gui-server can still be reading the catalog it bundles when a switch lands. server.holdSelect holds a selection before the server takes it.
// threadMeta is the saved thread metadata the app starts with.
async function startHarness(page,{runtime="claude",harnesses=HARNESSES,profiles=[],catalogs=CATALOGS,catalogGate=null,turnDelayMs=0,reconnectInitializeDelayMs=0,rejectSelect="",holdSelect=null,approvalTurns=false,holdTurns=null,profileEditing=false,installs=false,threadMeta={}}={}){
  const server={runtime,rejectSelect,selects:[],versions:{},holdRuntimeReads:null,failRuntimeReads:"",holdInstall:null,holdInstallAnswer:null,failInstall:"",holdSelect:null,counts:{bootstrap:0,models:0,select:0,upsert:0,install:0,runtimeReads:0,runtimeReadsDone:0,direct:0}};
  const relay=await startAgentRelay(()=>server.runtime,{turnDelayMs,reconnectInitializeDelayMs,approvalTurns,holdTurns});
  const settings=()=>({onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:server.runtime,agentRuntimeInstanceId:server.runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"});
  const bootstrap=()=>({mock:false,provider:"openai",providerReady:true,agentRuntime:server.runtime,agentRuntimeInstanceId:server.runtime+"-default",agentRuntimeReady:true,appServerReady:true,wsUrl:relay.wsUrl,cwd:process.cwd(),platform:process.platform,version:"runtime-switch-fixture",activeEnvironmentId:null,activeEnvironment:null});
  const snapshot=()=>{
    const statuses=[...harnesses.map(([kind,name])=>({id:kind+"-default",kind,name})),...profiles.map(({id,kind,displayName})=>({id,kind,name:displayName}))].map(status=>({...status,available:true,installed:true,authenticated:true,version:server.versions[status.kind]||"1.0.0-fixture"}));
    return {selectedRuntime:server.runtime,selectedInstanceId:server.runtime+"-default",definitions:harnesses.map(([id,name,protocol])=>({id,name,protocol,multipleInstances:profileEditing&&id==="claude"||profiles.some(profile=>profile.kind===id),...(installs&&(id==="claude"||id==="opencode")?{installable:true,packageName:id==="opencode"?"opencode-ai":"@anthropic-ai/claude-code"}:{})})),instances:statuses.map(({id,kind,name})=>({id,kind,displayName:name,enabled:true})),statuses};
  };
  const catalog=async active=>{await catalogGate?.(active);return catalogs[active]};
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>{server.counts.bootstrap++;return json(route,bootstrap())});
  await page.route(/\/api\/state$/,route=>json(route,{settings:settings(),projects:[],threadMeta}));
  await page.route(/\/api\/settings$/,route=>json(route,settings()));
  await page.route(/\/api\/models(?:\?.*)?$/,async route=>{server.counts.models++;const value=await catalog(server.runtime);return json(route,value,value.error?503:200)});
  await page.route(/\/api\/agent-runtimes(?:\?.*)?$/,async route=>{
    if(route.request().method()==="GET"){server.counts.runtimeReads++;await server.holdRuntimeReads;server.counts.runtimeReadsDone++;return server.failRuntimeReads?json(route,{error:server.failRuntimeReads},500):json(route,snapshot())}
    const body=route.request().postDataJSON()||{};
    if(body.action==="upsert"){
      // Validated like AgentRuntimeManager.upsertInstance: a bad Claude auto-compact threshold is rejected and nothing changes.
      server.counts.upsert++;const raw=body.instance?.autoCompactWindow,value=Number(raw);
      if(raw!=null&&String(raw).trim()!==""&&(!Number.isInteger(value)||value<100_000||value>1_000_000)){await delay(300);return json(route,{error:"Claude auto-compact threshold must be an integer between 100000 and 1000000 tokens"},400)}
      const current=snapshot();return json(route,{instance:body.instance,...current,bootstrap:bootstrap(),catalog:await catalog(server.runtime)});
    }
    if(body.action==="install"){
      // As gui-server answers an install: the harness list as it is when the install ends, with the bootstrap and catalog only when the
      // harness installed is the one that runs then.
      server.counts.install++;await server.holdInstall;
      if(server.failInstall){const error=server.failInstall;server.failInstall="";return json(route,{error},400)}
      server.versions[body.runtime]="1.1.0-updated";
      const current=snapshot(),active=body.runtime===server.runtime,refresh=active?{bootstrap:bootstrap(),catalog:await catalog(server.runtime)}:{};
      await server.holdInstallAnswer;
      return json(route,{installed:{ok:true,runtime:body.runtime,status:current.statuses.find(item=>item.kind===body.runtime)},...current,...refresh});
    }
    if(body.action!=="select")return json(route,{error:"Unexpected agent runtime action in the runtime switch fixture: "+body.action},400);
    server.counts.select++;server.selects.push(body);await server.holdSelect;
    if(server.rejectSelect){const refusal=server.rejectSelect;await (holdSelect?holdSelect():delay(300));return json(route,{error:refusal},400)}
    server.runtime=body.runtime;
    const value=await catalog(server.runtime),current=snapshot();
    return json(route,{...current,selected:{runtime:server.runtime,instance:current.instances.find(item=>item.kind===server.runtime),status:current.statuses.find(item=>item.kind===server.runtime)},bootstrap:bootstrap(),catalog:value});
  });
  await page.route(/\/api\/providers$/,route=>json(route,{selected:"openai",providers:[{id:"openai",name:"OpenAI API",official:true,hasKey:true}],status:{id:"openai",hasKey:true},ready:true}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/general-workspace$/,route=>json(route,{path:process.cwd(),environmentId:null}));
  await page.route(/\/api\/stashes$/,route=>json(route,{stashes:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/chat\/direct$/,route=>{server.counts.direct++;return json(route,{error:"The direct route must not be used outside mock mode"},500)});
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  return {server,relay,close:()=>relay.close()};
}

async function openGeneralChat(page,relay){
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await page.locator(".general-chat-card").click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect.poll(()=>relay.calls("thread/list").length,{timeout:15_000}).toBeGreaterThan(0);
  await expect(page.getByTestId("composer-transport")).toHaveCount(0);
}
async function openHarnessSettings(page){
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:/Agents & models/}).click();
  await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
}
async function selectHarness(page,name){
  await openHarnessSettings(page);
  const option=page.locator(".agent-runtime-option").filter({hasText:name}).locator("button").first();
  await expect(option).toBeEnabled({timeout:10_000});await option.click();
}
// A blocked send may be explained in the composer's visible text, the textarea placeholder or the Send button title; collect all three.
function composerExplanation(page){
  return page.locator(".composer-wrap").filter({has:page.getByTestId("composer")}).evaluate(node=>[node.textContent,node.querySelector('[data-testid="composer"]')?.placeholder,node.querySelector('[data-testid="send"]')?.title].filter(Boolean).join(" · "));
}
const agentRuntimePost=page=>page.waitForResponse(response=>/\/api\/agent-runtimes$/.test(new URL(response.url()).pathname)&&response.request().method()==="POST");
// The light and dark toggle saves its setting in the page only.
async function keepAppearance(page,server){
  const saved={};
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return json(route,{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:server.runtime,agentRuntimeInstanceId:server.runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",...saved})});
}
// The page in dark and light, as the header's theme button sets them, at each width; check() runs before each shot. It ends in dark.
async function shootModes(page,name,{widths=[1280,700],check=async()=>{}}={}){
  const html=page.locator("html"),toggle=async mode=>{if(await html.getAttribute("data-mode")!==mode){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(html).toHaveAttribute("data-mode",mode)}};
  for(const mode of ["dark","light"]){
    await toggle(mode);
    for(const width of widths){await page.setViewportSize({width,height:800});await check();await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${width}x800.png`})}
  }
  await page.setViewportSize({width:1280,height:800});await toggle("dark");
}
// The light and dark toggle saves its setting in the page only, over startHarness's fixed settings: the harness they name is Claude
// Code, or the one server (startHarness's) runs.
async function keepModeSaves(page,server=null){
  const saved={};
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});const runtime=server?.runtime||"claude";return json(route,{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",...saved})});
}
async function switchMode(page,mode){
  const html=page.locator("html");if(await html.getAttribute("data-mode")===mode)return;
  await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(html).toHaveAttribute("data-mode",mode);
}
// Scrolls Settings with the mouse wheel in small steps until the target is wholly in view, and no further, as a person stops once
// what they scroll to shows: scrolled down to, it ends near the bottom of the window.
async function wheelIntoView(page,target){
  await page.mouse.move(Math.round(page.viewportSize().width*.65),400);
  await expect.poll(async()=>{
    const box=await target.boundingBox(),height=page.viewportSize().height;
    if(box&&box.y>=60&&box.y+box.height<=height-4)return true;
    await page.mouse.wheel(0,box&&box.y<60?-40:40);return false;
  },{timeout:20_000,intervals:[120]}).toBe(true);
}
function expectCatalogModels(relay){
  for(const call of relay.calls("thread/start","turn/start"))expect(CATALOGS[call.runtime].models,`${call.method} sent ${call.params.model} to ${call.runtime}`).toContain(call.params.model);
}

test("a harness switch clears the old model, blocks sends until the new catalog arrives and starts the thread with a model from it",async({page})=>{
  test.setTimeout(60_000);
  let releaseCatalog=()=>{};const opencodeCatalog=new Promise(resolve=>{releaseCatalog=resolve});
  const {server,relay,close}=await startHarness(page,{runtime:"claude",catalogGate:runtime=>runtime==="opencode"?opencodeCatalog:null});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),picker=page.getByTestId("model-picker");
    await expect(picker).toContainText("Claude Fixture Sonnet");
    const draft="Summarize the OpenCode fixture workspace.";
    await composer.fill(draft);await expect(send).toBeEnabled();

    await selectHarness(page,"OpenCode");
    await expect.poll(()=>server.counts.select).toBe(1);
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    // The server already runs OpenCode, but its catalog has not arrived: the Claude model must be gone and nothing may be sent yet.
    await expect(picker).toBeVisible();
    await expect(picker).not.toContainText(/sonnet/i);
    await expect(picker).toBeDisabled();
    await expect.poll(()=>composerExplanation(page)).toMatch(/Loading models/i);
    await expect(send).toBeDisabled();
    await expect(composer).toHaveValue(draft);
    await composer.press("Enter");await page.waitForTimeout(500);
    expect(relay.calls("thread/start","turn/start")).toEqual([]);
    expect(server.counts.direct).toBe(0);
    await expect(composer).toHaveValue(draft);
    // Enter does what the disabled Send does: nothing. No failed card says again what the line under the composer says.
    await expect(page.getByTestId("composer-runtime-switch")).toHaveText("Switching to OpenCode… · your draft stays here until it is ready.");
    await expect(page.getByText(/Trebell is switching to OpenCode/)).toHaveCount(0);await expect(page.locator(".activity-card-failed")).toHaveCount(0);
    await page.setViewportSize({width:1280,height:800});await page.screenshot({animations:"disabled",path:auditDir+"runtime-switch-loading-models-1280x800.png",fullPage:true});

    releaseCatalog();
    await expect(picker).toContainText("OpenCode Fixture Fast",{timeout:15_000});
    await expect(picker).not.toContainText(/sonnet/i);
    await expect(send).toBeEnabled({timeout:15_000});
    await send.click();
    await expect.poll(()=>relay.calls("turn/start").length,{timeout:15_000}).toBe(1);
    const [threadStart]=relay.calls("thread/start"),[turnStart]=relay.calls("turn/start");
    expect(threadStart.runtime).toBe("opencode");
    expect(CATALOGS.opencode.models).toContain(threadStart.params.model);
    expect(turnStart.params.model).toBe(threadStart.params.model);
    expect(JSON.stringify(turnStart.params.input)).toContain(draft);
    expectCatalogModels(relay);
    await expect(page.getByText("Fixture reply from opencode",{exact:true})).toBeVisible({timeout:15_000});
    await expect(composer).toHaveValue("");
    expect(server.counts.direct).toBe(0);
  }finally{releaseCatalog();await close()}
});

test("a harness switch reconnects the transport once and a send right after it reaches the new harness",async({page})=>{
  test.setTimeout(60_000);
  const {server,relay,close}=await startHarness(page,{runtime:"claude",catalogGate:runtime=>runtime==="opencode"?delay(900):null,turnDelayMs:1200,reconnectInitializeDelayMs:1500});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),picker=page.getByTestId("model-picker");
    await expect(picker).toContainText("Claude Fixture Sonnet");
    const baseline=relay.connections(),draft="Run the OpenCode follow-up right after the switch.";
    await composer.fill(draft);
    const switched=page.waitForResponse(response=>/\/api\/agent-runtimes$/.test(new URL(response.url()).pathname)&&response.request().method()==="POST");
    await selectHarness(page,"OpenCode");
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    await switched;
    // The new transport's handshake takes 1.5 s: Send must stay disabled until OpenCode is actually connected.
    await expect(send).toBeDisabled();
    await expect(picker).toContainText("OpenCode Fixture Fast",{timeout:15_000});
    await expect(send).toBeEnabled({timeout:15_000});
    await send.click();
    await expect.poll(()=>relay.calls("turn/start").length,{timeout:15_000}).toBe(1);
    const [turnStart]=relay.calls("turn/start");
    await expect(page.getByText("Fixture reply from opencode",{exact:true})).toBeVisible({timeout:15_000});
    await page.waitForTimeout(1000);
    // One reconnect for the switch: exactly one new socket, it carried the turn, it is the only one left open and no reply was dropped.
    expect(relay.connections()-baseline).toBe(1);
    expect(relay.calls("initialize").filter(call=>call.connection>baseline)).toHaveLength(1);
    expect(relay.openConnections()).toEqual([turnStart.connection]);
    expect(relay.lostReplies()).toBe(0);
    expect(turnStart.runtime).toBe("opencode");
    expectCatalogModels(relay);
    await expect(composer).toHaveValue("");
    await expect(page.getByText(/(Claude Code|OpenCode) disconnected/)).toHaveCount(0);
    expect(server.counts.select).toBe(1);
    expect(server.counts.direct).toBe(0);
  }finally{await close()}
});

test("a harness switch completed while Settings stays open keeps the new catalog in the chat picker",async({page})=>{
  test.setTimeout(45_000);
  const {server,relay,close}=await startHarness(page,{runtime:"claude",catalogGate:runtime=>runtime==="opencode"?delay(2500):null});
  try{
    await openGeneralChat(page,relay);
    const picker=page.getByTestId("model-picker");
    await expect(picker).toContainText("Claude Fixture Sonnet");
    const switched=page.waitForResponse(response=>/\/api\/agent-runtimes$/.test(new URL(response.url()).pathname)&&response.request().method()==="POST");
    await selectHarness(page,"OpenCode");
    await switched;
    await expect(page.locator(".agent-runtime-option").filter({hasText:"OpenCode"}).getByText("Active",{exact:true})).toBeVisible();
    await page.waitForTimeout(500);
    const modelReads=server.counts.models;
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    // The select response already carried the OpenCode catalog; the picker must show it at once and keep it, not fall back to "No models".
    await expect(picker).toContainText("OpenCode Fixture Fast",{timeout:1500});
    await page.waitForTimeout(2000);
    await expect(picker).toContainText("OpenCode Fixture Fast");
    await expect(picker).toBeEnabled();
    expect(server.counts.models).toBe(modelReads);
  }finally{await close()}
});

// New task, the sidebar's way back from Settings, finds the new task's draft as it was after a harness switch, as the switch's note
// says it will be.
test("a new-task draft stays through a harness switch and New task back from Settings",async({page})=>{
  test.setTimeout(45_000);
  const {relay,close}=await startHarness(page,{runtime:"claude"});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),picker=page.getByTestId("model-picker"),draft="A draft written before the switch";
    await expect(picker).toContainText("Claude Fixture Sonnet");
    await composer.click();await page.keyboard.type(draft,{delay:8});
    const switched=agentRuntimePost(page);
    await selectHarness(page,"OpenCode");
    await switched;
    await page.getByRole("button",{name:"New task",exact:true}).click();
    await expect(composer).toHaveValue(draft);
    await expect(picker).toContainText("OpenCode Fixture Fast",{timeout:15_000});
    await expect(composer).toHaveValue(draft);
  }finally{await close()}
});

test("a rejected harness switch restores the previous harness model and keeps its transport",async({page})=>{
  test.setTimeout(45_000);
  const {server,relay,close}=await startHarness(page,{runtime:"claude",rejectSelect:"OpenCode could not start: fixture launcher failed"});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),picker=page.getByTestId("model-picker");
    await expect(picker).toContainText("Claude Fixture Sonnet");
    const draft="Keep working in Claude Code after the failed switch.",baseline=relay.connections();
    await composer.fill(draft);
    const rejected=agentRuntimePost(page);
    await selectHarness(page,"OpenCode");
    expect((await rejected).status()).toBe(400);
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    // The server still runs Claude Code, so its model comes back and its transport was never closed.
    await expect(picker).toContainText("Claude Fixture Sonnet",{timeout:10_000});
    await expect(send).toBeEnabled({timeout:10_000});
    await expect(composer).toHaveValue(draft);
    expect(relay.connections()).toBe(baseline);
    await send.click();
    await expect.poll(()=>relay.calls("turn/start").length,{timeout:15_000}).toBe(1);
    const [threadStart]=relay.calls("thread/start");
    expect(threadStart.runtime).toBe("claude");
    expect(threadStart.params.model).toBe("sonnet");
    expectCatalogModels(relay);
    await expect(page.getByText("Fixture reply from claude",{exact:true})).toBeVisible({timeout:15_000});
    expect(server.runtime).toBe("claude");
  }finally{await close()}
});

// The refusal shows on the row that was clicked, in view: the status line under the whole list was below the fold at 1280x800.
test("a refused harness switch says why on the harness row that was clicked, in view",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const {close}=await startHarness(page,{runtime:"claude",rejectSelect:"OpenCode could not start: fixture launcher failed"});
  // The light and dark toggle saves its setting in the page only.
  const saved={};
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return json(route,{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",...saved})});
  try{
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    for(const pass of ["dark","light"]){
      if(pass==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      const rejected=agentRuntimePost(page);
      await selectHarness(page,"OpenCode");
      expect((await rejected).status()).toBe(400);
      const row=page.locator(".agent-runtime-option").filter({hasText:"OpenCode"}),refusal=row.getByRole("alert");
      await expect(refusal).toHaveText("Could not switch to OpenCode: OpenCode could not start: fixture launcher failed");
      await expect(refusal).toBeInViewport();
      await expect(row.locator("button em")).toHaveText("Switch");
      // Said once: neither the status line under the list nor the app's alert repeats it.
      await expect(page.getByTestId("agent-runtime-message")).toHaveCount(0);await expect(page.getByTestId("app-action-error")).toHaveCount(0);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(refusal).toBeInViewport();await page.screenshot({animations:"disabled",path:`${auditDir}harness-switch-refused-on-its-row-${pass}-${width}x800.png`})}
      await page.setViewportSize({width:1280,height:800});
    }
  }finally{await close()}
});

// A refusal that comes once the person has gone back to the chat is said there, in the app's alert, and Settings opened again still
// says it on the row that was clicked: it was said on that row only, and lost with it, so whoever had left Settings saw it nowhere.
test("a harness switch refused after the person left Settings is said in the chat and kept on its row",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  let answer=null,refuse=()=>{};const arm=()=>{answer=new Promise(resolve=>{refuse=resolve})};arm();
  const {server,relay,close}=await startHarness(page,{runtime:"claude",rejectSelect:"OpenCode could not start: fixture launcher failed",holdSelect:()=>answer});
  // The light and dark toggle saves its setting in the page only.
  const saved={};
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return json(route,{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",...saved})});
  try{
    await openGeneralChat(page,relay);
    const picker=page.getByTestId("model-picker"),alert=page.getByTestId("app-action-error"),text="Could not switch to OpenCode: OpenCode could not start: fixture launcher failed";
    const row=page.locator(".agent-runtime-option").filter({hasText:"OpenCode"});
    await expect(picker).toContainText("Claude Fixture Sonnet");
    for(const pass of ["dark","light"]){
      if(pass==="light"){await expect(alert).toHaveCount(0,{timeout:10_000});arm();await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      const rejected=agentRuntimePost(page),asked=server.counts.select;
      await selectHarness(page,"OpenCode");
      await expect.poll(()=>server.counts.select).toBe(asked+1);
      // Back to the chat (the brand button) before the answer comes.
      await page.getByRole("button",{name:"Threads",exact:true}).click();await expect(page.getByTestId("composer")).toBeVisible();await expect(row).toHaveCount(0);
      refuse();expect((await rejected).status()).toBe(400);
      // Soft, so that the old build also shows what Settings says once it is opened again.
      await expect.soft(alert,"the chat says the switch was refused").toHaveText(text);
      await expect(picker).toContainText("Claude Fixture Sonnet",{timeout:10_000});
      if(await alert.count()){await expect(alert).toBeInViewport();await page.screenshot({animations:"disabled",path:`${auditDir}harness-switch-refused-in-chat-${pass}-1280x800.png`})}
      await openHarnessSettings(page);
      const refusal=row.getByRole("alert");
      await expect(refusal,"back in Settings, the OpenCode row says why").toHaveText(text);await expect(refusal).toBeInViewport();
      await expect(row.locator("button em")).toHaveText("Switch");
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(refusal).toBeInViewport();await page.screenshot({animations:"disabled",path:`${auditDir}harness-switch-refused-kept-on-its-row-${pass}-${width}x800.png`})}
      await page.setViewportSize({width:1280,height:800});
    }
  }finally{refuse();await close()}
});

// A switch asked for while the open thread's turn runs asks first and says what becomes of the task: Cancel (Escape) leaves the
// harness and the task as they were; once switched, the task runs on in its harness, its row in the sidebar says it runs until its
// turn ends, and opened it switches back and shows how it ended. The switch went through at once, without a word.
test("a harness switch while a turn runs asks first, and the running task stays in the sidebar until its turn ends",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  let release=()=>{};const held=new Promise(resolve=>{release=resolve});
  const {server,relay,close}=await startHarness(page,{runtime:"claude",holdTurns:held});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),picker=page.getByTestId("model-picker"),dialog=page.getByRole("dialog");
    await expect(picker).toContainText("Claude Fixture Sonnet");
    await composer.click();await page.keyboard.type("Run a long Claude task",{delay:5});await page.keyboard.press("Enter");
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeVisible({timeout:15_000});
    const threadId=relay.calls("turn/start")[0].params.threadId,row=page.locator(`.thread-row[data-thread-id="${threadId}"]`),runningDot=row.getByRole("img",{name:"Running"});
    await expect(runningDot).toBeVisible();
    await openHarnessSettings(page);
    const option=page.locator(".agent-runtime-option").filter({hasText:"OpenCode"}).locator("button").first();
    await expect(option).toBeEnabled({timeout:10_000});await option.click();
    // The task is named as its row names it (the fixture names every thread so).
    await expect(dialog,"a question before the switch").toContainText("Switch to OpenCode while Claude Code is running “Runtime switch fixture”?");
    await expect(dialog).toContainText("The task keeps running in Claude Code, and its thread stays in the sidebar.");
    await expect(dialog.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
    for(const width of [1280,700]){await page.setViewportSize({width,height:800});await expect(dialog.getByRole("button",{name:"Switch to OpenCode",exact:true})).toBeInViewport();await page.screenshot({animations:"disabled",path:`${auditDir}harness-switch-while-running-asks-${width}x800.png`})}
    await page.setViewportSize({width:1280,height:800});
    await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(option).toBeFocused();
    await expect(option.locator("em")).toHaveText("Switch");await expect(page.locator(".agent-runtime-option").filter({hasText:"Claude Code"}).locator("button em").first()).toHaveText("Active");
    expect(server.counts.select,"Cancel switches nothing").toBe(0);
    // Asked again from the keyboard (Escape gave it back to Switch), Switch to OpenCode goes through.
    const switched=agentRuntimePost(page);
    await page.keyboard.press("Enter");await expect(dialog).toBeVisible();
    await page.keyboard.press("Tab");await expect(dialog.getByRole("button",{name:"Switch to OpenCode",exact:true})).toBeFocused();await page.keyboard.press("Enter");
    await switched;expect(server.counts.select).toBe(1);
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    await expect(picker).toContainText("OpenCode Fixture Fast",{timeout:15_000});
    // The Claude Code task runs on, and its row says so until its turn ends.
    await expect(row).toBeVisible();await expect(runningDot).toBeVisible();
    await page.screenshot({animations:"disabled",path:auditDir+"harness-switch-while-running-row-runs-1280x800.png"});
    release();
    await expect(runningDot).toHaveCount(0,{timeout:15_000});
    // Opened, it switches back to Claude Code and shows the reply its turn ended with.
    await row.locator(".thread-main").click();
    await expect(picker).toContainText("Claude Fixture Sonnet",{timeout:15_000});
    await expect(page.getByText("Fixture reply from claude",{exact:true})).toBeVisible({timeout:15_000});
    expect(server.runtime).toBe("claude");expect(server.counts.direct).toBe(0);
  }finally{release();await close()}
});

// A Codex turn does not run on through a switch as the agent relay's turns do: Codex is restarted when it is selected again, or another
// of its profiles is, which ends its turns, and a window away from Codex hears nothing of them. So a switch away from Codex, or to
// another Codex profile, while a Codex turn runs is refused on the row that was clicked, as opening another harness's thread is, also
// from a new task while the turn runs on in its thread's row; once the turn has ended it goes through. The switch asked, and said the
// task kept running in Codex, and coming back to Codex then ended it with no word.
test("a switch away from Codex, or to another Codex profile, while a Codex turn runs is refused on the row clicked until the turn ends",async({page})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1280,height:800});
  let release=()=>{};const held=new Promise(resolve=>{release=resolve});
  const {server,relay,close}=await startHarness(page,{runtime:"codex",harnesses:WITH_CODEX,profiles:[{id:"codex-work",kind:"codex",displayName:"Codex work"}],holdTurns:held});
  await keepAppearance(page,server);
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),picker=page.getByTestId("model-picker"),dialog=page.getByRole("dialog");
    await expect(picker).toContainText("Codex Fixture");
    await composer.click();await page.keyboard.type("Run a long Codex task",{delay:5});await page.keyboard.press("Enter");
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeVisible({timeout:15_000});
    const threadId=relay.calls("turn/start")[0].params.threadId,runningDot=page.locator(`.thread-row[data-thread-id="${threadId}"]`).getByRole("img",{name:"Running"});
    await expect(runningDot).toBeVisible();
    const said=target=>`Could not switch to ${target}: Codex is running “Runtime switch fixture”. Stop the running turn before switching ${target==="Codex work"?"Codex profiles":"agent runtimes"}.`;
    const opencode=page.locator(".agent-runtime-option").filter({hasText:"OpenCode"}),switchOpenCode=opencode.locator("button").first(),work=page.locator(".runtime-profile-row").filter({hasText:"Codex work"});
    await openHarnessSettings(page);
    // OpenCode, with the mouse: refused on its row; nothing is asked and nothing switches.
    await expect(switchOpenCode).toBeEnabled({timeout:10_000});await switchOpenCode.click();
    await expect(opencode.getByRole("alert"),"the OpenCode row says why").toHaveText(said("OpenCode"));await expect(opencode.getByRole("alert")).toBeInViewport();
    await expect(dialog).toHaveCount(0);expect(server.counts.select,"nothing switched").toBe(0);await expect(switchOpenCode.locator("em")).toHaveText("Switch");
    // The Codex work profile, from the keyboard: refused on its own row, which says so in place of the OpenCode row.
    const use=work.locator("button").first();await expect(use.locator("em")).toHaveText("Use");await use.focus();await page.keyboard.press("Enter");
    await expect(work.getByRole("alert"),"the Codex work row says why").toHaveText(said("Codex work"));await expect(opencode.getByRole("alert")).toHaveCount(0);
    await expect(dialog).toHaveCount(0);expect(server.counts.select).toBe(0);
    await shootModes(page,"harness-switch-codex-running-refused",{widths:[1280,700],check:()=>expect(work.getByRole("alert")).toBeInViewport()});
    // From a new task the turn still runs, as its row says: the switch away from Codex is refused the same way.
    await page.getByRole("button",{name:"New task",exact:true}).click();await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);await expect(runningDot).toBeVisible();
    await openHarnessSettings(page);await switchOpenCode.click();
    await expect(opencode.getByRole("alert"),"from a new task, the OpenCode row says why").toHaveText(said("OpenCode"));expect(server.counts.select).toBe(0);
    // Once the turn has ended, OpenCode is switched to without a word.
    release();await expect(runningDot).toHaveCount(0,{timeout:15_000});
    const switched=agentRuntimePost(page);await switchOpenCode.click();await switched;
    await expect(dialog).toHaveCount(0);expect(server.counts.select).toBe(1);expect(server.runtime).toBe("opencode");
    await expect(opencode.getByRole("alert")).toHaveCount(0);await expect(switchOpenCode.locator("em")).toHaveText("Active");
  }finally{release();await close()}
});

// The other way: a window on Codex hears none of the agent relay's turns, so a switch to Codex while a Claude Code turn runs is refused
// on the Codex row too, where its row would say "Running" after the turn had ended. Once the turn has ended, Codex is switched to.
test("a switch to Codex while a Claude Code turn runs is refused on the Codex row until the turn ends",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  let release=()=>{};const held=new Promise(resolve=>{release=resolve});
  const {server,relay,close}=await startHarness(page,{runtime:"claude",harnesses:WITH_CODEX,holdTurns:held});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),picker=page.getByTestId("model-picker"),dialog=page.getByRole("dialog");
    await expect(picker).toContainText("Claude Fixture Sonnet");
    await composer.click();await page.keyboard.type("Run a long Claude task",{delay:5});await page.keyboard.press("Enter");
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeVisible({timeout:15_000});
    const threadId=relay.calls("turn/start")[0].params.threadId,runningDot=page.locator(`.thread-row[data-thread-id="${threadId}"]`).getByRole("img",{name:"Running"});
    await openHarnessSettings(page);
    const codex=page.locator(".agent-runtime-option").filter({has:page.locator("strong",{hasText:/^Codex$/})}),switchCodex=codex.locator("button").first();
    await expect(switchCodex).toBeEnabled({timeout:10_000});await switchCodex.click();
    await expect(codex.getByRole("alert"),"the Codex row says why").toHaveText("Could not switch to Codex: Claude Code is running “Runtime switch fixture”. Stop the running turn before switching agent runtimes.");
    await expect(codex.getByRole("alert")).toBeInViewport();await expect(dialog).toHaveCount(0);expect(server.counts.select,"nothing switched").toBe(0);
    for(const width of [1280,700]){await page.setViewportSize({width,height:800});await expect(codex.getByRole("alert")).toBeInViewport();await page.screenshot({animations:"disabled",path:`${auditDir}harness-switch-to-codex-refused-${width}x800.png`})}
    await page.setViewportSize({width:1280,height:800});
    release();await expect(runningDot).toHaveCount(0,{timeout:15_000});
    const switched=agentRuntimePost(page);await switchCodex.click();await switched;
    await expect(dialog).toHaveCount(0);expect(server.counts.select).toBe(1);expect(server.runtime).toBe("codex");
    await page.getByRole("button",{name:"Threads",exact:true}).click();await expect(picker).toContainText("Codex Fixture",{timeout:15_000});
  }finally{release();await close()}
});

// Opening a thread of another harness switches to that harness, and the switch waited only for the turn of the thread shown. A
// Codex turn left running for a new task was ended on the way back to Codex, which restarts it, and a Claude Code turn left so kept
// its row's Running dot in a window gone to Codex. When the switch crosses Codex, opening the thread now waits for those turns too,
// says which one runs, and goes through once it has ended.
test("opening another harness's thread waits for a turn left running for a new task when the switch crosses Codex",async({page})=>{
  test.setTimeout(150_000);
  await page.setViewportSize({width:1280,height:800});
  // hold: what the next turn waits on once started (none: it ends at once). holdNext() holds the next turn and gives its release.
  let hold=null;const holdNext=()=>{let release=()=>{};hold=new Promise(resolve=>{release=resolve});return release};
  const releases=[];
  const {server,relay,close}=await startHarness(page,{runtime:"claude",harnesses:WITH_CODEX,holdTurns:()=>hold});
  await keepAppearance(page,server);
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),picker=page.getByTestId("model-picker"),alert=page.getByTestId("composer-alert"),stop=page.getByRole("button",{name:"Stop",exact:true});
    const newTask=page.getByRole("button",{name:"New task",exact:true}),row=id=>page.locator(`.thread-row[data-thread-id="${id}"]`);
    const said=harness=>`Could not open “Runtime switch fixture”: ${harness} is running “Runtime switch fixture”. Stop the running turn before switching agent runtimes. Sending now starts a new task instead.`;
    // A Claude Code thread whose turn has ended, then Codex.
    await expect(picker).toContainText("Claude Fixture Sonnet");
    await composer.click();await page.keyboard.type("A Claude Code task",{delay:5});await page.keyboard.press("Enter");
    await expect(page.getByText("Fixture reply from claude",{exact:true})).toBeVisible({timeout:15_000});
    const claudeThread=relay.calls("turn/start")[0].params.threadId;
    let switched=agentRuntimePost(page);await selectHarness(page,"Codex");await switched;
    await page.getByRole("button",{name:"Threads",exact:true}).click();await expect(picker).toContainText("Codex Fixture",{timeout:15_000});
    // A Codex turn, left running for a new task: its row says it runs.
    releases.push(holdNext());
    await composer.click();await page.keyboard.type("Run a long Codex task",{delay:5});await page.keyboard.press("Enter");
    await expect(stop).toBeVisible({timeout:15_000});
    const codexThread=relay.calls("turn/start")[1].params.threadId,codexRunning=row(codexThread).getByRole("img",{name:"Running"});
    await newTask.click();await expect(stop).toHaveCount(0);await expect(codexRunning).toBeVisible();
    // The Claude Code thread, with the mouse: it does not open while the Codex turn runs, and the composer says why.
    let selects=server.counts.select;
    await row(claudeThread).locator(".thread-main").click();
    await expect(alert,"opening the Claude Code thread says the Codex turn runs").toHaveText(said("Codex"));
    expect(server.counts.select,"nothing switched").toBe(selects);
    await expect(codexRunning).toBeVisible();await expect(picker).toContainText("Codex Fixture");await expect(row(claudeThread)).not.toHaveClass(/active/);
    await shootModes(page,"harness-thread-open-waits-for-codex-turn",{widths:[1280,700],check:()=>expect(alert).toBeInViewport()});
    // Once the Codex turn has ended, the thread opens, on Claude Code, from the keyboard.
    releases.shift()();await expect(codexRunning).toHaveCount(0,{timeout:15_000});
    switched=agentRuntimePost(page);await row(claudeThread).locator(".thread-main").focus();await page.keyboard.press("Enter");await switched;
    await expect(picker).toContainText("Claude Fixture Sonnet",{timeout:15_000});expect(server.runtime).toBe("claude");expect(server.counts.select).toBe(selects+1);
    await expect(row(claudeThread)).toHaveClass(/active/);await expect(page.getByText("Fixture reply from claude",{exact:true})).toBeVisible({timeout:15_000});
    // The other way: a Claude Code turn left running for a new task holds the Codex thread back the same way.
    await newTask.click();releases.push(holdNext());
    await composer.click();await page.keyboard.type("Run a long Claude task",{delay:5});await page.keyboard.press("Enter");
    await expect(stop).toBeVisible({timeout:15_000});
    const claudeRunning=row(relay.calls("turn/start")[2].params.threadId).getByRole("img",{name:"Running"});
    await newTask.click();await expect(stop).toHaveCount(0);await expect(claudeRunning).toBeVisible();
    selects=server.counts.select;
    await row(codexThread).locator(".thread-main").click();
    await expect(alert,"opening the Codex thread says the Claude Code turn runs").toHaveText(said("Claude Code"));
    expect(server.counts.select,"nothing switched").toBe(selects);await expect(claudeRunning).toBeVisible();await expect(picker).toContainText("Claude Fixture Sonnet");
    releases.shift()();await expect(claudeRunning).toHaveCount(0,{timeout:15_000});
    switched=agentRuntimePost(page);await row(codexThread).locator(".thread-main").click();await switched;
    await expect(picker).toContainText("Codex Fixture",{timeout:15_000});expect(server.runtime).toBe("codex");
    await expect(page.getByText("Fixture reply from codex",{exact:true})).toBeVisible({timeout:15_000});
    expect(server.counts.direct).toBe(0);
  }finally{for(const release of releases)release();await close()}
});

// Another profile of the harness that runs takes the view to a new task, as a switch does, and the turn runs on in the profile it
// started in: Use asks first while the open thread's turn runs, as Switch does. It switched at once.
test("Use on another Claude Code profile while the open thread's turn runs asks first, and Cancel keeps the profile",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  let release=()=>{};const held=new Promise(resolve=>{release=resolve});
  const {server,relay,close}=await startHarness(page,{runtime:"claude",profiles:[{id:"claude-work",kind:"claude",displayName:"Claude work"}],holdTurns:held});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),dialog=page.getByRole("dialog");
    await expect(page.getByTestId("model-picker")).toContainText("Claude Fixture Sonnet");
    await composer.click();await page.keyboard.type("Run a long Claude task",{delay:5});await page.keyboard.press("Enter");
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeVisible({timeout:15_000});
    await openHarnessSettings(page);
    const use=page.locator(".runtime-profile-row").filter({hasText:"Claude work"}).locator("button").first();
    await expect(use.locator("em")).toHaveText("Use",{timeout:10_000});await use.click();
    await expect(dialog,"a question before the profile switch").toContainText("Switch to Claude work while Claude Code is running “Runtime switch fixture”? The task keeps running in Claude Code, and its thread stays in the sidebar.");
    await expect(dialog.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
    for(const width of [1280,700]){await page.setViewportSize({width,height:800});await expect(dialog.getByRole("button",{name:"Switch to Claude work",exact:true})).toBeInViewport();await page.screenshot({animations:"disabled",path:`${auditDir}harness-profile-while-running-asks-${width}x800.png`})}
    await page.setViewportSize({width:1280,height:800});
    await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(use).toBeFocused();expect(server.counts.select,"Cancel switches nothing").toBe(0);
    // Asked again from the keyboard, Switch to Claude work goes through with that profile.
    const switched=agentRuntimePost(page);
    await page.keyboard.press("Enter");await expect(dialog).toBeVisible();
    await page.keyboard.press("Tab");await expect(dialog.getByRole("button",{name:"Switch to Claude work",exact:true})).toBeFocused();await page.keyboard.press("Enter");
    await switched;expect(server.selects.map(body=>[body.runtime,body.instanceId])).toEqual([["claude","claude-work"]]);
  }finally{release();await close()}
});

// A refusal that comes while Settings, opened again, shows the harness rows is said on the row that was clicked there, once. Settings
// left and opened again before the answer came showed it nowhere on the row, and the app's alert said it over Settings. With Settings
// on another of its sections as it comes, no harness row is on screen, so the alert says it, and the row does once shown.
test("a refused switch answered after Settings was opened again is said on its row there, not in the app's alert",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  let answer=null,refuse=()=>{};const arm=()=>{answer=new Promise(resolve=>{refuse=resolve})};arm();
  const {server,relay,close}=await startHarness(page,{runtime:"claude",rejectSelect:"OpenCode could not start: fixture launcher failed",holdSelect:()=>answer});
  await keepAppearance(page,server);
  try{
    await openGeneralChat(page,relay);
    const alert=page.getByTestId("app-action-error"),text="Could not switch to OpenCode: OpenCode could not start: fixture launcher failed";
    const row=page.locator(".agent-runtime-option").filter({hasText:"OpenCode"}),refusal=row.getByRole("alert");
    await expect(page.getByTestId("model-picker")).toContainText("Claude Fixture Sonnet");
    let rejected=agentRuntimePost(page);
    await selectHarness(page,"OpenCode");await expect.poll(()=>server.counts.select).toBe(1);
    // Back to the chat, and Settings again, before the answer comes.
    await page.getByRole("button",{name:"Threads",exact:true}).click();await expect(row).toHaveCount(0);
    await openHarnessSettings(page);await expect(row).toBeVisible();await expect(refusal).toHaveCount(0);
    refuse();expect((await rejected).status()).toBe(400);
    await expect(refusal,"the OpenCode row on screen says why").toHaveText(text);await expect(refusal).toBeInViewport();
    await expect(row.locator("button em")).toHaveText("Switch");
    await page.waitForTimeout(500);await expect(alert,"said once, on its row: the app's alert does not repeat it over Settings").toHaveCount(0);
    await shootModes(page,"harness-switch-refused-after-reopen",{widths:[1280,900],check:()=>expect(refusal).toBeInViewport()});
    // Asked again, and Settings left for its General section before the answer: the alert says it, and the row once shown again.
    arm();rejected=agentRuntimePost(page);await row.locator("button").first().click();await expect.poll(()=>server.counts.select).toBe(2);
    await page.getByRole("navigation",{name:"Settings categories"}).getByRole("button",{name:/General/}).click();await expect(row).toHaveCount(0);
    refuse();expect((await rejected).status()).toBe(400);
    await expect(alert,"with no harness row on screen, the app's alert says why").toHaveText(text);
    await page.getByRole("navigation",{name:"Settings categories"}).getByRole("button",{name:/Agents & models/}).click();await expect(refusal).toHaveText(text);
  }finally{refuse();await close()}
});

// A refusal kept for a harness ends once a switch to that harness has gone through, also one the app made by opening one of its
// threads: Settings said "Could not switch to OpenCode" on its row at every visit after OpenCode had since worked.
test("a kept switch refusal ends once a switch to its harness goes through, also by opening one of its threads",async({page})=>{
  test.setTimeout(120_000);
  await page.setViewportSize({width:1280,height:800});
  const {server,relay,close}=await startHarness(page,{runtime:"claude"});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),picker=page.getByTestId("model-picker"),row=page.locator(".agent-runtime-option").filter({hasText:"OpenCode"}),threads=page.getByRole("button",{name:"Threads",exact:true});
    // A Claude Code thread, then an OpenCode one.
    await expect(picker).toContainText("Claude Fixture Sonnet");
    await composer.fill("A Claude Code task");await composer.press("Enter");
    await expect(page.getByText("Fixture reply from claude",{exact:true})).toBeVisible({timeout:15_000});
    const claudeThread=relay.calls("turn/start")[0].params.threadId;
    let switched=agentRuntimePost(page);await selectHarness(page,"OpenCode");await switched;
    await threads.click();await expect(picker).toContainText("OpenCode Fixture Fast",{timeout:15_000});
    await composer.fill("An OpenCode task");await composer.press("Enter");
    await expect(page.getByText("Fixture reply from opencode",{exact:true})).toBeVisible({timeout:15_000});
    const opencodeThread=relay.calls("turn/start")[1].params.threadId;
    switched=agentRuntimePost(page);await selectHarness(page,"Claude Code");await switched;
    // OpenCode is refused: its row says why.
    server.rejectSelect="OpenCode is installed but not authenticated";
    const rejected=agentRuntimePost(page);await selectHarness(page,"OpenCode");expect((await rejected).status()).toBe(400);
    await expect(row.getByRole("alert")).toHaveText("Could not switch to OpenCode: OpenCode is installed but not authenticated");
    // Signed in, the person opens the OpenCode thread, which switches to OpenCode, then the Claude Code one, which switches back.
    server.rejectSelect="";
    await threads.click();
    await page.locator(`.thread-row[data-thread-id="${opencodeThread}"] .thread-main`).click();
    await expect(picker).toContainText("OpenCode Fixture",{timeout:15_000});expect(server.runtime).toBe("opencode");
    await expect(page.getByText("Fixture reply from opencode",{exact:true})).toBeVisible({timeout:15_000});
    await page.locator(`.thread-row[data-thread-id="${claudeThread}"] .thread-main`).click();
    await expect(picker).toContainText("Claude Fixture Sonnet",{timeout:15_000});expect(server.runtime).toBe("claude");
    await expect(page.getByText("Fixture reply from claude",{exact:true})).toBeVisible({timeout:15_000});
    // Settings no longer says OpenCode could not be switched to.
    await openHarnessSettings(page);
    await expect(row.locator("button em")).toHaveText("Switch");await expect(row.getByRole("alert"),"the refusal OpenCode has since outlived").toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"harness-switch-refusal-ended-1280x800.png"});
  }finally{await close()}
});

// A refused Save profile says why in the profile editor, under its buttons: it went to the status line under the editor, which was
// below the fold at 1280x800 once Save profile was scrolled into view, so nothing on screen changed and the editor just stayed open.
test("a refused Save profile says why in the profile editor, in view, once",async({page})=>{
  test.setTimeout(90_000);
  const {close}=await startHarness(page,{runtime:"claude",profileEditing:true});
  await keepModeSaves(page);
  const reason="Claude auto-compact threshold must be an integer between 100000 and 1000000 tokens";
  try{
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    const editor=page.locator(".runtime-profile-editor"),refusal=editor.getByRole("alert");
    const autoCompact=editor.getByRole("spinbutton",{name:"Auto-compact after"}),save=editor.getByRole("button",{name:"Save profile",exact:true});
    for(const pass of ["dark","light"])for(const width of [1280,900]){
      await switchMode(page,pass);await page.setViewportSize({width,height:800});
      await page.getByRole("button",{name:"Threads",exact:true}).click();await openHarnessSettings(page);
      // The active profile is edited at 1280 and a new one is added at 900; either is refused the same way. Each control is
      // scrolled to just before it is used, so Save profile ends near the bottom of the window.
      const adding=width===900,opener=adding?page.getByRole("button",{name:"Add profile",exact:true}):page.locator(".runtime-profile-row").filter({hasText:"Claude Code"}).getByRole("button",{name:"Edit",exact:true});
      await wheelIntoView(page,opener);await opener.click();
      await wheelIntoView(page,autoCompact);await autoCompact.click();await page.keyboard.type("50000",{delay:15});
      await wheelIntoView(page,save);
      const rejected=agentRuntimePost(page);
      await save.click();
      expect((await rejected).status()).toBe(400);
      await expect(refusal).toHaveText(`Could not save the runtime profile “${adding?"Claude Code profile":"Claude Code"}”: ${reason}`);
      await expect(refusal).toBeInViewport({ratio:1});await expect(save).toBeInViewport({ratio:1});
      await expect(editor).toBeVisible();await expect(autoCompact).toHaveValue("50000");
      // Said once: the status line under the editor does not repeat it.
      await expect(page.getByTestId("agent-runtime-message")).toHaveCount(0);
      await page.screenshot({animations:"disabled",path:`${auditDir}harness-profile-refused-in-editor-${pass}-${width}x800.png`});
      // Cancel closes the editor, and the next one opens without the refusal.
      await editor.getByRole("button",{name:"Cancel",exact:true}).click();await expect(editor).toHaveCount(0);
      await page.getByRole("button",{name:"Add profile",exact:true}).click();await expect(editor).toBeVisible();await expect(refusal).toHaveCount(0);
      await editor.getByRole("button",{name:"Cancel",exact:true}).click();
    }
    // A value inside the range saves: the editor closes and the status line says so.
    await page.getByRole("button",{name:"Add profile",exact:true}).click();
    await autoCompact.click();await page.keyboard.type("50000",{delay:15});await save.click();await expect(refusal).toBeVisible();
    await autoCompact.fill("250000");
    const accepted=agentRuntimePost(page);
    await save.click();
    expect((await accepted).status()).toBe(200);
    await expect(editor).toHaveCount(0);
    await expect(page.getByTestId("agent-runtime-message")).toHaveText("· Runtime profile saved.");
  }finally{await close()}
});

// Names typed into Approved inherited environment variables stay as they are typed: the list was made again from the box at each
// key and shown one name per line, so a new line or a comma was gone at once and the next name ran on ("HTTPS_PROXYNO_PROXY").
test("names typed one per line or split by commas into Approved inherited environment variables stay as typed and save as a list",async({page})=>{
  test.setTimeout(60_000);
  const {close}=await startHarness(page,{runtime:"claude",profileEditing:true});
  await keepModeSaves(page);
  try{
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await openHarnessSettings(page);
    const editor=page.locator(".runtime-profile-editor"),keys=editor.getByRole("textbox",{name:"Approved inherited environment variables"});
    const ways=[
      {name:"enter",mode:"dark",typed:"HTTPS_PROXY\nNO_PROXY",async type(){
        await page.keyboard.type("HTTPS_PROXY",{delay:15});await page.keyboard.press("Enter");await expect(keys).toHaveValue("HTTPS_PROXY\n");
        // Another window coming to the front blurs the box but leaves the focus on it: the text stays as typed.
        await keys.dispatchEvent("focusout");await expect(keys).toBeFocused();await expect(keys).toHaveValue("HTTPS_PROXY\n");
        await page.keyboard.type("NO_PROXY",{delay:15});
      }},
      {name:"comma",mode:"dark",typed:"HTTPS_PROXY, NO_PROXY",async type(){await page.keyboard.type("HTTPS_PROXY,",{delay:15});await expect(keys).toHaveValue("HTTPS_PROXY,");await page.keyboard.type(" NO_PROXY",{delay:15})}},
      {name:"shift-enter",mode:"light",typed:"HTTPS_PROXY\nNO_PROXY",async type(){await page.keyboard.type("HTTPS_PROXY",{delay:15});await page.keyboard.press("Shift+Enter");await expect(keys).toHaveValue("HTTPS_PROXY\n");await page.keyboard.type("NO_PROXY",{delay:15})}},
    ];
    for(const way of ways){
      await switchMode(page,way.mode);
      await page.getByRole("button",{name:"Add profile",exact:true}).click();
      await expect(keys).toHaveValue("");
      await keys.click();await way.type();
      await expect(keys,way.name).toHaveValue(way.typed);
      // Left, the box shows the list it saves, one name per line.
      if(way.name==="comma"){await page.keyboard.press("Tab");await expect(editor.getByRole("button",{name:"Save profile",exact:true})).toBeFocused();await expect(keys).toHaveValue("HTTPS_PROXY\nNO_PROXY")}
      await keys.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:`${auditDir}harness-profile-environment-keys-${way.name}-${way.mode}-1280x800.png`});
      const posted=agentRuntimePost(page);
      await editor.getByRole("button",{name:"Save profile",exact:true}).click();
      const response=await posted;expect(response.status()).toBe(200);
      expect(response.request().postDataJSON().instance.approvedEnvironmentKeys,way.name).toEqual(["HTTPS_PROXY","NO_PROXY"]);
      await expect(editor).toHaveCount(0);
    }
  }finally{await close()}
});

// A saved profile's answer is not left under the next profile opened: Add profile, or Edit, after a save opened the new draft with the
// card's "Runtime profile saved." right under its Save profile and Cancel, as if the draft had been saved.
test("a profile opened after a save, by Add profile or by Edit from the keyboard, is not captioned as saved",async({page})=>{
  test.setTimeout(60_000);
  const {server,close}=await startHarness(page,{runtime:"claude",profileEditing:true});
  await keepModeSaves(page);
  const editor=page.locator(".runtime-profile-editor"),message=page.getByTestId("agent-runtime-message");
  const name=editor.getByRole("textbox",{name:"Profile name"}),save=editor.getByRole("button",{name:"Save profile",exact:true}),add=page.getByRole("button",{name:"Add profile",exact:true});
  const typeName=async text=>{await name.click();await page.keyboard.press("Control+A");await page.keyboard.type(text,{delay:10})};
  try{
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await openHarnessSettings(page);
    for(const [mode,opener] of [["dark","Add profile"],["light","Edit"]]){
      await switchMode(page,mode);
      // A profile is saved first.
      await wheelIntoView(page,add);await add.click();
      await typeName("Saved first");
      await wheelIntoView(page,save);
      const saved=agentRuntimePost(page);await save.click();expect((await saved).status()).toBe(200);
      await expect(editor).toHaveCount(0);await expect(message).toHaveText("· Runtime profile saved.");
      // The next one is opened and typed into, and not saved.
      const open=opener==="Add profile"?add:page.locator(".runtime-profile-row").filter({hasText:"Claude Code"}).getByRole("button",{name:"Edit",exact:true});
      await wheelIntoView(page,open);
      if(opener==="Edit")await open.press("Enter");else await open.click();
      await expect(editor).toBeVisible();
      await typeName("Not saved yet");
      await wheelIntoView(page,save);
      await expect(message,`nothing under the profile ${opener} opened says it was saved`).toHaveCount(0);
      await page.screenshot({animations:"disabled",path:`${auditDir}harness-profile-opened-after-save-by-${opener==="Edit"?"edit":"add"}-${mode}-1280x800.png`});
      await editor.getByRole("button",{name:"Cancel",exact:true}).click();await expect(editor).toHaveCount(0);
    }
    expect(server.counts.upsert,"only the two saves went out").toBe(2);
  }finally{await close()}
});

// An update that ends after the person switched to another harness, in Settings or by opening that harness's thread from the sidebar,
// is the update of the harness it was for: the harness switched to keeps its transport and the thread open on it. The install compared
// the harness it updated with the one in use when it began, so it reloaded the harness switched to, which closed its thread.
const harnessRow=(page,name)=>page.locator(".agent-runtime-option").filter({hasText:name});
const installAnswer=page=>page.waitForResponse(response=>/\/api\/agent-runtimes$/.test(new URL(response.url()).pathname)&&response.request().postDataJSON()?.action==="install");
// In Settings: Update on OpenCode, the harness in use, which runs while server.holdInstall holds it.
async function updateOpenCode(page){
  await openHarnessSettings(page);
  await harnessRow(page,"OpenCode").getByRole("button",{name:"Update",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"Update OpenCode",exact:true}).click();
  await expect(harnessRow(page,"OpenCode").getByRole("button",{name:"Installing…",exact:true})).toBeDisabled();
}
// Update on OpenCode, and a switch to Claude Code in Settings while the update runs.
async function updateOpenCodeThenSwitchToClaude(page){
  await updateOpenCode(page);
  await harnessRow(page,"Claude Code").locator("button").first().click();
  await expect(page.getByTestId("agent-runtime-message")).toHaveText("· Claude Code selected.");
}
async function ask(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:8});await page.keyboard.press("Enter")}
// A request the fixture holds until open().
const gate=()=>{let open=()=>{};const held=new Promise(resolve=>{open=resolve});return {held,open}};
// Settings is left for Projects, so it closes showing the harness in use then.
async function leaveSettings(page){await page.getByRole("button",{name:"Projects",exact:true}).click();await expect(page.getByRole("heading",{name:"Agent harness"})).toHaveCount(0)}
const savedThreadMeta=thread=>({[thread.id]:{projectless:true,environmentId:null,runtime:thread.runtime,runtimeInstanceId:thread.runtime+"-default",threadSnapshot:{...thread,provider:thread.runtime}}});
// A saved thread opened from the sidebar switches to its harness on its own.
async function openSavedThread(page,thread){await page.locator(`.thread-row[data-thread-id="${thread.id}"] .thread-main`).click()}
async function expectThreadOn(page,harness,model){
  await expect(page.locator(".sidebar-provider strong")).toContainText(harness);
  await expect(page.getByTestId("model-picker")).toContainText(model);
}
const SAVED_CLAUDE_THREAD={id:"claude-saved-thread",name:"Saved Claude Code task",preview:"Saved Claude Code task",cwd:process.cwd(),model:"sonnet",runtime:"claude",status:{type:"idle"},createdAt:Date.now()/1000-100,updatedAt:Date.now()/1000-50,turns:[]};
const SAVED_OPENCODE_THREAD={id:"opencode-saved-thread",name:"Saved OpenCode task",preview:"Saved OpenCode task",cwd:process.cwd(),model:"opencode/fixture-fast",runtime:"opencode",status:{type:"idle"},createdAt:Date.now()/1000-90,updatedAt:Date.now()/1000-40,turns:[]};
// install, answer and select hold the update, its answer once its harness list is taken, and the switch's selection (gates).
const SWITCHES_DURING_UPDATE=[
  // The switch in Settings, then a new thread in General chat.
  {id:"settings-switch",name:"a switch to Claude Code in Settings",started:1,async switch(page){
    await updateOpenCodeThenSwitchToClaude(page);
    await page.getByRole("button",{name:"Projects",exact:true}).click();await page.locator(".general-chat-card").click();
  }},
  // A saved Claude Code thread opened from the sidebar, with Settings still open.
  {id:"sidebar-thread",name:"opening a Claude Code thread from the sidebar",started:0,threadMeta:savedThreadMeta(SAVED_CLAUDE_THREAD),async switch(page){
    await updateOpenCode(page);
    await openSavedThread(page,SAVED_CLAUDE_THREAD);await expectThreadOn(page,"Claude Code","Claude Fixture Sonnet");
  }},
  // The same once Settings is left: it last showed OpenCode in use, and the update's answer names Claude Code.
  {id:"sidebar-thread-settings-left",name:"leaving Settings and opening a Claude Code thread from the sidebar",started:0,threadMeta:savedThreadMeta(SAVED_CLAUDE_THREAD),async switch(page){
    await updateOpenCode(page);await leaveSettings(page);
    await openSavedThread(page,SAVED_CLAUDE_THREAD);await expectThreadOn(page,"Claude Code","Claude Fixture Sonnet");
  }},
  // The same, with the update's harness list taken before the switch (gui-server was still reading OpenCode's catalog for it), so
  // its answer and the closed Settings both still say OpenCode.
  {id:"sidebar-thread-list-before-switch",name:"leaving Settings and opening a Claude Code thread from the sidebar, with the update's harness list taken before",started:0,threadMeta:savedThreadMeta(SAVED_CLAUDE_THREAD),holdAnswer:true,async switch(page,{server,install}){
    await updateOpenCode(page);
    install.open();await expect.poll(()=>server.versions.opencode).toBe("1.1.0-updated");
    await leaveSettings(page);
    await openSavedThread(page,SAVED_CLAUDE_THREAD);await expectThreadOn(page,"Claude Code","Claude Fixture Sonnet");
  }},
  // With Settings open, the update answers while the switch the sidebar thread started waits for the server: Settings and the
  // answer both still say OpenCode.
  {id:"sidebar-thread-answer-during-switch",name:"opening a Claude Code thread from the sidebar, answered while that switch is on its way",started:0,threadMeta:savedThreadMeta(SAVED_CLAUDE_THREAD),answered:true,async switch(page,{server,install,select}){
    await updateOpenCode(page);
    server.holdSelect=select.held;
    await openSavedThread(page,SAVED_CLAUDE_THREAD);await expect.poll(()=>server.counts.select).toBe(1);
    const installed=installAnswer(page);install.open();await installed;
    select.open();await expectThreadOn(page,"Claude Code","Claude Fixture Sonnet");
  }},
];
for(const way of SWITCHES_DURING_UPDATE){
  test(`an update that ends after ${way.name} leaves the thread open on Claude Code, and its transport, alone`,async({page})=>{
    test.setTimeout(90_000);
    const {server,relay,close}=await startHarness(page,{runtime:"opencode",installs:true,threadMeta:way.threadMeta||{}});
    const install=gate(),answer=gate(),select=gate();server.holdInstall=install.held;if(way.holdAnswer)server.holdInstallAnswer=answer.held;
    const replies=page.locator(".assistant-message-text"),asked=["What changes once OpenCode is updated?","And what stays the same?"];
    try{
      await page.setViewportSize({width:1280,height:800});
      await openGeneralChat(page,relay);
      await way.switch(page,{server,install,select});
      // A thread on Claude Code, with its answer, open when the OpenCode update ends.
      await ask(page,asked[0]);
      await expect(replies).toHaveText(["Fixture reply from claude"],{timeout:15_000});
      const sockets=relay.connections(),bootstraps=server.counts.bootstrap;
      if(!way.answered){const installed=installAnswer(page);install.open();answer.open();await installed}
      // The thread is still open with its answer and goes on there, on the same transport.
      await ask(page,asked[1]);
      await expect(replies).toHaveText(["Fixture reply from claude","Fixture reply from claude"],{timeout:15_000});
      await expect(page.locator(".user-bubble p")).toHaveText(asked);
      const [first,next]=relay.calls("turn/start");
      expect(next.params.threadId).toBe(first.params.threadId);expect(relay.calls("thread/start")).toHaveLength(way.started);
      expect([first.connection,next.connection]).toEqual([sockets,sockets]);
      expect(relay.connections(),"the update opened no new socket").toBe(sockets);expect(server.counts.bootstrap).toBe(bootstraps);
      await keepModeSaves(page);
      for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:`${auditDir}harness-update-after-${way.id}-thread-stays-${mode}-1280x800.png`})}
      // Settings has OpenCode updated and Claude Code still in use.
      await openHarnessSettings(page);
      await expect(harnessRow(page,"Claude Code").getByText("Active",{exact:true})).toBeVisible();
      await expect(harnessRow(page,"OpenCode")).toContainText("1.1.0-updated");
      await expect(harnessRow(page,"OpenCode").getByRole("button",{name:"Update",exact:true})).toBeEnabled();
      expect(server.runtime).toBe("claude");expect(server.counts.install).toBe(1);
    }finally{install.open();answer.open();select.open();await close()}
  });
}

// An update ends with its harness still in use once the switches around it have settled, and reloads it: a switch to Claude Code on
// its way when the update answers is refused, or a switch back to OpenCode comes from opening its thread after Settings was left. The
// install compared the harness it updated with the one Settings showed when the answer came (that switch, or the last one before
// Settings closed), so OpenCode stayed on the transport from before its update, never reloaded.
const RELOADS_AFTER_SWITCHES=[
  {id:"refused-switch",name:"a switch to Claude Code on its way when the update answers is refused",options:{rejectSelect:"Claude Code could not start: fixture launcher failed"},async switch(page,{server,relay,install,select}){
    await updateOpenCode(page);
    server.holdSelect=select.held;
    await harnessRow(page,"Claude Code").locator("button").first().click();
    await expect(page.getByTestId("agent-runtime-message")).toHaveText("· Switching…");await expect.poll(()=>server.counts.select).toBe(1);
    const sockets=relay.connections(),installed=installAnswer(page);install.open();await installed;
    await expect(harnessRow(page,"OpenCode").getByRole("status")).toHaveText("OpenCode installed and ready.");await expect(page.getByTestId("agent-runtime-message")).toHaveText("· Switching…");
    select.open();
    await expect(harnessRow(page,"Claude Code").getByRole("alert")).toHaveText("Could not switch to Claude Code: Claude Code could not start: fixture launcher failed");
    return sockets;
  }},
  {id:"switch-back-from-sidebar",name:"Settings is left after a switch to Claude Code and opening an OpenCode thread from the sidebar switches back",options:{threadMeta:savedThreadMeta(SAVED_OPENCODE_THREAD)},async switch(page,{relay,install}){
    await updateOpenCodeThenSwitchToClaude(page);await leaveSettings(page);
    await openSavedThread(page,SAVED_OPENCODE_THREAD);await expectThreadOn(page,"OpenCode","OpenCode Fixture Fast");
    const sockets=relay.connections(),installed=installAnswer(page);install.open();await installed;
    return sockets;
  }},
];
// OpenCode once updated lists one model more, which its catalog shows once it has reloaded.
const UPDATED_OPENCODE_CATALOG={...CATALOGS.opencode,models:[...CATALOGS.opencode.models,"opencode/fixture-updated"],metadata:{models:[...CATALOGS.opencode.metadata.models,{id:"opencode/fixture-updated",name:"OpenCode Fixture Updated",agent:"opencode"}]}};
for(const way of RELOADS_AFTER_SWITCHES){
  test(`an update reloads OpenCode, still in use, when ${way.name}`,async({page})=>{
    test.setTimeout(90_000);
    let harness=null;
    const catalogs={...CATALOGS,get opencode(){return harness?.server.versions.opencode?UPDATED_OPENCODE_CATALOG:CATALOGS.opencode}};
    harness=await startHarness(page,{runtime:"opencode",installs:true,catalogs,...way.options});
    const {server,relay,close}=harness,install=gate(),select=gate();server.holdInstall=install.held;
    try{
      await page.setViewportSize({width:1280,height:800});
      await openGeneralChat(page,relay);
      const sockets=await way.switch(page,{server,relay,install,select});
      // OpenCode reloads once, on a socket of its own and with the updated catalog, and a question asked next reaches it there.
      await expect.poll(()=>relay.openConnections(),{timeout:10_000}).toEqual([sockets+1]);
      await page.getByRole("button",{name:"Projects",exact:true}).click();await page.locator(".general-chat-card").click();
      const picker=page.getByTestId("model-picker");
      await expect(picker).toContainText("OpenCode Fixture Fast");
      await picker.click();await expect(page.locator(".model-picker-menu")).toContainText("OpenCode Fixture Updated");
      await page.keyboard.press("Escape");await expect(page.locator(".model-picker-menu")).toHaveCount(0);
      await ask(page,"Does OpenCode answer after its update?");
      await expect(page.locator(".assistant-message-text")).toHaveText(["Fixture reply from opencode"],{timeout:15_000});
      expect(relay.calls("turn/start").map(call=>[call.runtime,call.connection])).toEqual([["opencode",sockets+1]]);
      expect(relay.connections()).toBe(sockets+1);
      await keepModeSaves(page,server);
      for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:`${auditDir}harness-update-reloads-after-${way.id}-${mode}-1280x800.png`})}
      await openHarnessSettings(page);
      await expect(harnessRow(page,"OpenCode").getByText("Active",{exact:true})).toBeVisible();
      await expect(harnessRow(page,"OpenCode")).toContainText("1.1.0-updated");
      expect(server.runtime).toBe("opencode");expect(server.counts.install).toBe(1);
    }finally{install.open();select.open();await close()}
  });
}

// Settings left open through the update says how it went for the harness it updated, a failure too, and Claude Code, switched to
// meanwhile, stays in use on its transport.
test("an update that ends after a switch, with Settings still open, is said for the harness it updated and leaves the other harness running",async({page})=>{
  test.setTimeout(90_000);
  const {server,relay,close}=await startHarness(page,{runtime:"opencode",installs:true});
  let releaseInstall=()=>{};server.holdInstall=new Promise(resolve=>{releaseInstall=resolve});
  const message=page.getByTestId("agent-runtime-message"),claude=harnessRow(page,"Claude Code"),opencode=harnessRow(page,"OpenCode");
  try{
    await page.setViewportSize({width:1280,height:800});
    await openGeneralChat(page,relay);
    const loaded=relay.connections();
    await updateOpenCodeThenSwitchToClaude(page);
    // The switch's own socket is the one open when the update ends.
    const sockets=loaded+1,bootstraps=server.counts.bootstrap;await expect.poll(()=>relay.openConnections()).toEqual([sockets]);
    let installed=installAnswer(page);
    releaseInstall();await installed;
    await expect(opencode.getByRole("status")).toHaveText("OpenCode installed and ready.");await expect(message).toHaveText("· Claude Code selected.");
    await expect(claude.getByText("Active",{exact:true})).toBeVisible();await expect(opencode).toContainText("1.1.0-updated");
    await page.screenshot({animations:"disabled",path:auditDir+"harness-update-after-switch-said-in-settings-1280x800.png"});
    // A question asked next reaches Claude Code on that socket.
    await page.getByRole("button",{name:"Projects",exact:true}).click();await page.locator(".general-chat-card").click();
    await ask(page,"Is Claude Code still answering?");
    await expect(page.locator(".assistant-message-text")).toHaveText(["Fixture reply from claude"],{timeout:15_000});
    expect(relay.calls("turn/start").map(call=>[call.runtime,call.connection])).toEqual([["claude",sockets]]);
    expect(relay.connections(),"the update opened no new socket").toBe(sockets);expect(server.counts.bootstrap).toBe(bootstraps);
    // An update that fails after a switch says so on the OpenCode row, not on Claude Code's line as if Claude Code had failed.
    await openHarnessSettings(page);
    await opencode.locator("button").first().click();await expect(message).toHaveText("· OpenCode selected.");
    await expect.poll(()=>relay.openConnections()).toEqual([sockets+1]);
    server.holdInstall=new Promise(resolve=>{releaseInstall=resolve});server.failInstall="Could not install opencode-ai";
    await updateOpenCodeThenSwitchToClaude(page);
    const switched=sockets+2;await expect.poll(()=>relay.openConnections()).toEqual([switched]);
    installed=installAnswer(page);
    releaseInstall();await installed;
    await expect(opencode.getByRole("alert")).toHaveText("Could not update OpenCode: Could not install opencode-ai");
    await expect(message).toHaveText("· Claude Code selected.");
    await expect(claude.getByText("Active",{exact:true})).toBeVisible();await expect(opencode.getByRole("button",{name:"Update",exact:true})).toBeEnabled();
    await keepModeSaves(page);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:`${auditDir}harness-update-failed-after-switch-${mode}-1280x800.png`})}
    expect(relay.connections()).toBe(switched);expect(server.runtime).toBe("claude");expect(server.counts.install).toBe(2);
  }finally{releaseInstall();await close()}
});

// An update whose answer comes once a switch has landed, or while one is on its way, leaves the harness switched to in use: that
// answer has the harness list from before the switch, and the install reloaded the harness it updated over the one switched to.
test("an update whose answer comes after or during a switch made with the keyboard leaves the harness switched to in use",async({page})=>{
  test.setTimeout(90_000);
  const {server,relay,close}=await startHarness(page,{runtime:"opencode",installs:true});
  let install=gate(),answer=gate(),select=gate();server.holdInstall=install.held;server.holdInstallAnswer=answer.held;
  const message=page.getByTestId("agent-runtime-message"),claude=harnessRow(page,"Claude Code"),opencode=harnessRow(page,"OpenCode");
  try{
    await page.setViewportSize({width:1280,height:800});
    await openGeneralChat(page,relay);
    // The update ends with OpenCode in use, and its answer is still on its way when Enter on Claude Code's row switches.
    await updateOpenCode(page);
    install.open();await expect.poll(()=>server.versions.opencode).toBe("1.1.0-updated");
    await claude.locator("button").first().press("Enter");
    await expect(message).toHaveText("· Claude Code selected.");
    let installed=installAnswer(page);answer.open();await installed;
    await expect(opencode.getByRole("status")).toHaveText("OpenCode installed and ready.");
    await expect(claude.getByText("Active",{exact:true})).toBeVisible();
    await expect(message).toHaveText("· Claude Code selected.");
    await expect(opencode).toContainText("1.1.0-updated");await expect(opencode.getByRole("button",{name:"Update",exact:true})).toBeEnabled();
    // Back on OpenCode, the next update's answer comes while the switch to Claude Code waits for the server.
    await opencode.locator("button").first().click();await expect(message).toHaveText("· OpenCode selected.");
    install=gate();server.holdInstall=install.held;server.holdInstallAnswer=null;
    await updateOpenCode(page);
    select=gate();server.holdSelect=select.held;
    await claude.locator("button").first().press("Enter");
    await expect(message).toHaveText("· Switching…");await expect.poll(()=>server.counts.select).toBe(3);
    installed=installAnswer(page);install.open();await installed;
    await expect(opencode.getByRole("status")).toHaveText("OpenCode installed and ready.");await expect(message).toHaveText("· Switching…");
    const selected=agentRuntimePost(page);select.open();await selected;
    await expect(message).toHaveText("· Claude Code selected.");
    await expect(claude.getByText("Active",{exact:true})).toBeVisible();
    await keepModeSaves(page);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:`${auditDir}harness-update-during-switch-${mode}-1280x800.png`})}
    // The chat runs Claude Code, with its own models, on the last switch's socket.
    await page.getByRole("button",{name:"Projects",exact:true}).click();await page.locator(".general-chat-card").click();
    await expect(page.getByTestId("model-picker")).toContainText("Claude Fixture Sonnet");
    await ask(page,"Which harness answers now?");
    await expect(page.locator(".assistant-message-text")).toHaveText(["Fixture reply from claude"],{timeout:15_000});
    expectCatalogModels(relay);
    expect(relay.calls("turn/start").map(call=>call.connection)).toEqual([relay.connections()]);
    expect(server.runtime).toBe("claude");expect(server.counts.install).toBe(2);
  }finally{install.open();answer.open();select.open();await close()}
});

// The harness rows lane G's update checks ran on, OpenCode's last, with Claude Code's profiles under them: at 1280x800 the OpenCode
// row ends at about 656 px, and the card's status line, under the profiles, is below the fold.
const UPDATE_HARNESSES=[["native","Trebell Native","native"],["codex","Codex","codex"],["claude","Claude Code","claude"],["opencode","OpenCode","http"]];
const UPDATE_REFUSED="npm ERR! code E404 opencode-ai@latest is not in the npm registry";
// Update on OpenCode's row, scrolled to with the wheel as a person does, and Update OpenCode in the question: it runs while held.
async function pressUpdateOpenCode(page){
  const row=harnessRow(page,"OpenCode");
  await wheelIntoView(page,row);
  await row.getByRole("button",{name:"Update",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"Update OpenCode",exact:true}).click();
  await expect(row.getByRole("button",{name:"Installing…",exact:true})).toBeDisabled();
}

// An update still on its way when Settings is opened again says so on its row there, with the button held, and starts no second
// install: the install was the Settings page's own, so the page opened again offered Update at once, and a press on it installed
// OpenCode a second time alongside the first.
test("Settings opened again while an update runs says Installing… on its row with its button held, and starts no second install",async({page})=>{
  test.setTimeout(90_000);
  const {server,close}=await startHarness(page,{runtime:"claude",installs:true,profileEditing:true,harnesses:UPDATE_HARNESSES});
  await keepModeSaves(page);
  const install=gate();server.holdInstall=install.held;
  const opencode=harnessRow(page,"OpenCode"),installing=opencode.getByRole("button",{name:"Installing…",exact:true}),update=opencode.getByRole("button",{name:"Update",exact:true});
  try{
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    await openHarnessSettings(page);await pressUpdateOpenCode(page);
    // Off to Projects, and back by the sidebar, then by Ctrl+,.
    for(const back of ["the sidebar","Ctrl+,"]){
      await leaveSettings(page);
      if(back==="Ctrl+,"){await page.keyboard.press("Control+Comma");await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible()}
      else await openHarnessSettings(page);
      await expect.soft(installing,`Settings opened again by ${back} says OpenCode's update is on its way`).toBeDisabled();
      // Where Update is offered, a press on it installs OpenCode no second time.
      if(await update.count()){await update.click();await page.getByRole("dialog").getByRole("button",{name:"Update OpenCode",exact:true}).click()}
      await page.waitForTimeout(500);
      expect(server.counts.install,"one install of OpenCode at a time").toBe(1);
    }
    await shootModes(page,"harness-update-running-after-reopen",{widths:[1280,900],check:()=>installing.scrollIntoViewIfNeeded()});
    // The update ends: the row on screen says so, with the new version, and offers Update again.
    const installed=installAnswer(page);install.open();await installed;
    await expect(opencode.getByRole("status")).toHaveText("OpenCode installed and ready.");
    await expect(opencode).toContainText("1.1.0-updated");await expect(update).toBeEnabled();
    expect(server.counts.install).toBe(1);
  }finally{install.open();await close()}
});

// An update that ends once Settings was left is not lost: a failure is said in the app's alert, and Settings opened again says how it
// went on the OpenCode row, with the new version once it worked. Its answer went only to the Settings page that started it, which was
// gone: the card opened again said nothing of it, and a failure was said nowhere.
test("an update that ends after Settings was left says a failure in the app's alert, and Settings opened again says how it went",async({page})=>{
  test.setTimeout(120_000);
  const {server,relay,close}=await startHarness(page,{runtime:"claude",installs:true,profileEditing:true,harnesses:UPDATE_HARNESSES});
  await keepModeSaves(page);
  const opencode=harnessRow(page,"OpenCode"),alert=page.getByTestId("app-action-error"),failure="Could not update OpenCode: "+UPDATE_REFUSED;
  const toChat=async()=>{await page.getByRole("button",{name:"Projects",exact:true}).click();await page.locator(".general-chat-card").click();await expect(page.getByTestId("composer")).toBeVisible()};
  let install=gate();
  try{
    await page.setViewportSize({width:1280,height:800});
    await openGeneralChat(page,relay);
    // It works while the person asks Claude Code something in the chat.
    server.holdInstall=install.held;
    await openHarnessSettings(page);await pressUpdateOpenCode(page);
    await toChat();await ask(page,"What does Claude Code say meanwhile?");
    await expect(page.locator(".assistant-message-text")).toHaveText(["Fixture reply from claude"],{timeout:15_000});
    let installed=installAnswer(page);install.open();await installed;
    await page.waitForTimeout(500);await expect(alert,"an update that worked is not said as a failure").toHaveCount(0);
    await openHarnessSettings(page);
    await expect(opencode).toContainText("1.1.0-updated");
    await expect.soft(opencode.getByRole("status"),"Settings opened again says the update went").toHaveText("OpenCode installed and ready.");
    // It fails while the person is in the chat: the chat says so, and Settings opened again says it on the OpenCode row.
    install=gate();server.holdInstall=install.held;server.failInstall=UPDATE_REFUSED;
    await pressUpdateOpenCode(page);await toChat();
    installed=installAnswer(page);install.open();await installed;
    await expect.soft(alert,"the chat says the update failed").toHaveText(failure);
    if(await alert.count())for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:`${auditDir}harness-update-failed-said-in-chat-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    await openHarnessSettings(page);
    await expect(opencode.getByRole("alert"),"Settings opened again says why").toHaveText(failure);
    await expect(opencode.getByRole("button",{name:"Update",exact:true})).toBeEnabled();
    await shootModes(page,"harness-update-failed-said-after-reopen",{widths:[1280,900],check:()=>opencode.scrollIntoViewIfNeeded()});
    // It fails while Settings, opened again during it, is on screen: said on the row there, not in the app's alert as well.
    await expect(alert).toHaveCount(0,{timeout:10_000});
    install=gate();server.holdInstall=install.held;server.failInstall=UPDATE_REFUSED;
    await pressUpdateOpenCode(page);await expect(opencode.getByRole("alert")).toHaveCount(0);
    await leaveSettings(page);await openHarnessSettings(page);
    installed=installAnswer(page);install.open();await installed;
    await expect(opencode.getByRole("alert")).toHaveText(failure);await expect(opencode.getByRole("alert")).toBeInViewport();
    await page.waitForTimeout(500);await expect(alert,"said once, on its row").toHaveCount(0);
    expect(server.counts.install).toBe(3);
  }finally{install.open();await close()}
});

// With Settings open, an update's answer is said on the row whose Update was pressed, in view, once: it went to the card's status
// line, under the profiles and below the fold at 1280x800, so a failed update changed nothing on screen but the row's button.
test("an update's answer is said on the OpenCode row whose Update was pressed, in view, once",async({page})=>{
  test.setTimeout(90_000);
  const {server,close}=await startHarness(page,{runtime:"claude",installs:true,profileEditing:true,harnesses:UPDATE_HARNESSES});
  await keepModeSaves(page);
  const opencode=harnessRow(page,"OpenCode"),message=page.getByTestId("agent-runtime-message"),alert=page.getByTestId("app-action-error");
  let install=gate();
  try{
    await page.goto("/");await expect(page.getByTestId("composer")).toBeVisible();
    // At 1280 with the page as it opens, and at 900 with the row scrolled to with the wheel, so it ends near the bottom of the window.
    for(const [mode,width] of [["dark",1280],["light",900]]){
      await page.setViewportSize({width,height:800});await switchMode(page,mode);
      await page.getByRole("button",{name:"Projects",exact:true}).click();await openHarnessSettings(page);
      install=gate();server.holdInstall=install.held;server.failInstall=UPDATE_REFUSED;
      await pressUpdateOpenCode(page);
      let installed=installAnswer(page);install.open();await installed;
      const refusal=opencode.getByRole("alert");
      await expect(refusal).toHaveText("Could not update OpenCode: "+UPDATE_REFUSED);await expect(refusal).toBeInViewport({ratio:1});
      await expect(opencode.getByRole("button",{name:"Update",exact:true})).toBeEnabled();
      await expect(message,"said once: the status line under the profiles does not repeat it").toHaveCount(0);await expect(alert).toHaveCount(0);
      await page.screenshot({animations:"disabled",path:`${auditDir}harness-update-failed-on-its-row-${mode}-${width}x800.png`});
      // The next one works: said there too, with the new version.
      install=gate();server.holdInstall=install.held;
      await pressUpdateOpenCode(page);await expect(refusal).toHaveCount(0);
      installed=installAnswer(page);install.open();await installed;
      const said=opencode.getByRole("status");
      await expect(said).toHaveText("OpenCode installed and ready.");await expect(said).toBeInViewport({ratio:1});
      await expect(opencode).toContainText("1.1.0-updated");await expect(message).toHaveCount(0);
      await page.screenshot({animations:"disabled",path:`${auditDir}harness-update-said-on-its-row-${mode}-${width}x800.png`});
    }
    expect(server.counts.install).toBe(4);
  }finally{install.open();await close()}
});

// A failed switch, or a failed save of the active profile, must not touch the harness that stays active: its socket, the running
// turn and the approval it waits on carry on (the server rejects an answer that arrives on another socket, and sends the session's
// next approval to the socket that created it).
const FAILED_RUNTIME_CHANGES=[
  {name:"a rejected harness switch",options:{rejectSelect:"OpenCode is installed but not authenticated"},async act(page){
    const rejected=agentRuntimePost(page);
    // The turn runs, so the switch asks first.
    await selectHarness(page,"OpenCode");await page.getByRole("dialog").getByRole("button",{name:"Switch to OpenCode",exact:true}).click();
    expect((await rejected).status()).toBe(400);
    await expect(page.locator(".agent-runtime-settings")).toContainText("Could not switch to OpenCode: OpenCode is installed but not authenticated");
  }},
  {name:"a rejected save of the active profile",options:{profileEditing:true},async act(page){
    await openHarnessSettings(page);
    const profile=page.locator(".runtime-profile-row").filter({hasText:"Claude Code"});
    await expect(profile.getByText("Active",{exact:true})).toBeVisible();
    await profile.getByRole("button",{name:"Edit",exact:true}).click();
    await page.getByLabel("Auto-compact after").fill("50000");
    const rejected=agentRuntimePost(page);
    await page.getByRole("button",{name:"Save profile",exact:true}).click();
    expect((await rejected).status()).toBe(400);
    await expect(page.locator(".agent-runtime-settings")).toContainText("auto-compact threshold must be an integer between 100000 and 1000000");
  }},
];
for(const change of FAILED_RUNTIME_CHANGES){
  test(`${change.name} keeps the running turn's transport and delivers its open approval there`,async({page})=>{
    test.setTimeout(60_000);
    const {server,relay,close}=await startHarness(page,{runtime:"claude",approvalTurns:true,...change.options});
    try{
      await openGeneralChat(page,relay);
      const composer=page.getByTestId("composer"),picker=page.getByTestId("model-picker");
      await expect(picker).toContainText("Claude Fixture Sonnet");
      await composer.fill("Run the supervised fixture command.");await page.getByTestId("send").click();
      const approval=page.locator(".inline-approval .approval-card").filter({hasText:"Approve the runtime switch fixture command"});
      await expect(approval).toBeVisible({timeout:15_000});
      const [turnStart]=relay.calls("turn/start"),connection=turnStart.connection,baseline=relay.connections();
      expect(relay.openConnections()).toEqual([connection]);

      await change.act(page);
      await page.getByRole("button",{name:"Threads",exact:true}).click();
      await expect(picker).toContainText("Claude Fixture Sonnet",{timeout:10_000});
      await page.waitForTimeout(500);
      expect(relay.connections(),"the failed change opened no new socket").toBe(baseline);
      expect(relay.openConnections(),"the socket of the running turn stayed open").toEqual([connection]);
      await expect(approval).toBeVisible();
      await approval.getByRole("button",{name:"Allow once",exact:true}).click();
      await expect.poll(()=>relay.responses.find(item=>String(item.id).startsWith("approval-"))?.connection,{timeout:10_000}).toBe(connection);
      expect(relay.responses.find(item=>String(item.id).startsWith("approval-")).result).toEqual({decision:"accept"});
      await expect(page.getByText("Fixture reply from claude",{exact:true})).toBeVisible({timeout:15_000});
      expect(relay.lostReplies()).toBe(0);
      expect(server.runtime).toBe("claude");
      expect(server.counts.direct).toBe(0);
    }finally{await close()}
  });
}

test("an empty harness model catalog disables Send and tells the user to check Settings",async({page})=>{
  test.setTimeout(45_000);
  const catalogs={...CATALOGS,opencode:{...CATALOGS.opencode,models:[],defaultModel:null,metadata:{models:[]}}};
  const {server,relay,close}=await startHarness(page,{runtime:"opencode",catalogs});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),picker=page.getByTestId("model-picker");
    await expect(picker).toBeDisabled();
    const draft="This waits until OpenCode lists a model.";
    await composer.fill(draft);
    await expect(send).toBeDisabled();
    await expect.poll(()=>composerExplanation(page)).toMatch(/No models available[^]*Settings/i);
    await composer.press("Enter");await page.waitForTimeout(500);
    expect(relay.calls("thread/start","turn/start")).toEqual([]);
    expect(server.counts.direct).toBe(0);
    await expect(composer).toHaveValue(draft);
    const modelReads=server.counts.models;await page.waitForTimeout(1500);
    expect(server.counts.models-modelReads,"an empty catalog must not be re-requested in a loop").toBeLessThanOrEqual(1);
    await page.setViewportSize({width:1280,height:800});await page.screenshot({animations:"disabled",path:auditDir+"runtime-empty-catalog-send-disabled-1280x800.png",fullPage:true});
  }finally{await close()}
});

// An app command typed out in full needs neither the harness nor a model, so Enter runs it while Send waits for a model, as it did
// before Enter followed the disabled Send: /model opens the harness's model settings, /palette the command palette. A message still
// goes nowhere and adds no failed card. Enter did nothing for the commands, and nothing said why.
test("an app command typed out in full runs from Enter while Send waits for a model, and a message still waits without a card",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const catalogs={...CATALOGS,opencode:{...CATALOGS.opencode,models:[],defaultModel:null,metadata:{models:[]}}};
  const {server,relay,close}=await startHarness(page,{runtime:"opencode",catalogs});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),slashMenu=page.locator(".slash-menu");
    await expect.poll(()=>composerExplanation(page)).toMatch(/No models available[^]*Settings/i);
    // /model, typed out in full: the slash menu offers it, and Enter runs it.
    await composer.click();await page.keyboard.type("/model",{delay:15});await expect(slashMenu).toContainText("Open model provider settings");await expect(send).toBeDisabled();
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:`${auditDir}app-command-while-no-model-typed-${width}x800.png`})}
    await page.setViewportSize({width:1280,height:800});
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading",{name:"Agent harness"}),"/model opens the harness's model settings").toBeVisible({timeout:10_000});
    await page.screenshot({animations:"disabled",path:auditDir+"app-command-while-no-model-opened-settings-1280x800.png"});
    // /palette opens the command palette; Escape closes it again.
    await page.getByRole("button",{name:"Threads",exact:true}).click();await expect(composer).toHaveValue("");
    await composer.click();await page.keyboard.type("/palette",{delay:15});await page.keyboard.press("Enter");
    await expect(page.getByTestId("command-palette"),"/palette opens the command palette").toBeVisible({timeout:10_000});
    await page.keyboard.press("Escape");await expect(page.getByTestId("command-palette")).toHaveCount(0);
    // A message still waits for a model: nothing is sent, the draft stays, and no failed card repeats the line under the composer.
    const draft="Summarize the OpenCode workspace.";
    await composer.click();await page.keyboard.press("Control+A");await page.keyboard.type(draft,{delay:5});await page.keyboard.press("Enter");await page.waitForTimeout(500);
    expect(relay.calls("thread/start","turn/start")).toEqual([]);expect(server.counts.direct).toBe(0);
    await expect(composer).toHaveValue(draft);await expect(page.locator(".activity-card-failed")).toHaveCount(0);
    await expect(page.getByText(/models are still loading|has no usable model|No OpenCode model is available/)).toHaveCount(0);
  }finally{await close()}
});

test("a failed provider model catalog disables Send, shows the provider error and keeps the Configure action",async({page})=>{
  test.setTimeout(45_000);
  const providerError="OpenAI model catalog failed: 401 Incorrect API key provided";
  const catalogs={...CATALOGS,native:{provider:"openai",agentRuntime:"native",ready:false,models:[],defaultModel:null,metadata:null,error:providerError}};
  const {server,relay,close}=await startHarness(page,{runtime:"native",catalogs});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),send=page.getByTestId("send");
    const draft="This waits until the provider catalog loads.";
    await composer.fill(draft);
    await expect(send).toBeDisabled();
    await expect.poll(()=>composerExplanation(page)).toContain(providerError);
    const configure=page.locator(".composer-wrap").getByRole("button",{name:"Configure OpenAI API",exact:true});
    await expect(configure).toBeVisible();
    await composer.press("Enter");await page.waitForTimeout(500);
    expect(relay.calls("thread/start","turn/start")).toEqual([]);
    expect(server.counts.direct).toBe(0);
    await expect(composer).toHaveValue(draft);
    const modelReads=server.counts.models;await page.waitForTimeout(1500);
    expect(server.counts.models-modelReads,"a failed catalog must not be re-requested in a loop").toBeLessThanOrEqual(1);
    await page.setViewportSize({width:1280,height:800});await page.screenshot({animations:"disabled",path:auditDir+"runtime-provider-catalog-error-send-disabled-1280x800.png",fullPage:true});
    await configure.click();
    await expect(page.getByTestId("provider-settings-card")).toBeVisible();
  }finally{await close()}
});

test("re-opening Settings shows the cached harness list immediately while it refreshes",async({page})=>{
  test.setTimeout(45_000);
  let releaseReads=()=>{};
  const {server,relay,close}=await startHarness(page,{runtime:"claude"});
  try{
    await openGeneralChat(page,relay);
    const card=page.locator(".agent-runtime-settings"),list=page.locator(".agent-runtime-list"),refreshing=page.getByTestId("agent-runtime-refreshing"),skeletons=page.getByTestId("agent-runtime-skeleton");
    const claude=page.locator(".agent-runtime-option").filter({hasText:"Claude Code"}),opencode=page.locator(".agent-runtime-option").filter({hasText:"OpenCode"});
    // First visit: nothing is known yet, so skeleton rows stand in until the first probe answers.
    server.holdRuntimeReads=new Promise(resolve=>{releaseReads=resolve});
    await openHarnessSettings(page);
    await expect(skeletons.first()).toBeVisible();
    await expect(list).toHaveAttribute("aria-busy","true");
    releaseReads();
    await expect(claude.getByText("Active",{exact:true})).toBeVisible();
    await expect(opencode).toContainText("1.0.0-fixture");
    await expect(skeletons).toHaveCount(0);
    await expect(list).toHaveAttribute("aria-busy","false");
    await page.getByRole("button",{name:"Threads",exact:true}).click();

    // Later visits: each one re-probes every CLI (about 1.3 s live). Hold that probe so anything rendered meanwhile can only come from the cache.
    server.holdRuntimeReads=new Promise(resolve=>{releaseReads=resolve});server.versions.opencode="1.1.0-refreshed";
    const readsBefore=server.counts.runtimeReads,doneBefore=server.counts.runtimeReadsDone;
    await openHarnessSettings(page);
    await expect.poll(()=>server.counts.runtimeReads).toBeGreaterThan(readsBefore);
    await expect(claude.getByText("Active",{exact:true})).toBeVisible();
    await expect(opencode).toContainText("1.0.0-fixture");
    await expect(page.locator(".agent-runtime-option")).toHaveCount(HARNESSES.length);
    await expect(skeletons).toHaveCount(0);
    await expect(card).not.toContainText("checking…");
    await expect(refreshing).toBeVisible();
    await expect(list).toHaveAttribute("aria-busy","true");
    expect(server.counts.runtimeReadsDone).toBe(doneBefore);
    await page.setViewportSize({width:1280,height:800});await page.screenshot({animations:"disabled",path:auditDir+"settings-cached-harness-list-refreshing-1280x800.png",fullPage:true});

    releaseReads();
    await expect(opencode).toContainText("1.1.0-refreshed");
    await expect(refreshing).toHaveCount(0);
    await expect(list).toHaveAttribute("aria-busy","false");
    await expect(claude.getByText("Active",{exact:true})).toBeVisible();
    await expect(page.getByTestId("agent-runtime-refresh-error")).toHaveCount(0);

    // A probe that fails keeps the cached rows on screen but says so, instead of passing them off as current.
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    server.failRuntimeReads="Harness probe failed: fixture CLI timed out";
    await openHarnessSettings(page);
    const refreshError=page.getByTestId("agent-runtime-refresh-error");
    await expect(refreshError).toContainText("Could not refresh harness status (Harness probe failed: fixture CLI timed out)");
    await expect(opencode).toContainText("1.1.0-refreshed");
    await expect(claude.getByText("Active",{exact:true})).toBeVisible();
    await expect(refreshing).toHaveCount(0);
    server.failRuntimeReads="";
    await card.getByRole("button",{name:"Refresh",exact:true}).click();
    await expect(refreshError).toHaveCount(0);
  }finally{releaseReads();await close()}
});
