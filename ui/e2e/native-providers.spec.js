import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { keepThreadMeta } from "./test-home.js";

// Trebell Native on each model provider, as the live provider sweep met them: a provider without a key, a key the provider
// refuses, OpenAI's long model list and a saved Thinking level the model does not offer. The GUI server is mocked at its
// HTTP API, as runtime-switch.spec.js does.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const PROVIDER_NAMES={openai:"OpenAI API",anthropic:"Anthropic API",gemini:"Google Gemini API",meta:"Meta Model API",justworker:"JustWorker.icu",hcnsec:"HCNSec.cn",vyceai:"VyceAi"};
const MODES=["dark","light"];
const REFUSAL="HTTP 402: Insufficient balance. Please top up your account. The key was not saved.";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The Native relay answers what a new chat asks for. A turn completes at once with a fixed reply, and turnStarts keeps what
// each turn/start asked the provider for. listThreads: the relay keeps the threads it starts, with their model, lists them and
// opens them again, as the Native relay does after a reload.
async function startNativeRelay({listThreads=false}={}){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),open=new Set(),requests=[],turnStarts=[],threads=new Map();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    open.add(ws);ws.on("close",()=>open.delete(ws));
    const send=value=>{try{ws.send(JSON.stringify(value))}catch{}};
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
      requests.push(message.method);
      const params=message.params||{};
      if(message.method==="turn/start"){
        turnStarts.push(params);
        const threadId=params.threadId,turnId="native-turn-"+turnStarts.length;
        send({id:message.id,result:{turn:{id:turnId,status:"inProgress",items:[]}}});
        send({method:"turn/started",params:{threadId,turn:{id:turnId,status:"inProgress",startedAt:Date.now()/1000}}});
        send({method:"item/completed",params:{threadId,turnId,item:{id:"reply-"+turnId,type:"agentMessage",text:"Fixture reply"}}});
        send({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed",completedAt:Date.now()/1000}}});
        return;
      }
      let result={};
      if(message.method==="initialize")result={userAgent:"native-providers-fixture"};
      else if(message.method==="thread/start"){
        const thread={id:"native-thread-"+requests.length,name:"Native",preview:"",cwd:params.cwd||process.cwd(),createdAt:Date.now()/1000,updatedAt:Date.now()/1000,status:{type:"idle"},turns:[],...(listThreads?{name:"Native thread "+(threads.size+1),model:params.model||null,modelProvider:params.modelProvider||null}:{})};
        threads.set(thread.id,thread);result={thread};
      }
      else if(listThreads&&message.method==="thread/list")result={data:[...threads.values()],nextCursor:null};
      else if(listThreads&&["thread/resume","thread/read"].includes(message.method)&&threads.has(params.threadId))result={thread:threads.get(params.threadId)};
      else if(["thread/list","thread/turns/list","thread/queue/list","thread/attachment/list","thread/timeline/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(["threadSection/list","skills/list","collaborationMode/list"].includes(message.method))result={data:[]};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      send({id:message.id,result});
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",requests,turnStarts,async close(){for(const ws of open)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

// The GUI server's side for Trebell Native on one provider. Without a key the catalog has no models (a fixed-model provider
// still lists its model) and its error asks for a key, or says why the last key typed was refused, as ProviderManager.models
// answers; refuseKey makes a typed key fail its check the way the GUI server's checkKey reports it (true, or a test of the key;
// server.refuseKey changes it later), and keyCheckMs holds each answer that long, as the live check against the provider takes its
// time. server.checks keeps each key checked, with when it was sent and answered. server.modelsMs holds each /api/models answer that
// long, as the GUI server lists the models live from the provider with the key it has, for up to 12 s. reasoningEfforts are the saved
// Thinking levels, and a level picked in the composer is saved into them.
const STATIC_MODELS={justworker:["claude-opus-4-8"],hcnsec:["glm-5.3"]};
async function startNativeHarness(page,{provider,mode="dark",hasKey=false,models=[],defaultModel=null,refuseKey=false,keyCheckMs=0,reasoningEfforts={},listThreads=false}){
  const server={provider,hasKey,keyCheck:null,posts:[],checks:[],refuseKey,modelsMs:0,reasoningEfforts:{...reasoningEfforts}};
  const relay=await startNativeRelay({listThreads});
  const settings=()=>({onboardingComplete:true,appearance:"dark",appearanceMode:mode,panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:server.provider,defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",modelReasoningEfforts:server.reasoningEfforts});
  const bootstrap=()=>({mock:false,provider:server.provider,providerReady:server.hasKey,agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeReady:true,appServerReady:true,wsUrl:relay.wsUrl,cwd:process.cwd(),platform:process.platform,version:"native-providers-fixture",activeEnvironmentId:null,activeEnvironment:null});
  const keyless=()=>STATIC_MODELS[server.provider]||[];
  const catalog=()=>server.hasKey
    ?{provider:server.provider,agentRuntime:"native",ready:true,models,defaultModel,metadata:{provider:server.provider,source:"live",models:models.map(id=>({id,provider:server.provider}))},error:null}
    :{provider:server.provider,agentRuntime:"native",ready:false,models:keyless(),defaultModel:keyless()[0]||null,metadata:{provider:server.provider,source:keyless().length?"static":"none",models:keyless().map(id=>({id,provider:server.provider}))},error:server.keyCheck?"API key check failed: "+server.keyCheck.message:"API key required"};
  const row=id=>({id,name:PROVIDER_NAMES[id],official:["openai","anthropic","gemini","meta"].includes(id),requiresKey:true,hasKey:id===server.provider&&server.hasKey,keyCheck:id===server.provider?server.keyCheck:null});
  const providers=()=>({selected:server.provider,providers:Object.keys(PROVIDER_NAMES).map(row),status:{...row(server.provider),ready:server.hasKey},ready:server.hasKey});
  const runtimes=()=>({selectedRuntime:"native",selectedInstanceId:"native-default",definitions:[{id:"native",name:"Trebell Native",protocol:"native"}],instances:[{id:"native-default",kind:"native",displayName:"Trebell Native",enabled:true}],statuses:[{id:"native-default",kind:"native",name:"Trebell Native",available:true,installed:true,authenticated:true,version:"Built into Trebell Code"}]});
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,bootstrap()));
  await page.route(/\/api\/state$/,route=>json(route,{settings:settings(),projects:[],threadMeta:{}}));
  await page.route(/\/api\/settings$/,route=>{
    const patch=route.request().method()==="POST"?route.request().postDataJSON()||{}:{};
    if(patch.modelReasoningEfforts)server.reasoningEfforts={...patch.modelReasoningEfforts};
    return json(route,settings());
  });
  await page.route(/\/api\/models(?:\?.*)?$/,async route=>{if(server.modelsMs)await new Promise(resolve=>setTimeout(resolve,server.modelsMs));return json(route,catalog())});
  await page.route(/\/api\/agent-runtimes(?:\?.*)?$/,route=>route.request().method()==="GET"?json(route,runtimes()):json(route,{error:"No harness change is expected in this fixture"},400));
  await page.route(/\/api\/providers$/,async route=>{
    if(route.request().method()==="GET")return json(route,providers());
    const body=route.request().postDataJSON()||{},key=String(body.apiKey||"").trim();server.posts.push({provider:body.provider,apiKey:Boolean(key)});
    const check={key,sentAt:Date.now(),answeredAt:null};server.checks.push(check);
    if(keyCheckMs)await new Promise(resolve=>setTimeout(resolve,keyCheckMs));
    check.answeredAt=Date.now();
    if(typeof server.refuseKey==="function"?server.refuseKey(key):server.refuseKey){server.keyCheck={status:402,message:REFUSAL,at:new Date().toISOString()};return json(route,{error:PROVIDER_NAMES[server.provider]+" API key check failed: "+REFUSAL},400)}
    server.hasKey=Boolean(String(body.apiKey||"").trim());server.keyCheck=null;
    return json(route,{...providers(),agentRuntime:"native",...catalog()});
  });
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/general-workspace$/,route=>json(route,{path:process.cwd(),environmentId:null}));
  await page.route(/\/api\/stashes$/,route=>json(route,{stashes:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/chat\/direct$/,route=>json(route,{error:"The direct route must not be used outside mock mode"},500));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  return {server,relay,close:()=>relay.close()};
}

async function openGeneralChat(page,relay){
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await page.locator(".general-chat-card").click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect.poll(()=>relay.requests.filter(method=>method==="thread/list").length,{timeout:15_000}).toBeGreaterThan(0);
  await expect(page.getByTestId("composer-transport")).toHaveCount(0);
}
const composerWrap=page=>page.locator(".composer-wrap").filter({has:page.getByTestId("composer")});
// Waits for smooth scrolling (Settings reveals its target that way) to come to rest before a screenshot.
async function settle(page){
  await page.evaluate(()=>new Promise(resolve=>{
    const positions=()=>[...document.querySelectorAll("*")].map(node=>node.scrollTop).join(",");
    let last=positions(),still=0,frames=0;
    const tick=()=>{const now=positions();still=now===last?still+1:0;last=now;if(still>=6||++frames>180)resolve();else requestAnimationFrame(tick)};
    requestAnimationFrame(tick);
  }));
}

for(const mode of MODES)test(`a provider without a key offers no Thinking picker, shows a neutral next step and Configure lands in its API key field (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  const {relay,close}=await startNativeHarness(page,{provider:"gemini",mode});
  try{
    await openGeneralChat(page,relay);
    const wrap=composerWrap(page),configure=wrap.getByRole("button",{name:"Configure Google Gemini API",exact:true});
    await expect(configure).toBeVisible();
    // Live: "Thinking · provider d…" showed although Gemini had no model to think with.
    await expect(page.getByTestId("reasoning-effort-picker")).toHaveCount(0);
    await expect(page.getByTestId("service-tier-picker")).toHaveCount(0);
    const status=wrap.locator(".composer-status");
    await expect(status).toContainText("API key required");
    await expect(status).not.toHaveClass(/(?:^|\s)error(?:\s|$)/);
    await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-no-key-composer-${mode}.png`});

    await configure.click();
    await expect(page.getByTestId("provider-settings-card")).toBeVisible();
    const keyField=page.getByTestId("provider-api-key");
    await expect(keyField).toBeFocused();
    const providerStatus=page.getByTestId("provider-status");
    await expect(providerStatus).toHaveText("Google Gemini API · API key required");
    await expect(providerStatus).not.toHaveClass(/provider-status-error/);
    await settle(page);await expect(providerStatus).toBeInViewport({ratio:1});
    await page.screenshot({animations:"disabled",path:auditDir+`native-provider-no-key-settings-${mode}.png`});
    // The field takes typing at once, as a person would paste a key right after Configure.
    await page.keyboard.type("gm-fixture");await expect(keyField).toHaveValue("gm-fixture");
  }finally{await close()}
});

for(const provider of ["justworker","hcnsec"])for(const mode of MODES)test(`${PROVIDER_NAMES[provider]}, a provider with a fixed model, is set up first without a key: a neutral next step and Configure (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  // Its catalog lists the model even without a key; the composer used to show a red "API key required" and no Configure.
  const {relay,close}=await startNativeHarness(page,{provider,mode});
  try{
    await openGeneralChat(page,relay);
    const wrap=composerWrap(page),configure=wrap.getByRole("button",{name:"Configure "+PROVIDER_NAMES[provider],exact:true});
    await expect(configure).toBeVisible();await expect(configure).toHaveCount(1);
    const status=wrap.locator(".composer-status");
    await expect(status).toContainText("API key required");
    await expect(status).not.toHaveClass(/(?:^|\s)error(?:\s|$)/);
    await expect(page.getByTestId("send")).toBeDisabled();
    await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-${provider}-no-key-composer-${mode}.png`});

    await configure.click();
    await expect(page.getByTestId("provider-api-key")).toBeFocused();
    const providerStatus=page.getByTestId("provider-status");
    await expect(providerStatus).toHaveText(PROVIDER_NAMES[provider]+" · API key required");
    await expect(providerStatus).not.toHaveClass(/provider-status-error/);
  }finally{await close()}
});

