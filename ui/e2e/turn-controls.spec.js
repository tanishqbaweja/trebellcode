import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";
import { auditDir,gate,startStreamingFixture,stop } from "./native-stream-fixture.js";

// Turn controls as a person uses them: a new task while another thread runs, Stop, the queue, Edit from here and Compact. The real
// agent relay runs the real Native session with a scripted provider (native-stream-fixture.js); a Codex app-server is faked where
// the turn id only arrives with Codex's own answers.
const untilAborted=signal=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(Object.assign(new Error("provider request aborted"),{name:"AbortError"})),{once:true}));
const reply=(request,text)=>({id:"turn-controls-"+Math.random().toString(36).slice(2,8),provider:request.provider,model:request.model,text,toolCalls:[],finishReason:"stop",usage:{inputTokens:12,outputTokens:40,totalTokens:52}});
// The last thing the person asked in a provider call. Each scripted call answers by what it was asked, so a call a stopped or
// removed thread still makes (its completion check) never takes the answer meant for the next task.
const askedIn=request=>{const user=(request.messages||[]).findLast(message=>message?.role==="user");return typeof user?.content==="string"?user.content:JSON.stringify(user?.content||"")};
const GATE_ANSWER=JSON.stringify({status:"complete",progress:"improved",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"The fixture turn did what it was asked."});
function answerBy(fixture,routes){
  const step=(request,hook)=>{
    if(request.metadata?.completionGate===true||request.responseJsonSchema?.name==="trebell_completion_gate")return reply(request,GATE_ANSWER);
    const asked=askedIn(request),route=routes.find(([text])=>asked.includes(text));return route?route[1](request,hook):reply(request,"Done.");
  };
  for(let index=0;index<20;index++)fixture.script.push(step);
}
const composer=page=>page.getByTestId("composer");
const threadRow=(page,name)=>page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
const newTask=page=>page.getByRole("button",{name:"New task",exact:true});
const IDLE_PLACEHOLDER="Ask Trebell Code anything…";
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The settings the header's light and dark toggle saves stay in the page, so the shared e2e server keeps its own.
async function keepSettings(page){
  const saved={};
  await page.route(/\/api\/settings$/,route=>{
    if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(saved)});
  });
}
// Types into the composer as a person does, a key at a time.
async function typeInComposer(page,text){await composer(page).click();await page.keyboard.type(text,{delay:8})}
async function sendTyped(page,text){await typeInComposer(page,text);await page.keyboard.press("Enter")}
// The header's light and dark toggle, or its row in More actions where the header folded it away.
async function toggleMode(page){
  const before=await page.locator("html").getAttribute("data-mode"),direct=page.locator("[data-testid=appearance-toggle]:visible").first();
  if(await direct.count())await direct.click();
  else{await page.getByRole("button",{name:/More actions/}).first().click();await page.getByRole("menuitem",{name:/Switch to (light|dark) mode/}).first().click()}
  await expect(page.locator("html")).not.toHaveAttribute("data-mode",before||"");
}
// Dark and light screenshots at 1280x800 and 900 wide, each mode switched with the header toggle, ending where it began.
async function shoot(page,name){
  for(const [width,height] of [[1280,800],[900,800]]){
    await page.setViewportSize({width,height});
    for(let pass=0;pass<2;pass++){
      const mode=await page.locator("html").getAttribute("data-mode");
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.screenshot({animations:"disabled",path:`${auditDir}turn-controls-${name}-${mode}-${width}x${height}.png`});
      await toggleMode(page);
    }
  }
  await page.setViewportSize({width:1280,height:800});
}
// A new-task view a person can use: no Stop, the composer's own placeholder and its pickers enabled.
async function expectIdleNewTask(page){
  await expect(page.locator(".workspace-header")).toContainText("New Trebell task");
  await expect(stop(page)).toHaveCount(0);
  await expect(composer(page)).toHaveAttribute("placeholder",IDLE_PLACEHOLDER);await expect(composer(page)).toBeEnabled();
  await expect(page.locator(".composer-wrap select:disabled")).toHaveCount(0);
  await expect(page.locator(".queued-message")).toHaveCount(0);
}

