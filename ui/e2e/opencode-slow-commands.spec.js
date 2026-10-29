import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { fakeOpenCode2Catalog,openCodeModels } from "../../tests/fixtures/fake-opencode-catalog-servers.mjs";
import { startFakeOpenCode2,writeFakeOpenCode2Serve } from "../../tests/fixtures/fake-opencode2-server.mjs";
import { keepThreadMeta } from "./test-home.js";

// An OpenCode thread whose command list is slow (OpenCode lists MCP prompts among its commands, and an MCP server can take long to
// start), as a person sees it: their message goes to OpenCode and is answered while the list is still coming, and once OpenCode lists
// its commands the composer's / menu offers them. The real agent relay runs the real OpenCode 2 session and @opencode/client against a
// stand-in for `opencode serve` (tests/fixtures/fake-opencode2-server.mjs) whose command list answers only when the test says so.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
const MODEL="opencode/big-pickle",ANSWER="Hello. The commands can come later.";

// The app on the real agent relay with an OpenCode profile and its thread "Lint pass", whose session runs against the stand-in
// (fakeOptions go to it). models answers the page's model list.
async function openCodeWindow(page,{fakeOptions={},models}){
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode-slow-commands-"));await writeFakeOpenCode2Serve(root);
  const fake=await startFakeOpenCode2(fakeOptions);
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"home")});
  const seed=threadStore.create({runtime:"opencode",cwd:root,providerSessionId:"",model:MODEL,name:"Lint pass"});
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true};
  const runtimeManager={
    activeRuntime:()=>"opencode",activeInstance:()=>instance,instances:()=>[instance],compatibleInstanceIds:()=>[instance.id],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env,FAKE_OPENCODE2_URL:fake.url}),executable:()=>process.execPath,
    probe:async()=>({id:instance.id,name:"OpenCode",available:true,authenticated:true,version:"2.0.24"}),
  };
  const meta=new Map([[seed.id,{projectless:true,environmentId:null}]]);
  const state={settings:()=>({activeEnvironmentId:null,continueThreadsAfterRestart:false}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},recordUsage:()=>{}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:null,state,version:"fixture"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  const close=async()=>{await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await fake.close();threadStore.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})};
  try{
    await keepThreadMeta(page);
    const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",modelProvider:"openai",defaultPermissionMode:"auto",defaultWorkspaceMode:"current"};
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",cwd:root,platform:process.platform,version:"fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{[seed.id]:{projectless:true,environmentId:null}}}));
    await page.route(/\/api\/models(?:\?.*)?$/,models);
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.setViewportSize({width:1280,height:800});
  }catch(error){await close();throw error}
  return {fake,close};
}

test("an OpenCode thread answers while OpenCode's command list is still coming, and its / menu offers the commands once they are listed",async({page})=>{
  test.setTimeout(90_000);
  let listCommands=()=>{};const listed=new Promise(resolve=>{listCommands=resolve});
  const app=await openCodeWindow(page,{
    fakeOptions:{
      routes:{"GET /api/command":async({send})=>send(200,{data:await listed})},
      onPrompt:({sessionID,emit,reply})=>{
        reply(ANSWER);
        emit({type:"session.text.started",data:{sessionID,assistantMessageID:"msg_a1",ordinal:0}});
        emit({type:"session.text.delta",data:{sessionID,assistantMessageID:"msg_a1",delta:ANSWER}});
        emit({type:"session.execution.succeeded",data:{sessionID}});
      },
    },
    // The profile's own list (a new chat's) has no commands yet either: it is what the slow list leaves pending.
    models:route=>json(route,{models:[MODEL],metadata:{provider:"opencode",models:[{id:MODEL,name:"Big Pickle",provider:"opencode",agent:"OpenCode"}]},inventory:{commands:[],skills:[],agents:[]}}),
  }),fake=app.fake;
  try{
    await page.goto("/");
    await page.getByRole("button",{name:/Lint pass/}).click();
    const composer=page.getByTestId("composer");
    await expect(composer).toBeEnabled();
    await composer.click();await page.keyboard.type("Say hello",{delay:5});await page.getByTestId("send").click();
    await expect(page.locator(".assistant-message-text").filter({hasText:ANSWER}),"the turn did not wait for the command list").toBeVisible({timeout:20_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);
    expect(fake.called("GET /api/command").length,"the session asked for its commands").toBe(1);
    // Before OpenCode lists them, / offers only Trebell's own commands, and none starts /lint.
    const menu=page.locator(".composer-wrap .slash-menu");
    await composer.click();await page.keyboard.type("/");
    await expect(menu).toBeVisible();await expect(menu.locator("strong",{hasText:/^\/lint-fix$/})).toHaveCount(0);
    await page.keyboard.type("lint");await expect(menu).toHaveCount(0);
    for(let index=0;index<5;index++)await page.keyboard.press("Backspace");
    await expect(composer).toHaveValue("");
    listCommands([{name:"lint-fix",description:"Fix the lint errors in the changed files"}]);
    await page.keyboard.type("/lint",{delay:5});
    const command=menu.locator("button").filter({has:page.locator("strong",{hasText:/^\/lint-fix$/})});
    await expect(command,"the / menu offers OpenCode's commands once they are listed").toBeVisible({timeout:10_000});
    await expect(command.locator("span")).toHaveText("Fix the lint errors in the changed files");
    await expect(command).toBeInViewport();
    for(const width of [1280,900]){
      await page.setViewportSize({width,height:800});
      for(const mode of ["dark","light"]){
        if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode){await page.getByTestId("appearance-toggle").click();await composer.click()}
        await expect(page.locator("html")).toHaveAttribute("data-mode",mode);await expect(command).toBeInViewport();
        await page.screenshot({animations:"disabled",path:`${auditDir}opencode-slow-commands-menu-${mode}-${width}x800.png`});
      }
    }
  }finally{
    listCommands([]);
    await app.close();
  }
});

