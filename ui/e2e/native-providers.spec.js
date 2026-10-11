import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

// Trebell Native on each model provider, as the live provider sweep met them: a provider without a key, a key the provider
// refuses, OpenAI's long model list and a saved Thinking level the model does not offer. The GUI server is mocked at its
// HTTP API, as runtime-switch.spec.js does.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const PROVIDER_NAMES={openai:"OpenAI API",anthropic:"Anthropic API",gemini:"Google Gemini API",justworker:"JustWorker.icu",hcnsec:"HCNSec.cn",vyceai:"VyceAi"};
const MODES=["dark","light"];
const REFUSAL="HTTP 402: Insufficient balance. Please top up your account. The key was not saved.";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The Native relay answers what a new chat asks for. A turn completes at once with a fixed reply, and turnStarts keeps what
// each turn/start asked the provider for.
async function startNativeRelay(){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),open=new Set(),requests=[],turnStarts=[];
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
      else if(message.method==="thread/start")result={thread:{id:"native-thread-"+requests.length,name:"Native",preview:"",cwd:params.cwd||process.cwd(),createdAt:Date.now()/1000,updatedAt:Date.now()/1000,status:{type:"idle"},turns:[]}};
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
// answers; refuseKey makes a typed key fail its check the way the GUI server's checkKey reports it. reasoningEfforts are the
// saved Thinking levels, and a level picked in the composer is saved into them.
const STATIC_MODELS={justworker:["claude-opus-4-8"],hcnsec:["glm-5.3"]};
async function startNativeHarness(page,{provider,mode="dark",hasKey=false,models=[],defaultModel=null,refuseKey=false,reasoningEfforts={}}){
  const server={provider,hasKey,keyCheck:null,posts:[],reasoningEfforts:{...reasoningEfforts}};
  const relay=await startNativeRelay();
  const settings=()=>({onboardingComplete:true,appearance:"dark",appearanceMode:mode,panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:server.provider,defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",modelReasoningEfforts:server.reasoningEfforts});
  const bootstrap=()=>({mock:false,provider:server.provider,providerReady:server.hasKey,agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeReady:true,appServerReady:true,wsUrl:relay.wsUrl,cwd:process.cwd(),platform:process.platform,version:"native-providers-fixture",activeEnvironmentId:null,activeEnvironment:null});
  const keyless=()=>STATIC_MODELS[server.provider]||[];
  const catalog=()=>server.hasKey
    ?{provider:server.provider,agentRuntime:"native",ready:true,models,defaultModel,metadata:{provider:server.provider,source:"live",models:models.map(id=>({id,provider:server.provider}))},error:null}
    :{provider:server.provider,agentRuntime:"native",ready:false,models:keyless(),defaultModel:keyless()[0]||null,metadata:{provider:server.provider,source:keyless().length?"static":"none",models:keyless().map(id=>({id,provider:server.provider}))},error:server.keyCheck?"API key check failed: "+server.keyCheck.message:"API key required"};
  const row=id=>({id,name:PROVIDER_NAMES[id],official:["openai","anthropic","gemini"].includes(id),requiresKey:true,hasKey:id===server.provider&&server.hasKey,keyCheck:id===server.provider?server.keyCheck:null});
  const providers=()=>({selected:server.provider,providers:Object.keys(PROVIDER_NAMES).map(row),status:{...row(server.provider),ready:server.hasKey},ready:server.hasKey});
  const runtimes=()=>({selectedRuntime:"native",selectedInstanceId:"native-default",definitions:[{id:"native",name:"Trebell Native",protocol:"native"}],instances:[{id:"native-default",kind:"native",displayName:"Trebell Native",enabled:true}],statuses:[{id:"native-default",kind:"native",name:"Trebell Native",available:true,installed:true,authenticated:true,version:"Built into Trebell Code"}]});
  await page.route(/\/api\/bootstrap$/,route=>json(route,bootstrap()));
  await page.route(/\/api\/state$/,route=>json(route,{settings:settings(),projects:[],threadMeta:{}}));
  await page.route(/\/api\/settings$/,route=>{
    const patch=route.request().method()==="POST"?route.request().postDataJSON()||{}:{};
    if(patch.modelReasoningEfforts)server.reasoningEfforts={...patch.modelReasoningEfforts};
    return json(route,settings());
  });
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,catalog()));
  await page.route(/\/api\/agent-runtimes(?:\?.*)?$/,route=>route.request().method()==="GET"?json(route,runtimes()):json(route,{error:"No harness change is expected in this fixture"},400));
  await page.route(/\/api\/providers$/,route=>{
    if(route.request().method()==="GET")return json(route,providers());
    const body=route.request().postDataJSON()||{};server.posts.push({provider:body.provider,apiKey:Boolean(String(body.apiKey||"").trim())});
    if(refuseKey){server.keyCheck={status:402,message:REFUSAL,at:new Date().toISOString()};return json(route,{error:PROVIDER_NAMES[server.provider]+" API key check failed: "+REFUSAL},400)}
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
