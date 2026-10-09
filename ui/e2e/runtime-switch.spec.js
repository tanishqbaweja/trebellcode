import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const CATALOGS={
  claude:{agentRuntime:"claude",ready:true,models:["sonnet","opus"],defaultModel:"sonnet",metadata:{models:[{id:"sonnet",name:"Claude Fixture Sonnet",agent:"claude"},{id:"opus",name:"Claude Fixture Opus",agent:"claude"}]},error:null},
  opencode:{agentRuntime:"opencode",ready:true,models:["opencode/fixture-fast","opencode/fixture-large"],defaultModel:"opencode/fixture-fast",metadata:{models:[{id:"opencode/fixture-fast",name:"OpenCode Fixture Fast",agent:"opencode"},{id:"opencode/fixture-large",name:"OpenCode Fixture Large",agent:"opencode"}]},error:null},
  native:{provider:"openai",agentRuntime:"native",ready:true,models:["gpt-fixture"],defaultModel:"gpt-fixture",metadata:{provider:"openai",models:[{id:"gpt-fixture",name:"GPT Fixture",provider:"openai"}]},error:null},
};
const HARNESSES=[["claude","Claude Code","claude"],["opencode","OpenCode","http"],["native","Trebell Native","native"]];

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// Like the GUI server's /api/agent/ws: every non-Codex harness shares one socket URL and each request is served by whichever runtime the
// server has active when it arrives, so a stale-model send made while a switch is in flight lands in the new harness (the live F1 failure).
async function startAgentRelay(activeRuntime,{turnDelayMs=0,reconnectInitializeDelayMs=0,approvalTurns=false}={}){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),open=new Map(),requests=[],threads=[],responses=[],answers=new Map();let connections=0,lostReplies=0;
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
        // The turn stays in flight for turnDelayMs, so a transport reconnect during that window loses it like the live "App-server disconnected".
        const threadId=params.threadId,turnId="switch-turn-"+requests.length;if(turnDelayMs)await delay(turnDelayMs);
        send({id:message.id,result:{turn:{id:turnId,status:"inProgress",items:[]}}});
        send({method:"turn/started",params:{threadId,turn:{id:turnId,status:"inProgress",startedAt:Date.now()/1000}}});
        if(approvalTurns){
          // A supervised turn waits on an approval sent to the socket that started it, as the agent relay routes a session's permission requests.
          const approvalId="approval-"+turnId,answered=new Promise(resolve=>answers.set(approvalId,resolve));
          send({id:approvalId,method:"item/commandExecution/requestApproval",params:{threadId,turnId,itemId:"command-"+turnId,command:["git","status"],reason:"Approve the runtime switch fixture command"}});
          await answered;
        }
        send({method:"item/completed",params:{threadId,turnId,item:{id:"reply-"+turnId,type:"agentMessage",text:"Fixture reply from "+runtime}}});
        send({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed",completedAt:Date.now()/1000}}});
        return;
      }
      let result={};
      if(message.method==="initialize"){if(connection>1&&reconnectInitializeDelayMs)await delay(reconnectInitializeDelayMs);result={userAgent:"runtime-switch-fixture"}}
      else if(message.method==="thread/start"){const thread={id:"switch-thread-"+requests.length,name:"Runtime switch fixture",preview:"",cwd:params.cwd||process.cwd(),createdAt:Date.now()/1000,updatedAt:Date.now()/1000,status:{type:"idle"},turns:[]};threads.push(thread);result={thread}}
      else if(message.method==="thread/list")result={data:threads,nextCursor:null};
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
// profileEditing lets Claude Code keep several profiles, so its active profile can be edited and saved ({action:"upsert"}).
async function startHarness(page,{runtime="claude",catalogs=CATALOGS,catalogGate=null,turnDelayMs=0,reconnectInitializeDelayMs=0,rejectSelect="",approvalTurns=false,profileEditing=false}={}){
  const server={runtime,versions:{},holdRuntimeReads:null,failRuntimeReads:"",counts:{bootstrap:0,models:0,select:0,upsert:0,runtimeReads:0,runtimeReadsDone:0,direct:0}};
  const relay=await startAgentRelay(()=>server.runtime,{turnDelayMs,reconnectInitializeDelayMs,approvalTurns});
  const settings=()=>({onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:server.runtime,agentRuntimeInstanceId:server.runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"});
  const bootstrap=()=>({mock:false,provider:"openai",providerReady:true,agentRuntime:server.runtime,agentRuntimeInstanceId:server.runtime+"-default",agentRuntimeReady:true,appServerReady:true,wsUrl:relay.wsUrl,cwd:process.cwd(),platform:process.platform,version:"runtime-switch-fixture",activeEnvironmentId:null,activeEnvironment:null});
  const snapshot=()=>{
    const statuses=HARNESSES.map(([kind,name])=>({id:kind+"-default",kind,name,available:true,installed:true,authenticated:true,version:server.versions[kind]||"1.0.0-fixture"}));
    return {selectedRuntime:server.runtime,selectedInstanceId:server.runtime+"-default",definitions:HARNESSES.map(([id,name,protocol])=>({id,name,protocol,multipleInstances:profileEditing&&id==="claude"})),instances:statuses.map(({id,kind,name})=>({id,kind,displayName:name,enabled:true})),statuses};
  };
  const catalog=async active=>{await catalogGate?.(active);return catalogs[active]};
  await page.route(/\/api\/bootstrap$/,route=>{server.counts.bootstrap++;return json(route,bootstrap())});
  await page.route(/\/api\/state$/,route=>json(route,{settings:settings(),projects:[],threadMeta:{}}));
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
    if(body.action!=="select")return json(route,{error:"Unexpected agent runtime action in the runtime switch fixture: "+body.action},400);
    server.counts.select++;
    if(rejectSelect){await delay(300);return json(route,{error:rejectSelect},400)}
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
    await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"runtime-switch-loading-models-1280x800.png",fullPage:true});

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
    await expect(page.getByText(/App-server disconnected/)).toHaveCount(0);
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

// A failed switch, or a failed save of the active profile, must not touch the harness that stays active: its socket, the running
// turn and the approval it waits on carry on (the server rejects an answer that arrives on another socket, and sends the session's
// next approval to the socket that created it).
const FAILED_RUNTIME_CHANGES=[
  {name:"a rejected harness switch",options:{rejectSelect:"OpenCode is installed but not authenticated"},async act(page){
    const rejected=agentRuntimePost(page);
    await selectHarness(page,"OpenCode");
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
    await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"runtime-empty-catalog-send-disabled-1280x800.png",fullPage:true});
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
    await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"runtime-provider-catalog-error-send-disabled-1280x800.png",fullPage:true});
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
    await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"settings-cached-harness-list-refreshing-1280x800.png",fullPage:true});

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