for(const mode of MODES)test(`a refused key reads as the provider's reason under "key check failed", also after leaving Settings (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  const {server,relay,close}=await startNativeHarness(page,{provider:"vyceai",mode,refuseKey:true});
  try{
    await openGeneralChat(page,relay);
    const configure=composerWrap(page).getByRole("button",{name:"Configure VyceAi",exact:true});
    await configure.click();
    const keyField=page.getByTestId("provider-api-key"),providerStatus=page.getByTestId("provider-status");
    await expect(keyField).toBeFocused();
    await keyField.fill("vy-fixture-refused-key");
    await page.getByTestId("save-provider-key").click();
    // Live, this said "VyceAi · API key required · VyceAi API key validation failed: … HTTP 402: {"error":{…}}".
    await expect(providerStatus).toHaveText("VyceAi · key check failed · "+REFUSAL);
    await expect(providerStatus).toHaveClass(/provider-status-error/);
    await expect(providerStatus).not.toContainText("{");
    expect(server.posts).toEqual([{provider:"vyceai",apiKey:true}]);
    await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-key-refused-${mode}.png`});

    // Leave Settings: the composer no longer reads as a neutral next step but as the failed check, with its reason and
    // Configure. Then come back the way the composer sends people: the reason is still there.
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    await expect(configure).toBeVisible();
    const composerStatus=composerWrap(page).locator(".composer-status");
    await expect(composerStatus.getByTestId("composer-model-status")).toHaveText("API key check failed: "+REFUSAL);
    await expect(composerStatus).toHaveClass(/(?:^|\s)error(?:\s|$)/);
    await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-key-refused-composer-${mode}.png`});
    await configure.click();
    await expect(providerStatus).toHaveText("VyceAi · key check failed · "+REFUSAL);
    await expect(keyField).toBeFocused();
    await settle(page);await expect(providerStatus).toBeInViewport({ratio:1});
    await page.screenshot({animations:"disabled",path:auditDir+`native-provider-key-refused-return-${mode}.png`});
  }finally{await close()}
});

// Each key sent runs its live check against the provider. Enter held in the field (it repeats about every 33 ms) or on Save API key,
// and a double click on that button, sent the key once per repeat or click: the press that saves sends it, and a press while it is
// on its way, or what is left of the press once a refused key comes back to the field, sends nothing.
for(const mode of MODES)test(`Enter held in the API key field or on Save API key, or a double click on it, sends the key and its check once (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  const {server,relay,close}=await startNativeHarness(page,{provider:"openai",mode,models:["gpt-fixture"],defaultModel:"gpt-fixture",keyCheckMs:900});
  try{
    await openGeneralChat(page,relay);
    await composerWrap(page).getByRole("button",{name:"Configure OpenAI API",exact:true}).click();
    const keyField=page.getByTestId("provider-api-key"),save=page.getByTestId("save-provider-key"),providerStatus=page.getByTestId("provider-status");
    await expect(keyField).toBeFocused();
    // Enter goes down and repeats while the key is checked, and goes on repeating after the answer until it is let go.
    const holdEnter=async()=>{
      await page.keyboard.down("Enter");await expect(providerStatus).toContainText("Saving…");
      for(let index=0;index<4;index++)await page.keyboard.down("Enter");
      await expect(providerStatus).not.toContainText("Saving…",{timeout:10_000});
      for(let index=0;index<4;index++)await page.keyboard.down("Enter");
      await page.keyboard.up("Enter");
    };
    const answered=async()=>{await expect(providerStatus).toContainText("Saving…");await expect(providerStatus).not.toContainText("Saving…",{timeout:10_000})};
    // The keys one way of saving sent, counted once its answer is on screen.
    let counted=0;const sentSince=()=>{const count=server.posts.length-counted;counted=server.posts.length;return count};
    await page.keyboard.type("sk-fixture-held-enter",{delay:15});await holdEnter();
    await expect(providerStatus).toContainText("API key saved. Harness ready.");await expect(keyField).toHaveValue("");
    expect.soft(sentSince(),"keys sent for Enter held in the field").toBe(1);
    await keyField.fill("sk-fixture-double-click");await save.dblclick();await answered();
    await expect(providerStatus).toContainText("API key saved. Harness ready.");await expect(keyField).toHaveValue("");
    expect.soft(sentSince(),"keys sent for a double click on Save API key").toBe(1);
    await providerStatus.scrollIntoViewIfNeeded();await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-key-saved-once-${mode}.png`});

    // A refused key stays in the field, where the rest of a held press or of a double click must not send it again.
    server.refuseKey=true;
    await keyField.click();await page.keyboard.type("sk-fixture-refused",{delay:15});await holdEnter();
    await expect(providerStatus).toHaveText("OpenAI API · key check failed · "+REFUSAL);await expect(keyField).toHaveValue("sk-fixture-refused");
    expect.soft(sentSince(),"keys sent for Enter held in the field on a key the provider refuses").toBe(1);
    await page.keyboard.press("Tab");await expect(save).toBeFocused();
    await holdEnter();await expect(providerStatus).toHaveText("OpenAI API · key check failed · "+REFUSAL);await expect(save).toBeFocused();
    expect.soft(sentSince(),"keys sent for Enter held on Save API key").toBe(1);
    // A refusal can come back before the second click of a double click, which then lands on the button again.
    await save.click();await answered();
    await save.dispatchEvent("click",{detail:2});
    await expect(providerStatus).toHaveText("OpenAI API · key check failed · "+REFUSAL);await expect(keyField).toHaveValue("sk-fixture-refused");
    await providerStatus.scrollIntoViewIfNeeded();await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-key-refused-once-${mode}.png`});
    // A press of its own sends the key again. Its answer comes after that of anything the second click sent.
    server.refuseKey=false;
    await keyField.fill("sk-fixture-accepted");await keyField.press("Enter");await answered();
    await expect(providerStatus).toContainText("API key saved. Harness ready.");await expect(keyField).toHaveValue("");
    expect.soft(sentSince(),"keys sent for a click, the second click of a double click after its refusal, and Enter").toBe(2);
    expect(server.posts,"one key sent for each press of its own").toHaveLength(6);
  }finally{await close()}
});

