import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function startHarness(...threads){
  let socket=null;
  const upstreamHttp=createServer(),wss=new WebSocketServer({noServer:true});
  upstreamHttp.on("upgrade",(req,raw,head)=>wss.handleUpgrade(req,raw,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    socket=ws;ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
      let result={};
      if(message.method==="initialize")result={userAgent:"runtime-trace-fixture"};
      else if(message.method==="thread/list")result={data:threads,nextCursor:null};
      else if(message.method==="thread/resume")result={thread:threads.find(item=>item.id===message.params?.threadId)||threads[0],itemsBackwardsCursor:null,turnsBackwardsCursor:null};
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
async function routeApp(page,harness,...threads){
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  await keepThreadMeta(page);
  await page.route("**/api/bootstrap",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"runtime-trace-ui",activeEnvironmentId:null,activeEnvironment:null})}));
  await page.route("**/api/state",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:Object.fromEntries(threads.map(thread=>[thread.id,{projectless:true,environmentId:null}]))})}));
  await page.route("**/api/models",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}})}));
  await page.route("**/api/projects",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
  await page.route("**/api/environment/themes",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  await page.route("**/api/recovery",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
  // The theme button's setting stays in the page, so later specs on the shared server keep theirs.
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().postDataJSON()||{})}):route.fallback());
}
// Two frames on: the page has drawn what it was last given, and has done what React does once it is drawn (its effects).
const painted=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve)))));
const fixtureThread=(id,name,age)=>({id,name,preview:name,cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-age,updatedAt:Date.now()/1000-age,turns:[]});
const traceEvent=(id,thread,turnId,name,ago)=>({id,at:Date.now()-ago,runtime:"codex",provider:"openai",threadId:thread.id,turnId,category:"turn",name,status:"completed",data:{}});
// The trace, filtered from events as the server filters it. A request that hold(params) matches waits until release(which) sends
// it on (a slow journal); release resolves once the page has those answers and has drawn what they leave. Each held request keeps
// its place among the requests (index).
async function routeTraces(page,events){
  const traces={requests:[],held:[],hold:()=>false};
  await page.route("**/api/traces?*",async route=>{
    const params=Object.fromEntries(new URL(route.request().url()).searchParams.entries()),index=traces.requests.push(params)-1;
    if(traces.hold(params))await new Promise(resolve=>traces.held.push({index,params,request:route.request(),send:resolve}));
    let items=[...events];
    for(const key of ["threadId","turnId","runtime","category"])if(params[key])items=items.filter(item=>String(item[key])===params[key]);
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items,journal:{backend:"sqlite",lastError:null}})}).catch(()=>{});
  });
  traces.release=async(which=()=>true)=>{
    const going=traces.held.filter(entry=>which(entry.params));traces.held=traces.held.filter(entry=>!going.includes(entry));
    const answered=going.map(entry=>entry.request.response().then(response=>response?.finished()));
    for(const entry of going)entry.send();
    await Promise.all(answered);await painted(page);
  };
  return traces;
}
async function openRuntime(page,name){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
  await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
  const panel=page.getByTestId("right-panel");
  if(!await panel.isVisible())await page.getByTestId("right-panel-toggle").click();
  await panel.getByRole("button",{name:"Runtime",exact:true}).click();
  const trace=page.getByTestId("runtime-trace");await expect(trace).toBeVisible();
  return {trace,names:trace.locator(".runtime-trace-row summary strong"),turns:trace.getByLabel("Trace turn").locator("option")};
}
// The page in dark and light at 1280 wide, with the trace in view; it is left dark.
async function shootModes(page,trace,name){
  const mode=async value=>{if(await page.locator("html").getAttribute("data-mode")!==value){await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode",value)}};
  await page.setViewportSize({width:1280,height:800});
  for(const value of ["dark","light"]){await mode(value);await trace.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+name+"-"+value+"-1280x800.png"})}
  await mode("dark");
}

test("runtime trace filters by turn and preserves last-known-good data on refresh failure",async({page})=>{
  test.setTimeout(30_000);
  const thread={id:"runtime-trace-thread",name:"Runtime trace fixture",preview:"Trace filters",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-20,updatedAt:Date.now()/1000,turns:[]};
  const harness=await startHarness(thread),requests=[];let fail=false;
  const events=[
    {id:"event-delegate",at:Date.now()-2000,runtime:"codex",provider:"openai",threadId:thread.id,turnId:"turn-delegation-123456789",category:"delegation",name:"delegation.started",status:"running",data:{childThreadId:"child-1"}},
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
    await expect(trace.getByRole("alert")).toContainText("Deliberate trace refresh failure. Last valid trace is kept below.");
    await expect(trace).toContainText("knowledge.refreshed");
    await page.setViewportSize({width:1280,height:800});await trace.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"runtime-trace-filters-dark-1280x800.png",fullPage:true});
  }finally{await harness.close()}
});

