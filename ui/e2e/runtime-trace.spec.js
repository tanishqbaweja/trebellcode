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
// its place among the requests (index). lastError, when set, is the journal's last failure each answer carries, and fail has each
// request refused.
async function routeTraces(page,events){
  const traces={requests:[],held:[],hold:()=>false,lastError:null,fail:false};
  await page.route("**/api/traces?*",async route=>{
    const params=Object.fromEntries(new URL(route.request().url()).searchParams.entries()),index=traces.requests.push(params)-1;
    if(traces.hold(params))await new Promise(resolve=>traces.held.push({index,params,request:route.request(),send:resolve}));
    if(traces.fail){await route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Deliberate trace refresh failure"})}).catch(()=>{});return}
    let items=[...events];
    for(const key of ["threadId","turnId","runtime","category"])if(params[key])items=items.filter(item=>String(item[key])===params[key]);
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items,journal:{backend:"sqlite",lastError:traces.lastError}})}).catch(()=>{});
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
// The page in dark and light at each of widths (1280 wide unless given), with the trace in view; it is left dark at 1280. The theme
// is switched at 1280, as in a narrower window the open panel lies over the header.
async function shootModes(page,trace,name,widths=[1280]){
  const mode=async value=>{await page.setViewportSize({width:1280,height:800});if(await page.locator("html").getAttribute("data-mode")!==value){await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode",value)}};
  for(const value of ["dark","light"]){await mode(value);for(const width of widths){await page.setViewportSize({width,height:800});await trace.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+name+"-"+value+"-"+width+"x800.png"})}}
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

test("filters that hide every trace event of the thread say so and offer Clear filters, which a double click or a held Enter presses once to list them all again, and a thread with no events keeps its own text",async({page})=>{
  test.setTimeout(90_000);
  const thread=fixtureThread("thread-d-trace-hidden","Trace hidden events thread",30),none=fixtureThread("thread-e-trace-none","Trace no events thread",20);
  const harness=await startHarness(thread,none);
  const events=[
    traceEvent("d-1",thread,"turn-d-0001","d.turn.started",50_000),
    {...traceEvent("d-2",thread,"turn-d-0001","d.verification.step",40_000),runtime:"native",provider:"agentrouter",category:"verification",status:"failed"},
    traceEvent("d-3",thread,"turn-d-0002","d.turn.completed",30_000),
  ];
  const traces=await routeTraces(page,events);
  try{
    await routeApp(page,harness,thread,none);
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:500,terminalHeight:330})));
    await page.goto("/");
    const {trace,names}=await openRuntime(page,"Trace hidden events thread"),all=["d.turn.started","d.verification.step","d.turn.completed"];
    const [turn,runtime,category,time]=["Trace turn","Trace runtime","Trace category","Trace time window"].map(label=>trace.getByLabel(label));
    const filters=()=>Promise.all([turn,runtime,category,time].map(select=>select.inputValue()));
    const empty=trace.locator(".runtime-trace-empty"),clear=trace.getByRole("button",{name:"Clear filters",exact:true}),opened=trace.locator(".runtime-trace-row[open]");
    const refresh=trace.getByRole("button",{name:"Refresh execution trace"});
    await expect(names).toHaveText(all);
    // Codex picked in the runtimes, then from the keyboard the last category (verification) and the last 15 minutes: none of the
    // thread's Codex events is a verification step.
    const hideAll=async()=>{
      await runtime.selectOption("codex");
      await category.focus();await page.keyboard.press("End");await time.focus();await page.keyboard.press("ArrowDown");
      await expect.poll(filters).toEqual(["","codex","verification","15m"]);
      await expect(names).toHaveCount(0);await expect(refresh).toBeEnabled();
      await expect(empty,"filters that hide the thread's events read as if it had none").toContainText("No trace events match these filters.");
      await expect(clear).toBeVisible();
    };
    // Clear filters puts all four back and lists the thread's events again, none opened, with the keyboard on the Turn filter.
    const cleared=async how=>{
      await expect(names,how).toHaveText(all);await expect.poll(filters,how).toEqual(["","","","all"]);
      expect(traces.requests.at(-1),how).toEqual({limit:"40",threadId:thread.id});
      await expect(opened,how+": its rest opened the trace row that took Clear filters' place").toHaveCount(0);await expect(turn,how).toBeFocused();
    };
    await hideAll();
    await shootModes(page,trace,"runtime-trace-filters-match-nothing",[1280,900,700]);
    // A double click as a person's: the second click comes once the list has taken the button's place under the pointer.
    const box=await clear.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.up();
    await expect(names).toHaveText(all);
    expect(await page.evaluate(([x,y])=>Boolean(document.elementFromPoint(x,y)?.closest(".runtime-trace-row>summary")),[x,y]),"a trace row is under the pointer for the second click").toBe(true);
    await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});await painted(page);
    await cleared("a double click on Clear filters");
    await page.screenshot({animations:"disabled",path:auditDir+"runtime-trace-filters-cleared-dark-1280x800.png"});
    // In light mode in a 700 px window the message and the button fit the panel, and Tab then a held Enter press it once.
    await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light");
    await page.setViewportSize({width:700,height:800});
    await hideAll();
    const metrics=await trace.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await time.focus();await page.keyboard.press("Tab");await expect(clear).toBeFocused();
    await page.screenshot({animations:"disabled",path:auditDir+"runtime-trace-clear-filters-focused-light-700x800.png"});
    await page.keyboard.down("Enter");await page.keyboard.down("Enter");await page.keyboard.down("Enter");await page.keyboard.up("Enter");await painted(page);
    await cleared("Enter held on Clear filters");
    await page.screenshot({animations:"disabled",path:auditDir+"runtime-trace-filters-cleared-light-700x800.png"});
    await page.setViewportSize({width:1280,height:800});
    // A thread with no events keeps its own text, filtered or not (its filtered answer is held until the list says it is loading),
    // until an event comes that the filters hide.
    await openRuntime(page,"Trace no events thread");
    await expect(refresh).toBeEnabled();await expect(empty).toHaveText("No trace events for this thread yet.");
    traces.hold=params=>params.threadId===none.id&&params.category==="verification";
    await category.focus();await page.keyboard.press("End");await expect(category).toHaveValue("verification");
    await expect.poll(()=>traces.held.length).toBeGreaterThan(0);await expect(empty).toHaveText("Loading trace…");
    traces.hold=()=>false;await traces.release();
    await expect(empty,"a thread with no events, filtered").toHaveText("No trace events for this thread yet.");await expect(refresh).toBeEnabled();await expect(clear).toHaveCount(0);
    events.push(traceEvent("e-1",none,"turn-e-0001","e.turn.started",5_000));
    await refresh.click();
    await expect(empty,"filters that hide the event the thread now has").toContainText("No trace events match these filters.");
    await clear.click();
    await expect(names).toHaveText(["e.turn.started"]);await expect(category).toHaveValue("");await expect(turn).toBeFocused();
  }finally{traces.hold=()=>false;await traces.release().catch(()=>{});await harness.close()}
});