// Presses of their own while a key is checked: Enter let go and pressed again, or Enter and then a click on Save API key, send that
// key no second time. Another key pressed meanwhile is sent once the first has answered, as the server checks one key at a time,
// so the key sent last is the one checked; it was dropped with nothing said, and the first key's refusal showed next to it.
for(const mode of MODES)test(`a press while a key is checked sends that key no second time and sends another key once it has answered (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  const {server,relay,close}=await startNativeHarness(page,{provider:"openai",mode,models:["gpt-fixture"],defaultModel:"gpt-fixture",keyCheckMs:900,refuseKey:key=>key!=="sk-fixture-corrected"});
  try{
    await openGeneralChat(page,relay);
    await composerWrap(page).getByRole("button",{name:"Configure OpenAI API",exact:true}).click();
    const keyField=page.getByTestId("provider-api-key"),save=page.getByTestId("save-provider-key"),providerStatus=page.getByTestId("provider-status");
    await expect(keyField).toBeFocused();
    const refused="OpenAI API · key check failed · "+REFUSAL;
    let counted=0;const sentSince=()=>{const count=server.posts.length-counted;counted=server.posts.length;return count};
    await page.keyboard.type("sk-fixture-pressed-twice",{delay:15});
    await keyField.press("Enter");await expect(providerStatus).toContainText("Saving…");
    await keyField.press("Enter");
    await expect(providerStatus).toHaveText(refused,{timeout:10_000});await expect(keyField).toHaveValue("sk-fixture-pressed-twice");
    expect.soft(sentSince(),"keys sent for Enter, let go and pressed again while the key is checked").toBe(1);
    await keyField.press("Enter");await expect(providerStatus).toContainText("Saving…");
    await save.click();
    await expect(providerStatus).toHaveText(refused,{timeout:10_000});
    expect.soft(sentSince(),"keys sent for Enter and then a click on Save API key while the key is checked").toBe(1);
    // A mistyped key, then the corrected one while the first is checked.
    await keyField.fill("sk-fixture-mistyped");await keyField.press("Enter");await expect(providerStatus).toContainText("Saving…");
    await keyField.fill("sk-fixture-corrected");await keyField.press("Enter");
    expect.soft(server.posts.length-counted,"the corrected key waits for the mistyped one's answer").toBe(1);
    await expect.soft(providerStatus,"the corrected key is checked and saved").toContainText("API key saved. Harness ready.",{timeout:10_000});
    await expect.soft(keyField).toHaveValue("");
    expect.soft(sentSince(),"keys sent for a key and another one pressed while it is checked").toBe(2);
    const [mistyped,corrected]=server.checks.slice(-2);
    expect.soft([mistyped?.key,corrected?.key]).toEqual(["sk-fixture-mistyped","sk-fixture-corrected"]);
    expect.soft(corrected&&corrected.sentAt>=mistyped.answeredAt,"the corrected key is sent once the mistyped one has answered").toBe(true);
    await providerStatus.scrollIntoViewIfNeeded();await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-key-second-press-${mode}.png`});
    expect(server.posts,"one key sent for each press of its own, and the corrected key").toHaveLength(4);
  }finally{await close()}
});

