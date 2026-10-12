import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir,mkdtemp,readFile,readdir,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { keepThreadMeta } from "./test-home.js";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// The relay lets a harness session go once it has been idle (shortened here to 3 s); the thread's next send starts the harness again.
// A scripted ACP agent plays Grok Build. It takes config.json's initializeDelayMs to start (read at each start, so a test can slow a
// restart down), and each process logs the requests it gets to a file of its own, named for its start and its pid.
const FAKE_GROK=String.raw`
import readline from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const log=join(process.argv[2],Date.now()+"-"+process.pid+".log");appendFileSync(log,"");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));const sessionId="idle-fixture-session";let turns=0;
function send(value){process.stdout.write(JSON.stringify(value)+"\n")}
async function handle(message){
  if(message.method)appendFileSync(log,message.method+"\n");
  if(!message.method||message.id==null)return;
  if(message.method==="initialize"){await delay(JSON.parse(readFileSync(process.argv[3],"utf8")).initializeDelayMs||0);return send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:false,sessionCapabilities:{resume:{}}}}})}
  if(message.method==="session/new"||message.method==="session/resume")return send({jsonrpc:"2.0",id:message.id,result:{sessionId,models:{currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture Model"}]}}});
  if(message.method==="session/prompt"){
    turns++;send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Fixture reply "+process.pid+"-"+turns+"."}}}});
    return send({jsonrpc:"2.0",id:message.id,result:{stopReason:"end_turn"}});
  }
  return send({jsonrpc:"2.0",id:message.id,result:{}});
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line)).catch(()=>{})}catch{}});
`;
// The relay, with that agent as the thread's harness, and a saved thread as a restart leaves it: no session runs for it. idleMs is
// how long the relay keeps an idle session.
async function grokFixture(name,{initializeDelayMs,idleMs=3000}){
  const root=await mkdtemp(join(tmpdir(),"trebell-idle-release-")),agents=join(root,"agents"),fixture=join(root,"fake-grok.mjs"),config=join(root,"config.json");await mkdir(agents,{recursive:true});
  await writeFile(fixture,FAKE_GROK,"utf8");
  const startIn=ms=>writeFile(config,JSON.stringify({initializeDelayMs:ms}),"utf8");await startIn(initializeDelayMs);
  const env={...process.env,TREBELL_HOME:join(root,"home"),TREBELL_AGENT_SESSION_IDLE_MS:String(idleMs),TREBELL_AGENT_SESSION_SWEEP_MS:"100"};const threadStore=new AgentThreadStore(env);
  const seed=threadStore.create({runtime:"grok",cwd:root,providerSessionId:"idle-fixture-session",model:"fixture-model",name,providerMeta:{runtimeInstanceId:"grok-default",permissionProfile:"supervised"}});
  const instance={id:"grok-default",kind:"grok",displayName:"Grok Build",enabled:true};
  const runtimeManager={
    env,activeRuntime:()=>"grok",activeInstance:()=>instance,instances:()=>[instance],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>process.env,
    executable:()=>process.execPath,acpArgs:()=>[fixture,agents,config],compatibleInstanceIds:()=>[instance.id],
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
  // The agent processes started so far, oldest first: each one's pid and the requests it got.
  const processes=async()=>Promise.all((await readdir(agents)).sort().map(async file=>({pid:Number(file.split(/[-.]/)[1]),methods:(await readFile(join(agents,file),"utf8")).split("\n").filter(Boolean)})));
  const agentPids=async()=>(await processes()).map(agent=>agent.pid);
  return {
    root,seed,port,threadStore,startIn,agents:processes,agentPids,
    async close(){await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})},
  };
}
async function routeApp(page,fx){
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"grok",agentRuntimeInstanceId:"grok-default",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+fx.port+"/api/agent/ws",cwd:fx.root,platform:"win32",version:"fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"grok",agentRuntimeInstanceId:"grok-default",modelProvider:"openai",defaultPermissionMode:"full",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[fx.seed.id]:{projectless:true,environmentId:null}}}));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:["fixture-model"],metadata:{provider:"grok",models:[{id:"fixture-model",name:"Fixture Model",provider:"grok",agent:"Grok Build"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
}