test("a new task while another thread's turn runs is idle and starts its own thread, and the running thread shows running in the sidebar and again when opened",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  await keepSettings(page);
  const fixture=await startStreamingFixture(page,{threads:[{name:"Long count",preview:"Counting"}]});
  const streamed=gate(),finish=gate();
  answerBy(fixture,[
    ["Count slowly",async(request,hook)=>{hook({type:"text",delta:"Counting slowly: one, two, three, four, five. "});streamed.open();await Promise.race([finish.promise,untilAborted(request.signal)]);return reply(request,"Counting slowly: one, two, three, four, five. Done counting.")}],
    ["one short sentence",async request=>reply(request,"The second task answered in a thread of its own.")]]);
  try{
    await fixture.open("Long count");
    await sendTyped(page,"Count slowly to twenty.");await streamed.promise;
    await expect(stop(page)).toBeVisible();
    await newTask(page).click();
    await expectIdleNewTask(page);
    // The thread left running still shows running in the sidebar.
    await expect(threadRow(page,"Long count").getByRole("img",{name:"Running"})).toBeVisible();
    await shoot(page,"new-task-while-another-runs");
    // Enter starts a thread of its own while the other turn goes on: no queue, the reply comes in that thread.
    await sendTyped(page,"Reply with one short sentence.");
    await expect(page.getByText("The second task answered in a thread of its own.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(page.locator(".queued-message")).toHaveCount(0);
    await expect(page.locator(".workspace-header")).not.toContainText("New Trebell task");
    expect(fixture.threadStore.list().length).toBe(2);
    await expect(threadRow(page,"Long count").getByRole("img",{name:"Running"})).toBeVisible();
    await expect(stop(page)).toHaveCount(0);
    // Opened again, the first thread is running, and its turn ends there.
    await threadRow(page,"Long count").locator(".thread-main").click();
    await expect(stop(page)).toBeVisible({timeout:10_000});await expect(composer(page)).toHaveAttribute("placeholder","Queue a follow-up…");
    finish.open();
    await expect(page.locator(".history-assistant").filter({hasText:"Done counting."})).toHaveCount(1,{timeout:10_000});
    await expect(stop(page)).toHaveCount(0);
  }finally{finish.open();await fixture.close()}
});

for(const action of ["Delete","Archive"]){
  test(`${action.toLowerCase()} of the open thread while its turn runs leaves an idle new task whose next prompt starts a thread`,async({page})=>{
    test.setTimeout(90_000);
    await page.setViewportSize({width:1280,height:800});
    await keepSettings(page);
    const fixture=await startStreamingFixture(page,{threads:[{name:"Fix login redirect",preview:"Login"},{name:"Keep this one",preview:"Other"}]});
    // The provider holds its answer past the removal, as a slow request does, so the turn still runs when its thread goes.
    const streamed=gate(),release=gate();
    answerBy(fixture,[
      ["login redirect",async(request,hook)=>{hook({type:"text",delta:"Looking at the login redirect now. "});streamed.open();await release.promise;return reply(request,"The redirect loops because the session cookie is dropped.")}],
      ["new task after",async request=>reply(request,"A new task after the "+action.toLowerCase()+" answered.")]]);
    try{
      await fixture.open("Fix login redirect");
      await sendTyped(page,"Find why the login redirect loops.");await streamed.promise;
      await expect(stop(page)).toBeVisible();
      const row=threadRow(page,"Fix login redirect");await row.hover();await row.locator(".thread-menu summary").click();
      if(action==="Delete")page.once("dialog",dialog=>dialog.accept());
      await row.getByRole("button",{name:action,exact:true}).click();
      await expect(threadRow(page,"Fix login redirect")).toHaveCount(0);
      await expectIdleNewTask(page);
      await shoot(page,`${action.toLowerCase()}-running-thread`);
      release.open();await page.waitForTimeout(300);await expectIdleNewTask(page);
      await sendTyped(page,"Start a new task after the "+action.toLowerCase()+".");
      await expect(page.getByText("A new task after the "+action.toLowerCase()+" answered.",{exact:true})).toBeVisible({timeout:15_000});
      await expect(page.locator(".queued-message")).toHaveCount(0);await expect(stop(page)).toHaveCount(0);
    }finally{release.open();await fixture.close()}
  });
}

// A Codex app-server the test drives, reached through Trebell's Codex relay. Its turn/start is held: the test lets the turn start
// (turn/started) and lets the answer go, in either order, as Codex sends them. A started turn streams its reply and completes
// unless turn/interrupt ends it first; one interrupted before it started ends as it starts. interruptDelayMs holds the interrupt's
// answer (Codex answers once the turn has stopped).
async function startCodex(page,{name}){
  const thread={id:"codex-stop-thread",name,preview:name,cwd:process.cwd(),createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,status:{type:"idle"},turns:[]};
  const codex={thread,turns:[],interrupts:[],interruptDelayMs:0,socket:null};
  const upstream=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set();
  upstream.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  const notify=(method,params)=>{if(codex.socket?.readyState===1)codex.socket.send(JSON.stringify({method,params}))};
  const end=(turn,status)=>{turn.status=status;clearTimeout(turn.timer);notify("turn/completed",{threadId:thread.id,turn:{id:turn.id,status,items:[]}})};
  wss.on("connection",ws=>{
    sockets.add(ws);codex.socket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
      const params=message.params||{},respond=result=>{if(ws.readyState===1)ws.send(JSON.stringify({id:message.id,result}))};
      if(message.method==="turn/start"){
        const turn={id:"codex-turn-"+(codex.turns.length+1),status:"inProgress",started:false,timer:null};codex.turns.push(turn);
        turn.answer=()=>respond({turn:{id:turn.id,status:"inProgress",items:[]}});
        turn.start=()=>{
          turn.started=true;notify("turn/started",{threadId:thread.id,turn:{id:turn.id,status:"inProgress",items:[]}});
          if(turn.status!=="inProgress")return end(turn,turn.status);
          const itemId="reply-"+turn.id,words="One two three four five six seven eight nine ten. Counting is done.".split(/(?<= )/);let index=0;
          notify("item/started",{threadId:thread.id,turnId:turn.id,item:{type:"agentMessage",id:itemId,text:""}});
          const tick=()=>{
            if(turn.status!=="inProgress")return;
            if(index<words.length){notify("item/agentMessage/delta",{threadId:thread.id,turnId:turn.id,itemId,delta:words[index++]});turn.timer=setTimeout(tick,60);return}
            notify("item/completed",{threadId:thread.id,turnId:turn.id,item:{type:"agentMessage",id:itemId,text:words.join("")}});end(turn,"completed");
          };
          turn.timer=setTimeout(tick,60);
        };
        return;
      }
      if(message.method==="turn/interrupt"){
        codex.interrupts.push({...params});const turn=codex.turns.find(item=>item.id===params.turnId);
        setTimeout(()=>{if(turn?.status==="inProgress"){if(turn.started)end(turn,"interrupted");else turn.status="interrupted"}respond({})},codex.interruptDelayMs);return;
      }
      let result={};
      if(message.method==="initialize")result={userAgent:"turn-controls-codex"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(["thread/turns/list","thread/items/list","thread/queue/list","thread/attachment/list","thread/timeline/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(["threadSection/list","skills/list","collaborationMode/list"].includes(message.method))result={data:[]};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      respond(result);
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstream.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await keepThreadMeta(page);await keepSettings(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:process.platform,version:"turn-controls-codex",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  await threadRow(page,name).locator(".thread-main").click();await expect(composer(page)).toBeEnabled({timeout:15_000});
  codex.close=async()=>{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstream.close(resolve))])};
  return codex;
}
const stopping=page=>page.getByRole("button",{name:"Stopping",exact:true});

// Codex names a send's turn only in turn/start's answer or in turn/started, whichever it sends first. A Stop pressed before either is
// kept: the header says Stopping while the turn runs, the interrupt goes to the turn the moment its id comes, and only once, and the
// stopped turn ends stopped, without its reply.
for(const first of ["turn/started","the turn/start answer"]){
  test(`Stop before Codex names the turn is sent when ${first} names it, and the turn shows stopping until it ends`,async({page})=>{
    test.setTimeout(60_000);
    await page.setViewportSize({width:1280,height:800});
    const codex=await startCodex(page,{name:"Codex count"});
    try{
      await sendTyped(page,"Count from one to forty, one number per line.");
      await expect.poll(()=>codex.turns.length).toBe(1);const [turn]=codex.turns;
      await stop(page).click();
      await expect(stopping(page)).toBeVisible();await expect(stopping(page)).toBeDisabled();
      await page.waitForTimeout(300);
      expect(codex.interrupts).toEqual([]);await expect(stopping(page)).toBeVisible();
      if(first==="turn/started")await shoot(page,"stopping-before-turn-id");
      if(first==="turn/started")turn.start();else turn.answer();
      await expect.poll(()=>codex.interrupts).toEqual([{threadId:codex.thread.id,turnId:turn.id}]);
      if(first==="turn/started"){await page.waitForTimeout(200);turn.answer()}else{await expect(stopping(page)).toBeVisible();turn.start()}
      await expect(stop(page)).toHaveCount(0,{timeout:10_000});await expect(stopping(page)).toHaveCount(0);
      await expect(page.getByTestId("turn-outcome").last()).toHaveText(/^stopped/);
      await page.waitForTimeout(500);
      expect(codex.interrupts).toHaveLength(1);
      await expect(page.getByText("Counting is done.",{exact:false})).toHaveCount(0);
      await expect(composer(page)).toHaveAttribute("placeholder",IDLE_PLACEHOLDER);
    }finally{await codex.close()}
  });
}

test("a double click on Stop sends one turn/interrupt for the turn",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{name:"Codex double stop"});
  try{
    codex.interruptDelayMs=400;
    await sendTyped(page,"Count from one to forty, one number per line.");
    await expect.poll(()=>codex.turns.length).toBe(1);const [turn]=codex.turns;turn.answer();turn.start();
    await expect(stop(page)).toBeVisible();await expect(page.getByText("One two three",{exact:false})).toBeVisible({timeout:10_000});
    await stop(page).dblclick();
    await expect(stop(page)).toHaveCount(0,{timeout:10_000});await expect(stopping(page)).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(codex.interrupts).toEqual([{threadId:codex.thread.id,turnId:turn.id}]);
    await expect(page.getByTestId("turn-outcome").last()).toHaveText(/^stopped/);
  }finally{await codex.close()}
});