// What follows a refusal held the next press back: the providers are read again and the app reloads its catalog, which the GUI
// server lists live from the provider with the key stored before, for up to 12 s. Until that answered, Enter in the field or a click
// on Save API key sent nothing and showed nothing, and a corrected key sent then was dropped next to the old refusal.
for(const mode of MODES)test(`a press right after a refused key sends it at once while the catalog is still loading (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  const {server,relay,close}=await startNativeHarness(page,{provider:"openai",mode,hasKey:true,models:["gpt-fixture"],defaultModel:"gpt-fixture",keyCheckMs:900});
  try{
    await openGeneralChat(page,relay);
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    await expect(page.getByTestId("provider-settings-card")).toBeVisible();
    const keyField=page.getByTestId("provider-api-key"),save=page.getByTestId("save-provider-key"),providerStatus=page.getByTestId("provider-status");
    await expect(providerStatus).toHaveText("OpenAI API · ready");
    // A saved key, and a new one the provider refuses; each catalog read after a refusal takes 8 s.
    server.refuseKey=true;server.modelsMs=8000;
    const refused="OpenAI API · key check failed · "+REFUSAL;
    await keyField.fill("sk-fixture-refused");await keyField.press("Enter");
    await expect(providerStatus).toContainText("Saving…");await expect(providerStatus).toHaveText(refused,{timeout:10_000});
    expect(server.posts).toHaveLength(1);
    await keyField.press("Enter");
    await expect(providerStatus,"Enter right after the refusal sends the key again").toContainText("Saving…",{timeout:2_000});
    await expect.poll(()=>server.posts.length).toBe(2);
    await expect(providerStatus).toHaveText(refused,{timeout:10_000});
    await save.click();
    await expect(providerStatus,"a click on Save API key right after the refusal sends the key again").toContainText("Saving…",{timeout:2_000});
    await expect.poll(()=>server.posts.length).toBe(3);
    await expect(providerStatus).toHaveText(refused,{timeout:10_000});
    server.refuseKey=false;
    await keyField.fill("sk-fixture-corrected");await keyField.press("Enter");
    await expect(providerStatus,"a corrected key right after the refusal is sent").toContainText("Saving…",{timeout:2_000});
    await expect(providerStatus).toHaveText("OpenAI API · ready · API key saved. Harness ready.",{timeout:10_000});
    await expect(keyField).toHaveValue("");
    expect(server.posts).toHaveLength(4);
    await providerStatus.scrollIntoViewIfNeeded();await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-key-sent-again-after-refusal-${mode}.png`});
  }finally{await close()}
});

