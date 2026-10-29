import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { keepThreadMeta } from "./test-home.js";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}

// The step's later output shows as it comes, also when the thread was left for a new task and opened again while the step ran: the
// step comes back with the output the relay stored for it, and what comes after goes on from there.
for(const away of [false,true])test(`non-Codex ACP command progress streams visibly while the step runs${away?", after its thread is left and opened again,":""} and terminal tool calls settle`,async({page})=>{
  test.setTimeout(40_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-progress-"));
  const fixture=join(root,"fake-acp-progress.mjs");
  await writeFile(fixture,String.raw`
import { existsSync } from "node:fs";
import readline from "node:readline";
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));let sessionId="fixture-session";
// The command ends once the test writes "finish" beside this file, so it runs for as long as the test looks at the step.
const finished=(name="finish")=>new Promise(resolve=>{const check=()=>existsSync(new URL("./"+name,import.meta.url))?resolve():setTimeout(check,50);check()});
function send(value){process.stdout.write(JSON.stringify(value)+"\n")}
async function handle(message){
  if(!message.method||message.id==null)return;
  if(message.method==="initialize")return send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}}}}});
  if(message.method==="session/new"||message.method==="session/resume"||message.method==="session/load")return send({jsonrpc:"2.0",id:message.id,result:{sessionId,models:{currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture Model"}]},configOptions:[],modes:{currentModeId:"build",availableModes:[]}}});
  if(message.method==="session/set_model"||message.method==="session/close")return send({jsonrpc:"2.0",id:message.id,result:{}});
  if(message.method==="session/prompt"){
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"tool_call",toolCallId:"cmd-stream",title:"Fixture build",kind:"execute",status:"in_progress",rawOutput:"phase one\n"}}});
    // The second phase comes once the test writes "next" beside this file.
    await finished("next");
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:"cmd-stream",title:"Fixture build",kind:"execute",status:"in_progress",rawOutput:"phase one\nphase two\n"}}});
    await finished();
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:"cmd-stream",title:"Fixture build",kind:"execute",status:"completed",rawOutput:"phase one\nphase two\ndone\n"}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"tool_call",toolCallId:"cmd-fast",title:"Quick check",kind:"execute",status:"completed",rawOutput:"quick complete\n"}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Fixture finished."}}}});
    return send({jsonrpc:"2.0",id:message.id,result:{stopReason:"end_turn"}});
  }
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line)).catch(error=>send({jsonrpc:"2.0",id:null,error:{code:-32603,message:error.message}}))}catch{}});
`,"utf8");
  const env={...process.env,TREBELL_HOME:join(root,"home")};const threadStore=new AgentThreadStore(env);
  const seed=threadStore.create({runtime:"gemini",cwd:root,providerSessionId:"",model:"fixture-model",name:"ACP progress fixture"});
  const instance={id:"gemini-default",kind:"gemini",displayName:"Fixture ACP",enabled:true};
  const runtimeManager={
    activeRuntime:()=>"gemini",activeInstance:()=>instance,instances:()=>[instance],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>process.env,
    executable:()=>process.execPath,acpArgs:()=>[fixture],compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:instance.displayName,available:true,authenticated:true,version:"fixture"}),
  };
  const meta=new Map([[seed.id,{projectless:true,environmentId:null}]]);
  const state={
    settings:()=>({activeEnvironmentId:null,continueThreadsAfterRestart:false}),
    threadMeta:id=>meta.get(id)||{},
    updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},
    recordUsage:()=>{},
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:null,state,version:"fixture"});
  const port=await listen(server);
  try{
    await keepThreadMeta(page);
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"openai",providerReady:true,agentRuntime:"gemini",agentRuntimeInstanceId:"gemini-default",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",cwd:root,platform:"win32",version:"fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"gemini",agentRuntimeInstanceId:"gemini-default",modelProvider:"openai",defaultPermissionMode:"full",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[seed.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["fixture-model"],metadata:{provider:"gemini",models:[{id:"fixture-model",name:"Fixture Model",provider:"gemini",agent:"Gemini"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");
    await page.getByRole("button",{name:/ACP progress fixture/}).click();
    const composer=page.getByTestId("composer");await expect(composer).toBeEnabled();await composer.fill("Run the fixture command");await page.getByTestId("send").click();
    const streamed=page.locator(".tool-event").filter({hasText:"Fixture build"});await expect(streamed).toBeVisible();await streamed.locator("summary").click();
    const shot=name=>page.screenshot({animations:"disabled",path:auditDir+`agent-tool-progress-${name}${away?"-reopened":""}-1280x800.png`,fullPage:true});
    await expect(streamed).toContainText("phase one");await page.setViewportSize({width:1280,height:800});await shot("running");
    const body=streamed.locator(".tool-event-body"),status=streamed.locator("summary em");
    if(away){
      // A new task, and back to the thread while its step runs: the step shows the output stored for it, still running.
      await page.getByRole("button",{name:"New task",exact:true}).click();await expect(streamed).toHaveCount(0);
      await page.locator(".thread-row .thread-main").first().click();
      await expect(streamed).toBeVisible({timeout:10_000});await expect(status).toHaveText("running");
      await streamed.locator("summary").click();await expect(body).toContainText("phase one");
    }
    // The later output shows as it comes, while the step still runs, and the step closed and opened again from the keyboard
    // shows all of it.
    await writeFile(join(root,"next"),"");
    await expect(body).toContainText(/phase one\s+phase two/);await expect(status).toHaveText("running");
    await streamed.locator("summary").click();await expect(body).toHaveCount(0);
    await streamed.locator("summary").focus();await page.keyboard.press("Enter");
    await expect(body).toContainText(/phase one\s+phase two/);await expect(status).toHaveText("running");
    await shot("streamed");
    await writeFile(join(root,"finish"),"");
    await expect(streamed.locator("summary")).toContainText("done");await expect(body).toContainText(/phase two\s+done/);
    const quick=page.locator(".tool-event").filter({hasText:"Quick check"});await expect(quick.locator("summary")).toContainText("done");
    await expect(page.locator(".assistant-message-text")).toContainText("Fixture finished.");
    await expect(page.locator(".tool-event.kind-commandExecution")).toHaveCount(2);
    await expect(page.locator(".tool-event").filter({hasText:"Agent activity"})).toHaveCount(0);
    await shot("complete");
  }finally{
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
  }
});

// A call Cursor sends pending (not started: its input still streams, or it waits its turn) and never starts did not run: once its turn
// ends it reads not run, without the check of the call beside it that ran, on the turn's card and after a reload.
test("a Cursor tool call that never started reads not run once its turn ends, not done like the call that ran, also after a reload",async({page})=>{
  test.setTimeout(60_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-not-run-")),fixture=join(root,"fake-cursor.mjs");
  await writeFile(fixture,String.raw`
import { existsSync } from "node:fs";
import readline from "node:readline";
const send=value=>process.stdout.write(JSON.stringify(value)+"\n");
const select=(id,category,currentValue,values)=>({id,name:id,category,type:"select",currentValue,options:values.map(([value,name])=>({value,name}))});
let options=[select("mode","mode","agent",[["agent","Agent"],["plan","Plan"],["ask","Ask"]]),select("model","model","default",[["default","Auto"]])];
const update=(sessionId,update)=>send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update}});
// The tests run once the test writes "start" beside this file, so it sees both calls pending first.
const released=name=>new Promise(resolve=>{const check=()=>existsSync(new URL("./"+name,import.meta.url))?resolve():setTimeout(check,50);check()});
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",async line=>{
  let m;try{m=JSON.parse(line)}catch{return}
  if(m.id==null||!m.method)return;
  const reply=result=>send({jsonrpc:"2.0",id:m.id,result});
  if(m.method==="initialize")return reply({protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:true}});
  if(m.method==="session/new"||m.method==="session/load")return reply({sessionId:"fixture-session",configOptions:options});
  if(m.method==="session/set_config_option"){options=options.map(option=>option.id===m.params.configId?{...option,currentValue:m.params.value}:option);return reply({configOptions:options})}
  if(m.method==="session/prompt"){
    const id=m.params.sessionId;
    update(id,{sessionUpdate:"tool_call",toolCallId:"run-tests",title:"Run npm test",kind:"execute",status:"pending",rawInput:{command:"npm test"}});
    update(id,{sessionUpdate:"tool_call",toolCallId:"lint",title:"Run npm run lint",kind:"execute",status:"pending",rawInput:{command:"npm run lint"}});
    await released("start");
    update(id,{sessionUpdate:"tool_call_update",toolCallId:"run-tests",status:"in_progress"});
    update(id,{sessionUpdate:"tool_call_update",toolCallId:"run-tests",status:"completed",rawOutput:"12 passing"});
    // The lint call never starts: it is still pending as the turn ends.
    update(id,{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"The tests pass; I left the lint for later."}});
    return reply({stopReason:"end_turn"});
  }
  reply({});
});
`,"utf8");
  const env={...process.env,TREBELL_HOME:join(root,"home")},threadStore=new AgentThreadStore(env);
  const seed=threadStore.create({runtime:"cursor",cwd:root,providerSessionId:"",model:"default",name:"Pending calls"});
  const instance={id:"cursor-default",kind:"cursor",displayName:"Cursor",enabled:true};
  const runtimeManager={
    activeRuntime:()=>"cursor",activeInstance:()=>instance,instances:()=>[instance],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>process.env,
    executable:()=>process.execPath,acpArgs:()=>[fixture],compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:instance.displayName,available:true,authenticated:true,version:"fixture"}),
  };
  const meta=new Map([[seed.id,{projectless:true,environmentId:null}]]);
  const state={settings:()=>({activeEnvironmentId:null,continueThreadsAfterRestart:false}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},recordUsage:()=>{}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:null,state,version:"fixture"});
  const port=await listen(server),json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  try{
    await keepThreadMeta(page);
    const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"cursor",agentRuntimeInstanceId:"cursor-default",modelProvider:"openai",defaultPermissionMode:"full",defaultWorkspaceMode:"current"};
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"cursor",agentRuntimeInstanceId:"cursor-default",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",cwd:root,platform:"win32",version:"fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{[seed.id]:{projectless:true,environmentId:null}}}));
    await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:["default"],metadata:{provider:"cursor",models:[{id:"default",name:"Auto",provider:"cursor",agent:"Cursor"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const listed=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Pending calls"]')});
    await listed.locator(".thread-main").click();
    const composer=page.getByTestId("composer");await expect(composer).toBeEnabled();
    await composer.click();await page.keyboard.type("Run the tests and the lint",{delay:5});await page.keyboard.press("Enter");
    const row=title=>page.locator(".tool-event").filter({has:page.locator("summary strong",{hasText:title})});
    const tests=row("Run npm test"),lint=row("Run npm run lint");
    await expect(lint.locator("summary em"),"a call not started yet reads pending").toHaveText("pending",{timeout:20_000});
    await expect(tests.locator("summary em")).toHaveText("pending");
    await writeFile(join(root,"start"),"");
    await expect(page.locator(".assistant-message-text").filter({hasText:"The tests pass; I left the lint for later."})).toBeVisible({timeout:20_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:15_000});
    // What the turn's card says once the turn ended: the call that ran is done, the one that never started did not run.
    const said=async()=>({tests:await tests.locator("summary em").innerText(),lint:await lint.locator("summary em").innerText(),lintChecked:await lint.locator("summary .timeline-marker svg.lucide-check").count()});
    await expect.poll(said,{message:"the turn's card as the turn ended",timeout:10_000}).toEqual({tests:"done",lint:"not run",lintChecked:0});
    for(const mode of ["dark","light"]){
      if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").first().click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);await lint.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:auditDir+`agent-tool-not-run-${mode}-1280x800.png`});
    }
    // The window reloaded and the thread opened again: its card, rebuilt from the thread's history, says the same.
    await page.reload();
    await listed.locator(".thread-main").click();await expect(listed).toHaveClass(/active/);
    await expect(page.locator(".assistant-message-text").filter({hasText:"The tests pass; I left the lint for later."})).toBeVisible({timeout:20_000});
    const card=page.getByTestId("activity-card").last();await expect(card).toBeVisible();
    if(await card.getAttribute("data-state")!=="open")await card.locator(".activity-card-head").click();
    await expect.poll(said,{message:"the card after a reload",timeout:10_000}).toEqual({tests:"done",lint:"not run",lintChecked:0});
    await page.setViewportSize({width:700,height:800});await lint.scrollIntoViewIfNeeded();
    await expect(lint.locator("summary em"),"a narrow window says the same").toHaveText("not run");
    await page.screenshot({animations:"disabled",path:auditDir+`agent-tool-not-run-reloaded-${await page.evaluate(()=>document.documentElement.dataset.mode)}-700x800.png`});
  }finally{
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});
