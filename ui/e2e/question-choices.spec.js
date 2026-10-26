import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";

// A question that takes only the choices it offers (Antigravity's: the relay marks it allowCustomAnswer false, each choice carrying
// its option id as its value), answered as a person does. A Codex app-server is faked behind the real Codex relay and asks the
// question the agent relay would ask; every answer the app gives is kept.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const now=Date.now()/1000;
const THREAD={id:"choices-thread",name:"Database setup",preview:"Database",historyMode:"paginated",cwd:process.cwd(),createdAt:now-20,updatedAt:now,turns:[]};
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

async function startQuestionHarness(threads){
  let socket=null,nextId=7000;const answers=new Map(),waiting=new Map(),sockets=new Set();
  const upstreamHttp=createServer(),wss=new WebSocketServer({noServer:true});
  upstreamHttp.on("upgrade",(req,raw,head)=>wss.handleUpgrade(req,raw,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);socket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));
      if(message.id!=null&&!message.method){const id=String(message.id);answers.set(id,[...(answers.get(id)||[]),message.result]);waiting.get(id)?.(message.result);waiting.delete(id);return}
      if(message.id==null||!message.method)return;
      const params=message.params||{};let result={};
      if(message.method==="initialize")result={userAgent:"question-choices-fixture"};
      else if(message.method==="thread/list")result={data:threads,nextCursor:null};
      else if(message.method==="thread/resume")result={thread:threads.find(thread=>thread.id===params.threadId)||threads[0],itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(["thread/attachment/list","thread/queue/list","threadSection/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",
    // A server request as the agent relay sends it; answered resolves with the app's first answer.
    ask(method,params){const id=nextId++;const answered=new Promise(resolve=>waiting.set(String(id),resolve));socket.send(JSON.stringify({id,method,params}));return {id,answered}},
    answersTo:request=>answers.get(String(request.id))||[],
    async close(){relay.close();for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}
async function routeFixture(page,harness){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  const saved={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  await keepThreadMeta(page);
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return json(route,saved)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"question-choices-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:saved,projects:[],threadMeta:{[THREAD.id]:{projectless:true,environmentId:null}}}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
}
async function openThread(page,name){
  await page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)}).locator(".thread-main").click();
  await expect(page.locator(".workspace-header")).toContainText(name);
  await expect(page.getByTestId("composer")).toHaveAttribute("placeholder","Ask Trebell Code anything…");
}
// The header's light and dark toggle, or its row in More actions where the header folded it away.
async function toggleMode(page){
  const before=await page.locator("html").getAttribute("data-mode"),direct=page.locator("[data-testid=appearance-toggle]:visible").first();
  if(await direct.count())await direct.click();
  else{await page.getByRole("button",{name:/More actions/}).first().click();await page.getByTestId("header-overflow-menu").getByRole("button",{name:/^Switch to (light|dark) mode$/}).click()}
  await expect(page.locator("html")).not.toHaveAttribute("data-mode",before||"");
}
async function shoot(page,name){
  for(const [width,height] of [[1280,800],[900,800]]){
    await page.setViewportSize({width,height});
    const mode=await page.locator("html").getAttribute("data-mode");
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({animations:"disabled",path:`${auditDir}question-choices-${name}-${mode}-${width}x${height}.png`});
  }
  await page.setViewportSize({width:1280,height:800});
}
// Antigravity's question as the agent relay asks it: two choices of one name and a third, each with its option id.
const choicesOnly=itemId=>({threadId:THREAD.id,turnId:"turn-choices",itemId,questions:[{id:itemId,header:"Question",question:"Which database should the service use?",required:true,allowMultiple:false,allowCustomAnswer:false,options:[
  {label:"Postgres",description:"",value:"pg-15"},{label:"Postgres",description:"",value:"pg-16"},{label:"SQLite",description:"",value:"sqlite"},
]}]});

test("a question that takes only its own choices offers no answer or files of the person's own and answers with the chosen choice's id",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startQuestionHarness([THREAD]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Database setup");
    const modal=page.locator(".question-modal"),submit=modal.getByRole("button",{name:"Submit",exact:true}),postgres=modal.getByRole("button",{name:"Postgres",exact:true});
    for(const pass of ["dark","light"]){
      if(pass==="light")await toggleMode(page);
      const asked=harness.ask("item/tool/requestUserInput",choicesOnly("interaction_db_"+pass));
      await expect(modal).toContainText("Which database should the service use?");
      await expect(postgres).toHaveCount(2);await expect(modal.getByRole("button",{name:"SQLite",exact:true})).toBeVisible();
      await expect(modal.getByPlaceholder("Custom answer…")).toHaveCount(0);
      await expect(modal.getByRole("button",{name:"Attach files"})).toHaveCount(0);
      await expect(submit).toBeDisabled();
      // The second Postgres is a choice of its own: picking it leaves the first unpicked.
      await postgres.nth(1).click();
      await expect(postgres.nth(1)).toHaveAttribute("aria-pressed","true");await expect(postgres.nth(0)).toHaveAttribute("aria-pressed","false");
      await expect(submit).toBeEnabled();
      await shoot(page,"choices-only");
      if(pass==="dark")await submit.click();
      // From the keyboard: Tab from the picked choice goes past the third choice and Cancel to Submit, and Enter answers.
      else{for(let index=0;index<3;index++)await page.keyboard.press("Tab");await expect(submit).toBeFocused();await page.keyboard.press("Enter")}
      expect(await asked.answered).toEqual({answers:{["interaction_db_"+pass]:{answers:["pg-16"]}}});
      await expect(modal).toHaveCount(0);
      expect(harness.answersTo(asked)).toHaveLength(1);
    }
    // A question that takes the person's own words, as other harnesses ask, keeps its answer field and Attach files.
    const open=harness.ask("item/tool/requestUserInput",{threadId:THREAD.id,turnId:"turn-choices",itemId:"q-name",questions:[{id:"name",header:"Name",question:"What should the database be called?",required:true,allowMultiple:false,options:[{label:"app",description:""}]}]});
    await expect(modal).toContainText("What should the database be called?");
    await expect(modal.getByRole("button",{name:"Attach files"})).toBeVisible();
    await modal.getByPlaceholder("Custom answer…").click();await page.keyboard.type("orders",{delay:8});
    await submit.click();
    expect(await open.answered).toEqual({answers:{name:{answers:["orders"]}}});
  }finally{await harness.close()}
});