for(const mode of MODES)test(`the model menu opens on the checked model far down a long catalog (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  // Live, OpenAI listed 79 agent models and the default gpt-6.1-sol was the 65th.
  const models=Array.from({length:79},(_,index)=>index===64?"gpt-6.1-sol":`gpt-fixture-${String(index).padStart(2,"0")}`);
  const {relay,close}=await startNativeHarness(page,{provider:"openai",mode,hasKey:true,models,defaultModel:"gpt-6.1-sol"});
  try{
    await openGeneralChat(page,relay);
    await page.getByTestId("model-picker").click();
    const menu=page.locator(".model-picker-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("model-picker-search")).toBeFocused();
    const checked=menu.locator(":scope > button.selected");
    await expect(checked).toHaveCount(1);await expect(checked).toContainText("gpt-6.1-sol");
    // The checked row shows inside the menu, below its sticky search field, and no row peeks out above that field.
    const placement=await menu.evaluate(node=>{
      const row=node.querySelector(":scope > button.selected").getBoundingClientRect(),search=node.querySelector(".model-picker-search").getBoundingClientRect(),box=node.getBoundingClientRect();
      return {belowSearch:row.top>=search.bottom-1,insideMenu:row.bottom<=box.bottom+1,scrolled:node.scrollTop>0,searchGap:Math.round((search.top-box.top-node.clientTop)*10)/10};
    });
    expect(placement).toEqual({belowSearch:true,insideMenu:true,scrolled:true,searchGap:expect.any(Number)});
    expect(placement.searchGap,"rows show above the search field").toBeLessThanOrEqual(0);
    await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-model-menu-checked-${mode}.png`});
  }finally{await close()}
});