// A send that waits on its harness takes 2 s to start here. It shows the composer's one note for a send still unanswered after five
// seconds ("Sending · waiting for Grok Build…"); the window's clock is moved past them while the harness starts. A send to the harness
// that still runs is answered first and never shows it.
test("a send that has to start the thread's harness again waits for it under one note, and a send to a running harness shows none",async({page})=>{
  test.setTimeout(60_000);
  const fx=await grokFixture("Idle harness fixture",{initializeDelayMs:2000});
  try{
    await routeApp(page,fx);
    // The window's timers run on a clock the test moves on, past the five seconds after which a waiting send names the harness.
    await page.clock.install();
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await page.getByRole("button",{name:/Idle harness fixture/}).click();
    const composer=page.getByTestId("composer"),alert=page.getByTestId("composer-alert"),waiting="Sending · waiting for Grok Build…";await expect(composer).toBeEnabled();
    // Every placeholder the composer shows, as the person would have seen it.
    await page.evaluate(()=>{const box=document.querySelector('[data-testid="composer"]');window.__placeholders=[box.placeholder];new MutationObserver(()=>window.__placeholders.push(box.placeholder)).observe(box,{attributes:true,attributeFilter:["placeholder"]})});
    const seen=()=>page.evaluate(()=>window.__placeholders.splice(0));
    expect(await fx.agentPids()).toEqual([]);
    // The first send starts the harness: the send waits for it, and past five seconds the composer says whom it waits for, its only note.
    await composer.fill("First message");await page.getByTestId("send").click();
    await expect(composer).toHaveAttribute("placeholder","Sending…");
    await page.clock.fastForward("00:06");
    await expect(composer).toHaveAttribute("placeholder",waiting);await expect(alert).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"harness-idle-release-starting-1280x800.png"});
    await expect.poll(async()=>(await fx.agentPids()).length).toBe(1);
    const [first]=await fx.agentPids();
    await expect(page.locator(".assistant-message-text").last()).toContainText("Fixture reply "+first+"-1.");
    // Left idle, the session is let go and its harness exits.
    await expect.poll(()=>alive(first),{timeout:10_000}).toBe(false);
    await seen();
    // The next send starts it again and waits for it under the same one note; the turn then runs in the new harness, which resumed
    // the conversation.
    await composer.fill("Second message");await page.getByTestId("send").click();
    await expect(composer).toHaveAttribute("placeholder","Sending…");
    await page.clock.fastForward("00:06");
    await expect(composer).toHaveAttribute("placeholder",waiting);await expect(alert).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"harness-idle-release-restarting-1280x800.png"});
    await expect.poll(async()=>(await fx.agentPids()).length).toBe(2);
    const second=(await fx.agentPids())[1];
    await expect(page.locator(".assistant-message-text").last()).toContainText("Fixture reply "+second+"-1.");
    // While it waited the composer read "Sending…" and then the one note, never another.
    const restarting=await seen(),sendingAt=restarting.indexOf("Sending…");
    expect(sendingAt).toBeGreaterThanOrEqual(0);expect(restarting.slice(sendingAt,restarting.indexOf(waiting)+1)).toEqual(["Sending…",waiting]);
    // A send while the harness still runs is answered before five seconds pass, so it shows no note, even once the clock passes them.
    await composer.fill("Third message");await page.getByTestId("send").click();
    await expect(page.locator(".assistant-message-text").last()).toContainText("Fixture reply "+second+"-2.");
    await page.clock.fastForward("00:06");await page.waitForTimeout(250);
    expect(await seen()).not.toContain(waiting);await expect(alert).toHaveCount(0);
    expect(await fx.agentPids()).toHaveLength(2);
    await page.screenshot({animations:"disabled",path:auditDir+"harness-idle-release-replied-1280x800.png"});
  }finally{await fx.close()}
});

