import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir,mkdtemp,readdir,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { keepThreadMeta } from "./test-home.js";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};

// The relay lets a harness session go once it has been idle (shortened here to 3 s); the thread's next send starts the harness again.
// A scripted ACP agent plays Grok Build and takes 2 s to start. A send waiting on that start shows the composer's one note for a send
// still unanswered after five seconds ("Sending · waiting for Grok Build…"); the window's clock is moved past them while the harness
// starts. A send to the harness that still runs is answered first and never shows it.
test("a send that has to start the thread's harness again waits for it under one note, and a send to a running harness shows none",async({page})=>{
  test.setTimeout(60_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-idle-release-")),agents=join(root,"agents"),fixture=join(root,"fake-grok.mjs");await mkdir(agents,{recursive:true});
  await writeFile(fixture,String.raw`
import readline from "node:readline";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
appendFileSync(join(process.argv[2],Date.now()+"-"+process.pid+".log"),"");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));const sessionId="idle-fixture-session";let turns=0;
function send(value){process.stdout.write(JSON.stringify(value)+"\n")}
async function handle(message){
  if(!message.method||message.id==null)return;
  if(message.method==="initialize"){await delay(2000);return send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:false,sessionCapabilities:{resume:{}}}}})}
  if(message.method==="session/new"||message.method==="session/resume")return send({jsonrpc:"2.0",id:message.id,result:{sessionId,models:{currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture Model"}]}}});
  if(message.method==="session/prompt"){
    turns++;send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Fixture reply "+process.pid+"-"+turns+"."}}}});
    return send({jsonrpc:"2.0",id:message.id,result:{stopReason:"end_turn"}});
  }
  return send({jsonrpc:"2.0",id:message.id,result:{}});
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line)).catch(()=>{})}catch{}});
`,"utf8");
  const env={...process.env,TREBELL_HOME:join(root,"home"),TREBELL_AGENT_SESSION_IDLE_MS:"3000",TREBELL_AGENT_SESSION_SWEEP_MS:"100"};const threadStore=new AgentThreadStore(env);
  const seed=threadStore.create({runtime:"grok",cwd:root,providerSessionId:"idle-fixture-session",model:"fixture-model",name:"Idle harness fixture",providerMeta:{runtimeInstanceId:"grok-default",permissionProfile:"supervised"}});
  const instance={id:"grok-default",kind:"grok",displayName:"Grok Build",enabled:true};
  const runtimeManager={
    env,activeRuntime:()=>"grok",activeInstance:()=>instance,instances:()=>[instance],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>process.env,
    executable:()=>process.execPath,acpArgs:()=>[fixture,agents],compatibleInstanceIds:()=>[instance.id],
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
  const agentPids=async()=>(await readdir(agents)).sort().map(name=>Number(name.split(/[-.]/)[1]));
  try{
    await keepThreadMeta(page);
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"openai",providerReady:true,agentRuntime:"grok",agentRuntimeInstanceId:"grok-default",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",cwd:root,platform:"win32",version:"fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"grok",agentRuntimeInstanceId:"grok-default",modelProvider:"openai",defaultPermissionMode:"full",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[seed.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["fixture-model"],metadata:{provider:"grok",models:[{id:"fixture-model",name:"Fixture Model",provider:"grok",agent:"Grok Build"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    // The window's timers run on a clock the test moves on, past the five seconds after which a waiting send names the harness.
    await page.clock.install();
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await page.getByRole("button",{name:/Idle harness fixture/}).click();
    const composer=page.getByTestId("composer"),alert=page.getByTestId("composer-alert"),waiting="Sending · waiting for Grok Build…";await expect(composer).toBeEnabled();
    // Every placeholder the composer shows, as the person would have seen it.
    await page.evaluate(()=>{const box=document.querySelector('[data-testid="composer"]');window.__placeholders=[box.placeholder];new MutationObserver(()=>window.__placeholders.push(box.placeholder)).observe(box,{attributes:true,attributeFilter:["placeholder"]})});
    const seen=()=>page.evaluate(()=>window.__placeholders.splice(0));
    expect(await agentPids()).toEqual([]);
    // The first send starts the harness: the send waits for it, and past five seconds the composer says whom it waits for, its only note.
    await composer.fill("First message");await page.getByTestId("send").click();
    await expect(composer).toHaveAttribute("placeholder","Sending…");
    await page.clock.fastForward("00:06");
    await expect(composer).toHaveAttribute("placeholder",waiting);await expect(alert).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"harness-idle-release-starting-1280x800.png"});
    await expect.poll(async()=>(await agentPids()).length).toBe(1);
    const [first]=await agentPids();
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
    await expect.poll(async()=>(await agentPids()).length).toBe(2);
    const second=(await agentPids())[1];
    await expect(page.locator(".assistant-message-text").last()).toContainText("Fixture reply "+second+"-1.");
    // While it waited the composer read "Sending…" and then the one note, never another.
    const restarting=await seen(),sendingAt=restarting.indexOf("Sending…");
    expect(sendingAt).toBeGreaterThanOrEqual(0);expect(restarting.slice(sendingAt,restarting.indexOf(waiting)+1)).toEqual(["Sending…",waiting]);
    // A send while the harness still runs is answered before five seconds pass, so it shows no note, even once the clock passes them.
    await composer.fill("Third message");await page.getByTestId("send").click();
    await expect(page.locator(".assistant-message-text").last()).toContainText("Fixture reply "+second+"-2.");
    await page.clock.fastForward("00:06");await page.waitForTimeout(250);
    expect(await seen()).not.toContain(waiting);await expect(alert).toHaveCount(0);
    expect(await agentPids()).toHaveLength(2);
    await page.screenshot({animations:"disabled",path:auditDir+"harness-idle-release-replied-1280x800.png"});
  }finally{
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
  }
});
