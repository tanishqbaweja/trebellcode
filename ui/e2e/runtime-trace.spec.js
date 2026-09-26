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
      if(message.method==="initialize")result={userAgent:"runtime-trace-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/continuity/get")result={continuity:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",
    async close(){relay.close();try{socket?.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}
async function routeApp(page,harness,thread){
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  await page.route("**/api/bootstrap",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"runtime-trace-ui",activeEnvironmentId:null,activeEnvironment:null})}));
  await page.route("**/api/state",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
  await page.route("**/api/models",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
  await page.route("**/api/projects",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
  await page.route("**/api/environment/themes",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  await page.route("**/api/recovery",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
}

test("runtime trace filters by turn and preserves last-known-good data on refresh failure",async({page})=>{
  test.setTimeout(30_000);
  const thread={id:"runtime-trace-thread",name:"Runtime trace fixture",preview:"Trace filters",cwd:process.cwd(),status:{type:"idle"},model:"freebuff/test/coding-fast",createdAt:Date.now()/1000-20,updatedAt:Date.now()/1000,turns:[]};
  const harness=await startHarness(thread),requests=[];let fail=false;
  const events=[
    {id:"event-delegate",at:Date.now()-2000,runtime:"codex",provider:"freebuff",threadId:thread.id,turnId:"turn-delegation-123456789",category:"delegation",name:"delegation.started",status:"running",data:{childThreadId:"child-1"}},
    {id:"event-knowledge",at:Date.now()-1000,runtime:"claude",provider:"claude",threadId:thread.id,turnId:"turn-knowledge-2",category:"knowledge",name:"knowledge.refreshed",status:"completed",data:{facts:3}},
  ];
  try{
    await routeApp(page,harness,thread);
    await page.route("**/api/traces?*",async route=>{
      const url=new URL(route.request().url()),params=Object.fromEntries(url.searchParams.entries());requests.push(params);
      if(fail){await route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate trace refresh failure"})});return}
      let items=[...events];
      for(const [key,value] of [["threadId",params.threadId],["turnId",params.turnId],["runtime",params.runtime],["category",params.category]])if(value)items=items.filter(item=>String(item[key])===value);
      await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items,journal:{backend:"sqlite",lastError:null}})});
    });
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:500,terminalHeight:330})));
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Runtime trace fixture"]')});
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    await page.getByTestId("right-panel-toggle").click();
    const right=page.getByTestId("right-panel");await right.getByRole("button",{name:"Runtime",exact:true}).click();
    const trace=page.getByTestId("runtime-trace");await expect(trace).toBeVisible();
    await expect(trace.getByLabel("Trace turn")).toContainText("turn-delegat");await expect(trace.getByLabel("Trace turn")).toContainText("turn-knowledg");
    await expect(trace.getByLabel("Trace category")).toContainText("delegation");await expect(trace.getByLabel("Trace category")).toContainText("knowledge");
    await trace.getByLabel("Trace turn").selectOption("turn-knowledge-2");
    await expect.poll(()=>requests.at(-1)?.turnId||"").toBe("turn-knowledge-2");
    await expect(trace).toContainText("knowledge.refreshed");await expect(trace).not.toContainText("delegation.started");
    await trace.getByLabel("Trace runtime").selectOption("claude");await trace.getByLabel("Trace category").selectOption("knowledge");
    await expect.poll(()=>requests.at(-1)?.category||"").toBe("knowledge");
    const metrics=await trace.locator(".runtime-trace-filters").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    fail=true;await trace.getByRole("button",{name:"Refresh execution trace"}).click();
    await expect(trace.getByRole("alert")).toContainText("Deliberate trace refresh failure");
    await expect(trace).toContainText("knowledge.refreshed");
    await page.setViewportSize({width:1280,height:800});await trace.scrollIntoViewIfNeeded();
    await page.screenshot({path:auditDir+"runtime-trace-filters-dark-1280x800.png",fullPage:true});
  }finally{await harness.close()}
});