// Stop while a send waits on its harness's start: the send has no turn for Stop to name yet. It ends there, before its turn exists,
// and the harness is never sent its prompt; the draft goes back into the composer as it was, with no note. The start goes on, so
// sending the draft then runs it in that harness. The send is the thread's first after a reopen, or its first after the idle sweep
// let its session go (stopRestart), whose wait every send after ten idle minutes now has.
for(const stopRestart of [false,true]){
  test(`Stop while ${stopRestart?"a send after the idle sweep waits on the harness's restart":"the first send waits on the harness's start"} ends the send before it runs and puts the draft back`,async({page})=>{
    test.setTimeout(90_000);
    // The session that start leaves must outlast the checks below before the draft is sent: 5 s idle.
    const fx=await grokFixture(stopRestart?"Stop while restarting":"Stop while starting",{initializeDelayMs:stopRestart?0:4000,idleMs:5000});
    try{
      await routeApp(page,fx);
      await page.setViewportSize({width:1280,height:800});
      await page.goto("/");
      await page.getByRole("button",{name:stopRestart?/Stop while restarting/:/Stop while starting/}).click();
      const composer=page.getByTestId("composer"),alert=page.getByTestId("composer-alert"),stop=page.getByRole("button",{name:"Stop",exact:true});
      const userRow=text=>page.locator(".user-row").filter({hasText:text}),turns=()=>fx.threadStore.get(fx.seed.id).turns;
      await expect(composer).toBeEnabled();
      let harnesses=0;
      if(stopRestart){
        await composer.fill("First message");await page.getByTestId("send").click();
        await expect.poll(async()=>(await fx.agentPids()).length).toBe(1);const [first]=await fx.agentPids();harnesses=1;
        await expect(page.locator(".assistant-message-text").last()).toContainText("Fixture reply "+first+"-1.");
        await expect.poll(()=>alive(first),{timeout:15_000}).toBe(false);
        await fx.startIn(4000);
      }
      const kept=turns().length,draft="Do not run this yet";
      await composer.fill(draft);await page.getByTestId("send").click();
      await expect(composer).toHaveAttribute("placeholder","Sending…");await expect(userRow(draft)).toHaveCount(1);
      await expect(stop).toBeVisible();
      await expect.poll(async()=>(await fx.agentPids()).length).toBe(harnesses+1);
      await page.screenshot({animations:"disabled",path:auditDir+`harness-stop-while-${stopRestart?"restarting":"starting"}-before-1280x800.png`});
      await stop.click();
      // The send ends while the harness still starts: the draft is back, editable, with no note, and the message has left the
      // conversation.
      await expect(composer).toHaveValue(draft);await expect(composer).toBeEnabled();
      await expect(stop).toHaveCount(0);await expect(alert).toHaveCount(0);await expect(userRow(draft)).toHaveCount(0);
      const started=(await fx.agents())[harnesses];
      expect(started.methods).not.toContain("session/resume");
      // Once the start has ended the harness has the conversation and no prompt, and the thread no turn for the stopped send.
      await expect.poll(async()=>(await fx.agents())[harnesses].methods,{timeout:15_000}).toContain("session/resume");
      await page.waitForTimeout(500);
      expect({prompted:(await fx.agents())[harnesses].methods.includes("session/prompt"),turns:turns().length}).toEqual({prompted:false,turns:kept});
      await expect(composer).toHaveValue(draft);await expect(alert).toHaveCount(0);await expect(userRow(draft)).toHaveCount(0);
      await page.screenshot({animations:"disabled",path:auditDir+`harness-stop-while-${stopRestart?"restarting":"starting"}-after-1280x800.png`});
      // Sending the draft then runs it in the harness that start left.
      await page.getByTestId("send").click();
      await expect(page.locator(".assistant-message-text").last()).toContainText("Fixture reply "+started.pid+"-1.");
      await expect(userRow(draft)).toHaveCount(1);await expect(composer).toHaveValue("");
      expect({harnesses:(await fx.agentPids()).length,turns:turns().length,last:turns().at(-1).status}).toEqual({harnesses:harnesses+1,turns:kept+1,last:"completed"});
    }finally{await fx.close()}
  });
}