for(const mode of MODES)test(`a model picked in the model menu with Enter or a click gives the keyboard back to the composer, and Escape gives it to the picker (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  const models=Array.from({length:30},(_,index)=>`gpt-fixture-${String(index).padStart(2,"0")}`);
  const {relay,close}=await startNativeHarness(page,{provider:"openai",mode,hasKey:true,models,defaultModel:"gpt-fixture-00"});
  try{
    await openGeneralChat(page,relay);
    const composer=page.getByTestId("composer"),picker=page.getByTestId("model-picker"),menu=page.locator(".model-picker-menu"),search=page.getByTestId("model-picker-search"),options=menu.locator(":scope > button");
    await composer.click();await page.keyboard.type("Draft for the release",{delay:15});
    // From the keyboard: Tab to the picker, Enter opens the menu on its search, the search narrows it, ArrowDown and Enter pick.
    for(let step=0;step<12&&!await picker.evaluate(node=>node===document.activeElement);step++)await page.keyboard.press("Tab");
    await expect(picker).toBeFocused();
    await page.keyboard.press("Enter");await expect(search).toBeFocused();
    await page.keyboard.type("fixture-07",{delay:15});await expect(options).toHaveCount(1);
    await page.keyboard.press("ArrowDown");await expect(options.first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);await expect(picker).toContainText(/gpt-fixture-07/i);await expect(composer).toBeFocused();
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await settle(page);await expect(composer).toBeFocused();await page.screenshot({animations:"disabled",path:auditDir+`native-provider-model-picked-keyboard-${mode}-${width}x800.png`})}
    await page.setViewportSize({width:1280,height:800});
    await page.keyboard.type(" today",{delay:15});await expect(composer).toHaveValue("Draft for the release today");
    // With the mouse, the model clicked gives the keyboard back to the composer too.
    await picker.click();await expect(search).toBeFocused();
    await options.filter({hasText:/gpt-fixture-03/i}).click();
    await expect(menu).toHaveCount(0);await expect(picker).toContainText(/gpt-fixture-03/i);await expect(composer).toBeFocused();
    // Escape keeps the model and gives the keyboard back to the picker.
    await picker.click();await expect(search).toBeFocused();await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);await expect(picker).toBeFocused();await expect(picker).toContainText(/gpt-fixture-03/i);
  }finally{await close()}
});

for(const mode of MODES)test(`a Thinking level the model does not offer reads and runs as the provider default, and a level it offers is sent (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  // Saved while the picker still offered Extra High for gpt-5. The picker went on showing it and every turn sent it, which the
  // Responses API answers with HTTP 400 "Unsupported value: 'xhigh' is not supported with the 'gpt-5' model".
  const {server,relay,close}=await startNativeHarness(page,{provider:"openai",mode,hasKey:true,models:["gpt-5","gpt-6.1-sol"],defaultModel:"gpt-5",reasoningEfforts:{"native:openai:gpt-5":"xhigh"}});
  try{
    await openGeneralChat(page,relay);
    await expect(page.getByTestId("model-picker")).toContainText(/gpt-5/i);
    const picker=page.getByTestId("reasoning-effort-picker");
    await expect(picker).toHaveValue("");
    await expect(picker.locator("option")).toHaveText(["Thinking · Default","Thinking · Low","Thinking · Medium","Thinking · High"]);
    await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-thinking-level-not-offered-${mode}.png`});
    const composer=page.getByTestId("composer"),send=page.getByTestId("send");
    await composer.fill("hello");await send.click();
    await expect.poll(()=>relay.turnStarts.length,{timeout:15_000}).toBe(1);
    expect(relay.turnStarts[0].model).toBe("gpt-5");
    expect(relay.turnStarts[0]).not.toHaveProperty("reasoningEffort");

    await picker.selectOption({label:"Thinking · High"});
    await expect(picker).toHaveValue("high");
    expect(server.reasoningEfforts).toEqual({"native:openai:gpt-5":"high"});
    await composer.fill("again");await send.click();
    await expect.poll(()=>relay.turnStarts.length,{timeout:15_000}).toBe(2);
    expect(relay.turnStarts[1]).toMatchObject({model:"gpt-5",reasoningEffort:"high"});
    await expect(picker).toBeEnabled();await expect(picker).toHaveValue("high");
    await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-thinking-level-picked-${mode}.png`});
  }finally{await close()}
});