// Clear filters goes when an answer takes the empty list away while the keyboard is on it: an event the filters match comes with
// the next poll, the journal says it failed, a refresh fails, or a refresh starts (here Refresh pressed by script). Each time the
// keyboard goes on to the Turn filter, with its ring, as a press of Clear filters hands it: it fell to the page, and no control had it.
test("Clear filters that an answer takes away while the keyboard is on it hands the keyboard to the Turn filter: an event the filters match coming with a poll, a journal failure, a failed refresh and a refresh",async({page})=>{
  test.setTimeout(90_000);
  const thread=fixtureThread("thread-f-trace-keyboard","Trace keyboard thread",30);
  const harness=await startHarness(thread);
  const events=[traceEvent("f-1",thread,"turn-f-0001","f.turn.started",50_000),traceEvent("f-2",thread,"turn-f-0001","f.turn.completed",40_000)];
  const traces=await routeTraces(page,events);
  try{
    await routeApp(page,harness,thread);
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:500,terminalHeight:330})));
    await page.goto("/");
    const {trace,names}=await openRuntime(page,"Trace keyboard thread");
    const [turn,category,time]=["Trace turn","Trace category","Trace time window"].map(label=>trace.getByLabel(label));
    const clear=trace.getByRole("button",{name:"Clear filters",exact:true}),empty=trace.locator(".runtime-trace-empty"),failure=trace.getByRole("alert");
    const ring=locator=>locator.evaluate(node=>node===document.activeElement&&node.matches(":focus-visible"));
    await expect(names).toHaveText(["f.turn.started","f.turn.completed"]);
    // The verification category, picked from the keyboard, hides both turn events; Tab from the time window reaches Clear filters.
    await category.focus();await page.keyboard.press("End");await expect(category).toHaveValue("verification");
    const onClear=async()=>{await expect(empty).toContainText("No trace events match these filters.",{timeout:10_000});await time.focus();await page.keyboard.press("Tab");await expect(clear).toBeFocused()};
    // Soft, so a build that drops the keyboard says so for each way the button goes.
    const handedOn=async why=>{await expect(clear).toHaveCount(0);await expect.soft(turn,why).toBeFocused();expect.soft(await ring(turn),why+", with its ring").toBe(true)};
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});
      if(await page.locator("html").getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
      // A verification step comes with the next poll: it is listed in the message's place, and the keyboard is on the Turn filter.
      await onClear();
      events.push({...traceEvent("f-3",thread,"turn-f-0002","f.verification.step",5_000),category:"verification",status:"failed"});
      await expect(names,"the poll lists the event the filters match").toHaveText(["f.verification.step"],{timeout:10_000});
      await handedOn("an event the filters match, come with a poll, hands the keyboard on Clear filters to the Turn filter");
      for(const width of [1280,700]){await page.setViewportSize({width,height:800});await expect.soft(turn).toBeFocused();await trace.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+"runtime-trace-clear-filters-polled-away-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
      events.pop();await expect(names).toHaveCount(0,{timeout:10_000});
    }
    // The journal says it failed: the failure is said in the message's place.
    await onClear();traces.lastError={message:"Trace journal write failed"};
    await expect(failure).toContainText("Trace journal write failed",{timeout:10_000});
    await handedOn("a journal failure said in the message's place hands the keyboard on Clear filters to the Turn filter");
    await page.screenshot({animations:"disabled",path:auditDir+"runtime-trace-clear-filters-failed-away-light-1280x800.png"});
    traces.lastError=null;
    // A refresh that fails.
    await onClear();traces.fail=true;
    await expect(failure).toContainText("Deliberate trace refresh failure",{timeout:10_000});
    await handedOn("a failed refresh hands the keyboard on Clear filters to the Turn filter");
    traces.fail=false;
    // A refresh that starts (Refresh's click by script, its answer held): the list says it is loading in the message's place.
    await onClear();traces.hold=()=>true;
    await trace.getByRole("button",{name:"Refresh execution trace"}).evaluate(node=>node.click());
    await expect(empty).toHaveText("Loading trace…");
    await handedOn("a refresh that starts hands the keyboard on Clear filters to the Turn filter");
    traces.hold=()=>false;await traces.release();
    await expect(empty).toContainText("No trace events match these filters.",{timeout:10_000});await expect.soft(turn).toBeFocused();
  }finally{traces.hold=()=>false;traces.lastError=null;traces.fail=false;await traces.release().catch(()=>{});await harness.close()}
});