test("a slow trace answer for the thread just left is dropped, and the thread opened lists and filters only its own turns",async({page})=>{
  test.setTimeout(60_000);
  const threadA=fixtureThread("thread-a-trace-race","Trace race thread A",30),threadB=fixtureThread("thread-b-trace-race","Trace race thread B",20);
  const harness=await startHarness(threadA,threadB);
  const traces=await routeTraces(page,[
    traceEvent("a-1",threadA,"turn-a-0001","a.turn.started",50_000),traceEvent("a-2",threadA,"turn-a-0001","a.tool.completed",40_000),traceEvent("a-3",threadA,"turn-a-0002","a.turn.completed",30_000),
    traceEvent("b-1",threadB,"turn-b-0001","b.turn.started",20_000),traceEvent("b-2",threadB,"turn-b-0002","b.turn.completed",10_000),
  ]);
  try{
    await routeApp(page,harness,threadA,threadB);
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:500,terminalHeight:330})));
    await page.goto("/");
    const {trace,names,turns}=await openRuntime(page,"Trace race thread A");
    await expect(names).toHaveText(["a.turn.started","a.tool.completed","a.turn.completed"]);
    // Refresh is pressed on thread A and its answer is slow; thread B is opened while it is on its way, and B's trace answers.
    traces.hold=params=>params.threadId===threadA.id;
    await trace.getByRole("button",{name:"Refresh execution trace"}).click();
    await expect.poll(()=>traces.held.length).toBeGreaterThan(0);
    await openRuntime(page,"Trace race thread B");
    await expect(names).toHaveText(["b.turn.started","b.turn.completed"]);
    // B's later answers are slow too, so nothing of B's would replace what A's answer leaves once it lands.
    traces.hold=params=>params.threadId===threadA.id||params.threadId===threadB.id;
    await traces.release(params=>params.threadId===threadA.id);
    await expect(names,"thread A's late trace replaced thread B's").toHaveText(["b.turn.started","b.turn.completed"]);
    await expect(turns,"thread A's turns were added to thread B's Turn filter").toHaveText(["All turns","turn-b-0001","turn-b-0002"]);
    await trace.locator(".runtime-trace-row summary").first().click();
    await expect(trace.locator(".runtime-trace-row").first()).toContainText("codex · openai · thread thread-b-tra · turn turn-b-0001");
    await shootModes(page,trace,"runtime-trace-thread-switch");
    await expect(trace.getByRole("button",{name:"Refresh execution trace"})).toBeEnabled();
  }finally{traces.hold=()=>false;await traces.release().catch(()=>{});await harness.close()}
});

test("a slow trace answer for a turn no longer picked in the Turn filter is dropped",async({page})=>{
  test.setTimeout(60_000);
  const thread=fixtureThread("thread-c-trace-filter","Trace filter thread",20);
  const harness=await startHarness(thread);
  const traces=await routeTraces(page,[traceEvent("c-1",thread,"turn-c-0001","c.turn.started",20_000),traceEvent("c-2",thread,"turn-c-0002","c.turn.completed",10_000)]);
  try{
    await routeApp(page,harness,thread);
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:500,terminalHeight:330})));
    await page.goto("/");
    const {trace,names}=await openRuntime(page,"Trace filter thread"),turn=trace.getByLabel("Trace turn");
    await expect(names).toHaveText(["c.turn.started","c.turn.completed"]);
    // The first turn is picked and its answer is slow; All turns is picked again while it is on its way, and its answer lands
    // first. Every later answer is slow too, so nothing would replace what the first turn's answer leaves once it lands.
    traces.hold=()=>true;
    await turn.selectOption("turn-c-0001");
    await expect.poll(()=>traces.held.some(entry=>entry.params.turnId==="turn-c-0001")).toBe(true);
    const asked=traces.requests.length;
    await turn.selectOption("");
    await expect.poll(()=>traces.held.some(entry=>entry.index>=asked&&!entry.params.turnId)).toBe(true);
    await traces.release(params=>!params.turnId);
    await expect(names).toHaveText(["c.turn.started","c.turn.completed"]);
    await traces.release(params=>params.turnId==="turn-c-0001");
    await expect(turn).toHaveValue("");
    await expect(names,"the late answer for the turn no longer picked replaced the list of all turns").toHaveText(["c.turn.started","c.turn.completed"]);
    await expect(trace.getByRole("button",{name:"Refresh execution trace"})).toBeEnabled();
    await shootModes(page,trace,"runtime-trace-turn-filter-switch");
  }finally{traces.hold=()=>false;await traces.release().catch(()=>{});await harness.close()}
});