// Trebell Native assumes no model a provider does not name as its default, and shows the options instead (the owner, 2026-10-30:
// "If someone is putting in their meta api key, just show all models available"). Meta's /v1/models names none: a Meta key landed
// the composer silently on the first id sorted, muse-spark-1.1, Meta's oldest model, and a message went with it.
const META_MODELS=["muse-spark-1.1","muse-spark-1.2","muse-spark-1.3","muse-spark-1.3-contributor","muse-wonder-1.0"];
const META_NEWEST_FIRST=["muse-spark-1.3","muse-spark-1.2","muse-spark-1.1","muse-spark-1.3-contributor","muse-wonder-1.0"];
const CHOOSE=/(?:^|\s)choose(?:\s|$)/;
for(const mode of MODES)test(`Native on a provider that names no default model asks for one, lists them all, keeps the draft until one is picked and keeps the pick (${mode})`,async({page})=>{
  test.setTimeout(90_000);
  const {relay,close}=await startNativeHarness(page,{provider:"meta",mode,hasKey:true,models:META_MODELS,defaultModel:null,listThreads:true});
  try{
    await page.setViewportSize({width:1280,height:800});
    await openGeneralChat(page,relay);
    const picker=page.getByTestId("model-picker"),menu=page.locator(".model-picker-menu"),composer=page.getByTestId("composer"),send=page.getByTestId("send");
    const alert=page.getByTestId("composer-alert"),thinking=page.getByTestId("reasoning-effort-picker");
    // No model is assumed: the picker reads as a choice still to make, and no Thinking level shows for a model nobody chose.
    await expect(picker).toHaveText("Choose a model");await expect(picker).toHaveClass(CHOOSE);
    await expect(thinking).toHaveCount(0);
    await picker.click();await expect(menu).toBeVisible();
    await expect(menu.locator(":scope > button strong"),"every model the provider gave, newest version first").toHaveText(META_NEWEST_FIRST);
    await expect(menu.locator(":scope > button.selected")).toHaveCount(0);
    await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-model-choice-menu-${mode}.png`});
    await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);

    // A send before a pick, with Send or with Enter, opens the picker and says to choose first; the draft stays and nothing is sent.
    await composer.fill("Summarize the release notes");
    await expect(send).toBeEnabled();await send.click();
    await expect(menu).toBeVisible();await expect(alert).toHaveText("Choose a model first. Your draft is kept.");
    await expect(composer).toHaveValue("Summarize the release notes");
    await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-model-choice-asked-${mode}.png`});
    await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
    await composer.click();await page.keyboard.press("End");await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();await expect(alert).toHaveText("Choose a model first. Your draft is kept.");
    await expect(composer).toHaveValue("Summarize the release notes");
    expect(relay.turnStarts,"nothing is sent without a model").toHaveLength(0);
    expect(relay.requests,"no thread is started without a model").not.toContain("thread/start");

    // The pick ends the note, shows that model's Thinking levels, and the draft goes with it; so does a follow-up in its thread.
    await menu.getByRole("button",{name:"muse-spark-1.3",exact:true}).click();
    await expect(menu).toHaveCount(0);await expect(picker).toHaveText("muse-spark-1.3");await expect(picker).not.toHaveClass(CHOOSE);
    await expect(alert).toHaveCount(0);
    await expect(thinking.locator("option")).toHaveText(["Default","Minimal","Low","Medium","High","Extra High","Max"].map(level=>"Thinking · "+level));
    await expect(composer).toHaveValue("Summarize the release notes");
    await send.click();
    await expect.poll(()=>relay.turnStarts.length,{timeout:15_000}).toBe(1);
    expect(relay.turnStarts[0]).toMatchObject({model:"muse-spark-1.3",modelProvider:"meta"});
    await expect(page.getByText("Fixture reply").first()).toBeVisible({timeout:15_000});
    await composer.fill("And the open issues");await send.click();
    await expect.poll(()=>relay.turnStarts.length,{timeout:15_000}).toBe(2);
    expect(relay.turnStarts[1]).toMatchObject({threadId:relay.turnStarts[0].threadId,model:"muse-spark-1.3"});
    await expect(picker).toHaveText("muse-spark-1.3");
    await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-model-choice-picked-${mode}.png`});

    // After a reload a new task assumes nothing again, and the thread opened again keeps the model it was started with.
    await page.reload();
    await expect(composer).toBeVisible({timeout:15_000});
    await expect(picker).toHaveText("Choose a model",{timeout:15_000});
    const row=page.locator(".thread-row").first();await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();
    await expect(picker).toHaveText("muse-spark-1.3",{timeout:15_000});
    await composer.fill("One more follow-up");await send.click();
    await expect.poll(()=>relay.turnStarts.length,{timeout:15_000}).toBe(3);
    expect(relay.turnStarts[2]).toMatchObject({threadId:relay.turnStarts[0].threadId,model:"muse-spark-1.3"});
    await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-model-choice-reloaded-${mode}.png`});
  }finally{await close()}
});