// A new chat offers what OpenCode's own catalog lists before any thread exists: the window's model list carries OpenCode's commands
// and primary agents. The list is answered as gui-server.mjs answers it, from the server's own runtime manager reading the OpenCode 2
// profile's server (tests/fixtures/fake-opencode-catalog-servers.mjs), with only OpenCode's --version stood in for. A freshly opened
// window offers them on New task, and so does a new chat started after a thread.
test("a new chat in a freshly opened window offers OpenCode's own commands and agents from its catalog, and so does one started after a thread",async({page})=>{
  test.setTimeout(90_000);
  const home=await mkdtemp(join(tmpdir(),"trebell-opencode-catalog-menus-")),empty=join(home,"empty-path");mkdirSync(empty,{recursive:true});
  const catalog=await fakeOpenCode2Catalog({models:()=>openCodeModels(4),routes:{
    "GET /api/command":({send})=>send({data:[{name:"lint-fix",description:"Fix the lint errors in the changed files"}]}),
    "GET /api/agent":({send})=>send({data:[{id:"build",name:"build",mode:"primary"},{id:"plan",name:"plan",mode:"primary"}]}),
  }});
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,binaryPath:join(home,"opencode-2.0.24"),serverUrl:catalog.url,environment:{}};
  const runFn=async(command,args)=>command===instance.binaryPath&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:"2.0.24\n",stderr:""}:{ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""};
  const fetchImpl=async()=>new Response(JSON.stringify({message:"offline"}),{status:404,headers:{"content-type":"application/json"}});
  const manager=new AgentRuntimeManager({state:{settings:()=>({agentRuntime:"opencode",agentRuntimeInstanceId:instance.id,agentRuntimeInstances:[instance],activeEnvironmentId:null})},platform:"linux",env:{PATH:empty,HOME:home,USERPROFILE:home,TREBELL_HOME:join(home,"trebell"),TEMP:home,TMP:home},runFn,fetchImpl});
  let app=null;
  try{
    // The model list as gui-server's selectedModelsPayload answers it for an OpenCode window.
    app=await openCodeWindow(page,{models:async route=>{
      const result=await manager.models(manager.activeInstance());
      await json(route,{agentRuntime:"opencode",ready:true,models:result.models||[],defaultModel:result.preferred||null,metadata:{provider:"opencode",agentRuntime:"opencode",source:result.source,models:result.metadata||[]},error:result.error||null,...(result.inventory?{inventory:result.inventory}:{})});
    }});
    const composer=page.getByTestId("composer"),menu=page.locator(".composer-wrap .slash-menu"),agents=page.locator(".agent-picker");
    const command=menu.locator("button").filter({has:page.locator("strong",{hasText:/^\/lint-fix$/})});
    const offered=async()=>{
      await composer.click();await page.keyboard.type("/");
      await expect(command,"New task's / menu offers OpenCode's /lint-fix from its catalog").toBeVisible();
      await page.keyboard.type("lint");
      await expect(menu.locator("strong")).toHaveText(["/lint-fix"]);
      await expect(command.locator("span")).toHaveText("Fix the lint errors in the changed files");
      await expect(agents,"New task offers OpenCode's agents beside the model picker").toBeVisible();
      await expect(agents.locator("option")).toHaveText(["Default agent","build · primary","plan · primary"]);
    };
    await page.goto("/");
    await expect(page.getByTestId("model-picker")).toContainText("Model 0",{timeout:20_000});
    await expect(composer).toBeEnabled();
    await offered();
    for(const width of [1280,900]){
      await page.setViewportSize({width,height:800});
      for(const mode of ["dark","light"]){
        if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode){await page.getByTestId("appearance-toggle").click();await composer.click()}
        await expect(page.locator("html")).toHaveAttribute("data-mode",mode);await expect(command).toBeInViewport();await expect(agents).toBeInViewport();
        await page.screenshot({animations:"disabled",path:`${auditDir}opencode-new-chat-catalog-menus-${mode}-${width}x800.png`});
      }
    }
    await page.setViewportSize({width:1280,height:800});
    // The keyboard picks the command, and the picker an agent, for the new chat's first message.
    await page.keyboard.press("Enter");await expect(composer).toHaveValue("/lint-fix ");
    await agents.selectOption("plan");await expect(agents).toHaveValue("plan");
    // The person opens the thread, then starts a new chat again: OpenCode's catalog fills its menus again.
    await composer.click();await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");await expect(composer).toHaveValue("");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Lint pass"]')});
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);await expect(composer).toBeEnabled();
    await page.getByRole("button",{name:"New task",exact:true}).click();await expect(row).not.toHaveClass(/active/);
    await expect(composer).toHaveValue("");await expect(agents).toHaveValue("");
    await offered();
  }finally{
    await app?.close();await catalog.close();
    await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});
