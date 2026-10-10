import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

async function startHarness(thread){
  let socket=null;
  const upstreamHttp=createServer(),wss=new WebSocketServer({noServer:true});
  upstreamHttp.on("upgrade",(req,raw,head)=>wss.handleUpgrade(req,raw,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    socket=ws;ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
      let result={};
      if(message.method==="initialize")result={userAgent:"turn-verification-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/continuity/get")result={continuity:{threadId:thread.id,notes:{completedWork:[],unresolvedFailures:[],importantDecisions:[],artifactsCreated:[],pendingNextActions:[],updatedAt:0},workspace:{cwd:thread.cwd,runtime:"codex"},verification:{status:"incomplete",risk:"medium",verified:false,summary:"0/3 required checks passed · 3 missing",missing:["diagnostics · No evidence was recorded."],failures:[],blocked:[]},completedTurnIds:["turn-verified"],unresolvedFailures:[],recentFailures:[],artifactsCreated:[],pendingNextActions:[],completedWork:[],importantDecisions:[],meaningful:true,updatedAt:Date.now()}};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      else if(message.method==="thread/verification/repair")result={turn:{id:"turn-repair",status:"inProgress",items:[]}};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",
    emit(message){if(!socket)throw new Error("Fixture is not connected.");socket.send(JSON.stringify(message))},
    async close(){relay.close();try{socket?.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}

async function routeApp(page,harness,thread){
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"turn-verification-ui",activeEnvironmentId:null,activeEnvironment:null})}));
  await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
  await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}})}));
  await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
}

test("completed turns automatically plan verification while failed turns do not",async({page})=>{
  test.setTimeout(30_000);
  const thread={id:"turn-verification-thread",name:"Turn verification fixture",preview:"Verification planning",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-20,updatedAt:Date.now()/1000,turns:[]};
  const harness=await startHarness(thread),requests=[];
  try{
    await routeApp(page,harness,thread);
    await page.route("**/api/verification/plan-turn",async route=>{
      const body=route.request().postDataJSON();requests.push(body);
      await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
        supported:true,threadId:body.threadId,turnId:body.turnId,changedPaths:["ui/src/App.jsx"],
        record:{id:"verification:auto",threadId:body.threadId,turnId:body.turnId,status:"incomplete",risk:"medium",assessment:{status:"incomplete",risk:"medium",summary:{required:3,passed:0,failed:0,blocked:0,missing:3}}},
        nextAction:{action:"verify",nextStep:{id:"diagnostics"}},
      })});
    });
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Turn verification fixture"]')});
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    harness.emit({method:"turn/completed",params:{threadId:thread.id,turn:{id:"turn-verified",status:"completed",completedAt:Date.now()/1000}}});
    await expect.poll(()=>requests.length).toBe(1);
    expect(requests[0]).toEqual({threadId:thread.id,turnId:"turn-verified"});
    await expect(page.getByText("Verification planned · medium risk · 3 required checks · next diagnostics",{exact:true})).toBeVisible();
    await page.setViewportSize({width:1280,height:800});
    await page.getByText("Verification planned · medium risk · 3 required checks · next diagnostics",{exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:auditDir+"turn-verification-planned-dark-1280x800.png",fullPage:true});
    harness.emit({method:"turn/completed",params:{threadId:thread.id,turn:{id:"turn-failed",status:"failed",completedAt:Date.now()/1000}}});
    await page.waitForTimeout(250);expect(requests.length).toBe(1);
  }finally{await harness.close()}
});

test("a turn whose checks already ran shows their outcome: failed checks start a repair, and the repair turn reads verified",async({page})=>{
  test.setTimeout(30_000);
  const thread={id:"turn-outcome-thread",name:"Turn outcome fixture",preview:"Verification outcome",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-20,updatedAt:Date.now()/1000,turns:[]};
  const harness=await startHarness(thread);
  const outcomes={
    "turn-broke":{status:"failed",summary:{required:3,passed:2,failed:1,blocked:0,missing:0},nextAction:{action:"repair",nextStep:{id:"targeted_tests",kind:"tests"}}},
    "turn-repair":{status:"verified",summary:{required:3,passed:3,failed:0,blocked:0,missing:0},nextAction:{action:"complete"}},
  };
  try{
    await routeApp(page,harness,thread);
    await page.route("**/api/verification/plan-turn",async route=>{
      const body=route.request().postDataJSON(),outcome=outcomes[body.turnId];
      await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
        supported:true,threadId:body.threadId,turnId:body.turnId,changedPaths:["src/slug.js"],
        record:{id:"verification:"+body.turnId,threadId:body.threadId,turnId:body.turnId,status:outcome.status,risk:"low",assessment:{status:outcome.status,risk:"low",summary:outcome.summary}},
        nextAction:outcome.nextAction,
      })});
    });
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Turn outcome fixture"]')});
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    harness.emit({method:"turn/completed",params:{threadId:thread.id,turn:{id:"turn-broke",status:"completed",completedAt:Date.now()/1000}}});
    const failed=page.locator(".tool-event",{hasText:"Verification failed · low risk · 1 of 3 required checks failed"});
    // A failed row shares the error styling and keeps its own status text.
    await expect(failed).toHaveClass(/status-error/);await expect(failed.locator("summary em")).toHaveText("failed");
    const repair=page.locator(".tool-event",{hasText:"Verification failed · automatic same-thread repair started"});
    await expect(repair.locator("summary em")).toHaveText("running");
    harness.emit({method:"turn/started",params:{threadId:thread.id,turn:{id:"turn-repair",status:"inProgress",startedAt:Date.now()/1000}}});
    harness.emit({method:"turn/completed",params:{threadId:thread.id,turn:{id:"turn-repair",status:"completed",completedAt:Date.now()/1000}}});
    const verified=page.locator(".tool-event",{hasText:"Verified · low risk · 3 required checks passed"});
    await expect(verified).toHaveClass(/status-done/);await expect(verified.locator("summary em")).toHaveText("done");
    await expect(repair.locator("summary em")).toHaveText("done");
    // Nothing is left looking as if it still waits.
    await expect(page.locator(".tool-event.kind-verification summary em",{hasText:/^(pending|running)$/})).toHaveCount(0);
    await verified.scrollIntoViewIfNeeded();
    await page.screenshot({path:auditDir+"turn-verification-outcome-dark-1280x800.png",fullPage:true});
  }finally{await harness.close()}
});