// A provider that lists exactly one model uses it, and OpenAI lands on its measured default, gpt-6-luna, as before.
for(const {provider,models,defaultModel,picked} of [
  {provider:"vyceai",models:["claude-sonnet-4-6"],defaultModel:null,picked:"claude-sonnet-4-6"},
  {provider:"openai",models:["gpt-5","gpt-6-luna","gpt-6.1-sol"],defaultModel:"gpt-6-luna",picked:"gpt-6-luna"},
])for(const mode of MODES)test(`${PROVIDER_NAMES[provider]} ${defaultModel?"with its default model":"with one model"} picks it by itself and sends with it (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  const {relay,close}=await startNativeHarness(page,{provider,mode,hasKey:true,models,defaultModel});
  try{
    await page.setViewportSize({width:1280,height:800});
    await openGeneralChat(page,relay);
    const picker=page.getByTestId("model-picker");
    await expect(picker).toHaveText(picked);await expect(picker).not.toHaveClass(CHOOSE);
    await page.getByTestId("composer").fill("hello");await page.getByTestId("send").click();
    await expect.poll(()=>relay.turnStarts.length,{timeout:15_000}).toBe(1);
    expect(relay.turnStarts[0]).toMatchObject({model:picked,modelProvider:provider});
    await expect(page.getByTestId("composer-alert")).toHaveCount(0);
    await settle(page);await page.screenshot({animations:"disabled",path:auditDir+`native-provider-model-choice-${provider}-${mode}.png`});
  }finally{await close()}
});
